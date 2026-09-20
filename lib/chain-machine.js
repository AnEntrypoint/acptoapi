'use strict';
const { setup, createActor, assign } = require('xstate');

const FALLBACK_REASONS = ['error', 'timeout', 'rate_limit', 'empty', 'content_policy', 'sampler_backoff', 'matrix_block', 'auth', 'fetch_failed', 'credit_dead'];

const DEFAULT_LINK_TIMEOUT_MS = Number(process.env.ACPTOAPI_CHAIN_LINK_TIMEOUT_MS) || 120000;

function classifyError(err) {
  if (err && (err.name === 'AbortError' || err.code === 'ABORT_ERR')) return 'aborted';
  const status = err && err.status;
  const msg = (err && err.message) || '';
  if (/creditserror|no payment method|insufficient credits|payment.?required/i.test(msg)) return 'credit_dead';
  const code = err && err.code;
  if (code === 'RATE_LIMIT') return 'rate_limit';
  if (code === 'AUTH') return 'auth';
  if (code === 'CREDIT_DEAD') return 'credit_dead';
  if (code === 'FETCH_FAILED') return 'fetch_failed';
  if (code === 'TIMEOUT') return 'timeout';
  if (status === 401 || status === 403) return 'auth';
  if (status === 402) return 'credit_dead';
  if (status === 429) return 'rate_limit';
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

const HARDCODED_AGGREGATOR_PREFIXES = new Set(['openrouter']);
function isAggregatorPrefix(provider) {
  if (HARDCODED_AGGREGATOR_PREFIXES.has(provider)) return true;
  try {
    return require('./extra-providers').isMultiModelPrefix(provider);
  } catch {
    return false;
  }
}

function retryAfterMsFor(reason, err) {
  if (reason !== 'rate_limit') return undefined;
  try { return require('./errors').parseRetryDelay(err) ?? undefined; } catch { return undefined; }
}

const SAME_LINK_RETRY_REASONS = new Set(['timeout', 'error', 'fetch_failed', 'empty']);
const SAME_LINK_RETRY_BASE_MS = Number(process.env.ACPTOAPI_SAME_LINK_RETRY_BASE_MS) || 1000;
const SAME_LINK_RETRY_STEP_MAX_MS = Number(process.env.ACPTOAPI_SAME_LINK_RETRY_STEP_MAX_MS) || 15000;
const SAME_LINK_CONSECUTIVE_REASON_CAP = Number(process.env.ACPTOAPI_SAME_LINK_CONSECUTIVE_REASON_CAP) || 4;
const SAME_LINK_RETRY_BUDGET_MS = Number(process.env.ACPTOAPI_SAME_LINK_RETRY_BUDGET_MS) || 10 * 60 * 1000;
const CHAIN_WALL_CLOCK_BUDGET_MS = Number(process.env.ACPTOAPI_CHAIN_WALL_CLOCK_BUDGET_MS) || 90000;

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

const inFlightFailures = new Map();
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

function waitForLeadLinkPrecheck(link, opts, isLeadLink) {
  if (!isLeadLink) return null;
  const pc = preCheck(link, opts);
  if (!pc.ok && pc.reason === 'sampler_backoff') return { ok: true };
  return pc;
}

function markProviderFailed(model, reason, opts) {
  if (opts.sampler === false || !PROVIDER_LEVEL_HEALTH_REASONS.has(reason)) return;
  const provider = prefixOf(model);
  if (!provider) return;
  if (reason === 'credit_dead') {
    try { require('./availability').markCreditDead(model); } catch {}
  }
  if (isAggregatorPrefix(provider)) return;
  try {
    require('./sampler').markFailed(provider, reason);
  } catch (e) {
    console.error(`[chain] sampler.markFailed threw for provider=${provider}: ${e.message}`);
  }
}

const MIN_FAILSTREAK_TO_SKIP_MODEL = Number(process.env.ACPTOAPI_MODEL_SKIP_FAILSTREAK) || 5;

const modelProbeClaimedUntil = new Map();
const MODEL_PROBE_CLAIM_HOLD_MS = Number(process.env.ACPTOAPI_MODEL_PROBE_CLAIM_MS) || 30000;

function claimModelProbeSlot(model) {
  const now = Date.now();
  const claimedUntil = modelProbeClaimedUntil.get(model);
  if (claimedUntil && claimedUntil > now) return false;
  modelProbeClaimedUntil.set(model, now + MODEL_PROBE_CLAIM_HOLD_MS);
  return true;
}

function preCheck(link, opts) {
  const prefix = prefixOf(link.model);
  if (!prefix) return { ok: true };
  if (opts.sampler !== false && !isAggregatorPrefix(prefix)) {
    const sampler = (opts.sampler && typeof opts.sampler === 'object') ? opts.sampler : require('./sampler');
    if (typeof sampler.isAvailable === 'function' && !sampler.isAvailable(prefix)) {
      return { ok: false, reason: 'sampler_backoff' };
    }
  }
  if (opts.modelHealth !== false) {
    try {
      const availability = require('./availability');
      if (availability.isCreditDead(link.model)) {
        return { ok: false, reason: 'credit_dead' };
      }
      if (availability.isRetryDeadlineActive(link.model)) {
        return { ok: false, reason: 'model_unhealthy' };
      }
      const peeked = availability.peek(link.model);
      if (peeked && peeked.effectiveFailStreak >= MIN_FAILSTREAK_TO_SKIP_MODEL && peeked.rank < 0) {
        if (!claimModelProbeSlot(link.model)) return { ok: false, reason: 'model_unhealthy' };
      }
      if (peeked && !peeked.lastSuccessTs && peeked.totalSamples >= MIN_FAILSTREAK_TO_SKIP_MODEL && peeked.lastFailTs != null) {
        if (!claimModelProbeSlot(link.model)) return { ok: false, reason: 'model_unhealthy' };
      }
    } catch {}
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
  if (links.length === 0) {
    const err = new Error('No available chain links: every provider/model was filtered out (missing credentials, ACP daemons disabled, or sampler backoff) before dispatch was attempted.');
    err.code = 'NO_CHAIN_LINKS';
    err.chainHistory = [];
    err.attempted = [];
    throw err;
  }
  const actor = createChainActor(links);
  if (registerRun) registerRun(actor, { requestedModel: opts._requestedModel || links[0]?.model, resolvedLinks: links.map(l => l.model), resolvedLinksWithRank: snapshotAvailabilityRanks(links) });
  const attempted = [];
  const chainStartedAt = Date.now();
  const chainBudgetMs = typeof opts.chainBudgetMs === 'number' ? opts.chainBudgetMs : CHAIN_WALL_CLOCK_BUDGET_MS;
  const chainDeadline = chainBudgetMs > 0 ? chainStartedAt + chainBudgetMs : Infinity;
  const sameLinkRetryBudgetMs = typeof opts.sameLinkRetryBudgetMs === 'number' ? opts.sameLinkRetryBudgetMs : SAME_LINK_RETRY_BUDGET_MS;
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
    const pc = isLeadLink
      ? waitForLeadLinkPrecheck(link, opts, true)
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
    const fallbackOn = link.fallbackOn || opts.fallbackOn || FALLBACK_REASONS;
    const timeout = link.timeout ?? opts.timeout ?? DEFAULT_LINK_TIMEOUT_MS;
    const callOpts = { ...cleanOpts, ...link, model: link.model, timeout };
    let attempt = 0;
    let outcome = null;
    const linkRetryStartedAt = Date.now();
    let lastReason = null;
    let sameReasonStreak = 0;
    while (true) {
      attempt += 1;
      const t0 = Date.now();
      let contentAlreadyYielded = false, finished = false;
      console.log(`[chain] stream try provider=${prefixOf(link.model) || 'unknown'} model=${link.model} attempt=${snap.context.index + 1}/${links.length}${attempt > 1 ? ` (retry ${attempt - 1})` : ''}`);
      try {
        const iter = streamFn(callOpts);
        const guarded = timeout > 0 ? withTimeout(iter, timeout) : iter;
        for await (const ev of guarded) {
          if (ev && ev.type === 'text-delta' && ev.textDelta) contentAlreadyYielded = true;
          if (ev && ev.type === 'tool-call') contentAlreadyYielded = true;
          yield ev;
        }
        finished = true;
      } catch (e) {
        const reason = e.code === 'TIMEOUT' ? 'timeout' : classifyError(e);
        sameReasonStreak = reason === lastReason ? sameReasonStreak + 1 : 1;
        lastReason = reason;
        const elapsed = Date.now() - linkRetryStartedAt;
        if (!contentAlreadyYielded && SAME_LINK_RETRY_REASONS.has(reason) && elapsed < sameLinkRetryBudgetMs && Date.now() < chainDeadline && sameReasonStreak < SAME_LINK_CONSECUTIVE_REASON_CAP) {
          recordInFlightFailure(link.model);
          const delay = Math.min(sameLinkRetryDelayMs(link.model), sameLinkRetryBudgetMs - elapsed, chainDeadline - Date.now());
          console.log(`[chain] same-link retry reason=${reason} model=${link.model} delayMs=${delay} elapsedMs=${elapsed} sameReasonStreak=${sameReasonStreak}`);
          await sleep(delay);
          continue;
        }
        outcome = { ok: false, reason, error: e, ms: Date.now() - t0 };
        break;
      }
      if (finished && !contentAlreadyYielded && shouldFallback('empty', fallbackOn)) {
        sameReasonStreak = lastReason === 'empty' ? sameReasonStreak + 1 : 1;
        lastReason = 'empty';
        const elapsed = Date.now() - linkRetryStartedAt;
        if (SAME_LINK_RETRY_REASONS.has('empty') && elapsed < sameLinkRetryBudgetMs && Date.now() < chainDeadline && sameReasonStreak < SAME_LINK_CONSECUTIVE_REASON_CAP) {
          recordInFlightFailure(link.model);
          const delay = Math.min(sameLinkRetryDelayMs(link.model), sameLinkRetryBudgetMs - elapsed, chainDeadline - Date.now());
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
  if (links.length === 0) {
    const err = new Error('No available chain links: every provider/model was filtered out (missing credentials, ACP daemons disabled, or sampler backoff) before dispatch was attempted.');
    err.code = 'NO_CHAIN_LINKS';
    err.chainHistory = [];
    err.attempted = [];
    throw err;
  }
  const actor = createChainActor(links);
  if (registerRun) registerRun(actor, { requestedModel: opts._requestedModel || links[0]?.model, resolvedLinks: links.map(l => l.model), resolvedLinksWithRank: snapshotAvailabilityRanks(links) });
  const attempted = [];
  const chainStartedAt = Date.now();
  const chainBudgetMs = typeof opts.chainBudgetMs === 'number' ? opts.chainBudgetMs : CHAIN_WALL_CLOCK_BUDGET_MS;
  const chainDeadline = chainBudgetMs > 0 ? chainStartedAt + chainBudgetMs : Infinity;
  const sameLinkRetryBudgetMs = typeof opts.sameLinkRetryBudgetMs === 'number' ? opts.sameLinkRetryBudgetMs : SAME_LINK_RETRY_BUDGET_MS;
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
    const pc = isLeadLink
      ? waitForLeadLinkPrecheck(link, opts, true)
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
    const fallbackOn = link.fallbackOn || opts.fallbackOn || FALLBACK_REASONS;
    const timeout = link.timeout ?? opts.timeout ?? DEFAULT_LINK_TIMEOUT_MS;
    const callOpts = { ...cleanOpts, ...link, model: link.model, timeout };
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
          if (SAME_LINK_RETRY_REASONS.has('empty') && elapsed < sameLinkRetryBudgetMs && Date.now() < chainDeadline && sameReasonStreak < SAME_LINK_CONSECUTIVE_REASON_CAP) {
            recordInFlightFailure(link.model);
            const delay = Math.min(sameLinkRetryDelayMs(link.model), sameLinkRetryBudgetMs - elapsed, chainDeadline - Date.now());
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
        if (SAME_LINK_RETRY_REASONS.has(reason) && elapsed < sameLinkRetryBudgetMs && Date.now() < chainDeadline && sameReasonStreak < SAME_LINK_CONSECUTIVE_REASON_CAP) {
          recordInFlightFailure(link.model);
          const delay = Math.min(sameLinkRetryDelayMs(link.model), sameLinkRetryBudgetMs - elapsed, chainDeadline - Date.now());
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
      recordResponseQualitySignal(link.model, result);
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

function extractText(r) {
  if (!r) return '';
  if (typeof r === 'string') return r;
  if (r.choices) return (r.choices[0]?.message?.content) || '';
  if (Array.isArray(r.content)) return r.content.filter(b => b && b.type === 'text' && b.text).map(b => b.text).join('');
  return '';
}

const SOFT_REFUSAL_RE = /^\s*(?:i(?:'m| am) (?:sorry|unable to|not able to)|i can(?:not|'t) (?:help|assist|provide|comply)|as an ai(?: language model)?,? i|i (?:won't|will not) (?:be able to |help)|unfortunately,? i (?:cannot|can't|am unable))/i;
function isSoftRefusal(text) {
  return typeof text === 'string' && SOFT_REFUSAL_RE.test(text);
}
const TRUNCATION_SUSPECT_MIN_LENGTH = 40;
function isSuspiciouslyTruncated(text) {
  if (typeof text !== 'string' || text.length < TRUNCATION_SUSPECT_MIN_LENGTH) return false;
  const trimmed = text.trimEnd();
  return !/[.!?"'\)\]。！？`]$/.test(trimmed) && !/```$/.test(trimmed);
}

function recordResponseQualitySignal(model, result) {
  try {
    const text = extractText(result);
    const soft = isSoftRefusal(text) || isSuspiciouslyTruncated(text);
    const av = require('./availability');
    if (soft) av.recordSoftFailure(model); else av.recordSoftSuccess(model);
  } catch {}
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

module.exports = { runStream, runChat, normalizeLink, FALLBACK_REASONS, classifyError, shouldFallback, prefixOf, preCheck, reorderByMatrix, snapshotAvailabilityRanks, retryAfterMsFor };
