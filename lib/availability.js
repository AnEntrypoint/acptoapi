'use strict';

// Per-model availability tracking, distinct from lib/sampler.js's per-provider-
// prefix circuit breaker. Sampler answers "should we even try this provider
// right now" (backoff gate). This module answers "how healthy has this exact
// model been recently" (positive + negative signal) so chains can be ranked
// by live health instead of a static priority list.

const fs = require('fs');
const path = require('path');
const os = require('os');

const MIN_SAMPLES_FOR_RANK = Number(process.env.ACPTOAPI_AVAILABILITY_MIN_SAMPLES) || 2; // below this, success-based promotion is neutral (no data yet)
const LATENCY_DECAY = Number(process.env.ACPTOAPI_AVAILABILITY_LATENCY_DECAY) || 0.3; // EMA weight for newest sample

const PERSIST_ENABLED = process.env.ACPTOAPI_AVAILABILITY_PERSIST !== '0';
const CACHE_PATH = process.env.ACPTOAPI_AVAILABILITY_CACHE_PATH || path.join(os.homedir(), '.acptoapi', 'availability-cache.json');
const SAVE_EVERY_N_RECORDS = 10; // mirrors model-probe-live's "save on write" pattern, but batched to
// avoid a disk write on every single chat completion (recordSuccess/recordFailure fire per-link,
// per-request - saving on every call would mean one fsync per LLM call under load). Batching by
// count (rather than a setInterval/TTL like model-probe-live) is simpler here because there is no
// natural polling cadence to hook into - just plain counter mutations - and it guarantees a bounded
// worst-case data loss window (<=9 records) without needing a timer to manage/unref/clear.

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
      e.avgLatencyMs = e.avgLatencyMs == null ? latencyMs : (e.avgLatencyMs * (1 - LATENCY_DECAY) + latencyMs * LATENCY_DECAY);
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

  // Score is higher = better. Neutral (0) for truly unseen models (totalSamples
  // === 0) so they are tried in their original position until any data exists.
  // Asymmetric threshold: a single CONFIRMED failure is more informative than
  // staying neutral - a model that just failed once is a worse bet than an
  // untested one - so failure-based penalty applies as soon as failStreak >= 1,
  // regardless of totalSamples. Success-based promotion is the opposite: one
  // success could be luck, so the positive streakScore contribution still
  // requires totalSamples >= MIN_SAMPLES_FOR_RANK before a model is boosted
  // ahead of untested peers. Capped magnitude keeps a long streak from
  // permanently pinning a model.
  function score(model) {
    const e = cache.get(model);
    if (!e || e.totalSamples === 0) return 0;
    const failPenalty = Math.min(e.failStreak, 10) * 2;
    const successBonus = e.totalSamples >= MIN_SAMPLES_FOR_RANK ? Math.min(e.successStreak, 10) : 0;
    if (failPenalty === 0 && successBonus === 0) return 0;
    const streakScore = successBonus - failPenalty;
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

  // Stable re-rank: higher score sorts earlier, ties keep original order.
  // Models with equal (including neutral 0) score are NOT reordered relative
  // to each other, so a chain with no data yet is unchanged from its input order.
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

  // Force an immediate flush regardless of the batch counter (e.g. on graceful shutdown).
  function flush() {
    if (persist) saveCacheFile(cache);
  }

  return { recordSuccess, recordFailure, score, peek, getAll, rerank, reset, flush };
}

const _singleton = createAvailabilityTracker({ persist: true });

module.exports = {
  createAvailabilityTracker,
  recordSuccess: (m, ms) => _singleton.recordSuccess(m, ms),
  recordFailure: (m) => _singleton.recordFailure(m),
  score: (m) => _singleton.score(m),
  peek: (m) => _singleton.peek(m),
  getAll: () => _singleton.getAll(),
  rerank: (links, opts) => _singleton.rerank(links, opts),
  reset: (m) => _singleton.reset(m),
  flush: () => _singleton.flush(),
};
