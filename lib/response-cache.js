'use strict';
// In-process LRU + inflight-dedupe for idempotent /v1/chat/completions calls.
//
// - Cache key = sha256(model + JSON(messages) + JSON(tools||[]) + temperature + JSON(response_format||null)).
// - Skipped when: stream=true, tools present, temperature > ACPTOAPI_CACHE_MAX_TEMP (default 0.3),
//   or ACPTOAPI_CACHE_ENABLED=0.
// - Dedupe: if an identical request is mid-flight, late callers await the same Promise.
// - TTL: ACPTOAPI_CACHE_TTL_MS (default 5min). Max: ACPTOAPI_CACHE_MAX (default 256 entries).
// - Returns a SHALLOW CLONE on hit so callers can't mutate the cached object.

const crypto = require('crypto');

const TTL_MS = Number(process.env.ACPTOAPI_CACHE_TTL_MS) || 5 * 60 * 1000;
const MAX_ENTRIES = Number(process.env.ACPTOAPI_CACHE_MAX) || 256;
const MAX_TEMP = Number(process.env.ACPTOAPI_CACHE_MAX_TEMP);
const TEMP_GATE = Number.isFinite(MAX_TEMP) ? MAX_TEMP : 0.3;
const ENABLED = process.env.ACPTOAPI_CACHE_ENABLED !== '0';

const cache = new Map(); // key -> { value, expiresAt }
const inflight = new Map(); // key -> Promise<value>
const stats = { hits: 0, misses: 0, dedupes: 0, bypasses: 0, expirations: 0 };

function shouldCache(body) {
  if (!ENABLED) return false;
  if (body.stream === true) return false;
  if (Array.isArray(body.tools) && body.tools.length > 0) return false;
  const temp = typeof body.temperature === 'number' ? body.temperature : 1.0;
  if (temp > TEMP_GATE) return false;
  return true;
}

function keyFor(body) {
  const h = crypto.createHash('sha256');
  h.update(String(body.model || ''));
  h.update('\x00');
  h.update(JSON.stringify(body.messages || []));
  h.update('\x00');
  h.update(JSON.stringify(body.tools || []));
  h.update('\x00');
  h.update(String(body.temperature ?? 1.0));
  h.update('\x00');
  h.update(JSON.stringify(body.response_format || null));
  return h.digest('hex');
}

function get(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    cache.delete(key);
    stats.expirations++;
    return null;
  }
  // LRU touch: re-insert at the end.
  cache.delete(key);
  cache.set(key, entry);
  return entry.value;
}

function set(key, value) {
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { value, expiresAt: Date.now() + TTL_MS });
}

function clone(value) {
  try { return JSON.parse(JSON.stringify(value)); } catch { return value; }
}

// Wraps the provider call so concurrent identical requests share one inflight.
async function wrap(body, runner) {
  if (!shouldCache(body)) {
    stats.bypasses++;
    return { value: await runner(), hit: 'bypass' };
  }
  const key = keyFor(body);
  const hit = get(key);
  if (hit) { stats.hits++; return { value: clone(hit), hit: 'hit' }; }
  if (inflight.has(key)) {
    stats.dedupes++;
    const v = await inflight.get(key);
    return { value: clone(v), hit: 'dedupe' };
  }
  const p = (async () => {
    const v = await runner();
    set(key, v);
    return v;
  })();
  inflight.set(key, p);
  try {
    const value = await p;
    stats.misses++;
    return { value: clone(value), hit: 'miss' };
  } finally {
    inflight.delete(key);
  }
}

function getStats() {
  return { ...stats, size: cache.size, inflight: inflight.size, ttl_ms: TTL_MS, max: MAX_ENTRIES, max_temp: TEMP_GATE, enabled: ENABLED };
}

function clear() {
  cache.clear();
  inflight.clear();
}

module.exports = { wrap, getStats, clear, shouldCache, keyFor };
