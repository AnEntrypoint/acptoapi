'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const MIN_SAMPLES_BEFORE_SUCCESS_BONUS = Number(process.env.ACPTOAPI_AVAILABILITY_MIN_SAMPLES) || 2;
const LATENCY_EMA_WEIGHT = Number(process.env.ACPTOAPI_AVAILABILITY_LATENCY_DECAY) || 0.3;
// Continuous exponential decay of the effective fail streak toward 0 as time
// passes since the last failure, replacing a hard stale/not-stale cutoff.
// A cutoff over/under-compensates at its own edge: a model 1ms past the TTL
// is treated identically to one that failed 1ms ago (a burst-limit blip and
// a genuine 5-strike exhaustion recover on the EXACT same fixed schedule),
// and a model 1ms before the TTL stays fully gated with zero partial credit
// for the time that HAS already passed. Continuous decay gives partial
// credit throughout: effectiveFailStreak = failStreak * exp(-elapsed/halfLife),
// so a model recovers smoothly and a genuinely still-failing model (fresh
// failures keep resetting the elapsed clock) never gets an unearned reprieve.
// Half-life default (30min) means a fail streak is back to ~50% of its
// recorded weight after 30min with no new failure, ~25% after 1hr, etc. --
// continuing indefinitely rather than a binary flip at a single deadline.
const FAILURE_DECAY_HALF_LIFE_MS = Number(process.env.ACPTOAPI_AVAILABILITY_FAILURE_HALF_LIFE_MS) || 1800000;
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

// The latency penalty must scale against the SAME ceiling as SUCCESS_STREAK_CAP
// (both feed the same score sum) -- witnessed live: a 50s-average free model
// with a long success streak (successBonus capped at 30, latencyPenalty
// capped at the OLD 10) scored streakScore(30) - 10 = 20, while a 2s-average
// free model with only 3 successes scored 3 - 2 = 1, so the chain LED with
// the 50x-slower model despite an equally-free, dramatically-faster
// alternative being available and proven. A 10s hard ceiling on the penalty
// (vs. 30 on the bonus) structurally under-weighted latency relative to raw
// success count for exactly the pathological case ("maximum fluidity")
// that matters most: two free models, one fast, one glacially slow, both
// reliable. Raised to match SUCCESS_STREAK_CAP so an extreme outlier
// latency can fully cancel out even a maxed-out success streak, the same
// design intent SUCCESS_STREAK_CAP's own comment states for the bonus side.
const LATENCY_PENALTY_CAP_MS = Number(process.env.ACPTOAPI_AVAILABILITY_LATENCY_PENALTY_CAP_MS) || (SUCCESS_STREAK_CAP * 1000);

