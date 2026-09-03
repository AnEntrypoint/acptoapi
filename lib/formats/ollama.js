function extractSystem(messages) {
  const sys = messages.filter(m => m.role === 'system').map(m => m.content).join('\n');
  const rest = messages.filter(m => m.role !== 'system');
  return { system: sys || undefined, messages: rest };
}

function toParams(req) {
  const { system, messages } = extractSystem(req.messages || []);
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
    temperature: req.options?.temperature,
    maxOutputTokens: req.options?.num_predict,
  };
}

function toResponse(events) {
  let text = '';
  const toolCalls = [];
  for (const ev of events) {
    if (ev.type === 'text-delta') text += ev.textDelta;
    if (ev.type === 'tool-call') {
      toolCalls.push({ function: { name: ev.toolName, arguments: ev.args } });
    }
  }
  const message = { role: 'assistant', content: text };
  if (toolCalls.length) message.tool_calls = toolCalls;
  return {
    model: '',
    created_at: new Date().toISOString(),
    message,
    done: true,
    done_reason: 'stop',
    eval_count: 0,
    prompt_eval_count: 0,
  };
}

const NDJSON_HANDLERS = {
  'text-delta': (ev) => JSON.stringify({ model: '', created_at: new Date().toISOString(), message: { role: 'assistant', content: ev.textDelta }, done: false }) + '\n',
  'tool-call': (ev) => JSON.stringify({ model: '', created_at: new Date().toISOString(), message: { role: 'assistant', content: '', tool_calls: [{ function: { name: ev.toolName, arguments: ev.args } }] }, done: false }) + '\n',
  'finish-step': () => JSON.stringify({ model: '', created_at: new Date().toISOString(), message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop' }) + '\n',
};

function toSSE(event, state = {}) {
  const handler = NDJSON_HANDLERS[event.type];
  if (!handler) return '';
  return handler(event, state);
}

module.exports = { toParams, toResponse, toSSE };
