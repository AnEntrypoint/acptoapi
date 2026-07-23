'use strict';
const { translate, buffer } = require('./translate');
const { getBrand, isBrand } = require('./openai-brands');
const keyring = require('./keyring');

function splitPrefix(model) {
  const m = /^([a-z0-9-]+)\/(.+)$/.exec(model || '');
  return m ? { prefix: m[1], rest: m[2] } : { prefix: 'kilo', rest: model };
}

const BUILTIN_PROVIDER = {
  anthropic:  () => ({ provider: 'anthropic',     env: 'ANTHROPIC_API_KEY' }),
  gemini:     () => ({ provider: 'gemini',        env: 'GEMINI_API_KEY' }),
  google:     () => ({ provider: 'gemini',        env: 'GEMINI_API_KEY' }),
  ollama:     () => ({ provider: 'ollama' }),
  bedrock:    () => ({ provider: 'bedrock',       env: 'AWS_ACCESS_KEY_ID' }),
  kilo:       () => ({ provider: 'acp' }),
  opencode:   () => ({ provider: 'acp' }),
};

function resolveModel(model) {
  const { prefix, rest } = splitPrefix(model);
  if (BUILTIN_PROVIDER[prefix]) {
    const r = BUILTIN_PROVIDER[prefix]();
    return { provider: r.provider, model: rest, env: r.env, prefix };
  }
  if (isBrand(prefix)) {
    const b = getBrand(prefix);
    return { provider: 'openai-compat', url: b.url, model: rest, env: b.envKey, prefix };
  }
  return { provider: 'acp', model: rest || model, prefix: prefix || 'kilo' };
}

const _CHAIN_OPT_KEYS = new Set(['output', 'queuesMap', 'matrixSource', 'onFallback', 'fallbackOn', '_matrixData', '_requestedModel', 'extraQueueSources', 'queueConfigPath', 'sampler', 'timeout']);
function _stripChainOpts(rest) { const o = {}; for (const k of Object.keys(rest)) if (!_CHAIN_OPT_KEYS.has(k)) o[k] = rest[k]; return o; }
// A caller (freddie's runTurn -> acptoapi-bridge) sends tool_choice as a bare
// OpenAI-format string ('required'/'auto'/'none'), which passes straight
// through an 'openai-compat' body untouched -- correct for a genuine OpenAI-
// shaped backend, but WRONG for an auto-discovered extra-providers.js
// aggregator model that is actually Anthropic-format underneath (the
// endpoint answers on an OpenAI-shaped URL, so discoverOpenAI/discoverAnthropic
// records it as 'openai', but the real backend's Go server expects
// tool_choice as an OBJECT, e.g. {type:"required"}, and rejects a bare string
// outright: "invalid anthropic tool_choice: json: cannot unmarshal string
// into Go value of type anthropic.anthropicToolChoice"). Live-reproduced on a
// real production turn: every one of 20 chain attempts failed, several
// specifically on this exact error. Normalizing here (the single place every
// openai-compat body is authored, regardless of which brand/aggregator model
// resolved to it) fixes every current and future auto-discovered aggregator
// model at once, with no per-model detection needed -- the object form
// {type:'required'} is already a supported shape (this codebase's own
// tooluse transform in transformers.js produces exactly this, and the
// Anthropic-HTTP-server path already emits object-shaped tool_choice to
// OpenAI-compat backends with no issue), so this is a safe superset: an
// object already present is left untouched (never overrides an explicit
// caller/transform choice), and no OpenAI-compatible backend is known to
// reject the object form where it already accepts the bare string.
function _normalizeToolChoice(tc) {
  if (tc == null || typeof tc === 'object') return tc;
  if (typeof tc === 'string') return { type: tc };
  return tc;
}
function buildParams({ model, messages, system, tools, temperature, max_tokens, ...rest }) {
  const r = resolveModel(model);
  const apiKey = r.env ? (keyring.getKey(r.env) || undefined) : undefined;
  const clean = _stripChainOpts(rest);
  if (clean.tool_choice !== undefined) clean.tool_choice = _normalizeToolChoice(clean.tool_choice);
  const base = { model: r.model, messages, system, tools, temperature, maxOutputTokens: max_tokens, ...clean };
  if (r.provider === 'openai-compat') {
    return { provider: r.provider, params: { url: r.url, apiKey, body: { model: r.model, messages, tools, temperature, max_tokens, ...clean }, tools } };
  }
  if (r.provider === 'anthropic') return { provider: r.provider, params: { ...base, apiKey } };
  return { provider: r.provider, params: base };
}

