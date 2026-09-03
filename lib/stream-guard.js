const { TimeoutError, BridgeError } = require('./errors');

async function* guardStream(iterable, opts = {}) {
  const timeoutMs = opts?.chunkTimeoutMs ?? 30000;
  const maxRepeats = opts?.maxRepeats ?? 100;
  let lastChunk = null;
  let repeatCount = 0;
  for await (const chunk of raceTimeout(iterable, timeoutMs)) {
    const key = JSON.stringify(chunk);
    if (key === lastChunk && key !== '{}' && key !== 'null') {
      repeatCount++;
      if (repeatCount >= maxRepeats) {
        throw new BridgeError(`Same chunk repeated ${maxRepeats} times`, { retryable: false });
      }
    } else {
      lastChunk = key;
      repeatCount = 1;
    }
    yield chunk;
  }
}

async function* raceTimeout(iterable, ms) {
  const iter = iterable[Symbol.asyncIterator]();
  while (true) {
    const result = await Promise.race([
      iter.next(),
      new Promise((_, reject) => setTimeout(() => reject(new TimeoutError(`Stream chunk timeout after ${ms}ms`)), ms))
    ]);
    if (result.done) return;
    yield result.value;
  }
}

module.exports = { guardStream };
