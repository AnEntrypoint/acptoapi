'use strict';
const { isBrand, getBrand, BRANDS: BRANDS_RAW } = require('./openai-brands');
const { getDefaultModelSync, refreshAll, getDefaultModel } = require('./model-resolver');
const { sortByBenchmark, getModelScore } = require('./swe-bench-scores');
const { BACKENDS: ACP_BACKENDS, resolveBackend: resolveAcpBackend, listModels: listAcpModels } = require('./acp-client');
const keyring = require('./keyring');
const availability = require('./availability');
const brandCatalog = require('./brand-catalog');

const ACP_DAEMONS = Object.keys(ACP_BACKENDS);
const ACP_MODEL_CACHE = new Map();

const DAEMON_FILTER_DEFAULTS = {
  kilo: /free/i,
  opencode: /free/i,
};
const DAEMON_FILTER_ENV = {
  kilo: 'KILO_MODEL_FILTER',
  opencode: 'OPENCODE_MODEL_FILTER',
  'qwen-code': 'QWEN_CODE_MODEL_FILTER',
  'codex-cli': 'CODEX_CLI_MODEL_FILTER',
  'copilot-cli': 'COPILOT_CLI_MODEL_FILTER',
  cline: 'CLINE_MODEL_FILTER',
  'hermes-agent': 'HERMES_MODEL_FILTER',
  'cursor-acp': 'CURSOR_MODEL_FILTER',
  'codeium-cli': 'CODEIUM_MODEL_FILTER',
  'acp-cli': 'ACP_CLI_MODEL_FILTER',
};

function getDaemonFilter(name) {
  const envKey = DAEMON_FILTER_ENV[name];
  const envVal = envKey ? process.env[envKey] : null;
  if (envVal === '*' || envVal === 'all') return null;
  if (envVal) {
    try { return new RegExp(envVal, 'i'); } catch { return DAEMON_FILTER_DEFAULTS[name] || null; }
  }
  return DAEMON_FILTER_DEFAULTS[name] || null;
}

function filterDaemonModels(name, models) {
  const re = getDaemonFilter(name);
  if (!re) return models;
  return models.filter(m => re.test(m));
}

const DEFAULT_ORDER = ['anthropic','openrouter','groq','nvidia','cerebras','sambanova','mistral','codestral','qwen','zai','github-models','cloudflare','gemini','bedrock','opencode-zen','opencode-north','opencode','mimo','ollama','openai-oauth','xai-oauth','kilo','qwen-code','codex-cli','copilot-cli','cline','hermes-agent','cursor-acp','codeium-cli','acp-cli','chatjimmy','cohere','aion'];

const DEFAULT_MODELS = {
  anthropic:      'anthropic/claude-haiku-4-5-20251001',
  groq:           'groq/llama-3.3-70b-versatile',
  nvidia:         'nvidia/moonshotai/kimi-k2.6',
  cerebras:       'cerebras/gpt-oss-120b',
  bedrock:        'bedrock/anthropic.claude-3-5-haiku-20241022-v1:0',
  sambanova:      'sambanova/Meta-Llama-3.3-70B-Instruct',
  mistral:        'mistral/mistral-large-latest',
  codestral:      'codestral/codestral-latest',
  qwen:           'qwen/qwen-plus',
  zai:            'zai/glm-4-plus',
  cloudflare:     'cloudflare/@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  openrouter:     'openrouter/auto',
  gemini:         'gemini/gemini-2.0-flash',
  ollama:       'ollama/llama3.2',
  kilo:           'kilo/openrouter/free',
  opencode:       'opencode/minimax-m2.5-free',
  'opencode-north': 'opencode/openai/gpt-4o',
  'opencode-zen':    'opencode-zen/kimi-k3',
  mimo:          'mimo/v2-pro',
  'qwen-code':    'qwen-code/qwen-plus',
  'codex-cli':    'codex-cli/gpt-4-turbo',
  'copilot-cli':  'copilot-cli/gpt-4o',
  cline:          'cline/claude-opus-4-1',
  'hermes-agent': 'hermes-agent/hermes-3-70b',
  'cursor-acp':   'cursor-acp/cursor-pro',
  'codeium-cli':  'codeium-cli/claude-opus-4',
  'acp-cli':      'acp-cli/gpt-4-turbo',
  'xai-oauth':    'xai-oauth/grok-4.6',
  'openai-oauth': process.env.ACPTOAPI_OPENAI_OAUTH_MODEL || 'openai-oauth/gpt-5.6-terra',
  chatjimmy:      'chatjimmy/llama3.1-8B',
  cohere:         'cohere/command-r-plus',
  aion:           'aion/aion-2.5',
  'github-models': 'github-models/openai/gpt-4.1',
};

