'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { registerBrand, unregisterBrand, isBrand } = require('./openai-brands');
const keyring = require('./keyring');
const { createPeriodicTask } = require('./periodic-task');

const { getModelScore } = require('./swe-bench-scores');

const DEFAULT_PATH = path.join(os.homedir(), '.acptoapi', 'extra-providers.txt');
const PROBE_CACHE_PATH = process.env.ACPTOAPI_EXTRA_PROBE_CACHE || path.join(os.homedir(), '.acptoapi', 'extra-probe-cache.json');
const PROBE_TIMEOUT = Number(process.env.ACPTOAPI_EXTRA_PROBE_TIMEOUT_MS) || 8000;
const PROBE_TTL_MS = Number(process.env.ACPTOAPI_EXTRA_PROBE_TTL_MS) || 600000;
// A probe that found NEITHER an OpenAI nor an Anthropic endpoint (both
// discovery calls came back null) is far more likely to be a transient
// network blip / timeout against a real, working aggregator than a
// genuinely dead endpoint -- live-witnessed: tokenhun.shadw.app (casey's
// own 24-model aggregator) probed as fully dead once, got cached at the
// FULL 10-minute TTL, and a direct re-probe seconds later succeeded
// cleanly on both formats. Caching a negative result at the same TTL as a
// positive one means one bad network moment blinds an entire aggregator's
// worth of models for up to 10 minutes on every occurrence -- a real,
// recurring reliability gap. A short negative TTL lets the very next
// loadAndRegister() pass (driven by whatever re-triggers registration,
// e.g. casey's own periodic re-probe timer) retry soon instead of
// replaying the stale failure for the rest of the full window.
const STAGGER_MS = Number(process.env.ACPTOAPI_EXTRA_PROBE_STAGGER_MS) || 2000;
const PROBE_NEGATIVE_TTL_MS = Number(process.env.ACPTOAPI_EXTRA_PROBE_NEGATIVE_TTL_MS) || 30000;
const MAX_MODELS_TO_PROBE = Number(process.env.ACPTOAPI_EXTRA_MAX_MODELS) || 30;

function parseBaseURL(baseStr) {
  let s = baseStr.trim();
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  s = s.replace(/\/+$/, '');
  try {
    const u = new URL(s);
    return { scheme: u.protocol.replace(':', ''), host: u.host, path: u.pathname.replace(/\/+$/, ''), raw: s };
  } catch {
    return { scheme: 'https', host: s, path: '', raw: s };
  }
}

function candidateChatURLs(parsed) {
  const { scheme, host, path } = parsed;
  const base = `${scheme}://${host}`;
  const urls = [];

  if (path.endsWith('/chat/completions')) {
    urls.push(`${base}${path}`);
    return urls;
  }

  if (path.endsWith('/v1')) {
    urls.push(`${base}${path}/chat/completions`);
  } else if (path.endsWith('/messages')) {
    urls.push(`${base}${path.replace(/\/messages$/, '')}/chat/completions`);
    urls.push(`${base}${path.replace(/\/messages$/, '')}/v1/chat/completions`);
  } else if (path) {
    urls.push(`${base}${path}/chat/completions`);
    urls.push(`${base}${path}/v1/chat/completions`);
  }

  urls.push(`${base}${path}/chat/completions`);
  urls.push(`${base}/v1/chat/completions`);

  const seen = new Set();
  return urls.filter(u => { const s = u.toLowerCase(); if (seen.has(s)) return false; seen.add(s); return true; });
}

function candidateMessagesURLs(parsed) {
  const { scheme, host, path } = parsed;
  const base = `${scheme}://${host}`;
  const urls = [];

  if (path.endsWith('/messages')) {
    urls.push(`${base}${path}`);
    return urls;
  }

  if (path.endsWith('/chat/completions')) {
    urls.push(`${base}${path.replace(/\/chat\/completions$/, '')}/messages`);
    urls.push(`${base}${path.replace(/\/chat\/completions$/, '')}/v1/messages`);
  } else if (path.endsWith('/v1')) {
    urls.push(`${base}${path}/messages`);
  } else if (path) {
    urls.push(`${base}${path}/messages`);
    urls.push(`${base}${path}/v1/messages`);
  }

  urls.push(`${base}${path}/messages`);
  urls.push(`${base}/v1/messages`);

  const seen = new Set();
  return urls.filter(u => { const s = u.toLowerCase(); if (seen.has(s)) return false; seen.add(s); return true; });
}