function parseCommaList(model) {
  if (typeof model !== 'string' || !model.includes(',')) return null;
  const parts = model.split(',').map(s => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  return parts;
}

// Dedup: warn once per distinct chain name per process, not once per call
// (chains are typically invoked repeatedly in a hot loop / server request path).
const _warnedChainNames = new Set();
function _warnChainDeprecated(name) {
  if (_warnedChainNames.has(name)) return;
  _warnedChainNames.add(name);
  console.warn(`[acptoapi] chain/${name} is a legacy alias of queue/${name} - update your model string when convenient`);
}

function maybeNamedChain(opts) {
  const model = opts.model || '';
  // The literal string 'auto' must build the REAL dynamic auto-chain
  // (buildAutoChain -- live availability-ranked, provider-diverse, backed by
  // every configured key) rather than falling through resolveModel's bare-
  // prefix path below, which has no 'auto' entry in BUILTIN_PROVIDER/isBrand
  // and so silently resolves to splitPrefix's fallback prefix 'kilo' (an ACP
  // daemon on a port nothing is listening on) -- a caller requesting the
  // dynamic auto-chain got routed to a single hardcoded dead daemon instead,
  // hard-failing every call with ECONNREFUSED. This left 'auto' effectively
  // unusable, forcing callers to hand-author a static comma-list chain
  // instead (a real, live-witnessed gap: a hand-picked list goes stale the
  // moment every one of its entries degrades, exactly the "should always
  // know what's available" failure this fix closes at the root instead of
  // downstream in each caller).
  if (model === 'auto') {
    const { buildAutoChain } = require('./auto-chain');
    const hasTools = Array.isArray(opts.tools) && opts.tools.length > 0;
    const links = buildAutoChain('auto', { hasTools });
    if (Array.isArray(links) && links.length) {
      const { chain } = require('./chain');
      const { model: _m, ...rest } = opts;
      return chain(links.map(l => l.model), rest);
    }
    // No live provider at all (every key dead/unconfigured) -- fall through
    // to resolveModel's own behavior so the caller still gets a real error
    // naming the actual failure instead of a swallowed empty-chain no-op.
  }
  const comma = parseCommaList(model);
  if (comma) {
    const { chain } = require('./chain');
    const { model: _m, ...rest } = opts;
    return chain(comma, rest);
  }
  const mq = /^queue\/(.*)$/.exec(model);
  if (mq) {
    if (!mq[1]) throw new Error('queue/ requires a name');
    const { resolveQueue } = require('./queues');
    const { chain } = require('./chain');
    const q = resolveQueue({ name: mq[1], queuesMap: opts.queuesMap, configPath: opts.queueConfigPath, extraQueueSources: opts.extraQueueSources });
    const { model: _m, ...rest } = opts;
    return chain(q.links, rest);
  }
  const m = /^chain\/(.+)$/.exec(model);
  if (!m) return null;
  _warnChainDeprecated(m[1]);
  const { chain } = require('./chain');
  const named = require('./chain').resolveNamedChain(m[1]);
  const { model: _m, ...rest } = opts;
  if (named) return chain(named.links, { ...named.defaults, ...rest });
  // Fall back to the built-in named chains (fast/cheap/smart/reasoning/free/local/...)
  // registered in lib/named-chains.js  - same registry server.js consults for
  // model:'<name>' and model:'queue/<name>'. Without this fallback, api.chat({model:'chain/fast'})
  // throws "No named chain" even though the HTTP /v1/messages path resolves it fine.
  const builtinLinks = require('./named-chains').resolveChain(m[1]);
  if (!builtinLinks) throw new Error(`No named chain: ${m[1]}`);
  return chain(builtinLinks, rest);
}

async function listAllModelsAndQueues({ matrixSource, queueSources, configPath, queuesMap } = {}) {
  const { listAllQueues } = require('./queues');
  const rows = [];
  const queues = listAllQueues({ configPath, extraQueueSources: queueSources, queuesMap });
  for (const q of queues) {
    rows.push({ id: `queue/${q.name}`, object: 'queue', owned_by: 'queue', links: q.links, source: q.source });
  }
  if (matrixSource) {
    const { loadMatrix } = require('./matrix');
    const matrix = await loadMatrix(matrixSource);
    if (matrix && Array.isArray(matrix.providers)) {
      for (const p of matrix.providers) {
        for (const m of (p.models || [])) {
          const id = m.id || (p.id + '/' + (m.name || ''));
          rows.push({ id, object: 'model', owned_by: p.id || p.name });
        }
      }
    }
  }
  return rows;
}

async function* stream(opts) {
  const named = maybeNamedChain(opts);
  if (named) { for await (const ev of named.stream(opts)) yield ev; return; }
  const out = opts.output || 'events';
  const { provider, params } = buildParams(opts);
  const fromBase = out === 'events' ? null : 'openai';
  const from = provider === 'openai-compat' ? null : fromBase;
  const args = { from, to: out === 'events' ? null : out, provider, ...params };
  for await (const ev of translate(args)) yield ev;
}

async function chat(opts) {
  const named = maybeNamedChain(opts);
  if (named) return named.chat(opts);
  const out = opts.output || 'openai';
  const { provider, params } = buildParams(opts);
  // openai-compat params carry {url,apiKey,body,tools}; passing from:'openai' would strip them.
  const from = provider === 'openai-compat' ? null : 'openai';
  return await buffer({ from, to: out, provider, ...params });
}

const { chain, fallback, resolveNamedChain, listNamedChains, getRunHistory } = require('./chain');

async function* streamChain(models, opts) {
  for await (const ev of chain(models).stream(opts)) yield ev;
}

async function chatChain(models, opts) {
  return chain(models).chat(opts);
}

module.exports = { resolveModel, chat, stream, chain, fallback, chatChain, streamChain, resolveNamedChain, listNamedChains, getRunHistory, listAllModelsAndQueues, parseCommaList, splitPrefix };
