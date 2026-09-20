'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { splitBrandModel: _splitBrandModelId, normalizeModelId } = require('./model-id');
const { splitModel, resolveBackend, createSession, sendMessage, streamEvents, probe, BACKENDS } = require('./acp-client');
const { openAIMessagesToACP, createEventMapper, makeChunk, makeFinal, genId, translate, buffer } = require('./translate');
const { getFormat } = require('./formats/index');
const { isBrand, getBrand, listBrands } = require('./openai-brands');
const { PASSTHROUGH_ROUTES, passthrough } = require('./passthrough');
const { discoverModels: discoverNvidiaModels } = require('./providers/nvidia');
const metrics = require('./metrics');
const { buildAutoChain, buildAutoChainLive, getOrder, hasProvider, DEFAULT_MODELS } = require('./auto-chain');
const { listAllQueues } = require('./queues');
const sampler = require('./sampler');
const { getRunHistory } = require('./chain');
const { getAvailableModels } = require('./model-probe-live');
const { getModelScore } = require('./swe-bench-scores');
const keyring = require('./keyring');
const responseCache = require('./response-cache');
const pretest = require('./pretest');
const { classifyError } = require('./chain-machine');
const extraProviders = require('./extra-providers');
const xaiOauth = require('./xai-oauth');
const DEBUG_LOG = process.env.ACPTOAPI_DEBUG_LOG === '1' || process.env.AGENTAPI_DEBUG_LOG === '1';
const OLLAMA_LIST_TTL_MS = Number(process.env.ACPTOAPI_OLLAMA_LIST_TTL_MS) || 30000;
let _ollamaListCache = null;

