'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { splitModel, resolveBackend, createSession, sendMessage, streamEvents, probe, BACKENDS } = require('./acp-client');
const { openAIMessagesToACP, createEventMapper, makeChunk, makeFinal, genId, translate, buffer } = require('./translate');
const { isClaudeModel, parseClaudeModel, probeClaude, streamClaude, CLAUDE_MODELS } = require('./claude-client');
const { createClaudeMapper } = require('./claude-translate');
const { getFormat } = require('./formats/index');
const { isBrand, getBrand, listBrands, getEmbeddingBrand, listEmbeddingBrands } = require('./openai-brands');
const { PASSTHROUGH_ROUTES, passthrough } = require('./passthrough');
const { discoverModels: discoverNvidiaModels } = require('./providers/nvidia');
const metrics = require('./metrics');

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
  const ollamaUrl = process.env.OLLAMA_URL || 'http://localhost:11434';
  const ollamaModels = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(1500) })
    .then(r => r.json()).then(d => (d.models || []).map(m => m.name)).catch(() => []);
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
  for (const name of ollamaModels) {
    const id = `ollama/${name}`;
    if (seen.has(id)) continue;
    seen.add(id);
    data.push({ id, object: 'model', owned_by: 'ollama', created });
  }
  if (process.env.ANTHROPIC_API_KEY) {
    for (const name of ['anthropic/claude-opus-4-7', 'anthropic/claude-sonnet-4-6', 'anthropic/claude-haiku-4-5-20251001']) {
      if (seen.has(name)) continue;
      seen.add(name);
      data.push({ id: name, object: 'model', owned_by: 'anthropic', created });
    }
  }
  if (process.env.GEMINI_API_KEY) {
    for (const name of ['gemini/gemini-2.0-flash', 'gemini/gemini-2.5-pro', 'gemini/gemini-2.5-flash']) {
      if (seen.has(name)) continue;
      seen.add(name);
      data.push({ id: name, object: 'model', owned_by: 'google', created });
    }
  }
  if (process.env.NVIDIA_KEY) {
    try {
      const nvidiaModels = await discoverNvidiaModels(process.env.NVIDIA_KEY);
      for (const m of nvidiaModels) {
        const id = m.id || m;
        if (seen.has(id)) continue;
        seen.add(id);
        data.push({ id, object: 'model', owned_by: 'nvidia', created });
      }
    } catch (err) {
      console.error('[nvidia] Model discovery failed:', err.message);
    }
  }
  const BRAND_CATALOG = {
    groq: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'mixtral-8x7b-32768'],
    openrouter: ['auto', 'meta-llama/llama-3.3-70b-instruct'],
    together: ['meta-llama/Llama-3.3-70B-Instruct-Turbo', 'Qwen/Qwen2.5-72B-Instruct-Turbo'],
    deepseek: ['deepseek-chat', 'deepseek-reasoner'],
    xai: ['grok-2-latest', 'grok-beta'],
    cerebras: ['llama3.1-8b', 'llama-3.3-70b'],
    perplexity: ['llama-3.1-sonar-large-128k-online', 'llama-3.1-sonar-small-128k-online'],
    mistral: ['mistral-large-latest', 'mistral-small-latest', 'codestral-latest'],
    fireworks: ['accounts/fireworks/models/llama-v3p3-70b-instruct'],
    openai: ['gpt-4o', 'gpt-4o-mini', 'o1', 'o1-mini'],
  };
  for (const brand of listBrands()) {
    const envKey = getBrand(brand).envKey;
    if (!process.env[envKey]) continue;
    for (const m of (BRAND_CATALOG[brand] || [])) {
      const id = `${brand}/${m}`;
      if (seen.has(id)) continue;
      seen.add(id);
      data.push({ id, object: 'model', owned_by: brand, created });
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

function splitBrandModel(fullModel) {
  const m = /^([a-z0-9-]+)\/(.+)$/.exec(fullModel || '');
  if (!m) return null;
  return { prefix: m[1], model: m[2] };
}

async function handleBrandChat(req, res, brandName, body) {
  const brand = getBrand(brandName);
  const apiKey = process.env[brand.envKey];
  if (!apiKey) return json(res, 401, { error: { message: `Missing ${brand.envKey} env var for brand '${brandName}'` } });
  const sub = splitBrandModel(body.model);
  const upstreamModel = sub ? sub.model : body.model;
  const upstreamBody = { ...body, model: upstreamModel };
  delete upstreamBody.stream;
  const stream = body.stream === true;
  try {
    const r = await fetch(brand.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ ...upstreamBody, stream }),
    });
    res.writeHead(r.status, {
      'Content-Type': r.headers.get('content-type') || 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Private-Network': 'true',
    });
    if (stream && r.body) {
      const reader = r.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
      res.end();
    } else {
      const text = await r.text();
      res.end(text);
    }
  } catch (e) {
    json(res, 500, { error: { message: e.message } });
  }
}

