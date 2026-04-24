const { extractModelId } = require('./convert');
const { resolveTransformers, applyRequestTransformers } = require('./transformers');
const { loadConfig } = require('./config');
const { route } = require('./router');
const openaiProv = require('./providers/openai');
const { createCircuitBreaker } = require('./circuit-breaker');
const { getCapabilities, stripUnsupported } = require('./capabilities');

function isGeminiProvider(p) {
  return p.name === 'gemini' || (p.api_base_url || '').includes('generativelanguage.googleapis.com');
}

function findProvider(providers, providerName, modelName) {
  if (providerName) return providers.find(p => p.name === providerName);
  if (modelName) return providers.find(p => (p.models || []).includes(modelName));
  return providers[0];
}

function buildOpenAIUrl(base) {
  const clean = (base || '').replace(/\/$/g, '');
  return clean.includes('/completions') ? clean : clean + '/chat/completions';
}

function resolveForProvider(provider, model, customMap) {
  const useList = provider.transformer?.[model]?.use || provider.transformer?.use || [];
  return resolveTransformers(useList, customMap);
}

async function* routerStream(params, resolver) {
  const { createFullStream } = require('../index');
  const { provider, actualModel, transformers, caps } = await resolver(params);
  const stripped = stripUnsupported(params, caps);
  params = stripped.params;
  if (isGeminiProvider(provider)) {
    yield* createFullStream({ ...params, model: actualModel, apiKey: provider.api_key || params.apiKey });
  } else {
    const oaiMsgs = openaiProv.convertMessages(params.messages, params.system);
    const oaiTools = openaiProv.convertTools(params.tools);
    let req = { messages: oaiMsgs, model: actualModel, max_tokens: params.maxOutputTokens || 8192, temperature: params.temperature ?? 0.5 };
    if (oaiTools) req.tools = oaiTools;
    req = applyRequestTransformers(req, transformers);
    yield* openaiProv.streamOpenAI({ url: buildOpenAIUrl(provider.api_base_url), apiKey: provider.api_key, headers: req._extraHeaders, body: req, tools: params.tools, onStepFinish: params.onStepFinish, streamGuard: params.streamGuard });
  }
}

function createRouter(config) {
  const { generateGemini } = require('../index');
  const providers = config.Providers || config.providers || [];
  const routerCfg = config.Router || {};
  const breaker = createCircuitBreaker(config.circuitBreaker);
  async function resolve(params) {
    const { providerName, modelName } = await route(params, routerCfg, config.customRouter);
    let provider = findProvider(providers, providerName, modelName) || providers[0];
    if (provider && breaker.isOpen(provider.name)) {
      const fallback = providers.find(p => p !== provider && !breaker.isOpen(p.name));
      if (fallback) provider = fallback;
    }
    if (!provider) throw new Error('[thebird] no provider configured');
    const actualModel = modelName || (provider.models || [])[0] || extractModelId(params.model) || 'gemini-2.0-flash';
    const transformers = resolveForProvider(provider, actualModel, config._transformers);
    const caps = getCapabilities(provider);
    return { provider, actualModel, transformers, caps };
  }
  return {
    breaker,
    stream(params) { return { fullStream: routerStream(params, resolve), warnings: Promise.resolve([]) }; },
    async generate(params) {
      const { provider, actualModel, transformers, caps } = await resolve(params);
      params = stripUnsupported(params, caps).params;
      if (isGeminiProvider(provider)) return generateGemini({ ...params, model: actualModel, apiKey: provider.api_key || params.apiKey });
      const oaiMsgs = openaiProv.convertMessages(params.messages, params.system);
      const oaiTools = openaiProv.convertTools(params.tools);
      let req = { messages: oaiMsgs, model: actualModel, max_tokens: params.maxOutputTokens || 8192, temperature: params.temperature ?? 0.5 };
      if (oaiTools) req.tools = oaiTools;
      req = applyRequestTransformers(req, transformers);
      return openaiProv.generateOpenAI({ url: buildOpenAIUrl(provider.api_base_url), apiKey: provider.api_key, headers: req._extraHeaders, body: req, tools: params.tools });
    }
  };
}

function streamRouter(params) {
  const { streamGemini } = require('../index');
  const config = loadConfig(params.configPath);
  if (!(config.Providers || config.providers)?.length) return streamGemini(params);
  return createRouter(config).stream(params);
}

async function generateRouter(params) {
  const { generateGemini } = require('../index');
  const config = loadConfig(params.configPath);
  if (!(config.Providers || config.providers)?.length) return generateGemini(params);
  return createRouter(config).generate(params);
}

module.exports = { routerStream, createRouter, streamRouter, generateRouter, findProvider, buildOpenAIUrl, resolveForProvider, isGeminiProvider };