const PREFERRED_AUTO_MODEL = process.env.ACPTOAPI_PREFERRED_AUTO_MODEL || null;

const BUILTIN_KEYS = {
  anthropic: 'ANTHROPIC_API_KEY',
  gemini:    'GEMINI_API_KEY',
  bedrock:   'AWS_ACCESS_KEY_ID',
  ollama:    null,
  kilo:      null,
  opencode:  null,
  'qwen-code': null,
  'codex-cli': null,
  'copilot-cli': null,
  cline:     null,
  'hermes-agent': null,
  'cursor-acp': null,
  'codeium-cli': null,
  'acp-cli': null,
  chatjimmy: null,
  'xai-oauth': null,
  'openai-oauth': null,
};

function xaiOauthLoggedIn() {
  try {
    const xaiOauth = require('./xai-oauth');
    if (xaiOauth.isRefreshDead()) return false;
    return xaiOauth.hasCredentials();
  } catch { return false; }
}

function openaiOauthLoggedIn() {
  try { return require('./openai-oauth').hasCredentials(); } catch { return false; }
}

const FALLBACK_ON = ['error', 'rate_limit', 'timeout', 'empty', 'auth', 'fetch_failed', 'content_policy', 'sampler_backoff', 'matrix_block', 'credit_dead'];

let _liveDaemons = null;
function getLiveDaemons() {
  if (_liveDaemons) return _liveDaemons();
  try {
    const launcher = require('./acp-launcher');
    if (typeof launcher.liveDaemons === 'function') {
      _liveDaemons = launcher.liveDaemons;
      return _liveDaemons();
    }
  } catch {}
  return new Set();
}

const OLLAMA_PROBE_TTL_MS = Number(process.env.ACPTOAPI_OLLAMA_PROBE_TTL_MS) || 30000;
let _ollamaProbe = { ok: false, ts: 0, inFlight: false };
function ollamaAvailable() {
  const now = Date.now();
  if (now - _ollamaProbe.ts < OLLAMA_PROBE_TTL_MS) return _ollamaProbe.ok;
  if (!_ollamaProbe.inFlight) {
    _ollamaProbe.inFlight = true;
    const base = process.env.OLLAMA_URL || 'http://localhost:11434';
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 1000);
    fetch(`${base}/api/tags`, { signal: ac.signal })
      .then(r => { _ollamaProbe = { ok: r.ok, ts: Date.now(), inFlight: false }; })
      .catch(() => { _ollamaProbe = { ok: false, ts: Date.now(), inFlight: false }; })
      .finally(() => clearTimeout(timer));
  }
  return _ollamaProbe.ok;
}

function isProviderInBackoff(status) {
  return !!(status && status.failCount > 0 && status.nextRetryAt && status.nextRetryAt > Date.now());
}

function samplerAvailable(name) {
  try {
    const sampler = require('./sampler');
    if (typeof sampler.peekStatus !== 'function') return true;
    const s = sampler.peekStatus(name);
    if (!s) return true;
    if (isProviderInBackoff(s)) return false;
  } catch {}
  return true;
}

