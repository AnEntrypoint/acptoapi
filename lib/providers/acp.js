const { BridgeError } = require('../errors');

async function postJson(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) { const t = await res.text(); throw new BridgeError(t, { status: res.status, retryable: res.status === 429 || res.status >= 500 }); }
  return res.json();
}

function subscribeSSE(url, onEvent) {
  const ctrl = new AbortController();
  (async () => {
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok || !res.body) return;
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          const line = chunk.split('\n').find(l => l.startsWith('data:'));
          if (!line) continue;
          try { onEvent(JSON.parse(line.slice(5))); } catch (_) {}
        }
      }
    } catch (e) { if (e.name !== 'AbortError') throw e; }
  })();
  return () => ctrl.abort();
}

function toUserText(messages) {
  return messages.filter(m => m.role === 'user').map(m =>
    typeof m.content === 'string' ? m.content : (m.content || []).filter(b => b.type === 'text').map(b => b.text).join('')
  ).join('\n');
}

async function* streamACP({ url, model, messages, onStepFinish }) {
  yield { type: 'start-step' };
  const base = (url || 'http://localhost:4780').replace(/\/$/, '');
  const { id: sessionId } = await postJson(base + '/session', {});
  const queue = []; let resolveNext = null; let done = false;
  const push = ev => { queue.push(ev); if (resolveNext) { const r = resolveNext; resolveNext = null; r(); } };
  const textSeen = new Map();
  const toolState = new Map();
  const unsubscribe = subscribeSSE(base + '/event', (msg) => {
    if (msg.type !== 'message.part.updated') return;
    const part = msg.properties?.part;
    if (!part) return;
    if (part.type === 'text' && part.messageID) {
      const prior = textSeen.get(part.id) || '';
      const txt = part.text || '';
      if (txt.length > prior.length) { push({ type: 'text-delta', textDelta: txt.slice(prior.length) }); textSeen.set(part.id, txt); }
    } else if (part.type === 'tool') {
      const cid = part.callID; const st = part.state?.status;
      if (st === 'running' && !toolState.has(cid)) { toolState.set(cid, { name: part.tool, args: part.state.input || {} }); push({ type: 'tool-call', toolCallId: cid, toolName: part.tool, args: part.state.input || {} }); }
      else if (st === 'completed' && toolState.has(cid) && !toolState.get(cid).completed) { toolState.get(cid).completed = true; push({ type: 'tool-result', toolCallId: cid, toolName: part.tool, args: part.state.input || {}, result: part.state.output || '' }); }
    }
  });
  const promptPromise = postJson(base + '/session/' + sessionId + '/message', {
    parts: [{ type: 'text', text: toUserText(messages) }],
    providerID: 'kilo',
    modelID: model || 'x-ai/grok-code-fast-1:optimized:free',
  }).finally(() => { done = true; if (resolveNext) { const r = resolveNext; resolveNext = null; r(); } });
  while (!done || queue.length) {
    if (queue.length) { yield queue.shift(); continue; }
    await new Promise(r => { resolveNext = r; });
  }
  const result = await promptPromise;
  unsubscribe();
  yield { type: 'finish-step', finishReason: result.info?.finish || 'stop' };
  if (onStepFinish) await onStepFinish();
}

async function generateACP(opts) {
  let text = '';
  const toolCalls = [];
  for await (const ev of streamACP(opts)) {
    if (ev.type === 'text-delta') text += ev.textDelta;
    else if (ev.type === 'tool-call') toolCalls.push({ id: ev.toolCallId, name: ev.toolName, args: ev.args });
  }
  return { text, toolCalls };
}

module.exports = { streamACP, generateACP };
