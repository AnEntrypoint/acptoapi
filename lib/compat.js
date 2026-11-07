const { GoogleGenAI } = require('@google/genai');
const keyring = require('./keyring');
const { setup, createActor, fromCallback } = require('xstate');
const { getProvider } = require('./providers/index');
const { getFormat } = require('./formats/index');
const { translate } = require('./translate');
const { createFormatServer } = require('./server/format-server');


let _client = null;

function getClient(apiKey) {
  if (!_client || apiKey) _client = new GoogleGenAI({ apiKey: apiKey || keyring.getKey('GEMINI_API_KEY') });
  return _client;
}

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

class Anthropic {
  constructor({ provider = 'gemini', apiKey, baseURL, defaultHeaders = {}, ...config } = {}) {
    this._provider = defaultHeaders['x-provider'] || provider;
    this._apiKey = apiKey;
    this._config = config;
    this.messages = {
      create: (params) => this._create(params),
      stream: (params) => this._stream(params),
    };
  }

  _opts(params) {
    return { from: 'anthropic', provider: this._provider, apiKey: this._apiKey, ...params };
  }

  _stream(params) {
    return { fullStream: translate(this._opts(params)), warnings: Promise.resolve([]) };
  }

  async _create(params) {
    if (params.stream) return this._stream(params);
    const fmt = getFormat('anthropic');
    const events = [];
    for await (const ev of translate(this._opts(params))) events.push(ev);
    return fmt.toResponse(events);
  }
}

class OpenAI {
  constructor({ baseURL, apiKey, provider = 'openai-compat', ...config } = {}) {
    this._provider = provider;
    this._apiKey = apiKey;
    this._baseURL = baseURL;
    this._config = config;
    this.chat = {
      completions: {
        create: (params) => this._create(params),
      },
    };
  }

  _opts(params) {
    return {
      from: 'openai',
      provider: this._provider,
      apiKey: this._apiKey,
      url: this._baseURL ? this._baseURL + '/chat/completions' : undefined,
      ...params,
    };
  }

  _stream(params) {
    return translate(this._opts(params));
  }

  async _create(params) {
    if (params.stream) return this._stream(params);
    const fmt = getFormat('openai');
    const events = [];
    for await (const ev of translate(this._opts(params))) events.push(ev);
    return fmt.toResponse(events);
  }
}

const ANTHROPIC_LANDING = '<!doctype html><html><body><h1>acptoapi  - Anthropic proxy</h1><p>POST /v1/messages</p></body></html>';

const createAnthropicServer = createFormatServer({
  landing: ANTHROPIC_LANDING,
  path: '/v1/messages',
  from: 'anthropic',
  format: 'anthropic',
  errorTypes: { invalid: 'invalid_request', server: 'server_error', notFound: 'not_found' },
  errorShape: (type, message) => ({ error: { type, message } }),
  responseFrom: (fmt, events) => fmt.toResponse(events),
});

const OPENAI_LANDING = '<!doctype html><html><body><h1>acptoapi  - OpenAI proxy</h1><p>POST /v1/chat/completions</p></body></html>';

const createOpenAIServer = createFormatServer({
  landing: OPENAI_LANDING,
  path: '/v1/chat/completions',
  from: 'openai',
  format: 'openai',
  errorTypes: { invalid: 'invalid_request_error', server: 'server_error', notFound: 'not_found' },
  errorShape: (type, message) => ({ error: { message, type } }),
  responseFrom: (fmt, events, opts) => fmt.toResponse(events, opts.model || ''),
});

module.exports = { getClient, createStreamActor, Anthropic, OpenAI, createAnthropicServer, createOpenAIServer };