function isEndpointLikely(status) {
  if (status === 404) return false;
  if (status >= 200 && status < 500) return true;
  return false;
}

async function probeURL(method, url, headers, body, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    return res.status;
  } catch {
    return 0;
  } finally {
    clearTimeout(timer);
  }
}

const FORMAT_DISCOVERY_OPENAI_MODEL = 'gpt-4o-mini';
const FORMAT_DISCOVERY_ANTHROPIC_MODEL = 'claude-3-5-haiku-latest';

async function discoverOpenAI(parsed, apiKey, timeoutMs) {
  const candidates = candidateChatURLs(parsed);
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
  };
  const body = { model: FORMAT_DISCOVERY_OPENAI_MODEL, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 };

  for (const url of candidates) {
    const status = await probeURL('POST', url, headers, body, timeoutMs);
    if (isEndpointLikely(status)) return url;
  }
  return null;
}

async function discoverAnthropic(parsed, apiKey, timeoutMs) {
  const candidates = candidateMessagesURLs(parsed);
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  };
  const body = { model: FORMAT_DISCOVERY_ANTHROPIC_MODEL, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] };

  for (const url of candidates) {
    const status = await probeURL('POST', url, headers, body, timeoutMs);
    if (isEndpointLikely(status)) return url;
  }
  return null;
}

async function probeModel(chatURL, apiKey, modelId, timeoutMs) {
  const startedAt = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(chatURL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model: modelId, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
      signal: ctrl.signal,
    });
    const latencyMs = Date.now() - startedAt;
    if (res.ok) return { ok: true, status: res.status, error: null, latencyMs };
    const body = await res.text().catch(() => '');
    return { ok: false, status: res.status, error: body.slice(0, 300), latencyMs };
  } catch (e) {
    return { ok: false, status: 0, error: e.name === 'AbortError' ? 'timeout' : e.message, latencyMs: Date.now() - startedAt };
  } finally {
    clearTimeout(timer);
  }
}

async function probeModels(chatURL, apiKey, modelIds, timeoutMs, staggerMs = STAGGER_MS) {
  const results = new Map();
  if (!modelIds || modelIds.length === 0) return results;
  for (let i = 0; i < modelIds.length; i++) {
    if (i > 0 && staggerMs > 0) await new Promise(r => setTimeout(r, staggerMs));
    results.set(modelIds[i], await probeModel(chatURL, apiKey, modelIds[i], timeoutMs));
  }
  return results;
}

async function probeEntry(entry, timeoutMs, modelProbeTimeoutMs) {
  const parsed = parseBaseURL(entry.baseURL);
  const anthropicURL = await discoverAnthropic(parsed, entry.apiKey, timeoutMs);
  if (STAGGER_MS > 0) await new Promise(r => setTimeout(r, STAGGER_MS));
  const openaiURL = await discoverOpenAI(parsed, entry.apiKey, timeoutMs);
  const chatURL = openaiURL || anthropicURL;
  const models = chatURL && entry.models.length > 0
    ? await probeModels(chatURL, entry.apiKey, entry.models, modelProbeTimeoutMs || timeoutMs)
    : new Map();
  return { openai: openaiURL, anthropic: anthropicURL, models };
}

const FALLBACK_MODELS = [
  'claude-sonnet-5-20250514',
  'gpt-5.5',
  'claude-opus-4-20250514',
  'gpt-5.3-codex',
  'deepseek-chat',
  'kimi-k2.5',
  'claude-sonnet-4-6-20250514',
  'gpt-4.1',
  'gemini-2.5-pro-exp-03-25',
  'llama-4-maverick',
  'qwen-plus',
  'mistral-large-latest',
  'codestral-latest',
  'claude-3-5-haiku-latest',
  'gpt-4o-mini',
  'gemini-2.5-flash',
  'llama-4-scout',
  'llama-3.3-70b-versatile',
  'mistral-medium-latest',
  'deepseek-v3',
  'command-r-plus-08-2024',
  'llama-3.1-8b-instant',
  'gpt-4o',
  'claude-3-haiku-20240307',
  'gemini-2.0-flash',
  'mistral-tiny',
];

