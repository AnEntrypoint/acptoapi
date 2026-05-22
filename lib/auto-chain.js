'use strict';
const { isBrand, getBrand, BRANDS: BRANDS_RAW } = require('./openai-brands');
const { getDefaultModelSync, refreshAll, getDefaultModel } = require('./model-resolver');
const { sortByBenchmark, getModelScore } = require('./swe-bench-scores');
const { BACKENDS: ACP_BACKENDS, resolveBackend: resolveAcpBackend, listModels: listAcpModels } = require('./acp-client');
const keyring = require('./keyring');

const ACP_DAEMONS = Object.keys(ACP_BACKENDS);
const ACP_MODEL_CACHE = new Map();

// Per-daemon allowlist regex. ACP doesn't expose a "free" flag, so we filter
// by naming convention plus env override. Default rules:
//   kilo, opencode: keep model ids containing "free" (case-insensitive)
// Override with <NAME>_MODEL_FILTER env var (any valid JS regex string).
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
    try { return new RegExp(envVal, 'i'); } catch { /* fall through */ }
  }
  return DAEMON_FILTER_DEFAULTS[name] || null;
}

function filterDaemonModels(name, models) {
  const re = getDaemonFilter(name);
  if (!re) return models;
  return models.filter(m => re.test(m));
}

const DEFAULT_ORDER = ['anthropic','openrouter','groq','nvidia','cerebras','sambanova','mistral','codestral','qwen','zai','cloudflare','gemini','opencode-zen','ollama','kilo','opencode','qwen-code','codex-cli','copilot-cli','cline','hermes-agent','cursor-acp','codeium-cli','acp-cli','chatjimmy'];

const DEFAULT_MODELS = {
  anthropic:      'anthropic/claude-haiku-4-5-20251001',
  groq:           'groq/llama-3.3-70b-versatile',
  nvidia:         'nvidia/deepseek-ai/deepseek-r1',
  cerebras:       'cerebras/llama-3.3-70b',
  sambanova:      'sambanova/Meta-Llama-3.3-70B-Instruct',
  mistral:        'mistral/mistral-large-latest',
  codestral:      'codestral/codestral-latest',
  qwen:           'qwen/qwen-plus',
  zai:            'zai/glm-4-plus',
  cloudflare:     'cloudflare/@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  openrouter:     'openrouter/auto',
  gemini:         'gemini/gemini-2.0-flash',
  ollama:         'ollama/llama3.2',
  kilo:           'kilo/openrouter/free',
  opencode:       'opencode/minimax-m2.5-free',
  'qwen-code':    'qwen-code/qwen-plus',
  'codex-cli':    'codex-cli/gpt-4-turbo',
  'copilot-cli':  'copilot-cli/gpt-4o',
  cline:          'cline/claude-opus-4-1',
  'hermes-agent': 'hermes-agent/hermes-3-70b',
  'cursor-acp':   'cursor-acp/cursor-pro',
  'codeium-cli':  'codeium-cli/claude-opus-4',
  'acp-cli':      'acp-cli/gpt-4-turbo',
  chatjimmy:      'chatjimmy/llama3.1-8B',
};

const BUILTIN_KEYS = {
  anthropic: 'ANTHROPIC_API_KEY',
  gemini:    'GEMINI_API_KEY',
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
};

const FALLBACK_ON = ['error', 'rate_limit', 'timeout', 'empty', 'auth', 'fetch_failed', 'content_policy', 'sampler_backoff', 'matrix_block'];

// Pull liveDaemons() lazily — acp-launcher.js requires auto-chain.js
// indirectly, so a top-level require would create a circular dependency. Lazy
// resolve inside hasProvider keeps the dependency uni-directional.
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

