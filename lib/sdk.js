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

function buildParams({ model, messages, system, tools, temperature, max_tokens, ...rest }) {
  const r = resolveModel(model);
  const apiKey = r.env ? process.env[r.env] : undefined;
  const base = { model: r.model, messages, system, tools, temperature, maxOutputTokens: max_tokens, ...rest };
  if (r.provider === 'openai-compat') {
    return { provider: r.provider, params: { url: r.url, apiKey, body: { model: r.model, messages, tools, temperature, max_tokens, ...rest }, tools } };
  }
  if (r.provider === 'anthropic') return { provider: r.provider, params: { ...base, apiKey } };
  return { provider: r.provider, params: base };
}

async function* stream(opts) {
  const out = opts.output || 'events';
  const { provider, params } = buildParams(opts);
  const args = { from: out === 'events' ? null : 'openai', to: out === 'events' ? null : out, provider, ...params };
  for await (const ev of translate(args)) yield ev;
}

async function chat(opts) {
  const out = opts.output || 'openai';
  const { provider, params } = buildParams(opts);
  return await buffer({ from: 'openai', to: out, provider, ...params });
}

async function* streamChain(models, opts) {
  let lastErr;
  for (const m of models) {
    try {
      let any = false;
      for await (const ev of module.exports.stream({ ...opts, model: m })) { any = true; yield ev; }
      if (any) return;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('All chain models failed');
}

async function chatChain(models, opts) {
  let lastErr;
  for (const m of models) {
    try { return await module.exports.chat({ ...opts, model: m }); }
    catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('All chain models failed');
}

function chain(models, defaults = {}) {
  return {
    chat: (opts) => chatChain(models, { ...defaults, ...opts }),
    stream: (opts) => streamChain(models, { ...defaults, ...opts }),
    models,
  };
}

module.exports = { resolveModel, chat, stream, chain, chatChain, streamChain };