const ANTHROPIC_ROUTES = [
  { match: 'model starts with minimaxai/', provider: 'nvidia', note: 'routes to NVIDIA NIM' },
  { match: /^(z-ai|meta|qwen|deepseek|mistralai|microsoft|google|nvidia)\//, provider: 'openai-compat', note: 'routes to OpenAI-compat endpoint' },
  { match: 'default (no prefix match)', provider: 'nvidia (if NVIDIA_API_KEY set) | gemini', note: 'NVIDIA NIM when key present, else Google Gemini' },
];
const serverStartTime = Date.now();
const anthropicLog = [];
const ANTHROPIC_LOG_MAX = 50;
const endpointStats = new Map();

function logAnthropic(entry) {
  anthropicLog.push({ ts: new Date().toISOString(), ...entry });
  if (anthropicLog.length > ANTHROPIC_LOG_MAX) anthropicLog.shift();
}

function trackEndpoint(pathname) {
  const count = (endpointStats.get(pathname) || 0) + 1;
  endpointStats.set(pathname, count);
}

function buildModelProbes() {
  const probesByProvider = new Map();
  const models = getAvailableModels({ log: () => {} });

  const isAcpDaemonProvider = (provider) => ['kilo', 'opencode', 'qwen-code', 'codex-cli', 'copilot-cli', 'cline', 'hermes-agent', 'cursor-acp', 'codeium-cli', 'acp-cli'].includes(provider);
  const probeAcpDaemonReachable = (provider) => async () => {
    const b = resolveBackend(provider);
    const ok = await probe(b, 2000);
    if (!ok) throw new Error('ACP daemon unreachable');
  };
  const keyPresenceAlreadyConfirmedByGetAvailableModels = async () => Promise.resolve();

  for (const m of models) {
    const fullId = `${m.provider}/${m.model}`;
    if (probesByProvider.has(m.provider)) continue;
    probesByProvider.set(m.provider, {
      provider: m.provider,
      call: isAcpDaemonProvider(m.provider) ? probeAcpDaemonReachable(m.provider) : keyPresenceAlreadyConfirmedByGetAvailableModels,
    });
  }
  return Array.from(probesByProvider.values());
}

const DOCS_DIR = path.resolve(__dirname, '../docs');
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.svg': 'image/svg+xml' };
const serveStatic = (res, rel) => {
  const safe = rel.replace(/\.\.+/g, '').replace(/^\//, '') || 'index.html';
  const full = path.join(DOCS_DIR, safe);
  if (!full.startsWith(DOCS_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found: ' + rel); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
};

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Private-Network': 'true' });
  res.end(JSON.stringify(body));
};

const { redactKeys } = require('./errors');

function stripStackFrames(s) {
  return s.split(/\n\s*at\s/)[0];
}

function stripAbsolutePaths(s) {
  return s
    .replace(/[A-Za-z]:\\[^\s:]+(?:\\[^\s:]+)*(?::\d+(?::\d+)?)?/g, '<path>')
    .replace(/(?:\/[^\s/:]+)+\.[A-Za-z]+(?::\d+(?::\d+)?)?/g, '<path>');
}

function stripBareFileLineRefs(s) {
  return s.replace(/\b[\w.-]+\.(?:js|ts|mjs|cjs):\d+(?::\d+)?\b/g, '<path>');
}

function safeClientMessage(msg) {
  let s = String(msg == null ? '' : msg);
  s = stripStackFrames(s);
  s = stripAbsolutePaths(s);
  s = stripBareFileLineRefs(s);
  s = redactKeys(s);
  return s.trim() || 'request failed';
}

function errBody({ message, type, code, hint, tried }) {
  const error = { message: safeClientMessage(message) };
  if (type) error.type = type;
  if (code) error.code = code;
  if (hint) error.hint = hint;
  if (Array.isArray(tried)) error.tried = tried;
  return { error };
}
const jsonErr = (res, status, fields) => json(res, status, errBody(fields));

function jsonErrUnlessHeadersSent(res, status, fields) {
  if (!res.headersSent) jsonErr(res, status, fields);
  else { try { res.end(); } catch {} }
}

const CHAIN_EXHAUSTED_RETRY_AFTER_S = Number(process.env.ACPTOAPI_CHAIN_EXHAUSTED_RETRY_AFTER_S) || 5;

function redact(obj) {
  const s = JSON.stringify(obj, (k, v) => {
    const key = String(k || '').toLowerCase();
    if (key.includes('authorization') || key.includes('api_key') || key.includes('apikey') || key.includes('token')) return '[REDACTED]';
    return v;
  });
  try { return JSON.parse(s); } catch { return { value: '[unserializable]' }; }
}

function dlog(scope, payload) {
  if (!DEBUG_LOG) return;
  try {
    console.log(`[debug:${scope}] ${JSON.stringify(redact(payload))}`);
  } catch {
    console.log(`[debug:${scope}] [unserializable]`);
  }
}

const sse = (res, chunk) => res.write(`data: ${JSON.stringify(chunk)}\n\n`);

const MAX_BODY_BYTES = Number(process.env.ACPTOAPI_MAX_BODY_BYTES) || 10 * 1024 * 1024;

async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const c of req) {
    total += c.length;
    if (total > MAX_BODY_BYTES) {
      const err = new Error('Payload too large');
      err.status = 413;
      err.code = 'payload_too_large';
      err.hint = `request body exceeds the ${MAX_BODY_BYTES}-byte limit; set ACPTOAPI_MAX_BODY_BYTES to raise it`;
      throw err;
    }
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch (e) {
    const err = new Error('Invalid JSON in request body');
    err.status = 400;
    err.code = 'invalid_json';
    err.hint = 'request body must be valid JSON; check for trailing commas, unquoted keys, or truncated payload';
    throw err;
  }
}

async function listModels(queuesProvider) {
  const isProviderDefault = (modelId) => {
    for (const [provider, defaultModel] of Object.entries(DEFAULT_MODELS)) {
      if (defaultModel === modelId) return provider;
    }
    return null;
  };

  let acp = [];
  const ollamaUrl = process.env.OLLAMA_URL || 'http://localhost:11434';
  const listOllama = (async () => {
    const now = Date.now();
    if (_ollamaListCache && (now - _ollamaListCache.ts) < OLLAMA_LIST_TTL_MS) return _ollamaListCache.models;
    try {
      const r = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(1500) });
      const d = await r.json();
      const models = (d.models || []).map(m => m.name);
      _ollamaListCache = { models, ts: Date.now() };
      return models;
    } catch {
      _ollamaListCache = { models: [], ts: Date.now() };
      return [];
    }
  })();
  const listChatJimmy = (async () => {
    try {
      const { listChatJimmyModels } = require('./providers/chatjimmy');
      return await listChatJimmyModels();
    } catch { return []; }
  })();
  const listAcp = (async () => {
    if (process.env.ACPTOAPI_ENABLE_ACP !== '1') return [];
    let spawnFn = null;
    try { spawnFn = require('./acp-launcher').spawnDaemon; } catch {}
    return Promise.all(['kilo', 'opencode'].map(async prefix => {
      const b = resolveBackend(prefix);
      let ok = await probe(b, 1500);
      if (!ok && spawnFn) {
        try { await spawnFn(prefix, () => {}); ok = await probe(b, 1500); } catch {}
      }
      return { prefix, ok };
    }));
  })();
  const [ollamaModels, cjModels, acpResult] = await Promise.all([listOllama, listChatJimmy, listAcp]);
  acp = acpResult;
  const created = Math.floor(Date.now() / 1000);
  const MODEL_CATALOG = {
    kilo: ['cerebras/qwen-3-235b-a22b-instruct-2507', 'cerebras/gpt-oss-120b', 'cerebras/zai-glm-4.7'],
    opencode: ['minimax-m2.5-free', 'nemotron-3-super-free'],
  };
  const seen = new Set();
  const data = [];
  if (process.env.ACPTOAPI_ENABLE_ACP === '1') {
    for (const r of acp) {
      for (const m of MODEL_CATALOG[r.prefix]) {
        const id = `${r.prefix}/${m}`;
        if (seen.has(id)) continue;
        seen.add(id);
        const entry = { id, object: 'model', owned_by: r.prefix, created, status: r.ok ? 'up' : 'pending' };
        const score = getModelScore(id);
        if (score) entry.swe_bench_score = score;
        const defaultFor = isProviderDefault(id);
        if (defaultFor) entry.default_for_provider = defaultFor;
        data.push(entry);
      }
    }
  }
  for (const m of cjModels) {
    const id = `chatjimmy/${m}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const entry = { id, object: 'model', owned_by: 'chatjimmy', created };
    const defaultFor = isProviderDefault(id);
    if (defaultFor) entry.default_for_provider = defaultFor;
    data.push(entry);
  }
  for (const name of ollamaModels) {
    const id = `ollama/${name}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const entry = { id, object: 'model', owned_by: 'ollama', created };
    const score = getModelScore(id);
    if (score) entry.swe_bench_score = score;
    const defaultFor = isProviderDefault(id);
    if (defaultFor) entry.default_for_provider = defaultFor;
    data.push(entry);
  }
  if (keyring.hasAnyKey('ANTHROPIC_API_KEY')) {
    for (const name of ['anthropic/claude-opus-4', 'anthropic/claude-sonnet-4', 'anthropic/claude-haiku-4.5']) {
      if (seen.has(name)) continue;
      seen.add(name);
      const entry = { id: name, object: 'model', owned_by: 'anthropic', created };
      const score = getModelScore(name);
      if (score) entry.swe_bench_score = score;
      const defaultFor = isProviderDefault(name);
      if (defaultFor) entry.default_for_provider = defaultFor;
      data.push(entry);
    }
  }
  if (keyring.hasAnyKey('GEMINI_API_KEY')) {
    for (const name of ['google/gemini-2.5-pro', 'google/gemini-2.0-flash']) {
      if (seen.has(name)) continue;
      seen.add(name);
      const entry = { id: name, object: 'model', owned_by: 'google', created };
      const score = getModelScore(name);
      if (score) entry.swe_bench_score = score;
      const defaultFor = isProviderDefault(name);
      if (defaultFor) entry.default_for_provider = defaultFor;
      data.push(entry);
    }
  }
  try {
    if (require('./openai-oauth').hasCredentials()) {
      const id = DEFAULT_MODELS['openai-oauth'];
      if (!seen.has(id)) {
        seen.add(id);
        const entry = { id, object: 'model', owned_by: 'openai-oauth', created };
        const score = getModelScore(id);
        if (score) entry.swe_bench_score = score;
        entry.default_for_provider = 'openai-oauth';
        data.push(entry);
      }
    }
  } catch {}
  if (keyring.hasAnyKey('NVIDIA_API_KEY')) {
    try {
      const nvidiaModels = await discoverNvidiaModels(keyring.getKey('NVIDIA_API_KEY'));
      for (const m of nvidiaModels) {
        const id = m.id || m;
        if (seen.has(id)) continue;
        seen.add(id);
        const entry = { id, object: 'model', owned_by: 'nvidia', created };
        const score = getModelScore(id);
        if (score) entry.swe_bench_score = score;
        const defaultFor = isProviderDefault(id);
        if (defaultFor) entry.default_for_provider = defaultFor;
        data.push(entry);
      }
    } catch (err) {
      console.error('[nvidia] Model discovery failed:', err.message);
    }
  }
  const BRAND_CATALOG = {
    groq: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
    openrouter: ['auto', 'meta-llama/llama-3.3-70b-instruct'],
    together: ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'Qwen/Qwen2.5-72B-Instruct-Turbo'],
    deepseek: ['deepseek-chat', 'deepseek-reasoner'],
    xai: ['grok-2-latest', 'grok-beta'],
    cerebras: ['zai-glm-4.7', 'gpt-oss-120b', 'gemma-4-31b'],
    perplexity: ['llama-3.1-sonar-large-128k-online', 'llama-3.1-sonar-small-128k-online'],
    mistral: ['mistral-large-latest', 'mistral-small-latest', 'codestral-latest'],
    fireworks: ['accounts/fireworks/models/llama-v3p3-70b-instruct'],
    openai:         ['gpt-4o', 'gpt-4o-mini', 'o1', 'o1-mini'],
    nvidia:         ['deepseek-ai/deepseek-r1', 'deepseek-ai/deepseek-v3', 'meta/llama-3.3-70b-instruct'],
    sambanova:      ['Meta-Llama-3.3-70B-Instruct', 'Meta-Llama-3.1-405B-Instruct'],
    cloudflare:     ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/mistral/mistral-7b-instruct-v0.2-lora'],
    zai:            ['glm-4-plus', 'glm-4-air'],
    qwen:           ['qwen-plus', 'qwen-max'],
    codestral:      ['codestral-latest'],
    'opencode-zen': ['claude-sonnet-4-5', 'claude-haiku-4-5'],
  };
  for (const brand of listBrands()) {
    const envKey = getBrand(brand).envKey;
    if (!keyring.hasAnyKey(envKey)) continue;
    for (const m of (BRAND_CATALOG[brand] || [])) {
      const id = `${brand}/${m}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const entry = { id, object: 'model', owned_by: brand, created };
      const score = getModelScore(id);
      if (score) entry.swe_bench_score = score;
      const defaultFor = isProviderDefault(id);
      if (defaultFor) entry.default_for_provider = defaultFor;
      data.push(entry);
    }
  }
  let extraQueues = null;
  if (typeof queuesProvider === 'function') {
    try { extraQueues = await queuesProvider(); } catch { extraQueues = null; }
  }
  try {
    const queues = listAllQueues({ queuesMap: extraQueues });
    for (const q of queues) {
      data.push({ id: `queue/${q.name}`, object: 'queue', owned_by: 'queue', queue_links: q.links, source: q.source, created });
    }
  } catch {}
  try {
    const extraEntries = extraProviders.getAllEntries();
    for (const ep of extraEntries) {
      for (const m of ep.workingModels) {
        const id = `${ep.prefix}/${m.model}`;
        if (seen.has(id)) continue;
        seen.add(id);
        data.push({ id, object: 'model', owned_by: ep.prefix, created, capabilities: { formats: ep.formats, live_probe_ok: true, probe_latency_ms: m.latencyMs } });
      }
      for (const m of ep.untestedModels) {
        const id = `${ep.prefix}/${m}`;
        if (seen.has(id)) continue;
        seen.add(id);
        data.push({ id, object: 'model', owned_by: ep.prefix, created, capabilities: { formats: ep.formats, live_probe_ok: null } });
      }
    }
  } catch {}
  data.sort(byScoreDescendingQueuesLast);
  const { modelCapabilityTools } = require('./auto-chain');
  for (const m of data) {
    if (m.object !== 'model') continue;
    const t = modelCapabilityTools(m.id);
    m.capabilities = { tools: t === null ? 'unknown' : t };
  }
  return { object: 'list', data };
}

function byScoreDescendingQueuesLast(a, b) {
  const aQ = a.object === 'queue', bQ = b.object === 'queue';
  if (aQ !== bQ) return aQ ? 1 : -1;
  const aS = typeof a.swe_bench_score === 'number' ? a.swe_bench_score : -Infinity;
  const bS = typeof b.swe_bench_score === 'number' ? b.swe_bench_score : -Infinity;
  return bS - aS;
}


function splitBrandModel(fullModel) {
  return _splitBrandModelId(fullModel, { normalize: true });
}

async function handleXaiOauthChat(req, res, body) {
  const sub = splitBrandModel(body.model);
  const upstreamModel = sub ? sub.model : body.model;
  const { stripMaxTokens, shouldOmitMaxTokens } = require('./model-token-limits');
  let upstreamBody = { ...body, model: upstreamModel };
  if (shouldOmitMaxTokens(body.model) || shouldOmitMaxTokens(`xai-oauth/${upstreamModel}`)) {
    upstreamBody = stripMaxTokens(upstreamBody);
  }
  delete upstreamBody.stream;
  const stream = body.stream === true;
  let creds;
  try {
    creds = await xaiOauth.getCredentials();
  } catch (e) {
    console.log(`[acptoapi] xai-oauth credential resolution failed: ${e.message}`);
    return jsonErr(res, 401, { message: e.message, type: 'authentication_error', code: 'missing_provider_key', hint: "run 'node bin/acptoapi.js --xai-oauth-login' to authenticate via xAI device-code OAuth" });
  }
  const msgCount = Array.isArray(body.messages) ? body.messages.length : 0;
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  const reasoningKeys = Object.keys(body).filter(k => /reason|thinking|effort/i.test(k));
  console.log(`[acptoapi] /v1/chat/completions provider=xai-oauth model=${upstreamModel} stream=${stream} messages=${msgCount} max_tokens=${body.max_tokens ?? 'unset'} tools=${hasTools} reasoning_params=${reasoningKeys.length ? reasoningKeys.join(',') : 'none'}`);
  let clientClosed = false;
  req.on('close', () => {
    if (!res.writableEnded) {
      clientClosed = true;
      console.log(`[acptoapi] xai-oauth: client closed connection before response finished (model=${upstreamModel} stream=${stream})`);
    }
  });
  const url = `${creds.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const doFetch = (bearer) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
    body: JSON.stringify({ ...upstreamBody, stream }),
  });
  try {
    let r = await doFetch(creds.bearer);
    if (r.status === 401) {
      console.log('[acptoapi] xai-oauth: upstream 401, attempting reactive token refresh');
      try {
        const refreshed = await xaiOauth.forceRefresh();
        r = await doFetch(refreshed.bearer);
      } catch (e) {
        console.log(`[acptoapi] xai-oauth: reactive refresh failed: ${e.message}`);
        return jsonErr(res, 401, { message: `xAI OAuth refresh failed: ${e.message}`, type: 'authentication_error', code: 'provider_auth_failed', hint: "re-authenticate with 'node bin/acptoapi.js --xai-oauth-login'" });
      }
    }
    console.log(`[acptoapi] xai-oauth: upstream responded status=${r.status} content-type=${r.headers.get('content-type') || 'unknown'}`);
    res.writeHead(r.status, {
      'Content-Type': r.headers.get('content-type') || 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Private-Network': 'true',
    });
    if (stream && r.body) {
      const reader = r.body.getReader();
      let bytesWritten = 0;
      let sawDone = false;
      let lastFinishReason = null;
      let chunkBuf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytesWritten += value.length;
        chunkBuf += Buffer.from(value).toString('utf8');
        if (chunkBuf.includes('[DONE]')) sawDone = true;
        const finishMatch = chunkBuf.match(/"finish_reason"\s*:\s*"([^"]+)"/g);
        if (finishMatch && finishMatch.length) lastFinishReason = finishMatch[finishMatch.length - 1];
        if (chunkBuf.length > 8192) chunkBuf = chunkBuf.slice(-2048);
        res.write(Buffer.from(value));
      }
      res.end();
      console.log(`[acptoapi] xai-oauth: stream ended bytes=${bytesWritten} saw_done_sentinel=${sawDone} last_finish_reason=${lastFinishReason || 'none'} client_closed_early=${clientClosed}`);
    } else {
      const text = await r.text();
      res.end(text);
      let finishReason = 'unknown';
      let contentLen = null;
      try {
        const parsed = JSON.parse(text);
        finishReason = parsed?.choices?.[0]?.finish_reason ?? 'unknown';
        contentLen = parsed?.choices?.[0]?.message?.content?.length ?? null;
        const usage = parsed?.usage;
        if (usage) console.log(`[acptoapi] xai-oauth: usage prompt=${usage.prompt_tokens} completion=${usage.completion_tokens} reasoning=${usage.completion_tokens_details?.reasoning_tokens ?? 'n/a'}`);
      } catch {}
      console.log(`[acptoapi] xai-oauth: non-stream response finish_reason=${finishReason} content_length=${contentLen ?? 'n/a'} response_bytes=${text.length}`);
    }
  } catch (e) {
    console.log(`[acptoapi] xai-oauth: request failed: ${e.message} headers_sent=${res.headersSent}`);
    jsonErrUnlessHeadersSent(res, 500, { message: e.message, type: 'api_error', code: 'upstream_error', hint: 'request to xai-oauth failed before a response could be streamed; check xAI status' });
  }
}

