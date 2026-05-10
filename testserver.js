'use strict';
const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) process.env[m[1]] = m[2];
  }
}

const Anthropic = require('@anthropic-ai/sdk');
const { createServer } = require('./lib/server');

const PORT = 4800;
const client = new Anthropic({ apiKey: 'dummy', baseURL: `http://127.0.0.1:${PORT}` });

async function assert(label, fn) {
  try {
    await fn();
    console.log(`PASS: ${label}`);
  } catch (e) {
    console.error(`FAIL: ${label} — ${e.message}`);
    process.exitCode = 1;
  }
}

async function run() {
  const srv = await createServer({ port: PORT });
  console.log(`server on :${PORT}`);

  await assert('non-streaming groq message', async () => {
    const msg = await client.messages.create({
      model: 'groq/llama-3.3-70b-versatile',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'Say "hello"' }],
    });
    if (!msg.content?.[0]?.text) throw new Error('no text: ' + JSON.stringify(msg));
  });

  await assert('streaming groq message', async () => {
    let text = '';
    const stream = client.messages.stream({
      model: 'groq/llama-3.3-70b-versatile',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'Say "hi"' }],
    });
    for await (const ev of stream) {
      if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') text += ev.delta.text;
    }
    if (!text) throw new Error('empty streaming response');
  });

  await assert('system prompt', async () => {
    const msg = await client.messages.create({
      model: 'groq/llama-3.3-70b-versatile',
      max_tokens: 32,
      system: 'You are a terse assistant.',
      messages: [{ role: 'user', content: 'What is 2+2?' }],
    });
    if (!msg.content?.[0]?.text) throw new Error('no text');
  });

  await assert('multi-turn conversation', async () => {
    const msg = await client.messages.create({
      model: 'groq/llama-3.3-70b-versatile',
      max_tokens: 64,
      messages: [
        { role: 'user', content: 'My name is Alice.' },
        { role: 'assistant', content: 'Hello Alice!' },
        { role: 'user', content: 'What is my name?' },
      ],
    });
    if (!msg.content?.[0]?.text) throw new Error('no text');
  });

  await assert('model=auto routing', async () => {
    const msg = await client.messages.create({
      model: 'auto',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'Say "ok"' }],
    });
    if (!msg.content?.[0]?.text) throw new Error('no text');
  });

  await assert('token counting', async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer dummy' },
      body: JSON.stringify({ messages: [{ role: 'user', content: 'hello world' }] }),
    }).then(r => r.json());
    if (!r.input_tokens || r.input_tokens < 1) throw new Error('bad token count: ' + JSON.stringify(r));
  });

  await assert('/debug/auto-chain endpoint', async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/debug/auto-chain`).then(r => r.json());
    if (!Array.isArray(r.links)) throw new Error('missing links: ' + JSON.stringify(r));
    if (r.links.length === 0) throw new Error('empty auto-chain');
  });

  await assert('/v1/models listing', async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/v1/models`).then(r => r.json());
    if (!Array.isArray(r.data)) throw new Error('missing data: ' + JSON.stringify(r));
  });

  await assert('error: missing auth header', async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'groq/llama-3.3-70b-versatile', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }),
    });
    if (r.status !== 401) throw new Error(`expected 401, got ${r.status}`);
  });

  await assert('error: missing brand env key', async () => {
    const saved = process.env.GROQ_API_KEY;
    delete process.env.GROQ_API_KEY;
    const r = await fetch(`http://127.0.0.1:${PORT}/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer dummy' },
      body: JSON.stringify({ model: 'groq/llama-3.3-70b-versatile', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] }),
    });
    process.env.GROQ_API_KEY = saved;
    if (r.status !== 401) throw new Error(`expected 401, got ${r.status}`);
  });

  console.log('\nAll tests complete. Server stays on :4800.');
}

run().catch(e => { console.error('FATAL:', e); process.exit(1); });
