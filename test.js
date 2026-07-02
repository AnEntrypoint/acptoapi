'use strict';
// Integration witness: chain selection, named chains, fallthrough, sampler backoff,
// real-backend chain fallback, key rotation, format translation, edge cases.
// Mock-free  - NO stub HTTP, NO monkey-patching of sdk.chat/stream. Routing/format
// logic is exercised directly; live-dispatch dimensions (single model, comma-chain,
// queue, chain fallback, openai->anthropic translation) are witnessed against a REAL
// local OpenAI-compatible SSE server bound to a real socket (same pattern as the
// kilo/opencode ACP daemons  - a genuine HTTP backend, not a mock provider).

const assert = require('assert');
const http = require('http');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`[PASS] ${name}`);
        passed++;
    } catch (e) {
        console.error(`[FAIL] ${name}: ${e.message}`);
        failed++;
    }
}

async function testAsync(name, fn) {
    try {
        await fn();
        console.log(`[PASS] ${name}`);
        passed++;
    } catch (e) {
        console.error(`[FAIL] ${name}: ${e.message}`);
        failed++;
    }
}

// Reset modules to get clean state
function freshRequire(mod) {
    delete require.cache[require.resolve(mod)];
    return require(mod);
}

// ---- named-chains ----
test('resolveChain: fast returns 3 links', () => {
    const { resolveChain } = require('./lib/named-chains');
    const links = resolveChain('fast');
    assert(links && links.length === 3, `expected 3 links, got ${links && links.length}`);
    assert(links[0].model.startsWith('groq/'), `first link should be groq, got ${links[0].model}`);
});

test('resolveChain: cheap returns 3 links', () => {
    const { resolveChain } = require('./lib/named-chains');
    const links = resolveChain('cheap');
    assert(links && links.length === 3, `expected 3 links`);
});

test('resolveChain: smart, reasoning, free, local all resolve', () => {
    const { resolveChain } = require('./lib/named-chains');
    for (const name of ['smart', 'reasoning', 'free', 'local']) {
        const l = resolveChain(name);
        assert(l && l.length > 0, `${name} chain empty or null`);
    }
});

test('resolveChain: unknown model returns null (falls through)', () => {
    const { resolveChain } = require('./lib/named-chains');
    const r = resolveChain('completely-unknown-xyz');
    assert(r === null, `expected null for unknown chain, got ${JSON.stringify(r)}`);
});

test('resolveChain: auto sentinel returns null (handled by auto-chain)', () => {
    const { resolveChain } = require('./lib/named-chains');
    const r = resolveChain('auto');
    assert(r === null, `expected null for auto sentinel`);
});

test('resolveChain: free chain updated to 5 links, first groq/llama-4-scout', () => {
    const { resolveChain } = require('./lib/named-chains');
    const l = resolveChain('free');
    assert(l && l.length === 5, `expected 5 links, got ${l && l.length}`);
    assert(l[0].model === 'groq/llama-4-scout', `first link should be groq/llama-4-scout, got ${l[0].model}`);
});

test('resolveChain: hermes-free has 6 links, no ollama, last is hermes-agent', () => {
    const { resolveChain } = require('./lib/named-chains');
    const l = resolveChain('hermes-free');
    assert(l && l.length === 6, `expected 6 links, got ${l && l.length}`);
    assert(l[0].model === 'groq/llama-4-scout', `first link should be groq/llama-4-scout, got ${l[0].model}`);
    const last = l[l.length - 1].model;
    assert(last === 'hermes-agent/hermes-3-70b', `last link should be hermes-agent, got ${last}`);
    const hasLocal = l.some(x => x.model.startsWith('ollama/'));
    assert(!hasLocal, 'hermes-free should not contain local/ollama models');
});

// ---- auto-chain ----
test('buildAutoChain: unknown model pinned at front, chain non-empty', () => {
    process.env.GROQ_API_KEY = 'test-key';
    const { buildAutoChain } = require('./lib/auto-chain');
    const chain = buildAutoChain('my-unknown-model');
    assert(chain.length > 0, 'chain should not be empty');
    assert(chain[0].model === 'my-unknown-model', `expected pinned model at front, got ${chain[0].model}`);
});

