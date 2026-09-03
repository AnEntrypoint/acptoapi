'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPeriodicTask } = require('./periodic-task');

// Per-user direction: "devise its dynamic rate limit according to the
// lowest average that works over time" -- the fixed PROVIDER_BACKOFF_
// ESCALATION_MS/TIMEOUT_BACKOFF_ESCALATION_MS schedules below are a safety-
// net UPPER bound for a provider with no observed-recovery history yet, not
// the actual wait time once real data exists. Every time a provider that was
// in backoff succeeds again, the ELAPSED time since its failure (the real,
// empirically-observed recovery duration) is recorded; RECOVERY_HISTORY_SIZE
// most-recent observations are kept per provider and their MINIMUM becomes
// this provider's own learned floor -- markFailed then uses
// min(fixedScheduleStep, learnedFloor) so a provider that reliably recovers
// in 4s (measured) stops waiting the fixed schedule's 8s/20s/60s escalation
// once enough evidence exists, converging toward the lowest wait that
// actually works rather than a one-size-fits-all guess. The minimum (not the
// mean) is used deliberately: any recorded recovery that was fast enough to
// succeed is proof a shorter wait than the fixed schedule already works for
// this provider; a single fast observation should not be diluted upward by
// slower ones a few real successes will still coexist with. Never applied
// below MIN_LEARNED_BACKOFF_MS so a flappy provider recovering in <1s doesn't
// get hammered every tick.
const RECOVERY_HISTORY_SIZE = 8;
const MIN_LEARNED_BACKOFF_MS = 500;
const RECOVERY_HISTORY_PATH = process.env.ACPTOAPI_SAMPLER_RECOVERY_CACHE_PATH || path.join(os.homedir(), '.acptoapi', 'sampler-recovery-cache.json');
const RECOVERY_PERSIST = process.env.ACPTOAPI_SAMPLER_RECOVERY_PERSIST !== '0';

function loadRecoveryHistory() {
  if (!RECOVERY_PERSIST) return new Map();
  try {
    const raw = JSON.parse(fs.readFileSync(RECOVERY_HISTORY_PATH, 'utf8'));
    return new Map(Object.entries(raw).map(([k, v]) => [k, Array.isArray(v) ? v : []]));
  } catch {
    return new Map();
  }
}

function saveRecoveryHistory(recoveryHistory) {
  if (!RECOVERY_PERSIST) return;
  try {
    fs.mkdirSync(path.dirname(RECOVERY_HISTORY_PATH), { recursive: true });
    const obj = Object.fromEntries(recoveryHistory.entries());
    const tmp = RECOVERY_HISTORY_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, RECOVERY_HISTORY_PATH);
  } catch {}
}

const PROVIDER_BACKOFF_ESCALATION_MS = [3000, 8000, 20000, 60000, 180000, 480000];
// A 'timeout' means "this one response was slow," not "this provider is
// broken" -- a heavy prompt (large tool-result context) can legitimately
// exceed the chain's per-link timeout on an otherwise-healthy provider.
// Treating it identically to a genuine connectivity/auth failure (the same
// escalating-to-8-minute schedule above) means one slow response demotes a
// provider for far longer than the slowness itself justifies. A SEPARATE,
// much shorter, low-ceiling schedule for timeout-only failures: a single
// timeout backs off for 3s (barely noticeable), repeated CONSECUTIVE
// timeouts escalate mildly but cap at 30s rather than 8 minutes -- still a
// real penalty for a provider that keeps timing out, just proportionate to
// what a slow-but-alive provider actually costs the user (one retry cycle),
// not what a dead one does.
const TIMEOUT_BACKOFF_ESCALATION_MS = [3000, 8000, 15000, 30000];

