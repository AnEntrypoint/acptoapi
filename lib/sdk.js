'use strict';
const { translate, buffer } = require('./translate');
const { getBrand, isBrand } = require('./openai-brands');

function splitPrefix(model) {
  const m = /^([a-z0-9-]+)\/(.+)$/.exec(model || '');
  return m ? { prefix: m[1], rest: m[2] } : { prefix: 'kilo', rest: model };
}

const BUILTIN_PROVIDER = {
  anthropic:  () => ({ provider: 'anthropic',     env: 'ANTHROPIC_API_KEY' }),
  gemini:     () => ({ provider: 'gemini',        env: 'GEMINI_API_KEY' }),
  ollama:     () => ({ provider: 'ollama' }),
  bedrock:    () => ({ provider: 'bedrock',       env: 'AWS_ACCESS_KEY_ID' }),
  claude:     () => ({ provider: 'cloud' }),
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
function buildParams({ model, messages, system, tools, temperature, max_tokens, ...rest }) {
  const r = resolveModel(model);
  const apiKey = r.env ? process.env[r.env] : undefined;
  const clean = _stripChainOpts(rest);
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

function maybeNamedChain(opts) {
  const model = opts.model || '';
  const comma = parseCommaList(model);
  if (comma) {
    const { chain } = require('./chain');
    const { model: _m, ...rest } = opts;
    return chain(comma, rest);
  }
  const mq = /^queue\/(.+)$/.exec(model);
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
  const named = require('./chain').resolveNamedChain(m[1]);
  if (!named) throw new Error(`No named chain: ${m[1]}`);
  const { chain } = require('./chain');
  const { model: _m, ...rest } = opts;
  return chain(named.links, { ...named.defaults, ...rest });
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
