'use strict';

// Per-model availability tracking, distinct from lib/sampler.js's per-provider-
// prefix circuit breaker. Sampler answers "should we even try this provider
// right now" (backoff gate). This module answers "how healthy has this exact
// model been recently" (positive + negative signal) so chains can be ranked
// by live health instead of a static priority list.

const MIN_SAMPLES_FOR_RANK = 2; // below this, treat as neutral (no data yet)
const LATENCY_DECAY = 0.3; // EMA weight for newest sample

function createAvailabilityTracker() {
  const cache = new Map();

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
    return e;
  }

  function recordFailure(model) {
    const e = entry(model);
    e.ok = false;
    e.failStreak += 1;
    e.successStreak = 0;
    e.totalSamples += 1;
    e.lastFailTs = Date.now();
    return e;
  }

  // Score is higher = better. Neutral (0) for unseen/low-sample models so they
  // are tried in their original position until enough data exists. Score
  // rewards recent success streaks and low latency, penalizes fail streaks.
  // Capped magnitude keeps a long streak from permanently pinning a model.
  function score(model) {
    const e = cache.get(model);
    if (!e || e.totalSamples < MIN_SAMPLES_FOR_RANK) return 0;
    const streakScore = Math.min(e.successStreak, 10) - Math.min(e.failStreak, 10) * 2;
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
  }

  return { recordSuccess, recordFailure, score, peek, getAll, rerank, reset };
}

const _singleton = createAvailabilityTracker();

module.exports = {
  createAvailabilityTracker,
  recordSuccess: (m, ms) => _singleton.recordSuccess(m, ms),
  recordFailure: (m) => _singleton.recordFailure(m),
  score: (m) => _singleton.score(m),
  peek: (m) => _singleton.peek(m),
  getAll: () => _singleton.getAll(),
  rerank: (links, opts) => _singleton.rerank(links, opts),
  reset: (m) => _singleton.reset(m),
};