// ACP daemons that haven't been confirmed live yet still appear in the chain
// — they get a chance to lazy-spawn on first /v1/models probe. After that the
// liveDaemons() set is authoritative and dead daemons are filtered out so
// auto-chain never iterates over unreachable links.
function hasProvider(name) {
  if (name in BUILTIN_KEYS) {
    const key = BUILTIN_KEYS[name];
    if (key) return keyring.hasAnyKey(key);
    const acpDaemons = ['ollama', 'kilo', 'opencode', 'qwen-code', 'codex-cli', 'copilot-cli', 'cline', 'hermes-agent', 'cursor-acp', 'codeium-cli', 'acp-cli'];
    if (acpDaemons.includes(name)) {
      // After at least one daemon has come up, restrict to live ones — keeps
      // dead daemons out of the chain so the fallback iterator doesn't waste
      // turns on every-other-attempt fetch_failed. Before any daemon is up
      // (initial probe), keep all so spawnDaemon gets a chance to try them.
      const live = getLiveDaemons();
      if (live.size === 0) return true;
      return live.has(name);
    }
    if (name === 'chatjimmy') return true;
    return false;
  }
  if (isBrand(name)) {
    const b = BRANDS_RAW[name] || null;
    if (!b || !keyring.hasAnyKey(b.envKey)) return false;
    if (name === 'cloudflare' && !process.env.CLOUDFLARE_ACCOUNT_ID) return false;
    return true;
  }
  return false;
}

function getOrder() {
  const envOrder = process.env.PROVIDER_ORDER;
  if (!envOrder || !envOrder.trim()) return DEFAULT_ORDER;
  return envOrder.split(',').map(s => s.trim()).filter(Boolean);
}

function buildAutoChain(targetModel) {
  const order = getOrder();
  const available = order.filter(hasProvider);
  const seenModels = new Set();
  const pool = [];

  const addLink = (model) => {
    if (!model || seenModels.has(model)) return;
    seenModels.add(model);
    const link = { model, fallbackOn: FALLBACK_ON };
    const score = getModelScore(model);
    if (score) link.swe_bench_score = score;
    pool.push(link);
  };

  if (targetModel && targetModel !== 'auto') {
    addLink(targetModel);
  }

  for (const name of available) {
    const isAcp = ACP_DAEMONS.includes(name);
    const discovered = isAcp ? (ACP_MODEL_CACHE.get(name) || []) : [];
    if (isAcp && discovered.length > 0) {
      // Discovery succeeded: use only the live catalog, skip hardcoded default.
      for (const sub of discovered) addLink(`${name}/${sub}`);
    } else {
      addLink(getDefaultModelSync(name) || DEFAULT_MODELS[name]);
    }
  }

  // Flatten everything (direct API + discovered ACP models) into one pool,
  // sort purely by SWE-bench score descending. No provider-priority bucketing.
  const sorted = sortByBenchmark(pool);

  if (targetModel && targetModel !== 'auto') {
    const idx = sorted.findIndex(l => l.model === targetModel);
    if (idx > 0) {
      const [pinned] = sorted.splice(idx, 1);
      sorted.unshift(pinned);
    }
  }
  return sorted;
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
      // Optional live probe layer: drops models that fail with auth/quota errors.
      const probed = process.env.ACPTOAPI_ACP_PROBE === '1'
        ? await probeAcpModels(backend, allowed)
        : allowed;
      if (probed.length > 0) ACP_MODEL_CACHE.set(name, probed);
    } catch {}
  }));
  return Object.fromEntries(ACP_MODEL_CACHE);
}

async function buildAutoChainLive(targetModel) {
  const order = getOrder();
  const available = order.filter(hasProvider);
  await Promise.all([
    refreshAll(available),
    refreshAcpModels(available.filter(n => ACP_DAEMONS.includes(n))),
  ]);
  return buildAutoChain(targetModel);
}

module.exports = { buildAutoChain, buildAutoChainLive, refreshAcpModels, probeAcpModels, getDaemonFilter, filterDaemonModels, DEFAULT_ORDER, DEFAULT_MODELS, hasProvider, getOrder, getDefaultModel, getDefaultModelSync, ACP_MODEL_CACHE };