function logKeyRotation(brandName) {
  return ({ reason, index, nextIndex }) =>
    console.log(`[acptoapi] key-rotate provider=${brandName} reason=${reason} key-index=${index} next-index=${nextIndex}`);
}

async function handleBrandChat(req, res, brandName, body) {
  if (brandName === 'xai-oauth') return handleXaiOauthChat(req, res, body);
  const brand = getBrand(brandName);
  const envKey = brand.envKey;
  const allKeys = keyring.getKeys(envKey);
  if (allKeys.length === 0) return jsonErr(res, 401, { message: `Missing ${envKey} env var for brand '${brandName}'`, type: 'authentication_error', code: 'missing_provider_key', hint: `set ${envKey} (or ${envKey}_1..N for multi-key) in .env to use '${brandName}/' models` });
  const sub = splitBrandModel(body.model);
  const upstreamModel = sub ? sub.model : body.model;
  console.log(`[acptoapi] /v1/chat/completions provider=${brandName} model=${upstreamModel} stream=${body.stream === true} keys=${allKeys.length}`);
  const { shouldOmitMaxTokens, stripMaxTokens } = require('./model-token-limits');
  let upstreamBody = { ...body, model: upstreamModel };
  if (shouldOmitMaxTokens(body.model) || shouldOmitMaxTokens(`${brandName}/${upstreamModel}`)) {
    upstreamBody = stripMaxTokens(upstreamBody);
  }
  delete upstreamBody.stream;
  const stream = body.stream === true;
  try {
    const rotated = await keyring.rotateKeys(envKey, (apiKey) => fetch(brand.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ ...upstreamBody, stream }),
    }), { onRotate: logKeyRotation(brandName) });
    const r = rotated.result;
    const keyCount = rotated.candidateCount;
    if (r.status === 429) {
      const st = keyring.peekStatus(envKey);
      const next = st.map(k => k.nextRetryInMs).filter(n => typeof n === 'number' && n > 0);
      const waitMs = next.length ? Math.min(...next) : 30000;
      return jsonErr(res, 429, { message: `Rate limited by ${brandName}`, type: 'rate_limit_error', code: 'rate_limited', hint: `all ${keyCount} ${envKey} key(s) are rate limited; next key rotation in ~${Math.ceil(waitMs / 1000)}s (backoff steps 30s,60s,2m,4m,8m). add ${envKey}_1..N for more keys, or route via a multi-provider chain` });
    }
    if (r.status === 401 || r.status === 403) {
      return jsonErr(res, 401, { message: `Authentication failed for ${brandName}`, type: 'authentication_error', code: 'provider_auth_failed', hint: `all ${keyCount} ${envKey} key(s) were rejected by ${brandName}; verify ${envKey} is valid and has access to '${upstreamModel}'` });
    }
    res.writeHead(r.status, {
      'Content-Type': r.headers.get('content-type') || 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Private-Network': 'true',
    });
    if (stream && r.body) {
      const reader = r.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      res.end();
    } else {
      const text = await r.text();
      res.end(text);
    }
  } catch (e) {
    jsonErrUnlessHeadersSent(res, 500, { message: e.message, type: 'api_error', code: 'upstream_error', hint: `request to ${brandName} failed before a response could be streamed; check provider status and ${envKey}` });
  }
}

function handleEmbeddingsGone(req, res) {
  json(res, 410, {
    error: {
      message: 'Embeddings are not provided by acptoapi. The gm stack uses rs-learn natively (in-process via fastembed-rs / nomic-embed-text). acptoapi is for LLM chat/completions only. If you reach this endpoint your caller is misconfigured  - host_vec_embed should be talking to the rs-learn-embed sidecar, not to /v1/embeddings.',
      code: 'embeddings_not_here',
      hint: 'See rs-learn for the native embedder; see gm-starter/gm-plugkit/plugkit-wasm-wrapper.js::host_vec_embed for the canonical wiring.',
    },
  });
}

function estimateTokens(input) {
  if (typeof input === 'string') return Math.ceil(input.length / 4);
  if (Array.isArray(input)) {
    let total = 0;
    for (const m of input) {
      if (typeof m.content === 'string') total += Math.ceil(m.content.length / 4);
      else if (Array.isArray(m.content)) for (const b of m.content) {
        if (b.type === 'text' && b.text) total += Math.ceil(b.text.length / 4);
        else if (b.type === 'tool_use') total += Math.ceil(JSON.stringify(b.input || {}).length / 4) + 8;
        else if (b.type === 'tool_result') total += Math.ceil(JSON.stringify(b.content || '').length / 4) + 4;
        else if (b.type === 'image') total += 1500;
      }
      total += 4;
    }
    return total;
  }
  return 0;
}

async function handleCountTokens(req, res) {
  const body = await readBody(req);
  const messages = body.messages || [];
  const system = body.system || '';
  const tools = body.tools || [];
  let count = estimateTokens(messages) + estimateTokens(system);
  for (const t of tools) count += Math.ceil(JSON.stringify(t).length / 4);
  json(res, 200, { input_tokens: count });
}

async function executeBrandModel(brandName, opts) {
  if (brandName === 'xai-oauth') return executeXaiOauthModel(opts);
  if (brandName === 'openai-oauth') return require('./sdk').chat(opts);
  const brand = getBrand(brandName);
  const envKey = brand.envKey;
  const allKeys = keyring.getKeys(envKey);
  if (allKeys.length === 0) {
    const e = new Error(`Missing ${envKey} env var for brand '${brandName}'`);
    e.status = 401;
    throw e;
  }
  const sub = splitBrandModel(opts.model);
  const upstreamModel = sub ? sub.model : opts.model;
  const { shouldOmitMaxTokens, stripMaxTokens } = require('./model-token-limits');
  let upstreamBody = { ...opts, model: upstreamModel };
  if (shouldOmitMaxTokens(opts.model) || shouldOmitMaxTokens(`${brandName}/${upstreamModel}`)) {
    upstreamBody = stripMaxTokens(upstreamBody);
  }
  delete upstreamBody.stream;
  delete upstreamBody.timeout;
  const rotated = await keyring.rotateKeys(envKey, (apiKey) => fetch(brand.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(upstreamBody),
  }), { onRotate: logKeyRotation(brandName) });
  const r = rotated.result;
  const text = await r.text();
  if (!r.ok) {
    const e = new Error(`${brandName} ${r.status}: ${text.slice(0, 200)}`);
    e.status = r.status;
    if (r.status === 429) e.code = 'RATE_LIMIT';
    throw e;
  }
  try { return JSON.parse(text); } catch { const e = new Error(`${brandName}: non-JSON response`); throw e; }
}

async function executeXaiOauthModel(opts) {
  const sub = splitBrandModel(opts.model);
  const upstreamModel = sub ? sub.model : opts.model;
  const upstreamBody = { ...opts, model: upstreamModel };
  delete upstreamBody.stream;
  const timeoutMs = upstreamBody.timeout;
  delete upstreamBody.timeout;
  return xaiOauth.chatCompletion(upstreamBody, timeoutMs != null ? { timeoutMs } : {});
}

async function executeAcpModel(prefix, opts, backends) {
  const backend = resolveBackend(prefix, backends);
  const prompt = openAIMessagesToACP(opts.messages || []);
  const id = genId();
  const sessionId = await createSession(backend);
  const ctrl = new AbortController();
  const mapper = createEventMapper(id, opts.model);
  let fullText = '';
  let finished = false;
  const overallTimeoutMs = Number(process.env.ACP_OVERALL_TIMEOUT_MS) || 240000;
  const overallTimer = setTimeout(() => { if (!finished) ctrl.abort(new Error(`ACP overall timeout ${overallTimeoutMs}ms`)); }, overallTimeoutMs);
  const split = splitModel(opts.model);
  const sub = split ? split.model : opts.model;
  let msgErr = null;
  const msgPromise = sendMessage(backend, sessionId, prompt, sub)
    .then(r => r.text())
    .catch(e => { msgErr = e; return null; });
  try {
    for await (const ev of streamEvents(backend, sessionId, ctrl.signal)) {
      const isTerminal = mapper.mapEvent(ev, chunk => { if (chunk.choices?.[0]?.delta?.content) fullText += chunk.choices[0].delta.content; });
      if (isTerminal) { finished = true; break; }
    }
  } catch (e) {
    clearTimeout(overallTimer); ctrl.abort();
    await msgPromise;
    const err = new Error(`${prefix}: ${e?.message || String(e)}`);
    throw err;
  } finally { clearTimeout(overallTimer); ctrl.abort(); }
  await msgPromise;
  if (msgErr) { const e = new Error(`${prefix}: ${msgErr?.message || String(msgErr)}`); throw e; }
  if (!fullText.trim()) { const e = new Error(`${prefix}: empty response`); throw e; }
  return makeFinal(id, opts.model, fullText);
}

async function executeViaProvider(name, opts) {
  const { getProvider } = require('./providers');
  const provider = getProvider(name);
  let modelStr = opts.model;
  if (name === 'chatjimmy' || name === 'openai-compat' || name === 'nvidia' || name === 'ollama' || name === 'anthropic' || name === 'gemini' || name === 'bedrock') {
    const slash = modelStr.indexOf('/');
    if (slash >= 0) modelStr = modelStr.slice(slash + 1);
  }
  const id = genId();
  let fullText = '';
  for await (const ev of provider.stream({ ...opts, model: modelStr })) {
    if (ev && ev.type === 'text-delta' && ev.textDelta) fullText += ev.textDelta;
  }
  if (!fullText.trim()) { const e = new Error(`${name}: empty response`); throw e; }
  return makeFinal(id, opts.model, fullText);
}

async function executeForModel(opts, backends) {
  const sub = splitBrandModel(opts.model);
  if (sub && isBrand(sub.prefix)) return executeBrandModel(sub.prefix, opts);
  const split = splitModel(opts.model);
  if (split) return executeAcpModel(split.prefix, opts, backends);
  const inferred = inferProviderForModel(opts.model);
  if (inferred && inferred !== 'brand' && inferred !== 'acp') {
    return executeViaProvider(inferred, opts);
  }
  const e = new Error(`Unknown model '${opts.model}'`); e.status = 400; e.hint = `model string invalid: use <brand>/<model>, <acp-agent>/<model>, queue/<name>, or a named chain`; throw e;
}

