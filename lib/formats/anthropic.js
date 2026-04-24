const { BridgeError } = require('../errors');
const { crypto } = globalThis;

function uid() {
  return 'msg_' + Math.random().toString(36).slice(2, 18);
}

function toParams(req) {
  const tools = {};
  if (Array.isArray(req.tools)) {
    for (const t of req.tools) {
      tools[t.name] = { description: t.description, parameters: t.input_schema };
    }
  }
  return {
    model: req.model,
    messages: req.messages,
    system: req.system,
    tools: Object.keys(tools).length ? tools : undefined,
    temperature: req.temperature,
    maxOutputTokens: req.max_tokens,
  };
}

function toResponse(events) {
  let text = '';
  let stopReason = 'end_turn';
  const toolUses = [];
  for (const ev of events) {
    if (ev.type === 'text-delta') text += ev.textDelta;
    if (ev.type === 'tool-call') toolUses.push({ type: 'tool_use', id: ev.toolCallId, name: ev.toolName, input: ev.args });
    if (ev.type === 'finish-step') {
      if (ev.finishReason === 'tool-calls') stopReason = 'tool_use';
      if (ev.finishReason === 'error') stopReason = 'error';
    }
  }
  const content = [];
  if (text) content.push({ type: 'text', text });
  for (const t of toolUses) content.push(t);
  return {
    id: uid(),
    type: 'message',
    role: 'assistant',
    content,
    stop_reason: stopReason,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

const SSE_HANDLERS = {
  'start-step': (ev, state) => {
    const id = uid();
    state.msgId = id;
    state.blockIndex = 0;
    const lines = [
      `event: message_start`,
      `data: ${JSON.stringify({ type: 'message_start', message: { id, type: 'message', role: 'assistant', content: [], stop_reason: null, usage: { input_tokens: 0, output_tokens: 0 } } })}`,
      '',
    ];
    return lines.join('\n');
  },
  'text-delta': (ev, state) => {
    const parts = [];
    if (!state.textStarted) {
      state.textStarted = true;
      parts.push(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: state.blockIndex, content_block: { type: 'text', text: '' } })}\n`);
    }
    parts.push(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: state.blockIndex, delta: { type: 'text_delta', text: ev.textDelta } })}\n`);
    return parts.join('\n');
  },
  'tool-call': (ev, state) => {
    state.blockIndex += state.textStarted ? 1 : 0;
    state.textStarted = false;
    const idx = state.blockIndex++;
    return [
      `event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: ev.toolCallId, name: ev.toolName, input: {} } })}`,
      `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: JSON.stringify(ev.args) } })}`,
      `event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: idx })}`,
      '',
    ].join('\n');
  },
  'finish-step': (ev, state) => {
    const stopMap = { stop: 'end_turn', 'tool-calls': 'tool_use', error: 'error' };
    const stop_reason = stopMap[ev.finishReason] || 'end_turn';
    return [
      `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason, stop_sequence: null }, usage: { output_tokens: 0 } })}`,
      `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}`,
      '',
    ].join('\n');
  },
  'error': (ev) => `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: ev.error?.message || 'unknown' } })}\n`,
};

function toSSE(event, state = {}) {
  const handler = SSE_HANDLERS[event.type];
  if (!handler) return '';
  return handler(event, state);
}

module.exports = { toParams, toResponse, toSSE };
