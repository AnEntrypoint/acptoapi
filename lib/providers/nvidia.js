const { streamOpenAI, convertMessages, convertTools } = require('./openai');

const NVIDIA_API_URL = 'https://integrate.api.nvidia.com/v1';

// Cache for model discovery
let modelsCache = null;
let modelsCacheTime = 0;
const CACHE_TTL = 300000; // 5 minutes

async function discoverModels(apiKey) {
  const now = Date.now();
  if (modelsCache && (now - modelsCacheTime) < CACHE_TTL) {
    return modelsCache;
  }

  try {
    const res = await fetch(NVIDIA_API_URL + '/models', {
      headers: { 'Authorization': `Bearer ${apiKey}` }
    });

    if (res.ok) {
      const data = await res.json();
      modelsCache = data.data || [];
      modelsCacheTime = now;
      return modelsCache;
    }
  } catch (err) {
    console.error('[nvidia] Model discovery failed:', err.message);
  }

  // Fallback with known common models
  return [
    { id: 'deepseek-ai/deepseek-v4-pro', name: 'DeepSeek v4 Pro' },
    { id: 'deepseek-ai/deepseek-r1', name: 'DeepSeek R1' },
    { id: 'deepseek-ai/deepseek-v3', name: 'DeepSeek v3' },
  ];
}

async function isValidModel(model, apiKey) {
  const models = await discoverModels(apiKey);
  return models.some(m => m.id === model || m.id?.endsWith('/' + model));
}

async function streamNvidia({ apiKey, messages, system, model, temperature, maxOutputTokens, topP, tools, onStepFinish, streamGuard, headers: userHeaders }) {
  const url = NVIDIA_API_URL + '/chat/completions';

  const body = {
    model,
    messages: convertMessages(messages, system),
    temperature: temperature ?? 1,
    top_p: topP ?? 0.95,
    max_tokens: maxOutputTokens ?? 16384,
  };

  if (tools) body.tools = convertTools(tools);

  return streamOpenAI({
    url,
    apiKey,
    headers: userHeaders,
    body,
    tools,
    onStepFinish,
    streamGuard,
  });
}

async function generateNvidia({ apiKey, messages, system, model, temperature, maxOutputTokens, topP, tools, headers: userHeaders }) {
  const url = NVIDIA_API_URL + '/chat/completions';

  const body = {
    model,
    messages: convertMessages(messages, system),
    temperature: temperature ?? 1,
    top_p: topP ?? 0.95,
    max_tokens: maxOutputTokens ?? 16384,
  };

  if (tools) body.tools = convertTools(tools);

  // Use OpenAI's non-streaming generate function
  const { generateOpenAI } = require('./openai');
  return generateOpenAI({
    url,
    apiKey,
    headers: userHeaders,
    body,
    tools,
  });
}

module.exports = { streamNvidia, generateNvidia, convertMessages, convertTools, discoverModels, isValidModel, NVIDIA_API_URL };
