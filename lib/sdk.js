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
async function buildParams({ model, messages, system, tools, temperature, max_tokens, ...rest }) {
  const { clampMaxTokensForModel, shouldOmitMaxTokens, stripMaxTokens } = require('./model-token-limits');
  max_tokens = clampMaxTokensForModel(model, max_tokens);
  const r = resolveModel(model);
  if (r.prefix === 'xai-oauth') {
    let clean = _stripChainOpts(rest);
    if (shouldOmitMaxTokens(model)) clean = stripMaxTokens(clean);
    const { bearer, baseUrl } = await require('./xai-oauth').getCredentials();
    const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const body = { model: r.model, messages, tools, temperature, ...clean };
    if (max_tokens != null) body.max_tokens = max_tokens;
    return { provider: 'openai-compat', params: { url, apiKey: bearer, body, tools } };
  }
  if (r.prefix === 'openai-oauth') {
    const clean = _stripChainOpts(rest);
    return { provider: 'openai-oauth', params: { model: r.model, messages, system, tools, max_tokens, ...clean } };
  }
  const apiKey = r.env ? (keyring.getKey(r.env) || undefined) : undefined;
  let clean = _stripChainOpts(rest);
  if (shouldOmitMaxTokens(model)) clean = stripMaxTokens(clean);
  const base = { model: r.model, messages, system, tools, temperature, maxOutputTokens: max_tokens, ...clean };
  if (r.provider === 'openai-compat') {
    const body = { model: r.model, messages, tools, temperature, ...clean };
    if (max_tokens != null) body.max_tokens = max_tokens;
    return { provider: r.provider, params: { url: r.url, apiKey, body, tools } };
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

const _warnedChainNamesThisProcess = new Set();
function _warnChainDeprecated(name) {
  if (_warnedChainNamesThisProcess.has(name)) return;
  _warnedChainNamesThisProcess.add(name);
  console.warn(`[acptoapi] chain/${name} is a legacy alias of queue/${name} - update your model string when convenient`);
}

function maybeNamedChain(opts) {
  const model = opts.model || '';
  if (model === 'auto') {
    const { buildAutoChain } = require('./auto-chain');
    const hasTools = Array.isArray(opts.tools) && opts.tools.length > 0;
    const links = buildAutoChain('auto', { hasTools });
    if (Array.isArray(links) && links.length) {
      const { chain } = require('./chain');
      const { model: _m, ...rest } = opts;
      return chain(links.map(l => l.model), rest);
    }
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
  const { provider, params } = await buildParams(opts);
  const fromBase = out === 'events' ? null : 'openai';
  const from = provider === 'openai-compat' ? null : fromBase;
  const args = { from, to: out === 'events' ? null : out, provider, ...params };
  for await (const ev of translate(args)) yield ev;
}

async function chat(opts) {
  const named = maybeNamedChain(opts);
  if (named) return named.chat(opts);
  const out = opts.output || 'openai';
  const { provider, params } = await buildParams(opts);
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