async function handleChat(req, res, backends) {
  const body = await readBody(req);
  const wantsStream = body.stream === true;
  pretest.markBusy();
  let _idleOnce = false;
  const _markIdleOnce = () => { if (_idleOnce) return; _idleOnce = true; pretest.markIdle(); };
  res.on('close', _markIdleOnce);
  res.on('finish', _markIdleOnce);

  if (body.model && process.env.ACPTOAPI_DISABLE_CHAIN !== '1') {
    let autoLinks = null;
    const { parseCommaList } = require('./sdk');
    const commaParts = parseCommaList(body.model);
    if (commaParts) {
      autoLinks = commaParts.map(m => ({ model: m }));
      console.log(`[acptoapi] /v1/chat/completions using comma chain (${commaParts.length} links)`);
    }
    if (!autoLinks) {
      try {
        const namedChains = require('./named-chains');
        const namedLinks = namedChains.resolveChain(body.model);
        if (namedLinks && namedLinks.length) {
          autoLinks = namedLinks;
          console.log(`[acptoapi] /v1/chat/completions using named queue '${body.model}' (${namedLinks.length} links)`);
        }
      } catch {}
    }
    if (!autoLinks) {
      const directlyRoutable = (() => {
        const sub = splitBrandModel(body.model);
        if (sub && isBrand(sub.prefix)) return true;
        if (splitModel(body.model)) return true;
        const inf = inferProviderForModel(body.model);
        return !!(inf && inf !== 'brand');
      })();
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
      if (directlyRoutable) {
        autoLinks = await buildAutoChainLive(body.model, { hasTools });
      } else {
        const unresolvable = isUnresolvableModelString(body.model);
        if (unresolvable) {
          return jsonErr(res, 400, { message: unresolvable.message, type: 'invalid_request_error', code: unresolvable.code, hint: unresolvable.hint });
        }
        console.log(`[acptoapi] /v1/chat/completions unknown model '${body.model}', falling through to default queue${hasTools ? ' (tools[])' : ''}`);
        autoLinks = await buildAutoChainLive(undefined, { hasTools });
      }
    }
    try {
      const { runChat, runStream } = require('./chain-machine');
      const fallbackOn = ['error', 'rate_limit', 'timeout', 'empty', 'auth', 'fetch_failed', 'content_policy', 'sampler_backoff', 'matrix_block'];
      const REASONING_TIMEOUT_BRANDS = /^xai-oauth\//;
      const isReasoningModel = typeof body.model === 'string' && REASONING_TIMEOUT_BRANDS.test(body.model);
      const explicitLinkTimeout = Number(process.env.ACPTOAPI_LINK_TIMEOUT_MS)
        || Number(process.env.ACPTOAPI_CHAIN_LINK_TIMEOUT_MS);
      const isSingleLinkChain = Array.isArray(autoLinks) && autoLinks.length === 1;
      const explicitSingleLinkTimeout = Number(process.env.ACPTOAPI_SINGLE_LINK_LINK_TIMEOUT_MS);
      const linkTimeout = isSingleLinkChain
        ? (explicitSingleLinkTimeout || 0)
        : (explicitLinkTimeout || (isReasoningModel ? Number(process.env.ACPTOAPI_REASONING_LINK_TIMEOUT_MS) || 300000 : 120000));
      const chainBudgetMs = isSingleLinkChain
        ? Number(process.env.ACPTOAPI_SINGLE_LINK_CHAIN_BUDGET_MS) || 0
        : undefined;
      const sameLinkRetryBudgetMs = isSingleLinkChain
        ? Number(process.env.ACPTOAPI_SINGLE_LINK_SAME_LINK_RETRY_BUDGET_MS) || Number.POSITIVE_INFINITY
        : undefined;
      if (wantsStream) {
        const sdk = require('./sdk');
        const rid = genId();
        let mdl = body.model || 'auto';
        let sawAny = false;
        let headersSent = false;
        const attempted = [];
        const ensureHeaders = () => {
          if (headersSent) return;
          headersSent = true;
          const extra = {};
          if (mdl) extra['X-Acptoapi-Served-Model'] = mdl;
          if (attempted.length) extra['X-Acptoapi-Chain-Attempts'] = String(attempted.length);
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Private-Network': 'true', ...extra });
        };
        try {
          const streamGen = runStream(
            autoLinks,
            { fallbackOn, timeout: linkTimeout, _requestedModel: body.model, sampler, ...(chainBudgetMs === undefined ? {} : { chainBudgetMs }), ...(sameLinkRetryBudgetMs === undefined ? {} : { sameLinkRetryBudgetMs }) },
            async function* (callOpts) {
              mdl = callOpts.model;
              attempted.push(callOpts.model);
              const { clampMaxTokensForModel } = require('./model-token-limits');
              const linkMaxTokens = clampMaxTokensForModel(callOpts.model, body.max_tokens);
              for await (const ev of sdk.stream({ ...body, model: callOpts.model, max_tokens: linkMaxTokens, stream: undefined })) {
                yield ev;
              }
            },
            null,
          );
          let toolCallIdx = 0;
          let finishReason = 'stop';
          for await (const ev of streamGen) {
            if ((ev.type === 'text-delta' && ev.textDelta) || ev.type === 'tool-call') ensureHeaders();
            if (ev.type === 'text-delta' && ev.textDelta) {
              sawAny = true;
              sse(res, makeChunk(rid, mdl, { content: ev.textDelta }));
            } else if (ev.type === 'tool-call') {
              sawAny = true;
              finishReason = 'tool_calls';
              const tc = { index: toolCallIdx++, id: ev.toolCallId || '', type: 'function', function: { name: ev.toolName || '', arguments: JSON.stringify(ev.args || {}) } };
              sse(res, makeChunk(rid, mdl, { tool_calls: [tc] }));
            }
          }
          ensureHeaders();
          sse(res, makeChunk(rid, mdl, {}, finishReason));
          res.write('data: [DONE]\n\n');
          res.end();
        } catch (e) {
          console.error(`[acptoapi] streaming chain exhausted: ${e.message}`);
          const tried = Array.isArray(e.attempted) ? e.attempted.filter(a => !a.ok).map(a => ({ model: a.model, reason: a.reason })) : [];
          if (!headersSent && !sawAny) {
            headersSent = true;
            try { res.setHeader('Retry-After', String(CHAIN_EXHAUSTED_RETRY_AFTER_S)); } catch {}
            if (tried.length) { try { res.setHeader('X-Acptoapi-Chain-Exhausted', JSON.stringify(tried)); } catch {} }
            jsonErr(res, 503, {
              message: 'All upstream providers are currently unavailable. Please retry shortly.',
              type: 'api_error',
              code: 'chain_exhausted',
              hint: tried.length
                ? `every chain link failed: ${tried.map(t => `${t.model} (${t.reason})`).join(', ')}`
                : 'every chain link failed; see the acptoapi log for the per-link reason',
            });
            _markIdleOnce();
            return;
          }
          if (!headersSent) {
            headersSent = true;
            const extra = {};
            if (tried.length) extra['X-Acptoapi-Chain-Exhausted'] = JSON.stringify(tried);
            try { res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Private-Network': 'true', ...extra }); } catch {}
          }
          sse(res, makeChunk(rid, mdl, {}, 'stop'));
          try { res.write('data: [DONE]\n\n'); res.end(); } catch {}
        }
        _markIdleOnce();
        return;
      }
      const cacheWrap = await responseCache.wrap(body, async () => {
        const r = await runChat(
          autoLinks,
          { fallbackOn, timeout: linkTimeout, _requestedModel: body.model, sampler, ...(chainBudgetMs === undefined ? {} : { chainBudgetMs }), ...(sameLinkRetryBudgetMs === undefined ? {} : { sameLinkRetryBudgetMs }) },
          async (callOpts) => {
            try {
              const { clampMaxTokensForModel } = require('./model-token-limits');
              const linkMaxTokens = clampMaxTokensForModel(callOpts.model, body.max_tokens);
              return await executeForModel({ ...body, model: callOpts.model, max_tokens: linkMaxTokens }, backends);
            } catch (e) {
              if (/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(e.message)) {
                const wrapped = new Error(e.message);
                wrapped.code = 'FETCH_FAILED';
                throw wrapped;
              }
              if (e.status === 401 || e.status === 403) {
                const wrapped = new Error(e.message);
                wrapped.code = 'AUTH';
                throw wrapped;
              }
              if (e.status === 429) {
                const wrapped = new Error(e.message);
                wrapped.code = 'RATE_LIMIT';
                throw wrapped;
              }
              throw e;
            }
          },
          null,
        );
        return r;
      });
      const result = cacheWrap.value;
      try { res.setHeader('X-Acptoapi-Cache', cacheWrap.hit); } catch {}
      const servedModel = result.__chainAttempted?.findLast?.(a => a.ok)?.model || result.model || body.model;
      const chainAttempts = result.__chainAttempted?.length || 1;
      try {
        res.setHeader('X-Acptoapi-Served-Model', servedModel);
        res.setHeader('X-Acptoapi-Chain-Attempts', String(chainAttempts));
      } catch {}
      if (body.model && body.model !== 'auto' && servedModel && servedModel !== body.model) {
        try {
          res.setHeader('X-Acptoapi-Requested-Model', body.model);
          res.setHeader('X-Acptoapi-Model-Substituted', 'true');
        } catch {}
      }
      if (cacheWrap.hit === 'hit' || cacheWrap.hit === 'dedupe') {
        console.log(`[acptoapi] /v1/chat/completions cache=${cacheWrap.hit} model=${body.model}`);
      } else {
        console.log(`[acptoapi] /v1/chat/completions chain ok served-by=${servedModel} attempts=${result.__chainAttempted?.length || 1} cache=${cacheWrap.hit}`);
      }
      try {
        const { recordRunDirect } = require('./chain');
        const attempted = Array.isArray(result.__chainAttempted) && result.__chainAttempted.length
          ? result.__chainAttempted
          : [{ model: servedModel, ok: true, reason: cacheWrap.hit && cacheWrap.hit !== 'bypass' ? 'cache' : null }];
        recordRunDirect({ requestedModel: body.model, servedBy: servedModel, finalModel: servedModel, attempted });
      } catch {}
      delete result.__chainAttempted;
      if (wantsStream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Private-Network': 'true' });
        const msg = result.choices?.[0]?.message || {};
        const realFinishReason = result.choices?.[0]?.finish_reason || 'stop';
        const rid = result.id || genId();
        const mdl = result.model || body.model;
        const deltaFields = { role: 'assistant' };
        if (msg.content) deltaFields.content = msg.content;
        if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) deltaFields.tool_calls = msg.tool_calls;
        if (msg.refusal) deltaFields.refusal = msg.refusal;
        sse(res, makeChunk(rid, mdl, deltaFields));
        sse(res, makeChunk(rid, mdl, {}, realFinishReason));
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      return json(res, 200, result);
    } catch (e) {
      console.error(`[acptoapi] chain exhausted (all providers fell back): ${e.message}`);
      const content = 'All upstream providers are currently unavailable. Please retry shortly.';
      const rid = genId();
      const mdl = body.model || 'auto';
      const tried = Array.isArray(e.attempted) ? e.attempted.filter(a => !a.ok).map(a => ({ model: a.model, reason: a.reason })) : [];
      if (tried.length) {
        try { res.setHeader('X-Acptoapi-Chain-Exhausted', JSON.stringify(tried)); } catch {}
      }
      if (!res.headersSent) {
        try { res.setHeader('Retry-After', String(CHAIN_EXHAUSTED_RETRY_AFTER_S)); } catch {}
      }
      return jsonErr(res, 503, {
        message: content,
        type: 'api_error',
        code: 'chain_exhausted',
        hint: tried.length
          ? `every chain link failed: ${tried.map(t => `${t.model} (${t.reason})`).join(', ')}`
          : 'every chain link failed; see the acptoapi log for the per-link reason',
      });
    }
  }

  const sub = splitBrandModel(body.model);
  if (sub && isBrand(sub.prefix)) return handleBrandChat(req, res, sub.prefix, body);
  const split = splitModel(body.model);
  if (!split) {
    const { BRANDS } = require('./openai-brands');
    const brandNames = Object.keys(BRANDS).join(', ');
    const acpPrefixes = Object.keys(BACKENDS).join(', ');
    return jsonErr(res, 400, { message: `Unknown model '${body.model || ''}'`, type: 'invalid_request_error', code: 'unknown_model', hint: `model string invalid: use <brand>/<model> (brands: ${brandNames}) or <acp-agent>/<model> (acp: ${acpPrefixes})` });
  }
  const { prefix, model } = split;
  console.log(`[acptoapi] /v1/chat/completions provider=acp/${prefix} model=${model} stream=${body.stream === true}`);
  const backend = resolveBackend(prefix, backends);
  const prompt = openAIMessagesToACP(body.messages || []);
  const id = genId();
  const stream = body.stream === true;

  const sessionId = await createSession(backend);
  const ctrl = new AbortController();
  const mapper = createEventMapper(id, body.model || `${prefix}/${model}`);
  let fullText = '';
  let finished = false;

  if (stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Private-Network': 'true' });
  }

  const emit = chunk => {
    if (chunk.choices?.[0]?.delta?.content) fullText += chunk.choices[0].delta.content;
    if (stream) sse(res, chunk);
  };

  const msgPromise = sendMessage(backend, sessionId, prompt, model)
    .then(r => r.text())
    .catch(() => null);

  const overallTimeoutMs = Number(process.env.ACP_OVERALL_TIMEOUT_MS) || 240000;
  const overallTimer = setTimeout(() => {
    if (!finished) {
      ctrl.abort(new Error(`ACP chat overall timeout after ${overallTimeoutMs}ms (no terminal event from ${prefix})`));
    }
  }, overallTimeoutMs);

  try {
    for await (const ev of streamEvents(backend, sessionId, ctrl.signal)) {
      const isTerminal = mapper.mapEvent(ev, emit);
      if (isTerminal) { finished = true; break; }
    }
  } catch (e) {
    if (!finished) {
      const msg = e?.message || String(e);
      if (stream) { sse(res, errBody({ message: msg, type: 'api_error', code: 'acp_timeout', hint: `ACP daemon '${prefix}' did not return a terminal event; check the daemon on its port or raise ACP_OVERALL_TIMEOUT_MS` })); res.end(); }
      else jsonErr(res, 504, { message: msg, type: 'api_error', code: 'acp_timeout', hint: `ACP daemon '${prefix}' did not return a terminal event; check the daemon on its port or raise ACP_OVERALL_TIMEOUT_MS` });
      clearTimeout(overallTimer);
      return;
    }
  } finally {
    clearTimeout(overallTimer);
    ctrl.abort();
  }

  await msgPromise.catch(() => {});

  if (stream) {
    sse(res, makeChunk(id, body.model || `${prefix}/${model}`, {}, 'stop'));
    res.write('data: [DONE]\n\n');
    res.end();
  } else {
    json(res, 200, makeFinal(id, body.model || `${prefix}/${model}`, fullText));
  }
}

function isValidAnthropicMessageResponse(result) {
  if (!result || typeof result !== 'object') return false;
  if (result.type !== 'message' || result.role !== 'assistant') return false;
  if (!Array.isArray(result.content)) return false;
  return true;
}

function inferProviderForModel(model) {
  if (!model) return null;
  if (model.startsWith('anthropic/')) return 'anthropic';
  if (model.startsWith('gemini/')) return 'gemini';
  if (model.startsWith('ollama/')) return 'ollama';
  if (model.startsWith('chatjimmy/')) return 'chatjimmy';
  if (model.startsWith('kilo/') || model.startsWith('opencode/')) return 'acp';
  if (/^minimaxai\//i.test(model)) return 'nvidia';
  if (model.startsWith('nvidia/')) return 'nvidia';
  if (model.startsWith('bedrock/')) return 'bedrock';
  if (/^(z-ai\/|meta\/|qwen\/|deepseek\/|mistralai\/|microsoft\/|google\/)/i.test(model)) return 'openai-compat';
  const sub = splitBrandModel(model);
  if (sub && isBrand(sub.prefix)) return 'brand';
  return null;
}

function isUnresolvableModelString(model) {
  if (!model || typeof model !== 'string' || model === 'auto') return null;
  const namedChains = require('./named-chains');
  if (namedChains.resolveChain(model)) return null;
  if (/^queue\//.test(model)) {
    const name = model.slice('queue/'.length);
    try {
      require('./queues').resolveQueue({ name });
      return null;
    } catch {
      return { code: 'unknown_model', message: `Unknown queue '${model}'`, hint: `no queue named '${name}' found in ~/.acptoapi/queues.json, ACPTOAPI_QUEUES, extraQueueSources, or ~/.acptoapi/config.json chains; GET /v1/queues lists resolvable queues` };
    }
  }
  const sub = splitBrandModel(model);
  if (sub) {
    if (isBrand(sub.prefix)) return null;
    if (BACKENDS[sub.prefix]) return null;
    if (inferProviderForModel(model)) return null;
    const { BRANDS } = require('./openai-brands');
    const brandNames = Object.keys(BRANDS).join(', ');
    const acpPrefixes = Object.keys(BACKENDS).join(', ');
    return { code: 'unknown_model', message: `Unknown model '${model}'`, hint: `'${sub.prefix}' is not a registered brand or ACP agent; use <brand>/<model> (brands: ${brandNames}) or <acp-agent>/<model> (acp: ${acpPrefixes}) or queue/<name>` };
  }
  return null;
}

async function handleAnthropicMessages(req, res, backends) {
  const startedAt = Date.now();
  const body = await readBody(req);
  console.log(`[acptoapi] /v1/messages requested model=${body.model} stream=${body.stream === true}`);
  dlog('anthropic.in', { method: req.method, url: req.url, headers: req.headers, body });
  if (body.max_tokens == null) body.max_tokens = 4096;
  if (body.max_tokens > 32768) body.max_tokens = 32768;
  body.model = normalizeModelId(body.model);
  const isBareClaudeName = typeof body.model === 'string'
    && /^claude-/i.test(body.model)
    && !body.model.includes('/');
  if (isBareClaudeName && keyring.hasAnyKey('ANTHROPIC_API_KEY')) {
    body.model = 'anthropic/' + body.model;
  } else if (isBareClaudeName) {
    body.model = 'auto';
  }
  const requestedQueueName = body.model && body.model !== 'auto' ? body.model : undefined;

  const namedChains = require('./named-chains');
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  let queueLinks;

  if (requestedQueueName) {
    const namedLinks = namedChains.resolveChain(requestedQueueName);
    if (namedLinks && namedLinks.length) {
      console.log(`[acptoapi] /v1/messages using named chain '${requestedQueueName}' (${namedLinks.length} links)`);
      queueLinks = namedLinks;
    }
  }

  if (!queueLinks) {
    const inferred = requestedQueueName ? inferProviderForModel(requestedQueueName) : null;
    const targetModel = inferred ? requestedQueueName : undefined;
    if (!targetModel && requestedQueueName) {
      const unresolvable = isUnresolvableModelString(requestedQueueName);
      if (unresolvable) {
        return jsonErr(res, 400, { message: unresolvable.message, type: 'invalid_request_error', code: unresolvable.code, hint: unresolvable.hint });
      }
    }
    queueLinks = await buildAutoChainLive(targetModel, { hasTools });
    console.log(`[acptoapi] /v1/messages live chain: ${queueLinks.length} links${targetModel ? ` (pinned: ${targetModel})` : ''}`);
    if (queueLinks.length === 0) {
      queueLinks = buildAutoChain(targetModel, { hasTools });
    }
  }
  if (queueLinks.length === 0) {
    return jsonErr(res, 503, { type: 'api_error', message: 'No providers configured', code: 'no_providers', hint: 'no chain links resolved; set at least one provider key (ANTHROPIC_API_KEY, GEMINI_API_KEY, GROQ_API_KEY, NVIDIA_API_KEY, ...) in .env, or ensure a kilo/opencode ACP daemon is reachable' });
  }
  const queue = queueLinks.map(l => l.model);
  const forcedProvider = req.headers['x-provider'];
  logAnthropic({ action: 'fallback_queue', queue });
  const { snapshotAvailabilityRanks } = require('./chain-machine');
  const resolvedLinksWithRank = snapshotAvailabilityRanks(queueLinks);
  const streaming = body.stream === true;
  const authHeader = req.headers['authorization'] || req.headers['x-api-key'];
  const messagesRequireAuth = process.env.ACPTOAPI_API_KEY || process.env.AGENTAPI_API_KEY;
  if (messagesRequireAuth && !authHeader) { logAnthropic({ action: 'auth_fail', reason: 'missing auth header' }); return jsonErr(res, 401, { type: 'authentication_error', message: 'Missing authentication', code: 'missing_auth', hint: 'send Authorization: Bearer <ACPTOAPI_API_KEY> or x-api-key header' }); }

  function buildOpts(modelStr) {
    const { clampMaxTokensForModel } = require('./model-token-limits');
    const localBody = { ...body, model: modelStr, max_tokens: clampMaxTokensForModel(modelStr, body.max_tokens) };
    let localProvider = forcedProvider || inferProviderForModel(modelStr);
    if (!localProvider) throw new Error(`Cannot infer provider for model: ${modelStr}`);
    let lBrandUrl, lBrandApiKey;
    if (localProvider === 'brand') {
      const sub = splitBrandModel(modelStr);
      const brand = sub ? getBrand(sub.prefix) : null;
      if (!brand) throw new Error(`Unknown brand prefix in model: ${modelStr}`);
      const apiKeyVal = keyring.getKey(brand.envKey);
      if (!apiKeyVal) throw new Error(`Missing ${brand.envKey} for model: ${modelStr}`);
      lBrandUrl = brand.url;
      lBrandApiKey = apiKeyVal;
      localBody.model = sub.model;
    }
    if (localProvider === 'openai-compat' || localProvider === 'nvidia') {
      const sub = splitBrandModel(localBody.model);
      if (sub) localBody.model = sub.model;
    }
    const effectiveProvider = localProvider === 'brand' ? 'openai-compat' : localProvider;
    const baseOpts = { from: 'anthropic', to: 'anthropic', provider: effectiveProvider, ...localBody };
    const opts = effectiveProvider === 'openai-compat' || effectiveProvider === 'nvidia'
      ? (() => {
          const { anthropic_messages_to_openai, anthropic_tools_to_openai, anthropic_tool_choice_to_openai } = require('./formats/anthropic');
          const oaiMessages = anthropic_messages_to_openai(localBody.messages || [], localBody.system);
          const oaiTools = anthropic_tools_to_openai(localBody.tools || []);
          const oaiToolChoice = anthropic_tool_choice_to_openai(localBody.tool_choice);
          return {
            ...baseOpts,
            url: localProvider === 'brand' ? lBrandUrl : `${(process.env.OPENAI_API_BASE || 'https://integrate.api.nvidia.com/v1').replace(/\/$/, '')}/chat/completions`,
            apiKey: localProvider === 'brand' ? lBrandApiKey : (keyring.getKey('OPENAI_API_KEY') || keyring.getKey('NVIDIA_API_KEY')),
            streamGuard: { chunkTimeoutMs: Number(process.env.OPENAI_STREAM_CHUNK_TIMEOUT_MS || 240000) },
            body: {
              model: localBody.model,
              messages: oaiMessages,
              temperature: localBody.temperature,
              max_tokens: localBody.max_tokens,
              ...(oaiTools ? { tools: oaiTools } : {}),
              ...(oaiTools && oaiToolChoice !== 'auto' ? { tool_choice: oaiToolChoice } : {}),
            },
          };
        })()
      : baseOpts;
    return { opts, provider: localProvider, model: localBody.model };
  }

  if (streaming) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Private-Network': 'true' });
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => clearInterval(ping));
    let served = false;
    let lastError = null;
    const tried = [];
    for (const candidate of queue) {
      if (forcedProvider && tried.length > 0) break;
      let route;
      try { route = buildOpts(candidate); }
      catch (e) { tried.push({ model: candidate, error: safeClientMessage(e.message), reason: classifyError(e) }); lastError = e; continue; }
      let anyData = false;
      let buffered = '';
      const linkStartedAt = Date.now();
      try {
        console.log(`[acptoapi] stream try provider=${route.provider} model=${route.model} (link ${tried.length + 1}/${queue.length})`);
        dlog('anthropic.stream.start', { provider: route.provider, model: route.model });
        logAnthropic({ action: 'stream_start', provider: route.provider, model: route.model, durationMs: Date.now() - startedAt });
        for await (const ev of translate(route.opts)) {
          if (ev.type === 'sse' && ev.raw) {
            const isContent = /content_block_delta|content_block_start|message_delta|content_block_stop/.test(ev.raw);
            if (!anyData && isContent && /text_delta|tool_use|input_json_delta/.test(ev.raw)) {
              if (buffered) { res.write(buffered); buffered = ''; }
              anyData = true;
              res.write(ev.raw + '\n');
            } else if (anyData) {
              res.write(ev.raw + '\n');
            } else {
              buffered += ev.raw + '\n';
            }
          }
        }
        if (!anyData) {
          console.log(`[acptoapi] stream empty provider=${route.provider} model=${route.model}, falling back`);
          lastError = new Error(`Empty stream from ${candidate}`);
          tried.push({ model: candidate, error: 'empty', reason: 'empty' });
          try { require('./availability').recordFailure(route.model); } catch {}
          continue;
        }
        served = true;
        console.log(`[acptoapi] stream ok provider=${route.provider} model=${route.model} ms=${Date.now() - startedAt}`);
        logAnthropic({ action: 'stream_done', provider: route.provider, model: route.model, durationMs: Date.now() - startedAt });
        try { res.write(`: X-Acptoapi-Served-Model: ${route.model}\n`); res.write(`: X-Acptoapi-Chain-Attempts: ${tried.length + 1}\n\n`); } catch {}
        try {
          const { recordRunDirect } = require('./chain');
          recordRunDirect({ requestedModel: body.model, resolvedLinks: queue, resolvedLinksWithRank, servedBy: route.model, finalModel: route.model, startedAt, attempted: [...tried, { model: route.model, ok: true, reason: null }] });
        } catch {}
        try { require('./availability').recordSuccess(route.model, Date.now() - linkStartedAt); } catch {}
        break;
      } catch (e) {
        if (anyData) {
          dlog('anthropic.stream.error', { provider: route.provider, model: route.model, error: { message: e.message } });
          res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: safeClientMessage(e.message) } })}\n\n`);
          served = true;
          try { require('./availability').recordFailure(route.model); } catch {}
          break;
        }
        console.log(`[acptoapi] stream fail provider=${route.provider} model=${route.model} error=${e.message}, falling back`);
        lastError = e;
        tried.push({ model: candidate, error: safeClientMessage(e.message), reason: classifyError(e) });
        logAnthropic({ action: 'stream_fallback', from: candidate, error: e.message });
        try { require('./availability').recordFailure(route.model); } catch {}
        continue;
      }
    }
    if (!served) {
      res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: `All ${tried.length} chain links failed`, code: 'chain_exhausted', hint: `every provider in the fallback chain is down or rate limited; retry shortly or GET /v1/sampler/status for per-provider backoff. last: ${safeClientMessage(lastError ? lastError.message : 'unknown')}`, tried } })}\n\n`);
      try {
        const { recordRunDirect } = require('./chain');
        recordRunDirect({ requestedModel: body.model, resolvedLinks: queue, resolvedLinksWithRank, servedBy: null, finalModel: null, startedAt, attempted: tried });
      } catch {}
    }
    clearInterval(ping);
    res.end();
  } else {
    let lastError = null;
    const tried = [];
    for (const candidate of queue) {
      if (forcedProvider && tried.length > 0) break;
      let route;
      try { route = buildOpts(candidate); }
      catch (e) { tried.push({ model: candidate, error: safeClientMessage(e.message), reason: classifyError(e) }); lastError = e; continue; }
      const linkStartedAt = Date.now();
      try {
        console.log(`[acptoapi] chat try provider=${route.provider} model=${route.model} (link ${tried.length + 1}/${queue.length})`);
        const result = await buffer(route.opts);
        if (!isValidAnthropicMessageResponse(result) || result.stop_reason === 'error' || result.content.length === 0) {
          const reason = !isValidAnthropicMessageResponse(result) ? 'malformed' : result.stop_reason === 'error' ? 'error_stop' : 'empty';
          console.log(`[acptoapi] chat ${reason} provider=${route.provider} model=${route.model}, falling back`);
          tried.push({ model: candidate, error: reason, reason: reason === 'malformed' || reason === 'error_stop' ? 'error' : reason });
          lastError = new Error(`${reason} from ${candidate}`);
          logAnthropic({ action: 'fallback', from: candidate, reason });
          try { require('./availability').recordFailure(route.model); } catch {}
          continue;
        }
        console.log(`[acptoapi] chat ok provider=${route.provider} model=${route.model} ms=${Date.now() - startedAt}`);
        logAnthropic({ action: 'success', provider: route.provider, model: route.model, durationMs: Date.now() - startedAt, stop_reason: result.stop_reason });
        try {
          res.setHeader('X-Acptoapi-Served-Model', route.model);
          res.setHeader('X-Acptoapi-Chain-Attempts', String(tried.length + 1));
        } catch {}
        try {
          const { recordRunDirect } = require('./chain');
          recordRunDirect({ requestedModel: body.model, resolvedLinks: queue, resolvedLinksWithRank, servedBy: route.model, finalModel: route.model, startedAt, attempted: [...tried, { model: route.model, ok: true, reason: null }] });
        } catch {}
        try { require('./availability').recordSuccess(route.model, Date.now() - linkStartedAt); } catch {}
        return json(res, 200, result);
      } catch (e) {
        console.log(`[acptoapi] chat fail provider=${route.provider} model=${route.model} error=${e.message}, falling back`);
        lastError = e;
        tried.push({ model: candidate, error: safeClientMessage(e.message), reason: classifyError(e) });
        logAnthropic({ action: 'fallback', from: candidate, error: e.message });
        try { require('./availability').recordFailure(route.model); } catch {}
        continue;
      }
    }
    try {
      const { recordRunDirect } = require('./chain');
      recordRunDirect({ requestedModel: body.model, resolvedLinks: queue, resolvedLinksWithRank, servedBy: null, finalModel: null, startedAt, attempted: tried });
    } catch {}
    return jsonErr(res, 503, { type: 'overloaded_error', message: `All ${tried.length} chain links failed`, code: 'chain_exhausted', hint: `every provider in the fallback chain is down or rate limited; retry shortly or GET /v1/sampler/status for per-provider backoff. last: ${safeClientMessage(lastError ? lastError.message : 'unknown')}`, tried });
  }
}