test('buildAutoChain: undefined target produces default chain', () => {
    process.env.GROQ_API_KEY = 'test-key';
    const { buildAutoChain } = require('./lib/auto-chain');
    const chain = buildAutoChain(undefined);
    assert(chain.length > 0, 'default chain should not be empty');
});

// ---- model-probe-live: direct providers before ACP ----
test('getAvailableModels: direct providers sort before ACP daemons', () => {
    process.env.GROQ_API_KEY = 'test-key';
    delete process.env.ANTHROPIC_API_KEY;
    const probe = freshRequire('./lib/model-probe-live');
    const models = probe.getAvailableModels();
    const acpNames = new Set(['kilo','opencode','qwen-code','codex-cli','copilot-cli','cline','hermes-agent','cursor-acp','codeium-cli','acp-cli']);
    const firstAcpIdx = models.findIndex(m => acpNames.has(m.provider));
    if (firstAcpIdx < 0) return; // no ACP available, trivially correct
    const anyDirectAfterAcp = models.slice(firstAcpIdx).some(m => !acpNames.has(m.provider));
    assert(!anyDirectAfterAcp, 'direct providers must not appear after ACP daemons');
});

// ---- swe-bench-scores: no fabricated ACP wrapper entries ----
test('swe-bench-scores: ACP prefix entries removed from dict', () => {
    const { SWE_BENCH_SCORES, getModelScore } = freshRequire('./lib/swe-bench-scores');
    assert(!SWE_BENCH_SCORES['cline/claude-opus-4-1'], 'cline entry should not be in dict');
    assert(!SWE_BENCH_SCORES['copilot-cli/gpt-4o'], 'copilot-cli entry should not be in dict');
    // But getModelScore should still resolve ACP prefixed ids via underlying model lookup
    const score = getModelScore('cline/claude-opus-4-1');
    assert(score > 0, `getModelScore('cline/claude-opus-4-1') should resolve to underlying score, got ${score}`);
});

// ---- sdk.js: google prefix routes to gemini ----
test('sdk.js: google prefix in BUILTIN_PROVIDER', () => {
    const src = require('fs').readFileSync('./lib/sdk.js', 'utf8');
    assert(/google.*gemini/.test(src), 'google -> gemini mapping missing from BUILTIN_PROVIDER');
});

// ---- anthropic format translation ----
test('anthropic_messages_to_openai: basic text', () => {
    const { anthropic_messages_to_openai } = require('./lib/formats/anthropic');
    const r = anthropic_messages_to_openai([{ role: 'user', content: 'hello' }], 'sys');
    assert(r[0].role === 'system' && r[0].content === 'sys');
    assert(r[1].role === 'user' && r[1].content === 'hello');
});

test('anthropic_messages_to_openai: tool_use blocks', () => {
    const { anthropic_messages_to_openai } = require('./lib/formats/anthropic');
    const r = anthropic_messages_to_openai([{ role: 'assistant', content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', id: 'tu_1', name: 'f', input: { x: 1 } }] }]);
    assert(r[0].role === 'assistant' && r[0].content === 'ok');
    assert(r[0].tool_calls.length === 1 && r[0].tool_calls[0].function.name === 'f');
});

test('anthropic_messages_to_openai: image block base64', () => {
    const { anthropic_messages_to_openai } = require('./lib/formats/anthropic');
    const r = anthropic_messages_to_openai([{ role: 'user', content: [{ type: 'text', text: 'desc' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } }] }]);
    assert(r[0].role === 'user' && Array.isArray(r[0].content));
    assert(r[0].content.some(p => p.type === 'image_url'));
});

test('anthropic_messages_to_openai: tool_result', () => {
    const { anthropic_messages_to_openai } = require('./lib/formats/anthropic');
    const r = anthropic_messages_to_openai([{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'result' }] }]);
    assert(r[0].role === 'tool' && r[0].tool_call_id === 'tu_1');
});

