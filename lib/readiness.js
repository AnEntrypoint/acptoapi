'use strict';

const availability = require('./availability');
const sampler = require('./sampler');
const { createPeriodicTask } = require('./periodic-task');

const N = (name, def) => Number(process.env[name]) || def;
const CONF = {
  intervalMs: () => N('ACPTOAPI_READINESS_INTERVAL_MS', 120000),
  freshMs: () => N('ACPTOAPI_READINESS_FRESH_MS', 90000),
  topK: () => N('ACPTOAPI_READINESS_TOPK', 10),
  maxPerProvider: () => N('ACPTOAPI_READINESS_MAX_PER_PROVIDER', 2),
  probeTimeoutMs: () => N('ACPTOAPI_READINESS_PROBE_TIMEOUT_MS', 8000),
  spacingMs: () => N('ACPTOAPI_READINESS_SPACING_MS', 200),
};

const lastActiveProbeByModel = new Map();

const registeredSteadyStateCandidates = new Set();
function registerCandidates(models) {
  for (const m of (Array.isArray(models) ? models : [models])) {
    const model = typeof m === 'string' ? m : (m && m.model);
    if (model) registeredSteadyStateCandidates.add(model);
  }
}

function prefixOf(model) {
  const i = model.indexOf('/');
  return i > 0 ? model.slice(0, i) : model;
}

// See chain-machine.js's markProviderFailed/isAggregatorPrefix comment: a
// multi-model aggregator prefix is not "one backend" the way a real
// single-backend provider is, so a single readiness-probed model's own
// success/failure must not mark (or clear) prefix-wide sampler state that
// would otherwise wrongly affect its unrelated siblings. Lazy require avoids
// a load-order/circular-require risk with extra-providers.js.
function isAggregatorPrefix(provider) {
  try {
    return require('./extra-providers').isMultiModelPrefix(provider);
  } catch {
    return false;
  }
}

function isRecentlyVerified(model, now, freshMs) {
  const activeProbe = lastActiveProbeByModel.get(model);
  if (activeProbe && now - activeProbe.ts < freshMs) return true;
  const traffic = availability.peek(model);
  const lastRealTrafficTs = Math.max(traffic.lastSuccessTs || 0, traffic.lastFailTs || 0);
  return lastRealTrafficTs > 0 && now - lastRealTrafficTs < freshMs;
}

function deriveCandidates(topK, maxPerProvider, toolModes = [false, true]) {
  const seenCountByProvider = new Map();
  const out = [];
  const seenModel = new Set();
  const tryAdd = (model) => {
    if (!model || seenModel.has(model) || out.length >= topK) return;
    const provider = prefixOf(model);
    const seenForProvider = seenCountByProvider.get(provider) || 0;
    if (seenForProvider >= maxPerProvider) return;
    seenCountByProvider.set(provider, seenForProvider + 1);
    seenModel.add(model);
    out.push(model);
  };

  for (const model of registeredSteadyStateCandidates) {
    if (out.length >= topK) break;
    tryAdd(model);
  }

  for (const hasTools of toolModes) {
    if (out.length >= topK) break;
    let links = [];
    try { links = require('./auto-chain').buildAutoChain('auto', { hasTools }) || []; } catch { links = []; }
    for (const link of links) {
      if (out.length >= topK) break;
      tryAdd(typeof link === 'string' ? link : link.model);
    }
  }

  return out;
}

async function probeOne(model) {
  const startedAt = Date.now();
  let sdk;
  try { sdk = require('./sdk'); } catch { return { model, ok: false, reason: 'no_sdk' }; }
  const provider = prefixOf(model);

  let timeoutHandle;
  const timeoutRejection = new Promise((_, reject) => {
    timeoutHandle = setTimeout(() => reject(new Error('readiness probe timeout')), CONF.probeTimeoutMs());
  });

  try {
    await Promise.race([
      sdk.chat({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, output: 'openai' }),
      timeoutRejection,
    ]);
    const latencyMs = Date.now() - startedAt;
    availability.recordSuccess(model, latencyMs);
    lastActiveProbeByModel.set(model, { ts: Date.now(), ok: true, latencyMs });
    if (!isAggregatorPrefix(provider)) { try { sampler.markOk(provider); } catch {} }
    return { model, ok: true, latencyMs };
  } catch (e) {
    availability.recordFailure(model);
    lastActiveProbeByModel.set(model, { ts: Date.now(), ok: false, latencyMs: Date.now() - startedAt });
    if (!isAggregatorPrefix(provider)) { try { sampler.markFailed(provider); } catch {} }
    return { model, ok: false, reason: (e && e.message ? String(e.message).slice(0, 120) : 'error') };
  } finally {
    clearTimeout(timeoutHandle);
  }
}

function deterministicJitterFraction(model) {
  let hash = 0;
  for (let i = 0; i < model.length; i++) hash = (hash * 31 + model.charCodeAt(i)) & 0xffff;
  return (hash % 100) / 100;
}

async function runOnce() {
  const now = Date.now();
  const topK = CONF.topK();
  const maxPerProvider = CONF.maxPerProvider();
  const freshMs = CONF.freshMs();
  const spacingMs = CONF.spacingMs();

  try { await require('./brand-catalog').refreshAll({ force: false }); } catch {}

  const candidates = deriveCandidates(topK, maxPerProvider);
  const results = [];
  for (const model of candidates) {
    if (isRecentlyVerified(model, now, freshMs)) {
      results.push({ model, ok: null, reason: 'fresh_skip' });
      continue;
    }
    results.push(await probeOne(model));
    if (spacingMs > 0) {
      const jitteredDelay = spacingMs + Math.floor(spacingMs * deterministicJitterFraction(model));
      await new Promise(resolve => setTimeout(resolve, jitteredDelay));
    }
  }
  return results;
}

let periodicReadinessTask = null;
function start() {
  if (!periodicReadinessTask) periodicReadinessTask = createPeriodicTask(runOnce, CONF.intervalMs());
  periodicReadinessTask.start();
}
function stop() { periodicReadinessTask?.stop(); }

function peek() {
  const topK = CONF.topK();
  const maxPerProvider = CONF.maxPerProvider();
  const freshMs = CONF.freshMs();
  const now = Date.now();
  return deriveCandidates(topK, maxPerProvider).map((model) => {
    const activeProbe = lastActiveProbeByModel.get(model) || {};
    const traffic = availability.peek(model);
    const lastProbeTs = activeProbe.ts || null;
    return {
      model,
      lastProbeTs,
      ok: activeProbe.ok != null ? activeProbe.ok : traffic.ok,
      latencyMs: activeProbe.latencyMs != null ? activeProbe.latencyMs : traffic.avgLatencyMs,
      rank: traffic.rank,
      fresh: isRecentlyVerified(model, now, freshMs),
      nextProbeInMs: lastProbeTs ? Math.max(0, freshMs - (now - lastProbeTs)) : 0,
    };
  });
}

module.exports = {
  start, stop, runOnce, probeOne, peek, deriveCandidates,
  isFresh: isRecentlyVerified, registerCandidates,
  _lastProbe: lastActiveProbeByModel,
};