async function handleGeminiGenerateContent(req, res, model, stream) {
  const body = await readBody(req);
  body.model = model;
  console.log(`[acptoapi] /v1beta/models/${model} provider=gemini stream=${stream}`);
  if (stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Private-Network': 'true' });
    try {
      for await (const ev of translate({ from: 'gemini', to: 'gemini', provider: 'gemini', ...body })) {
        if (ev.type === 'sse' && ev.raw) res.write(ev.raw);
      }
    } catch (e) {
      res.write(`data: ${JSON.stringify({ error: { code: 500, message: safeClientMessage(e.message), status: 'INTERNAL' } })}\n\n`);
    }
    res.end();
  } else {
    try {
      const result = await buffer({ from: 'gemini', to: 'gemini', provider: 'gemini', ...body });
      json(res, 200, result);
    } catch (e) {
      json(res, 500, { error: { code: 500, message: safeClientMessage(e.message), status: 'INTERNAL' } });
    }
  }
}

function createServer({ port = 4800, backends = {}, queuesProvider = null } = {}) {
  const requireAuth = process.env.ACPTOAPI_API_KEY || process.env.AGENTAPI_API_KEY;
  const server = http.createServer(async (req, res) => {
    const t0 = Date.now();
    try {
      if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Private-Network': 'true', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization,x-api-key,x-provider,x-cwd,x-freddie-cwd,anthropic-version,anthropic-dangerous-direct-browser-access' }); return res.end(); }
      const url = new URL(req.url, 'http://x');
      metrics.inc('acptoapi_requests_total', { path: url.pathname, method: req.method });
      res.on('finish', () => metrics.observe('acptoapi_request_duration_ms', Date.now() - t0, { path: url.pathname }));
      const isPublic = url.pathname === '/health' || url.pathname === '/metrics' || url.pathname === '/' || url.pathname === '/demo' || url.pathname.startsWith('/demo/') || /^\/(app-shell\.css|colors_and_type\.css|styles\.css|app\.js|favicon\.(svg|ico))$/.test(url.pathname);
      if (requireAuth && !isPublic) {
        const auth = req.headers['authorization'] || '';
        const key = auth.startsWith('Bearer ') ? auth.slice(7) : (req.headers['x-api-key'] || '');
        if (key !== requireAuth) { metrics.inc('acptoapi_auth_failures_total'); return jsonErr(res, 401, { message: 'Invalid API key', type: 'authentication_error', code: 'invalid_api_key', hint: 'check ANTHROPIC_API_KEY (client) or ACPTOAPI_API_KEY (server) matches the configured gateway key' }); }
      }
      const pathKey = req.method + ' ' + url.pathname;
      trackEndpoint(pathKey);

      if (url.pathname === '/metrics' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
        return res.end(metrics.render());
      }
      if (url.pathname === '/v1/models' && req.method === 'GET') return json(res, 200, await listModels(queuesProvider));
      if (url.pathname === '/v1/queues' && req.method === 'GET') {
        let extra = null;
        if (typeof queuesProvider === 'function') { try { extra = await queuesProvider(); } catch {} }
        return json(res, 200, { queues: listAllQueues({ queuesMap: extra }) });
      }
      if (url.pathname === '/v1/sampler/status' && req.method === 'GET') {
        const observed = sampler.getStatus();
        const seen = new Set(observed.map(s => s.provider));
        const configured = getOrder().filter(hasProvider);
        const neverProbed = configured
          .filter(p => !seen.has(p))
          .map(provider => ({ provider, ok: null, failCount: 0, nextCheckIn: 0, neverProbed: true }));
        return json(res, 200, { status: [...observed, ...neverProbed] });
      }
      if (url.pathname === '/v1/availability' && req.method === 'GET') return json(res, 200, { availability: require('./availability').getAll() });
      if (url.pathname === '/v1/brand-catalog' && req.method === 'GET') return json(res, 200, { brands: require('./brand-catalog').peek() });
      if (url.pathname === '/v1/readiness' && req.method === 'GET') return json(res, 200, { candidates: require('./readiness').peek() });
      if (url.pathname === '/v1/extra-providers' && req.method === 'GET') return json(res, 200, { providers: extraProviders.listRegistered() });
      if (url.pathname === '/v1/keyring/status' && req.method === 'GET') {
        const { PROVIDER_KEYS } = require('./provider-maps');
        const seen = new Set();
        const out = [];
        for (const [provider, envKey] of Object.entries(PROVIDER_KEYS)) {
          if (seen.has(envKey)) continue;
          seen.add(envKey);
          const keys = keyring.peekStatus(envKey);
          if (keys.length === 0) continue;
          out.push({ provider, envKey, keys });
        }
        return json(res, 200, { providers: out });
      }
      if (url.pathname === '/v1/runs' && req.method === 'GET') return json(res, 200, { runs: getRunHistory() });
      if (url.pathname === '/v1/cache/stats' && req.method === 'GET') return json(res, 200, responseCache.getStats());
      if (url.pathname === '/v1/cache/clear' && req.method === 'POST') { responseCache.clear(); return json(res, 200, { ok: true }); }
      if (url.pathname === '/v1/pretest/stats' && req.method === 'GET') return json(res, 200, pretest.getStats());
      if (url.pathname === '/v1/pretest/run' && req.method === 'POST') { await pretest.runOnce(); return json(res, 200, pretest.getStats()); }
      if (url.pathname === '/v1/chat/completions' && req.method === 'POST') return await handleChat(req, res, backends);
      if (url.pathname === '/health') return json(res, 200, { ok: true, backends: Object.keys(BACKENDS) });
      if (url.pathname === '/' || url.pathname === '/demo' || url.pathname === '/demo/') return serveStatic(res, 'index.html');
      if (url.pathname.startsWith('/demo/')) return serveStatic(res, url.pathname.slice(6));
      if (/^\/(app-shell\.css|colors_and_type\.css|styles\.css|app\.js|favicon\.(svg|ico))$/.test(url.pathname)) return serveStatic(res, url.pathname.slice(1));
      if (url.pathname === '/debug/providers' && req.method === 'GET') {
        const aclDaemons = Object.keys(BACKENDS);
        const checks = await Promise.all(
          aclDaemons.map(async prefix => {
            const b = resolveBackend(prefix);
            const start = Date.now();
            const ok = await probe(b, 2000).catch(() => false);
            return { name: prefix, status: ok ? 'ok' : 'unreachable', latencyMs: Date.now() - start };
          })
        );
        return json(res, 200, checks);
      }
      if (url.pathname === '/debug/chains' && req.method === 'GET') {
        const { listNamedChains, resolveNamedChain, getRunHistory } = require('./chain');
        const defined = listNamedChains().map(n => ({ name: n, ...resolveNamedChain(n) }));
        return json(res, 200, { defined, recent: getRunHistory() });
      }
      if (url.pathname === '/v1/chains' && req.method === 'GET') {
        const nc = require('./named-chains');
        const names = nc.listChains();
        const detail = {};
        for (const n of [...names.builtin, ...names.runtime]) {
          const r = nc.resolveChain(n);
          if (r) detail[n] = r.map(l => l.model);
        }
        return json(res, 200, { chains: detail, builtin: names.builtin, runtime: names.runtime });
      }
      if (url.pathname === '/v1/chains' && req.method === 'POST') {
        const nc = require('./named-chains');
        const body = await readBody(req);
        if (!body || typeof body.name !== 'string' || !Array.isArray(body.links) || !body.links.length) {
          return jsonErr(res, 400, { message: 'Invalid chain definition', type: 'invalid_request_error', code: 'invalid_chain', hint: 'expected {name: string, links: [<model>, ...]} with a non-empty links array' });
        }
        try {
          nc.registerChain(body.name, body.links);
          return json(res, 201, { ok: true, name: body.name, links: body.links });
        } catch (e) {
          return jsonErr(res, 400, { message: e.message, type: 'invalid_request_error', code: 'invalid_chain', hint: 'each link must be a routable model string (<brand>/<model>, <acp-agent>/<model>, or queue/<name>)' });
        }
      }
      if (url.pathname === '/v1/chains' && req.method === 'DELETE') {
        const nc = require('./named-chains');
        const name = url.searchParams.get('name');
        if (!name) return jsonErr(res, 400, { message: 'Missing chain name', type: 'invalid_request_error', code: 'missing_name', hint: 'pass ?name=<chain> in the query string' });
        const ok = nc.unregisterChain(name);
        if (ok) return json(res, 200, { ok, name });
        return jsonErr(res, 404, { message: `Chain '${name}' not found`, type: 'not_found_error', code: 'chain_not_found', hint: `runtime chain '${name}' not found in ~/.acptoapi/chains.json or env.ACPTOAPI_CHAINS; GET /v1/chains lists registered chains` });
      }
      if (url.pathname === '/debug/auto-chain' && req.method === 'GET') {
        const links = buildAutoChain();
        return json(res, 200, { links, order: getOrder(), available: links.map(l => l.model) });
      }
      if (url.pathname === '/debug/probe-live' && req.method === 'GET') {
        const { getAvailableModels, getAvailableModelsLive, buildChainFromModels } = require('./model-probe-live');
        const logs = [];
        const force = url.searchParams.get('force') === '1' || req.headers['x-live-probe'] === '1';
        const models = force
          ? await getAvailableModelsLive({ log: m => logs.push(m), force: true })
          : getAvailableModels({ log: m => logs.push(m) });
        const chain = buildChainFromModels(models);
        return json(res, 200, { models, chain: chain.map(l => l.model), logs });
      }
      if (url.pathname === '/debug/config' && req.method === 'GET') {
        const { loadConfig } = require('./config');
        const { redactKeys } = require('./errors');
        const cfg = loadConfig();
        return json(res, 200, redactKeys(cfg));
      }
      if (url.pathname === '/debug/why' && req.method === 'GET') {
        try {
          const model = url.searchParams.get('model');
          if (!model) return jsonErr(res, 400, { message: 'model query param required', type: 'invalid_request_error', code: 'missing_model', hint: 'pass ?model=<prefix>/<name> in the query string' });
          const m = /^([a-z0-9-]+)\/(.+)$/.exec(model);
          const prefix = m ? m[1] : null;
          const rest = m ? m[2] : null;
          const { PROVIDER_KEYS } = require('./provider-maps');
          const { getBrand } = require('./openai-brands');
          let envKey = prefix ? PROVIDER_KEYS[prefix] : null;
          if (!envKey && prefix) {
            const brand = getBrand(prefix);
            if (brand && brand.envKey) envKey = brand.envKey;
          }
          const blockers = [];
          if (prefix && !sampler.isAvailable(prefix)) {
            blockers.push({ layer: 'sampler', detail: sampler.peekStatus(prefix) });
          }
          if (!envKey) {
            blockers.push({ layer: 'keyring', detail: { note: `no envKey mapping exists for prefix '${prefix}'` } });
          } else if (keyring.listUsable(envKey).length === 0) {
            blockers.push({ layer: 'keyring', detail: keyring.peekStatus(envKey) });
          }
          const { getModelScore } = require('./swe-bench-scores');
          const score = getModelScore(model);
          let availability = null;
          try {
            const av = require('./availability');
            availability = av.peek(model);
            if ((!availability || availability.ok === null) && rest) {
              const bareHit = av.peek(rest);
              if (bareHit && bareHit.ok !== null) availability = bareHit;
            }
          } catch { availability = null; }
          return json(res, 200, {
            model,
            prefix,
            rest,
            wouldBeSelectable: blockers.length === 0,
            blockers,
            score,
            scored: score != null,
            availability,
            matrixNote: 'matrix scoring is request-scoped (requires a matrixSource) and not evaluated by this diagnostic endpoint',
          });
        } catch (e) {
          return jsonErr(res, 500, { message: e.message, type: 'internal_error', code: 'why_failed' });
        }
      }
      if (url.pathname === '/v1/images/generations' && req.method === 'POST') {
        const { pickTarget, forwardJson } = require('./media-passthrough');
        const body = await readBody(req);
        const provider = req.headers['x-provider'] || (keyring.hasAnyKey('OPENAI_API_KEY') ? 'openai' : 'replicate');
        const target = pickTarget('images', provider);
        if (!target) return jsonErr(res, 400, { message: `Unknown image provider '${provider}'`, type: 'invalid_request_error', code: 'unknown_provider', hint: 'set a supported provider via the x-provider header (e.g. openai, replicate)' });
        return forwardJson({ req, res, json: body, target });
      }
      if (url.pathname === '/v1/audio/speech' && req.method === 'POST') {
        const { pickTarget, forwardJson } = require('./media-passthrough');
        const body = await readBody(req);
        const provider = req.headers['x-provider'] || (body.provider === 'elevenlabs' ? 'tts.elevenlabs' : 'speech.openai');
        const target = pickTarget('audio', provider);
        if (!target) return jsonErr(res, 400, { message: `Unknown speech provider '${provider}'`, type: 'invalid_request_error', code: 'unknown_provider', hint: 'set a supported provider via the x-provider header (e.g. speech.openai, tts.elevenlabs)' });
        return forwardJson({ req, res, json: body, target });
      }
      if (url.pathname === '/v1/audio/transcriptions' && req.method === 'POST') {
        const { pickTarget, forwardMultipart } = require('./media-passthrough');
        const target = pickTarget('audio', 'transcriptions.openai');
        return forwardMultipart({ req, res, target });
      }
      if (url.pathname === '/v1/responses' && req.method === 'POST') {
        const { pickTarget, forwardJson } = require('./media-passthrough');
        const body = await readBody(req);
        const target = pickTarget('responses', 'openai');
        return forwardJson({ req, res, json: body, target });
      }
      if (url.pathname === '/v1/messages' && req.method === 'POST') return await handleAnthropicMessages(req, res, backends);
      if (url.pathname === '/v1/messages/count_tokens' && req.method === 'POST') return await handleCountTokens(req, res);
      if (url.pathname === '/v1/embeddings' && req.method === 'POST') return await handleEmbeddingsGone(req, res);
      if (PASSTHROUGH_ROUTES[url.pathname] && req.method === 'POST') {
        const body = await readBody(req);
        return passthrough(req, res, body, PASSTHROUGH_ROUTES[url.pathname]);
      }
      const geminiCountTokens = url.pathname.match(/^\/v1beta\/models\/([^:]+):countTokens$/);
      if (geminiCountTokens && req.method === 'POST') {
        const body = await readBody(req);
        const messages = (body.contents || []).map(c => ({ role: c.role, content: (c.parts || []).map(p => p.text || '').join('') }));
        return json(res, 200, { totalTokens: estimateTokens(messages) });
      }
      const geminiEmbedRoute = url.pathname.match(/^\/v1beta\/models\/([^:]+):embedContent$/);
      if (geminiEmbedRoute && req.method === 'POST') {
        return handleEmbeddingsGone(req, res);
      }
      if (url.pathname === '/v1beta/models' && req.method === 'GET') {
        const models = await listModels();
        const created = Math.floor(Date.now() / 1000);
        const geminiModels = models.data.map(m => ({ name: 'models/' + m.id, displayName: m.id, supportedGenerationMethods: ['generateContent', 'streamGenerateContent'], createTime: new Date(created * 1000).toISOString(), updateTime: new Date(created * 1000).toISOString() }));
        return json(res, 200, { models: geminiModels });
      }
      const geminiMatch = url.pathname.match(/^\/v1beta\/models\/([^:]+):(streamGenerateContent|generateContent)$/);
      if (geminiMatch && req.method === 'POST') return await handleGeminiGenerateContent(req, res, geminiMatch[1], geminiMatch[2] === 'streamGenerateContent');
      if (url.pathname === '/debug/anthropic' && req.method === 'GET') {
        const envVars = {};
        for (const key of ['NVIDIA_API_KEY', 'OPENAI_API_KEY', 'OPENAI_API_BASE', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'ACPTOAPI_API_KEY', 'AGENTAPI_API_KEY', 'ACPTOAPI_DEBUG_LOG', 'AGENTAPI_DEBUG_LOG']) {
          envVars[key] = process.env[key] ? (key.includes('KEY') || key.includes('TOKEN') ? '***set***' : process.env[key]) : '(not set)';
        }
        const counts = {};
        for (const e of anthropicLog) {
          counts[e.action] = (counts[e.action] || 0) + 1;
        }
        return json(res, 200, {
          uptimeMs: Date.now() - serverStartTime,
          routing: ANTHROPIC_ROUTES.map(r => ({ ...r, match: r.match instanceof RegExp ? r.match.source : r.match })),
          env: envVars,
          requestCounts: counts,
          recentRequests: anthropicLog.slice(-20),
        });
      }
      if (url.pathname === '/debug/translate' && req.method === 'POST') {
        const { translate } = require('./translate');
        const body = await readBody(req);
        const missing = ['from', 'to', 'provider'].filter((k) => !body || !body[k]);
        if (missing.length) {
          return jsonErr(res, 400, { message: `Missing required field(s): ${missing.join(', ')}`, type: 'invalid_request_error', code: 'missing_field', hint: 'POST /debug/translate requires {from, to, provider, ...params} - see AGENTS.md Core Pipeline: translate()' });
        }
        const events = [];
        const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000));
        try {
          await Promise.race([
            (async () => { for await (const ev of translate(body)) events.push(ev); })(),
            timeout
          ]);
        } catch (e) {
          if (e.message !== 'timeout') throw e;
        }
        return json(res, 200, events);
      }
      jsonErr(res, 404, { message: `No route for ${req.method} ${url.pathname}`, type: 'not_found_error', code: 'route_not_found', hint: 'check the method and path; GET /v1/models, POST /v1/chat/completions, POST /v1/messages are the primary routes' });
    } catch (e) {
      const status = e && e.status ? e.status : 500;
      if (status >= 500) console.error('[acptoapi] request error:', e && e.stack || e);
      const message = status >= 500 ? 'Internal server error' : (e && e.message) || 'Request failed';
      jsonErr(res, status, { message, code: e && e.code, hint: status >= 500 ? undefined : (e && e.hint) });
    }
  });

  const activityInterval = setInterval(() => {
    const actionCounts = {};
    for (const e of anthropicLog) {
      actionCounts[e.action] = (actionCounts[e.action] || 0) + 1;
    }
    const actionSummary = Object.entries(actionCounts).map(([k, v]) => `${k}:${v}`).join(' ');
    const topEndpoints = Array.from(endpointStats.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([k, v]) => `${k}:${v}`)
      .join(' ');
    const parts = [];
    if (actionSummary) parts.push(`actions: ${actionSummary}`);
    if (topEndpoints) parts.push(`endpoints: ${topEndpoints}`);
    if (parts.length > 0) {
      console.log(`[acptoapi] activity (${anthropicLog.length} log entries) - ${parts.join(' | ')}`);
    }
    anthropicLog.length = Math.max(0, anthropicLog.length - ANTHROPIC_LOG_MAX);
  }, 60000);
  if (activityInterval.unref) activityInterval.unref();

  const host = process.env.ACPTOAPI_BIND || '127.0.0.1';
  return new Promise((resolve, reject) => {
    server.listen(port, host, () => {
      const actual = server.address().port;
      console.log(`acptoapi listening http://${host}:${actual}`);
      try { pretest.start(); } catch {}
      if (host !== '127.0.0.1' && host !== 'localhost' && !(process.env.ACPTOAPI_API_KEY || process.env.AGENTAPI_API_KEY)) {
        if (process.env.ACPTOAPI_REQUIRE_AUTH_ON_BIND === '1') {
          const err = new Error('[acptoapi] refusing to start: bound to non-loopback address without ACPTOAPI_API_KEY/AGENTAPI_API_KEY set, and ACPTOAPI_REQUIRE_AUTH_ON_BIND=1 is set  - provider keys would be reachable without auth');
          console.error(err.message);
          server.close(() => reject(err));
          return;
        }
        console.warn('[acptoapi] WARNING: bound to non-loopback address without ACPTOAPI_API_KEY set  - provider keys are reachable without auth');
      }
      if (process.env.ACPTOAPI_ENABLE_ACP === '1' && process.env.ACPTOAPI_ENABLE_ACP_AUTOLAUNCH !== '0') {
        try {
          const { ensureRunning } = require('./acp-launcher');
          const names = Object.keys(BACKENDS).filter(n => n !== 'anthropic' && n !== 'gemini');
          ensureRunning({ names, log: m => console.log(m) }).catch(e => console.error('[acp-launcher] Error:', e.message));
        } catch (e) {
          console.error('[acp-launcher] Failed to initialize:', e.message);
        }
      }
      if (process.env.ACPTOAPI_DISABLE_EXTRA_PROVIDERS !== '1') {
        extraProviders.loadAndRegisterAsync().then(count => {
          if (count > 0) console.log(`[extra-providers] registered ${count} extra providers from file`);
        });
      }

      const probeIntervalMs = Number(process.env.ACPTOAPI_PROBE_INTERVAL_MS || 3600000);
      sampler.startSampler(buildModelProbes, probeIntervalMs);
      console.log(`[sampler] started with ${probeIntervalMs}ms interval`);
      if (process.env.ACPTOAPI_DISABLE_BOOT_PROBE !== '1' &&
          process.env.ACPTOAPI_DISABLE_PROBE !== '1' &&
          process.env.ACPTOAPI_LIVE_PROBE !== '1') {
        const bootProbeTimer = setTimeout(() => {
          const { getAvailableModelsLive } = require('./model-probe-live');
          getAvailableModelsLive({ force: true, log: console.log }).catch(() => {});
        }, 5000);
        if (bootProbeTimer.unref) bootProbeTimer.unref();
      }
      if (process.env.ACPTOAPI_DISABLE_BOOT_PROBE !== '1' &&
          process.env.ACPTOAPI_DISABLE_PROBE !== '1') {
        const sweBenchRefreshTimer = setTimeout(() => {
          const { refreshSweBenchScoresLive } = require('./swe-bench-scores');
          refreshSweBenchScoresLive().catch(() => {});
        }, 6000);
        if (sweBenchRefreshTimer.unref) sweBenchRefreshTimer.unref();
      }
      if (process.env.ACPTOAPI_DISABLE_BOOT_PROBE !== '1' &&
          process.env.ACPTOAPI_DISABLE_PROBE !== '1' &&
          process.env.ACPTOAPI_DISABLE_BRAND_CATALOG !== '1') {
        const brandCatalogTimer = setTimeout(() => {
          const brandCatalog = require('./brand-catalog');
          brandCatalog.refreshAll({ force: false }).catch(() => {});
        }, 8000);
        if (brandCatalogTimer.unref) brandCatalogTimer.unref();
      }
      if (process.env.ACPTOAPI_DISABLE_BOOT_PROBE !== '1' &&
          process.env.ACPTOAPI_DISABLE_PROBE !== '1' &&
          process.env.ACPTOAPI_DISABLE_READINESS !== '1') {
        const readiness = require('./readiness');
        readiness.start();
        const readinessWarmTimer = setTimeout(() => { readiness.runOnce().catch(() => {}); }, 11000);
        if (readinessWarmTimer.unref) readinessWarmTimer.unref();
        console.log('[readiness] preemptive prober started');
      }
      resolve({ server, port: actual });
    });
    server.on('error', reject);
  });
}

module.exports = { createServer };
