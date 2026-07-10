'use strict';
const { isBrand, getBrand, BRANDS: BRANDS_RAW } = require('./openai-brands');
const { getDefaultModelSync, refreshAll, getDefaultModel } = require('./model-resolver');
const { sortByBenchmark, getModelScore } = require('./swe-bench-scores');
const { BACKENDS: ACP_BACKENDS, resolveBackend: resolveAcpBackend, listModels: listAcpModels } = require('./acp-client');
const keyring = require('./keyring');
const availability = require('./availability');

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

const DEFAULT_ORDER = ['anthropic','openrouter','groq','nvidia','cerebras','sambanova','mistral','codestral','qwen','zai','cloudflare','gemini','bedrock','opencode-zen','opencode-north','opencode','mimo','ollama','kilo','qwen-code','codex-cli','copilot-cli','cline','hermes-agent','cursor-acp','codeium-cli','acp-cli','chatjimmy','cohere','aion'];

const DEFAULT_MODELS = {
  anthropic:      'anthropic/claude-haiku-4-5-20251001',
  groq:           'groq/llama-3.3-70b-versatile',
  nvidia:         'nvidia/moonshotai/kimi-k2.6',
  cerebras:       'cerebras/zai-org/glm-5.2',
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
  'opencode-zen':    'opencode-zen/hy3-free',
  mimo:          'mimo/v2-pro',
  'qwen-code':    'qwen-code/qwen-plus',
  'codex-cli':    'codex-cli/gpt-4-turbo',
  'copilot-cli':  'copilot-cli/gpt-4o',
  cline:          'cline/claude-opus-4-1',
  'hermes-agent': 'hermes-agent/hermes-3-70b',
  'cursor-acp':   'cursor-acp/cursor-pro',
  'codeium-cli':  'codeium-cli/claude-opus-4',
  'acp-cli':      'acp-cli/gpt-4-turbo',
  chatjimmy:      'chatjimmy/llama3.1-8B',
  cohere:         'cohere/command-r-plus',
  aion:           'aion/aion-2.5',
};

// The model the auto-chain leads with when no explicit model is requested.
// The user's strongest verified model (opencode-zen / hy3-free) is tried first;
// the rest of the chain is then ranked by availability + capability, with the
// (dubious) static SWE-bench score only as a weak tiebreaker. Set
// ACPTOAPI_PREFERRED_AUTO_MODEL to override (e.g. 'opencode-zen/hy3-free').
const PREFERRED_AUTO_MODEL = process.env.ACPTOAPI_PREFERRED_AUTO_MODEL || DEFAULT_MODELS['opencode-zen'];

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
};

const FALLBACK_ON = ['error', 'rate_limit', 'timeout', 'empty', 'auth', 'fetch_failed', 'content_policy', 'sampler_backoff', 'matrix_block'];

// Pull liveDaemons() lazily  - acp-launcher.js requires auto-chain.js
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
//  - they get a chance to lazy-spawn on first /v1/models probe. After that the
// liveDaemons() set is authoritative and dead daemons are filtered out so
// auto-chain never iterates over unreachable links.
function samplerAvailable(name) {
  try {
    const sampler = require('./sampler');
    if (typeof sampler.peekStatus !== 'function') return true;
    const s = sampler.peekStatus(name);
    if (!s) return true;
    // failCount > 0 means provider was explicitly marked failed and is in backoff
    if (s.failCount > 0 && s.nextRetryAt && s.nextRetryAt > Date.now()) return false;
  } catch {}
  return true;
}

