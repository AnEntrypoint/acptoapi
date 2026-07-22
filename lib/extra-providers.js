'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { registerBrand, unregisterBrand, isBrand } = require('./openai-brands');
const keyring = require('./keyring');

const { getModelScore } = require('./swe-bench-scores');

const DEFAULT_PATH = path.join(os.homedir(), '.acptoapi', 'extra-providers.txt');
const PROBE_CACHE_PATH = process.env.ACPTOAPI_EXTRA_PROBE_CACHE || path.join(os.homedir(), '.acptoapi', 'extra-probe-cache.json');
const PROBE_TIMEOUT = Number(process.env.ACPTOAPI_EXTRA_PROBE_TIMEOUT_MS) || 8000;
const PROBE_TTL_MS = Number(process.env.ACPTOAPI_EXTRA_PROBE_TTL_MS) || 600000;
const STAGGER_MS = Number(process.env.ACPTOAPI_EXTRA_PROBE_STAGGER_MS) || 2000;
const MAX_MODELS_TO_PROBE = Number(process.env.ACPTOAPI_EXTRA_MAX_MODELS) || 30;

// ---------------------------------------------------------------------------
// Entry model
// ---------------------------------------------------------------------------
//   { baseURL, apiKey, models[], sourceName, sourceNote }
//   baseURL: raw string from file (bare hostname, or full URL with scheme+path)
//   apiKey:  the API key for this endpoint (may be masked; probing will detect)
//   models:  parsed model IDs from the file (empty if none specified)

// ---------------------------------------------------------------------------
// URL resolution  - try multiple patterns to find what works
// ---------------------------------------------------------------------------

// Normalize a raw URL string to { scheme, host, path, raw }. Handles bare
// hostnames, full URLs, URLs with/without trailing slash, etc.
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

// Build candidate OpenAI chat completions URLs from a parsed base.
// Tries variations: with/without /v1, with/without /chat/completions suffix.
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

// ---------------------------------------------------------------------------
// Probing  - try a request, classify whether the endpoint speaks the format
// ---------------------------------------------------------------------------

function isEndpointLikely(status) {
  // 2xx = works, 400 = recognized but bad body, 401/403 = recognized but bad
  // auth, 429 = recognized but rate-limited, 404 = not found (unlikely to be
  // the right format).
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

// Lightweight OpenAI probe: minimal chat completions request. Returns the
// working chat completions URL or null.
async function discoverOpenAI(parsed, apiKey, timeoutMs) {
  const candidates = candidateChatURLs(parsed);
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
  };
  // Use a widely-supported modern model for format discovery. gpt-4o-mini is
  // accepted by virtually every OpenAI-compatible endpoint in 2025-2026.
  const body = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 };

  for (const url of candidates) {
    const status = await probeURL('POST', url, headers, body, timeoutMs);
    if (isEndpointLikely(status)) return url;
  }
  return null;
}

// Lightweight Anthropic probe: minimal messages request. Returns the working
// messages URL or null.
async function discoverAnthropic(parsed, apiKey, timeoutMs) {
  const candidates = candidateMessagesURLs(parsed);
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  };
  // Use claude-3-5-haiku-latest — fast, universally accepted, modern enough to
  // test that the endpoint actually supports Anthropic's Messages API shape.
  const body = { model: 'claude-3-5-haiku-latest', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] };

  for (const url of candidates) {
    const status = await probeURL('POST', url, headers, body, timeoutMs);
    if (isEndpointLikely(status)) return url;
  }
  return null;
}

// Probe a single model by making a real 1-token inference call. Returns:
//   { ok: bool, status: number, error: string|null, latencyMs: number }
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

// Probe every model listed for an entry through the discovered endpoint.
// Models are probed one at a time with a stagger delay so a row with many
// models doesn't hammer the upstream in a single burst. Returns a Map<modelId,
// {ok, status, error, latencyMs}>.
async function probeModels(chatURL, apiKey, modelIds, timeoutMs, staggerMs = STAGGER_MS) {
  const results = new Map();
  if (!modelIds || modelIds.length === 0) return results;
  for (let i = 0; i < modelIds.length; i++) {
    if (i > 0 && staggerMs > 0) await new Promise(r => setTimeout(r, staggerMs));
    results.set(modelIds[i], await probeModel(chatURL, apiKey, modelIds[i], timeoutMs));
  }
  return results;
}

