'use strict';

// FIRST-STRIKE BACKOFF TOO LONG, fixed here: a single failure on ANY model
// under a provider prefix used to back off the WHOLE provider (every other
// model sharing that prefix) for 30s minimum. Live-witnessed: one turn's own
// bounded ~23s retry walk backed off 2-3 real providers early (a genuine but
// transient rate_limit/timeout on one specific model), which then removed
// most of the chain's remaining diversity for the REST of that SAME turn's
// own fallback attempts -- a turn that should have found a healthy model
// among 12 candidates instead exhausted the chain to a hard failure, because
// its own earlier retries had backed off the providers it needed later.
// Escalating steps starting well under the retry loop's own attempt spacing
// means a lone transient hit barely dents availability for the rest of THIS
// turn, while a genuinely repeated failure pattern (failCount climbing) still
// reaches the same long backoffs as before -- "sustained, not one bad roll"
// is the standing discipline this codebase already applies elsewhere
// (MIN_SAMPLES_FOR_DEGRADED, MIN_FAILSTREAK_TO_SKIP); this was the one place
// still tripping hard on failure #1.
const BACKOFF_STEPS_MS = [3000, 8000, 20000, 60000, 180000, 480000];

function createSampler() {
  const cache = new Map();
  let interval = null;

  function entry(provider) {
    if (!cache.has(provider)) cache.set(provider, { ok: null, failCount: 0, nextCheck: 0 });
    return cache.get(provider);
  }

  function isAvailable(provider) {
    const e = entry(provider);
    if (e.nextCheck > Date.now()) return e.ok !== false;
    return true;
  }

  function markFailed(provider) {
    const e = entry(provider);
    e.ok = false;
    e.failCount = (e.failCount || 0) + 1;
    e.lastFailedAt = Date.now();
    const step = Math.min(e.failCount - 1, BACKOFF_STEPS_MS.length - 1);
    e.nextCheck = Date.now() + BACKOFF_STEPS_MS[step];
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
    e.ok = true;
    e.failCount = 0;
    e.nextCheck = 0;
    // Clear the failure timestamp on recovery; otherwise peekStatus reports a
    // healthy provider (ok=true) alongside a stale lastFailedAt, which reads as
    // "just failed" and confuses health consumers.
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
    if (interval) return;
    const runProbes = async () => {
      const probes = getProbes();
      await Promise.allSettled(probes.map(({ provider, call }) => {
        const e = entry(provider);
        if (e.nextCheck > Date.now()) return Promise.resolve();
        return probe(provider, call);
      }));
    };
    runProbes().catch(() => {}); // Run immediately on startup
    interval = setInterval(runProbes, intervalMs);
    if (interval.unref) interval.unref();
  }

  function stopSampler() {
    if (interval) { clearInterval(interval); interval = null; }
  }

  return { isAvailable, markFailed, markOk, resetAvailability, getStatus, peekStatus, probe, startSampler, stopSampler };
}

const _singleton = createSampler();

module.exports = {
  createSampler,
  isAvailable: (p) => _singleton.isAvailable(p),
  markFailed: (p) => _singleton.markFailed(p),
  markOk: (p) => _singleton.markOk(p),
  resetAvailability: (p) => _singleton.resetAvailability(p),
  getStatus: () => _singleton.getStatus(),
  peekStatus: (p, m) => _singleton.peekStatus(p, m),
  probe: (p, fn) => _singleton.probe(p, fn),
  startSampler: (fn, intervalMs) => _singleton.startSampler(fn, intervalMs),
  stopSampler: () => _singleton.stopSampler(),
};
