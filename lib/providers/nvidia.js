const { streamOpenAI, convertMessages, convertTools } = require('./openai');

async function streamNvidia({ apiKey, messages, system, model, temperature, maxOutputTokens, topP, tools, onStepFinish, streamGuard, headers: userHeaders }) {
  const url = 'https://integrate.api.nvidia.com/v1/chat/completions';

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
  const url = 'https://integrate.api.nvidia.com/v1/chat/completions';

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

module.exports = { streamNvidia, generateNvidia, convertMessages, convertTools };
