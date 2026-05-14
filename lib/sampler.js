'use strict';

const BACKOFF_STEPS_MS = [30000, 60000, 120000, 240000, 480000];

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
    interval = setInterval(async () => {
      const probes = getProbes();
      await Promise.allSettled(probes.map(({ provider, call }) => {
        const e = entry(provider);
        if (e.nextCheck > Date.now()) return Promise.resolve();
        return probe(provider, call);
      }));
    }, intervalMs);
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
