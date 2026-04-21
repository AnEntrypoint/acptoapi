import http from 'http';
import { splitModel, resolveBackend, createSession, sendMessage, streamEvents, probe, BACKENDS } from './acp-client.js';
import { openAIMessagesToACP, createEventMapper, makeChunk, makeFinal, genId } from './translate.js';

const json = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Private-Network': 'true' });
  res.end(JSON.stringify(body));
};

const sse = (res, chunk) => res.write(`data: ${JSON.stringify(chunk)}\n\n`);

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

async function listModels() {
  const results = await Promise.all(['kilo', 'opencode'].map(async prefix => {
    const b = resolveBackend(prefix);
    const ok = await probe(b, 1500);
    return { prefix, ok, default: b.defaultModel };
  }));
  const created = Math.floor(Date.now() / 1000);
  const MODEL_CATALOG = {
    kilo: ['x-ai/grok-code-fast-1:optimized:free', 'kilo-auto/free', 'openrouter/free', 'stepfun/step-3.5-flash:free', 'nvidia/nemotron-3-super-120b-a12b:free'],
    opencode: ['minimax-m2.5-free', 'nemotron-3-super-free'],
  };
  const seen = new Set();
  const data = [];
  for (const r of results) {
    if (!r.ok) continue;
    for (const m of MODEL_CATALOG[r.prefix]) {
      const id = `${r.prefix}/${m}`;
      if (seen.has(id)) continue;
      seen.add(id);
      data.push({ id, object: 'model', owned_by: r.prefix, created });
    }
  }
  return { object: 'list', data };
}

async function handleChat(req, res, backends) {
  const body = await readBody(req);
  const { prefix, model } = splitModel(body.model);
  const backend = resolveBackend(prefix, backends);
  const prompt = openAIMessagesToACP(body.messages || []);
  const id = genId();
  const stream = body.stream === true;

  const sessionId = await createSession(backend);
  const ctrl = new AbortController();
  const mapper = createEventMapper(id, body.model || `${prefix}/${model}`);
  let fullText = '';
  let finished = false;

  if (stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Private-Network': 'true' });
  }

  const emit = chunk => {
    if (chunk.choices?.[0]?.delta?.content) fullText += chunk.choices[0].delta.content;
    if (stream) sse(res, chunk);
  };

  const msgPromise = sendMessage(backend, sessionId, prompt, model).then(r => r.text()).catch(e => { throw e; });

  try {
    for await (const ev of streamEvents(backend, sessionId, ctrl.signal)) {
      const isTerminal = mapper.mapEvent(ev, emit);
      if (isTerminal) { finished = true; break; }
    }
  } catch (e) {
    if (!finished) {
      if (stream) { sse(res, { error: { message: e.message } }); res.end(); }
      else json(res, 500, { error: { message: e.message } });
      return;
    }
  } finally {
    ctrl.abort();
  }

  await msgPromise.catch(() => {});

  if (stream) {
    sse(res, makeChunk(id, body.model || `${prefix}/${model}`, {}, 'stop'));
    res.write('data: [DONE]\n\n');
    res.end();
  } else {
    json(res, 200, makeFinal(id, body.model || `${prefix}/${model}`, fullText));
  }
}

export function createServer({ port = 4800, backends = {} } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Private-Network': 'true', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization' }); return res.end(); }
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/v1/models' && req.method === 'GET') return json(res, 200, await listModels());
      if (url.pathname === '/v1/chat/completions' && req.method === 'POST') return handleChat(req, res, backends);
      if (url.pathname === '/health') return json(res, 200, { ok: true, backends: Object.keys(BACKENDS) });
      json(res, 404, { error: { message: 'not found: ' + url.pathname } });
    } catch (e) {
      json(res, 500, { error: { message: e.message, stack: e.stack } });
    }
  });
  return new Promise((resolve, reject) => {
    server.listen(port, () => {
      const actual = server.address().port;
      console.log(`acp2openai listening http://localhost:${actual}`);
      resolve({ server, port: actual });
    });
    server.on('error', reject);
  });
}
