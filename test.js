const assert = require('assert');
const api = require('./index.js');

async function run() {
  const { getFormat, FORMATS, getProvider, PROVIDERS } = api;
  assert.deepStrictEqual(Object.keys(FORMATS).sort(), ['acp','anthropic','bedrock','cohere','gemini','mistral','ollama','openai']);

  const anth = getFormat('anthropic');
  const p = anth.toParams({ model:'m', messages:[{role:'user',content:'hi'}], max_tokens:10 });
  assert.strictEqual(p.model, 'm');
  assert.strictEqual(p.maxOutputTokens, 10);
  assert.strictEqual(p.messages[0].content, 'hi');

  const events = [
    { type:'text-delta', textDelta:'hello' },
    { type:'finish-step', finishReason:'stop' },
  ];
  const resp = anth.toResponse(events);
  assert.strictEqual(resp.type, 'message');
  assert.strictEqual(resp.content[0].text, 'hello');
  assert.strictEqual(resp.stop_reason, 'end_turn');

  const sse = anth.toSSE({ type:'text-delta', textDelta:'hi' });
  assert(sse.includes('content_block_delta'), 'SSE missing content_block_delta');

  const oai = getFormat('openai');
  const op = oai.toParams({ model:'gpt-4', messages:[{role:'user',content:'test'}], max_tokens:5 });
  assert.strictEqual(op.model, 'gpt-4');
  assert.strictEqual(op.maxOutputTokens, 5);

  const oresp = oai.toResponse(events);
  assert.strictEqual(oresp.object, 'chat.completion');
  assert.strictEqual(oresp.choices[0].message.content, 'hello');

  assert(Object.keys(PROVIDERS).includes('gemini'));
  assert(Object.keys(PROVIDERS).includes('openai-compat'));
  assert.strictEqual(typeof getProvider('gemini').stream, 'function');
  assert.throws(() => getProvider('bogus'), /Unknown provider/);

  const a = new api.Anthropic({ provider:'gemini', apiKey:'test' });
  assert.strictEqual(typeof a.messages.create, 'function');
  assert.strictEqual(typeof a.messages.stream, 'function');
  const o = new api.OpenAI({ baseURL:'http://localhost:1/v1', apiKey:'test' });
  assert.strictEqual(typeof o.chat.completions.create, 'function');

  const srv = api.createAnthropicServer({ provider:'gemini', apiKey:'test' });
  assert.strictEqual(srv.constructor.name, 'Server');
  const osrv = api.createOpenAIServer({ provider:'gemini', apiKey:'test' });
  assert.strictEqual(osrv.constructor.name, 'Server');

  const anthRState = { blockIndex: 0 };
  const anthR1 = anth.toSSE({ type:'reasoning-delta', reasoningDelta:'think' }, anthRState);
  assert(anthR1.includes('content_block_start'));
  assert(anthR1.includes('thinking_delta'));
  const anthR2 = anth.toSSE({ type:'reasoning-delta', reasoningDelta:'more' }, anthRState);
  assert(!anthR2.includes('content_block_start'));

  const oaiR = oai.toSSE({ type:'reasoning-delta', reasoningDelta:'think' }, { id:'test', created:0 });
  assert(oaiR.includes('reasoning_content'));

  assert.strictEqual(getFormat('gemini').toSSE({ type:'reasoning-delta', reasoningDelta:'think' }), '');
  assert(getFormat('acp').toSSE({ type:'reasoning-delta', reasoningDelta:'think' }).includes('reasoning'));

  assert.strictEqual(typeof api.translate, 'function');
  assert.strictEqual(typeof api.translateSync, 'function');
  assert.strictEqual(typeof api.buffer, 'function');
  assert.strictEqual(typeof api.createStreamActor, 'function');

  const acpFmt = getFormat('acp');
  assert(acpFmt.toSSE({ type:'text-delta', textDelta:'hello' }).includes('text'));

  const acpResp = acpFmt.toResponse(events);
  assert.strictEqual(acpResp.parts[0].text, 'hello');
  assert.strictEqual(acpResp.finish, 'stop');

  const oaiFromEvents = oai.toSSE({ type:'text-delta', textDelta:'hello' }, { id:'x', created:0 });
  assert(oaiFromEvents.includes('choices'));

  const anthFromOaiReq = oai.toParams({ model:'gpt-4', messages:[{role:'user',content:'Hi'}] });
  const anthRespFromOai = anth.toResponse(events);
  assert.strictEqual(anthRespFromOai.type, 'message');
  assert.strictEqual(anthRespFromOai.content[0].text, 'hello');
  assert.strictEqual(anthFromOaiReq.model, 'gpt-4');

  const gem = getFormat('gemini');
  const geminiResp = gem.toResponse(events);
  assert(geminiResp.candidates, 'gemini toResponse missing candidates');
  assert.strictEqual(geminiResp.candidates[0].content.parts[0].text, 'hello');

  const mistral = getFormat('mistral');
  assert(mistral.toParams({ model:'m', messages:[{role:'user',content:'hi'}] }).messages);
  assert(getFormat('cohere').toParams({ model:'m', messages:[{role:'user',content:'hi'}] }));
  assert(getFormat('ollama').toParams({ model:'m', messages:[{role:'user',content:'hi'}] }).model);
  assert(getFormat('bedrock').toParams({ model:'m', messages:[{role:'user',content:'hi'}] }));

  const { isBrand, listBrands } = require('./lib/openai-brands');
  assert.ok(isBrand('groq') && isBrand('openrouter') && isBrand('xai'));
  assert.ok(listBrands().length >= 8);

  const { resolveModel, chain, fallback, listNamedChains, getRunHistory } = require('./lib/sdk');
  const fb = fallback('groq/x').then('gemini/y').timeout(5000).build();
  assert.deepStrictEqual(fb.models, ['groq/x', 'gemini/y']);
  const fbObj = chain([{ model: 'groq/x', timeout: 1000 }, { model: 'gemini/y', temperature: 0.3 }]);
  assert.strictEqual(fbObj.links[0].timeout, 1000);
  assert.strictEqual(fbObj.links[1].temperature, 0.3);
  assert.strictEqual(typeof listNamedChains, 'function');
  assert(Array.isArray(getRunHistory()));
  let chainErr2;
  try { await chain(['unknown-brand-xyz/a']).chat({ messages: [{ role:'user', content:'hi' }] }); } catch (e) { chainErr2 = e; }
  assert(chainErr2, 'unknown brand should fail');
  assert.throws(() => chain([]), /non-empty/);
  assert.throws(() => chain('does-not-exist-chain'), /No named chain/);

  const rGroq = resolveModel('groq/llama-3.3-70b-versatile');
  assert.strictEqual(rGroq.provider, 'openai-compat');
  assert.strictEqual(rGroq.model, 'llama-3.3-70b-versatile');
  assert.strictEqual(rGroq.env, 'GROQ_API_KEY');
  assert.strictEqual(resolveModel('anthropic/claude-sonnet-4-6').provider, 'anthropic');
  assert.strictEqual(resolveModel('gemini/gemini-2.0-flash').provider, 'gemini');
  assert.strictEqual(resolveModel('ollama/llama3.2').provider, 'ollama');
  const c = chain(['groq/x', 'gemini/y']);
  assert.deepStrictEqual(c.models, ['groq/x', 'gemini/y']);
  assert.strictEqual(typeof c.chat, 'function');
  assert.strictEqual(typeof c.stream, 'function');

  const { createServer } = require('./lib/server');
  const _srv2 = await createServer({ port: 0 });
  const base = 'http://127.0.0.1:' + _srv2.port;

  const ct = await fetch(base + '/v1/messages/count_tokens', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'abcd'.repeat(8) }] }),
  }).then(r => r.json());
  assert.ok(ct.input_tokens > 0);

  const savedG = process.env.GROQ_API_KEY; delete process.env.GROQ_API_KEY;
  const br = await fetch(base + '/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'groq/llama-3.3-70b-versatile', messages: [{ role:'user', content:'hi' }] }),
  });
  assert.strictEqual(br.status, 401);
  if (savedG) process.env.GROQ_API_KEY = savedG;

  const metricsBody = await fetch(base + '/metrics').then(r => r.text());
  assert.ok(metricsBody.includes('agentapi_uptime_seconds'));

  const gct = await fetch(base + '/v1beta/models/gemini-2.0-flash:countTokens', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hello world' }] }] }),
  }).then(r => r.json());
  assert.ok(gct.totalTokens > 0);

  const savedC = process.env.COHERE_API_KEY; delete process.env.COHERE_API_KEY;
  const rrk = await fetch(base + '/v1/rerank', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'cohere/rerank-v3.5', query: 'q', documents: ['a'] }),
  });
  assert.strictEqual(rrk.status, 401);
  if (savedC) process.env.COHERE_API_KEY = savedC;
  _srv2.server.close();

  process.env.AGENTAPI_API_KEY = 'tk-test';
  const _srv4 = await createServer({ port: 0 });
  const base4 = 'http://127.0.0.1:' + _srv4.port;
  const noAuth = await fetch(base4 + '/v1/chat/completions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'kilo/x', messages: [] }),
  });
  assert.strictEqual(noAuth.status, 401);
  const healthOk = await fetch(base4 + '/health');
  assert.strictEqual(healthOk.status, 200);
  delete process.env.AGENTAPI_API_KEY;
  _srv4.server.close();

  const savedAll = ['ANTHROPIC_API_KEY','GEMINI_API_KEY','GROQ_API_KEY','OPENROUTER_API_KEY']
    .map(k => [k, process.env[k]]);
  for (const [k] of savedAll) delete process.env[k];
  let chainErr;
  try { await chain(['anthropic/claude-sonnet-4-6', 'groq/llama-3.3-70b-versatile']).chat({ messages: [{ role:'user', content:'hi' }] }); }
  catch (e) { chainErr = e; }
  assert(chainErr, 'chain with all-missing-keys should throw');
  for (const [k, v] of savedAll) if (v !== undefined) process.env[k] = v;


  // new brands + auto-chain
  assert.ok(isBrand('sambanova') && isBrand('nvidia') && isBrand('zai') && isBrand('qwen') && isBrand('codestral') && isBrand('opencode-zen'));
  const { buildAutoChain, DEFAULT_ORDER: DO } = require('./lib/auto-chain');
  assert.ok(Array.isArray(DO) && DO.includes('groq'));
  const savedG2 = process.env.GROQ_API_KEY; process.env.GROQ_API_KEY = 'test-key';
  const acLinks = buildAutoChain(); assert.ok(acLinks.some(l => l.model.startsWith('groq/')));
  process.env.GROQ_API_KEY = savedG2 || '';
  const _srv3 = await createServer({ port: 0 });
  const acr = await fetch('http://127.0.0.1:' + _srv3.port + '/debug/auto-chain').then(r => r.json());
  assert.ok(Array.isArray(acr.links) && Array.isArray(acr.order)); _srv3.server.close();

  console.log('ALL TESTS PASS');
}

run().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
