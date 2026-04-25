'use strict';
const BACKENDS = {
  kilo: { base: 'http://localhost:4780', providerID: 'kilo', defaultModel: 'x-ai/grok-code-fast-1:optimized:free' },
  opencode: { base: 'http://localhost:4790', providerID: 'opencode', defaultModel: 'minimax-m2.5-free' },
};

function splitModel(fullModel) {
  const m = /^(kilo|opencode)\/(.+)$/.exec(fullModel || '');
  if (!m) return { prefix: 'kilo', model: fullModel || BACKENDS.kilo.defaultModel };
  return { prefix: m[1], model: m[2] };
}

function resolveBackend(prefix, overrides = {}) {
  const b = BACKENDS[prefix];
  if (!b) throw new Error(`unknown acp backend: ${prefix} (expected: kilo, opencode)`);
  return { ...b, ...(overrides[prefix] || {}) };
}

async function createSession(backend) {
  const r = await fetch(backend.base + '/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  if (!r.ok) throw new Error(`ACP /session ${r.status}: ${await r.text()}`);
  return (await r.json()).id;
}

async function sendMessage(backend, sessionId, text, modelId) {
  const body = { parts: [{ type: 'text', text }] };
  if (backend.providerID === 'opencode') body.model = { providerID: 'opencode', modelID: modelId };
  else { body.providerID = 'kilo'; body.modelID = modelId; }
  const r = await fetch(`${backend.base}/session/${sessionId}/message`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`ACP /message ${r.status}: ${await r.text()}`);
  return r;
}

async function* streamEvents(backend, sessionId, signal) {
  const r = await fetch(backend.base + '/event', { method: 'GET', signal });
  if (!r.ok) throw new Error(`ACP /event ${r.status}`);
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) return;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      if (!raw.startsWith('data: ')) continue;
      let ev;
      try { ev = JSON.parse(raw.slice(6)); } catch { continue; }
      if (ev.properties?.sessionID && ev.properties.sessionID !== sessionId) continue;
      yield ev;
    }
  }
}

async function probe(backend, timeoutMs = 2000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(backend.base + '/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: ctrl.signal });
    return r.ok;
  } catch { return false; }
  finally { clearTimeout(t); }
}

module.exports = { BACKENDS, splitModel, resolveBackend, createSession, sendMessage, streamEvents, probe };