async function handleEmbeddings(req, res) {
  const body = await readBody(req);
  const sub = splitBrandModel(body.model);
  const brandName = sub ? sub.prefix : 'openai';
  const upstreamModel = sub ? sub.model : body.model;
  const brand = getEmbeddingBrand(brandName);
  if (!brand) return json(res, 400, { error: { message: `No embeddings brand '${brandName}'. Known: ${listEmbeddingBrands().join(', ')}` } });
  const apiKey = process.env[brand.envKey];
  if (!apiKey) return json(res, 401, { error: { message: `Missing ${brand.envKey}` } });
  try {
    const r = await fetch(brand.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ ...body, model: upstreamModel }),
    });
    const text = await r.text();
    res.writeHead(r.status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Private-Network': 'true' });
    res.end(text);
  } catch (e) {
    json(res, 500, { error: { message: e.message } });
  }
}

function estimateTokens(input) {
  if (typeof input === 'string') return Math.ceil(input.length / 4);
  if (Array.isArray(input)) {
    let total = 0;
    for (const m of input) {
      if (typeof m.content === 'string') total += Math.ceil(m.content.length / 4);
      else if (Array.isArray(m.content)) for (const b of m.content) {
        if (b.type === 'text' && b.text) total += Math.ceil(b.text.length / 4);
        else if (b.type === 'tool_use') total += Math.ceil(JSON.stringify(b.input || {}).length / 4) + 8;
        else if (b.type === 'tool_result') total += Math.ceil(JSON.stringify(b.content || '').length / 4) + 4;
        else if (b.type === 'image') total += 1500;
      }
      total += 4;
    }
    return total;
  }
  return 0;
}

async function handleCountTokens(req, res) {
  const body = await readBody(req);
  const messages = body.messages || [];
  const system = body.system || '';
  const tools = body.tools || [];
  let count = estimateTokens(messages) + estimateTokens(system);
  for (const t of tools) count += Math.ceil(JSON.stringify(t).length / 4);
  json(res, 200, { input_tokens: count });
}