// A provider-stated Retry-After can be extreme (a daily/monthly quota reset
// reported in hours, not the burst-limit seconds this mechanism is really
// meant for) -- capping it prevents one such response from gating a model
// far longer than any other recovery path in this file (STALE_FAILURE_TTL_MS
// above is the longest EXISTING window, 1hr default) ever holds a model down
// for. A capped-but-still-long wait still correctly avoids hammering a
// genuinely quota-exhausted model; it just cannot outlast this ceiling.
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
    // A real success proves the provider's earlier Retry-After deadline no
    // longer applies (or the deadline already lapsed and preCheck let this
    // call through) -- clear it explicitly rather than leaving it to lapse
    // on its own, mirroring the failStreak reset just above.
    e.retryNotBeforeTs = null;
    if (typeof latencyMs === 'number' && latencyMs >= 0) {
      e.avgLatencyMs = e.avgLatencyMs == null ? latencyMs : (e.avgLatencyMs * (1 - LATENCY_EMA_WEIGHT) + latencyMs * LATENCY_EMA_WEIGHT);
    }
    maybeSave();
    return e;
  }

  // retryAfterMs, when provided, is the provider's OWN stated wait time (a
  // real 429 Retry-After header or a Gemini-style RetryInfo.retryDelay body
  // detail -- see lib/errors.js's parseRetryDelay, the single parser for
  // both shapes) rather than this tracker's own fixed failStreak-based
  // guess. It sets retryNotBeforeTs, an explicit "do not retry before this
  // exact moment" deadline that isAvailableNow (below) honors ahead of the
  // failStreak heuristic when present -- letting a real rate-limit-reset
  // time (which can be much shorter OR much longer than the fixed 5-strike
  // gate implies) drive recovery instead of a one-size-fits-all guess.
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

  // A real provider-stated deadline is still in effect for this model --
  // distinct from score()'s failStreak-based unhealthy heuristic, which has
  // no notion of an exact recovery time. Called from chain-machine.js's
  // preCheck ahead of the MIN_FAILSTREAK_TO_SKIP_MODEL gate so a model with
  // a genuine, still-live Retry-After is skipped for exactly as long as the
  // provider actually said, not the fixed schedule.
  function isRetryDeadlineActive(model) {
    const e = cache.get(model);
    return !!(e && e.retryNotBeforeTs && e.retryNotBeforeTs > Date.now());
  }

  // A 402/CreditsError ("no payment method") is permanent until the account
  // adds billing -- unlike a transient timeout/rate_limit, it must NOT decay
  // back to healthy the way effectiveFailStreak does (that decay exists so a
  // genuinely-recovered provider climbs back into rotation; a missing
  // payment method never self-heals with the passage of time alone). Tracked
  // per-MODEL, not per-brand/prefix -- a multi-model aggregator brand
  // (witnessed: opencode-zen) can have some models genuinely free/working
  // (nemotron-3-ultra-free) and others 402ing (claude-opus-5, grok-4.6) on
  // the SAME account at the SAME time, so a brand-wide exclusion wrongly
  // took out the working free models alongside the dead paid ones.
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

  // Continuously decayed fail streak: exact integer failStreak scaled down by
  // exp(-elapsed/halfLife) since the last real failure. A model that failed
  // once 5 minutes ago and one that failed 5 times an hour ago can land at
  // similar effective weight even though their raw failStreak differs wildly
  // -- this is the point: raw consecutive-failure count alone conflates
  // "failing right now" with "failed a while back," exactly the over-
  // compensation a fixed-TTL cutoff also got wrong, just with a smooth curve
  // instead of one deadline.
  //
  // Applies to a model that has never once succeeded too -- no exemption from
  // decay by success history. An earlier version of this function exempted
  // that case entirely -- "untested-and-failing should never earn a reprieve
  // purely by elapsed clock time with zero evidence it actually recovered" --
  // but that created a genuine permanent self-heal deadlock: preCheck
  // (chain-machine.js) skips a model BEFORE any HTTP attempt once its
  // effective streak stays at/above MIN_FAILSTREAK_TO_SKIP_MODEL, so a model
  // exempted from decay could never record the one real success that would
  // reset failStreak on its own -- it was never dispatched to in the first
  // place. Live-witnessed (2026-08-26): openrouter/stealth/ox-alpha with
  // failStreak:6, totalSamples:6, lastSuccessTs:null stayed permanently
  // 'unhealthy' after a real key refresh + a confirmed-working direct call to
  // the same model, requiring a manual cache-file edit to unblock. Decaying
  // this case too does not weaken the exemption's original intent of not
  // indefinitely retrying a model that keeps failing: fresh failures
  // continuously reset lastFailTs (recordFailure), so a GENUINELY still-
  // broken model (bad model id, still-bad key) never accumulates decay --
  // only a model that has gone quiet since its last failure earns the
  // reprieve, which is exactly the "quiet for a while" recovery signal this
  // mechanism exists to honor, now smooth rather than a single deadline.
  // Concurrent-burst protection (so N simultaneous callers hitting a newly-
  // recovered-looking model don't all dispatch to a still-broken provider at
  // once) lives in chain-machine.js's preCheck as a single-flight claim, not
  // here -- this function stays a pure read with no side effects, since
  // score()/peek()/this function are read from several independent call
  // sites per request (preCheck itself, snapshotAvailabilityRanks,
  // auto-chain.js's rankLinks) with no coordination between them; a stateful
  // claim living here was tried and reverted after it self-collided the
  // moment more than one of those call sites touched the same model in one
  // request, defeating the very probe it was meant to allow through even for
  // a single non-concurrent caller.
  function effectiveFailStreak(e) {
    if (!e || e.failStreak === 0) return 0;
    if (e.lastFailTs == null) return e.failStreak;
    const elapsedMs = Date.now() - e.lastFailTs;
    if (elapsedMs <= 0) return e.failStreak;
    const decayed = e.failStreak * Math.exp(-elapsedMs / FAILURE_DECAY_HALF_LIFE_MS * Math.LN2);
    // Below 0.05 is indistinguishable from fully recovered for every
    // downstream consumer (failPenalty rounds via Math.min(...,10)*2, and
    // preCheck's gate gates only on values still >= 1) -- treat as exactly 0
    // rather than carrying an ever-shrinking-but-never-zero float forever.
    return decayed < 0.05 ? 0 : decayed;
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
    const latencyPenalty = e.avgLatencyMs == null ? 0 : Math.min(e.avgLatencyMs / 1000, LATENCY_PENALTY_CAP_MS / 1000);
    return streakScore - latencyPenalty;
  }

  function peek(model) {
    const e = cache.get(model);
    if (!e) return { model, ok: null, successStreak: 0, failStreak: 0, effectiveFailStreak: 0, avgLatencyMs: null, lastSuccessTs: null, lastFailTs: null, rank: 0 };
    // effectiveFailStreak is the continuously-decayed value (see the
    // function above) -- callers gating on "is this model currently
    // unhealthy" (chain-machine.js's preCheck) must read THIS field, not the
    // raw failStreak also present on the spread `...e` below, which never
    // decays on its own and previously masked score()'s own recovery signal
    // (a real defect: preCheck gated on raw failStreak >= threshold, which
    // stayed true forever once reached, even after score() had already
    // recovered past the decayed value going back positive).
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
