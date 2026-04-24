const { convertMessages, convertTools, cleanSchema, extractModelId, buildConfig } = require('./convert');
const { ensureAuth, CODE_ASSIST_BASE, CODE_ASSIST_HEADERS } = require('./oauth');
const crypto = require('crypto');

function buildUserAgent(model) {
  return `gemini-cli/0.30.0 (node; ${process.platform}) model/${model || 'unknown'}`;
}

async function cloudGenerate({ model, system, messages, tools, temperature, maxOutputTokens, topP, topK, safetySettings, responseModalities, authPort }) {
  const tokens = await ensureAuth(authPort);
  const modelId = extractModelId(model);
  const contents = convertMessages(messages);
  const { config } = buildConfig({ system, tools, temperature, maxOutputTokens, topP, topK, safetySettings, responseModalities });

  const request = { contents };
  if (config.systemInstruction) request.systemInstruction = { parts: [{ text: config.systemInstruction }] };
  if (config.tools) request.tools = config.tools;
  const genConfig = {};
  if (config.maxOutputTokens) genConfig.maxOutputTokens = config.maxOutputTokens;
  if (config.temperature != null) genConfig.temperature = config.temperature;
  if (config.topP != null) genConfig.topP = config.topP;
  if (config.topK != null) genConfig.topK = config.topK;
  if (config.responseModalities) genConfig.responseModalities = config.responseModalities;
  if (Object.keys(genConfig).length) request.generationConfig = genConfig;

  const envelope = { project: tokens.projectId, model: modelId, user_prompt_id: crypto.randomUUID(), request };

  const res = await fetch(`${CODE_ASSIST_BASE}:generateContent`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tokens.accessToken}`,
      'User-Agent': buildUserAgent(modelId),
      'x-activity-request-id': crypto.randomUUID(),
      ...CODE_ASSIST_HEADERS
    },
    body: JSON.stringify(envelope)
  });

  if (!res.ok) throw new Error(`Cloud generate failed (${res.status}): ${await res.text()}`);
  const data = await res.json();
  const inner = data.response || data;
  const candidate = inner.candidates?.[0];
  if (!candidate) throw new Error('No candidates returned');
  const allParts = candidate.content?.parts || [];
  const text = allParts.filter(p => p.text && !p.thought).map(p => p.text).join('');
  return { text, parts: allParts, response: inner };
}

async function* cloudStream({ model, system, messages, tools, onStepFinish, temperature, maxOutputTokens, topP, topK, safetySettings, responseModalities, authPort }) {
  const tokens = await ensureAuth(authPort);
  const modelId = extractModelId(model);
  const contents = convertMessages(messages);
  const { config } = buildConfig({ system, tools, temperature, maxOutputTokens, topP, topK, safetySettings, responseModalities });

  const request = { contents };
  if (config.systemInstruction) request.systemInstruction = { parts: [{ text: config.systemInstruction }] };
  if (config.tools) request.tools = config.tools;
  const genConfig = {};
  if (config.maxOutputTokens) genConfig.maxOutputTokens = config.maxOutputTokens;
  if (config.temperature != null) genConfig.temperature = config.temperature;
  if (config.topP != null) genConfig.topP = config.topP;
  if (config.topK != null) genConfig.topK = config.topK;
  if (config.responseModalities) genConfig.responseModalities = config.responseModalities;
  if (Object.keys(genConfig).length) request.generationConfig = genConfig;

  const envelope = { project: tokens.projectId, model: modelId, user_prompt_id: crypto.randomUUID(), request };

  const res = await fetch(`${CODE_ASSIST_BASE}:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${tokens.accessToken}`,
      'User-Agent': buildUserAgent(modelId),
      'x-activity-request-id': crypto.randomUUID(),
      Accept: 'text/event-stream',
      ...CODE_ASSIST_HEADERS
    },
    body: JSON.stringify(envelope)
  });

  if (!res.ok) throw new Error(`Cloud stream failed (${res.status}): ${await res.text()}`);

  yield { type: 'start-step' };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const json = trimmed.slice(5).trim();
      if (!json || json === '[DONE]') continue;
      try {
        const parsed = JSON.parse(json);
        const inner = parsed.response || parsed;
        const parts = inner.candidates?.[0]?.content?.parts || [];
        for (const part of parts) {
          if (part.text && !part.thought) yield { type: 'text-delta', textDelta: part.text };
          if (part.inlineData) yield { type: 'image-data', inlineData: part.inlineData };
        }
      } catch {}
    }
  }
  yield { type: 'finish-step', finishReason: 'stop' };
  if (onStepFinish) await onStepFinish();
}

function streamCloud(params) {
  return { fullStream: cloudStream(params), warnings: Promise.resolve([]) };
}

module.exports = { cloudGenerate, cloudStream, streamCloud };