function hasBedrockCredentials() {
  return keyring.hasAnyKey('AWS_ACCESS_KEY_ID') && keyring.hasAnyKey('AWS_SECRET_ACCESS_KEY');
}

const ACP_DAEMON_NAMES = ['kilo', 'opencode', 'qwen-code', 'codex-cli', 'copilot-cli', 'cline', 'hermes-agent', 'cursor-acp', 'codeium-cli', 'acp-cli'];

function acpDaemonAvailable(name) {
  if (process.env.ACPTOAPI_ENABLE_ACP !== '1') return false;
  const live = getLiveDaemons();
  if (live.size === 0) return true;
  return live.has(name);
}

function brandUrlResolvable(brand) {
  if (typeof brand.url !== 'function') return true;
  try {
    const url = brand.url();
    return !!url && typeof url === 'string';
  } catch { return false; }
}

function hasProvider(name) {
  if (name in BUILTIN_KEYS) {
    const key = BUILTIN_KEYS[name];
    if (name === 'bedrock') return hasBedrockCredentials();
    if (name === 'ollama') return ollamaAvailable();
    if (name === 'xai-oauth') return xaiOauthLoggedIn();
    if (name === 'openai-oauth') return openaiOauthLoggedIn();
    if (key) {
      if (!keyring.hasAnyKey(key)) return false;
      return samplerAvailable(name);
    }
    if (ACP_DAEMON_NAMES.includes(name)) return acpDaemonAvailable(name);
    if (name === 'chatjimmy') return process.env.ACPTOAPI_ENABLE_CHATJIMMY === '1';
    return false;
  }
  if (isBrand(name)) {
    const b = BRANDS_RAW[name] || null;
    if (!b || !keyring.hasAnyKey(b.envKey)) return false;
    if (name === 'cloudflare' && !process.env.CLOUDFLARE_ACCOUNT_ID) return false;
    if (!brandUrlResolvable(b)) return false;
    return samplerAvailable(name);
  }
  return false;
}

function getOrder() {
  const envOrder = process.env.PROVIDER_ORDER;
  if (!envOrder || !envOrder.trim()) return DEFAULT_ORDER;
  return envOrder.split(',').map(s => s.trim()).filter(Boolean);
}

const TOOLS_PREFERRED_RE = /(?:llama-?3\.3-|llama-?4|llama-?nemotron-super|kimi-?k2|mistral[-_]?(?:large|medium)|claude[-/]?(?:opus|sonnet|haiku|3|4|5)|gpt-?[45]|qwen[-/]?\d+.*(?:instruct|coder)|deepseek[-/]?(?:v3|v4|r1)|gemini-?2\.5-?pro|grok-?(?:4|4\.6|code))/i;
const CHAT_COMPLETION_INCAPABLE_RE = /(?:embed|embedqa|bge-(?:m3|large|base|small)|gte-(?:large|base|small)|e5-(?:large|base|small)|nomic-embed|jina-embeddings|nemoretriever|nemoguard|nemotron-?safety|safety-?guard|content-?safety|topic-?control|tts|whisper|speech|orpheus|kokoro|parler-?tts|xtts|guard|deplot|diffusion|-?fim(?:-|$)|\bocr\b|moderation|rerank|reranker)/i;
const TOOLS_UNRELIABLE_RE = /(?:starcoder|jamba|code-?llama|deepseek-?coder|codegemma|llama-?3\.1-?8b|llama-?2(?!\d)|mistral-?code|devstral|codestral)/i;

function modelCapabilityImpossible(modelId) {
  return !!(modelId && typeof modelId === 'string' && CHAT_COMPLETION_INCAPABLE_RE.test(modelId));
}
function modelCapabilityTools(modelId) {
  if (!modelId || typeof modelId !== 'string') return null;
  if (CHAT_COMPLETION_INCAPABLE_RE.test(modelId) || TOOLS_UNRELIABLE_RE.test(modelId)) return false;
  if (TOOLS_PREFERRED_RE.test(modelId)) return true;
  return null;
}

