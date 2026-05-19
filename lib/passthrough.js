'use strict';

const keyring = require('./keyring');

const PASSTHROUGH_ROUTES = {
  '/v1/images/generations':      { brands: { openai: 'https://api.openai.com/v1/images/generations',
                                              together: 'https://api.together.xyz/v1/images/generations' } },
  '/v1/moderations':             { brands: { openai: 'https://api.openai.com/v1/moderations' } },
  '/v1/rerank':                  { brands: { cohere: 'https://api.cohere.com/v2/rerank',
                                              voyage: 'https://api.voyageai.com/v1/rerank',
                                              together: 'https://api.together.xyz/v1/rerank' } },
  '/v1/audio/speech':            { brands: { openai: 'https://api.openai.com/v1/audio/speech',
                                              groq: 'https://api.groq.com/openai/v1/audio/speech' } },
};

const ENV_KEYS = {
  openai: 'OPENAI_API_KEY', together: 'TOGETHER_API_KEY', cohere: 'COHERE_API_KEY',
  voyage: 'VOYAGE_API_KEY', groq: 'GROQ_API_KEY',
};

function splitBrandModel(fullModel) {
  const m = /^([a-z0-9-]+)\/(.+)$/.exec(fullModel || '');
  return m ? { prefix: m[1], model: m[2] } : null;
}

async function passthrough(req, res, body, route) {
  const sub = splitBrandModel(body.model);
  const brandName = sub ? sub.prefix : Object.keys(route.brands)[0];
  const url = route.brands[brandName];
  if (!url) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: `Unknown brand '${brandName}' for ${req.url}. Known: ${Object.keys(route.brands).join(', ')}` } }));
  }
  const envKey = ENV_KEYS[brandName];
  const usableKeys = keyring.listUsable(envKey);
  const allKeys = keyring.getKeys(envKey);
  const tryKeys = usableKeys.length > 0 ? usableKeys : (allKeys.length > 0 ? [keyring.getKey(envKey)] : []);
  if (tryKeys.length === 0) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: `Missing ${envKey}` } }));
  }
  const upstreamBody = sub ? { ...body, model: sub.model } : body;
  let r;
  let lastApiKey;
  for (const apiKey of tryKeys) {
    lastApiKey = apiKey;
    r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify(upstreamBody),
    });
    const reason = keyring.classify(r.status);
    if (reason === 'auth' || reason === 'rate_limit') {
      keyring.markKeyFailed(envKey, apiKey, reason);
      continue;
    }
    if (r.ok) keyring.markKeyOk(envKey, apiKey);
    break;
  }
  res.writeHead(r.status, {
    'Content-Type': r.headers.get('content-type') || 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Private-Network': 'true',
  });
  if (r.body && (r.headers.get('content-type') || '').includes('audio')) {
    const reader = r.body.getReader();
    while (true) { const { done, value } = await reader.read(); if (done) break; res.write(Buffer.from(value)); }
    res.end();
  } else {
    res.end(await r.text());
  }
}

module.exports = { PASSTHROUGH_ROUTES, passthrough };
