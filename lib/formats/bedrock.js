const { BridgeError } = require('../errors');

function toParams(req) {
  const messages = (req.messages || []).map(m => ({
    role: m.role,
    content: (typeof m.content === 'string' ? [{ text: m.content }] : m.content || []).map(b => {
      if (b.text !== undefined) return { type: 'text', text: b.text };
      if (b.toolUse) return { type: 'tool_use', id: b.toolUse.toolUseId, name: b.toolUse.name, input: b.toolUse.input };
      if (b.toolResult) return { type: 'tool_result', tool_use_id: b.toolResult.toolUseId, content: b.toolResult.content };
      return b;
    }),
  }));
  const system = (req.system || []).map(s => s.text).join('\n') || undefined;
  const tools = {};
  for (const t of (req.toolConfig?.tools || [])) {
    const s = t.toolSpec;
    tools[s.name] = { description: s.description, parameters: s.inputSchema?.json || {} };
  }
  return {
    model: req.model,
    messages,
    system,
    tools: Object.keys(tools).length ? tools : undefined,
    temperature: req.inferenceConfig?.temperature,
    maxOutputTokens: req.inferenceConfig?.maxTokens,
  };
}

function toResponse(events) {
  let text = '';
  let stopReason = 'end_turn';
  const toolUses = [];
  for (const ev of events) {
    if (ev.type === 'text-delta') text += ev.textDelta;
    if (ev.type === 'tool-call') toolUses.push({ toolUseId: ev.toolCallId, name: ev.toolName, input: ev.args });
    if (ev.type === 'finish-step') {
      if (ev.finishReason === 'tool-calls') stopReason = 'tool_use';
      else if (ev.finishReason === 'length') stopReason = 'max_tokens';
      else stopReason = 'end_turn';
    }
  }
  const content = toolUses.length
    ? toolUses.map(t => ({ toolUse: t }))
    : [{ text }];
  return {
    output: { message: { role: 'assistant', content } },
    stopReason,
    usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    metrics: { latencyMs: 0 },
  };
}

const STOP_REASON_MAP = { stop: 'end_turn', 'tool-calls': 'tool_use', length: 'max_tokens' };

const SSE_HANDLERS = {
  'start-step': () => JSON.stringify({ messageStart: { role: 'assistant' } }) + '\n',
  'text-delta': (ev) => JSON.stringify({ contentBlockDelta: { contentBlockIndex: 0, delta: { text: ev.textDelta } } }) + '\n',
  'tool-call': (ev) => [
    JSON.stringify({ contentBlockStart: { contentBlockIndex: 1, contentBlock: { toolUse: { toolUseId: ev.toolCallId, name: ev.toolName, input: {} } } } }),
    JSON.stringify({ contentBlockDelta: { contentBlockIndex: 1, delta: { toolUse: { input: JSON.stringify(ev.args) } } } }),
    JSON.stringify({ contentBlockStop: { contentBlockIndex: 1 } }),
  ].join('\n') + '\n',
  'finish-step': (ev) => JSON.stringify({ messageStop: { stopReason: STOP_REASON_MAP[ev.finishReason] || 'end_turn' } }) + '\n',
};

function toSSE(event, state = {}) {
  const handler = SSE_HANDLERS[event.type];
  return handler ? handler(event, state) : '';
}

module.exports = { toParams, toResponse, toSSE };
