const { BridgeError } = require('../errors');
const { convertMessages } = require('../convert');

function geminiMessagesToAnthropic(contents) {
  return (contents || []).map(c => {
    const role = c.role === 'model' ? 'assistant' : 'user';
    const content = (c.parts || []).map(p => {
      if (p.text !== undefined) return { type: 'text', text: p.text };
      if (p.inlineData) return { type: 'image', source: { type: 'base64', media_type: p.inlineData.mimeType, data: p.inlineData.data } };
      if (p.fileData) return { type: 'image', source: { type: 'url', url: p.fileData.fileUri, media_type: p.fileData.mimeType } };
      if (p.functionCall) return { type: 'tool_use', id: p.functionCall.name, name: p.functionCall.name, input: p.functionCall.args || {} };
      if (p.functionResponse) return { type: 'tool_result', tool_use_id: p.functionResponse.name, content: JSON.stringify(p.functionResponse.response) };
      return null;
    }).filter(Boolean);
    return { role, content };
  });
}

function toParams(req) {
  const messages = geminiMessagesToAnthropic(req.contents);
  const cfg = req.generationConfig || req.config || {};
  const tools = {};
  if (Array.isArray(req.tools)) {
    for (const t of req.tools) {
      if (t.functionDeclarations) {
        for (const fn of t.functionDeclarations) {
          tools[fn.name] = { description: fn.description, parameters: fn.parameters };
        }
      }
    }
  }
  return {
    model: req.model,
    messages,
    system: req.systemInstruction?.parts?.[0]?.text,
    tools: Object.keys(tools).length ? tools : undefined,
    temperature: cfg.temperature,
    maxOutputTokens: cfg.maxOutputTokens,
    topP: cfg.topP,
    topK: cfg.topK,
  };
}

function eventsToText(events) {
  return events.filter(e => e.type === 'text-delta').map(e => e.textDelta).join('');
}

function eventsToFunctionCalls(events) {
  return events.filter(e => e.type === 'tool-call').map(e => ({ name: e.toolName, args: e.args }));
}

function toGeminiResponse(events) {
  const text = eventsToText(events);
  const calls = eventsToFunctionCalls(events);
  const parts = [];
  if (text) parts.push({ text });
  for (const c of calls) parts.push({ functionCall: { name: c.name, args: c.args } });
  const finishEv = events.find(e => e.type === 'finish-step');
  const finishMap = { stop: 'STOP', 'tool-calls': 'STOP', error: 'OTHER' };
  const finishReason = finishEv ? (finishMap[finishEv.finishReason] || 'STOP') : 'STOP';
  return {
    candidates: [{ content: { role: 'model', parts }, finishReason, index: 0 }],
    usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 },
  };
}

function toResponse(events) {
  return toGeminiResponse(events);
}

function toSSE(event) {
  const HANDLERS = {
    'text-delta': (ev) => `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: ev.textDelta }] }, finishReason: null, index: 0 }] })}\n\n`,
    'tool-call': (ev) => `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name: ev.toolName, args: ev.args } }] }, finishReason: null, index: 0 }] })}\n\n`,
    'finish-step': (ev) => {
      const finishMap = { stop: 'STOP', 'tool-calls': 'STOP', error: 'OTHER' };
      return `data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [] }, finishReason: finishMap[ev.finishReason] || 'STOP', index: 0 }] })}\n\n`;
    },
    'error': (ev) => `data: ${JSON.stringify({ error: { code: 500, message: ev.error?.message || 'unknown', status: 'INTERNAL' } })}\n\n`,
  };
  const handler = HANDLERS[event.type];
  return handler ? handler(event) : '';
}

module.exports = { toParams, toResponse, toSSE };
