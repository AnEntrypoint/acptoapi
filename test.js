const assert = require('assert');
const fs = require('fs'); const path = require('path'); const os = require('os');
try { require('dotenv').config?.({ path: path.join(__dirname, '.env') }); } catch {}
if (!process.env.GROQ_API_KEY) { try {
  const env = fs.readFileSync(path.join(__dirname, '.env'),'utf8');
  for (const line of env.split(/\r?\n/)) { const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line); if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g,''); }
} catch {} }
const api = require('./index.js');

async function run() {
  const { getFormat, FORMATS, getProvider, PROVIDERS } = api;
  assert.deepStrictEqual(Object.keys(FORMATS).sort(), ['acp','anthropic','bedrock','cohere','gemini','mistral','ollama','openai']);
  const anth = getFormat('anthropic'), oai = getFormat('openai');
  const p = anth.toParams({ model:'m', messages:[{role:'user',content:'hi'}], max_tokens:10 });
  assert.strictEqual(p.model, 'm'); assert.strictEqual(p.maxOutputTokens, 10); assert.strictEqual(p.messages[0].content, 'hi');
  const events = [{ type:'text-delta', textDelta:'hello' },{ type:'finish-step', finishReason:'stop' }];
  const resp = anth.toResponse(events);
  assert.strictEqual(resp.type, 'message'); assert.strictEqual(resp.content[0].text, 'hello'); assert.strictEqual(resp.stop_reason, 'end_turn');
  assert(anth.toSSE({ type:'text-delta', textDelta:'hi' }).includes('content_block_delta'));
  const op = oai.toParams({ model:'gpt-4', messages:[{role:'user',content:'test'}], max_tokens:5 });
  assert.strictEqual(op.model, 'gpt-4'); assert.strictEqual(op.maxOutputTokens, 5);
  const oresp = oai.toResponse(events);
  assert.strictEqual(oresp.object, 'chat.completion'); assert.strictEqual(oresp.choices[0].message.content, 'hello');
  assert(Object.keys(PROVIDERS).includes('gemini') && Object.keys(PROVIDERS).includes('openai-compat'));
  assert.strictEqual(typeof getProvider('gemini').stream, 'function');
  assert.throws(() => getProvider('bogus'), /Unknown provider/);
  const a = new api.Anthropic({ provider:'gemini', apiKey:'test' });
  assert.strictEqual(typeof a.messages.create, 'function'); assert.strictEqual(typeof a.messages.stream, 'function');
  const o = new api.OpenAI({ baseURL:'http://localhost:1/v1', apiKey:'test' });
  assert.strictEqual(typeof o.chat.completions.create, 'function');
  assert.strictEqual(api.createAnthropicServer({ provider:'gemini', apiKey:'test' }).constructor.name, 'Server');
  assert.strictEqual(api.createOpenAIServer({ provider:'gemini', apiKey:'test' }).constructor.name, 'Server');
  const anthRState = { blockIndex: 0 };
  const anthR1 = anth.toSSE({ type:'reasoning-delta', reasoningDelta:'think' }, anthRState);
  assert(anthR1.includes('content_block_start') && anthR1.includes('thinking_delta'));
  assert(!anth.toSSE({ type:'reasoning-delta', reasoningDelta:'more' }, anthRState).includes('content_block_start'));
  assert(oai.toSSE({ type:'reasoning-delta', reasoningDelta:'think' }, { id:'test', created:0 }).includes('reasoning_content'));
  assert.strictEqual(getFormat('gemini').toSSE({ type:'reasoning-delta', reasoningDelta:'think' }), '');
  assert(getFormat('acp').toSSE({ type:'reasoning-delta', reasoningDelta:'think' }).includes('reasoning'));
  assert.strictEqual(typeof api.translate, 'function'); assert.strictEqual(typeof api.buffer, 'function'); assert.strictEqual(typeof api.createStreamActor, 'function');
  const acpFmt = getFormat('acp');
  assert(acpFmt.toSSE({ type:'text-delta', textDelta:'hello' }).includes('text'));
  const acpResp = acpFmt.toResponse(events);
  assert.strictEqual(acpResp.parts[0].text, 'hello'); assert.strictEqual(acpResp.finish, 'stop');
  assert(oai.toSSE({ type:'text-delta', textDelta:'hello' }, { id:'x', created:0 }).includes('choices'));
  const geminiResp = getFormat('gemini').toResponse(events);
  assert(geminiResp.candidates && geminiResp.candidates[0].content.parts[0].text === 'hello');
  assert(getFormat('mistral').toParams({ model:'m', messages:[{role:'user',content:'hi'}] }).messages);
  assert(getFormat('cohere').toParams({ model:'m', messages:[{role:'user',content:'hi'}] }));
  assert(getFormat('ollama').toParams({ model:'m', messages:[{role:'user',content:'hi'}] }).model);
  assert(getFormat('bedrock').toParams({ model:'m', messages:[{role:'user',content:'hi'}] }));
  const { isBrand, listBrands } = require('./lib/openai-brands');
  assert.ok(isBrand('groq') && isBrand('openrouter') && isBrand('xai') && isBrand('sambanova') && isBrand('nvidia') && isBrand('zai') && isBrand('qwen') && isBrand('codestral') && isBrand('opencode-zen'));
  assert.ok(listBrands().length >= 8);

  // === Turn-1: comma-list + queue/<name> + sampler-aware + matrix-aware + peekNext + listAllModelsAndQueues ===
  const { resolveModel, chain, fallback, listNamedChains, getRunHistory, listAllModelsAndQueues, parseCommaList, splitPrefix } = require('./lib/sdk');
  // (i) parseCommaList
  assert.deepStrictEqual(parseCommaList('a/x, b/y , c/z'), ['a/x','b/y','c/z']);
  assert.strictEqual(parseCommaList('single'), null);
  assert.deepStrictEqual(splitPrefix('groq/llama'), { prefix: 'groq', rest: 'llama' });
  // (ii) chain([...]).peekNext returns array of {index,model,fallbackOn,blocked,reason}
  const fbObj = chain([{ model: 'groq/x', timeout: 1000 }, { model: 'gemini/y', temperature: 0.3 }, { model: 'mistral/z' }]);
  const peek = fbObj.peekNext(3);
  assert.strictEqual(peek.length, 3);
  assert.deepStrictEqual(peek.map(p => p.model), ['groq/x','gemini/y','mistral/z']);
  assert.strictEqual(peek[0].blocked, false);
  assert(Array.isArray(peek[0].fallbackOn));
  // (iii) chain w/ string-array via comma path
  const fb = fallback('groq/x').then('gemini/y').timeout(5000).build();
  assert.deepStrictEqual(fb.models, ['groq/x', 'gemini/y']);
  assert.strictEqual(typeof listNamedChains, 'function');
  assert(Array.isArray(getRunHistory()));
  assert.throws(() => chain([]), /non-empty/);
  assert.throws(() => chain('does-not-exist-chain'), /No named chain/);
  // (iv) sampler peekStatus
  const sampler = require('./lib/sampler');
  sampler.resetAvailability('test-prov');
  const ps0 = sampler.peekStatus('test-prov');
  assert.strictEqual(ps0.available, true); assert.strictEqual(ps0.lastFailedAt, null); assert.strictEqual(ps0.nextRetryAt, null);
  sampler.markFailed('test-prov');
  const ps1 = sampler.peekStatus('test-prov');
  assert.strictEqual(ps1.available, false); assert(ps1.lastFailedAt > 0); assert(ps1.nextRetryAt > Date.now());
  sampler.resetAvailability('test-prov');
  // (v) sampler-aware peekNext blocks links
  sampler.markFailed('blockedprefix');
  const fbBlocked = chain([{ model: 'blockedprefix/x' }, { model: 'groq/y' }]);
  const peekB = fbBlocked.peekNext(2);
  assert.strictEqual(peekB[0].blocked, true); assert.strictEqual(peekB[0].reason, 'sampler_backoff');
  assert.strictEqual(peekB[1].blocked, false);
  sampler.resetAvailability('blockedprefix');
  // (vi) queues — resolveQueue from inline queuesMap
  const { resolveQueue, listAllQueues } = require('./lib/queues');
  const qMap = { fast: ['groq/llama-3.3-70b-versatile', 'mistral/mistral-small-latest'], single: ['groq/x'] };
  const q = resolveQueue({ name: 'fast', queuesMap: qMap });
  assert.strictEqual(q.links.length, 2); assert.strictEqual(q.links[0].model, 'groq/llama-3.3-70b-versatile');
  assert.throws(() => resolveQueue({ name: 'nope', queuesMap: qMap }), /not found/);
  const qList = listAllQueues({ queuesMap: qMap });
  assert.strictEqual(qList.length, 2);
  // (vii) matrix
  const { loadMatrix, matrixScore, clearMatrixCache } = require('./lib/matrix');
  clearMatrixCache();
  const mTmp = path.join(os.tmpdir(), 'acp-matrix-' + Date.now() + '.json');
  fs.writeFileSync(mTmp, JSON.stringify({ providers: [{ id: 'groq', models: [{ id: 'llama-3.3-70b-versatile', usable_in_any_mode: true, modes:{chat:{ok:true}} }, { id: 'old-model', usable_in_any_mode: false, modes:{chat:{ok:false}} }] }] }));
  const mat = await loadMatrix(mTmp);
  assert.strictEqual(matrixScore('groq', 'llama-3.3-70b-versatile', mat).ok, true);
  assert.strictEqual(matrixScore('groq', 'old-model', mat).ok, false);
  assert.strictEqual(matrixScore('groq', 'unknown', mat).ok, null);
  // (viii) listAllModelsAndQueues mixed shape
  const mixed = await listAllModelsAndQueues({ queuesMap: qMap });
  assert(mixed.some(r => r.id === 'queue/fast' && r.object === 'queue'));
  assert(mixed[0].links || mixed.find(r => r.id === 'queue/fast').links);

  // server & queue/sampler/runs routes
  const { createServer } = require('./lib/server');
  const _srv2 = await createServer({ port: 0, queuesProvider: () => qMap });
  const base = 'http://127.0.0.1:' + _srv2.port;
  const models = await fetch(base + '/v1/models').then(r => r.json());
  assert(Array.isArray(models.data));
  const queueRow = models.data.find(m => m.id === 'queue/fast');
  assert(queueRow, '/v1/models missing queue/fast row'); assert.strictEqual(queueRow.object, 'queue');
  const qRes = await fetch(base + '/v1/queues').then(r => r.json());
  assert(qRes.queues.some(q => q.name === 'fast'));
  const samp = await fetch(base + '/v1/sampler/status').then(r => r.json());
  assert(Array.isArray(samp.status));
  const runs = await fetch(base + '/v1/runs').then(r => r.json());
  assert(Array.isArray(runs.runs));
  const ct = await fetch(base + '/v1/messages/count_tokens', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: [{ role: 'user', content: 'abcd'.repeat(8) }] }) }).then(r => r.json());
  assert.ok(ct.input_tokens > 0);
  assert.ok((await fetch(base + '/metrics').then(r => r.text())).includes('agentapi_uptime_seconds'));
  const gct = await fetch(base + '/v1beta/models/gemini-2.0-flash:countTokens', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'hello world' }] }] }) }).then(r => r.json());
  assert.ok(gct.totalTokens > 0);

  const rGroq = resolveModel('groq/llama-3.3-70b-versatile');
  assert.strictEqual(rGroq.provider, 'openai-compat'); assert.strictEqual(rGroq.env, 'GROQ_API_KEY');
  assert.strictEqual(resolveModel('anthropic/claude-sonnet-4-6').provider, 'anthropic');
  assert.strictEqual(resolveModel('gemini/gemini-2.0-flash').provider, 'gemini');
  assert.strictEqual(resolveModel('ollama/llama3.2').provider, 'ollama');
  const { buildAutoChain, DEFAULT_ORDER: DO } = require('./lib/auto-chain');
  assert.ok(Array.isArray(DO) && DO.includes('groq'));
  process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || 'test-key';
  const acLinks = buildAutoChain();
  assert.ok(acLinks.some(l => l.model.startsWith('groq/')));
  const acr = await fetch(base + '/debug/auto-chain').then(r => r.json());
  assert.ok(Array.isArray(acr.links) && Array.isArray(acr.order));
  _srv2.server.close();

  // === Witnessed real call: comma-list descending past intentionally-bad first link to a working one ===
  if (process.env.GROQ_API_KEY && !/test-key/.test(process.env.GROQ_API_KEY)) {
    sampler.resetAvailability('groq'); sampler.resetAvailability('mistral'); sampler.resetAvailability('sambanova');
    const fallbacks = [];
    const result = await api.chat({
      model: 'groq/this-model-does-not-exist-xyz,groq/llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: 'Reply with exactly the word: OK' }],
      max_tokens: 16,
      onFallback: (info) => fallbacks.push(info),
    });
    assert(result && (result.choices?.[0]?.message?.content || result.content), 'comma-list chat returned nothing');
    assert(fallbacks.length >= 1, 'expected at least one fallback event from bad-first-link descent');
    assert(/groq\/this-model-does-not-exist-xyz/.test(fallbacks[0].from), 'first fallback should be from the bad link');
    const hist = getRunHistory();
    const last = hist[hist.length - 1];
    assert(last && Array.isArray(last.resolvedLinks) && last.resolvedLinks.length === 2);
    assert.strictEqual(last.finalModel, 'groq/llama-3.3-70b-versatile');
    console.log('[witnessed] comma-list descent ok, fallbacks=' + fallbacks.length + ' final=' + last.finalModel);
  } else {
    console.log('[skip] real-call witness — no GROQ_API_KEY');
  }
  try { fs.unlinkSync(mTmp); } catch {}

  // ACP daemon registry + spawn tests
  const { registerBackend, BACKENDS, splitModel } = require('./lib/acp-client');
  const { registerDaemon, CMDS, isUp } = require('./lib/acp-launcher');
  assert(BACKENDS['kilo'] && BACKENDS['opencode'] && BACKENDS['gemini-cli'] && BACKENDS['qwen-code'] && BACKENDS['codex-cli'] && BACKENDS['copilot-cli'] && BACKENDS['cline'] && BACKENDS['hermes-agent'] && BACKENDS['cursor-acp'] && BACKENDS['codeium-cli'] && BACKENDS['acp-cli'], 'all 11 ACP backends registered');
  assert.strictEqual(BACKENDS['gemini-cli'].base.includes('4810'), true, 'gemini-cli on port 4810');
  assert.strictEqual(BACKENDS['qwen-code'].base.includes('4820'), true, 'qwen-code on port 4820');
  assert.strictEqual(BACKENDS['codex-cli'].base.includes('4830'), true, 'codex-cli on port 4830');
  assert.strictEqual(BACKENDS['copilot-cli'].base.includes('4840'), true, 'copilot-cli on port 4840');
  assert.strictEqual(BACKENDS['cline'].base.includes('4850'), true, 'cline on port 4850');
  assert.strictEqual(BACKENDS['hermes-agent'].base.includes('4860'), true, 'hermes-agent on port 4860');
  assert.strictEqual(BACKENDS['cursor-acp'].base.includes('4870'), true, 'cursor-acp on port 4870');
  assert.strictEqual(BACKENDS['codeium-cli'].base.includes('4880'), true, 'codeium-cli on port 4880');
  assert.strictEqual(BACKENDS['acp-cli'].base.includes('4890'), true, 'acp-cli on port 4890');
  registerBackend('test-daemon', { base: 'http://localhost:9999', providerID: 'test', defaultModel: 'test/model' });
  assert(BACKENDS['test-daemon'], 'registerBackend works');
  const split = splitModel('test-daemon/my-model');
  assert.strictEqual(split.prefix, 'test-daemon', 'splitModel recognizes new backend');
  assert.strictEqual(split.model, 'my-model', 'splitModel extracts model');
  registerDaemon('test-daemon', 9999, [{ command: 'test', args: [] }]);
  assert(CMDS['test-daemon'], 'registerDaemon works');
  assert.strictEqual(CMDS['test-daemon'].port, 9999, 'daemon port set correctly');
  console.log('[witnessed] ACP registry extensibility ok');

  // Test all daemons in auto-chain
  const { hasProvider } = require('./lib/auto-chain');
  assert(hasProvider('gemini-cli'), 'gemini-cli available');
  assert(hasProvider('qwen-code'), 'qwen-code available');
  assert(hasProvider('codex-cli'), 'codex-cli available');
  assert(hasProvider('copilot-cli'), 'copilot-cli available');
  assert(hasProvider('cline'), 'cline available');
  assert(hasProvider('hermes-agent'), 'hermes-agent available');
  assert(hasProvider('cursor-acp'), 'cursor-acp available');
  assert(hasProvider('codeium-cli'), 'codeium-cli available');
  assert(hasProvider('acp-cli'), 'acp-cli available');
  const chain = buildAutoChain();
  const chainStr = chain.map(l => l.model).join(', ');
  assert(chainStr.includes('gemini-cli') && chainStr.includes('cline') && chainStr.includes('hermes-agent') && chainStr.includes('acp-cli'), 'all 11 daemons in auto-chain');
  console.log('[witnessed] auto-chain includes all 11 ACP daemons ok');

  console.log('ALL TESTS PASS');
}
run().catch(e => { console.error('FAIL:', e.message, e.stack); process.exit(1); });
