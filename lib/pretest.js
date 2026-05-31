'use strict';
// Idle pretest: periodically warm the auto-chain head model so first-call
// latency on a cold daemon doesn't surface to the user. Off by default;
// enable with ACPTOAPI_PRETEST_ENABLED=1. Interval ACPTOAPI_PRETEST_INTERVAL_MS
// (default 60000). Skipped when a chat is in-flight (busy flag).

const { buildAutoChainLive } = require('./auto-chain');

const ENABLED = process.env.ACPTOAPI_PRETEST_ENABLED === '1';
const INTERVAL = Number(process.env.ACPTOAPI_PRETEST_INTERVAL_MS) || 60000;

let busy = 0;
let timer = null;
const stats = { runs: 0, errors: 0, lastRunAt: 0, lastHead: null, lastChainLen: 0 };

function markBusy() { busy++; }
function markIdle() { busy = Math.max(0, busy - 1); }

async function runOnce() {
  if (busy > 0) return;
  stats.runs++;
  stats.lastRunAt = Date.now();
  try {
    const chain = await buildAutoChainLive();
    stats.lastChainLen = Array.isArray(chain) ? chain.length : 0;
    stats.lastHead = (chain && chain[0] && (chain[0].model || chain[0].id)) || null;
  } catch (e) {
    stats.errors++;
  }
}

function start() {
  if (!ENABLED) return;
  if (timer) return;
  // First run after 5s so cold boot has time to settle.
  setTimeout(runOnce, 5000);
  timer = setInterval(runOnce, INTERVAL);
  if (typeof timer.unref === 'function') timer.unref();
}

function stop() { if (timer) { clearInterval(timer); timer = null; } }
function getStats() { return { ...stats, enabled: ENABLED, interval_ms: INTERVAL, busy }; }

module.exports = { start, stop, markBusy, markIdle, runOnce, getStats };
