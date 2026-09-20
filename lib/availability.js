'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const MIN_SAMPLES_BEFORE_SUCCESS_BONUS = Number(process.env.ACPTOAPI_AVAILABILITY_MIN_SAMPLES) || 2;
const LATENCY_EMA_WEIGHT = Number(process.env.ACPTOAPI_AVAILABILITY_LATENCY_DECAY) || 0.3;
const FAILURE_DECAY_HALF_LIFE_MS = Number(process.env.ACPTOAPI_AVAILABILITY_FAILURE_HALF_LIFE_MS) || 1800000;
const SUCCESS_STREAK_CAP = Number(process.env.ACPTOAPI_AVAILABILITY_SUCCESS_STREAK_CAP) || 30;
const LATENCY_PENALTY_CAP_MS = Number(process.env.ACPTOAPI_AVAILABILITY_LATENCY_PENALTY_CAP_MS) || (SUCCESS_STREAK_CAP * 1000);
const MAX_RETRY_AFTER_MS = Number(process.env.ACPTOAPI_AVAILABILITY_MAX_RETRY_AFTER_MS) || 900000;

const PERSIST_ENABLED = process.env.ACPTOAPI_AVAILABILITY_PERSIST !== '0';
const CACHE_PATH = process.env.ACPTOAPI_AVAILABILITY_CACHE_PATH || path.join(os.homedir(), '.acptoapi', 'availability-cache.json');
const SAVE_EVERY_N_RECORDS = 10;

function loadCacheFile() {
  if (!PERSIST_ENABLED) return new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    const m = new Map();
    for (const [model, e] of Object.entries(raw || {})) {
      if (e && typeof e === 'object') m.set(model, { model, ...e });
    }
    return m;
  } catch {
    return new Map();
  }
}

function saveCacheFile(cache) {
  if (!PERSIST_ENABLED) return;
  try {
    const obj = {};
    for (const [model, e] of cache.entries()) obj[model] = e;
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(obj, null, 2));
  } catch {}
}

function clearCacheFile() {
  if (!PERSIST_ENABLED) return;
  try { fs.unlinkSync(CACHE_PATH); } catch {}
}