async function handleChat(req, res, backends, claudeBin) {
  const body = await readBody(req);
  if (isClaudeModel(body.model)) return handleClaudeChat(req, res, body, claudeBin);
  const sub = splitBrandModel(body.model);
  if (sub && isBrand(sub.prefix)) return handleBrandChat(req, res, sub.prefix, body);
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

async function handleAnthropicMessages(req, res, backends, claudeBin) {
  const body = await readBody(req);
  const provider = req.headers['x-provider'] || (body.model && body.model.startsWith('claude/') ? 'claude' : 'gemini');
  const streaming = body.stream === true;
  const authHeader = req.headers['authorization'] || req.headers['x-api-key'];
  if (!authHeader) return json(res, 401, { error: { type: 'authentication_error', message: 'Missing authentication' } });

  if (streaming) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Private-Network': 'true' });
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => clearInterval(ping));
    try {
      for await (const ev of translate({ from: 'anthropic', to: 'anthropic', provider, ...body })) {
        if (ev.type === 'sse' && ev.raw) res.write(ev.raw + '\n');
      }
    } catch (e) {
      res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: e.message } })}\n\n`);
    }
    clearInterval(ping);
    res.end();
  } else {
    try {
      const result = await buffer({ from: 'anthropic', to: 'anthropic', provider, ...body });
      json(res, 200, result);
    } catch (e) {
      json(res, 500, { error: { type: 'api_error', message: e.message } });
    }
  }
}

async function handleGeminiGenerateContent(req, res, model, stream) {
  const body = await readBody(req);
  body.model = model;
  if (stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Private-Network': 'true' });
    try {
      for await (const ev of translate({ from: 'gemini', to: 'gemini', provider: 'gemini', ...body })) {
        if (ev.type === 'sse' && ev.raw) res.write(ev.raw);
      }
    } catch (e) {
      res.write(`data: ${JSON.stringify({ error: { code: 500, message: e.message, status: 'INTERNAL' } })}\n\n`);
    }
    res.end();
  } else {
    try {
      const result = await buffer({ from: 'gemini', to: 'gemini', provider: 'gemini', ...body });
      json(res, 200, result);
    } catch (e) {
      json(res, 500, { error: { code: 500, message: e.message, status: 'INTERNAL' } });
    }
  }
}

function handleHistory(req, res, url) {
  const { getStore } = require('./history');
  const store = getStore(process.env.CLAUDE_PROJECTS_DIR);
  const p = url.pathname;
  const q = Object.fromEntries(url.searchParams);
  if (q.limit) q.limit = parseInt(q.limit, 10);
  try {
    if (p === '/v1/history' || p === '/v1/history/snapshot') return json(res, 200, store.snapshot());
    if (p === '/v1/history/sessions') return json(res, 200, store.sessions());
    const m = p.match(/^\/v1\/history\/sessions\/([^/]+)\/events$/);
    if (m) return json(res, 200, { sid: m[1], events: store.sessionEvents(m[1]) });
    if (p === '/v1/history/search') return json(res, 200, { query: q.q || '', results: q.q ? store.search(q.q, q) : [] });
    if (p === '/v1/history/reindex') { store.rebuildIndex(); return json(res, 200, { ok: true, at: store.lastBuilt }); }
    if (p === '/v1/history/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Private-Network': 'true' });
      res.write('event: hello\ndata: {}\n\n');
      store.sseClients.add(res);
      req.on('close', () => store.sseClients.delete(res));
      return;
    }
    return json(res, 404, { error: { message: 'history endpoint not found: ' + p } });
  } catch (e) {
    return json(res, 500, { error: { message: e.message } });
  }
}

async function handleTerminal(req, res, url) {
  const term = require('./terminal');
  const p = url.pathname;
  try {
    if (p === '/v1/terminal/sessions' && req.method === 'GET') return json(res, 200, term.listSessions());
    if (p === '/v1/terminal/sessions' && req.method === 'POST') {
      const body = await readBody(req);
      const s = term.createSession({ shell: body.shell, cwd: body.cwd, cols: body.cols, rows: body.rows, env: body.env });
      return json(res, 200, { sid: s.sid, kind: s.kind, shell: s.shell, cwd: s.cwd, cols: s.cols, rows: s.rows, pid: s.proc.pid });
    }
    const m = p.match(/^\/v1\/terminal\/sessions\/([^/]+)$/);
    if (m && req.method === 'GET') {
      const s = term.getSession(m[1]);
      if (!s) return json(res, 404, { error: { message: 'session not found' } });
      return json(res, 200, { sid: s.sid, kind: s.kind, shell: s.shell, cwd: s.cwd, cols: s.cols, rows: s.rows, pid: s.proc.pid, clients: s.clients.size });
    }
    if (m && req.method === 'DELETE') {
      const ok = term.closeSession(m[1]);
      return json(res, ok ? 200 : 404, { ok });
    }
    return json(res, 404, { error: { message: 'terminal endpoint not found: ' + p } });
  } catch (e) {
    return json(res, 500, { error: { message: e.message } });
  }
}

function attachTerminalWs(server) {
  const { WebSocketServer } = require('ws');
  const term = require('./terminal');
  const wss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://x');
    const m = url.pathname.match(/^\/v1\/terminal\/sessions\/([^/]+)$/);
    if (!m) return;
    const sid = m[1];
    const requireAuth = process.env.ACPTOAPI_API_KEY;
    if (requireAuth) {
      const auth = req.headers['authorization'] || '';
      const key = auth.startsWith('Bearer ') ? auth.slice(7) : (req.headers['x-api-key'] || url.searchParams.get('token') || '');
      if (key !== requireAuth) { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); socket.destroy(); return; }
    }
    wss.handleUpgrade(req, socket, head, (ws) => { term.attachWs(sid, ws); });
  });
}

function createServer({ port = 4800, backends = {}, claudeBin = 'claude' } = {}) {
  const requireAuth = process.env.ACPTOAPI_API_KEY;
  const server = http.createServer(async (req, res) => {
    const t0 = Date.now();
    try {
      if (req.method === 'OPTIONS') { res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Private-Network': 'true', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type,Authorization,x-api-key,x-provider' }); return res.end(); }
      const url = new URL(req.url, 'http://x');
      metrics.inc('acptoapi_requests_total', { path: url.pathname, method: req.method });
      res.on('finish', () => metrics.observe('acptoapi_request_duration_ms', Date.now() - t0, { path: url.pathname }));
      const isPublic = url.pathname === '/health' || url.pathname === '/metrics' || url.pathname.startsWith('/debug/') || url.pathname === '/' || url.pathname === '/demo' || url.pathname.startsWith('/demo/') || /^\/(app-shell\.css|colors_and_type\.css|styles\.css|app\.js|favicon\.(svg|ico))$/.test(url.pathname);
      if (requireAuth && !isPublic) {
        const auth = req.headers['authorization'] || '';
        const key = auth.startsWith('Bearer ') ? auth.slice(7) : (req.headers['x-api-key'] || '');
        if (key !== requireAuth) { metrics.inc('acptoapi_auth_failures_total'); return json(res, 401, { error: { message: 'Invalid API key' } }); }
      }
      if (url.pathname === '/metrics' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4' });
        return res.end(metrics.render());
      }
      if (url.pathname === '/v1/models' && req.method === 'GET') return json(res, 200, await listModels(claudeBin));
      if (url.pathname === '/v1/chat/completions' && req.method === 'POST') return handleChat(req, res, backends, claudeBin);
      if (url.pathname.startsWith('/v1/history') && req.method === 'GET') return handleHistory(req, res, url);
      if (url.pathname.startsWith('/v1/terminal/sessions')) return handleTerminal(req, res, url);
      if (url.pathname === '/health') return json(res, 200, { ok: true, backends: Object.keys(BACKENDS) });
      if (url.pathname === '/' || url.pathname === '/demo' || url.pathname === '/demo/') return serveStatic(res, 'index.html');
      if (url.pathname.startsWith('/demo/')) return serveStatic(res, url.pathname.slice(6));
      if (/^\/(app-shell\.css|colors_and_type\.css|styles\.css|app\.js|favicon\.(svg|ico))$/.test(url.pathname)) return serveStatic(res, url.pathname.slice(1));
      if (url.pathname === '/debug/providers' && req.method === 'GET') {
        const checks = await Promise.all(
          ['kilo', 'opencode'].map(async prefix => {
            const b = resolveBackend(prefix);
            const start = Date.now();
            const ok = await probe(b, 2000).catch(() => false);
            return { name: prefix, status: ok ? 'ok' : 'unreachable', latencyMs: Date.now() - start };
          })
        );
        const claudeStart = Date.now();
        const claudeOk = await probeClaude(claudeBin).catch(() => false);
        checks.push({ name: 'claude', status: claudeOk ? 'ok' : 'unreachable', latencyMs: Date.now() - claudeStart });
        return json(res, 200, checks);
      }
      if (url.pathname === '/debug/chains' && req.method === 'GET') {
        const { listNamedChains, resolveNamedChain, getRunHistory } = require('./chain');
        const defined = listNamedChains().map(n => ({ name: n, ...resolveNamedChain(n) }));
        return json(res, 200, { defined, recent: getRunHistory() });
      }
      if (url.pathname === '/debug/config' && req.method === 'GET') {
        const { loadConfig } = require('./config');
        const { redactKeys } = require('./errors');
        const cfg = loadConfig();
        return json(res, 200, redactKeys(cfg));
      }
      if (url.pathname === '/v1/messages' && req.method === 'POST') return handleAnthropicMessages(req, res, backends, claudeBin);
      if (url.pathname === '/v1/messages/count_tokens' && req.method === 'POST') return handleCountTokens(req, res);
      if (url.pathname === '/v1/embeddings' && req.method === 'POST') return handleEmbeddings(req, res);
      if (PASSTHROUGH_ROUTES[url.pathname] && req.method === 'POST') {
        const body = await readBody(req);
        return passthrough(req, res, body, PASSTHROUGH_ROUTES[url.pathname]);
      }
      const geminiEmbed = url.pathname.match(/^\/v1beta\/models\/([^:]+):(embedContent|countTokens)$/);
      if (geminiEmbed && req.method === 'POST') {
        const body = await readBody(req);
        if (geminiEmbed[2] === 'countTokens') {
          const messages = (body.contents || []).map(c => ({ role: c.role, content: (c.parts || []).map(p => p.text || '').join('') }));
          return json(res, 200, { totalTokens: estimateTokens(messages) });
        }
        const apiKey = process.env.GEMINI_API_KEY;
        if (!apiKey) return json(res, 401, { error: { message: 'Missing GEMINI_API_KEY' } });
        const upstream = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${geminiEmbed[1]}:embedContent?key=${apiKey}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
        return res.end(await upstream.text());
      }
      if (url.pathname === '/v1beta/models' && req.method === 'GET') {
        const models = await listModels(claudeBin);
        const created = Math.floor(Date.now() / 1000);
        const geminiModels = models.data.map(m => ({ name: 'models/' + m.id, displayName: m.id, supportedGenerationMethods: ['generateContent', 'streamGenerateContent'], createTime: new Date(created * 1000).toISOString(), updateTime: new Date(created * 1000).toISOString() }));
        return json(res, 200, { models: geminiModels });
      }
      const geminiMatch = url.pathname.match(/^\/v1beta\/models\/([^:]+):(streamGenerateContent|generateContent)$/);
      if (geminiMatch && req.method === 'POST') return handleGeminiGenerateContent(req, res, geminiMatch[1], geminiMatch[2] === 'streamGenerateContent');
      if (url.pathname === '/debug/translate' && req.method === 'POST') {
        const { translate } = require('./translate');
        const body = await readBody(req);
        const events = [];
        const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000));
        try {
          await Promise.race([
            (async () => { for await (const ev of translate(body)) events.push(ev); })(),
            timeout
          ]);
        } catch (e) {
          if (e.message !== 'timeout') throw e;
        }
        return json(res, 200, events);
      }
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
