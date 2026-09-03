const finishMap = { stop: 'COMPLETE', 'tool-calls': 'TOOL_CALL', error: 'MAX_TOKENS' };

function uid() { return 'gen-' + Math.random().toString(36).slice(2, 18); }

function toParams(req) {
  const system = (req.messages || []).filter(m => m.role === 'system').map(m => m.content).join('\n');
  const messages = (req.messages || []).filter(m => m.role !== 'system');
  const tools = Array.isArray(req.tools)
    ? req.tools.map(t => ({ type: 'function', function: { name: t.function.name, description: t.function.description, parameters: t.function.parameters } }))
    : undefined;
  return {
    model: req.model,
    messages,
    system: system || undefined,
    tools: tools && tools.length ? tools : undefined,
    temperature: req.temperature,
    maxOutputTokens: req.max_tokens,
  };
}

function toResponse(events) {
  let text = '';
  let finishReason = 'COMPLETE';
  const toolCalls = [];
  for (const ev of events) {
    if (ev.type === 'text-delta') text += ev.textDelta;
    if (ev.type === 'tool-call') toolCalls.push({ id: ev.toolCallId, type: 'function', function: { name: ev.toolName, arguments: JSON.stringify(ev.args) } });
    if (ev.type === 'finish-step') finishReason = finishMap[ev.finishReason] || 'COMPLETE';
  }
  const content = text ? [{ type: 'text', text }] : [];
  const message = { role: 'assistant', content };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return { id: uid(), finish_reason: finishReason, message };
}

const SSE_HANDLERS = {
  'start-step': (ev, state) => {
    state.id = uid();
    return `data: ${JSON.stringify({ event_type: 'message-start', id: state.id })}\n\n`;
  },
  'text-delta': (ev) => `data: ${JSON.stringify({ event_type: 'content-delta', delta: { message: { content: { text: ev.textDelta } } } })}\n\n`,
  'tool-call': (ev) => {
    const start = `data: ${JSON.stringify({ event_type: 'tool-call-start', delta: { message: { tool_calls: [{ id: ev.toolCallId, function: { name: ev.toolName } }] } } })}\n\n`;
    const delta = `data: ${JSON.stringify({ event_type: 'tool-call-delta', delta: { message: { tool_calls: [{ function: { arguments: JSON.stringify(ev.args) } }] } } })}\n\n`;
    return start + delta;
  },
  'finish-step': (ev) => `data: ${JSON.stringify({ event_type: 'message-end', delta: { finish_reason: finishMap[ev.finishReason] || 'COMPLETE' } })}\n\n`,
  'error': (ev) => `data: ${JSON.stringify({ event_type: 'error', error: { message: ev.error?.message || 'unknown' } })}\n\n`,
};

function toSSE(event, state = {}) {
  const handler = SSE_HANDLERS[event.type];
  return handler ? handler(event, state) : '';
}

module.exports = { toParams, toResponse, toSSE };
