'use strict';
const BACKENDS = {
  kilo: { base: 'http://localhost:4780', providerID: 'kilo', defaultModel: 'openrouter/free' },
  opencode: { base: 'http://localhost:4790', providerID: 'opencode', defaultModel: 'minimax-m2.5-free' },
  'gemini-cli': { base: 'http://localhost:4810', providerID: 'gemini-cli', defaultModel: 'gemini-2.0-flash' },
  'qwen-code': { base: 'http://localhost:4820', providerID: 'qwen-code', defaultModel: 'qwen-plus' },
  'codex-cli': { base: 'http://localhost:4830', providerID: 'codex-cli', defaultModel: 'code-davinci-003' },
  'copilot-cli': { base: 'http://localhost:4840', providerID: 'copilot-cli', defaultModel: 'gpt-4o' },
  cline: { base: 'http://localhost:4850', providerID: 'cline', defaultModel: 'claude-opus-4-1' },
  'hermes-agent': { base: 'http://localhost:4860', providerID: 'hermes-agent', defaultModel: 'hermes-3-70b' },
  'cursor-acp': { base: 'http://localhost:4870', providerID: 'cursor-acp', defaultModel: 'cursor-pro' },
  'codeium-cli': { base: 'http://localhost:4880', providerID: 'codeium-cli', defaultModel: 'claude-opus-4' },
  'acp-cli': { base: 'http://localhost:4890', providerID: 'acp-cli', defaultModel: 'gpt-4-turbo' },
};

function registerBackend(name, config) {
  BACKENDS[name] = config;
}

function splitModel(fullModel) {
  const prefixes = Object.keys(BACKENDS).join('|');
  const m = new RegExp(`^(${prefixes})\\/(.+)$`).exec(fullModel || '');
  if (!m) {
    const defaultBackend = Object.keys(BACKENDS)[0];
    return { prefix: defaultBackend, model: fullModel || BACKENDS[defaultBackend].defaultModel };
  }
  return { prefix: m[1], model: m[2] };
}

function resolveBackend(prefix, overrides = {}) {
  const b = BACKENDS[prefix];
  if (!b) throw new Error(`unknown acp backend: ${prefix} (available: ${Object.keys(BACKENDS).join(', ')})`);
  return { ...b, ...(overrides[prefix] || {}) };
}

async function createSession(backend) {
  const r = await fetch(backend.base + '/session', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  if (!r.ok) throw new Error(`ACP /session ${r.status}: ${await r.text()}`);
  return (await r.json()).id;
}

async function sendMessage(backend, sessionId, text, modelId) {
  const body = { parts: [{ type: 'text', text }], model: { providerID: backend.providerID, modelID: modelId } };
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

async function listModels(backend, timeoutMs = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(backend.base + '/models', { method: 'GET', signal: ctrl.signal });
    if (!r.ok) return [];
    const data = await r.json();
    // Wrapper returns ACP-shaped {models:[{id,name,description}], currentValue, configId}.
    // Reduce to canonical model id strings for chain interleaving.
    const raw = Array.isArray(data?.models) ? data.models : Array.isArray(data) ? data : [];
    return raw.map(m => (typeof m === 'string' ? m : m?.id || m?.modelID || m?.name)).filter(Boolean);
  } catch {
    return [];
  } finally {
    clearTimeout(t);
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

module.exports = { BACKENDS, registerBackend, splitModel, resolveBackend, createSession, sendMessage, streamEvents, probe, listModels };