function createSampler() {
  const cache = new Map();
  const recoveryHistory = loadRecoveryHistory();
  let periodicProbeTask = null;

  function entry(provider) {
    if (!cache.has(provider)) cache.set(provider, { ok: null, failCount: 0, timeoutFailCount: 0, nextCheck: 0 });
    return cache.get(provider);
  }

  // The learned floor for THIS provider: the minimum of its recent observed
  // recovery times (see the module-level comment above for why minimum, not
  // mean). Returns Infinity (never wins the min() against the fixed
  // schedule) when there's no history yet -- a provider needs at least one
  // real observed recovery before its own data can override the safety-net
  // schedule.
  function learnedFloorMs(provider) {
    const hist = recoveryHistory.get(provider);
    if (!hist || !hist.length) return Infinity;
    return Math.max(MIN_LEARNED_BACKOFF_MS, Math.min(...hist));
  }

  function recordObservedRecovery(provider, recoveryMs) {
    if (!(recoveryMs > 0)) return;
    const hist = recoveryHistory.get(provider) || [];
    hist.push(recoveryMs);
    if (hist.length > RECOVERY_HISTORY_SIZE) hist.shift();
    recoveryHistory.set(provider, hist);
    saveRecoveryHistory(recoveryHistory);
  }

  function isAvailable(provider) {
    const e = entry(provider);
    if (e.nextCheck > Date.now()) return e.ok !== false;
    return true;
  }

  // reason (optional): when 'timeout', uses the short TIMEOUT_BACKOFF_
  // ESCALATION_MS schedule and its own separate timeoutFailCount counter
  // instead of the long-tail escalation used for every other failure
  // reason (fetch_failed/auth/error/empty/rate_limit) -- a run of
  // genuine connectivity failures still escalates to the full 8-minute
  // ceiling, a run of mere timeouts caps at 30s. The two counters are
  // independent: a provider that times out once then genuinely errors
  // once is NOT treated as "2 real failures" on the long schedule, nor
  // does a real error's markOk-reset (see markOk below) get confused
  // with a timeout-only recovery.
  //
  // The fixed schedule step is the safety-net ceiling; learnedFloorMs
  // (this provider's own observed-recovery history) can only ever shorten
  // it, never lengthen it -- a provider with no history yet gets exactly
  // today's fixed-schedule behavior.
  function markFailed(provider, reason) {
    const e = entry(provider);
    e.ok = false;
    e.lastFailedAt = Date.now();
    const floor = learnedFloorMs(provider);
    if (reason === 'timeout') {
      e.timeoutFailCount = (e.timeoutFailCount || 0) + 1;
      const step = Math.min(e.timeoutFailCount - 1, TIMEOUT_BACKOFF_ESCALATION_MS.length - 1);
      e.nextCheck = Date.now() + Math.min(TIMEOUT_BACKOFF_ESCALATION_MS[step], floor);
      return;
    }
    e.failCount = (e.failCount || 0) + 1;
    const step = Math.min(e.failCount - 1, PROVIDER_BACKOFF_ESCALATION_MS.length - 1);
    e.nextCheck = Date.now() + Math.min(PROVIDER_BACKOFF_ESCALATION_MS[step], floor);
  }

  function peekStatus(provider, _model) {
    const e = entry(provider);
    const inBackoff = e.nextCheck > Date.now();
    return {
      available: inBackoff ? (e.ok !== false) : true,
      lastFailedAt: e.lastFailedAt || null,
      nextRetryAt: inBackoff ? e.nextCheck : null,
      failCount: e.failCount || 0,
    };
  }

  function markOk(provider) {
    const e = entry(provider);
    // A success while genuinely still in backoff (e.g. this same-provider's
    // lead-link precheck wait retried early and the real upstream had
    // already recovered) is real, directly-usable evidence: the elapsed
    // time since the failure that triggered THIS backoff window is exactly
    // the recovery duration this provider needed. A success outside any
    // backoff window (the common case -- most calls never fail at all)
    // carries no such signal and is not recorded.
    if (e.lastFailedAt && e.nextCheck > 0) {
      recordObservedRecovery(provider, Date.now() - e.lastFailedAt);
    }
    e.ok = true;
    e.failCount = 0;
    e.timeoutFailCount = 0;
    e.nextCheck = 0;
    e.lastFailedAt = null;
  }

  function resetAvailability(provider) {
    cache.delete(provider);
  }

  function getStatus() {
    return Array.from(cache.entries()).map(([provider, e]) => ({
      provider,
      ok: e.ok,
      failCount: e.failCount,
      nextCheckIn: Math.max(0, e.nextCheck - Date.now()),
    }));
  }

  async function probe(provider, probeCall) {
    try {
      await probeCall();
      markOk(provider);
      return true;
    } catch {
      markFailed(provider);
      return false;
    }
  }

  function startSampler(getProbes, intervalMs = 3600000) {
    if (periodicProbeTask) return;
    periodicProbeTask = createPeriodicTask(async () => {
      const probes = getProbes();
      await Promise.allSettled(probes.map(({ provider, call }) => {
        const e = entry(provider);
        if (e.nextCheck > Date.now()) return Promise.resolve();
        return probe(provider, call);
      }));
    }, intervalMs);
    periodicProbeTask.start();
  }

  function stopSampler() {
    periodicProbeTask?.stop();
    periodicProbeTask = null;
  }

  return { isAvailable, markFailed, markOk, resetAvailability, getStatus, peekStatus, probe, startSampler, stopSampler };
}

const _singleton = createSampler();

module.exports = {
  createSampler,
  isAvailable: (p) => _singleton.isAvailable(p),
  markFailed: (p, reason) => _singleton.markFailed(p, reason),
  markOk: (p) => _singleton.markOk(p),
  resetAvailability: (p) => _singleton.resetAvailability(p),
  getStatus: () => _singleton.getStatus(),
  peekStatus: (p, m) => _singleton.peekStatus(p, m),
  probe: (p, fn) => _singleton.probe(p, fn),
  startSampler: (fn, intervalMs) => _singleton.startSampler(fn, intervalMs),
  stopSampler: () => _singleton.stopSampler(),
};
