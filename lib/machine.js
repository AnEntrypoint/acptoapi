const { setup, createActor, fromCallback } = require('xstate');
const { getProvider } = require('./providers/index');
const { getFormat } = require('./formats/index');

function createQueue() {
  const q = []; let resolve = null; let closed = false;
  const push = (v) => { q.push({ value: v, done: false }); if (resolve) { const r = resolve; resolve = null; r(q.shift()); } };
  const close = () => { closed = true; if (resolve) { const r = resolve; resolve = null; r(); } };
  const next = () => new Promise(r => {
    if (q.length) return r(q.shift());
    if (closed) return r({ done: true });
    resolve = r;
  });
  return { push, close, next, get closed() { return closed; } };
}

function makeTranslateActor(provider, fromFmt, toFmt) {
  return fromCallback(({ sendBack, input }) => {
    const { params } = input;
    (async () => {
      try {
        let resolved = params;
        if (fromFmt?.toParams) resolved = fromFmt.toParams(params);
        const sseState = {};
        const calls = [];
        for await (const ev of provider.stream(resolved)) {
          const out = toFmt ? { type: 'sse', raw: toFmt.toSSE(ev, sseState), event: ev } : ev;
          sendBack({ type: 'CHUNK', event: out });
          if (ev.type === 'tool-call') calls.push(ev);
          if (ev.type === 'finish-step') {
            if (calls.length) { sendBack({ type: 'TOOL_CALLS', calls: [...calls] }); }
            else { sendBack({ type: 'DONE' }); }
            return;
          }
        }
        sendBack({ type: 'DONE' });
      } catch (err) {
        sendBack({ type: 'ERROR', error: err });
      }
    })();
    return () => {};
  });
}

const machine = setup({
  actors: { streamActor: fromCallback(({ sendBack }) => { sendBack({ type: 'DONE' }); return () => {}; }) },
}).createMachine({
  id: 'translateLoop',
  initial: 'idle',
  context: ({ input }) => ({ params: input?.params || {}, events: [], toolCalls: [], provider: input?.provider }),
  states: {
    idle: { on: { START: { target: 'streaming', actions: ({ context, event }) => { context.params = event.params; context.provider = event.provider; } } } },
    streaming: {
      invoke: {
        src: 'streamActor',
        input: ({ context }) => ({ params: context.params, provider: context.provider }),
        onError: { target: 'error', actions: ({ context, event }) => { context.lastError = event.error; } },
      },
      on: {
        CHUNK: { actions: ({ context, event }) => { context.events.push(event.event); } },
        TOOL_CALLS: { target: 'toolLoop', actions: ({ context, event }) => { context.toolCalls = event.calls; } },
        DONE: { target: 'done' },
        ERROR: { target: 'error', actions: ({ context, event }) => { context.lastError = event.error; } },
      },
    },
    toolLoop: {
      entry: ({ context }) => { context.toolCalls = []; },
      on: {
        TOOL_RESULTS: { target: 'streaming', actions: ({ context, event }) => {
          context.params = { ...context.params, messages: [...(context.params.messages || []), ...event.results] };
        }},
      },
    },
    done: { type: 'final' },
    error: { type: 'final' },
  },
});

function createStreamActor(params, providerName, { from, to } = {}) {
  const provider = getProvider(providerName || params.provider || 'gemini');
  const fromFmt = from ? getFormat(from) : null;
  const toFmt = to ? getFormat(to) : null;
  const streamActorImpl = makeTranslateActor(provider, fromFmt, toFmt);
  const queue = createQueue();
  const resolvedMachine = machine.provide({ actors: { streamActor: streamActorImpl } });
  const actor = createActor(resolvedMachine, { input: { params, provider } });
  let seen = 0;
  actor.subscribe(snapshot => {
    const evs = snapshot.context.events;
    while (seen < evs.length) queue.push(evs[seen++]);
    if (snapshot.status === 'done' || snapshot.status === 'error') queue.close();
  });
  actor.start();
  actor.send({ type: 'START', params, provider });
  async function* stream() {
    while (true) {
      const { value, done } = await queue.next();
      if (done) return;
      yield value;
    }
  }
  return { actor, stream: stream() };
}

module.exports = { createStreamActor };
