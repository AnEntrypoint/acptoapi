const { getProvider } = require('./providers/index');
const { getFormat } = require('./formats/index');
const { randomUUID } = require('crypto');

async function* translate({ from, to, provider: providerName, ...params }) {
  let resolved = params;
  if (from) {
    const fmt = getFormat(from);
    if (fmt.toParams) resolved = fmt.toParams(params);
  }
  const provider = getProvider(providerName || 'gemini');
  const toFmt = to ? getFormat(to) : null;
  const sseState = {};
  for await (const ev of provider.stream(resolved)) {
    if (!toFmt) { yield ev; continue; }
    const sse = toFmt.toSSE(ev, sseState);
    if (sse) yield { type: 'sse', raw: sse, event: ev };
    else yield { type: 'raw', event: ev };
  }
}

async function translateSync(opts) {
  const events = [];
  for await (const ev of translate(opts)) events.push(ev);
  return events;
}

async function buffer({ from, to, provider: providerName, ...params }) {
  let resolved = params;
  if (from) {
    const fmt = getFormat(from);
    if (fmt.toParams) resolved = fmt.toParams(params);
  }
  const provider = getProvider(providerName || 'gemini');
  const events = [];
  for await (const ev of provider.stream(resolved)) events.push(ev);
  if (!to) return events;
  const toFmt = getFormat(to);
  return toFmt.toResponse ? toFmt.toResponse(events) : events;
}

function stream(opts) {
  return { fullStream: translate(opts), warnings: Promise.resolve([]) };
}

// ACP/OpenAI helper exports (used by ESM server/acp files via named import)
function makeChunk(id, model, deltaFields, finishReason = null) {
  return {
    id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, delta: deltaFields, finish_reason: finishReason }],
  };
}

function makeFinal(id, model, content, finishReason = 'stop', usage) {
  return {
    id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason }],
    usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

function genId() { return 'chatcmpl-' + randomUUID().replace(/-/g, '').slice(0, 24); }

function openAIMessagesToACP(messages) {
  const parts = [];
  let system = '';
  for (const m of messages) {
    const text = typeof m.content === 'string' ? m.content
      : (m.content || []).map(c => c.type === 'text' ? c.text : (c.type === 'image_url' ? '[image: ' + (c.image_url?.url || '') + ']' : '')).join('');
    if (m.role === 'system') system += (system ? '\n' : '') + text;
    else parts.push((m.role === 'user' ? 'User' : 'Assistant') + ': ' + text);
  }
  return (system ? system + '\n\n' : '') + parts.join('\n\n');
}

const TERMINAL = new Set(['session.idle', 'session.turn.close']);

function createEventMapper(id, model) {
  const emittedRole = { done: false };
  const partType = new Map();
  const toolSnapshots = new Map();
  const ensureRole = emit => {
    if (!emittedRole.done) { emit(makeChunk(id, model, { role: 'assistant', content: '' })); emittedRole.done = true; }
  };
  return {
    mapEvent(ev, emit) {
      const t = ev.type;
      if (t === 'message.part.updated') {
        const part = ev.properties?.part;
        if (!part) return false;
        if (part.id && part.type) partType.set(part.id, part.type);
        if (part.type === 'tool') {
          const prev = toolSnapshots.get(part.id) || { input: null };
          const cur = { input: part.state?.input };
          const inputChanged = JSON.stringify(cur.input) !== JSON.stringify(prev.input);
          if (inputChanged && cur.input) {
            ensureRole(emit);
            emit(makeChunk(id, model, { tool_calls: [{ index: 0, id: 'call_' + part.id.slice(-8), type: 'function', function: { name: part.tool || part.state?.tool || 'unknown', arguments: JSON.stringify(cur.input) } }] }));
          }
          toolSnapshots.set(part.id, cur);
        }
      } else if (t === 'message.part.delta') {
        const p = ev.properties;
        if (!p?.delta) return TERMINAL.has(t);
        const pt = partType.get(p.partID);
        ensureRole(emit);
        if (pt === 'reasoning') emit(makeChunk(id, model, { reasoning_content: p.delta }));
        else emit(makeChunk(id, model, { content: p.delta }));
      }
      return TERMINAL.has(t);
    },
  };
}

module.exports = { translate, translateSync, buffer, stream, makeChunk, makeFinal, genId, openAIMessagesToACP, createEventMapper };
