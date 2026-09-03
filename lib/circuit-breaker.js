function createCircuitBreaker(opts = {}) {
  const maxFailures = opts.maxFailures || 5;
  const cooldownMs = opts.cooldownMs || 60000;
  const state = new Map();

  function getState(name) {
    if (!state.has(name)) state.set(name, { failures: 0, openedAt: 0 });
    return state.get(name);
  }

  function isOpen(name) {
    const s = getState(name);
    if (s.failures < maxFailures) return false;
    // Cooldown elapsed: fully reset to a clean (closed) slate so the breaker is
    // genuinely half-open again. The previous code left failures pinned AT
    // maxFailures, so a single later failure immediately re-opened and the
    // breaker never truly recovered. Reset here so recovery is real.
    if (Date.now() - s.openedAt >= cooldownMs) {
      s.failures = 0;
      s.openedAt = 0;
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
    const s = getState(name);
    s.failures = 0;
    s.openedAt = 0;
  }

  return { isOpen, recordFailure, recordSuccess };
}

module.exports = { createCircuitBreaker };