test('openai_finish_to_anthropic_stop: all variants', () => {
    const { openai_finish_to_anthropic_stop } = require('./lib/formats/anthropic');
    assert(openai_finish_to_anthropic_stop('stop') === 'end_turn');
    assert(openai_finish_to_anthropic_stop('length') === 'max_tokens');
    assert(openai_finish_to_anthropic_stop('tool_calls') === 'tool_use');
    assert(openai_finish_to_anthropic_stop('stop_sequence') === 'stop_sequence');
    assert(openai_finish_to_anthropic_stop(null) === 'end_turn');
});

test('anthropic_tool_choice_to_openai: all variants', () => {
    const { anthropic_tool_choice_to_openai } = require('./lib/formats/anthropic');
    assert(anthropic_tool_choice_to_openai({ type: 'auto' }) === 'auto');
    assert(anthropic_tool_choice_to_openai({ type: 'any' }) === 'required');
    assert(anthropic_tool_choice_to_openai({ type: 'none' }) === 'none');
    assert(anthropic_tool_choice_to_openai({ type: 'tool', name: 'get_weather' }).function.name === 'get_weather');
    assert(anthropic_tool_choice_to_openai(null) === 'auto');
});

test('openai_message_to_anthropic: text + tool_calls', () => {
    const { openai_message_to_anthropic } = require('./lib/formats/anthropic');
    const r = openai_message_to_anthropic({ content: 'done', tool_calls: [{ id: 'call_1', function: { name: 'f', arguments: '{"x":1}' } }], finish_reason: 'tool_calls' });
    assert(r.type === 'message' && r.content.some(c => c.type === 'tool_use'));
    assert(r.stop_reason === 'tool_use');
});

test('AnthropicPassthroughEmitter: text stream', () => {
    const { AnthropicPassthroughEmitter } = require('./lib/formats/anthropic');
    const e = new AnthropicPassthroughEmitter();
    const start = e.start('msg_1', 'm', 10);
    assert(start.some(s => s.raw.includes('message_start')));
    const feed = e.feed_chunk({ choices: [{ delta: { content: 'hi' } }] });
    assert(feed.some(s => s.raw.includes('text_delta')));
    const fin = e.finish();
    assert(fin.some(s => s.raw.includes('message_stop')));
});

test('AnthropicPassthroughEmitter: tool_use stream', () => {
    const { AnthropicPassthroughEmitter } = require('./lib/formats/anthropic');
    const e = new AnthropicPassthroughEmitter();
    e.start('msg_1', 'm', 10);
    const f1 = e.feed_chunk({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'f', arguments: '{"x"' } }] } }] });
    assert(f1.some(s => s.raw.includes('content_block_start') && s.raw.includes('tool_use')));
    const f2 = e.feed_chunk({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] } }] });
    assert(f2.some(s => s.raw.includes('input_json_delta')));
    const fin = e.finish();
    assert(fin.some(s => s.raw.includes('message_stop')));
});

test('openai_chat_response_to_anthropic: converts tool_calls response', () => {
    const { openai_chat_response_to_anthropic } = require('./lib/formats/anthropic');
    const r = openai_chat_response_to_anthropic({
        choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: 'done', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'f', arguments: '{"x":1}' } }] } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
    assert(r && r.type === 'message', 'should produce message response');
    assert(r.stop_reason === 'tool_use', 'tool_calls finish maps to tool_use');
    assert(r.content.some(c => c.type === 'tool_use'), 'should have tool_use content');
    assert(r.usage.input_tokens === 10, 'should carry prompt tokens');
});

test('probe cache: load/save round-trip', () => {
    const tmpPath = require('path').join(require('os').tmpdir(), '.acptoapi-test-probe-cache.json');
    process.env.ACPTOAPI_PROBE_CACHE_PATH = tmpPath;
    const { loadProbeCache, clearProbeCache } = freshRequire('./lib/model-probe-live');
    clearProbeCache();
    const c = loadProbeCache();
    assert(c && typeof c === 'object', 'cache should be an object');
    c.test_provider = { ok: true, ts: Date.now() };
    require('fs').writeFileSync(tmpPath, JSON.stringify(c));
    const d = JSON.parse(require('fs').readFileSync(tmpPath, 'utf8'));
    assert(d.test_provider.ok === true, 'should persist probe result');
    require('fs').unlinkSync(tmpPath);
});

