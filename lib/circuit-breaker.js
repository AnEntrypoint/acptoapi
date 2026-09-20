function createCircuitBreaker(opts = {}) {
  const maxFailures = opts.maxFailures || 5;
  const cooldownMs = opts.cooldownMs || 60000;
  const state = new Map();

  function getState(name) {
    if (!state.has(name)) state.set(name, { failures: 0, openedAt: 0 });
    return state.get(name);
  }

  function resetToClosed(s) {
    s.failures = 0;
    s.openedAt = 0;
  }

  function isOpen(name) {
    const s = getState(name);
    if (s.failures < maxFailures) return false;
    if (Date.now() - s.openedAt >= cooldownMs) {
      resetToClosed(s);
      return false;
    }
    return true;
  }

  function recordFailure(name) {
    const s = getState(name);
    s.failures++;
    if (s.failures >= maxFailures) s.openedAt = Date.now();
  }

  function recordSuccess(name) {
    resetToClosed(getState(name));
  }

  return { isOpen, recordFailure, recordSuccess };
}

module.exports = { createCircuitBreaker };
