'use strict';

const { createPeriodicTask } = require('./periodic-task');

const PROVIDER_BACKOFF_ESCALATION_MS = [3000, 8000, 20000, 60000, 180000, 480000];

function createSampler() {
  const cache = new Map();
  let periodicProbeTask = null;

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
    const step = Math.min(e.failCount - 1, PROVIDER_BACKOFF_ESCALATION_MS.length - 1);
    e.nextCheck = Date.now() + PROVIDER_BACKOFF_ESCALATION_MS[step];
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
  markFailed: (p) => _singleton.markFailed(p),
  markOk: (p) => _singleton.markOk(p),
  resetAvailability: (p) => _singleton.resetAvailability(p),
  getStatus: () => _singleton.getStatus(),
  peekStatus: (p, m) => _singleton.peekStatus(p, m),
  probe: (p, fn) => _singleton.probe(p, fn),
  startSampler: (fn, intervalMs) => _singleton.startSampler(fn, intervalMs),
  stopSampler: () => _singleton.stopSampler(),
};
