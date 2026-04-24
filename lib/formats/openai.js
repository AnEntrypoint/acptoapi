const { BridgeError } = require('../errors');

function uid() {
  return 'chatcmpl-' + Math.random().toString(36).slice(2, 18);
}

function extractSystem(messages) {
  const sys = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
  const rest = messages.filter(m => m.role !== 'system');
  return { system: sys || undefined, messages: rest };
}

function normalizeOpenAIMessages(messages) {
  return messages.map(m => {
    if (m.role === 'tool') {
      return {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content }],
      };
    }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      const toolBlocks = m.tool_calls.map(tc => ({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: (() => { try { return JSON.parse(tc.function.arguments); } catch { return {}; } })(),
      }));
      const textContent = m.content ? [{ type: 'text', text: m.content }] : [];
      return { role: 'assistant', content: [...textContent, ...toolBlocks] };
    }
    return m;
  });
}

function toParams(req) {
  const { system: sysFromMsgs, messages: filteredMsgs } = extractSystem(req.messages || []);
  const system = req.system || sysFromMsgs;
  const messages = normalizeOpenAIMessages(filteredMsgs);
  const tools = {};
  if (Array.isArray(req.tools)) {
    for (const t of req.tools) {
      const fn = t.function || t;
      tools[fn.name] = { description: fn.description, parameters: fn.parameters };
    }
  }
  return {
    model: req.model,
    messages,
    system: system || undefined,
    tools: Object.keys(tools).length ? tools : undefined,
    temperature: req.temperature,
    maxOutputTokens: req.max_tokens,
  };
}

function toResponse(events) {
  let text = '';
  let finishReason = 'stop';
  const toolCalls = [];
  for (const ev of events) {
    if (ev.type === 'text-delta') text += ev.textDelta;
    if (ev.type === 'tool-call') {
      toolCalls.push({
        id: ev.toolCallId,
        type: 'function',
        function: { name: ev.toolName, arguments: JSON.stringify(ev.args) },
      });
    }
    if (ev.type === 'finish-step') {
      if (ev.finishReason === 'tool-calls') finishReason = 'tool_calls';
      if (ev.finishReason === 'error') finishReason = 'error';
    }
  }
  const message = { role: 'assistant', content: text || null };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    id: uid(),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: '',
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

const SSE_HANDLERS = {
  'start-step': (ev, state) => {
    state.id = uid();
    state.created = Math.floor(Date.now() / 1000);
    const chunk = { id: state.id, object: 'chat.completion.chunk', created: state.created, model: '', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] };
    return `data: ${JSON.stringify(chunk)}\n\n`;
  },
  'text-delta': (ev, state) => {
    const chunk = { id: state.id, object: 'chat.completion.chunk', created: state.created, model: '', choices: [{ index: 0, delta: { content: ev.textDelta }, finish_reason: null }] };
    return `data: ${JSON.stringify(chunk)}\n\n`;
  },
  'tool-call': (ev, state) => {
    const chunk = {
      id: state.id, object: 'chat.completion.chunk', created: state.created, model: '',
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: ev.toolCallId, type: 'function', function: { name: ev.toolName, arguments: JSON.stringify(ev.args) } }] }, finish_reason: null }],
    };
    return `data: ${JSON.stringify(chunk)}\n\n`;
  },
  'finish-step': (ev, state) => {
    const finishMap = { stop: 'stop', 'tool-calls': 'tool_calls', error: 'stop' };
    const chunk = { id: state.id, object: 'chat.completion.chunk', created: state.created, model: '', choices: [{ index: 0, delta: {}, finish_reason: finishMap[ev.finishReason] || 'stop' }] };
    return `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
  },
  'error': (ev) => `data: ${JSON.stringify({ error: { message: ev.error?.message || 'unknown', type: 'server_error' } })}\n\n`,
};

function toSSE(event, state = {}) {
  const handler = SSE_HANDLERS[event.type];
  if (!handler) return '';
  return handler(event, state);
}

module.exports = { toParams, toResponse, toSSE };
