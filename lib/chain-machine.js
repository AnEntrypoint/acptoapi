'use strict';
const { setup, createActor, assign } = require('xstate');

const FALLBACK_REASONS = ['error', 'timeout', 'rate_limit', 'empty', 'content_policy', 'sampler_backoff', 'matrix_block', 'auth', 'fetch_failed', 'credit_dead'];

const DEFAULT_LINK_TIMEOUT_MS = Number(process.env.ACPTOAPI_CHAIN_LINK_TIMEOUT_MS) || 120000;

function classifyError(err) {
  // A caller-initiated cancellation (AbortController.abort(), e.g. freddie's
  // TUI ctrl+c cancelTurn) is not a provider health signal -- it says
  // nothing about whether the provider is reachable, only that the caller
  // stopped waiting. Checked first, before any status/code/message
  // heuristic below, since an aborted fetch's error can otherwise read as
  // `fetch_failed` or the generic `error` fallthrough (both
  // PROVIDER_LEVEL_HEALTH_REASONS members), which previously tripped
  // sampler.markFailed on a perfectly healthy provider for every
  // mid-request cancel. `'aborted'` is deliberately absent from both
  // FALLBACK_REASONS and PROVIDER_LEVEL_HEALTH_REASONS below, so it is both
  // terminal (rethrown immediately, no wasted attempt on the next link) and
  // never penalizes the provider.
  if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) return 'aborted';
  const status = err && err.status;
  const msg = (err && err.message) || '';
  // Checked BEFORE the status-code auth check below: witnessed live
  // (opencode-zen) a provider that returns HTTP 401 with a CreditsError body
  // ("No payment method...") for a billing failure -- a bare status===401
  // check alone misclassifies this as 'auth' (permanently-dead key), when the
  // actual, more specific and more actionable signal is 'credit_dead' (add a
  // payment method; the key itself is fine). The message-shape check is more
  // specific than the generic status code here, so it takes precedence.
  if (/creditserror|no payment method|insufficient credits|payment.?required/i.test(msg)) return 'credit_dead';
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'credit_dead';
  if (status === 429) return 'rate_limit';
  const code = err && err.code;
  if (code === 'RATE_LIMIT') return 'rate_limit';
  if (code === 'AUTH') return 'auth';
  if (code === 'CREDIT_DEAD') return 'credit_dead';
  if (code === 'FETCH_FAILED') return 'fetch_failed';
  if (code === 'TIMEOUT') return 'timeout';
  if (/rate.?limit|429|quota/i.test(msg)) return 'rate_limit';
  if (/timeout|timed out/i.test(msg)) return 'timeout';
  if (/content.?policy|safety|blocked/i.test(msg)) return 'content_policy';
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(msg)) return 'fetch_failed';
  if (/402/.test(msg)) return 'credit_dead';
  if (/401|403|invalid api key|unauthorized/i.test(msg)) return 'auth';
  return 'error';
}

function shouldFallback(reason, fallbackOn) {
  if (!fallbackOn || fallbackOn.length === 0) return FALLBACK_REASONS.includes(reason);
  return fallbackOn.includes(reason);
}

function normalizeLink(link) {
  if (typeof link === 'string') return { model: link };
  if (link && typeof link === 'object' && link.model) return link;
  throw new Error('chain link must be a model string or { model, ...overrides }');
}

function prefixOf(model) {
  const m = /^([a-z0-9-]+)\//.exec(model || '');
  return m ? m[1] : null;
}

const PROVIDER_LEVEL_HEALTH_REASONS = new Set(['error', 'timeout', 'rate_limit', 'auth', 'fetch_failed', 'empty', 'credit_dead']);

// A multi-model aggregator prefix (one base URL serving many independent
// models, e.g. a proxy that fans out to dozens of unrelated brands) is NOT
// "one backend" the way a real single-backend provider (groq, cerebras,
// mistral, ...) is -- the per-PREFIX sampler backoff below assumes exactly
// that, so a single model's failure was backing off every unrelated sibling
// model under the same prefix for minutes at a time. The per-MODEL
// availability tracker (below, in preCheck) already does the right thing for
// an aggregator model on its own; this just stops the coarse prefix-wide
// sampler from ALSO firing for that case. A genuine single-backend provider
// is unaffected: isMultiModelPrefix only returns true for a prefix whose
// registered record actually holds more than one model.
//
// HARDCODED_AGGREGATOR_PREFIXES covers the same case for a hardcoded brand
// (lib/openai-brands.js BRANDS) rather than a user-registered extra-provider
// entry. isMultiModelPrefix only tracks the latter (registeredProvidersByPrefix,
// populated by extra-providers.js's registration flow), so a brand like
// openrouter -- which re-exports many independent third-party brands under
// nested model ids (openrouter/x-ai/grok-4.6, openrouter/google/gemini-3.6-flash)
// -- was never recognized as an aggregator: prefixOf collapses every nested
// id to the same 'openrouter' prefix, so one unrelated openrouter/<brand>/<model>
// failure (bad key, no credits, wrong endpoint) tripped sampler.markFailed
// ('openrouter') and backed off EVERY openrouter model, including an entirely
// healthy, explicitly user-configured one (witnessed: agent.model_preference's
// sole entry openrouter/ox-alpha skipped with reason=sampler_backoff after
// unrelated openrouter/x-ai/grok-4.6 and openrouter/google/gemini-3.6-flash:batch
// probe failures). A real single-backend brand (groq, deepseek, mistral, ...)
// never nests a third-party brand segment in its model ids and stays off this
// set, so its per-prefix breaker is unaffected.
const HARDCODED_AGGREGATOR_PREFIXES = new Set(['openrouter']);
function isAggregatorPrefix(provider) {
  if (HARDCODED_AGGREGATOR_PREFIXES.has(provider)) return true;
  try {
    return require('./extra-providers').isMultiModelPrefix(provider);
  } catch {
    return false; // fail-open to today's behavior if the lookup itself throws
  }
}

