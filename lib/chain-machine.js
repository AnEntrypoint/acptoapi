'use strict';
const { setup, createActor, assign } = require('xstate');

const FALLBACK_REASONS = ['error', 'timeout', 'rate_limit', 'empty', 'content_policy', 'sampler_backoff', 'matrix_block', 'auth', 'fetch_failed'];

// A per-hop timeout of 0 (unbounded) is the wrong default for a multi-link
// chain: a single overloaded provider can then consume the ENTIRE caller
// budget by itself before the chain ever falls through to the next link.
// Live-witnessed (round 1): nvidia's own infra returned a 503 "Worker local
// total request limit reached" after 44 SECONDS -- against a chain whose
// overall caller-side timeout was 120s, one slow hop alone could eat over a
// third of it. Live-witnessed AGAIN (round 2, tighter caller budget): a
// genuinely SUCCEEDING call (nvidia/deepseek-ai/deepseek-v4-flash, real 200
// response, not an error) still took 17.6 SECONDS against a caller-side
// budget of only 60s (casey's CASEY_TURN_HARD_DEADLINE_MS) walking a 12-link
// chain -- one hop alone consumed nearly 30% of the entire turn's time
// budget, starving the remaining ~10 candidates of any real chance. The
// original 20s default assumed "all confirmed sub-2s live," which round 2
// directly disproved: real provider latency varies far more than that
// assumption held, and a caller with a SHORT overall budget (60s, not 120s)
// needs a correspondingly shorter per-hop ceiling so a chain of many
// candidates can actually be walked within it. 10s still comfortably covers
// any hop this project's providers have shown succeeding under normal load
// (median observed ~3s) while capping a single outlier's damage to roughly
// 1/6 of a 60s budget instead of 1/3. A caller that wants a different bound
// still can via link.timeout/opts.timeout, which take priority over this
// default exactly as before.
const DEFAULT_LINK_TIMEOUT_MS = 10000;

function classifyError(err) {
  const code = err && err.code;
  if (code === 'RATE_LIMIT') return 'rate_limit';
  if (code === 'AUTH') return 'auth';
  if (code === 'FETCH_FAILED') return 'fetch_failed';
  if (code === 'TIMEOUT') return 'timeout';
  const msg = (err && err.message) || '';
  if (/rate.?limit|429|quota/i.test(msg)) return 'rate_limit';
  if (/timeout|timed out/i.test(msg)) return 'timeout';
  if (/content.?policy|safety|blocked/i.test(msg)) return 'content_policy';
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i.test(msg)) return 'fetch_failed';
  if (/401|403|invalid api key|unauthorized/i.test(msg)) return 'auth';
  return 'error';
}