function createAvailabilityTracker({ persist = false } = {}) {
  const cache = persist ? loadCacheFile() : new Map();
  let writesSinceSave = 0;

  function maybeSave() {
    if (!persist) return;
    writesSinceSave += 1;
    if (writesSinceSave >= SAVE_EVERY_N_RECORDS) {
      writesSinceSave = 0;
      saveCacheFile(cache);
    }
  }

  function entry(model) {
    if (!cache.has(model)) {
      cache.set(model, {
        model,
        ok: null,
        successStreak: 0,
        failStreak: 0,
        totalSamples: 0,
        avgLatencyMs: null,
        lastSuccessTs: null,
        lastFailTs: null,
        retryNotBeforeTs: null,
      });
    }
    return cache.get(model);
  }

  function recordSuccess(model, latencyMs) {
    const e = entry(model);
    e.ok = true;
    e.successStreak += 1;
    e.failStreak = 0;
    e.totalSamples += 1;
    e.lastSuccessTs = Date.now();
    e.retryNotBeforeTs = null;
    if (typeof latencyMs === 'number' && latencyMs >= 0) {
      e.avgLatencyMs = e.avgLatencyMs == null ? latencyMs : (e.avgLatencyMs * (1 - LATENCY_EMA_WEIGHT) + latencyMs * LATENCY_EMA_WEIGHT);
    }
    maybeSave();
    return e;
  }

  function recordFailure(model, retryAfterMs) {
    const e = entry(model);
    e.ok = false;
    e.failStreak += 1;
    e.successStreak = 0;
    e.totalSamples += 1;
    e.lastFailTs = Date.now();
    e.retryNotBeforeTs = (typeof retryAfterMs === 'number' && retryAfterMs >= 0) ? Date.now() + Math.min(retryAfterMs, MAX_RETRY_AFTER_MS) : null;
    maybeSave();
    return e;
  }

  function isRetryDeadlineActive(model) {
    const e = cache.get(model);
    return !!(e && e.retryNotBeforeTs && e.retryNotBeforeTs > Date.now());
  }

  function markCreditDead(model) {
    const e = entry(model);
    e.creditDead = true;
    e.creditDeadAt = Date.now();
    maybeSave();
    return e;
  }
  function isCreditDead(model) {
    const e = cache.get(model);
    return !!(e && e.creditDead);
  }

  const SOFT_FAILURE_PENALTY_CAP = Number(process.env.ACPTOAPI_AVAILABILITY_SOFT_FAIL_CAP) || 5;
  function recordSoftFailure(model) {
    const e = entry(model);
    e.softFailStreak = Math.min((e.softFailStreak || 0) + 1, SOFT_FAILURE_PENALTY_CAP);
    e.lastSoftFailTs = Date.now();
    maybeSave();
    return e;
  }
  function recordSoftSuccess(model) {
    const e = entry(model);
    if (e.softFailStreak) e.softFailStreak = 0;
    return e;
  }

  const EFFECTIVELY_RECOVERED_THRESHOLD = 0.05;
  function effectiveFailStreak(e) {
    if (!e || e.failStreak === 0) return 0;
    if (e.lastFailTs == null) return e.failStreak;
    const elapsedMs = Date.now() - e.lastFailTs;
    if (elapsedMs <= 0) return e.failStreak;
    const decayed = e.failStreak * Math.exp(-elapsedMs / FAILURE_DECAY_HALF_LIFE_MS * Math.LN2);
    return decayed < EFFECTIVELY_RECOVERED_THRESHOLD ? 0 : decayed;
  }

  function score(model) {
    const e = cache.get(model);
    if (!e || e.totalSamples === 0) return 0;
    const failStreakForScoring = effectiveFailStreak(e);
    const failPenalty = Math.min(failStreakForScoring, 10) * 2;
    const successBonus = e.totalSamples >= MIN_SAMPLES_BEFORE_SUCCESS_BONUS ? Math.min(e.successStreak, SUCCESS_STREAK_CAP) : 0;
    const softFailPenalty = e.softFailStreak ? Math.min(e.softFailStreak, SOFT_FAILURE_PENALTY_CAP) : 0;
    if (failPenalty === 0 && successBonus === 0 && softFailPenalty === 0) return 0;
    const streakScore = successBonus - failPenalty - softFailPenalty;
    const latencyPenalty = e.avgLatencyMs == null ? 0 : Math.min(e.avgLatencyMs / 1000, LATENCY_PENALTY_CAP_MS / 1000);
    return streakScore - latencyPenalty;
  }

  function peek(model) {
    const e = cache.get(model);
    if (!e) return { model, ok: null, successStreak: 0, failStreak: 0, effectiveFailStreak: 0, avgLatencyMs: null, lastSuccessTs: null, lastFailTs: null, rank: 0 };
    return { ...e, effectiveFailStreak: effectiveFailStreak(e), rank: score(model) };
  }

  function getAll() {
    return Array.from(cache.keys())
      .map(peek)
      .sort((a, b) => b.rank - a.rank);
  }

  function rerank(links, opts = {}) {
    if (!Array.isArray(links) || links.length <= 1) return links;
    const getModel = opts.getModel || ((l) => (typeof l === 'string' ? l : l.model));
    return links
      .map((l, i) => ({ l, i, s: score(getModel(l)) }))
      .sort((a, b) => (b.s - a.s) || (a.i - b.i))
      .map((x) => x.l);
  }

  function reset(model) {
    if (model) cache.delete(model);
    else cache.clear();
    writesSinceSave = 0;
    if (persist) {
      if (model) saveCacheFile(cache);
      else clearCacheFile();
    }
  }

  function flush() {
    if (persist) saveCacheFile(cache);
  }

  return { recordSuccess, recordFailure, recordSoftFailure, recordSoftSuccess, score, peek, getAll, rerank, reset, flush, isRetryDeadlineActive, markCreditDead, isCreditDead };
}

const _singleton = createAvailabilityTracker({ persist: true });

module.exports = {
  createAvailabilityTracker,
  recordSuccess: (m, ms) => _singleton.recordSuccess(m, ms),
  recordFailure: (m, retryAfterMs) => _singleton.recordFailure(m, retryAfterMs),
  recordSoftFailure: (m) => _singleton.recordSoftFailure(m),
  recordSoftSuccess: (m) => _singleton.recordSoftSuccess(m),
  score: (m) => _singleton.score(m),
  peek: (m) => _singleton.peek(m),
  getAll: () => _singleton.getAll(),
  rerank: (links, opts) => _singleton.rerank(links, opts),
  reset: (m) => _singleton.reset(m),
  flush: () => _singleton.flush(),
  isRetryDeadlineActive: (m) => _singleton.isRetryDeadlineActive(m),
  markCreditDead: (m) => _singleton.markCreditDead(m),
  isCreditDead: (m) => _singleton.isCreditDead(m),
};
