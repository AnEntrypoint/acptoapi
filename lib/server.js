'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
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
const DEBUG_LOG = process.env.ACPTOAPI_DEBUG_LOG === '1' || process.env.AGENTAPI_DEBUG_LOG === '1';

const ANTHROPIC_ROUTES = [
  { match: 'model starts with minimaxai/', provider: 'nvidia', note: 'routes to NVIDIA NIM' },
  { match: /^(z-ai|meta|qwen|deepseek|mistralai|microsoft|google|nvidia)\//, provider: 'openai-compat', note: 'routes to OpenAI-compat endpoint' },
  { match: 'default (no prefix match)', provider: 'nvidia (if NVIDIA_API_KEY set) | gemini', note: 'NVIDIA NIM when key present, else Google Gemini' },
];
const serverStartTime = Date.now();
const anthropicLog = [];
const ANTHROPIC_LOG_MAX = 50;
const endpointStats = new Map(); // Track endpoint request counts

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

  for (const m of models) {
    const fullId = `${m.provider}/${m.model}`;

    // Skip if we already have a probe for this provider
    if (probesByProvider.has(m.provider)) continue;

    // For ACP daemons, use the simple probe from acp-client
    if (['kilo', 'opencode', 'qwen-code', 'codex-cli', 'copilot-cli', 'cline', 'hermes-agent', 'cursor-acp', 'codeium-cli', 'acp-cli'].includes(m.provider)) {
      probesByProvider.set(m.provider, {
        provider: m.provider,
        call: async () => {
          const b = resolveBackend(m.provider);
          const ok = await probe(b, 2000);
          if (!ok) throw new Error('ACP daemon unreachable');
        }
      });
    } else {
      // For other providers (anthropic, google, etc.), lightweight check: env key presence
      probesByProvider.set(m.provider, {
        provider: m.provider,
        call: async () => {
          // Resolve immediately (env keys already checked in getAvailableModels)
          return Promise.resolve();
        }
      });
    }
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

// Sanitize any error text headed for the client: strip absolute file paths
// (which carry usernames and internal structure), drop stack "at ..." frames
// and "file:line" pairs, and redact key-shaped tokens. The full detail still
// goes to the server log via console.error; only the cleaned message is sent.
function safeClientMessage(msg) {
  let s = String(msg == null ? '' : msg);
  // Drop everything from the first stack frame onward (Node stacks start "\n    at ").
  s = s.split(/\n\s*at\s/)[0];
  // Strip Windows (C:\dev\...\file.js) and POSIX (/home/.../file.js) absolute
  // paths plus any trailing :line:col so no internal layout leaks.
  s = s.replace(/[A-Za-z]:\\[^\s:]+(?:\\[^\s:]+)*(?::\d+(?::\d+)?)?/g, '<path>');
  s = s.replace(/(?:\/[^\s/:]+)+\.[A-Za-z]+(?::\d+(?::\d+)?)?/g, '<path>');
  // Strip a bare "file.js:line:col" reference even without a leading path.
  s = s.replace(/\b[\w.-]+\.(?:js|ts|mjs|cjs):\d+(?::\d+)?\b/g, '<path>');
  s = redactKeys(s);
  return s.trim() || 'request failed';
}

// Build a uniform error envelope. `hint` is the actionable recovery guidance
// the task requires per status code; it is omitted when null so existing
// {error:{message}} shapes stay backward compatible.
function errBody({ message, type, code, hint, tried }) {
  const error = { message: safeClientMessage(message) };
  if (type) error.type = type;
  if (code) error.code = code;
  if (hint) error.hint = hint;
  if (Array.isArray(tried)) error.tried = tried;
  return { error };
}
const jsonErr = (res, status, fields) => json(res, status, errBody(fields));

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
  // A malformed body is a CLIENT error (400), not a server error (500). We tag
  // the thrown error with .status so the outer catch responds honestly with the
  // right code instead of a misleading 500 that blames the bridge.
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
  // Probe ACP daemons; if down, attempt to spawn them so the catalog reflects
  // what's actually available rather than only what happens to be already up.
  // Lazy spawn at first chat covers ad-hoc use; this covers `/v1/models` discovery
  // so the chain order (sorted by SWE-bench) actually surfaces kilo+opencode first.

  // Mark models that are the provider default
  const isProviderDefault = (modelId) => {
    for (const [provider, defaultModel] of Object.entries(DEFAULT_MODELS)) {
      if (defaultModel === modelId) return provider;
    }
    return null;
  };

  // ACP daemons are opt-in via ACPTOAPI_ENABLE_ACP=1
  let acp = [];
  if (process.env.ACPTOAPI_ENABLE_ACP === '1') {
    let spawnFn = null;
    try { spawnFn = require('./acp-launcher').spawnDaemon; } catch {}
    acp = await Promise.all(['kilo', 'opencode'].map(async prefix => {
      const b = resolveBackend(prefix);
      let ok = await probe(b, 1500);
      if (!ok && spawnFn) {
        try { await spawnFn(prefix, () => {}); ok = await probe(b, 1500); } catch {}
      }
      return { prefix, ok };
    }));
  }
  const ollamaUrl = process.env.OLLAMA_URL || 'http://localhost:11434';
  const ollamaModels = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(1500) })
    .then(r => r.json()).then(d => (d.models || []).map(m => m.name)).catch(() => []);
  const created = Math.floor(Date.now() / 1000);
  const MODEL_CATALOG = {
    kilo: ['cerebras/qwen-3-235b-a22b-instruct-2507', 'cerebras/gpt-oss-120b', 'cerebras/zai-glm-4.7'],
    opencode: ['minimax-m2.5-free', 'nemotron-3-super-free'],
  };
  const seen = new Set();
  const data = [];
  // ACP daemons are opt-in via ACPTOAPI_ENABLE_ACP=1; excluded by default.
  // When enabled, include catalog entries so chains can target them and trigger
  // lazy-spawn on first chat. Mark live ones with status:'up' so clients can
  // tell, but never hide them  - hiding broke the SWE-bench-ordered chain by
  // collapsing every chain to the only-up backend (chatjimmy/llama3.1-8B).
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
  try {
    const { listChatJimmyModels } = require('./providers/chatjimmy');
    const cjModels = await listChatJimmyModels();
    for (const m of cjModels) {
      const id = `chatjimmy/${m}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const entry = { id, object: 'model', owned_by: 'chatjimmy', created };
      const defaultFor = isProviderDefault(id);
      if (defaultFor) entry.default_for_provider = defaultFor;
      data.push(entry);
    }
  } catch {}
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
  if (process.env.ANTHROPIC_API_KEY) {
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
  if (process.env.GEMINI_API_KEY) {
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
  if (process.env.NVIDIA_API_KEY) {
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
    cerebras: ['zai-org/glm-5.2', 'llama3.1-8b', 'llama-3.3-70b'],
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
  // Extra file-based providers (from ~/.acptoapi/extra-providers.txt) appear
  // in the catalog with their probed model IDs. Only models that passed the
  // live inference probe are listed; failed models are excluded. Each entry
  // carries capabilities indicating which API formats the endpoint supports.
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
  // Stable sort by SWE-bench score descending so clients walking `data[]` in
  // order get the strongest models first (kilo+opencode-hosted Cerebras/Qwen
  // beat chatjimmy/llama3.1-8B). Entries without a score keep insertion order
  // below scored ones. Queue entries always sort last.
  data.sort((a, b) => {
    const aQ = a.object === 'queue', bQ = b.object === 'queue';
    if (aQ !== bQ) return aQ ? 1 : -1;
    const aS = typeof a.swe_bench_score === 'number' ? a.swe_bench_score : -Infinity;
    const bS = typeof b.swe_bench_score === 'number' ? b.swe_bench_score : -Infinity;
    return bS - aS;
  });
  // Stamp capability hints: tools = true|false|null. Lets clients filter the
  // catalog when assembling tool-bearing requests rather than rely on the
  // server's auto-chain to push non-tool models to the bottom.
  const { modelCapabilityTools } = require('./auto-chain');
  for (const m of data) {
    if (m.object !== 'model') continue;
    const t = modelCapabilityTools(m.id);
    m.capabilities = { tools: t === null ? 'unknown' : t };
  }
  return { object: 'list', data };
}


function splitBrandModel(fullModel) {
  const m = /^([a-z0-9-]+)\/(.+)$/.exec(fullModel || '');
  if (!m) return null;
  return { prefix: m[1], model: normalizeModelId(m[2]) };
}

function normalizeModelId(model) {
  if (typeof model !== 'string') return model;
  // Preserve dotted GLM version IDs when upstream/client rewrites dots to dashes.
  if (model === 'z-ai/glm-5-1') return 'z-ai/glm-5.1';
  if (model === 'glm-5-1') return 'glm-5.1';
  return model;
}

async function handleBrandChat(req, res, brandName, body) {
  const brand = getBrand(brandName);
  const envKey = brand.envKey;
  const allKeys = keyring.getKeys(envKey);
  if (allKeys.length === 0) return jsonErr(res, 401, { message: `Missing ${envKey} env var for brand '${brandName}'`, type: 'authentication_error', code: 'missing_provider_key', hint: `set ${envKey} (or ${envKey}_1..N for multi-key) in .env to use '${brandName}/' models` });
  const sub = splitBrandModel(body.model);
  const upstreamModel = sub ? sub.model : body.model;
  console.log(`[acptoapi] /v1/chat/completions provider=${brandName} model=${upstreamModel} stream=${body.stream === true} keys=${allKeys.length}`);
  const upstreamBody = { ...body, model: upstreamModel };
  delete upstreamBody.stream;
  const stream = body.stream === true;
  try {
    const usable = keyring.listUsable(envKey);
    const tryKeys = usable.length > 0 ? usable : [keyring.getKey(envKey)];
    let r;
    let usedKey;
    for (let i = 0; i < tryKeys.length; i++) {
      const apiKey = tryKeys[i];
      usedKey = apiKey;
      r = await fetch(brand.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ ...upstreamBody, stream }),
      });
      const reason = keyring.classify(r.status);
      if ((reason === 'auth' || reason === 'rate_limit') && i < tryKeys.length - 1) {
        keyring.markKeyFailed(envKey, apiKey, reason);
        console.log(`[acptoapi] key-rotate provider=${brandName} reason=${reason} key-index=${i} next-index=${i + 1}`);
        continue;
      }
      if (reason === 'auth' || reason === 'rate_limit') {
        keyring.markKeyFailed(envKey, apiKey, reason);
      } else if (r.ok) {
        keyring.markKeyOk(envKey, apiKey);
      }
      break;
    }
    // All keys exhausted and the final upstream response is a rate limit or
    // auth failure. Return a clean structured error with a backoff hint instead
    // of streaming the vendor body through verbatim (which can carry vendor
    // request ids / phrasing the caller cannot act on). The chain path handles
    // rotation; this is the single-shot brand-only path.
    if (r.status === 429) {
      const st = keyring.peekStatus(envKey);
      const next = st.map(k => k.nextRetryInMs).filter(n => typeof n === 'number' && n > 0);
      const waitMs = next.length ? Math.min(...next) : 30000;
      return jsonErr(res, 429, { message: `Rate limited by ${brandName}`, type: 'rate_limit_error', code: 'rate_limited', hint: `all ${tryKeys.length} ${envKey} key(s) are rate limited; next key rotation in ~${Math.ceil(waitMs / 1000)}s (backoff steps 30s,60s,2m,4m,8m). add ${envKey}_1..N for more keys, or route via a multi-provider chain` });
    }
    if (r.status === 401 || r.status === 403) {
      return jsonErr(res, 401, { message: `Authentication failed for ${brandName}`, type: 'authentication_error', code: 'provider_auth_failed', hint: `all ${tryKeys.length} ${envKey} key(s) were rejected by ${brandName}; verify ${envKey} is valid and has access to '${upstreamModel}'` });
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
    // Once writeHead has fired (we are mid-stream), a second json()/writeHead
    // throws ERR_HTTP_HEADERS_SENT and crashes the process. If the stream errors
    // partway, just close the connection; only send a JSON error if no header
    // has gone out yet. Mirrors handleAnthropicMessages' guarded error path.
    if (!res.headersSent) jsonErr(res, 500, { message: e.message, type: 'api_error', code: 'upstream_error', hint: `request to ${brandName} failed before a response could be streamed; check provider status and ${envKey}` });
    else { try { res.end(); } catch { /* already closed */ } }
  }
}

// Embeddings are served by rs-learn natively (fastembed-rs / ONNX Runtime
// in-process). acptoapi is for LLM chat/completions only. Any caller hitting
// /v1/embeddings should be redirected to rs-learn's native sidecar  - the
// architecture explicitly separates the LLM gateway from the memory store's
// embedder. Keep this gate as a 410 Gone so old callers fail loudly rather
// than silently routing through a phantom service.
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
  const upstreamBody = { ...opts, model: upstreamModel };
  delete upstreamBody.stream;
  const usable = keyring.listUsable(envKey);
  const tryKeys = usable.length > 0 ? usable : [keyring.getKey(envKey)];
  let r;
  for (let i = 0; i < tryKeys.length; i++) {
    const apiKey = tryKeys[i];
    r = await fetch(brand.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify(upstreamBody),
    });
    const reason = keyring.classify(r.status);
    if ((reason === 'auth' || reason === 'rate_limit') && i < tryKeys.length - 1) {
      keyring.markKeyFailed(envKey, apiKey, reason);
      continue;
    }
    if (reason === 'auth' || reason === 'rate_limit') keyring.markKeyFailed(envKey, apiKey, reason);
    else if (r.ok) keyring.markKeyOk(envKey, apiKey);
    break;
  }
  const text = await r.text();
  if (!r.ok) {
    const e = new Error(`${brandName} ${r.status}: ${text.slice(0, 200)}`);
    e.status = r.status;
    if (r.status === 429) e.code = 'RATE_LIMIT';
    throw e;
  }
  try { return JSON.parse(text); } catch { const e = new Error(`${brandName}: non-JSON response`); throw e; }
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
  const overallTimeoutMs = Number(process.env.ACP_OVERALL_TIMEOUT_MS) || 90000;
  const overallTimer = setTimeout(() => { if (!finished) ctrl.abort(new Error(`ACP overall timeout ${overallTimeoutMs}ms`)); }, overallTimeoutMs);
  const split = splitModel(opts.model);
  const sub = split ? split.model : opts.model;
  // Attach a no-op rejection sink immediately so an abort/timeout on the message
  // fetch can't become an unhandled rejection if streamEvents throws first
  // (both fetches share ctrl, so abort rejects both  - and a node:internal
  // unhandledRejection from sendMessage tears the whole acptoapi process down).
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
    // streamEvents abort/error  - surface as an error the chain caller can catch and fall through.
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
  // For openai-compat/nvidia/chatjimmy, strip the brand prefix (e.g. "chatjimmy/llama3.1-8B" -> "llama3.1-8B")
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
    // Resolve incoming `model` as a QUEUE SELECTOR (like /v1/messages):
    // 1) named chain? 2) directly-routable single-link? 3) fall back to default curated queue
    let autoLinks = null;
    try {
      const namedChains = require('./named-chains');
      const namedLinks = namedChains.resolveChain(body.model);
      if (namedLinks && namedLinks.length) {
        autoLinks = namedLinks;
        console.log(`[acptoapi] /v1/chat/completions using named queue '${body.model}' (${namedLinks.length} links)`);
      }
    } catch {}
    if (!autoLinks) {
      // Is the incoming model directly routable as a single-link?
      const directlyRoutable = (() => {
        const sub = splitBrandModel(body.model);
        if (sub && isBrand(sub.prefix)) return true;
        if (splitModel(body.model)) return true;
        const inf = inferProviderForModel(body.model);
        return !!(inf && inf !== 'brand');
      })();
      // Use the LIVE builder so ACP_MODEL_CACHE is refreshed before chain build  - 
      // otherwise an empty cache makes ACP daemons fall to dead hardcoded defaults
      // (e.g. kilo/openrouter/free) and the actually-live kilo/cerebras models that
      // /v1/models reports as 'up' are never tried for chat.
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
      const { runChat } = require('./chain-machine');
      // Fall back on every transient reason so the chain seamlessly advances to
      // the next provider and a rate_limit/auth/etc is never surfaced to the caller.
      const fallbackOn = ['error', 'rate_limit', 'timeout', 'empty', 'auth', 'fetch_failed', 'content_policy', 'sampler_backoff', 'matrix_block'];
      // Per-link timeout so a stalling provider (e.g. an ACP daemon that accepts
      // the connection but never completes) fast-fails and the chain advances
      // instead of hanging for the daemon's own long timeout. Tunable via
      // ACPTOAPI_LINK_TIMEOUT_MS; chatjimmy (fast, always-up) is the final link.
      const linkTimeout = Number(process.env.ACPTOAPI_LINK_TIMEOUT_MS) || 25000;
      const cacheWrap = await responseCache.wrap(body, async () => {
        const r = await runChat(
          autoLinks,
          { fallbackOn, timeout: linkTimeout, _requestedModel: body.model, sampler },
          async (callOpts) => {
            try {
              return await executeForModel({ ...body, model: callOpts.model }, backends);
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
      // Always expose which model actually served the response, and how many
      // links the chain tried, for every successful response - not just the
      // narrow case where an explicit pinned model got silently substituted.
      // Without this, a `model: 'auto'` or comma-chain caller has zero
      // programmatic way to learn which link served beyond parsing the
      // response body's own `model` field (not guaranteed consistent across
      // every provider/format path).
      try {
        res.setHeader('X-Acptoapi-Served-Model', servedModel);
        res.setHeader('X-Acptoapi-Chain-Attempts', String(chainAttempts));
      } catch {}
      // Surface a substitution to the caller: the requested `model` was pinned
      // first in the chain (buildAutoChain), but any earlier link can fail and
      // fall through (e.g. an ACP daemon rejecting the model with a 500). Without
      // a header, a caller who explicitly picked a model has no way to detect
      // that a *different* model silently answered - the JSON `model` field
      // alone looks correct-by-construction since it always reflects whoever
      // actually served the response, not what was asked for.
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
      delete result.__chainAttempted;
      if (wantsStream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Private-Network': 'true' });
        const content = result.choices?.[0]?.message?.content || '';
        const rid = result.id || genId();
        const mdl = result.model || body.model;
        sse(res, makeChunk(rid, mdl, { role: 'assistant', content }));
        sse(res, makeChunk(rid, mdl, {}, 'stop'));
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      return json(res, 200, result);
    } catch (e) {
      // Chain exhausted: every provider fell back. Never surface the raw
      // provider error (e.g. a rate_limit message) to the caller  - return a
      // clean, well-formed assistant completion so downstream agents keep
      // working. The detail goes to the server log only.
      console.error(`[acptoapi] chain exhausted (all providers fell back): ${e.message}`);
      const content = 'All upstream providers are currently unavailable. Please retry shortly.';
      const rid = genId();
      const mdl = body.model || 'auto';
      // e.attempted (populated by lib/chain-machine.js runChat) already carries a
      // classified `reason` per link ({model, ms, ok, reason}) - thread it through
      // rather than re-deriving, so callers can distinguish "every provider
      // rate-limited" from "every provider is down" from "auth misconfigured
      // everywhere" instead of parsing the free-text `content` string. This
      // handler always answers 200 (see comment above) so the structured detail
      // rides in a response header rather than changing the status/body shape.
      const tried = Array.isArray(e.attempted) ? e.attempted.filter(a => !a.ok).map(a => ({ model: a.model, reason: a.reason })) : [];
      if (tried.length) {
        try { res.setHeader('X-Acptoapi-Chain-Exhausted', JSON.stringify(tried)); } catch {}
      }
      if (wantsStream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Private-Network': 'true' });
        sse(res, makeChunk(rid, mdl, { role: 'assistant', content }));
        sse(res, makeChunk(rid, mdl, {}, 'stop'));
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      return json(res, 200, { id: rid, object: 'chat.completion', created: Math.floor(Date.now()/1000), model: mdl, choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, ...(tried.length ? { tried } : {}) });
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

  // Silent rejection sink  - see executeAcpModel for rationale (avoids node
  // unhandledRejection process exit when streamEvents fails first).
  const msgPromise = sendMessage(backend, sessionId, prompt, model)
    .then(r => r.text())
    .catch(() => null);

  const overallTimeoutMs = Number(process.env.ACP_OVERALL_TIMEOUT_MS) || 90000;
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

// Distinguishes "syntactically valid but flatly unresolvable" model strings
// (e.g. `queue/nonexistent-xyz` with no such queue in ANY source, or
// `somebrand/model` where `somebrand` is not a registered brand/ACP/provider
// prefix at all) from "resolves fine but fails at request time" (rate limit,
// auth, etc - which must fall through to the chain untouched). Only the
// former should ever become a 400; a caller-visible `auto` or a named chain
// must never be flagged here. This does NOT decide the request's fate by
// itself - callers still fall through to buildAutoChainLive for `auto`/named
// chains/directly-routable models; this only fires for the residual case
// where none of those apply AND the string looks deliberately, specifically
// targeted (has a `queue/` prefix or a `<prefix>/<rest>` shape) rather than
// being free-form text that was never meant to resolve to anything.
function isUnresolvableModelString(model) {
  if (!model || typeof model !== 'string' || model === 'auto') return null;
  const namedChains = require('./named-chains');
  if (namedChains.resolveChain(model)) return null; // valid named chain / queue-alias
  if (/^queue\//.test(model)) {
    const name = model.slice('queue/'.length);
    try {
      require('./queues').resolveQueue({ name });
      return null; // resolves - not our concern here
    } catch {
      return { code: 'unknown_model', message: `Unknown queue '${model}'`, hint: `no queue named '${name}' found in ~/.acptoapi/queues.json, ACPTOAPI_QUEUES, extraQueueSources, or ~/.acptoapi/config.json chains; GET /v1/queues lists resolvable queues` };
    }
  }
  const sub = splitBrandModel(model);
  if (sub) {
    if (isBrand(sub.prefix)) return null; // registered brand - handled elsewhere
    if (BACKENDS[sub.prefix]) return null; // registered ACP backend
    if (inferProviderForModel(model)) return null; // built-in provider (anthropic/gemini/ollama/...)
    const { BRANDS } = require('./openai-brands');
    const brandNames = Object.keys(BRANDS).join(', ');
    const acpPrefixes = Object.keys(BACKENDS).join(', ');
    return { code: 'unknown_model', message: `Unknown model '${model}'`, hint: `'${sub.prefix}' is not a registered brand or ACP agent; use <brand>/<model> (brands: ${brandNames}) or <acp-agent>/<model> (acp: ${acpPrefixes}) or queue/<name>` };
  }
  return null; // free-form string with no prefix shape - not our concern, let it fall through
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
  if (isBareClaudeName && process.env.ANTHROPIC_API_KEY) {
    body.model = 'anthropic/' + body.model;
  } else if (isBareClaudeName) {
    body.model = 'auto';
  }
  // Incoming model parameter is used ONLY to select queue name.
  // The selected provider/model comes from our curated lists, not the incoming parameter.
  const requestedQueueName = body.model && body.model !== 'auto' ? body.model : undefined;

  // Unified chain selection: same logic as /v1/chat/completions.
  // 1) named chain? 2) directly-routable single-link pinned at front of live chain?
  // 3) unknown/auto -> live auto-chain (direct providers first, ACP last, capped).
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
    // Only pin the requested model when it actually resolves to a known
    // provider/brand; otherwise fall through to the score-ranked auto-chain
    // so the best model on top is what serves the request.
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
  if (!authHeader) { logAnthropic({ action: 'auth_fail', reason: 'missing auth header' }); return jsonErr(res, 401, { type: 'authentication_error', message: 'Missing authentication', code: 'missing_auth', hint: 'send Authorization: Bearer <ACPTOAPI_API_KEY> or x-api-key header' }); }

  function buildOpts(modelStr) {
    const localBody = { ...body, model: modelStr };
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
            streamGuard: { chunkTimeoutMs: Number(process.env.OPENAI_STREAM_CHUNK_TIMEOUT_MS || 120000) },
            body: {
              model: localBody.model,
              messages: oaiMessages,
              temperature: localBody.temperature,
              max_tokens: localBody.max_tokens,
              ...(oaiTools ? { tools: oaiTools } : {}),
              // tool_choice referencing a specific tool (e.g. Claude Code's built-in
              // server-side web_search) is meaningless - and rejected by most
              // OpenAI-compat providers - when that tool isn't actually in the
              // forwarded tools[] array (web_search has no client-side JSON schema
              // to translate, so anthropic_tools_to_openai never includes it).
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
        // Streaming headers are already flushed (writeHead above), so this
        // metadata rides as SSE comment lines rather than HTTP headers - the
        // only way to attach it post-hoc without breaking the SSE framing.
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
      // Track endpoint usage for activity logging
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
        // sampler.getStatus() only knows providers that have had markFailed/markOk
        // called on them at least once - a configured-but-never-dispatched-to
        // provider (or a freshly booted server) has no Map entry and is silently
        // absent, which misleadingly reads as "no exclusions" rather than "never
        // observed". Cross-reference against auto-chain's currently-available
        // (keyed) provider prefixes and synthesize a neverProbed row for any that
        // the sampler hasn't seen yet. Done here (HTTP layer) rather than inside
        // lib/sampler.js to avoid sampler.js importing auto-chain.js (circular dep).
        const observed = sampler.getStatus();
        const seen = new Set(observed.map(s => s.provider));
        const configured = getOrder().filter(hasProvider);
        const neverProbed = configured
          .filter(p => !seen.has(p))
          .map(provider => ({ provider, ok: null, failCount: 0, nextCheckIn: 0, neverProbed: true }));
        return json(res, 200, { status: [...observed, ...neverProbed] });
      }
      if (url.pathname === '/v1/availability' && req.method === 'GET') return json(res, 200, { availability: require('./availability').getAll() });
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
      // await so a rejection from handleChat (e.g. readBody's 400 on malformed
      // JSON) lands in the outer catch and becomes an honest HTTP response,
      // instead of escaping as an unhandledRejection that drops the connection.
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
          // Availability is recorded under the bare model name for brand-routed
          // providers (route.model strips the prefix, matching buildAutoChain's
          // own bare-name convention) - fall back to the bare 'rest' portion
          // when the fully-qualified prefix/rest id has no record.
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
      // Media passthrough endpoints  - acptoapi forwards to upstream so callers
      // don't have to ship per-vendor fetch code for these niche surfaces.
      if (url.pathname === '/v1/images/generations' && req.method === 'POST') {
        const { pickTarget, forwardJson } = require('./media-passthrough');
        const body = await readBody(req);
        const provider = req.headers['x-provider'] || (process.env.OPENAI_API_KEY ? 'openai' : 'replicate');
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
      // Gemini /v1beta/models/<model>:countTokens is kept (token estimation
      // is not an embedding op). :embedContent is removed  - acptoapi does not
      // provide embeddings; rs-learn does that natively.
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
      // Honour an explicit .status (e.g. 400 from readBody on malformed JSON) so
      // client errors are not mislabelled as 500. Do NOT leak the stack to the
      // client -- a stack can carry paths, env detail, and internal structure an
      // adversary can map; log it server-side and return only the message.
      const status = e && e.status ? e.status : 500;
      if (status >= 500) console.error('[acptoapi] request error:', e && e.stack || e);
      // safeClientMessage strips paths/stack/line-numbers and redacts key-shaped
      // tokens; a 5xx collapses to a generic message so no internal detail (which
      // could carry env or layout) ever reaches the client. .hint/.code (set by
      // readBody / Unknown-model throwers) carry the actionable guidance through.
      const message = status >= 500 ? 'Internal server error' : (e && e.message) || 'Request failed';
      jsonErr(res, status, { message, code: e && e.code, hint: status >= 500 ? undefined : (e && e.hint) });
    }
  });

  // Periodic activity summary
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
    // Clear old entries to keep log bounded
    anthropicLog.length = Math.max(0, anthropicLog.length - ANTHROPIC_LOG_MAX);
  }, 60000); // Log every minute
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
      // ACP backend auto-launch is ON by default  - `bunx acptoapi` is expected
      // to bring up the strong ACP backends (kilo, opencode, qwen, codex, ...) so
      // `auto` routes to a tool-capable model out of the box rather than falling
      // through to a weak keyless fallback. Opt OUT with ACPTOAPI_ENABLE_ACP_AUTOLAUNCH=0.
      // ACP daemons are also gated by ACPTOAPI_ENABLE_ACP=1.
      // Spawns use CREATE_NO_WINDOW so they do not pop up terminals on Windows;
      // the chat path's resolveBackend -> spawnDaemon chain still lazily spawns any
      // backend that is not pre-warmed.
      if (process.env.ACPTOAPI_ENABLE_ACP === '1' && process.env.ACPTOAPI_ENABLE_ACP_AUTOLAUNCH !== '0') {
        try {
          const { ensureRunning } = require('./acp-launcher');
          const names = Object.keys(BACKENDS).filter(n => n !== 'anthropic' && n !== 'gemini');
          ensureRunning({ names, log: m => console.log(m) }).catch(e => console.error('[acp-launcher] Error:', e.message));
        } catch (e) {
          console.error('[acp-launcher] Failed to initialize:', e.message);
        }
      }
      // Load extra file-based providers from ~/.acptoapi/extra-providers.txt.
      // Probes each (URL, key) pair to discover OpenAI and/or Anthropic
      // compatibility, then registers working endpoints as dynamic brands.
      // Fire-and-forget so it doesn't block server readiness. Respects
      // ACPTOAPI_DISABLE_EXTRA_PROVIDERS=1 to opt out.
      if (process.env.ACPTOAPI_DISABLE_EXTRA_PROVIDERS !== '1') {
        extraProviders.loadAndRegisterAsync().then(count => {
          if (count > 0) console.log(`[extra-providers] registered ${count} extra providers from file`);
        });
      }

      // Start model probing with exponential backoff (1 hour default interval)
      const probeIntervalMs = Number(process.env.ACPTOAPI_PROBE_INTERVAL_MS || 3600000);
      sampler.startSampler(buildModelProbes, probeIntervalMs);
      console.log(`[sampler] started with ${probeIntervalMs}ms interval`);
      // Fire-and-forget one background live-probe pass shortly after boot so the
      // probe cache has real data before the first user request, instead of only
      // being populated by an explicit ?force=1 debug call or the
      // ACPTOAPI_LIVE_PROBE=1 boot flag. Delayed a few seconds to let ACP daemon
      // autolaunch (above) settle first. Opt out with ACPTOAPI_DISABLE_BOOT_PROBE=1.
      // Also skipped when ACPTOAPI_LIVE_PROBE=1 is already set, since that flag
      // makes handleAnthropicMessages force a live chain on every cold-cache
      // request anyway  - firing here too would be redundant probing. Also
      // respects ACPTOAPI_DISABLE_PROBE=1 (the existing "no network calls at
      // boot/test time" convention used by the test suite).
      if (process.env.ACPTOAPI_DISABLE_BOOT_PROBE !== '1' &&
          process.env.ACPTOAPI_DISABLE_PROBE !== '1' &&
          process.env.ACPTOAPI_LIVE_PROBE !== '1') {
        const bootProbeTimer = setTimeout(() => {
          const { getAvailableModelsLive } = require('./model-probe-live');
          getAvailableModelsLive({ force: true, log: console.log }).catch(() => {});
        }, 5000);
        if (bootProbeTimer.unref) bootProbeTimer.unref();
      }
      resolve({ server, port: actual });
    });
    server.on('error', reject);
  });
}

module.exports = { createServer };
