const assert = require('assert');
const api = require('./index.js');

api.PROVIDERS['mock'] = {
  stream: async function*(params) {
    yield { type: 'start-step' };
    yield { type: 'text-delta', textDelta: 'Hello world' };
    yield { type: 'finish-step', finishReason: 'stop' };
  }
};

async function run() {
  // Format registry
  const { getFormat, FORMATS } = api;
  assert.deepStrictEqual(Object.keys(FORMATS).sort(), ['acp','anthropic','bedrock','cohere','gemini','mistral','ollama','openai']);

  // Anthropic toParams
  const anth = getFormat('anthropic');
  const p = anth.toParams({ model:'m', messages:[{role:'user',content:'hi'}], max_tokens:10 });
  assert.strictEqual(p.model, 'm');
  assert.strictEqual(p.maxOutputTokens, 10);
  assert.strictEqual(p.messages[0].content, 'hi');

  // Anthropic toResponse
  const events = [
    { type:'text-delta', textDelta:'hello' },
    { type:'finish-step', finishReason:'stop' },
  ];
  const resp = anth.toResponse(events);
  assert.strictEqual(resp.type, 'message');
  assert.strictEqual(resp.content[0].text, 'hello');
  assert.strictEqual(resp.stop_reason, 'end_turn');

  // Anthropic toSSE
  const sse = anth.toSSE({ type:'text-delta', textDelta:'hi' });
  assert(sse.includes('content_block_delta'), 'SSE missing content_block_delta');

  // OpenAI toParams
  const oai = getFormat('openai');
  const op = oai.toParams({ model:'gpt-4', messages:[{role:'user',content:'test'}], max_tokens:5 });
  assert.strictEqual(op.model, 'gpt-4');
  assert.strictEqual(op.maxOutputTokens, 5);

  // OpenAI toResponse
  const oresp = oai.toResponse(events);
  assert.strictEqual(oresp.object, 'chat.completion');
  assert.strictEqual(oresp.choices[0].message.content, 'hello');

  // Provider registry
  const { getProvider, PROVIDERS } = api;
  assert(Object.keys(PROVIDERS).includes('gemini'));
  assert(Object.keys(PROVIDERS).includes('openai-compat'));
  const gp = getProvider('gemini');
  assert.strictEqual(typeof gp.stream, 'function');
  assert.throws(() => getProvider('bogus'), /Unknown provider/);

  // SDK clients
  const a = new api.Anthropic({ provider:'gemini', apiKey:'test' });
  assert.strictEqual(typeof a.messages.create, 'function');
  assert.strictEqual(typeof a.messages.stream, 'function');
  const o = new api.OpenAI({ baseURL:'http://localhost:1/v1', apiKey:'test' });
  assert.strictEqual(typeof o.chat.completions.create, 'function');

  // HTTP servers
  const srv = api.createAnthropicServer({ provider:'gemini', apiKey:'test' });
  assert.strictEqual(srv.constructor.name, 'Server');
  const osrv = api.createOpenAIServer({ provider:'gemini', apiKey:'test' });
  assert.strictEqual(osrv.constructor.name, 'Server');

  // reasoning-delta SSE handlers
  const anthRState = { blockIndex: 0 };
  const anthR1 = anth.toSSE({ type:'reasoning-delta', reasoningDelta:'think' }, anthRState);
  assert(anthR1.includes('content_block_start'), 'anthropic reasoning-delta missing block_start on first call');
  assert(anthR1.includes('thinking_delta'), 'anthropic reasoning-delta missing thinking_delta');
  const anthR2 = anth.toSSE({ type:'reasoning-delta', reasoningDelta:'more' }, anthRState);
  assert(!anthR2.includes('content_block_start'), 'anthropic reasoning-delta should not repeat block_start');

  const oaiRState = { id:'test', created:0 };
  const oaiR = oai.toSSE({ type:'reasoning-delta', reasoningDelta:'think' }, oaiRState);
  assert(oaiR.includes('reasoning_content'), 'openai reasoning-delta missing reasoning_content');

  const gemini = getFormat('gemini');
  const gemR = gemini.toSSE({ type:'reasoning-delta', reasoningDelta:'think' });
  assert.strictEqual(gemR, '', 'gemini reasoning-delta should return empty string');

  const acpFmt = getFormat('acp');
  const acpR = acpFmt.toSSE({ type:'reasoning-delta', reasoningDelta:'think' });
  assert(acpR.includes('reasoning'), 'acp reasoning-delta missing reasoning type');

  // translate exports
  assert.strictEqual(typeof api.translate, 'function');
  assert.strictEqual(typeof api.translateSync, 'function');
  assert.strictEqual(typeof api.buffer, 'function');
  assert.strictEqual(typeof api.createStreamActor, 'function');

  // In-buffer: raw passthrough (no from/to)
  const rawEvs = [];
  for await (const ev of api.translate({ provider: 'mock', messages: [] })) rawEvs.push(ev);
  assert.strictEqual(rawEvs[1].type, 'text-delta');

  // In-buffer: api-to-acp SSE events (portless, no server)
  const acpEvs = [];
  for await (const ev of api.translate({ to: 'acp', provider: 'mock', messages: [] })) acpEvs.push(ev);
  assert(acpEvs.some(e => e.type === 'sse' && e.raw.includes('text')), 'acp SSE missing text delta');

  // In-buffer: api-to-openai SSE events
  const oaiEvs = [];
  for await (const ev of api.translate({ to: 'openai', provider: 'mock', messages: [] })) oaiEvs.push(ev);
  assert(oaiEvs.some(e => e.type === 'sse' && e.raw.includes('choices')), 'openai SSE missing choices');

  // In-buffer: buffer() to acp response object
  const acpRes = await api.buffer({ to: 'acp', provider: 'mock', messages: [] });
  assert.strictEqual(acpRes.parts[0].text, 'Hello world');
  assert.strictEqual(acpRes.finish, 'stop');

  // api-to-api: anthropic request → acp response (no HTTP server)
  const acpFromAnth = await api.buffer({ from: 'anthropic', to: 'acp', provider: 'mock', model: 'claude-3-5-sonnet-20241022', messages: [{ role: 'user', content: 'Hi' }] });
  assert.strictEqual(acpFromAnth.parts[0].text, 'Hello world');

  // api-to-api: openai request → anthropic response
  const anthFromOai = await api.buffer({ from: 'openai', to: 'anthropic', provider: 'mock', model: 'gpt-4', messages: [{ role: 'user', content: 'Hi' }] });
  assert.strictEqual(anthFromOai.type, 'message');
  assert.strictEqual(anthFromOai.content[0].text, 'Hello world');

  // xstate machine: createStreamActor with to:'acp'
  const actor = api.createStreamActor({ messages: [] }, 'mock', { to: 'acp' });
  const machineEvs = [];
  for await (const ev of actor.stream) machineEvs.push(ev);
  assert(machineEvs.some(e => e.type === 'sse'), 'xstate machine did not emit SSE events');

  // bidirectional matrix: openai→gemini
  const oaiToGemini = await api.buffer({ from: 'openai', to: 'gemini', provider: 'mock', model: 'gpt-4', messages: [{ role: 'user', content: 'Hi' }] });
  assert(oaiToGemini.candidates, 'openai→gemini missing candidates');
  assert.strictEqual(oaiToGemini.candidates[0].content.parts[0].text, 'Hello world');

  // bidirectional matrix: anthropic proxied via gemini, response in anthropic format
  const anthViaGemini = await api.buffer({ from: 'anthropic', to: 'anthropic', provider: 'mock', model: 'claude-3-5-sonnet-20241022', messages: [{ role: 'user', content: 'Hi' }] });
  assert.strictEqual(anthViaGemini.type, 'message');
  assert.strictEqual(anthViaGemini.content[0].text, 'Hello world');

  // bidirectional matrix: gemini→openai
  const geminiToOai = await api.buffer({ from: 'gemini', to: 'openai', provider: 'mock', model: 'gemini-2.0-flash', contents: [{ role: 'user', parts: [{ text: 'Hi' }] }] });
  assert.strictEqual(geminiToOai.object, 'chat.completion');
  assert.strictEqual(geminiToOai.choices[0].message.content, 'Hello world');

  // smoke tests: format toParams
  const mistral = getFormat('mistral');
  const mp = mistral.toParams({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
  assert(mp.messages, 'mistral toParams missing messages');

  const cohere = getFormat('cohere');
  const cp = cohere.toParams({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
  assert(cp, 'cohere toParams failed');

  const ollama = getFormat('ollama');
  const olp = ollama.toParams({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
  assert(olp.model, 'ollama toParams missing model');

  const bedrock = getFormat('bedrock');
  const bp = bedrock.toParams({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
  assert(bp, 'bedrock toParams failed');

  console.log('ALL TESTS PASS');
}

run().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