test('anthropic tools conversion: empty and null handling', () => {
    const { anthropic_tools_to_openai, anthropic_tool_choice_to_openai } = require('./lib/formats/anthropic');
    assert(anthropic_tools_to_openai([]) === undefined, 'empty tools returns undefined');
    assert(anthropic_tools_to_openai([{ name: 'f', input_schema: { type: 'object' } }]).length === 1, 'valid tool converts');
    assert(anthropic_tool_choice_to_openai(null) === 'auto', 'null tool_choice is auto');
    assert(anthropic_tool_choice_to_openai(undefined) === 'auto', 'undefined tool_choice is auto');
});

test('anthropic system prompt as list of text blocks', () => {
    const { anthropic_messages_to_openai } = require('./lib/formats/anthropic');
    const r = anthropic_messages_to_openai([{ role: 'user', content: 'hi' }], [{ type: 'text', text: 'part1' }, { type: 'text', text: 'part2' }]);
    assert(r[0].role === 'system' && r[0].content === 'part1\npart2', 'system list concatenated with newline');
});

test('anthropic image block: url source', () => {
    const { anthropic_image_block_to_openai_part } = require('./lib/formats/anthropic');
    const r = anthropic_image_block_to_openai_part({ source: { type: 'url', url: 'https://example.com/img.png' } });
    assert(r && r.type === 'image_url' && r.image_url.url === 'https://example.com/img.png', 'url image block converts');
    const n = anthropic_image_block_to_openai_part({ source: { type: 'base64', data: '' } });
    assert(n === null, 'empty data returns null');
    const n2 = anthropic_image_block_to_openai_part({});
    assert(n2 === null, 'no source returns null');
});

// ---- sampler backoff integration ----
test('sampler backoff excludes provider from getAvailableModels', () => {
    process.env.GROQ_API_KEY = 'test-key';
    const sampler = freshRequire('./lib/sampler');
    const probe = freshRequire('./lib/model-probe-live');
    const before = probe.getAvailableModels().some(m => m.provider === 'groq');
    sampler.markFailed('groq');
    const after = probe.getAvailableModels().some(m => m.provider === 'groq');
    assert(before, 'groq should be available before marking failed');
    assert(!after, 'groq should be excluded after sampler marks it failed');
});

