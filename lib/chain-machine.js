'use strict';
const { setup, createActor, assign } = require('xstate');

const FALLBACK_REASONS = ['error', 'timeout', 'rate_limit', 'empty', 'content_policy', 'sampler_backoff', 'matrix_block'];

function classifyError(err) {
  const msg = (err && err.message) || '';
  if (/rate.?limit|429|quota/i.test(msg)) return 'rate_limit';
  if (/timeout|timed out/i.test(msg)) return 'timeout';
  if (/content.?policy|safety|blocked/i.test(msg)) return 'content_policy';
  return 'error';
}

function shouldFallback(reason, fallbackOn) {
  if (!fallbackOn || fallbackOn.length === 0) return reason === 'error';
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

function preCheck(link, opts) {
  const prefix = prefixOf(link.model);
  if (!prefix) return { ok: true };
  if (opts.sampler !== false) {
    const sampler = (opts.sampler && typeof opts.sampler === 'object') ? opts.sampler : require('./sampler');
    if (typeof sampler.isAvailable === 'function' && !sampler.isAvailable(prefix)) {
      return { ok: false, reason: 'sampler_backoff' };
    }
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

function createChainActor(links) {
  const actor = createActor(machine, { input: { links } });
  actor.start();
  return actor;
}

async function* runStream(linksIn, opts, streamFn, registerRun) {
  await hydrateMatrix(opts);
  const links = reorderByMatrix(linksIn, opts);
  const actor = createChainActor(links);
  if (registerRun) registerRun(actor, { requestedModel: opts._requestedModel || links[0]?.model, resolvedLinks: links.map(l => l.model) });
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
    const callOpts = { ...opts, ...link, model: link.model };
    const fallbackOn = link.fallbackOn || opts.fallbackOn || ['error'];
    const timeout = link.timeout || opts.timeout || 0;
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
      const pfx = prefixOf(link.model);
      const nextPfx = prefixOf(links[snap.context.index + 1]?.model);
      if (pfx && opts.sampler !== false && pfx !== nextPfx && reason !== 'error') { try { require('./sampler').markFailed(pfx); } catch {} }
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
    console.log(`[chain] stream ok provider=${pfx || 'unknown'} model=${link.model} ms=${Date.now() - t0}`);
    actor.send({ type: 'SUCCESS' });
  }
}

async function runChat(linksIn, opts, chatFn, registerRun) {
  await hydrateMatrix(opts);
  const links = reorderByMatrix(linksIn, opts);
  const actor = createChainActor(links);
  if (registerRun) registerRun(actor, { requestedModel: opts._requestedModel || links[0]?.model, resolvedLinks: links.map(l => l.model) });
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
    const callOpts = { ...opts, ...link, model: link.model };
    const fallbackOn = link.fallbackOn || opts.fallbackOn || ['error'];
    const timeout = link.timeout || opts.timeout || 0;
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
      console.log(`[chain] chat ok provider=${pfx || 'unknown'} model=${link.model} ms=${Date.now() - t0}`);
      actor.send({ type: 'SUCCESS' });
      result.__chainAttempted = attempted;
      return result;
    } catch (e) {
      const reason = e.code === 'TIMEOUT' ? 'timeout' : classifyError(e);
      attempted.push({ model: link.model, ms: Date.now() - t0, ok: false, reason });
      const pfx = prefixOf(link.model);
      const nextPfx = prefixOf(links[snap.context.index + 1]?.model);
      if (pfx && opts.sampler !== false && pfx !== nextPfx && reason !== 'error') { try { require('./sampler').markFailed(pfx); } catch {} }
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

module.exports = { runStream, runChat, normalizeLink, FALLBACK_REASONS, classifyError, shouldFallback, prefixOf, preCheck, reorderByMatrix };
