'use strict';

const { buildAutoChainLive } = require('./auto-chain');
const { createPeriodicTask } = require('./periodic-task');

const ENABLED = process.env.ACPTOAPI_PRETEST_ENABLED === '1';
const INTERVAL_MS = Number(process.env.ACPTOAPI_PRETEST_INTERVAL_MS) || 60000;
const COLD_BOOT_DELAY_MS = 5000;

let inFlightCount = 0;
const stats = { runs: 0, errors: 0, lastRunAt: 0, lastHead: null, lastChainLen: 0 };

function markBusy() { inFlightCount++; }
function markIdle() { inFlightCount = Math.max(0, inFlightCount - 1); }

async function runOnce() {
  if (inFlightCount > 0) return;
  stats.runs++;
  stats.lastRunAt = Date.now();
  try {
    const chain = await buildAutoChainLive();
    stats.lastChainLen = Array.isArray(chain) ? chain.length : 0;
    stats.lastHead = (chain && chain[0] && (chain[0].model || chain[0].id)) || null;
  } catch {
    stats.errors++;
  }
}

let periodicPretestTask = null;
function start() {
  if (!ENABLED) return;
  if (!periodicPretestTask) periodicPretestTask = createPeriodicTask(runOnce, INTERVAL_MS);
  setTimeout(() => periodicPretestTask.start(), COLD_BOOT_DELAY_MS).unref?.();
}

function stop() { periodicPretestTask?.stop(); }
function getStats() { return { ...stats, enabled: ENABLED, interval_ms: INTERVAL_MS, busy: inFlightCount }; }

module.exports = { start, stop, markBusy, markIdle, runOnce, getStats };
