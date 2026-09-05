'use strict';

const keyring = require('./keyring');
const { splitBrandModel } = require('./model-id');

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

async function passthrough(req, res, body, route) {
  const sub = splitBrandModel(body.model);
  const brandName = sub ? sub.prefix : Object.keys(route.brands)[0];
  const url = route.brands[brandName];
  if (!url) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: `Unknown brand '${brandName}' for ${req.url}. Known: ${Object.keys(route.brands).join(', ')}` } }));
  }
  const envKey = ENV_KEYS[brandName];
  const upstreamBody = sub ? { ...body, model: sub.model } : body;
  const rotated = await keyring.rotateKeys(envKey, (apiKey) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify(upstreamBody),
  }), {
    onRotate: ({ reason, index, nextIndex }) =>
      console.log(`[acptoapi] key-rotate provider=${brandName} reason=${reason} key-index=${index} next-index=${nextIndex}`),
  });
  if (rotated.exhausted) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: `Missing ${envKey}` } }));
  }
  const r = rotated.result;
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
