const http = require('http');
const { translate } = require('../translate');
const { getFormat } = require('../formats/index');

const LANDING = `<!doctype html><html><body><h1>acptoapi  - OpenAI proxy</h1><p>POST /v1/chat/completions</p></body></html>`;

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function createOpenAIServer({ provider = 'gemini', apiKey, ...config } = {}) {
  const state = { requests: 0, errors: 0, startedAt: Date.now() };
  const fmt = getFormat('openai');

  const server = http.createServer(async (req, res) => {
    const { method, url } = req;
    if (method === 'GET' && url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      return res.end(LANDING);
    }
    if (method === 'GET' && url === '/debug/state') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ...state, uptimeMs: Date.now() - state.startedAt }));
    }
    if (method === 'POST' && url === '/v1/chat/completions') {
      state.requests++;
      let body;
      try { body = await readBody(req); } catch (e) {
        state.errors++;
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: e.message, type: 'invalid_request_error' } }));
      }
      const opts = { from: 'openai', provider, apiKey, ...config, ...body };
      if (body.stream) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        const sseState = {};
        try {
          for await (const ev of translate(opts)) {
            const chunk = fmt.toSSE(ev, sseState);
            if (chunk) res.write(chunk);
          }
        } catch (e) {
          state.errors++;
          res.write(fmt.toSSE({ type: 'error', error: e }, sseState));
        }
        return res.end();
      }
      try {
        const events = [];
        for await (const ev of translate(opts)) events.push(ev);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(fmt.toResponse(events, opts.model || '')));
      } catch (e) {
        state.errors++;
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: e.message, type: 'server_error' } }));
      }
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `${method} ${url} not found`, type: 'not_found' } }));
  });

  return server;
}

module.exports = { createOpenAIServer };