// Probe a single entry to discover which API formats it supports, then probe
// each declared model to confirm it actually serves inference. Format
// discovery is sequential (Anthropic first, then OpenAI) so the endpoint
// isn't hit by two bursts simultaneously. Stagger between formats uses the
// same inter-probe delay as model probing. Returns:
//   { openai: <chatURL>|null, anthropic: <messagesURL>|null,
//     models: Map<modelId, {ok, status, error, latencyMs}> }
async function probeEntry(entry, timeoutMs, modelProbeTimeoutMs) {
  const parsed = parseBaseURL(entry.baseURL);
  // Anthropic-style first — preferred when both work. OpenAI fallback.
  const anthropicURL = await discoverAnthropic(parsed, entry.apiKey, timeoutMs);
  if (STAGGER_MS > 0) await new Promise(r => setTimeout(r, STAGGER_MS));
  const openaiURL = await discoverOpenAI(parsed, entry.apiKey, timeoutMs);
  const chatURL = openaiURL || anthropicURL;
  const models = chatURL && entry.models.length > 0
    ? await probeModels(chatURL, entry.apiKey, entry.models, modelProbeTimeoutMs || timeoutMs)
    : new Map();
  return { openai: openaiURL, anthropic: anthropicURL, models };
}

// ---------------------------------------------------------------------------
// Auto-discovery  — when no explicit model list is given, try to fetch the
// endpoint's /v1/models list and probe candidates. Falls back to a curated
// quality-ordered list when the models endpoint is unavailable.
// ---------------------------------------------------------------------------

const FALLBACK_MODELS = [
  // 2026 frontier models (SWE-bench >= 80)
  'claude-sonnet-5-20250514',
  'gpt-5.5',
  'claude-opus-4-20250514',
  'gpt-5.3-codex',
  'deepseek-chat',
  'kimi-k2.5',
  // 2025-2026 flagships (SWE-bench 70-80)
  'claude-sonnet-4-6-20250514',
  'gpt-4.1',
  'gemini-2.5-pro-exp-03-25',
  'llama-4-maverick',
  'qwen-plus',
  'mistral-large-latest',
  'codestral-latest',
  // Fast/cheap tier
  'claude-3-5-haiku-latest',
  'gpt-4o-mini',
  'gemini-2.5-flash',
  'llama-4-scout',
  'llama-3.3-70b-versatile',
  'mistral-medium-latest',
  'deepseek-v3',
  'command-r-plus-08-2024',
  // Widely available workhorses
  'llama-3.1-8b-instant',
  'gpt-4o',
  'claude-3-haiku-20240307',
  'gemini-2.0-flash',
  'mistral-tiny',
];

// Try to list models via OpenAI-compatible GET /v1/models endpoint.
// Returns an array of model IDs (sorted by id) or null on failure.
async function tryListModels(openaiURL, apiKey, timeoutMs) {
  // Build /v1/models URL from the discovered chat completions URL.
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
    // Deduplicate and sort (newer models tend to appear later in list).
    const seen = new Set();
    return ids.filter(id => { if (seen.has(id)) return false; seen.add(id); return true; }).sort();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Score a model ID by SWE-bench when known, otherwise by a simple heuristic
// based on model name patterns: higher version numbers → higher quality.
function scoreModelID(modelId) {
  const bench = getModelScore(modelId);
  if (bench) return bench + 100; // known models always rank above guessed ones
  const id = modelId.toLowerCase();
  let base = 0;
  // Heuristic tiers based on model name patterns (2025-2026 conventions)
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
  // Bump for newer version numbers in the name
  const verMatch = id.match(/(\d+)[.](\d+)/);
  if (verMatch) base += Number(verMatch[2]) * 0.5;
  return base;
}

// Auto-discover models for an entry that has no explicit model list.
// 1. Try GET /v1/models (OpenAI-compat standard)
// 2. If that returns models, score+sort them, take top MAX_MODELS_TO_PROBE
// 3. If that fails, use FALLBACK_MODELS
// Returns array of model ID strings (quality-descending), or empty array.
function autoDiscoverModels(openaiURL, apiKey, timeoutMs) {
  // This is the sync function signature for the async tryListModels wrapper.
  // The actual async call happens in loadAndRegister.
  return { tryList: tryListModels(openaiURL, apiKey, timeoutMs), fallback: FALLBACK_MODELS };
}

// Sort model IDs by quality (highest scored first). Unknown models go last.
function sortModelIDs(ids) {
  const scored = ids.map(id => ({ id, score: scoreModelID(id) }));
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return scored.map(s => s.id);
}

// ---------------------------------------------------------------------------
// File format parsing
// ---------------------------------------------------------------------------

// TSV format: domain\tapiKey\tmodel1 model2 model3\t...
// Interleaved format: <URL line> then <key line> alternately.
// Lines starting with # are comments. Blank lines are skipped.
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
      // TSV: host/url, key, models...
      const url = parts[0].trim();
      const key = parts[1].trim();
      if (!url || !key) continue;
      const modelsStr = parts.slice(2).join(' ').trim();
      const models = parseModelNames(modelsStr);
      entries.push({ baseURL: url, apiKey: key, models });
    } else if (parts.length === 1 && raw) {
      // Single value: could be URL line in interleaved format
      // Check if next line looks like an API key
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
      // Two values: could be url\tkey
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
  // API keys typically start with sk-, sk-or-, sk-ai-, lfu_, 2b5b, or look
  // like tokens (alphanumeric, possibly with punctuation).
  return /^(sk-|sk-or-|sk-ai-|lfu_|[0-9a-f]{6})/i.test(s) || /^[A-Za-z0-9_-]{8,}$/.test(s);
}