// A rate_limit failure's own stated recovery time (a real Retry-After header
// or Gemini-style RetryInfo.retryDelay body detail) is a far more precise
// backoff signal than the fixed MIN_FAILSTREAK_TO_SKIP_MODEL count -- it can
// be much shorter (a burst limit that clears in seconds) or much longer (a
// daily quota reset) than the fixed schedule assumes. Reuses lib/errors.js's
// existing parseRetryDelay (already the one parser for both header and body
// shapes, wired into withRetry) rather than re-deriving the same logic here.
// Only meaningful for rate_limit -- every other reason has no such deadline.
function retryAfterMsFor(reason, err) {
  if (reason !== 'rate_limit') return undefined;
  try { return require('./errors').parseRetryDelay(err) ?? undefined; } catch { return undefined; }
}

// Reasons plausibly transient on the SAME model (a network blip, one slow
// response, a momentarily empty completion) -- worth staying on this link
// and retrying before ever falling to the next chain link. auth/rate_limit/
// content_policy are excluded: retrying the identical call changes nothing
// for those (a bad key stays bad, a policy refusal repeats, a rate limit
// needs its own stated Retry-After, not a blind retry).
const SAME_LINK_RETRY_REASONS = new Set(['timeout', 'error', 'fetch_failed', 'empty']);
const SAME_LINK_RETRY_BASE_MS = Number(process.env.ACPTOAPI_SAME_LINK_RETRY_BASE_MS) || 1000;
const SAME_LINK_RETRY_STEP_MAX_MS = Number(process.env.ACPTOAPI_SAME_LINK_RETRY_STEP_MAX_MS) || 15000;
// A model erroring with the IDENTICAL reason N times in a row within the
// SAME request's same-link retry loop is strong same-request evidence it
// will not recover before the time budget runs out anyway -- witnessed live
// (2026-08-31): nvidia/moonshotai/kimi-k2.6 burned 19 same-link retries
// (~45s) as the chain lead, erroring identically every single time, before
// finally advancing. sameLinkRetryDelayMs scales its delay off
// availability.js's CROSS-REQUEST failStreak (only incremented once per
// whole chain-link exhaustion, not per same-link attempt), so within one
// request's retry loop the per-attempt delay barely grows and the loop just
// keeps hammering on the time budget alone. This is a SEPARATE, same-request
// consecutive-count cap that advances early once the SAME reason repeats
// this many times in a row, independent of the time budget -- a genuinely
// transient failure (reason varies attempt to attempt, e.g. timeout then
// error then empty) is unaffected and still gets the full time budget.
const SAME_LINK_CONSECUTIVE_REASON_CAP = Number(process.env.ACPTOAPI_SAME_LINK_CONSECUTIVE_REASON_CAP) || 4;
// Per-user direction: keep retrying the SAME (lead) model for up to this long
// -- most real provider hiccups (a transient network blip, a momentary
// overload) clear within minutes, and falling to a last-resort model the
// instant the lead model stumbles once defeats the whole point of having a
// lead model. Only after this budget is exhausted does the chain advance to
// the next link. 10 minutes default: long enough to ride out a real but
// short-lived outage, short enough that a genuinely dead model still fails
// over within the same turn's patience.
const SAME_LINK_RETRY_BUDGET_MS = Number(process.env.ACPTOAPI_SAME_LINK_RETRY_BUDGET_MS) || 10 * 60 * 1000;

// Overall wall-clock ceiling for the ENTIRE chain walk (all links combined),
// distinct from SAME_LINK_RETRY_BUDGET_MS (per-link patience) and
// MODEL_UNHEALTHY_WAIT_BUDGET_MS (per-precheck patience) -- those bound each
// INDIVIDUAL link, but nothing previously bounded the sum across a whole
// chain. Witnessed live (2026-08-31): a request walked ~64 attempts across 5
// links (same-link retries + per-link timeouts compounding), took 5+ minutes,
// and the caller gave up with literally zero bytes ever received (the
// streaming branch had not yet reached its own catch block to emit even the
// fallback message). A per-link budget that is individually reasonable can
// still sum to an unreasonable total across a 9-12 link auto chain. Checked
// at the top of the main loop in both runStream/runChat; once exceeded, the
// chain gives up immediately (throws/exhausts) rather than starting or
// continuing to wait on any further link, regardless of how many remain.
const CHAIN_WALL_CLOCK_BUDGET_MS = Number(process.env.ACPTOAPI_CHAIN_WALL_CLOCK_BUDGET_MS) || 90000;

// Separate, much shorter budget for waiting out a model_unhealthy preCheck
// block specifically -- see waitForLeadLinkPrecheck's own comment for why
// this must NOT share SAME_LINK_RETRY_BUDGET_MS with sampler_backoff (which
// has a real, precise recovery ETA via nextRetryAt).
const MODEL_UNHEALTHY_WAIT_BUDGET_MS = Number(process.env.ACPTOAPI_MODEL_UNHEALTHY_WAIT_BUDGET_MS) || 10000;

