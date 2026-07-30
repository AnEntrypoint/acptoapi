'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const MIN_SAMPLES_BEFORE_SUCCESS_BONUS = Number(process.env.ACPTOAPI_AVAILABILITY_MIN_SAMPLES) || 2;
const LATENCY_EMA_WEIGHT = Number(process.env.ACPTOAPI_AVAILABILITY_LATENCY_DECAY) || 0.3;
const STALE_FAILURE_TTL_MS = Number(process.env.ACPTOAPI_AVAILABILITY_FAILURE_TTL_MS) || 3600000;
const NEVER_SUCCEEDED_EXEMPTION_SAMPLE_FLOOR = Number(process.env.ACPTOAPI_AVAILABILITY_NEVER_SUCCEEDED_THRESHOLD) || 5;
// The success-streak bonus used to hard-cap at 10 -- live-witnessed this
// meant every model that had ever cleared 10 clean successes in a row
// scored IDENTICALLY on the streak component, no matter how much further
// ahead its real track record was (a model with a 37-success streak and a
// model with an 11-success streak tied). With ties this common among a
// pool of many "proven good" models, the sort fell through to round-robin
// insertion order as the effective tiebreaker -- so a genuinely superior,
// consistently-fast, long-track-record model did NOT reliably lead the
// chain; the ranking was, in practice, close to random among the healthy
// pool. Raised to 30 (still a real cap, not unbounded -- an extreme
// outlier streak of 500 should not let one model's history dominate every
// other signal forever, and a fresh process/model still climbs to a
// meaningful bonus within a handful of real successes) so a materially
// better track record actually outranks a merely-adequate one instead of
// tying with it.
const SUCCESS_STREAK_CAP = Number(process.env.ACPTOAPI_AVAILABILITY_SUCCESS_STREAK_CAP) || 30;

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
    if (typeof latencyMs === 'number' && latencyMs >= 0) {
      e.avgLatencyMs = e.avgLatencyMs == null ? latencyMs : (e.avgLatencyMs * (1 - LATENCY_EMA_WEIGHT) + latencyMs * LATENCY_EMA_WEIGHT);
    }
    maybeSave();
    return e;
  }

  function recordFailure(model) {
    const e = entry(model);
    e.ok = false;
    e.failStreak += 1;
    e.successStreak = 0;
    e.totalSamples += 1;
    e.lastFailTs = Date.now();
    maybeSave();
    return e;
  }

  // A "soft" failure: the call succeeded (200/valid response, no fallback
  // triggered -- the caller gets a real answer) but the answer itself looks
  // like a refusal or a suspiciously truncated response. This is DISTINCT
  // from recordFailure: it must never trip sampler.js's per-prefix circuit
  // breaker (a soft refusal is a per-response quality signal, not "the
  // provider is down"), so it does not reset successStreak or bump
  // failStreak -- those remain the pure reliability signal chain-machine.js
  // already uses for hard errors. Instead it demotes future ranking via a
  // small, separately-tracked penalty, so a model that reliably RESPONDS but
  // often refuses/truncates ranks below an equally-reliable model that
  // doesn't, without ever being treated as "down" for circuit-breaking
  // purposes. Witnessed gap (2026-07-30 research pass): a refusal or
  // truncated response currently looks identical to a normal short answer to
  // this tracker -- it just scores as a mediocre-latency success.
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

  function hasNeverSucceededAtScale(e) {
    return !e.lastSuccessTs && e.totalSamples >= NEVER_SUCCEEDED_EXEMPTION_SAMPLE_FLOOR;
  }

  function failureIsStale(e) {
    return e.lastFailTs != null && (Date.now() - e.lastFailTs) > STALE_FAILURE_TTL_MS;
  }

  function effectiveFailStreak(e) {
    if (!e || e.failStreak === 0) return 0;
    if (hasNeverSucceededAtScale(e)) return e.failStreak;
    if (failureIsStale(e)) return 0;
    return e.failStreak;
  }

  function score(model) {
    const e = cache.get(model);
    if (!e || e.totalSamples === 0) return 0;
    const failStreakForScoring = effectiveFailStreak(e);
    const failPenalty = Math.min(failStreakForScoring, 10) * 2;
    const successBonus = e.totalSamples >= MIN_SAMPLES_BEFORE_SUCCESS_BONUS ? Math.min(e.successStreak, SUCCESS_STREAK_CAP) : 0;
    // Soft-failure penalty is deliberately weaker than the hard failPenalty
    // (1 point/occurrence vs 2) -- a refusal/truncation is a real quality
    // signal but a much softer one than an outright error, since the call
    // itself succeeded and the caller did get SOME response.
    const softFailPenalty = e.softFailStreak ? Math.min(e.softFailStreak, SOFT_FAILURE_PENALTY_CAP) : 0;
    if (failPenalty === 0 && successBonus === 0 && softFailPenalty === 0) return 0;
    const streakScore = successBonus - failPenalty - softFailPenalty;
    const latencyPenalty = e.avgLatencyMs == null ? 0 : Math.min(e.avgLatencyMs / 1000, 10);
    return streakScore - latencyPenalty;
  }

  function peek(model) {
    const e = cache.get(model);
    if (!e) return { model, ok: null, successStreak: 0, failStreak: 0, avgLatencyMs: null, lastSuccessTs: null, lastFailTs: null, rank: 0 };
    return { ...e, rank: score(model) };
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

  return { recordSuccess, recordFailure, recordSoftFailure, recordSoftSuccess, score, peek, getAll, rerank, reset, flush };
}

const _singleton = createAvailabilityTracker({ persist: true });

module.exports = {
  createAvailabilityTracker,
  recordSuccess: (m, ms) => _singleton.recordSuccess(m, ms),
  recordFailure: (m) => _singleton.recordFailure(m),
  recordSoftFailure: (m) => _singleton.recordSoftFailure(m),
  recordSoftSuccess: (m) => _singleton.recordSoftSuccess(m),
  score: (m) => _singleton.score(m),
  peek: (m) => _singleton.peek(m),
  getAll: () => _singleton.getAll(),
  rerank: (links, opts) => _singleton.rerank(links, opts),
  reset: (m) => _singleton.reset(m),
  flush: () => _singleton.flush(),
};