function hasProvider(name) {
  if (name in BUILTIN_KEYS) {
    const key = BUILTIN_KEYS[name];
    if (name === 'bedrock') {
      // Bedrock needs the full AWS credential pair, not just an access key id.
      return keyring.hasAnyKey('AWS_ACCESS_KEY_ID') && keyring.hasAnyKey('AWS_SECRET_ACCESS_KEY');
    }
    if (key) {
      if (!keyring.hasAnyKey(key)) return false;
      // Also check sampler: if this provider is in backoff, don't waste chain slots.
      return samplerAvailable(name);
    }
    const acpDaemons = ['ollama', 'kilo', 'opencode', 'qwen-code', 'codex-cli', 'copilot-cli', 'cline', 'hermes-agent', 'cursor-acp', 'codeium-cli', 'acp-cli'];
    if (acpDaemons.includes(name)) {
      // ACP daemons (except ollama, which is local) are opt-in via ACPTOAPI_ENABLE_ACP=1
      if (name !== 'ollama' && process.env.ACPTOAPI_ENABLE_ACP !== '1') return false;
      // After at least one daemon has come up, restrict to live ones  - keeps
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
    // Evaluate function-valued URLs at check time to catch misconfiguration
    // early (e.g. cloudflare without CLOUDFLARE_ACCOUNT_ID, librechat with
    // bad LIBRECHAT_URL). If the URL function throws, the provider is not
    // actually available regardless of env key presence.
    if (typeof b.url === 'function') {
      try {
        const url = b.url();
        if (!url || typeof url !== 'string') return false;
      } catch { return false; }
    }
    // Also check sampler for brand providers
    return samplerAvailable(name);
  }
  return false;
}

function getOrder() {
  const envOrder = process.env.PROVIDER_ORDER;
  if (!envOrder || !envOrder.trim()) return DEFAULT_ORDER;
  return envOrder.split(',').map(s => s.trim()).filter(Boolean);
}

// Capability heuristics  - regex over the canonical model id (with provider
// prefix stripped where natural). Used to push non-tool-capable models to
// the bottom of the auto-chain when the caller passes tools[].
//   tools=true  -> known function-calling shape (modern Llama instruct, Kimi
//                  K2+, Mistral Large/Medium, Claude *, GPT-4/5, Qwen instruct,
//                  DeepSeek V3+, Gemini 2.5 pro)
//   tools=false -> embedding-only, safety-guard, code-completion, tiny instruct
//                  (Llama 3.1 8b, Llama 2, starcoder), or TTS/whisper
//   tools=null  -> unknown (default; treated as middle tier when tools[] set)
const TOOLS_PREFERRED_RE = /(?:llama-?3\.3-|llama-?4|llama-?nemotron-super|kimi-?k2|mistral[-_]?(?:large|medium)|claude[-/]?(?:opus|sonnet|haiku|3|4|5)|gpt-?[45]|qwen[-/]?\d+.*(?:instruct|coder)|deepseek[-/]?(?:v3|v4|r1)|gemini-?2\.5-?pro|grok-?(?:4|code))/i;
const TOOLS_BLOCKED_RE = /(?:embed|embedqa|nemoretriever|nemoguard|nemotron-?safety|safety-?guard|content-?safety|topic-?control|starcoder|jamba|tts|whisper|speech|guard|code-?llama|deepseek-?coder|llama-?3\.1-?8b|llama-?2(?!\d))/i;
function modelCapabilityTools(modelId) {
  if (!modelId || typeof modelId !== 'string') return null;
  if (TOOLS_BLOCKED_RE.test(modelId)) return false;
  if (TOOLS_PREFERRED_RE.test(modelId)) return true;
  return null;
}

// Free-tier classification for ACPTOAPI_FREE_TIER_MODE. Providers known to
// offer a genuinely free tier/local execution, plus the well-known
// "openrouter/*:free" model-id suffix convention. This is intentionally a
// coarse, provider/id-based heuristic (no live cost lookup) - opt-in only.
const FREE_TIER_PROVIDERS = new Set(['ollama', 'kilo', 'opencode', 'gemini', 'groq']);
const FREE_TIER_MODEL_RE = /(?::free\b|\/free\b|-free\b)/i;
function isFreeTierModel(modelId) {
  if (!modelId || typeof modelId !== 'string') return false;
  const slash = modelId.indexOf('/');
  const head = slash > 0 ? modelId.slice(0, slash) : modelId;
  if (FREE_TIER_PROVIDERS.has(head)) return true;
  if (FREE_TIER_MODEL_RE.test(modelId)) return true;
  return false;
}
// Stable partition: free-tier links first (in their existing relative
// order), then everything else (in its existing relative order). Does not
// mutate the input array.
function rankFreeTierFirst(links) {
  const free = [];
  const paid = [];
  for (const link of links) {
    (isFreeTierModel(link.model) ? free : paid).push(link);
  }
  return [...free, ...paid];
}

function buildAutoChain(targetModel, opts = {}) {
  const order = getOrder();
  const available = order.filter(hasProvider);
  // Second pass: filter out providers that are in sampler backoff but might have
  // slipped through hasProvider's check (e.g. ACP daemons that just failed).
  // This prevents dead providers from consuming chain cap slots.
  // ACP daemons are opt-in via ACPTOAPI_ENABLE_ACP=1; exclude them by default.
  const aclEnabled = process.env.ACPTOAPI_ENABLE_ACP === '1';
  const live = available.filter(n => {
    if (ACP_DAEMONS.includes(n)) return aclEnabled; // ACP daemons opt-in only
    return samplerAvailable(n);
  });
  const seenModels = new Set();
  const pool = [];
  const hasTools = opts && opts.hasTools === true;

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

  for (const name of live) {
    const isAcp = ACP_DAEMONS.includes(name);
    const discovered = isAcp ? (ACP_MODEL_CACHE.get(name) || []) : [];
    if (isAcp && discovered.length > 0) {
      // Discovery succeeded: use only the live catalog, skip hardcoded default.
      // Some daemons already return ids prefixed with their own name
      // (e.g. kilo -> 'kilo/openrouter/free'); don't double the prefix.
      for (const sub of discovered) addLink(sub.startsWith(`${name}/`) ? sub : `${name}/${sub}`);
    } else {
      addLink(getDefaultModelSync(name) || DEFAULT_MODELS[name]);
    }
  }

  // Append extra (file-based) providers at the tail  - these are dynamically
  // registered endpoints from ~/.acptoapi/extra-providers.txt. Load from disk
  // cache synchronously first (no network) so cold-start exec paths don't
  // require a server's probe cycle. Fire async load for fresh probe data
  // (subsequent buildAutoChain calls pick it up).
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

  // Two-tier split: (1) DIRECT providers (sub-1s + reliable tool-calling) first,
  // then (2) ACP-wrapper + openrouter brand-routing tier (slow, often unauth).
  // Within each tier the chain is ranked by AVAILABILITY + CAPABILITY first,
  // with the (dubious) static SWE-bench score only as a weak tiebreaker - so a
  // model that is actually observed working/fast leads, and a model that is
  // observed failing is demoted, regardless of its paper score. Then cap to
  // ACP_AUTO_CHAIN_CAP (default 12) so a single `auto` request can't walk 100+
  // dead-link fallbacks for minutes - first-paint UX requires sub-5s response.
  const ACP_BRAND_NAMES = new Set([...ACP_DAEMONS, 'openrouter']);
  const isAcpTier = (link) => {
    const slash = link.model.indexOf('/');
    const head = slash > 0 ? link.model.slice(0, slash) : link.model;
    return ACP_BRAND_NAMES.has(head);
  };

  // Availability/capability-first ranking. availability.score() is the real
  // observed signal (success streak minus failure penalty minus latency) and
  // dominates. For tool requests, capability (tool-calling ability) is the
  // secondary key. The static SWE-bench score is intentionally scaled to a
  // weak signal (/100) so it only breaks ties between equally-available,
  // equally-capable models. When availability ranking is disabled, availability
  // contributes 0 and capability + the weak score still drive the order.
  const rankLinks = (links) => {
    const useAvail = process.env.ACPTOAPI_DISABLE_AVAILABILITY_RANK !== '1';
    const capRank = (m) => {
      if (!hasTools) return 0;
      const t = modelCapabilityTools(m);
      return t === true ? 0 : t === null ? 1 : 2;
    };
    return links
      .map((l, i) => ({
        l, i,
        av: useAvail ? availability.score(l.model) : 0,
        cap: capRank(l.model),
        sc: (getModelScore(l.model) || 0) / 100,
      }))
      .sort((a, b) => (b.av - a.av) || (a.cap - b.cap) || (b.sc - a.sc) || (a.i - b.i))
      .map(x => x.l);
  };

  const direct = rankLinks(pool.filter(l => !isAcpTier(l)));
  const wrapped = rankLinks(pool.filter(l => isAcpTier(l)));
  const cap = Number(process.env.ACPTOAPI_AUTO_CHAIN_CAP) || 12;
  let sorted = [...direct, ...wrapped];

  // Preferred default: when no explicit model is requested, lead with the
  // user's strongest verified model (opencode-zen / hy3-free by default) if
  // its provider is available, so the auto-chain tries it first. The rest of
  // the chain is still availability/capability ranked, so a future failure
  // transparently falls through to the next working link.
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

  // Opt-in free-tier-first reordering. Purely additive: when the env var is
  // unset, `sorted` passes through untouched (byte-identical to prior
  // behavior). When set, free-tier links are stably moved to the head of the
  // chain, preserving their existing relative (tier/benchmark) order, with
  // paid/premium links following in their existing relative order.
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
      // Pinned-but-not-in-cap: put it back at the front so user choice is honored.
      sorted.unshift({ model: targetModel, fallbackOn: FALLBACK_ON });
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

async function buildAutoChainLive(targetModel, opts) {
  const order = getOrder();
  const available = order.filter(hasProvider);
  await Promise.all([
    refreshAll(available),
    refreshAcpModels(available.filter(n => ACP_DAEMONS.includes(n))),
  ]);
  return buildAutoChain(targetModel, opts);
}

module.exports = { buildAutoChain, buildAutoChainLive, refreshAcpModels, probeAcpModels, getDaemonFilter, filterDaemonModels, DEFAULT_ORDER, DEFAULT_MODELS, hasProvider, getOrder, getDefaultModel, getDefaultModelSync, ACP_MODEL_CACHE, modelCapabilityTools, isFreeTierModel, rankFreeTierFirst };
