'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { splitModel, resolveBackend, createSession, sendMessage, streamEvents, probe, BACKENDS } = require('./acp-client');
const { openAIMessagesToACP, createEventMapper, makeChunk, makeFinal, genId } = require('./translate');
const { isClaudeModel, parseClaudeModel, probeClaude, streamClaude, CLAUDE_MODELS } = require('./claude-client');
const { createClaudeMapper } = require('./claude-translate');

const DOCS_DIR = path.resolve(__dirname, '../docs');
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.svg': 'image/svg+xml' };
const serveStatic = (res, rel) => {
  const safe = rel.replace(/\.\.+/g, '').replace(/^\//, '') || 'index.html';
  const full = path.join(DOCS_DIR, safe);
  if (!full.startsWith(DOCS_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found: ' + rel); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
};

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

async function listModels(claudeBin) {
  const acp = await Promise.all(['kilo', 'opencode'].map(async prefix => {
    const b = resolveBackend(prefix);
    const ok = await probe(b, 1500);
    return { prefix, ok };
  }));
  const claudeOk = await probeClaude(claudeBin);
  const created = Math.floor(Date.now() / 1000);
  const MODEL_CATALOG = {
    kilo: ['x-ai/grok-code-fast-1:optimized:free', 'kilo-auto/free', 'openrouter/free', 'stepfun/step-3.5-flash:free', 'nvidia/nemotron-3-super-120b-a12b:free'],
    opencode: ['minimax-m2.5-free', 'nemotron-3-super-free'],
    claude: CLAUDE_MODELS,
  };
  const seen = new Set();
  const data = [];
  for (const r of acp) {
    if (!r.ok) continue;
    for (const m of MODEL_CATALOG[r.prefix]) {
      const id = `${r.prefix}/${m}`;
      if (seen.has(id)) continue;
      seen.add(id);
      data.push({ id, object: 'model', owned_by: r.prefix, created });
    }
  }
  if (claudeOk) {
    for (const m of MODEL_CATALOG.claude) {
      const id = `claude/${m}`;
      if (seen.has(id)) continue;
      seen.add(id);
      data.push({ id, object: 'model', owned_by: 'claude', created });
    }
  }
  return { object: 'list', data };
}

async function handleClaudeChat(req, res, body, claudeBin) {
  const model = parseClaudeModel(body.model);
  const messages = body.messages || [];
  const systemParts = messages.filter(m => m.role === 'system').map(m => typeof m.content === 'string' ? m.content : '').filter(Boolean);
  const convo = messages.filter(m => m.role !== 'system').map(m => {
    const text = typeof m.content === 'string' ? m.content : (m.content || []).map(c => c.type === 'text' ? c.text : '').join('');
    return `${m.role === 'user' ? 'User' : 'Assistant'}: ${text}`;
  }).join('\n\n');
  const systemPrompt = systemParts.join('\n\n');
  const id = genId();
  const stream = body.stream === true;
  const mapper = createClaudeMapper(id, body.model || `claude/${model}`);
  let fullText = '';
  let finishReason = 'stop';
  let usage = null;

  if (stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Private-Network': 'true' });
  }

  const emit = chunk => {
    if (chunk.choices?.[0]?.delta?.content) fullText += chunk.choices[0].delta.content;
    if (stream) sse(res, chunk);
  };

  const ctrl = new AbortController();
  req.on('close', () => ctrl.abort());

  try {
    for await (const ev of streamClaude({ prompt: convo, model, systemPrompt, bin: claudeBin, signal: ctrl.signal })) {
      const r = mapper.mapEvent(ev, emit);
      if (r && r.terminal) { finishReason = r.stop_reason; usage = r.usage; break; }
    }
  } catch (e) {
    if (stream) { sse(res, { error: { message: e.message } }); res.end(); return; }
    return json(res, 500, { error: { message: e.message } });
  }

  if (stream) {
    sse(res, makeChunk(id, body.model || `claude/${model}`, {}, finishReason));
    res.write('data: [DONE]\n\n');
    res.end();
  } else {
    const finalUsage = usage ? {
      prompt_tokens: usage.input_tokens || 0,
      completion_tokens: usage.output_tokens || 0,
      total_tokens: (usage.input_tokens || 0) + (usage.output_tokens || 0),
    } : undefined;
    json(res, 200, makeFinal(id, body.model || `claude/${model}`, fullText, finishReason, finalUsage));
  }
}

async function handleChat(req, res, backends, claudeBin) {
  const body = await readBody(req);
  if (isClaudeModel(body.model)) return handleClaudeChat(req, res, body, claudeBin);
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

function createServer({ port = 4800, backends = {}, claudeBin = 'claude' } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Private-Network': 'true', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization' }); return res.end(); }
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/v1/models' && req.method === 'GET') return json(res, 200, await listModels(claudeBin));
      if (url.pathname === '/v1/chat/completions' && req.method === 'POST') return handleChat(req, res, backends, claudeBin);
      if (url.pathname === '/health') return json(res, 200, { ok: true, backends: Object.keys(BACKENDS) });
      if (url.pathname === '/' || url.pathname === '/demo' || url.pathname === '/demo/') return serveStatic(res, 'index.html');
      if (url.pathname.startsWith('/demo/')) return serveStatic(res, url.pathname.slice(6));
      if (/^\/(app-shell\.css|colors_and_type\.css|styles\.css|app\.js|favicon\.(svg|ico))$/.test(url.pathname)) return serveStatic(res, url.pathname.slice(1));
      json(res, 404, { error: { message: 'not found: ' + url.pathname } });
    } catch (e) {
      json(res, 500, { error: { message: e.message, stack: e.stack } });
    }
  });
  return new Promise((resolve, reject) => {
    server.listen(port, () => {
      const actual = server.address().port;
      console.log(`acptoapi listening http://localhost:${actual}`);
      resolve({ server, port: actual });
    });
    server.on('error', reject);
  });
}

module.exports = { createServer };