function parseModelNames(str) {
  if (!str) return [];
  // Strip trailing "+N" (e.g. "+338" meaning "338 more models").
  const cleaned = str.replace(/\+\d+\s*$/, '').trim();
  if (!cleaned) return [];
  return cleaned.split(/\s+/).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Probe cache (persists across restarts so cold boot isn't re-probed)
// ---------------------------------------------------------------------------

function loadCache() {
  try { return JSON.parse(fs.readFileSync(PROBE_CACHE_PATH, 'utf8')); } catch { return {}; }
}

function saveCache(cache) {
  try {
    fs.mkdirSync(path.dirname(PROBE_CACHE_PATH), { recursive: true });
    fs.writeFileSync(PROBE_CACHE_PATH, JSON.stringify(cache, null, 2));
  } catch {}
}

// ---------------------------------------------------------------------------
// Registration  - register working entries as dynamic brands
// ---------------------------------------------------------------------------

// Track registered extra providers so we can unregister/re-register on reload.
const _registry = new Map(); // prefix -> { entry, openaiURL, anthropicURL, models: Map }
let _counter = 0;

function nextPrefix() {
  while (true) {
    const p = `extra-${_counter}`;
    _counter++;
    if (!isBrand(p)) return p;
  }
}

function generateEnvKey(prefix) {
  return `ACPTOAPI_EXTRA_${prefix.replace(/[^a-zA-Z0-9_]/g, '_').toUpperCase()}`;
}

// Register a single probed entry as a dynamic brand provider.
// Only models that passed the live inference probe are registered as chain
// links. Failed models are tracked in the registry for diagnostics but not
// added to the chain.
// Brand routing requires at least OpenAI-compat (the brand passthrough path
// sends OpenAI-format requests and translates Anthropic requests to OpenAI).
// For endpoints that also support Anthropic natively, we record the messages
// URL so future routing can prefer anthropic-style when the incoming request
// is Anthropic-format (avoiding translation and preserving thinking blocks).
function registerOne(entry, probeResult) {
  if (!probeResult.openai && !probeResult.anthropic) return null;

  const prefix = nextPrefix();
  const envKey = generateEnvKey(prefix);

  // Prefer Anthropic-style URL when both are available (preserves native
  // message format, thinking blocks, etc. through the pipeline). Fall back
  // to OpenAI URL otherwise.
  const primaryURL = probeResult.anthropic || probeResult.openai;
  if (!primaryURL) return null;

  keyring.registerKey(envKey, entry.apiKey);
  registerBrand(prefix, { url: primaryURL, envKey });

  // Classify models by probe outcome.
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
    // Models were listed but probe didn't run (no endpoint found?)  - treat as untested
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
  _registry.set(prefix, rec);

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

// Unregister all previously registered extra brands.
function unregisterAll() {
  for (const [prefix] of _registry) {
    try { unregisterBrand(prefix); } catch {}
  }
  _registry.clear();
}

// ---------------------------------------------------------------------------
// Main lifecycle
// ---------------------------------------------------------------------------

// Load the file, probe each entry, register working ones. Returns the list of
// registered records. If `filePath` is not set, uses DEFAULT_PATH.
async function loadAndRegister(filePath) {
  const fp = filePath || DEFAULT_PATH;
  let text;
  try { text = fs.readFileSync(fp, 'utf8'); } catch { return []; }

  // Unregister any previously loaded extra providers first.
  unregisterAll();

  const rawEntries = parseProviderFile(text);
  if (rawEntries.length === 0) return [];

  const cache = loadCache();
  const now = Date.now();
  const out = [];

  for (let ei = 0; ei < rawEntries.length; ei++) {
    const entry = rawEntries[ei];

    // Stagger between entries so multi-endpoint files don't burst all at once.
    if (ei > 0 && STAGGER_MS > 0) await new Promise(r => setTimeout(r, STAGGER_MS));

    if (!entry.apiKey || entry.apiKey.length < 6) {
      console.log(`[extra-providers] skip ${entry.baseURL} — key too short or masked`);
      continue;
    }

    const cacheKey = `${entry.baseURL}|${maskKey(entry.apiKey)}`;

    // Check cache first.
    let probeResult = null;
    const cached = cache[cacheKey];
    if (cached && (now - cached.ts) < PROBE_TTL_MS) {
      probeResult = {
        openai: cached.openai,
        anthropic: cached.anthropic,
        models: cached.models ? new Map(Object.entries(cached.models)) : new Map(),
      };
    }

    // Probe if no valid cache entry.
    if (!probeResult) {
      const modelCountLabel = entry.models.length > 0 ? `${entry.models.length} model(s)` : 'auto-discover';
      console.log(`[extra-providers] probing ${entry.baseURL} (${modelCountLabel})...`);
      probeResult = await probeEntry(entry, PROBE_TIMEOUT, PROBE_TIMEOUT);

      // Serialize models Map to plain object for JSON cache.
      const serializedModels = {};
      if (probeResult.models) {
        for (const [k, v] of probeResult.models) serializedModels[k] = v;
      }

      // Cache the probe result (format discovery only at this point).
      cache[cacheKey] = {
        openai: probeResult.openai,
        anthropic: probeResult.anthropic,
        models: serializedModels,
        ts: now,
      };
      // Don't save cache yet — auto-discovery below may add model data.
    }

    // Auto-discover models when none were listed in the file.
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

    // Serialize models and save cache (now includes auto-discovered model data).
    {
      const serializedModels = {};
      if (probeResult.models) {
        for (const [k, v] of probeResult.models) serializedModels[k] = v;
      }
      cache[cacheKey] = {
        openai: probeResult.openai,
        anthropic: probeResult.anthropic,
        models: serializedModels,
        ts: Date.now(),
      };
      saveCache(cache);
    }

    // Register if at least one format was detected.
    if (probeResult.openai || probeResult.anthropic) {
      const rec = registerOne(entry, probeResult);
      if (rec) {
        // Feed probe results into availability tracking so `rerank` in the
        // auto-chain immediately reflects which models actually serve
        // inference. Working models get a `recordSuccess` with probe latency;
        // failed models get `recordFailure` so the chain prefers live peers.
        try {
          const av = require('./availability');
          for (const m of rec.workingModels) {
            av.recordSuccess(`${rec.prefix}/${m.model}`, m.latencyMs);
          }
          for (const m of rec.failedModels) {
            av.recordFailure(`${rec.prefix}/${m.model}`);
          }
        } catch {}
        out.push(rec);
      }
    } else {
      console.log(`[extra-providers] skip ${entry.baseURL} — no API format detected`);
    }
  }

  return out;
}

// Non-blocking variant for server startup  - fires and doesn't await.
function loadAndRegisterAsync(filePath) {
  return loadAndRegister(filePath).catch(e => {
    console.error(`[extra-providers] load error: ${e.message}`);
    return [];
  });
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

function listRegistered() {
  return Array.from(_registry.values()).map(r => ({
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
  return Array.from(_registry.values()).map(r => ({
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

// ---------------------------------------------------------------------------
// Model helpers
// ---------------------------------------------------------------------------

// Return all model IDs from all registered extra providers, formatted as
// `extra-0/model-name` entries for the /v1/models catalog. Only includes
// models that passed the live inference probe.
function getModelCatalog() {
  const out = [];
  for (const [prefix, rec] of _registry) {
    for (const m of rec.workingModels) {
      out.push(`${prefix}/${m.model}`);
    }
    for (const m of rec.untestedModels) {
      out.push(`${prefix}/${m.model}`);
    }
  }
  return out;
}

// Return auto-chain links for all registered extra providers. Only includes
// models that passed the live inference probe. Failed models are excluded so
// they don't waste chain fallback turns.
function getChainLinks() {
  const links = [];
  const FALLBACK_ON = ['error', 'rate_limit', 'timeout', 'empty', 'auth', 'fetch_failed', 'content_policy', 'sampler_backoff', 'matrix_block'];
  for (const [prefix, rec] of _registry) {
    for (const m of rec.workingModels) {
      links.push({ model: `${prefix}/${m.model}`, _probeLatencyMs: m.latencyMs, _probeOk: true, fallbackOn: FALLBACK_ON });
    }
    for (const m of rec.untestedModels) {
      links.push({ model: `${prefix}/${m.model}`, _probeOk: null, fallbackOn: FALLBACK_ON });
    }
  }
  return links;
}

// Synchronously load from disk cache and populate _registry without any
// network calls. Returns true if at least one entry was loaded from cache,
// false if cache file was missing or empty. Call before getChainLinks() so
// cold-start exec paths get extra models without blocking on probe timeouts.
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

      // Reconstruct a probe result from cache without making any network calls.
      // Register ANY entry that has a detected format (openai/anthropic URL),
      // with its cached model probe data. Models that succeeded in the last
      // probe are registered as working; models that failed are not included
      // (the chain will re-probe them live). Entries without cached model data
      // are registered with empty working lists (chain degrades to the auto
      // chain's fallback models).
      const cachedModels = cached.models ? new Map(Object.entries(cached.models)) : new Map();
      if (cached.openai || cached.anthropic) {
        const workingModels = [];
        if (cachedModels.size > 0) {
          for (const [modelId, result] of cachedModels) {
            if (result && result.ok) workingModels.push({ model: modelId, latencyMs: result.latencyMs || 0 });
          }
        }
        const syntheticEntry = { baseURL: entry.baseURL, apiKey: entry.apiKey, models: [] };
        const prefix = nextPrefix();
        const envKey = generateEnvKey(prefix);
        const primaryURL = cached.anthropic || cached.openai;
        keyring.registerKey(envKey, entry.apiKey);
        registerBrand(prefix, { url: primaryURL, envKey });
        _registry.set(prefix, {
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

// Periodic re-probe, mirroring readiness.js's start()/stop() pattern exactly:
// immediate first tick (no cold-boot gap), then a recurring interval,
// overlap-guarded so a slow probe never stacks with the next tick, unref'd so
// it never keeps the process alive on its own.
//
// USER DIRECTIVE, live-witnessed: index.js's _ensureExtraProvidersStarted
// previously called loadAndRegister/loadAndRegisterAsync exactly ONCE per
// process lifetime (a one-shot latch, `if (_extraProvidersStarted) return`).
// A single transient probe failure at that one call -- PROBE_TIMEOUT is only
// 8s by default, and boot time is exactly when many OTHER chain/readiness
// probes are also competing for the same network/CPU -- permanently excluded
// a genuinely working, correctly-configured provider for the rest of that
// process's life ("[extra-providers] skip <url> — no API format detected"),
// even though a standalone re-probe moments later succeeded cleanly and
// discovered real working models. "Capacity must never fail to recover; the
// system must always be ready with what models actually work, based on what
// is dynamically sampled to be available right now" -- a one-shot latch is
// the opposite of that. loadAndRegister's own PROBE_TTL_MS cache-freshness
// check (see loadAndRegister's cached-entry branch) already makes repeat
// calls cheap -- most ticks just confirm the cache is still fresh and return
// immediately; only a genuinely stale or previously-failed entry pays for a
// real re-probe.
let _interval = null;
let _running = false;
function start(filePath, intervalMs = Number(process.env.ACPTOAPI_EXTRA_REPROBE_INTERVAL_MS) || 300000) {
  if (_interval) return; // idempotent
  const tick = () => {
    if (_running) return; // never overlap passes
    _running = true;
    loadAndRegister(filePath).catch(() => {}).finally(() => { _running = false; });
  };
  tick();
  _interval = setInterval(tick, intervalMs);
  if (_interval.unref) _interval.unref();
}
function stop() {
  if (_interval) { clearInterval(_interval); _interval = null; }
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
