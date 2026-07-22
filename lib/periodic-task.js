'use strict';

function createPeriodicTask(runOnce, intervalMs) {
  let timer = null;
  let running = false;

  const tickOnceGuarded = () => {
    if (running) return;
    running = true;
    Promise.resolve().then(runOnce).catch(() => {}).finally(() => { running = false; });
  };

  function start() {
    if (timer) return;
    tickOnceGuarded();
    timer = setInterval(tickOnceGuarded, intervalMs);
    timer.unref?.();
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  function isRunning() { return timer != null; }

  return { start, stop, isRunning, runNow: tickOnceGuarded };
}

module.exports = { createPeriodicTask };
