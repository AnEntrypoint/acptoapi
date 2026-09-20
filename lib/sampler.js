'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPeriodicTask } = require('./periodic-task');

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
const TIMEOUT_BACKOFF_ESCALATION_MS = [3000, 8000, 15000, 30000];

function createSampler() {
  const cache = new Map();
  const recoveryHistory = loadRecoveryHistory();
  let periodicProbeTask = null;

  function entry(provider) {
    if (!cache.has(provider)) cache.set(provider, { ok: null, failCount: 0, timeoutFailCount: 0, nextCheck: 0 });
    return cache.get(provider);
  }

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
    const now = Date.now();
    return Array.from(cache.entries()).map(([provider, e]) => {
      const inBackoff = e.nextCheck > now;
      return {
        provider,
        ok: inBackoff ? e.ok : true,
        failCount: e.failCount,
        nextCheckIn: inBackoff ? Math.max(0, e.nextCheck - now) : 0,
      };
    });
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