const FREE_TIER_PROVIDERS = new Set(['ollama', 'kilo', 'opencode', 'gemini', 'groq', 'nvidia']);
const FREE_TIER_MODEL_RE = /(?::free\b|\/free\b|-free\b)/i;
function isFreeTierModel(modelId) {
  if (!modelId || typeof modelId !== 'string') return false;
  const slash = modelId.indexOf('/');
  const head = slash > 0 ? modelId.slice(0, slash) : modelId;
  if (FREE_TIER_PROVIDERS.has(head)) return true;
  if (FREE_TIER_MODEL_RE.test(modelId)) return true;
  return false;
}
function rankFreeTierFirst(links) {
  const paid = [];
  const free = [];
  for (const l of links) (isFreeTierModel(l.model) ? free : paid).push(l);
  return [...paid, ...free];
}

function modelFamily(model) {
  if (!model || typeof model !== 'string') return model;
  const parts = model.split('/');
  const last = parts[parts.length - 1] || model;
  return last.toLowerCase().replace(/[-_](?:free|fast|preview|latest|turbo)\b/g, '');
}

function buildAutoChain(targetModel, opts = {}) {
  const order = getOrder();
  const available = order.filter(hasProvider);
  const acpDaemonsEnabled = process.env.ACPTOAPI_ENABLE_ACP === '1';
  const live = available.filter(n => {
    if (ACP_DAEMONS.includes(n)) return acpDaemonsEnabled;
    return samplerAvailable(n);
  });
  const seenModels = new Set();
  const pool = [];
  const hasTools = opts && opts.hasTools === true;

  let linkOrderCounter = 0;
  const addLink = (model) => {
    if (!model || seenModels.has(model)) return;
    if (modelCapabilityImpossible(model)) return;
    seenModels.add(model);
    const link = { model, fallbackOn: FALLBACK_ON, rrOrder: linkOrderCounter++ };
    const score = getModelScore(model);
    if (score) link.swe_bench_score = score;
    pool.push(link);
  };

  if (targetModel && targetModel !== 'auto') {
    addLink(targetModel);
    return pool;
  }

  const perBrandCap = Number(process.env.ACPTOAPI_BRAND_MODELS_PER_PROVIDER) || 6;
  const brandExpand = process.env.ACPTOAPI_DISABLE_BRAND_CATALOG !== '1';

  const brandBuckets = [];

  for (const name of live) {
    const isAcp = ACP_DAEMONS.includes(name);
    if (isAcp) {
      const discovered = ACP_MODEL_CACHE.get(name) || [];
      if (discovered.length > 0) {
        for (const sub of discovered) addLink(sub.startsWith(`${name}/`) ? sub : `${name}/${sub}`);
      } else {
        addLink(getDefaultModelSync(name) || DEFAULT_MODELS[name]);
      }
      continue;
    }

    if (brandExpand && brandCatalog.isAuthDead(name)) continue;
    let discovered = [];
    if (brandExpand) {
      try { discovered = brandCatalog.getCachedModels(name) || []; } catch { discovered = []; }
    }
    if (discovered.length > 0) {
      const useAvail = process.env.ACPTOAPI_DISABLE_AVAILABILITY_RANK !== '1';
      const ranked = discovered
        .map(id => `${name}/${id}`)
        .filter(m => !availability.isCreditDead(m))
        .sort((a, b) => {
          const avA = useAvail ? availability.score(a) : 0;
          const avB = useAvail ? availability.score(b) : 0;
          if (avA !== avB) return avB - avA;
          return (getModelScore(b) || 0) - (getModelScore(a) || 0);
        })
        .slice(0, perBrandCap);
      if (ranked.length) brandBuckets.push(ranked);
    } else if (brandExpand && brandCatalog.isAuthDead(name)) {
      continue;
    } else {
      const def = getDefaultModelSync(name) || DEFAULT_MODELS[name];
      if (def && !availability.isCreditDead(def)) brandBuckets.push([def]);
    }
  }

  brandBuckets.sort((a, b) => (getModelScore(b[0]) || 0) - (getModelScore(a[0]) || 0));
  const maxDepth = brandBuckets.reduce((m, b) => Math.max(m, b.length), 0);
  const familyDeferred = [];
  for (let depth = 0; depth < maxDepth; depth++) {
    for (const bucket of brandBuckets) {
      if (depth >= bucket.length) continue;
      const candidate = bucket[depth];
      const lastAdded = pool.length ? pool[pool.length - 1].model : null;
      if (lastAdded && modelFamily(candidate) === modelFamily(lastAdded) && !seenModels.has(candidate)) {
        familyDeferred.push(candidate);
        continue;
      }
      addLink(candidate);
    }
  }
  for (const candidate of familyDeferred) addLink(candidate);

  try {
    const extra = require('./extra-providers');
    extra.loadFromCache();
    const extraLinks = extra.getChainLinks();
    for (const link of extraLinks) {
      if (!seenModels.has(link.model)) {
        seenModels.add(link.model);
        pool.push(link);
      }
    }
  } catch {}

  const ACP_BRAND_NAMES = new Set([...ACP_DAEMONS, 'openrouter']);
  const isAcpTier = (link) => {
    const slash = link.model.indexOf('/');
    const head = slash > 0 ? link.model.slice(0, slash) : link.model;
    return ACP_BRAND_NAMES.has(head);
  };

  const rankLinks = (links) => {
    const useAvail = process.env.ACPTOAPI_DISABLE_AVAILABILITY_RANK !== '1';
    const capRank = (m) => {
      if (!hasTools) return 0;
      const t = modelCapabilityTools(m);
      return t === true ? 0 : t === null ? 1 : 2;
    };
    const rr = (l) => (typeof l.rrOrder === 'number' ? l.rrOrder : Number.MAX_SAFE_INTEGER);
    return links
      .map((l) => ({
        l,
        av: useAvail ? availability.score(l.model) : 0,
        cap: capRank(l.model),
        rr: rr(l),
        sc: (getModelScore(l.model) || 0) / 100,
      }))
      .sort((a, b) => (b.av - a.av) || (a.cap - b.cap) || (a.rr - b.rr) || (b.sc - a.sc))
      .map(x => x.l);
  };

  const direct = rankLinks(pool.filter(l => !isAcpTier(l)));
  const wrapped = rankLinks(pool.filter(l => isAcpTier(l)));
  const cap = Number(process.env.ACPTOAPI_AUTO_CHAIN_CAP) || 12;
  let sorted = [...direct, ...wrapped];

  const isDefaultRequest = !targetModel || targetModel === 'auto';
  if (isDefaultRequest && PREFERRED_AUTO_MODEL) {
    const prefHead = PREFERRED_AUTO_MODEL.split('/')[0];
    if (available.includes(prefHead) || hasProvider(prefHead)) {
      const idx = sorted.findIndex(l => l.model === PREFERRED_AUTO_MODEL);
      if (idx > 0) {
        const [p] = sorted.splice(idx, 1);
        sorted.unshift(p);
      } else if (idx < 0) {
        sorted.unshift({ model: PREFERRED_AUTO_MODEL, fallbackOn: FALLBACK_ON, swe_bench_score: getModelScore(PREFERRED_AUTO_MODEL) });
      }
    }
  }

  if (process.env.ACPTOAPI_FREE_TIER_MODE === '1') {
    sorted = rankFreeTierFirst(sorted);
  }

  sorted = sorted.slice(0, cap);

  if (targetModel && targetModel !== 'auto') {
    const idx = sorted.findIndex(l => l.model === targetModel);
    if (idx > 0) {
      const [pinned] = sorted.splice(idx, 1);
      sorted.unshift(pinned);
    } else if (idx < 0) {
      sorted.unshift({ model: targetModel, fallbackOn: FALLBACK_ON });
    }
  }
  return sorted.map(({ rrOrder, ...link }) => link);
}

