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
  // topK doubled (5 -> 10) now that deriveCandidates covers TWO chains (plain
  // + tool-capable, see its own comment) sharing one budget -- at the old
  // topK=5 the tool-capable chain (what a real casey turn actually uses)
  // could get crowded out entirely by the plain chain's leads, leaving it
  // never pre-warmed despite this whole module existing to prevent exactly
  // that. maxPerProvider unchanged: still bounds how hard any single
  // provider gets hit per cycle regardless of how many total candidates.
  topK: () => N('ACPTOAPI_READINESS_TOPK', 10),
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

// Explicit-chain callers (an app that configures its OWN comma-separated or
// array chain -- e.g. casey's CASEY_LLM_MODEL -- rather than relying on
// buildAutoChain('auto')) have no way to tell this prober which models
// actually matter to them: deriveCandidates only ever looked at the generic
// auto-chain, so an app's real configured models could sit unprobed
// indefinitely, silently stuck in a sampler backoff window (up to 8 minutes
// at BACKOFF_STEPS_MS's ceiling) even after they recovered, because
// pre-emptive skip prevents the only OTHER path (a real chat call) from ever
// re-discovering they're healthy again. registerCandidates lets a caller
// register its own models as ALWAYS-INCLUDED probe targets, on top of
// whatever the auto-chain derivation finds -- a small, bounded set (Set
// dedups; callers are expected to register their own steady chain once, not
// grow this unboundedly).
const _registeredCandidates = new Set();
function registerCandidates(models) {
  for (const m of (Array.isArray(models) ? models : [models])) {
    const model = typeof m === 'string' ? m : (m && m.model);
    if (model) _registeredCandidates.add(model);
  }
}

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

// Derive the candidate set to keep hot: every registerCandidates() model
// FIRST (a caller's own explicit configured chain, e.g. casey's
// CASEY_LLM_MODEL -- these are the models a real request will ACTUALLY try,
// not a generic best-guess, so they lead), then the top-K links of the
// current auto-chain to fill any remaining budget. Both capped per provider
// so one brand's models don't consume the whole readiness budget. Lazy-
// require auto-chain to avoid a load-order cycle (auto-chain -> availability
// -> ... ).
function deriveCandidates(topK, maxPerProvider) {
  const perProvider = new Map();
  const out = [];
  const seenModel = new Set();
  const tryAdd = (model) => {
    if (!model || seenModel.has(model) || out.length >= topK) return false;
    const pfx = prefixOf(model);
    const seen = perProvider.get(pfx) || 0;
    if (seen >= maxPerProvider) return false;
    perProvider.set(pfx, seen + 1);
    seenModel.add(model);
    out.push(model);
    return true;
  };
  for (const model of _registeredCandidates) { if (out.length >= topK) break; tryAdd(model); }
  if (out.length < topK) {
    let links = [];
    try {
      const { buildAutoChain } = require('./auto-chain');
      links = buildAutoChain('auto') || [];
    } catch { links = []; }
    for (const link of links) {
      if (out.length >= topK) break;
      tryAdd(typeof link === 'string' ? link : link.model);
    }
  }
  // ALSO derive from the TOOL-CAPABLE chain (hasTools:true), not just the
  // plain-text chain above. Live-witnessed gap: a real consumer like casey
  // issues almost every request through a tool-bearing agent loop
  // (runTurn's case_* tool surface), which resolves a DIFFERENT, often much
  // narrower chain (TOOLS_IMPOSSIBLE_RE/TOOLS_UNRELIABLE_RE exclude many
  // models outright -- see auto-chain.js) -- yet this prober only ever
  // warmed the non-tool chain, so its whole "already verified by the time a
  // real message arrives" promise never actually applied to casey's real
  // traffic shape. Appended (not interleaved) so the plain-chain leads get
  // priority within the same topK/maxPerProvider budget; tryAdd's dedup
  // means a model appearing in both chains is only probed once.
  if (out.length < topK) {
    let toolLinks = [];
    try {
      const { buildAutoChain } = require('./auto-chain');
      toolLinks = buildAutoChain('auto', { hasTools: true }) || [];
    } catch { toolLinks = []; }
    for (const link of toolLinks) {
      if (out.length >= topK) break;
      tryAdd(typeof link === 'string' ? link : link.model);
    }
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

  // Keep brand-catalog.js's per-brand model list warm for in-process consumers.
  // refreshAll is its own TTL-gated no-op when everything is already fresh, so
  // this costs nothing extra once warm -- but without SOME periodic caller,
  // an in-process consumer that never boots lib/server.js (the only other
  // refreshAll call site) gets a ONE-TIME catalog populated at first probe and
  // then, the instant its TTL elapses, buildAutoChain permanently falls back
  // to each brand's single static default model for the rest of the process's
  // life -- live-witnessed as buildAutoChain('auto') flickering between an
  // 11-link and a 9-link chain (losing two real, working, keyed brands)
  // purely on TTL timing, no code change involved. Best-effort: a refresh
  // failure must never block the readiness pass itself.
  try { await require('./brand-catalog').refreshAll({ force: false }); } catch {}

  const candidates = deriveCandidates(topK, maxPerProvider);
  const results = [];
  for (const model of candidates) {
    if (isFresh(model, now, freshMs)) { results.push({ model, ok: null, reason: 'fresh_skip' }); continue; }
    // DELIBERATELY PROBE a sampler-backed-off provider, don't skip it -- this
    // was previously "don't probe a provider the sampler has circuit-broken,
    // it's known down, probing it just wastes a request," which inverts the
    // whole point of a readiness prober. sampler.js's backoff window (up to
    // 8 minutes at BACKOFF_STEPS_MS's ceiling) is a REAL-TRAFFIC circuit
    // breaker -- it protects a live user request from paying the cost of
    // discovering a down provider itself. It is not evidence the provider is
    // STILL down; a burst of failures from OUR OWN heavy testing trips the
    // same breaker as a genuine outage, and nothing else re-verifies it
    // before the backoff timer expires on its own. USER DIRECTIVE, live-
    // witnessed: "we're not expecting providers to be recovering... it's
    // supposed to dynamically figure out and use what's really available"
    // and "these providers should already immediately be available when the
    // message arrives, there's no need for it to fail at that point." A
    // cheap 1-token readiness probe is exactly the controlled-rate recovery
    // check a circuit breaker is supposed to get -- probeOne already calls
    // sampler.markOk() on success (clearing the backoff immediately) and
    // availability.recordFailure() on failure (so a genuinely still-down
    // provider stays correctly ranked low without needing this loop to lie
    // about it). Real user traffic (chain-machine.js preCheck) still defers
    // to sampler.isAvailable() as its own gate, unchanged -- only the
    // BACKGROUND prober, whose entire job is safely testing recovery, no
    // longer refuses to test the exact providers most in need of testing.
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
  // COLD-BOOT GAP, fixed here: setInterval's own first tick only fires after a
  // FULL intervalMs delay (2min default) -- so every fresh process start ran
  // with zero readiness data for up to 2 minutes, purely reactive (a real
  // user turn discovering failures live) during exactly the window a
  // just-restarted process is most likely to receive its first real traffic.
  // USER DIRECTIVE: the correct model should already be ready when the call
  // happens, not discovered by backing off after the call fails. Fire an
  // immediate pass on start() so the very first real chat/chatChain call
  // after a restart already has fresh, real-request-verified availability
  // data to rank against, not a cold best-guess default order.
  tick();
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

module.exports = { start, stop, runOnce, probeOne, peek, deriveCandidates, isFresh, registerCandidates, _lastProbe };
