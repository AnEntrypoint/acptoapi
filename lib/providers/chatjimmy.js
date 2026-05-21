'use strict';
const { BridgeError } = require('../errors');

const BASE = process.env.CHATJIMMY_BASE || 'https://chatjimmy.ai';
const DEFAULT_MODEL = 'llama3.1-8B';
const STATS_RE = /<\|stats\|>[\s\S]*?<\|\/stats\|>\s*$/;

function convertMessages(messages, system) {
  const out = [];
  if (system) out.push({ role: 'system', content: typeof system === 'string' ? system : JSON.stringify(system) });
  for (const m of messages || []) {
    if (typeof m.content === 'string') { out.push({ role: m.role, content: m.content }); continue; }
    if (!Array.isArray(m.content)) continue;
    const text = m.content.filter(b => b && b.type === 'text').map(b => b.text).join('');
    if (text) out.push({ role: m.role, content: text });
  }
  return out;
}

async function* streamChatJimmy({ model, messages, system }) {
  const selectedModel = (model && model.includes('/') ? model.split('/').slice(1).join('/') : model) || DEFAULT_MODEL;
  const msgs = convertMessages(messages, system);
  const r = await fetch(`${BASE}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: msgs, chatOptions: { selectedModel } }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new BridgeError(`chatjimmy ${r.status}: ${t}`, { status: r.status, retryable: r.status === 429 || r.status >= 500 });
  }
  yield { type: 'start-step' };
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let inStats = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      while (true) {
        if (inStats) {
          const end = buf.indexOf('<|/stats|>');
          if (end < 0) { buf = ''; break; }
          buf = buf.slice(end + '<|/stats|>'.length);
          inStats = false;
          continue;
        }
        const start = buf.indexOf('<|stats|>');
        if (start >= 0) {
          if (start > 0) yield { type: 'text-delta', textDelta: buf.slice(0, start) };
          buf = buf.slice(start + '<|stats|>'.length);
          inStats = true;
          continue;
        }
        const hold = Math.min(buf.length, 9);
        const safeLen = buf.length - hold;
        if (safeLen > 0) { yield { type: 'text-delta', textDelta: buf.slice(0, safeLen) }; buf = buf.slice(safeLen); }
        break;
      }
    }
    buf += dec.decode();
    if (!inStats && buf) {
      const tail = buf.replace(STATS_RE, '');
      if (tail) yield { type: 'text-delta', textDelta: tail };
    }
  } finally { try { reader.releaseLock(); } catch {} }
  yield { type: 'finish-step', finishReason: 'stop' };
}

let _modelsCache = null;
let _modelsCacheTs = 0;
async function listChatJimmyModels() {
  const now = Date.now();
  if (_modelsCache && (now - _modelsCacheTs) < 5 * 60 * 1000) return _modelsCache;
  try {
    const r = await fetch(`${BASE}/api/models`, { signal: AbortSignal.timeout(2000) });
    if (!r.ok) return [DEFAULT_MODEL];
    const j = await r.json();
    const ids = (j.data || []).map(m => m.id).filter(Boolean);
    if (ids.length) { _modelsCache = ids; _modelsCacheTs = now; return ids; }
  } catch {}
  return [DEFAULT_MODEL];
}

module.exports = { streamChatJimmy, listChatJimmyModels, DEFAULT_MODEL };