const path = require('path');
const fs = require('fs');
const os = require('os');
const PROBE_CACHE_PATH = process.env.ACPTOAPI_ACP_PROBE_CACHE || path.join(os.homedir(), '.acptoapi', 'acp-probe-cache.json');
const PROBE_TTL_MS = Number(process.env.ACPTOAPI_ACP_PROBE_TTL_MS) || 24 * 60 * 60 * 1000;

function loadProbeCache() {
  try { return JSON.parse(fs.readFileSync(PROBE_CACHE_PATH, 'utf8')); } catch { return {}; }
}
function saveProbeCache(cache) {
  try {
    fs.mkdirSync(path.dirname(PROBE_CACHE_PATH), { recursive: true });
    fs.writeFileSync(PROBE_CACHE_PATH, JSON.stringify(cache, null, 2));
  } catch {}
}

async function probeOneModel(backend, modelId, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const sessRes = await fetch(backend.base + '/session', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: ctrl.signal,
    });
    if (!sessRes.ok) return false;
    const { id: sessionId } = await sessRes.json();
    const msgRes = await fetch(`${backend.base}/session/${sessionId}/message`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parts: [{ type: 'text', text: 'hi' }], model: { providerID: backend.providerID, modelID: modelId } }),
      signal: ctrl.signal,
    });
    return msgRes.ok;
  } catch { return false; }
  finally { clearTimeout(t); }
}