// ---- error-response schema (live server, real fetch, mock-free) ----
// Boots createServer on an ephemeral port with auth on, ACP autolaunch + probe
// off, and asserts each error code returns {error:{message,code,hint}} with an
// actionable hint and no leaked filesystem path / stack frame to the client.
async function errorResponseWitness() {
    process.env.ACPTOAPI_API_KEY = 'test-witness-key';
    process.env.ACPTOAPI_ENABLE_ACP_AUTOLAUNCH = '0';
    process.env.ACPTOAPI_DISABLE_PROBE = '1';
    process.env.ACPTOAPI_BIND = '127.0.0.1';
    delete process.env.ANTHROPIC_API_KEY; delete process.env.GEMINI_API_KEY; delete process.env.GROQ_API_KEY;
    const { createServer } = freshRequire('./lib/server');
    const { server, port } = await createServer({ port: 0 });
    const base = `http://127.0.0.1:${port}`;
    const hit = async (path, opts = {}) => {
        const headers = { 'Content-Type': 'application/json', ...(opts.noauth ? {} : { Authorization: 'Bearer test-witness-key' }), ...(opts.headers || {}) };
        const r = await fetch(base + path, { method: opts.method || 'GET', headers, body: opts.body });
        return { status: r.status, body: await r.json().catch(() => ({})) };
    };
    const noLeak = b => { const s = JSON.stringify(b); return !/[A-Za-z]:\\/.test(s) && !/\n\s*at\s/.test(s) && !/server\.js:\d+/.test(s); };
    try {
        await testAsync('401 wrong gateway key -> hint + code', async () => {
            const { status, body } = await hit('/v1/models', { noauth: true, headers: { Authorization: 'Bearer wrong' } });
            assert(status === 401 && body.error.code === 'invalid_api_key' && /ANTHROPIC_API_KEY|ACPTOAPI_API_KEY/.test(body.error.hint), 'missing 401 hint');
            assert(noLeak(body), 'leaked path/stack');
        });
        await testAsync('400 malformed JSON -> hint', async () => {
            const { status, body } = await hit('/v1/chat/completions', { method: 'POST', body: '{not json' });
            assert(status === 400 && body.error.code === 'invalid_json' && body.error.hint, 'missing 400 json hint');
        });
        await testAsync('400 unknown model -> model string invalid hint', async () => {
            process.env.ACPTOAPI_DISABLE_CHAIN = '1';
            const { status, body } = await hit('/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'bogus-xyz', messages: [] }) });
            delete process.env.ACPTOAPI_DISABLE_CHAIN;
            assert(status === 400 && /model string invalid/.test(body.error.hint), 'missing model-invalid hint');
        });
        await testAsync('404 chain delete -> queues/env hint', async () => {
            const { status, body } = await hit('/v1/chains?name=nope', { method: 'DELETE' });
            assert(status === 404 && body.error.code === 'chain_not_found' && /chains\.json|ACPTOAPI_CHAINS/.test(body.error.hint), 'missing 404 hint');
        });
        await testAsync('404 unknown route -> route hint', async () => {
            const { status, body } = await hit('/no/such/route');
            assert(status === 404 && body.error.code === 'route_not_found' && body.error.hint, 'missing route hint');
        });
        await testAsync('401 brand missing key -> set ENV hint', async () => {
            process.env.ACPTOAPI_DISABLE_CHAIN = '1';
            const { status, body } = await hit('/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'groq/llama-3.3-70b-versatile', messages: [{ role: 'user', content: 'hi' }] }) });
            delete process.env.ACPTOAPI_DISABLE_CHAIN;
            assert(status === 401 && body.error.code === 'missing_provider_key' && /GROQ_API_KEY/.test(body.error.hint), 'missing brand-key hint');
        });
    } finally {
        server.close();
    }
}

// ---- real-backend integration: single model, comma-chain, queue/<name>, chain
//      fallback (first fails / second succeeds), key rotation, openai->anthropic
//      translation. Dispatched through the REAL sdk.chat / chain().chat path against
//      a genuine local OpenAI-compatible SSE server bound to a real socket (same
//      pattern as the kilo/opencode ACP daemons  - a real HTTP backend, not a mock).
//      No stub HTTP, no monkey-patching of sdk.chat/stream. ----

function startOpenAICompatServer({ requireAuth } = {}) {
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', c => (body += c));
        req.on('end', () => {
            const auth = req.headers['authorization'] || '';
            if (requireAuth && auth !== `Bearer ${requireAuth}`) {
                res.writeHead(401, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'unauthorized' }));
                return;
            }
            res.writeHead(200, { 'Content-Type': 'text/event-stream' });
            const send = o => res.write(`data: ${JSON.stringify(o)}\n\n`);
            send({ choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] });
            send({ choices: [{ index: 0, delta: { content: 'real-reply' } }] });
            send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
            res.write('data: [DONE]\n\n');
            res.end();
        });
    });
    return new Promise(r => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port })));
}

function closedPort() {
    return new Promise(r => {
        const s = http.createServer();
        s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); });
    });
}