function shouldFallback(reason, fallbackOn) {
  // Default to falling back on ALL transient reasons (not just 'error') so the
  // chain seamlessly advances to the next provider and a rate_limit/auth/timeout
  // is never surfaced to the caller.
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

// Reasons that reflect the PROVIDER itself being unhealthy (down, rate-limited,
// unauthed, unreachable, timing out, or returning garbage) -- these back off the
// whole provider via the sampler so the NEXT call pre-emptively skips it instead
// of re-discovering the same failure turn after turn. 'content_policy' is
// deliberately excluded: a refusal on THIS prompt says nothing about whether the
// provider can serve the NEXT one, so it must never count against provider
// health. Previously this only fired when `reason !== 'error'` -- but 'error' is
// classifyError's catch-all for "something is actually wrong" (a bad/retired
// model id, a malformed response, an unclassified 5xx), exactly the case that
// most needs backoff; excluding it meant a chain with a single permanently-wrong
// model entry (e.g. a retired model name) NEVER backed off and walked into the
// same dead link on every single call, live-witnessed as repeated multi-second
// full-chain walks before falling through to a working provider on every turn.
const PROVIDER_HEALTH_REASONS = new Set(['error', 'timeout', 'rate_limit', 'auth', 'fetch_failed', 'empty']);

// Pre-emptive backoff write. Failing to call sampler.markFailed here does not
// block the chain (the fallback below still runs on the CURRENT failure), but
// it silently disables pre-emption for every FUTURE call on this provider -- the
// same dead link gets walked into again and again with no operator visibility.
// So this fails LOUD (console.error, not a swallowed catch{}) rather than the
// silent catch{} the two call sites used to each carry inline.
function markProviderFailed(model, reason, opts) {
  if (opts.sampler === false || !PROVIDER_HEALTH_REASONS.has(reason)) return;
  const pfx = prefixOf(model);
  if (!pfx) return;
  try {
    require('./sampler').markFailed(pfx);
  } catch (e) {
    console.error(`[chain] sampler.markFailed threw for provider=${pfx} (pre-emptive backoff for this provider is now BROKEN until this is fixed): ${e.message}`);
  }
}

// A model-specific health gate, distinct from the provider-wide sampler
// backoff above. The sampler only trips when an ENTIRE provider prefix looks
// dead; it says nothing about one specific model within an otherwise-healthy
// provider that has been failing repeatedly (a retired/renamed model id, a
// model this account's key cannot reach, a model consistently over capacity).
// availability.js already tracks this per-model streak but, before this fix,
// only used it to SORT the chain -- a model with e.g. 19 straight failures
// still consumed a real network round-trip (and its own DEFAULT_LINK_TIMEOUT_MS
// budget) on every single call that reached it, live-witnessed burning through
// several seconds of a turn's deadline on models that were never going to
// succeed. MIN_FAILSTREAK_TO_SKIP is deliberately higher than sampler's own
// bar (which trips on failure #1) so one or two transient failures never skip
// a model outright -- only a real, repeated pattern does, and
// FAILURE_TTL_MS-decayed (effectiveFailStreak) failures never count, so a
// model that recovers hours later is never permanently excluded.
const MIN_FAILSTREAK_TO_SKIP = Number(process.env.ACPTOAPI_MODEL_SKIP_FAILSTREAK) || 5;

function preCheck(link, opts) {
  const prefix = prefixOf(link.model);
  if (!prefix) return { ok: true };
  if (opts.sampler !== false) {
    const sampler = (opts.sampler && typeof opts.sampler === 'object') ? opts.sampler : require('./sampler');
    if (typeof sampler.isAvailable === 'function' && !sampler.isAvailable(prefix)) {
      return { ok: false, reason: 'sampler_backoff' };
    }
  }
  if (opts.modelHealth !== false) {
    try {
      const availability = require('./availability');
      const peeked = availability.peek(link.model);
      if (peeked && peeked.failStreak >= MIN_FAILSTREAK_TO_SKIP && availability.score(link.model) < 0) {
        return { ok: false, reason: 'model_unhealthy' };
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
  // Stable partition: ok=true first, ok=null neutral, ok=false last
  scored.sort((a, b) => {
    const rank = (x) => x.ok === true ? 0 : x.ok === null ? 1 : 2;
    return rank(a) - rank(b) || a.i - b.i;
  });
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

// Snapshot each link's availability rank (from lib/availability.js) at the moment
// the chain is built, so a later run's history can be correlated against the
// scoring that produced this order rather than only the flat model list. Best-
// effort: availability.js failures (e.g. cache read error) must not block a run.
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
  while (true) {
    const snap = actor.getSnapshot();
    if (snap.value === 'exhausted') {
      const err = snap.context.lastError || new Error('All chain links failed');
      err.chainHistory = snap.context.history;
      err.attempted = attempted;
      throw err;
    }
    if (snap.value === 'done') return;
    const link = snap.context.links[snap.context.index];
    const pc = preCheck(link, opts);
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
    const t0 = Date.now();
    let any = false, finished = false;
    console.log(`[chain] stream try provider=${prefixOf(link.model) || 'unknown'} model=${link.model} attempt=${snap.context.index + 1}/${links.length}`);
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
      attempted.push({ model: link.model, ms: Date.now() - t0, ok: false, reason });
      markProviderFailed(link.model, reason, opts);
      try { require('./availability').recordFailure(link.model); } catch {}
      if (shouldFallback(reason, fallbackOn)) {
        const _next = links[snap.context.index + 1]?.model;
        console.log(`[chain] fallback reason=${reason} from=${link.model}${_next ? ` to=${_next}` : ' (exhausted)'}`);
        if (opts.onFallback) try { opts.onFallback({ from: link.model, to: _next, reason, error: e }); } catch {}
        actor.send({ type: 'FALLBACK', reason, error: e });
        continue;
      }
      throw e;
    }
    if (finished && !any && shouldFallback('empty', fallbackOn)) {
      const e = new Error(`Empty response from ${link.model}`);
      attempted.push({ model: link.model, ms: Date.now() - t0, ok: false, reason: 'empty' });
      const _next = links[snap.context.index + 1]?.model;
      console.log(`[chain] fallback reason=empty from=${link.model}${_next ? ` to=${_next}` : ' (exhausted)'}`);
      if (opts.onFallback) try { opts.onFallback({ from: link.model, to: _next, reason: 'empty', error: e }); } catch {}
      actor.send({ type: 'FALLBACK', reason: 'empty', error: e });
      continue;
    }
    attempted.push({ model: link.model, ms: Date.now() - t0, ok: true, reason: null });
    const pfx = prefixOf(link.model);
    if (pfx && opts.sampler !== false) { try { require('./sampler').markOk(pfx); } catch {} }
    try { require('./availability').recordSuccess(link.model, Date.now() - t0); } catch {}
    console.log(`[chain] stream ok provider=${pfx || 'unknown'} model=${link.model} ms=${Date.now() - t0}`);
    actor.send({ type: 'SUCCESS' });
  }
}

async function runChat(linksIn, opts, chatFn, registerRun) {
  await hydrateMatrix(opts);
  const links = reorderByMatrix(linksIn, opts);
  const actor = createChainActor(links);
  if (registerRun) registerRun(actor, { requestedModel: opts._requestedModel || links[0]?.model, resolvedLinks: links.map(l => l.model), resolvedLinksWithRank: snapshotAvailabilityRanks(links) });
  const attempted = [];
  while (true) {
    const snap = actor.getSnapshot();
    if (snap.value === 'exhausted') {
      const err = snap.context.lastError || new Error('All chain links failed');
      err.chainHistory = snap.context.history;
      err.attempted = attempted;
      throw err;
    }
    const link = snap.context.links[snap.context.index];
    const pc = preCheck(link, opts);
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
    const t0 = Date.now();
    console.log(`[chain] chat try provider=${prefixOf(link.model) || 'unknown'} model=${link.model} attempt=${snap.context.index + 1}/${links.length}`);
    try {
      const promise = chatFn(callOpts);
      const result = timeout > 0 ? await Promise.race([promise, rejectAfter(timeout)]) : await promise;
      const empty = isEmptyResult(result);
      if (empty && shouldFallback('empty', fallbackOn)) {
        const e = new Error(`Empty response from ${link.model}`);
        attempted.push({ model: link.model, ms: Date.now() - t0, ok: false, reason: 'empty' });
        if (opts.onFallback) try { opts.onFallback({ from: link.model, to: links[snap.context.index + 1]?.model, reason: 'empty', error: e }); } catch {}
        actor.send({ type: 'FALLBACK', reason: 'empty', error: e });
        continue;
      }
      attempted.push({ model: link.model, ms: Date.now() - t0, ok: true, reason: null });
      const pfx = prefixOf(link.model);
      if (pfx && opts.sampler !== false) { try { require('./sampler').markOk(pfx); } catch {} }
      try { require('./availability').recordSuccess(link.model, Date.now() - t0); } catch {}
      console.log(`[chain] chat ok provider=${pfx || 'unknown'} model=${link.model} ms=${Date.now() - t0}`);
      actor.send({ type: 'SUCCESS' });
      result.__chainAttempted = attempted;
      return result;
    } catch (e) {
      const reason = e.code === 'TIMEOUT' ? 'timeout' : classifyError(e);
      attempted.push({ model: link.model, ms: Date.now() - t0, ok: false, reason });
      markProviderFailed(link.model, reason, opts);
      try { require('./availability').recordFailure(link.model); } catch {}
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
