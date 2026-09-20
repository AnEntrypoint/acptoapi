const { streamOpenAI, convertMessages: convertToOpenAI, convertTools } = require('./openai');
const keyring = require('../keyring');

const NVIDIA_API_URL = 'https://integrate.api.nvidia.com/v1';

function convertAnthropicMessagesToOpenAI(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.map(m => ({
    role: m.role,
    content: typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content)
        ? m.content.map(c => c.type === 'text' ? c.text : JSON.stringify(c)).join('')
        : ''
  }));
}

let modelsDiscoveryCache = null;
let modelsDiscoveryCacheTime = 0;
const MODELS_DISCOVERY_CACHE_TTL_MS = 300000;

async function discoverModels(apiKey) {
  const now = Date.now();
  if (modelsDiscoveryCache && (now - modelsDiscoveryCacheTime) < MODELS_DISCOVERY_CACHE_TTL_MS) {
    return modelsDiscoveryCache;
  }

  try {
    const res = await fetch(NVIDIA_API_URL + '/models', {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(2000)
    });

    if (res.ok) {
      const data = await res.json();
      modelsDiscoveryCache = data.data || [];
      modelsDiscoveryCacheTime = now;
      return modelsDiscoveryCache;
    }
  } catch (err) {
    console.error('[nvidia] Model discovery failed:', err.message);
  }

  const FALLBACK_KNOWN_MODELS = [
    { id: 'deepseek-ai/deepseek-v4-pro', name: 'DeepSeek v4 Pro' },
    { id: 'deepseek-ai/deepseek-r1', name: 'DeepSeek R1' },
    { id: 'deepseek-ai/deepseek-v3', name: 'DeepSeek v3' },
  ];
  return FALLBACK_KNOWN_MODELS;
}

async function isValidModel(model, apiKey) {
  const models = await discoverModels(apiKey);
  return models.some(m => m.id === model || m.id?.endsWith('/' + model));
}

async function* streamNvidia(params) {
  const { apiKey, messages, system, model, temperature, maxOutputTokens, topP, tools, onStepFinish, streamGuard, headers: userHeaders } = params || {};

  const key = apiKey || keyring.getKey('NVIDIA_API_KEY');
  if (!key) throw new Error('NVIDIA_API_KEY not provided');

  const url = NVIDIA_API_URL + '/chat/completions';

  const openaiMessages = convertAnthropicMessagesToOpenAI(messages) || [];
  const apiModel = model ? model.replace(/^nvidia\//i, '') : 'deepseek-ai/deepseek-v4-pro';
  const body = {
    model: apiModel,
    messages: system ? [{ role: 'system', content: typeof system === 'string' ? system : JSON.stringify(system) }, ...openaiMessages] : openaiMessages,
    temperature: temperature ?? 1,
    top_p: topP ?? 0.95,
    max_tokens: maxOutputTokens ?? 16384,
    chat_template_kwargs: { enable_thinking: true, thinking: true },
  };

  if (tools) body.tools = convertTools(tools);

  for await (const ev of streamOpenAI({
    url,
    apiKey: key,
    headers: userHeaders,
    body,
    tools,
    onStepFinish,
    streamGuard,
  })) {
    yield ev;
  }
}

async function generateNvidia(params) {
  const { apiKey, messages, system, model, temperature, maxOutputTokens, topP, tools, headers: userHeaders } = params || {};

  const key = apiKey || keyring.getKey('NVIDIA_API_KEY');
  if (!key) throw new Error('NVIDIA_API_KEY not provided');

  const url = NVIDIA_API_URL + '/chat/completions';

  const openaiMessages = convertAnthropicMessagesToOpenAI(messages) || [];
  const apiModel = model ? model.replace(/^nvidia\//i, '') : 'deepseek-ai/deepseek-v4-pro';
  const body = {
    model: apiModel,
    messages: system ? [{ role: 'system', content: typeof system === 'string' ? system : JSON.stringify(system) }, ...openaiMessages] : openaiMessages,
    temperature: temperature ?? 1,
    top_p: topP ?? 0.95,
    max_tokens: maxOutputTokens ?? 16384,
    chat_template_kwargs: { enable_thinking: true, thinking: true },
  };

  if (tools) body.tools = convertTools(tools);

  const { generateOpenAI } = require('./openai');
  return generateOpenAI({
    url,
    apiKey: key,
    headers: userHeaders,
    body,
    tools,
  });
}

module.exports = { streamNvidia, generateNvidia, convertTools, discoverModels, isValidModel, NVIDIA_API_URL };