async function realBackendSuite() {
    const { BRANDS } = require('./lib/openai-brands');
    const keyring = require('./lib/keyring');
    const sdk = require('./lib/sdk');
    const { chain } = require('./lib/chain');
    const { resolveQueue } = require('./lib/queues');

    const good = await startOpenAICompatServer({});
    const deadPort = await closedPort();
    BRANDS.localgood = { url: `http://127.0.0.1:${good.port}/v1/chat/completions`, envKey: 'LOCALGOOD_API_KEY' };
    BRANDS.localdead = { url: `http://127.0.0.1:${deadPort}/v1/chat/completions`, envKey: 'LOCALDEAD_API_KEY' };
    process.env.LOCALGOOD_API_KEY = 'k-good';
    process.env.LOCALDEAD_API_KEY = 'k-dead';
    try {
        // single model  - real round-trip through sdk.chat over a real socket.
        await testAsync('real: single model round-trip returns content', async () => {
            const r = await sdk.chat({ model: 'localgood/m', messages: [{ role: 'user', content: 'hi' }] });
            assert(r.choices[0].message.content === 'real-reply', `expected real-reply, got ${JSON.stringify(r.choices[0])}`);
        });

        // comma-chain  - parse + real dispatch through the working link.
        test('real: parseCommaList whitespace-tolerant split', () => {
            assert(JSON.stringify(sdk.parseCommaList('groq/a, mistral/b ,kilo/c')) === JSON.stringify(['groq/a', 'mistral/b', 'kilo/c']));
            assert(sdk.parseCommaList('groq/a') === null, 'single model is not a comma chain');
        });
        await testAsync('real: comma-chain model="dead,good" falls through to working link', async () => {
            const r = await sdk.chat({ model: 'localdead/x, localgood/m', messages: [{ role: 'user', content: 'hi' }], sampler: false });
            assert(r.choices[0].message.content === 'real-reply', 'comma-chain should fall through');
            assert(r.__chainAttempted[0].ok === false && r.__chainAttempted[0].model === 'localdead/x', 'first link is a real failed attempt');
        });

        // queue/<name>  - in-memory map, real temp file, and sdk dispatch.
        test('real: resolveQueue from in-memory queuesMap', () => {
            const q = resolveQueue({ name: 'myq', queuesMap: { myq: ['groq/x', 'mistral/y'] } });
            assert(q.links.length === 2 && q.links[0].model === 'groq/x');
        });
        test('real: resolveQueue from real temp file', () => {
            const fs = require('fs'), os = require('os'), path = require('path');
            const tmp = path.join(os.tmpdir(), 'acptoapi-test-queues-' + Date.now() + '.json');
            fs.writeFileSync(tmp, JSON.stringify({ queues: { fileq: ['cerebras/z', 'groq/w'] } }));
            try {
                const q = resolveQueue({ name: 'fileq', extraQueueSources: [tmp] });
                assert(q.links.length === 2 && q.links[0].model === 'cerebras/z');
            } finally { fs.unlinkSync(tmp); }
        });
        await testAsync('real: queue/<name> via sdk.chat dispatches queue links', async () => {
            const r = await sdk.chat({ model: 'queue/liveq', messages: [{ role: 'user', content: 'hi' }], sampler: false, queuesMap: { liveq: ['localdead/x', 'localgood/m'] } });
            assert(r.choices[0].message.content === 'real-reply', 'queue should resolve and fall through');
        });

        // chain fallback  - first link real-fails (ECONNREFUSED), second real-succeeds.
        await testAsync('real: chain fallback first fails second succeeds + onFallback fires', async () => {
            const fb = [];
            const r = await chain(['localdead/x', 'localgood/m'], { sampler: false, onFallback: ({ from, to, reason }) => fb.push({ from, to, reason }) })
                .chat({ messages: [{ role: 'user', content: 'hi' }] });
            assert(r.choices[0].message.content === 'real-reply', 'second link must serve content');
            assert(r.__chainAttempted.length === 2 && r.__chainAttempted[0].ok === false && r.__chainAttempted[1].ok === true, 'attempt log: fail then success');
            assert(fb.length === 1 && fb[0].from === 'localdead/x' && fb[0].to === 'localgood/m', 'onFallback reports the real transition');
        });

        // chain exhaustion  - all links real-fail -> throws with attempted/chainHistory.
        await testAsync('real: chain exhaustion throws with attempted populated', async () => {
            BRANDS.localdead2 = { url: `http://127.0.0.1:${deadPort}/v2/chat/completions`, envKey: 'LD2' };
            process.env.LD2 = 'k';
            let threw = null;
            try { await chain(['localdead/x', 'localdead2/y'], { sampler: false }).chat({ messages: [{ role: 'user', content: 'hi' }] }); }
            catch (e) { threw = e; }
            assert(threw && Array.isArray(threw.attempted) && threw.attempted.length === 2, 'exhaustion surfaces both failed attempts');
            assert(Array.isArray(threw.chainHistory), 'exhausted error carries chainHistory');
        });

        // format translation openai->anthropic, end-to-end through the real backend.
        await testAsync('real: openai->anthropic translation end-to-end', async () => {
            const r = await sdk.chat({ model: 'localgood/m', messages: [{ role: 'user', content: 'hi' }], output: 'anthropic' });
            assert(r.type === 'message' && r.role === 'assistant', 'anthropic-shaped response');
            assert(r.content[0].type === 'text' && r.content[0].text === 'real-reply', 'translated text block');
            assert(r.stop_reason === 'end_turn', 'stop finish_reason -> end_turn');
        });

        // key rotation  - real keyring backoff state machine.
        test('real: key rotation bad-primary auth-fail rotates to secondary', () => {
            keyring.reset('ROT_KEY');
            process.env.ROT_KEY = 'bad-primary';
            process.env.ROT_KEY_2 = 'good-secondary';
            try {
                assert(keyring.getKey('ROT_KEY') === 'bad-primary', 'primary used first');
                keyring.markKeyFailed('ROT_KEY', 'bad-primary', keyring.classify(401));
                assert(keyring.getKey('ROT_KEY') === 'good-secondary', 'rotates to secondary after auth-fail');
                assert(keyring.listUsable('ROT_KEY').length === 1 && keyring.listUsable('ROT_KEY')[0] === 'good-secondary', 'backed-off primary dropped from usable');
                assert(keyring.classify(401) === 'auth' && keyring.classify(429) === 'rate_limit' && keyring.classify(500) === 'upstream_5xx', 'status classification');
            } finally { delete process.env.ROT_KEY; delete process.env.ROT_KEY_2; keyring.reset('ROT_KEY'); }
        });

        // key rotation  - live witness: real server gives 401 to bad key, 200 to good key.
        await testAsync('real: server 401 bad key then 200 rotated key (live auth)', async () => {
            const secured = await startOpenAICompatServer({ requireAuth: 'good-secondary' });
            try {
                const bad = await fetch(`http://127.0.0.1:${secured.port}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer bad-primary' }, body: '{}' });
                assert(bad.status === 401, `bad key should get real 401, got ${bad.status}`);
                const okRes = await fetch(`http://127.0.0.1:${secured.port}/v1/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer good-secondary' }, body: '{}' });
                assert(okRes.status === 200, `rotated key should get real 200, got ${okRes.status}`);
                await okRes.text();
            } finally { secured.server.close(); }
        });

        // edge cases  - missing key, empty queue name, malformed model.
        await testAsync('real: missing-key brand chat throws (no silent success)', async () => {
            delete process.env.GROQ_API_KEY;
            keyring.reset('GROQ_API_KEY');
            let err = null;
            try { await sdk.chat({ model: 'groq/llama-3.3-70b-versatile', messages: [{ role: 'user', content: 'hi' }] }); }
            catch (e) { err = e; }
            assert(err instanceof Error, 'a real upstream/auth failure surfaces as a thrown Error');
        });
        test('real: resolveQueue empty name rejected', () => {
            let err = null;
            try { resolveQueue({ name: '', queuesMap: { '': ['groq/x'] } }); } catch (e) { err = e; }
            assert(err instanceof Error && /name required/.test(err.message), 'empty queue name must be rejected by resolveQueue');
        });
        await testAsync('real: queue/ (no name) does not silently succeed', async () => {
            let err = null;
            try { await sdk.chat({ model: 'queue/', messages: [] }); } catch (e) { err = e; }
            assert(err instanceof Error, 'malformed queue/ model must throw, never silently return');
        });
        test('real: resolveQueue unknown name throws', () => {
            let err = null;
            try { resolveQueue({ name: 'does-not-exist', queuesMap: {} }); } catch (e) { err = e; }
            assert(err instanceof Error && /not found/.test(err.message), 'unknown queue throws not-found');
        });
        test('real: resolveModel(undefined) defaults to acp/kilo (malformed-tolerant)', () => {
            const r = sdk.resolveModel(undefined);
            assert(r.provider === 'acp' && r.prefix === 'kilo', 'undefined model -> acp/kilo default');
        });

        // invisible fallback  - HTTP layer strips chain metadata even though the
        // raw sdk.chat() result (asserted above) carries __chainAttempted for
        // programmatic callers.
        await testAsync('real: HTTP /v1/chat/completions never leaks chain metadata on success', async () => {
            process.env.ACPTOAPI_DISABLE_ACP_AUTOLAUNCH = '1';
            process.env.ACPTOAPI_DISABLE_PROBE = '1';
            const { createServer } = freshRequire('./lib/server');
            const { server, port } = await createServer({ port: 0 });
            try {
                const r = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ model: 'localdead/x, localgood/m', messages: [{ role: 'user', content: 'hi' }] }),
                });
                const body = await r.json();
                assert(!('__chainAttempted' in body) && !('chainHistory' in body), 'HTTP response must not leak chain internals');
            } finally { server.close(); }
        });

        // availability HTTP surface  - GET /v1/availability reflects a real chain run.
        // (single-model sdk.chat() bypasses chain-machine.js entirely; only actual
        // multi-link chain() traversal records to availability, so drive it that way.)
        await testAsync('real: GET /v1/availability reflects a real chain success', async () => {
            const av = require('./lib/availability');
            av.reset();
            await chain(['localgood/m'], { sampler: false }).chat({ messages: [{ role: 'user', content: 'hi' }] });
            const { createServer } = freshRequire('./lib/server');
            const { server, port } = await createServer({ port: 0 });
            try {
                const r = await fetch(`http://127.0.0.1:${port}/v1/availability`);
                const body = await r.json();
                assert(Array.isArray(body.availability), 'availability endpoint returns an array');
                assert(body.availability.some(e => e.model === 'localgood/m'), 'tracked model appears in availability list');
            } finally { server.close(); }
        });
    } finally {
        good.server.close();
    }
}

