'use strict';

// Preemptive readiness prober.
//
// The chain-fallback machinery is REACTIVE: on a real request, buildAutoChain's
// lead link is a best-guess (SWE-bench score + whatever availability signal
// happens to exist), and if that lead is actually down/rate-limited the request
// pays the full fallback walk (witnessed: /v1/messages walking glm-5 -> 404,
// gpt-oss-20b -> empty, gemma-4-31b -> payment_required, DeepSeek-V3.1 -> ok,
// ~5.8s). This module makes selection PREEMPTIVE: it periodically sends a real,
// minimal (1-token) request to the TOP-K candidates of the current auto-chain,
// records the outcome+latency into lib/availability.js, so by the time a user
// request arrives the chain already LEADS with a recently-verified live model
// and per-request fallback time approaches zero.
//
// Distinct from the two existing background mechanisms:
//   - lib/sampler.js is a per-PROVIDER-PREFIX circuit breaker; its brand probes
//     are hollow (`Promise.resolve()` env-key checks, buildModelProbes in
//     server.js), so it never learns whether a specific model actually responds.
//   - the boot-probe (server.js) is a one-shot getAvailableModelsLive pass.
// This is a continuous, per-MODEL, real-request readiness signal that feeds the
// same availability score the chain already ranks on.
//
// Budget discipline (the "without wasting limits" half of the ask):
//   - only the top-K chain candidates are probed, re-derived each cycle so
//     promotions/demotions are tracked (smart-mapped, not all 700 models);
//   - a candidate whose availability data is still FRESH is skipped (real user
//     traffic already records success/failure per link, so live traffic IS a
//     readiness signal we defer to -- we never spend a probe duplicating what
//     traffic just proved);
//   - a provider already in sampler backoff is skipped (don't probe a known-down
//     provider);
//   - per-provider max probes per cycle + jittered spacing bound the burst.

const availability = require('./availability');
const sampler = require('./sampler');

const N = (name, def) => Number(process.env[name]) || def;
const CONF = {
  intervalMs: () => N('ACPTOAPI_READINESS_INTERVAL_MS', 120000),   // re-probe cadence: 2min
  freshMs: () => N('ACPTOAPI_READINESS_FRESH_MS', 90000),          // a model verified within this window is skipped
  topK: () => N('ACPTOAPI_READINESS_TOPK', 5),                     // how many chain-lead candidates to keep hot
  maxPerProvider: () => N('ACPTOAPI_READINESS_MAX_PER_PROVIDER', 2),
  probeTimeoutMs: () => N('ACPTOAPI_READINESS_PROBE_TIMEOUT_MS', 8000),
  spacingMs: () => N('ACPTOAPI_READINESS_SPACING_MS', 200),        // base jittered gap between probes
};

// Per-model last-probe bookkeeping, distinct from availability's cache: this
// tracks when WE last actively probed a model (for the observability endpoint
// and fresh-skip), independent of real-traffic recordSuccess calls.
const _lastProbe = new Map(); // model -> { ts, ok, latencyMs }
let _interval = null;
let _running = false;

function prefixOf(model) {
  const i = model.indexOf('/');
  return i > 0 ? model.slice(0, i) : model;
}

// A model is "fresh" (skip active probing) when EITHER our own last probe OR
// availability's last real-traffic success/failure landed within freshMs. This
// is the anti-waste rule: real user traffic already exercised the model, so we
// don't burn a probe re-confirming it.
function isFresh(model, now, freshMs) {
  const p = _lastProbe.get(model);
  if (p && now - p.ts < freshMs) return true;
  const a = availability.peek(model);
  const lastReal = Math.max(a.lastSuccessTs || 0, a.lastFailTs || 0);
  if (lastReal && now - lastReal < freshMs) return true;
  return false;
}

// Derive the candidate set to keep hot: the top-K links of the CURRENT auto-chain
// (the models a real request would actually try first), capped per provider so
// one brand's models don't consume the whole readiness budget. Lazy-require
// auto-chain to avoid a load-order cycle (auto-chain -> availability -> ... ).
function deriveCandidates(topK, maxPerProvider) {
  let links = [];
  try {
    const { buildAutoChain } = require('./auto-chain');
    links = buildAutoChain('auto') || [];
  } catch {
    return [];
  }
  const perProvider = new Map();
  const out = [];
  for (const link of links) {
    const model = typeof link === 'string' ? link : link.model;
    if (!model) continue;
    const pfx = prefixOf(model);
    const seen = perProvider.get(pfx) || 0;
    if (seen >= maxPerProvider) continue;
    perProvider.set(pfx, seen + 1);
    out.push(model);
    if (out.length >= topK) break;
  }
  return out;
}

