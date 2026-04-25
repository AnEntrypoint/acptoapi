'use strict';
const { setup, createActor, assign } = require('xstate');

const FALLBACK_REASONS = ['error', 'timeout', 'rate_limit', 'empty', 'content_policy'];

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

const machine = setup({
  types: {},
  actions: {
    advance: assign({ index: ({ context }) => context.index + 1, lastReason: (_, params) => params?.reason || null, lastError: (_, params) => params?.error || null }),
    recordSuccess: assign({ servedBy: ({ context }) => context.links[context.index]?.model, succeededAt: () => Date.now() }),
  },
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
        SUCCESS: { target: 'done', actions: 'recordSuccess' },
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

async function* runStream(links, opts, streamFn, registerRun) {
  const actor = createChainActor(links);
  const runId = registerRun ? registerRun(actor) : null;
  while (true) {
    const snap = actor.getSnapshot();
    if (snap.value === 'exhausted') {
      const err = snap.context.lastError || new Error('All chain links failed');
      err.chainHistory = snap.context.history;
      throw err;
    }
    if (snap.value === 'done') return;
    const link = snap.context.links[snap.context.index];
    const callOpts = { ...opts, ...link, model: link.model };
    const fallbackOn = link.fallbackOn || opts.fallbackOn || ['error'];
    const timeout = link.timeout || opts.timeout || 0;
    let any = false, finished = false;
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
      if (shouldFallback(reason, fallbackOn)) {
        if (opts.onFallback) try { opts.onFallback({ from: link.model, to: links[snap.context.index + 1]?.model, reason, error: e }); } catch {}
        actor.send({ type: 'FALLBACK', reason, error: e });
        continue;
      }
      throw e;
    }
    if (finished && !any && shouldFallback('empty', fallbackOn)) {
      const e = new Error(`Empty response from ${link.model}`);
      if (opts.onFallback) try { opts.onFallback({ from: link.model, to: links[snap.context.index + 1]?.model, reason: 'empty', error: e }); } catch {}
      actor.send({ type: 'FALLBACK', reason: 'empty', error: e });
      continue;
    }
    actor.send({ type: 'SUCCESS' });
  }
}

async function runChat(links, opts, chatFn, registerRun) {
  const actor = createChainActor(links);
  if (registerRun) registerRun(actor);
  while (true) {
    const snap = actor.getSnapshot();
    if (snap.value === 'exhausted') {
      const err = snap.context.lastError || new Error('All chain links failed');
      err.chainHistory = snap.context.history;
      throw err;
    }
    const link = snap.context.links[snap.context.index];
    const callOpts = { ...opts, ...link, model: link.model };
    const fallbackOn = link.fallbackOn || opts.fallbackOn || ['error'];
    const timeout = link.timeout || opts.timeout || 0;
    try {
      const promise = chatFn(callOpts);
      const result = timeout > 0 ? await Promise.race([promise, rejectAfter(timeout)]) : await promise;
      const empty = isEmptyResult(result);
      if (empty && shouldFallback('empty', fallbackOn)) {
        const e = new Error(`Empty response from ${link.model}`);
        if (opts.onFallback) try { opts.onFallback({ from: link.model, to: links[snap.context.index + 1]?.model, reason: 'empty', error: e }); } catch {}
        actor.send({ type: 'FALLBACK', reason: 'empty', error: e });
        continue;
      }
      actor.send({ type: 'SUCCESS' });
      return result;
    } catch (e) {
      const reason = e.code === 'TIMEOUT' ? 'timeout' : classifyError(e);
      if (shouldFallback(reason, fallbackOn)) {
        if (opts.onFallback) try { opts.onFallback({ from: link.model, to: links[snap.context.index + 1]?.model, reason, error: e }); } catch {}
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

module.exports = { runStream, runChat, normalizeLink, FALLBACK_REASONS, classifyError, shouldFallback };