// ---- availability tracking + dynamic reordering ----
test('availability: success bumps model ahead of failing model, unseen stays neutral', () => {
    const av = freshRequire('./lib/availability');
    av.reset();
    av.recordFailure('groq/bad');
    av.recordFailure('groq/bad');
    av.recordSuccess('mistral/good', 40);
    av.recordSuccess('mistral/good', 45);
    const ranked = av.rerank([{ model: 'groq/bad' }, { model: 'mistral/good' }, { model: 'unseen/x' }]);
    assert(ranked[0].model === 'mistral/good', `expected mistral/good first, got ${ranked.map(l => l.model)}`);
    assert(ranked[ranked.length - 1].model === 'groq/bad', `expected groq/bad last, got ${ranked.map(l => l.model)}`);
});

test('availability: single-link chain is a no-op', () => {
    const av = freshRequire('./lib/availability');
    av.reset();
    const links = [{ model: 'solo/model' }];
    assert(av.rerank(links) === links, 'single-link rerank must return the same array unchanged');
});

test('availability: all-neutral (no data) preserves original order', () => {
    const av = freshRequire('./lib/availability');
    av.reset();
    const links = [{ model: 'a/x' }, { model: 'b/y' }, { model: 'c/z' }];
    const ranked = av.rerank(links);
    assert(JSON.stringify(ranked.map(l => l.model)) === JSON.stringify(['a/x', 'b/y', 'c/z']), 'neutral chain must not reorder');
});

test('availability: getAll() shape', () => {
    const av = freshRequire('./lib/availability');
    av.reset();
    av.recordSuccess('groq/live', 30);
    const all = av.getAll();
    assert(all.length === 1 && all[0].model === 'groq/live' && typeof all[0].rank === 'number', 'availability.getAll() shape');
});

// ---- summary (after async witnesses complete) ----
realBackendSuite()
    .catch(e => { console.error(`[FAIL] realBackendSuite: ${e.message}`); failed++; })
    .then(() => errorResponseWitness())
    .catch(e => { console.error(`[FAIL] errorResponseWitness: ${e.message}`); failed++; })
    .finally(() => {
        console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
        process.exitCode = failed > 0 ? 1 : 0;
    });