// Probe ONE model with a real 1-token request via the SDK's single-model path
// (reuses every provider's real routing/keyring, so a "ready" verdict genuinely
// means the model responds). Never throws; records into availability +
// _lastProbe AND sampler -- a proactive discovery that a provider is down
// must feed the SAME pre-emptive circuit breaker a real chain walk consults
// via chain-machine.js's preCheck(), otherwise this probe's findings are
// invisible to actual chat/chatChain routing decisions (the whole point of
// "preemptive" readiness: know a provider is bad BEFORE a real user turn
// walks into it, not just record data nothing else reads).
async function probeOne(model) {
  const started = Date.now();
  let sdk;
  try { sdk = require('./sdk'); } catch { return { model, ok: false, reason: 'no_sdk' }; }
  const pfx = prefixOf(model);

  // Timeout via Promise.race, NOT a `signal` field on the sdk.chat opts -- an
  // AbortController signal threaded into sdk.chat leaks into the provider
  // request body, which most OpenAI-compat brands reject with 400 "property
  // 'signal' is unsupported" (witnessed against nvidia/groq/cerebras). The
  // race just stops us WAITING past the timeout; the underlying fetch is left
  // to settle on its own (a stray extra token is cheaper than a corrupted body).
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('readiness probe timeout')), CONF.probeTimeoutMs()); });
  try {
    await Promise.race([
      sdk.chat({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1, output: 'openai' }),
      timeout,
    ]);
    const latencyMs = Date.now() - started;
    // Any non-throwing completion is a readiness success (we don't require
    // specific content -- the endpoint responded, which is what "ready" means).
    availability.recordSuccess(model, latencyMs);
    _lastProbe.set(model, { ts: Date.now(), ok: true, latencyMs });
    try { sampler.markOk(pfx) } catch { /* never let sampler bookkeeping fail a probe */ }
    return { model, ok: true, latencyMs };
  } catch (e) {
    availability.recordFailure(model);
    _lastProbe.set(model, { ts: Date.now(), ok: false, latencyMs: Date.now() - started });
    // A readiness-probe failure is real provider-health signal, same class as
    // chain-machine.js's own PROVIDER_HEALTH_REASONS (error/timeout/rate_limit/
    // auth/fetch_failed/empty) -- content_policy is the one exception there,
    // but a 1-token "hi" probe can't trigger a content-policy refusal, so
    // every failure here is unconditionally provider-health-worthy.
    try { sampler.markFailed(pfx) } catch { /* never let sampler bookkeeping fail a probe */ }
    return { model, ok: false, reason: (e && e.message ? String(e.message).slice(0, 120) : 'error') };
  } finally {
    clearTimeout(timer);
  }
}

// Run one readiness pass: derive candidates, skip fresh/backed-off ones, probe
// the rest with jittered spacing. Returns the per-model results (also used by
// the boot warm-up and any manual trigger). Never throws.
async function runOnce() {
  const now = Date.now();
  const topK = CONF.topK();
  const maxPerProvider = CONF.maxPerProvider();
  const freshMs = CONF.freshMs();
  const spacing = CONF.spacingMs();

  const candidates = deriveCandidates(topK, maxPerProvider);
  const results = [];
  for (const model of candidates) {
    if (isFresh(model, now, freshMs)) { results.push({ model, ok: null, reason: 'fresh_skip' }); continue; }
    // Don't probe a provider the sampler has circuit-broken -- it's known down,
    // probing it just wastes a request and the timeout window.
    try { if (!sampler.isAvailable(prefixOf(model))) { results.push({ model, ok: null, reason: 'sampler_backoff' }); continue; } } catch {}
    results.push(await probeOne(model));
    // Jittered spacing so a pass doesn't fire as one synchronized burst.
    if (spacing > 0) await new Promise(r => setTimeout(r, spacing + Math.floor(spacing * (deterministicJitter(model)))));
  }
  return results;
}

// Deterministic per-model jitter in [0,1) without Math.random (keeps the module
// import-order/replay clean and avoids a synchronized cadence across models).
function deterministicJitter(model) {
  let h = 0;
  for (let i = 0; i < model.length; i++) h = (h * 31 + model.charCodeAt(i)) & 0xffff;
  return (h % 100) / 100;
}

function start() {
  if (_interval) return; // idempotent -- like sampler.startSampler
  const tick = () => {
    if (_running) return; // never overlap passes
    _running = true;
    runOnce().catch(() => {}).finally(() => { _running = false; });
  };
  _interval = setInterval(tick, CONF.intervalMs());
  if (_interval.unref) _interval.unref();
}

function stop() {
  if (_interval) { clearInterval(_interval); _interval = null; }
}

// Observability snapshot for GET /v1/readiness.
function peek() {
  const topK = CONF.topK();
  const maxPerProvider = CONF.maxPerProvider();
  const freshMs = CONF.freshMs();
  const now = Date.now();
  const candidates = deriveCandidates(topK, maxPerProvider);
  return candidates.map((model) => {
    const p = _lastProbe.get(model) || {};
    const a = availability.peek(model);
    const lastProbeTs = p.ts || null;
    return {
      model,
      lastProbeTs,
      ok: p.ok != null ? p.ok : a.ok,
      latencyMs: p.latencyMs != null ? p.latencyMs : a.avgLatencyMs,
      rank: a.rank,
      fresh: isFresh(model, now, freshMs),
      nextProbeInMs: lastProbeTs ? Math.max(0, freshMs - (now - lastProbeTs)) : 0,
    };
  });
}

module.exports = { start, stop, runOnce, probeOne, peek, deriveCandidates, isFresh, _lastProbe };
