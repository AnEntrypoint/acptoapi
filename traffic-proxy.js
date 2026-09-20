const http = require('http');

const TARGET_PORT = 4900;
const PROXY_PORT = 4901;
const TARGET_HOST = '127.0.0.1';
const MAX_BODY_LOG = 8000;

const proxy = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    const ts = new Date().toISOString();

    console.log(`\n=== ${ts} [REQ] ${req.method} ${req.url} ===`);
    console.log('HEADERS:', JSON.stringify(req.headers, null, 2));
    const bodyStr = body.toString();
    console.log('BODY LEN:', bodyStr.length);
    console.log('BODY:', bodyStr.substring(0, MAX_BODY_LOG));

    const opts = {
      hostname: TARGET_HOST,
      port: TARGET_PORT,
      path: req.url,
      method: req.method,
      headers: { ...req.headers, host: `127.0.0.1:${TARGET_PORT}` },
    };

    const proxyReq = http.request(opts, (proxyRes) => {
      const resChunks = [];
      proxyRes.on('data', c => resChunks.push(c));
      proxyRes.on('end', () => {
        const resBody = Buffer.concat(resChunks);
        const elapsed = Date.now() - new Date(ts).getTime();
        console.log(`\n=== ${ts} [RES] ${proxyRes.statusCode} (${elapsed}ms) ===`);
        console.log('HEADERS:', JSON.stringify(proxyRes.headers, null, 2));

        const ct = proxyRes.headers['content-type'] || '';
        const bodyStr = resBody.toString();
        if (ct.includes('text/event-stream')) {
          console.log('BODY (SSE):');
          bodyStr.split('\n').forEach(l => { if (l.trim()) console.log('  ' + l); });
        } else {
          console.log('BODY:', bodyStr.substring(0, MAX_BODY_LOG));
        }
        console.log(`=== END ${ts} ===`);

        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        res.end(resBody);
      });
    });
    proxyReq.on('error', e => { console.error('PROXY ERROR:', e.message); res.writeHead(502); res.end(e.message); });
    proxyReq.setTimeout(120000);
    proxyReq.end(body);
  });
});

proxy.listen(PROXY_PORT, () => {
  console.log(`HTTP proxy listening on :${PROXY_PORT} -> :${TARGET_PORT}`);
  console.log(`Point claude at ANTHROPIC_BASE_URL=http://127.0.0.1:${PROXY_PORT}`);
});