// Backoff between same-link retries scales with how persistently this exact
// model has been failing recently (availability.js's own raw failStreak, not
// the time-decayed effectiveFailStreak used elsewhere for gating -- here we
// want the retry delay to track the CURRENT run of failures, not a
// smoothed-over-time value), so a model with a longer recent failure streak
// gets a longer pause between retries, while a model that rarely fails gets
// a short one. Capped per-step so even a persistently-bad model still gets
// checked again reasonably often within the overall retry budget above,
// rather than one huge sleep eating most of the budget in a single step.
function sameLinkRetryDelayMs(model) {
  try {
    const { failStreak } = require('./availability').peek(model);
    const n = Math.max(0, failStreak || 0);
    return Math.min(SAME_LINK_RETRY_STEP_MAX_MS, SAME_LINK_RETRY_BASE_MS * Math.pow(2, n));
  } catch {
    return SAME_LINK_RETRY_BASE_MS;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// In-flight same-link failure tracker, shared across CONCURRENT requests in
// this process (a module-level Map, not per-request state). Witnessed live
// (2026-08-31): two concurrent requests both independently retried the SAME
// currently-erroring lead model for 100+ seconds each, because
// availability.recordFailure only fires once a same-link retry LOOP fully
// exhausts (chain-machine.js's own retry loop below), not per individual
// retry attempt -- so a second request's preCheck/rankLinks had zero
// visibility into "this model is mid-storm right now" until the first
// request's entire budget ran out. This tracker updates on EVERY same-link
// retry attempt (not just final exhaustion) so a second concurrent request
// can see the storm immediately and skip the lead link fast instead of
// piling onto the same dying model.
const inFlightFailures = new Map(); // model -> { count, lastFailTs }
const IN_FLIGHT_STORM_THRESHOLD = Number(process.env.ACPTOAPI_INFLIGHT_STORM_THRESHOLD) || 3;
const IN_FLIGHT_STORM_WINDOW_MS = Number(process.env.ACPTOAPI_INFLIGHT_STORM_WINDOW_MS) || 15000;

function recordInFlightFailure(model) {
  const now = Date.now();
  const e = inFlightFailures.get(model);
  if (e && (now - e.lastFailTs) < IN_FLIGHT_STORM_WINDOW_MS) {
    e.count += 1;
    e.lastFailTs = now;
  } else {
    inFlightFailures.set(model, { count: 1, lastFailTs: now });
  }
}
function clearInFlightFailure(model) {
  inFlightFailures.delete(model);
}
// True when >= IN_FLIGHT_STORM_THRESHOLD retries have landed on this model
// within the last IN_FLIGHT_STORM_WINDOW_MS, REGARDLESS of which request
// recorded them -- the whole point is cross-request visibility. Naturally
// self-clears: a stale entry outside the window is treated as no storm
// (checked inline, no separate sweep/timer needed).
function isInFlightStorming(model) {
  const e = inFlightFailures.get(model);
  if (!e) return false;
  if ((Date.now() - e.lastFailTs) >= IN_FLIGHT_STORM_WINDOW_MS) return false;
  return e.count >= IN_FLIGHT_STORM_THRESHOLD;
}

// A sampler_backoff/model_unhealthy preCheck block happens BEFORE any call is
// even attempted -- the SAME-link retry loop below never runs for it, so a
// prefix-level circuit-breaker trip (lib/sampler.js) bypassed the whole
// same-link retry budget above and fell straight to the next chain link,
// exactly the "switched to a last-resort model while the lead model was
// still genuinely reachable" defect this file's own same-link retry was
// built to fix. This applies the identical retry-budget discipline to a
// preCheck block on the CHAIN'S LEAD LINK ONLY (index 0) -- a non-lead link
// that's already a fallback has no "stay here" expectation to honor, so
// falling through immediately for those is unchanged. Waits for the
// sampler's own reported nextRetryAt when available (the real, precise
// clearing time) rather than blind-polling on a fixed interval; falls back
// to a short fixed poll when no nextRetryAt is known (e.g. model_unhealthy,
// which has no sampler-side timer).
async function waitForLeadLinkPrecheck(link, opts, isLeadLink, linkRetryStartedAt, chainDeadline, isLastLink) {
  if (!isLeadLink) return null;
  // A lead link that is ALSO the last link (single-model chain, or the
  // final fallback) has no candidate waiting behind it -- blocking here on
  // an in-flight-storm signal from a DIFFERENT concurrent request only
  // guarantees this request fails with zero live attempt, where a real
  // attempt can only be equal-or-better (succeeds and self-heals the
  // tracked health, or fails exactly as a block would have but with a real
  // error). Witnessed live: a single-model direct request against
  // openrouter/anthropic/claude-sonnet-5:batch returned a fabricated
  // "all providers unavailable" 200 with reason=model_unhealthy and no
  // upstream call, purely because an EARLIER unrelated request had tripped
  // the in-flight storm tracker for that same model id.
  if (isLastLink) return preCheck(link, opts);
  // Fast path: another concurrent request is already mid-storm retrying
  // this exact model -- don't wait for OUR own preCheck/retry cycle to
  // discover the same thing independently, bail immediately so this
  // request advances to the next chain link right away.
  if (isInFlightStorming(link.model)) {
    return { ok: false, reason: 'model_unhealthy' };
  }
  const deadline = typeof chainDeadline === 'number' ? chainDeadline : Infinity;
  while (true) {
    if (Date.now() >= deadline) return { ok: false, reason: 'sampler_backoff' };
    const pc = preCheck(link, opts);
    if (pc.ok) return pc;
    if (pc.reason !== 'sampler_backoff' && pc.reason !== 'model_unhealthy') return pc;
    const elapsed = Date.now() - linkRetryStartedAt;
    // model_unhealthy has no stated recovery deadline the way sampler_backoff
    // does (peekStatus().nextRetryAt below) -- it is a persisted, cross-
    // request health signal (availability.js's effectiveFailStreak/rank) that
    // can stay negative for a long time with nothing to wait OUT for. Waiting
    // the FULL SAME_LINK_RETRY_BUDGET_MS on it (as sampler_backoff correctly
    // does, since it has a real ETA) just burns the whole budget uselessly on
    // a model already confirmed unhealthy by prior evidence -- witnessed live
    // (2026-08-31): a request spent 45s+ polling model_unhealthy every 1s on
    // a model with zero live attempts, before ever reaching a working
    // fallback. Bounded to a much shorter budget so a confirmed-unhealthy
    // lead model fails over promptly while a real, precisely-timed
    // sampler_backoff still gets its full patience.
    const budgetForReason = pc.reason === 'model_unhealthy'
      ? Math.min(SAME_LINK_RETRY_BUDGET_MS, MODEL_UNHEALTHY_WAIT_BUDGET_MS)
      : SAME_LINK_RETRY_BUDGET_MS;
    if (elapsed >= budgetForReason) return pc;
    let waitMs = SAME_LINK_RETRY_BASE_MS;
    try {
      const prefix = prefixOf(link.model);
      const status = require('./sampler').peekStatus(prefix);
      if (status?.nextRetryAt) waitMs = Math.max(0, status.nextRetryAt - Date.now());
    } catch {}
    waitMs = Math.min(waitMs || SAME_LINK_RETRY_STEP_MAX_MS, SAME_LINK_RETRY_STEP_MAX_MS, budgetForReason - elapsed, deadline - Date.now());
    console.log(`[chain] same-link precheck-wait reason=${pc.reason} model=${link.model} delayMs=${waitMs} elapsedMs=${elapsed}`);
    await sleep(waitMs);
  }
}

function markProviderFailed(model, reason, opts) {
  if (opts.sampler === false || !PROVIDER_LEVEL_HEALTH_REASONS.has(reason)) return;
  const provider = prefixOf(model);
  if (!provider) return;
  // credit_dead (402/no payment method) is permanent -- unlike a transient
  // rate_limit/timeout, it must never self-heal via availability.js's
  // effectiveFailStreak time-decay (a missing payment method doesn't fix
  // itself with the passage of time). Tracked per-MODEL via
  // availability.markCreditDead, NOT per-brand/prefix: a multi-model
  // aggregator brand (witnessed: opencode-zen) can have some models
  // genuinely free/working (nemotron-3-ultra-free, laguna-s-2.1-free) and
  // others 402ing (claude-opus-5, grok-4.6) on the SAME account -- a
  // brand-wide exclusion (the original, wrong version of this fix) took the
  // working free models out of the chain right alongside the dead paid ones.
  if (reason === 'credit_dead') {
    try { require('./availability').markCreditDead(model); } catch {}
  }
  if (isAggregatorPrefix(provider)) return; // per-model availability.recordFailure already covers this at the call site
  try {
    // reason forwarded so sampler.js can apply its own much-shorter,
    // low-ceiling backoff schedule for a mere 'timeout' (a slow-but-alive
    // response) instead of the same long-tail escalation a genuine
    // connectivity/auth failure gets -- see sampler.js's own comment.
    require('./sampler').markFailed(provider, reason);
  } catch (e) {
    console.error(`[chain] sampler.markFailed threw for provider=${provider}: ${e.message}`);
  }
}

const MIN_FAILSTREAK_TO_SKIP_MODEL = Number(process.env.ACPTOAPI_MODEL_SKIP_FAILSTREAK) || 5;

// Single-flight claim for the "model has never once succeeded, but its
// effective (decayed) fail streak has recovered enough to clear the gate"
// recovery path: availability.js's effectiveFailStreak continuously decays
// toward 0 as time passes since the last failure (see that file's own
// comment for why -- the decay exists so a model whose failures were caused
// by a since-fixed external condition, e.g. an expired provider key later
// refreshed, can recover instead of staying permanently hard-skipped with no
// path back to health, since preCheck below skips a model BEFORE any HTTP
// attempt and the model can never record the one real success that would
// reset failStreak on its own). Without this claim, EVERY caller reaching
// preCheck for that model within the same instant sees the identical
// recovered score and ALL would pass the gate, dispatching a burst of
// simultaneous real HTTP calls to a still-broken provider instead of the
// single bounded probe the recovery mechanism intends. The claim lives HERE,
// not inside availability.js's score()/peek() (a prior version tried that
// and was reverted -- see availability.js's own comment on
// effectiveFailStreak -- because score()/peek() are read from several
// independent call sites per request, e.g. snapshotAvailabilityRanks and
// auto-chain.js's rankLinks, both BEFORE this preCheck call in the real
// request path; a stateful claim living inside the shared read function
// self-collided the moment more than one of those call sites touched the
// same model in one request, defeating the very probe it was meant to allow
// through even for a single non-concurrent caller). preCheck is the ONE call
// site that actually turns a read into a dispatch decision, so it is the
// correct and only place this side effect belongs.
const modelProbeClaimedUntil = new Map();
const MODEL_PROBE_CLAIM_HOLD_MS = Number(process.env.ACPTOAPI_MODEL_PROBE_CLAIM_MS) || 30000;

function preCheck(link, opts) {
  const prefix = prefixOf(link.model);
  if (!prefix) return { ok: true };
  // See markProviderFailed's isAggregatorPrefix comment: a multi-model
  // aggregator prefix never entered prefix-wide backoff above, so this gate
  // would otherwise stay permanently open for it anyway (isAvailable reads
  // the same sampler state markProviderFailed no longer writes) -- skip the
  // lookup itself rather than relying on that side effect, so the intent is
  // explicit at the read site too.
  if (opts.sampler !== false && !isAggregatorPrefix(prefix)) {
    const sampler = (opts.sampler && typeof opts.sampler === 'object') ? opts.sampler : require('./sampler');
    if (typeof sampler.isAvailable === 'function' && !sampler.isAvailable(prefix)) {
      return { ok: false, reason: 'sampler_backoff' };
    }
  }
  if (opts.modelHealth !== false) {
    try {
      const availability = require('./availability');
      // A 402/no-payment-method model never self-heals with time (unlike
      // every other reason here, which is either a real stated deadline or a
      // decaying heuristic) -- checked first and unconditionally, ahead of
      // both the Retry-After deadline and the decaying failStreak gate below,
      // since neither of those apply to a permanently billing-blocked model.
      if (availability.isCreditDead(link.model)) {
        return { ok: false, reason: 'credit_dead' };
      }
      // A real, still-live provider-stated Retry-After deadline (see
      // retryAfterMsFor above) takes precedence over the fixed failStreak
      // gate below -- it is the model's ACTUAL known recovery time, whether
      // that is shorter or longer than MIN_FAILSTREAK_TO_SKIP_MODEL implies.
      if (availability.isRetryDeadlineActive(link.model)) {
        return { ok: false, reason: 'model_unhealthy' };
      }
      // MUST read effectiveFailStreak (continuously time-decayed, see
      // availability.js), never the raw failStreak also present on peeked --
      // the raw count never decays on its own, so a model that hit the
      // threshold once stayed gated here PERMANENTLY even after score()
      // itself had already recovered (score's failPenalty is computed from
      // the decayed value, but a raw-failStreak condition here would use the
      // undecayed one, silently overriding the recovery the rank check
      // should have honored). A real defect an independent adversarial
      // review caught: the fixed-schedule sampler backoff this file also
      // uses (lib/sampler.js) was suspected as the over-compensating culprit
      // first, but openrouter (this session's actual blocked provider) is a
      // registered aggregator prefix exempted from that breaker entirely --
      // this per-model gate was the real, permanent-lockout source.
      //
      // Reads peeked.rank rather than a second availability.score(link.model)
      // call -- peek() already computes rank: score(model) inline (see
      // availability.js), so a second explicit call is a pure redundant
      // duplicate. This mattered more when score()/peek() carried a stateful
      // single-flight side effect (since reverted, see availability.js) that
      // was NOT idempotent across repeated calls in the same tick; kept as
      // the correct shape regardless, since it's also simply fewer calls for
      // an identical result.
      const peeked = availability.peek(link.model);
      if (peeked && peeked.effectiveFailStreak >= MIN_FAILSTREAK_TO_SKIP_MODEL && peeked.rank < 0) {
        return { ok: false, reason: 'model_unhealthy' };
      }
      // score()/peek() are pure reads (see availability.js) -- a model that
      // has never once succeeded but whose effectiveFailStreak has decayed
      // enough to clear the gate above already passed with a non-negative
      // rank. Apply single-flight ONLY to that specific case: a model that
      // HAS succeeded before doesn't need it (a decayed old failure on an
      // otherwise-healthy model, with positive success history to fall back
      // on, isn't the sharp zero-evidence transition this guards against),
      // and a model still within its fresh-failure window already got
      // skipped above regardless of this claim.
      if (peeked && !peeked.lastSuccessTs && peeked.totalSamples >= MIN_FAILSTREAK_TO_SKIP_MODEL && peeked.lastFailTs != null) {
        const now = Date.now();
        const claimedUntil = modelProbeClaimedUntil.get(link.model);
        if (claimedUntil && claimedUntil > now) {
          return { ok: false, reason: 'model_unhealthy' };
        }
        modelProbeClaimedUntil.set(link.model, now + MODEL_PROBE_CLAIM_HOLD_MS);
      }
    } catch { /* availability tracking is best-effort; never block a call on it */ }
  }
  if (opts._matrixData) {
    const { matrixScore } = require('./matrix');
    const rest = link.model.slice(prefix.length + 1);
    const score = matrixScore(prefix, rest, opts._matrixData);
    if (score.ok === false) return { ok: false, reason: 'matrix_block' };
  }
  return { ok: true };
}

async function hydrateMatrix(opts) {
  if (!opts || opts._matrixData !== undefined) return;
  if (!opts.matrixSource) return;
  try { opts._matrixData = await require('./matrix').loadMatrix(opts.matrixSource); }
  catch { opts._matrixData = null; }
}

function reorderByMatrix(links, opts) {
  if (!opts || !opts._matrixData) return links;
  const { matrixScore } = require('./matrix');
  const scored = links.map((l, i) => {
    const prefix = prefixOf(l.model);
    if (!prefix) return { l, i, ok: null };
    const rest = l.model.slice(prefix.length + 1);
    const s = matrixScore(prefix, rest, opts._matrixData);
    return { l, i, ok: s.ok };
  });
  const okToRank = (x) => x.ok === true ? 0 : x.ok === null ? 1 : 2;
  scored.sort((a, b) => okToRank(a) - okToRank(b) || a.i - b.i);
  return scored.map(s => s.l);
}

const machine = setup({
  types: {},
  guards: {
    hasMore: ({ context }) => context.index + 1 < context.links.length,
  },
}).createMachine({
  id: 'chainFallback',
  initial: 'trying',
  context: ({ input }) => ({
    links: input.links,
    index: 0,
    history: [],
    lastReason: null,
    lastError: null,
    servedBy: null,
    succeededAt: null,
    startedAt: Date.now(),
  }),
  states: {
    trying: {
      on: {
        SUCCESS: { target: 'done', actions: assign({ servedBy: ({ context }) => context.links[context.index]?.model, succeededAt: () => Date.now() }) },
        FALLBACK: [
          { target: 'trying', guard: 'hasMore', actions: assign({
            index: ({ context }) => context.index + 1,
            history: ({ context, event }) => [...context.history, { model: context.links[context.index].model, reason: event.reason, error: event.error?.message }],
            lastReason: ({ event }) => event.reason,
            lastError: ({ event }) => event.error,
          }), reenter: true },
          { target: 'exhausted', actions: assign({
            history: ({ context, event }) => [...context.history, { model: context.links[context.index].model, reason: event.reason, error: event.error?.message }],
            lastReason: ({ event }) => event.reason,
            lastError: ({ event }) => event.error,
          }) },
        ],
      },
    },
    done: { type: 'final' },
    exhausted: { type: 'final' },
  },
});

function snapshotAvailabilityRanks(links) {
  try {
    const availability = require('./availability');
    return links.map(l => ({ model: l.model, availabilityRank: availability.peek(l.model).rank }));
  } catch {
    return links.map(l => ({ model: l.model, availabilityRank: 0 }));
  }
}

function createChainActor(links) {
  const actor = createActor(machine, { input: { links } });
  actor.start();
  return actor;
}

async function* runStream(linksIn, opts, streamFn, registerRun) {
  await hydrateMatrix(opts);
  const links = reorderByMatrix(linksIn, opts);
  const actor = createChainActor(links);
  if (registerRun) registerRun(actor, { requestedModel: opts._requestedModel || links[0]?.model, resolvedLinks: links.map(l => l.model), resolvedLinksWithRank: snapshotAvailabilityRanks(links) });
  const attempted = [];
  const precheckRetryStartedAt = new Map();
  const chainStartedAt = Date.now();
  const chainBudgetMs = typeof opts.chainBudgetMs === 'number' ? opts.chainBudgetMs : CHAIN_WALL_CLOCK_BUDGET_MS;
  const chainDeadline = chainBudgetMs > 0 ? chainStartedAt + chainBudgetMs : Infinity;
  while (true) {
    if (chainBudgetMs > 0 && (Date.now() - chainStartedAt) >= chainBudgetMs) {
      const err = new Error(`Chain wall-clock budget (${chainBudgetMs}ms) exceeded after ${attempted.length} attempt(s)`);
      err.code = 'CHAIN_BUDGET_EXCEEDED';
      err.chainHistory = actor.getSnapshot().context.history;
      err.attempted = attempted;
      throw err;
    }
    const snap = actor.getSnapshot();
    if (snap.value === 'exhausted') {
      const err = snap.context.lastError || new Error('All chain links failed');
      err.chainHistory = snap.context.history;
      err.attempted = attempted;
      throw err;
    }
    if (snap.value === 'done') return;
    const link = snap.context.links[snap.context.index];
    const isLeadLink = snap.context.index === 0;
    const isLastLink = snap.context.index >= snap.context.links.length - 1;
    if (isLeadLink && !precheckRetryStartedAt.has(snap.context.index)) precheckRetryStartedAt.set(snap.context.index, Date.now());
    const pc = isLeadLink
      ? await waitForLeadLinkPrecheck(link, opts, true, precheckRetryStartedAt.get(snap.context.index), chainDeadline, isLastLink)
      : preCheck(link, opts);
    if (!pc.ok) {
      const e = new Error(`Link ${link.model} blocked: ${pc.reason}`);
      attempted.push({ model: link.model, ms: 0, ok: false, reason: pc.reason });
      const _next = links[snap.context.index + 1]?.model;
      console.log(`[chain] skip reason=${pc.reason} model=${link.model}${_next ? ` -> ${_next}` : ' (exhausted)'}`);
      if (opts.onFallback) try { opts.onFallback({ from: link.model, to: _next, reason: pc.reason, error: e }); } catch {}
      actor.send({ type: 'FALLBACK', reason: pc.reason, error: e });
      continue;
    }
    const { queuesMap: _qm, matrixSource: _ms, onFallback: _of, fallbackOn: _fo, timeout: _to, _matrixData: _md, _requestedModel: _rm, extraQueueSources: _eqs, queueConfigPath: _qcp, sampler: _spl, ...cleanOpts } = opts;
    const callOpts = { ...cleanOpts, ...link, model: link.model };
    const fallbackOn = link.fallbackOn || opts.fallbackOn || FALLBACK_REASONS;
    const timeout = link.timeout || opts.timeout || DEFAULT_LINK_TIMEOUT_MS;
    let attempt = 0;
    let outcome = null;
    const linkRetryStartedAt = Date.now();
    let lastReason = null;
    let sameReasonStreak = 0;
    while (true) {
      attempt += 1;
      const t0 = Date.now();
      let any = false, finished = false;
      console.log(`[chain] stream try provider=${prefixOf(link.model) || 'unknown'} model=${link.model} attempt=${snap.context.index + 1}/${links.length}${attempt > 1 ? ` (retry ${attempt - 1})` : ''}`);
      try {
        const iter = streamFn(callOpts);
        const guarded = timeout > 0 ? withTimeout(iter, timeout) : iter;
        for await (const ev of guarded) {
          if (ev && ev.type === 'text-delta' && ev.textDelta) any = true;
          if (ev && ev.type === 'tool-call') any = true;
          yield ev;
        }
        finished = true;
      } catch (e) {
        const reason = e.code === 'TIMEOUT' ? 'timeout' : classifyError(e);
        sameReasonStreak = reason === lastReason ? sameReasonStreak + 1 : 1;
        lastReason = reason;
        // A same-link retry after any content has already been yielded would
        // double-deliver output to the caller -- only safe to retry a
        // failure that happened before the first event, same as the
        // no-content case below.
        const elapsed = Date.now() - linkRetryStartedAt;
        if (!any && SAME_LINK_RETRY_REASONS.has(reason) && elapsed < SAME_LINK_RETRY_BUDGET_MS && Date.now() < chainDeadline && sameReasonStreak < SAME_LINK_CONSECUTIVE_REASON_CAP) {
          recordInFlightFailure(link.model);
          const delay = Math.min(sameLinkRetryDelayMs(link.model), SAME_LINK_RETRY_BUDGET_MS - elapsed, chainDeadline - Date.now());
          console.log(`[chain] same-link retry reason=${reason} model=${link.model} delayMs=${delay} elapsedMs=${elapsed} sameReasonStreak=${sameReasonStreak}`);
          await sleep(delay);
          continue;
        }
        outcome = { ok: false, reason, error: e, ms: Date.now() - t0 };
        break;
      }
      if (finished && !any && shouldFallback('empty', fallbackOn)) {
        sameReasonStreak = lastReason === 'empty' ? sameReasonStreak + 1 : 1;
        lastReason = 'empty';
        const elapsed = Date.now() - linkRetryStartedAt;
        if (SAME_LINK_RETRY_REASONS.has('empty') && elapsed < SAME_LINK_RETRY_BUDGET_MS && Date.now() < chainDeadline && sameReasonStreak < SAME_LINK_CONSECUTIVE_REASON_CAP) {
          recordInFlightFailure(link.model);
          const delay = Math.min(sameLinkRetryDelayMs(link.model), SAME_LINK_RETRY_BUDGET_MS - elapsed, chainDeadline - Date.now());
          console.log(`[chain] same-link retry reason=empty model=${link.model} delayMs=${delay} elapsedMs=${elapsed} sameReasonStreak=${sameReasonStreak}`);
          await sleep(delay);
          continue;
        }
        outcome = { ok: false, reason: 'empty', error: new Error(`Empty response from ${link.model}`), ms: Date.now() - t0 };
        break;
      }
      outcome = { ok: true, ms: Date.now() - t0 };
      break;
    }
    if (outcome.ok) {
      clearInFlightFailure(link.model);
      attempted.push({ model: link.model, ms: outcome.ms, ok: true, reason: null });
      const pfx = prefixOf(link.model);
      if (pfx && opts.sampler !== false) { try { require('./sampler').markOk(pfx); } catch {} }
      try { require('./availability').recordSuccess(link.model, outcome.ms); } catch {}
      console.log(`[chain] stream ok provider=${pfx || 'unknown'} model=${link.model} ms=${outcome.ms}`);
      actor.send({ type: 'SUCCESS' });
      continue;
    }
    const { reason, error: e, ms } = outcome;
    attempted.push({ model: link.model, ms, ok: false, reason });
    markProviderFailed(link.model, reason, opts);
    try { require('./availability').recordFailure(link.model, retryAfterMsFor(reason, e)); } catch {}
    if (shouldFallback(reason, fallbackOn)) {
      const _next = links[snap.context.index + 1]?.model;
      console.log(`[chain] fallback reason=${reason} from=${link.model}${_next ? ` to=${_next}` : ' (exhausted)'}`);
      if (opts.onFallback) try { opts.onFallback({ from: link.model, to: _next, reason, error: e }); } catch {}
      actor.send({ type: 'FALLBACK', reason, error: e });
      continue;
    }
    throw e;
  }
}

async function runChat(linksIn, opts, chatFn, registerRun) {
  await hydrateMatrix(opts);
  const links = reorderByMatrix(linksIn, opts);
  const actor = createChainActor(links);
  if (registerRun) registerRun(actor, { requestedModel: opts._requestedModel || links[0]?.model, resolvedLinks: links.map(l => l.model), resolvedLinksWithRank: snapshotAvailabilityRanks(links) });
  const attempted = [];
  const precheckRetryStartedAt = new Map();
  const chainStartedAt = Date.now();
  const chainBudgetMs = typeof opts.chainBudgetMs === 'number' ? opts.chainBudgetMs : CHAIN_WALL_CLOCK_BUDGET_MS;
  const chainDeadline = chainBudgetMs > 0 ? chainStartedAt + chainBudgetMs : Infinity;
  while (true) {
    if (chainBudgetMs > 0 && (Date.now() - chainStartedAt) >= chainBudgetMs) {
      const err = new Error(`Chain wall-clock budget (${chainBudgetMs}ms) exceeded after ${attempted.length} attempt(s)`);
      err.code = 'CHAIN_BUDGET_EXCEEDED';
      err.chainHistory = actor.getSnapshot().context.history;
      err.attempted = attempted;
      throw err;
    }
    const snap = actor.getSnapshot();
    if (snap.value === 'exhausted') {
      const err = snap.context.lastError || new Error('All chain links failed');
      err.chainHistory = snap.context.history;
      err.attempted = attempted;
      throw err;
    }
    const link = snap.context.links[snap.context.index];
    const isLeadLink = snap.context.index === 0;
    const isLastLink = snap.context.index >= snap.context.links.length - 1;
    if (isLeadLink && !precheckRetryStartedAt.has(snap.context.index)) precheckRetryStartedAt.set(snap.context.index, Date.now());
    const pc = isLeadLink
      ? await waitForLeadLinkPrecheck(link, opts, true, precheckRetryStartedAt.get(snap.context.index), chainDeadline, isLastLink)
      : preCheck(link, opts);
    if (!pc.ok) {
      const e = new Error(`Link ${link.model} blocked: ${pc.reason}`);
      attempted.push({ model: link.model, ms: 0, ok: false, reason: pc.reason });
      const _next = links[snap.context.index + 1]?.model;
      console.log(`[chain] skip reason=${pc.reason} model=${link.model}${_next ? ` -> ${_next}` : ' (exhausted)'}`);
      if (opts.onFallback) try { opts.onFallback({ from: link.model, to: _next, reason: pc.reason, error: e }); } catch {}
      actor.send({ type: 'FALLBACK', reason: pc.reason, error: e });
      continue;
    }
    const { queuesMap: _qm, matrixSource: _ms, onFallback: _of, fallbackOn: _fo, timeout: _to, _matrixData: _md, _requestedModel: _rm, extraQueueSources: _eqs, queueConfigPath: _qcp, sampler: _spl, ...cleanOpts } = opts;
    const callOpts = { ...cleanOpts, ...link, model: link.model };
    const fallbackOn = link.fallbackOn || opts.fallbackOn || FALLBACK_REASONS;
    const timeout = link.timeout || opts.timeout || DEFAULT_LINK_TIMEOUT_MS;
    let attempt = 0;
    let outcome = null;
    const linkRetryStartedAt = Date.now();
    let lastReason = null;
    let sameReasonStreak = 0;
    while (true) {
      attempt += 1;
      const t0 = Date.now();
      console.log(`[chain] chat try provider=${prefixOf(link.model) || 'unknown'} model=${link.model} attempt=${snap.context.index + 1}/${links.length}${attempt > 1 ? ` (retry ${attempt - 1})` : ''}`);
      try {
        const promise = chatFn(callOpts);
        const result = timeout > 0 ? await Promise.race([promise, rejectAfter(timeout)]) : await promise;
        const empty = isEmptyResult(result) && shouldFallback('empty', fallbackOn);
        if (empty) {
          sameReasonStreak = lastReason === 'empty' ? sameReasonStreak + 1 : 1;
          lastReason = 'empty';
          const elapsed = Date.now() - linkRetryStartedAt;
          if (SAME_LINK_RETRY_REASONS.has('empty') && elapsed < SAME_LINK_RETRY_BUDGET_MS && Date.now() < chainDeadline && sameReasonStreak < SAME_LINK_CONSECUTIVE_REASON_CAP) {
            recordInFlightFailure(link.model);
            const delay = Math.min(sameLinkRetryDelayMs(link.model), SAME_LINK_RETRY_BUDGET_MS - elapsed, chainDeadline - Date.now());
            console.log(`[chain] same-link retry reason=empty model=${link.model} delayMs=${delay} elapsedMs=${elapsed} sameReasonStreak=${sameReasonStreak}`);
            await sleep(delay);
            continue;
          }
          outcome = { ok: false, reason: 'empty', error: new Error(`Empty response from ${link.model}`), ms: Date.now() - t0 };
          break;
        }
        outcome = { ok: true, result, ms: Date.now() - t0 };
        break;
      } catch (e) {
        const reason = e.code === 'TIMEOUT' ? 'timeout' : classifyError(e);
        sameReasonStreak = reason === lastReason ? sameReasonStreak + 1 : 1;
        lastReason = reason;
        const elapsed = Date.now() - linkRetryStartedAt;
        if (SAME_LINK_RETRY_REASONS.has(reason) && elapsed < SAME_LINK_RETRY_BUDGET_MS && Date.now() < chainDeadline && sameReasonStreak < SAME_LINK_CONSECUTIVE_REASON_CAP) {
          recordInFlightFailure(link.model);
          const delay = Math.min(sameLinkRetryDelayMs(link.model), SAME_LINK_RETRY_BUDGET_MS - elapsed, chainDeadline - Date.now());
          console.log(`[chain] same-link retry reason=${reason} model=${link.model} delayMs=${delay} elapsedMs=${elapsed} sameReasonStreak=${sameReasonStreak}`);
          await sleep(delay);
          continue;
        }
        outcome = { ok: false, reason, error: e, ms: Date.now() - t0 };
        break;
      }
    }
    if (outcome.ok) {
      clearInFlightFailure(link.model);
      const { result, ms } = outcome;
      attempted.push({ model: link.model, ms, ok: true, reason: null });
      const pfx = prefixOf(link.model);
      if (pfx && opts.sampler !== false) { try { require('./sampler').markOk(pfx); } catch {} }
      try { require('./availability').recordSuccess(link.model, ms); } catch {}
      // Soft-quality check: a successful, non-empty response that still
      // looks like a refusal or a truncation cutoff. Never affects fallback
      // (the caller already has a real response) or the sampler breaker --
      // it only feeds availability.js's separate soft-fail ranking penalty
      // so a model that reliably answers but often refuses/truncates sinks
      // in future chain ordering without ever being treated as "down."
      try {
        const text = extractText(result);
        const soft = isSoftRefusal(text) || isSuspiciouslyTruncated(text);
        const av = require('./availability');
        if (soft) av.recordSoftFailure(link.model); else av.recordSoftSuccess(link.model);
      } catch {}
      console.log(`[chain] chat ok provider=${pfx || 'unknown'} model=${link.model} ms=${ms}`);
      actor.send({ type: 'SUCCESS' });
      result.__chainAttempted = attempted;
      return result;
    }
    const { reason, error: e, ms } = outcome;
    attempted.push({ model: link.model, ms, ok: false, reason });
    markProviderFailed(link.model, reason, opts);
    try { require('./availability').recordFailure(link.model, retryAfterMsFor(reason, e)); } catch {}
    if (shouldFallback(reason, fallbackOn)) {
      const _next = links[snap.context.index + 1]?.model;
      console.log(`[chain] fallback reason=${reason} from=${link.model}${_next ? ` to=${_next}` : ' (exhausted)'}`);
      if (opts.onFallback) try { opts.onFallback({ from: link.model, to: _next, reason, error: e }); } catch {}
      actor.send({ type: 'FALLBACK', reason, error: e });
      continue;
    }
    throw e;
  }
}

function isEmptyResult(r) {
  if (!r) return true;
  if (typeof r === 'string') return r.trim().length === 0;
  if (r.choices) {
    const c = r.choices[0];
    return !(c?.message?.content || c?.message?.tool_calls?.length);
  }
  if (Array.isArray(r.content)) return r.content.length === 0 || r.content.every(b => !b.text && b.type !== 'tool_use');
  return false;
}

// Extract the plain-text portion of a chat result, across the two shapes
// isEmptyResult already handles (OpenAI choices[].message.content, Anthropic
// content[] blocks). Returns '' rather than null/undefined so callers can
// regex/measure-length unconditionally.
function extractText(r) {
  if (!r) return '';
  if (typeof r === 'string') return r;
  if (r.choices) return (r.choices[0]?.message?.content) || '';
  if (Array.isArray(r.content)) return r.content.filter(b => b && b.type === 'text' && b.text).map(b => b.text).join('');
  return '';
}

// Cheap, always-on heuristic for a "soft failure": the call succeeded (a
// real response came back, no chain fallback triggered) but the content
// itself looks like a refusal or a suspiciously abrupt/truncated answer.
// This is a QUALITY signal, distinct from the hard-failure reasons above --
// see availability.js's recordSoftFailure for why it must never trip
// sampler.js's circuit breaker. Deliberately conservative (few, high-
// precision patterns) since a false positive here wrongly demotes a model
// that gave a perfectly good short answer ("no" is a valid response to a
// yes/no question, not a refusal).
const SOFT_REFUSAL_RE = /^\s*(?:i(?:'m| am) (?:sorry|unable to|not able to)|i can(?:not|'t) (?:help|assist|provide|comply)|as an ai(?: language model)?,? i|i (?:won't|will not) (?:be able to |help)|unfortunately,? i (?:cannot|can't|am unable))/i;
function isSoftRefusal(text) {
  return typeof text === 'string' && SOFT_REFUSAL_RE.test(text);
}
// A response finishing on a mid-word/mid-sentence cutoff with no terminal
// punctuation, past a length where truncation is a plausible false-positive
// on a legitimately short reply (e.g. "ok" or "42"), reads as suspiciously
// truncated -- most often a max_tokens cutoff the model hit mid-thought.
function isSuspiciouslyTruncated(text) {
  if (typeof text !== 'string' || text.length < 40) return false;
  const trimmed = text.trimEnd();
  return !/[.!?"'\)\]。！？`]$/.test(trimmed) && !/```$/.test(trimmed);
}

function rejectAfter(ms) {
  return new Promise((_, rej) => setTimeout(() => { const e = new Error('timeout'); e.code = 'TIMEOUT'; rej(e); }, ms));
}

async function* withTimeout(iter, ms) {
  const it = iter[Symbol.asyncIterator] ? iter[Symbol.asyncIterator]() : iter;
  while (true) {
    const next = it.next();
    const timer = new Promise((_, rej) => setTimeout(() => { const e = new Error('timeout'); e.code = 'TIMEOUT'; rej(e); }, ms));
    const { value, done } = await Promise.race([next, timer]);
    if (done) return;
    yield value;
  }
}

module.exports = { runStream, runChat, normalizeLink, FALLBACK_REASONS, classifyError, shouldFallback, prefixOf, preCheck, reorderByMatrix, snapshotAvailabilityRanks };
