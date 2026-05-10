const { streamOpenAI, convertMessages: convertToOpenAI, convertTools } = require('./openai');

const NVIDIA_API_URL = 'https://integrate.api.nvidia.com/v1';

function convertAnthropicMessages(messages) {
  // Convert Anthropic format to OpenAI format
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
      headers: { 'Authorization': `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(2000)
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

async function* streamNvidia(params) {
  const { apiKey, messages, system, model, temperature, maxOutputTokens, topP, tools, onStepFinish, streamGuard, headers: userHeaders } = params || {};

  // Extract API key from environment if not provided
  const key = apiKey || process.env.NVIDIA_API_KEY;
  if (!key) throw new Error('NVIDIA_API_KEY not provided');

  const url = NVIDIA_API_URL + '/chat/completions';

  // Convert messages - they come in Anthropic format from translate()
  // Prepend system prompt as a system message for OpenAI-compatible APIs
  const openaiMessages = convertAnthropicMessages(messages) || [];
  const body = {
    model: model || 'deepseek-ai/deepseek-v4-pro',
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

  // Extract API key from environment if not provided
  const key = apiKey || process.env.NVIDIA_API_KEY;
  if (!key) throw new Error('NVIDIA_API_KEY not provided');

  const url = NVIDIA_API_URL + '/chat/completions';

  // Convert messages - they come in Anthropic format
  // Prepend system prompt as a system message for OpenAI-compatible APIs
  const openaiMessages = convertAnthropicMessages(messages) || [];
  const body = {
    model: model || 'deepseek-ai/deepseek-v4-pro',
    messages: system ? [{ role: 'system', content: typeof system === 'string' ? system : JSON.stringify(system) }, ...openaiMessages] : openaiMessages,
    temperature: temperature ?? 1,
    top_p: topP ?? 0.95,
    max_tokens: maxOutputTokens ?? 16384,
    chat_template_kwargs: { enable_thinking: true, thinking: true },
  };

  if (tools) body.tools = convertTools(tools);

  // Use OpenAI's non-streaming generate function
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
