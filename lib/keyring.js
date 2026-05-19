'use strict';

// Per-key backoff so a flaky/exhausted key for a provider does not poison the
// remaining keys for that same provider. Steps mirror lib/sampler.js but at
// per-(envKey,key) granularity instead of per-provider granularity.
const BACKOFF_STEPS_MS = [30000, 60000, 120000, 240000, 480000];

const _state = new Map();

function _entry(envKey, key) {
  const id = envKey + '|' + key;
  if (!_state.has(id)) _state.set(id, { ok: null, failCount: 0, nextCheck: 0, lastFailedAt: null, lastReason: null });
  return _state.get(id);
}

function _isUsable(envKey, key) {
  const e = _entry(envKey, key);
  if (e.nextCheck && e.nextCheck > Date.now()) return false;
  return true;
}

function _collectFromEnv(envKey) {
  if (!envKey) return [];
  const seen = new Set();
  const out = [];
  const push = (val) => {
    if (!val) return;
    const trimmed = String(val).trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    out.push(trimmed);
  };
  push(process.env[envKey]);
  // Indexed variants: GROQ_API_KEY_1, GROQ_API_KEY_2, ... up to _99
  for (let i = 1; i <= 99; i++) {
    push(process.env[envKey + '_' + i]);
  }
  // Allow ACPTOAPI_KEYS_<NAME> as a JSON array escape hatch (rare)
  const bag = process.env['ACPTOAPI_KEYS_' + envKey];
  if (bag) {
    try {
      const arr = JSON.parse(bag);
      if (Array.isArray(arr)) for (const k of arr) push(k);
    } catch { /* ignore malformed */ }
  }
  return out;
}

function getKeys(envKey) {
  return _collectFromEnv(envKey);
}

function hasAnyKey(envKey) {
  return _collectFromEnv(envKey).length > 0;
}

// First usable key (not in backoff). Returns null if none configured at all,
// returns the *least-recently-failed* key when every key is in backoff so
// callers still attempt rather than hard-fail.
function getKey(envKey) {
  const keys = _collectFromEnv(envKey);
  if (keys.length === 0) return null;
  for (const k of keys) if (_isUsable(envKey, k)) return k;
  // All in backoff — pick the one whose backoff is closest to expiring.
  let best = keys[0];
  let bestNext = _entry(envKey, best).nextCheck || 0;
  for (const k of keys) {
    const e = _entry(envKey, k);
    if (e.nextCheck < bestNext) { best = k; bestNext = e.nextCheck; }
  }
  return best;
}

// All usable keys in declared order. Callers that loop key-by-key on per-call
// failures (handleBrandChat) use this; chain-level callers use getKey().
function listUsable(envKey) {
  return _collectFromEnv(envKey).filter(k => _isUsable(envKey, k));
}

function markKeyFailed(envKey, key, reason) {
  if (!envKey || !key) return;
  const e = _entry(envKey, key);
  e.ok = false;
  e.failCount = (e.failCount || 0) + 1;
  e.lastFailedAt = Date.now();
  e.lastReason = reason || 'error';
  const step = Math.min(e.failCount - 1, BACKOFF_STEPS_MS.length - 1);
  e.nextCheck = Date.now() + BACKOFF_STEPS_MS[step];
}

function markKeyOk(envKey, key) {
  if (!envKey || !key) return;
  const e = _entry(envKey, key);
  e.ok = true;
  e.failCount = 0;
  e.nextCheck = 0;
  e.lastReason = null;
}

function reset(envKey, key) {
  if (key) { _state.delete(envKey + '|' + key); return; }
  for (const id of [..._state.keys()]) if (id.startsWith(envKey + '|')) _state.delete(id);
}

function _mask(key) {
  if (!key) return null;
  if (key.length <= 8) return '***' + key.slice(-2);
  return key.slice(0, 4) + '…' + key.slice(-4);
}

function peekStatus(envKey) {
  const keys = _collectFromEnv(envKey);
  const now = Date.now();
  return keys.map((k, idx) => {
    const e = _entry(envKey, k);
    const inBackoff = e.nextCheck > now;
    return {
      index: idx,
      key: _mask(k),
      ok: e.ok,
      failCount: e.failCount || 0,
      lastFailedAt: e.lastFailedAt,
      lastReason: e.lastReason,
      inBackoff,
      nextRetryInMs: inBackoff ? Math.max(0, e.nextCheck - now) : 0,
    };
  });
}

// Classify an upstream failure into a backoff-worthy reason. 401/403 = auth
// (probably bad key, longer backoff value tier handled by failCount). 429 =
// rate limit (per-key, rotate). 5xx = transient (do not backoff this key
// aggressively — the provider is the problem, not the key).
function classify(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'upstream_5xx';
  return null;
}

module.exports = {
  getKeys, getKey, listUsable, hasAnyKey,
  markKeyFailed, markKeyOk, reset,
  peekStatus, classify,
  _BACKOFF_STEPS_MS: BACKOFF_STEPS_MS,
};
