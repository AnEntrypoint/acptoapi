const KEY_PATTERNS = [
  /\b(AIza[A-Za-z0-9_-]{20,})/g,
  /\b(sk-[A-Za-z0-9_-]{20,})/g,
  /\b(key-[A-Za-z0-9_-]{20,})/g,
  /((?:api[_-]?key|token|secret|authorization|bearer)[=:\s"']+)([A-Za-z0-9_-]{20,})/gi,
];

function redactKeys(str) {
  if (typeof str !== 'string') return str;
  let result = str;
  result = result.replace(KEY_PATTERNS[0], m => `...${m.slice(-4)}`);
  result = result.replace(KEY_PATTERNS[1], m => `...${m.slice(-4)}`);
  result = result.replace(KEY_PATTERNS[2], m => `...${m.slice(-4)}`);
  result = result.replace(KEY_PATTERNS[3], (_, prefix, val) => `${prefix}...${val.slice(-4)}`);
  return result;
}

class BridgeError extends Error {
  constructor(message, { status, code, retryable = false, provider, headers } = {}) {
    super(redactKeys(message));
    this.name = 'BridgeError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.provider = provider;
    this.headers = headers;
  }
}

class AuthError extends BridgeError {
  constructor(message, opts = {}) {
    super(message, { ...opts, retryable: false });
    this.name = 'AuthError';
  }
}

class RateLimitError extends BridgeError {
  constructor(message, opts = {}) {
    super(message, { ...opts, retryable: true });
    this.name = 'RateLimitError';
  }
}

class TimeoutError extends BridgeError {
  constructor(message, opts = {}) {
    super(message, { ...opts, retryable: true });
    this.name = 'TimeoutError';
  }
}

class ContextWindowError extends BridgeError {
  constructor(message, opts = {}) {
    super(message, { ...opts, retryable: false });
    this.name = 'ContextWindowError';
  }
}

class ContentPolicyError extends BridgeError {
  constructor(message, opts = {}) {
    super(message, { ...opts, retryable: false });
    this.name = 'ContentPolicyError';
  }
}

class ProviderError extends BridgeError {
  constructor(message, opts = {}) {
    super(message, opts);
    this.name = 'ProviderError';
  }
}

const GeminiError = BridgeError;

function classifyError(status, message, provider) {
  const opts = { status, provider };
  const msg = message || '';
  if (status === 401 || status === 403) return new AuthError(msg, opts);
  if (status === 429) return new RateLimitError(msg, opts);
  if (status === 408 || /timeout/i.test(msg)) return new TimeoutError(msg, opts);
  if (status === 413 || /context.?length|token.?limit|too.?long/i.test(msg)) return new ContextWindowError(msg, opts);
  if (status === 451 || /safety|blocked|content.?policy|harmful/i.test(msg)) return new ContentPolicyError(msg, opts);
  if (typeof status === 'number' && status >= 500) return new ProviderError(msg, { ...opts, retryable: true });
  return new BridgeError(msg, { ...opts, retryable: false });
}

function isRetryable(err) {
  if (err instanceof BridgeError) return err.retryable;
  const status = err?.status ?? err?.code;
  if (status === 429) return true;
  if (typeof status === 'number' && status >= 500) return true;
  const msg = err?.message ?? '';
  return /quota|rate.?limit|overloaded|unavailable/i.test(msg);
}

function parseRetryAfterHeader(err) {
  const raw = err?.headers?.get?.('retry-after') ?? err?.retryAfter;
  if (raw == null) return null;
  const secs = Number(raw);
  if (!isNaN(secs) && secs >= 0) return secs * 1000;
  const date = Date.parse(raw);
  if (!isNaN(date)) return Math.max(0, date - Date.now());
  return null;
}

function parseRetryDelay(err) {
  const headerDelay = parseRetryAfterHeader(err);
  if (headerDelay != null) return headerDelay;
  try {
    const body = typeof err.message === 'string' ? JSON.parse(err.message) : err.message;
    const details = body?.error?.details || [];
    const retryInfo = details.find(d => d['@type']?.includes('RetryInfo'));
    if (retryInfo?.retryDelay) {
      const secs = parseFloat(retryInfo.retryDelay);
      if (!isNaN(secs)) return secs * 1000;
    }
  } catch (_) {}
  return null;
}

async function withRetry(fn, maxRetries = 3) {
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === maxRetries) throw err;
      const suggested = parseRetryDelay(err);
      const delay = suggested != null ? suggested + Math.random() * 1000 : Math.min(1000 * 2 ** attempt + Math.random() * 200, 16000);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

module.exports = {
  BridgeError, GeminiError, AuthError, RateLimitError,
  TimeoutError, ContextWindowError, ContentPolicyError,
  ProviderError, classifyError, isRetryable, withRetry, redactKeys
};