async function probeAcpModels(backend, models) {
  if (!models || models.length === 0) return [];
  const cache = loadProbeCache();
  const now = Date.now();
  const cacheKey = backend.providerID;
  const entry = cache[cacheKey] || { results: {}, lastChecked: 0 };
  const survivors = [];
  for (const m of models) {
    const cached = entry.results[m];
    if (cached && (now - cached.ts) < PROBE_TTL_MS) {
      if (cached.ok) survivors.push(m);
      continue;
    }
    const ok = await probeOneModel(backend, m);
    entry.results[m] = { ok, ts: now };
    if (ok) survivors.push(m);
  }
  entry.lastChecked = now;
  cache[cacheKey] = entry;
  saveProbeCache(cache);
  return survivors;
}

async function refreshAcpModels(daemonNames = ACP_DAEMONS) {
  await Promise.all(daemonNames.map(async (name) => {
    try {
      const backend = resolveAcpBackend(name);
      const discovered = await listAcpModels(backend);
      const allowed = filterDaemonModels(name, discovered);
      const probed = process.env.ACPTOAPI_ACP_PROBE === '1'
        ? await probeAcpModels(backend, allowed)
        : allowed;
      if (probed.length > 0) ACP_MODEL_CACHE.set(name, probed);
    } catch {}
  }));
  return Object.fromEntries(ACP_MODEL_CACHE);
}

async function buildAutoChainLive(targetModel, opts) {
  if (targetModel && targetModel !== 'auto') return buildAutoChain(targetModel, opts);
  const order = getOrder();
  const available = order.filter(hasProvider);
  await Promise.all([
    refreshAll(available),
    refreshAcpModels(available.filter(n => ACP_DAEMONS.includes(n))),
  ]);
  return buildAutoChain(targetModel, opts);
}

module.exports = { buildAutoChain, buildAutoChainLive, refreshAcpModels, probeAcpModels, getDaemonFilter, filterDaemonModels, DEFAULT_ORDER, DEFAULT_MODELS, hasProvider, getOrder, getDefaultModel, getDefaultModelSync, ACP_MODEL_CACHE, modelCapabilityTools, isFreeTierModel, rankFreeTierFirst, modelFamily };