async function tryListModels(openaiURL, apiKey, timeoutMs) {
  const base = openaiURL.replace(/\/chat\/completions\/?$/, '').replace(/\/v1\/?$/, '');
  const modelsURL = `${base}/v1/models`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(modelsURL, {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const data = await res.json();
    const ids = [];
    if (Array.isArray(data.data)) {
      for (const m of data.data) {
        if (m.id && (m.object === 'model' || !m.object)) ids.push(m.id);
      }
    } else if (Array.isArray(data)) {
      for (const m of data) {
        if (m.id) ids.push(m.id);
      }
    }
    const seen = new Set();
    return ids.filter(id => { if (seen.has(id)) return false; seen.add(id); return true; }).sort();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const KNOWN_BENCHMARK_SCORE_OFFSET = 100;

function scoreModelID(modelId) {
  const bench = getModelScore(modelId);
  if (bench) return bench + KNOWN_BENCHMARK_SCORE_OFFSET;
  const id = modelId.toLowerCase();
  let base = 0;
  if (/sonnet-5|opus-4[.67]|gpt-?5[.\d]|mythos/i.test(id)) base = 92;
  else if (/sonnet-4[.][56]/i.test(id)) base = 78;
  else if (/opus-4[.\d]|gpt-?4[.][01]/i.test(id)) base = 74;
  else if (/deepseek[.-]?(v?4|chat|reasoner)/i.test(id)) base = 72;
  else if (/kimi.?k2[.\d]|qwen.?3[.\d]/i.test(id)) base = 70;
  else if (/llama-4|maverick|scout/i.test(id)) base = 68;
  else if (/gemini.?2[.][05]|flash|pro/i.test(id)) base = 60;
  else if (/mistral-large|codestral/i.test(id)) base = 65;
  else if (/claude-3-5|haiku/i.test(id)) base = 55;
  else if (/llama-3[.\d]/i.test(id)) base = 52;
  else if (/gpt-?4o/i.test(id)) base = 50;
  else base = 30;
  const verMatch = id.match(/(\d+)[.](\d+)/);
  if (verMatch) base += Number(verMatch[2]) * 0.5;
  return base;
}

function autoDiscoverModels(openaiURL, apiKey, timeoutMs) {
  return { tryList: tryListModels(openaiURL, apiKey, timeoutMs), fallback: FALLBACK_MODELS };
}

function sortModelIDs(ids) {
  const scored = ids.map(id => ({ id, score: scoreModelID(id) }));
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return scored.map(s => s.id);
}

function parseProviderFile(text) {
  const lines = text.split(/\r?\n/);
  const entries = [];
  let i = 0;

  while (i < lines.length) {
    const raw = lines[i].trim();
    i++;
    if (!raw || raw.startsWith('#')) continue;

    const parts = raw.split('\t');

    if (parts.length >= 3) {
      const url = parts[0].trim();
      const key = parts[1].trim();
      if (!url || !key) continue;
      const modelsStr = parts.slice(2).join(' ').trim();
      const models = parseModelNames(modelsStr);
      entries.push({ baseURL: url, apiKey: key, models });
    } else if (parts.length === 1 && raw) {
      if (i < lines.length) {
        const nextRaw = lines[i].trim();
        if (nextRaw && !nextRaw.startsWith('#') && isKeyLine(nextRaw)) {
          const url = raw;
          const key = nextRaw;
          i++;
          entries.push({ baseURL: url, apiKey: key, models: [] });
        }
      }
    } else if (parts.length === 2) {
      const url = parts[0].trim();
      const key = parts[1].trim();
      if (url && key) {
        entries.push({ baseURL: url, apiKey: key, models: [] });
      }
    }
  }

  return entries;
}

function isKeyLine(s) {
  return /^(sk-|sk-or-|sk-ai-|lfu_|[0-9a-f]{6})/i.test(s) || /^[A-Za-z0-9_-]{8,}$/.test(s);
}

function parseModelNames(str) {
  if (!str) return [];
  const cleaned = str.replace(/\+\d+\s*$/, '').trim();
  if (!cleaned) return [];
  return cleaned.split(/\s+/).filter(Boolean);
}

function loadCache() {
  try { return JSON.parse(fs.readFileSync(PROBE_CACHE_PATH, 'utf8')); } catch { return {}; }
}

function saveCache(cache) {
  try {
    fs.mkdirSync(path.dirname(PROBE_CACHE_PATH), { recursive: true });
    fs.writeFileSync(PROBE_CACHE_PATH, JSON.stringify(cache, null, 2));
  } catch {}
}

const registeredProvidersByPrefix = new Map();
let nextPrefixCounter = 0;
const prefixByBaseURL = new Map();

// A prefix registered here from ONE base URL can host many genuinely
// independent models (an aggregator endpoint) -- chain-machine.js's coarse
// per-prefix sampler backoff assumes a prefix IS one backend (true for a real
// single-backend brand like groq/cerebras, where an outage really does take
// every model down together), which is wrong for an aggregator: one model's
// failure should never back off its unrelated siblings. True when this
// prefix's registered record holds more than one (working+untested) model.
// A single-model extra endpoint legitimately behaves like a single backend
// and is correctly left on the per-prefix sampler.
function isMultiModelPrefix(prefix) {
  const rec = registeredProvidersByPrefix.get(prefix);
  if (!rec) return false;
  return (rec.workingModels.length + rec.untestedModels.length) > 1;
}

function nextPrefix(baseURL) {
  if (baseURL && prefixByBaseURL.has(baseURL)) return prefixByBaseURL.get(baseURL);
  let p;
  while (true) {
    p = `extra-${nextPrefixCounter}`;
    nextPrefixCounter++;
    if (!isBrand(p)) break;
  }
  if (baseURL) prefixByBaseURL.set(baseURL, p);
  return p;
}

function generateEnvKey(prefix) {
  return `ACPTOAPI_EXTRA_${prefix.replace(/[^a-zA-Z0-9_]/g, '_').toUpperCase()}`;
}

function registerOne(entry, probeResult) {
  if (!probeResult.openai && !probeResult.anthropic) return null;

  const prefix = nextPrefix(entry.baseURL);
  const envKey = generateEnvKey(prefix);
  const primaryURL = probeResult.anthropic || probeResult.openai;
  if (!primaryURL) return null;

  keyring.registerKey(envKey, entry.apiKey);
  registerBrand(prefix, { url: primaryURL, envKey });

  const workingModels = [];
  const failedModels = [];
  const untestedModels = [];

  if (probeResult.models && probeResult.models.size > 0) {
    for (const [modelId, result] of probeResult.models) {
      if (result.ok) workingModels.push({ model: modelId, latencyMs: result.latencyMs });
      else failedModels.push({ model: modelId, status: result.status, error: result.error });
    }
  } else if (entry.models.length === 0) {
    untestedModels.push({ model: 'default' });
  } else {
    for (const m of entry.models) untestedModels.push({ model: m });
  }

  const rec = {
    prefix,
    entry,
    openaiURL: probeResult.openai,
    anthropicURL: probeResult.anthropic,
    primaryURL,
    envKey,
    workingModels,
    failedModels,
    untestedModels,
    formats: [
      ...(probeResult.openai ? ['openai'] : []),
      ...(probeResult.anthropic ? ['anthropic'] : []),
    ],
  };
  registeredProvidersByPrefix.set(prefix, rec);

  if (workingModels.length === 0 && untestedModels.length === 0) {
    console.log(`[extra-providers] ${prefix}: ${entry.baseURL} — endpoint reachable (${rec.formats.join('/')}) but all ${failedModels.length} model(s) failed probe`);
  } else {
    const details = [];
    if (workingModels.length) details.push(`${workingModels.length} working`);
    if (untestedModels.length) details.push(`${untestedModels.length} untested`);
    if (failedModels.length) details.push(`${failedModels.length} failed`);
    console.log(`[extra-providers] ${prefix}: ${entry.baseURL} — ${rec.formats.join('/')} (${details.join(', ')})`);
  }

  return rec;
}

function unregisterAll() {
  for (const [prefix] of registeredProvidersByPrefix) {
    try { unregisterBrand(prefix); } catch {}
  }
  registeredProvidersByPrefix.clear();
}

function serializeProbedModels(probeResult) {
  const serialized = {};
  if (probeResult.models) {
    for (const [modelId, result] of probeResult.models) serialized[modelId] = result;
  }
  return serialized;
}

function cacheProbeResult(cache, cacheKey, probeResult, ts) {
  cache[cacheKey] = {
    openai: probeResult.openai,
    anthropic: probeResult.anthropic,
    models: serializeProbedModels(probeResult),
    ts,
  };
}

function recordProbedModelsIntoAvailability(rec) {
  try {
    const av = require('./availability');
    for (const m of rec.workingModels) av.recordSuccess(`${rec.prefix}/${m.model}`, m.latencyMs);
    for (const m of rec.failedModels) av.recordFailure(`${rec.prefix}/${m.model}`);
  } catch {}
}

async function loadAndRegister(filePath) {
  const fp = filePath || DEFAULT_PATH;
  let text;
  try { text = fs.readFileSync(fp, 'utf8'); } catch { return []; }

  unregisterAll();

  const rawEntries = parseProviderFile(text);
  if (rawEntries.length === 0) return [];

  const cache = loadCache();
  const now = Date.now();
  const out = [];

  for (let ei = 0; ei < rawEntries.length; ei++) {
    const entry = rawEntries[ei];

    if (ei > 0 && STAGGER_MS > 0) await new Promise(r => setTimeout(r, STAGGER_MS));

    if (!entry.apiKey || entry.apiKey.length < 6) {
      console.log(`[extra-providers] skip ${entry.baseURL} — key too short or masked`);
      continue;
    }

    const cacheKey = `${entry.baseURL}|${maskKey(entry.apiKey)}`;

    let probeResult = null;
    const cached = cache[cacheKey];
    if (cached) {
      const cachedIsNegative = !cached.openai && !cached.anthropic;
      const effectiveTtl = cachedIsNegative ? PROBE_NEGATIVE_TTL_MS : PROBE_TTL_MS;
      if ((now - cached.ts) < effectiveTtl) {
        probeResult = {
          openai: cached.openai,
          anthropic: cached.anthropic,
          models: cached.models ? new Map(Object.entries(cached.models)) : new Map(),
        };
      }
    }

    if (!probeResult) {
      const modelCountLabel = entry.models.length > 0 ? `${entry.models.length} model(s)` : 'auto-discover';
      console.log(`[extra-providers] probing ${entry.baseURL} (${modelCountLabel})...`);
      probeResult = await probeEntry(entry, PROBE_TIMEOUT, PROBE_TIMEOUT);
      cacheProbeResult(cache, cacheKey, probeResult, now);
    }

    if ((probeResult.openai || probeResult.anthropic) && entry.models.length === 0 && (!probeResult.models || probeResult.models.size === 0)) {
      const chatURL = probeResult.openai;
      if (chatURL) {
        const listedModels = await tryListModels(chatURL, entry.apiKey, PROBE_TIMEOUT);
        const modelCandidates = listedModels && listedModels.length > 0
          ? sortModelIDs(listedModels).slice(0, MAX_MODELS_TO_PROBE)
          : sortModelIDs(FALLBACK_MODELS).slice(0, MAX_MODELS_TO_PROBE);
        if (modelCandidates.length > 0) {
          console.log(`[extra-providers] auto-discovered ${modelCandidates.length} model(s) for ${entry.baseURL}`);
          const discoveredResults = await probeModels(chatURL, entry.apiKey, modelCandidates, PROBE_TIMEOUT, STAGGER_MS);
          if (!probeResult.models) probeResult.models = new Map();
          for (const [k, v] of discoveredResults) probeResult.models.set(k, v);
        }
      }
    }

    cacheProbeResult(cache, cacheKey, probeResult, Date.now());
    saveCache(cache);

    if (probeResult.openai || probeResult.anthropic) {
      const rec = registerOne(entry, probeResult);
      if (rec) {
        recordProbedModelsIntoAvailability(rec);
        out.push(rec);
      }
    } else {
      console.log(`[extra-providers] skip ${entry.baseURL} — no API format detected`);
    }
  }

  return out;
}

function loadAndRegisterAsync(filePath) {
  return loadAndRegister(filePath).catch(e => {
    console.error(`[extra-providers] load error: ${e.message}`);
    return [];
  });
}

function listRegistered() {
  return Array.from(registeredProvidersByPrefix.values()).map(r => ({
    prefix: r.prefix,
    baseURL: r.entry.baseURL,
    openaiURL: r.openaiURL,
    anthropicURL: r.anthropicURL,
    formats: r.formats,
    workingModels: r.workingModels.map(m => ({ model: m.model, latencyMs: m.latencyMs })),
    failedModels: r.failedModels.map(m => ({ model: m.model, status: m.status, error: m.error })),
    untestedModels: r.untestedModels.map(m => m.model),
  }));
}

function getAllEntries() {
  return Array.from(registeredProvidersByPrefix.values()).map(r => ({
    prefix: r.prefix,
    baseURL: r.entry.baseURL,
    apiKey: maskKey(r.entry.apiKey),
    openaiURL: r.openaiURL,
    anthropicURL: r.anthropicURL,
    formats: r.formats,
    workingModels: r.workingModels.map(m => ({ model: m.model, latencyMs: m.latencyMs })),
    failedModels: r.failedModels.map(m => ({ model: m.model, status: m.status, error: m.error })),
    untestedModels: r.untestedModels.map(m => m.model),
  }));
}

function maskKey(key) {
  if (!key) return '';
  if (key.length <= 6) return key.slice(0, 2) + '***';
  return key.slice(0, 4) + '...' + key.slice(-4);
}

function getModelCatalog() {
  const out = [];
  for (const [prefix, rec] of registeredProvidersByPrefix) {
    for (const m of rec.workingModels) {
      out.push(`${prefix}/${m.model}`);
    }
    for (const m of rec.untestedModels) {
      out.push(`${prefix}/${m.model}`);
    }
  }
  return out;
}

function getChainLinks() {
  const links = [];
  const FALLBACK_ON = ['error', 'rate_limit', 'timeout', 'empty', 'auth', 'fetch_failed', 'content_policy', 'sampler_backoff', 'matrix_block'];
  for (const [prefix, rec] of registeredProvidersByPrefix) {
    for (const m of rec.workingModels) {
      links.push({ model: `${prefix}/${m.model}`, _probeLatencyMs: m.latencyMs, _probeOk: true, fallbackOn: FALLBACK_ON });
    }
    for (const m of rec.untestedModels) {
      links.push({ model: `${prefix}/${m.model}`, _probeOk: null, fallbackOn: FALLBACK_ON });
    }
  }
  return links;
}

function loadFromCache(filePath) {
  const fp = filePath || DEFAULT_PATH;
  try {
    const text = fs.readFileSync(fp, 'utf8');
    const rawEntries = parseProviderFile(text);
    if (rawEntries.length === 0) return false;

    const cache = loadCache();
    const now = Date.now();
    let loadedAny = false;

    for (const entry of rawEntries) {
      if (!entry.apiKey || entry.apiKey.length < 6) continue;
      const cacheKey = `${entry.baseURL}|${maskKey(entry.apiKey)}`;
      const cached = cache[cacheKey];
      if (!cached) continue;

      const cachedModels = cached.models ? new Map(Object.entries(cached.models)) : new Map();
      if (cached.openai || cached.anthropic) {
        const workingModels = [];
        if (cachedModels.size > 0) {
          for (const [modelId, result] of cachedModels) {
            if (result && result.ok) workingModels.push({ model: modelId, latencyMs: result.latencyMs || 0 });
          }
        }
        const syntheticEntry = { baseURL: entry.baseURL, apiKey: entry.apiKey, models: [] };
        const prefix = nextPrefix(entry.baseURL);
        const envKey = generateEnvKey(prefix);
        const primaryURL = cached.anthropic || cached.openai;
        keyring.registerKey(envKey, entry.apiKey);
        registerBrand(prefix, { url: primaryURL, envKey });
        registeredProvidersByPrefix.set(prefix, {
          prefix, entry: syntheticEntry,
          openaiURL: cached.openai,
          anthropicURL: cached.anthropic,
          primaryURL,
          envKey,
          workingModels,
          failedModels: [],
          untestedModels: [],
          formats: [
            ...(cached.openai ? ['openai'] : []),
            ...(cached.anthropic ? ['anthropic'] : []),
          ],
        });
        loadedAny = true;
      }
    }
    return loadedAny;
  } catch {
    return false;
  }
}

const REPROBE_INTERVAL_MS = Number(process.env.ACPTOAPI_EXTRA_REPROBE_INTERVAL_MS) || 300000;
let periodicReprobeTask = null;
function start(filePath, intervalMs = REPROBE_INTERVAL_MS) {
  if (!periodicReprobeTask) periodicReprobeTask = createPeriodicTask(() => loadAndRegister(filePath), intervalMs);
  periodicReprobeTask.start();
}
function stop() {
  periodicReprobeTask?.stop();
}

module.exports = {
  loadAndRegister,
  loadAndRegisterAsync,
  loadFromCache,
  start,
  stop,
  parseBaseURL,
  candidateChatURLs,
  candidateMessagesURLs,
  probeEntry,
  probeModel,
  probeModels,
  discoverOpenAI,
  discoverAnthropic,
  parseProviderFile,
  parseModelNames,
  maskKey,
  isKeyLine,
  registerOne,
  isMultiModelPrefix,
  nextPrefix,
  generateEnvKey,
  tryListModels,
  scoreModelID,
  sortModelIDs,
  listRegistered,
  getAllEntries,
  getModelCatalog,
  getChainLinks,
  unregisterAll,
  DEFAULT_PATH,
  PROBE_CACHE_PATH,
  FALLBACK_MODELS,
  MAX_MODELS_TO_PROBE,
};
