const { BridgeError } = require('../errors');

function toParams(req) {
  const textParts = (req.parts || []).filter(p => p.type === 'text').map(p => p.text).join('\n');
  const messages = textParts ? [{ role: 'user', content: textParts }] : [];
  return {
    model: req.modelID,
    messages,
    system: req.system,
    tools: req.tools,
    temperature: req.temperature,
    maxOutputTokens: req.maxOutputTokens,
  };
}

function toResponse(events) {
  const parts = [];
  let finishReason = 'stop';
  for (const ev of events) {
    if (ev.type === 'text-delta') {
      const last = parts[parts.length - 1];
      if (last?.type === 'text') last.text += ev.textDelta;
      else parts.push({ type: 'text', text: ev.textDelta });
    }
    if (ev.type === 'tool-call') {
      parts.push({ type: 'tool', toolName: ev.toolName, toolCallId: ev.toolCallId, input: ev.args });
    }
    if (ev.type === 'finish-step') finishReason = ev.finishReason;
  }
  return { parts, finish: finishReason };
}

const SSE_HANDLERS = {
  'text-delta': (ev) => `data: ${JSON.stringify({ type: 'part', part: { type: 'text', delta: ev.textDelta } })}\n\n`,
  'tool-call': (ev) => `data: ${JSON.stringify({ type: 'part', part: { type: 'tool', toolName: ev.toolName, toolCallId: ev.toolCallId, input: ev.args, status: 'running' } })}\n\n`,
  'tool-result': (ev) => `data: ${JSON.stringify({ type: 'part', part: { type: 'tool', toolName: ev.toolName, toolCallId: ev.toolCallId, output: ev.result, status: 'done' } })}\n\n`,
  'start-step': (ev) => `data: ${JSON.stringify({ type: 'step-start' })}\n\n`,
  'finish-step': (ev) => `data: ${JSON.stringify({ type: 'step-finish', finishReason: ev.finishReason })}\n\ndata: ${JSON.stringify({ type: 'finish', finish: ev.finishReason })}\n\n`,
  'error': (ev) => `data: ${JSON.stringify({ type: 'error', error: ev.error?.message || 'unknown' })}\n\n`,
};

function toSSE(event) {
  const handler = SSE_HANDLERS[event.type];
  return handler ? handler(event) : '';
}

module.exports = { toParams, toResponse, toSSE };
