'use strict';
// Integration witness: chain selection, named chains, fallthrough, sampler backoff,
// real-backend chain fallback, key rotation, format translation, edge cases.
// Mock-free  - NO stub HTTP, NO monkey-patching of sdk.chat/stream. Routing/format
// logic is exercised directly; live-dispatch dimensions (single model, comma-chain,
// queue, chain fallback, openai->anthropic translation) are witnessed against a REAL
// local OpenAI-compatible SSE server bound to a real socket (same pattern as the
// kilo/opencode ACP daemons  - a genuine HTTP backend, not a mock provider).

// Disabled globally, before any lib/server.js require: real ACP daemon
// autolaunch (kilo/opencode/qwen-code/...) spawns real child processes with
// no test-scoped teardown, which previously hung the whole suite indefinitely.
process.env.ACPTOAPI_ENABLE_ACP_AUTOLAUNCH = '0';
process.env.ACPTOAPI_DISABLE_PROBE = '1';

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

// ---- dependency/reachability sanity ----
test('reachability: core lib modules resolve and export expected shape', () => {
    const mods = [
        ['./lib/sdk', 'chat'],
        ['./lib/chain', 'chain'],
        ['./lib/queues', 'resolveQueue'],
        ['./lib/named-chains', 'resolveChain'],
        ['./lib/auto-chain', 'buildAutoChain'],
        ['./lib/keyring', 'getKey'],
        ['./lib/server', 'createServer'],
    ];
    for (const [mod, exportName] of mods) {
        const resolved = require.resolve(mod);
        assert(require('fs').existsSync(resolved), `${mod} should resolve to an existing file`);
        const m = require(mod);
        assert(typeof m[exportName] === 'function', `${mod} should export ${exportName} as a function`);
    }
});

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
    const { SWE_BENCH_SCORES, getModelScore, loadCache } = freshRequire('./lib/swe-bench-scores');
    assert(!SWE_BENCH_SCORES, 'the static SWE_BENCH_SCORES table was removed in favor of the live-fetched cache');
    // getModelScore should resolve ACP prefixed ids via underlying model lookup.
    // Pick a real slug from whatever the live cache currently has rather than
    // hardcoding one -- the upstream leaderboard's model roster changes over
    // time (this test previously hardcoded 'cline/claude-opus-4-1', which
    // stopped existing on the real leaderboard and made the test flake on
    // real leaderboard churn, not a real regression).
    const cache = loadCache();
    const realSlug = cache && cache.scores && Object.keys(cache.scores)[0];
    if (!realSlug) { console.log('[SKIP] swe-bench-scores: no live cache populated yet, skipping resolve check'); return; }
    const score = getModelScore(`cline/${realSlug}`);
    assert(score > 0, `getModelScore('cline/${realSlug}') should resolve to underlying score, got ${score}`);
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

// ---- extra-providers: file parsing + URL resolution (no network) ----
test('extra-providers: parseBaseURL handles bare hostname, full URL, no trailing slash', () => {
    const { parseBaseURL } = require('./lib/extra-providers');
    assert(parseBaseURL('my-host.com').host === 'my-host.com', 'bare hostname');
    assert(parseBaseURL('https://my-host.com').host === 'my-host.com', 'full URL');
    assert(parseBaseURL('http://my-host.com/v1').path === '/v1', 'path preserved');
    assert(parseBaseURL('my-host.com/').host === 'my-host.com', 'trailing slash stripped');
});

test('extra-providers: candidateChatURLs generates multiple candidates', () => {
    const { parseBaseURL, candidateChatURLs } = require('./lib/extra-providers');
    const urls = candidateChatURLs(parseBaseURL('my-host.com'));
    assert(Array.isArray(urls), 'should return array');
    assert(urls.length >= 2, 'at least 2 candidates');
    assert(urls.some(u => u.includes('/chat/completions')), 'all candidates end in chat/completions');
    assert(urls.filter(u => u.includes('/chat/completions')).length === urls.length, 'all should end with chat/completions');
    // No duplicates
    assert(urls.length === new Set(urls.map(u => u.toLowerCase())).size, 'duplicate candidates');
});

test('extra-providers: candidateMessagesURLs generates multiple candidates', () => {
    const { parseBaseURL, candidateMessagesURLs } = require('./lib/extra-providers');
    const urls = candidateMessagesURLs(parseBaseURL('my-host.com'));
    assert(Array.isArray(urls), 'should return array');
    assert(urls.length >= 2, 'at least 2 candidates');
    assert(urls.every(u => u.includes('/messages')), 'all candidates end in /messages');
});

test('extra-providers: candidateChatURLs short-circuits on known suffix', () => {
    const { parseBaseURL, candidateChatURLs } = require('./lib/extra-providers');
    const urls = candidateChatURLs(parseBaseURL('https://api.example.com/v1/chat/completions'));
    assert(urls.length === 1, 'exact chat/completions URL returns single candidate');
    assert(urls[0] === 'https://api.example.com/v1/chat/completions', 'returns exact URL');
});

test('extra-providers: parseProviderFile TSV format with 3+ cols', () => {
    const ep = require('./lib/extra-providers');
    const text = 'my-host.com\tsk-test-abc123\tmodel-a model-b\n# comment\nother.com\tsk-other-xyz\tmodel-c';
    const entries = ep.parseProviderFile(text);
    assert(entries.length === 2, 'expected 2 entries');
    assert(entries[0].baseURL === 'my-host.com', 'first entry URL');
    assert(entries[0].apiKey === 'sk-test-abc123', 'first entry key');
    assert.deepStrictEqual(entries[0].models, ['model-a', 'model-b'], 'first entry models');
    assert(entries[1].baseURL === 'other.com', 'second entry URL');
    assert.deepStrictEqual(entries[1].models, ['model-c'], 'second entry models');
});

test('extra-providers: parseProviderFile interleaved format (URL then key)', () => {
    const ep = require('./lib/extra-providers');
    const text = 'my-host.com\nsk-test-abc123\nother.com\nsk-other-xyz';
    const entries = ep.parseProviderFile(text);
    assert(entries.length === 2, 'expected 2 entries');
    assert(entries[0].baseURL === 'my-host.com', 'first URL');
    assert(entries[0].apiKey === 'sk-test-abc123', 'first key');
    assert(entries[1].baseURL === 'other.com', 'second URL');
    assert(entries[1].apiKey === 'sk-other-xyz', 'second key');
});

test('extra-providers: parseProviderFile tab-pair format (2 cols)', () => {
    const ep = require('./lib/extra-providers');
    const text = 'my-host.com\tsk-test-abc123\nother.com\tsk-other-xyz';
    const entries = ep.parseProviderFile(text);
    assert(entries.length === 2, 'expected 2 entries');
    assert(entries[0].baseURL === 'my-host.com', 'first URL');
    assert(entries[0].apiKey === 'sk-test-abc123', 'first key');
});

test('extra-providers: parseProviderFile skips comments and blank lines', () => {
    const ep = require('./lib/extra-providers');
    const text = '\n  \n# comment\nmy-host.com\tsk-test-abc123\tmodel-a\n\n# another\nother.com\tsk-other-xyz';
    const entries = ep.parseProviderFile(text);
    assert(entries.length === 2, 'expected 2 entries');
});

test('extra-providers: parseProviderFile handles models with trailing +N count', () => {
    const ep = require('./lib/extra-providers');
    const text = 'my-host.com\tsk-test-abc123\tmodel-a model-b +338';
    const entries = ep.parseProviderFile(text);
    assert(entries.length === 1, 'expected 1 entry');
    assert.deepStrictEqual(entries[0].models, ['model-a', 'model-b'], '+N stripped from models');
});

test('extra-providers: parseModelNames strips empty and returns array', () => {
    const { parseModelNames } = require('./lib/extra-providers');
    assert.deepStrictEqual(parseModelNames(''), [], 'empty string');
    assert.deepStrictEqual(parseModelNames(null), [], 'null');
    assert.deepStrictEqual(parseModelNames('a b c'), ['a', 'b', 'c'], 'simple');
    assert.deepStrictEqual(parseModelNames('model-a\tmodel-b'), ['model-a', 'model-b'], 'tab separated');
});

test('extra-providers: maskKey short and normal keys', () => {
    const ep = require('./lib/extra-providers');
    assert(ep.maskKey('abc') === 'ab***', 'short key');
    assert(ep.maskKey('sk-test-abc123def456') === 'sk-t...f456', 'normal key');
    assert(ep.maskKey('') === '', 'empty');
});

// ---- extra-providers: witness with local HTTP server ----
async function extraProviderWitness() {
    process.env.ACPTOAPI_ENABLE_ACP_AUTOLAUNCH = '0';
    // Create a local HTTP server that speaks both OpenAI and Anthropic formats
    // for probing. This is a REAL backend — no mocks.
    const extraServer = http.createServer((req, res) => {
        const url = req.url;
        const method = req.method;

        // OpenAI /v1/models endpoint (for auto-discovery)
        if (url.endsWith('/models') && method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                object: 'list',
                data: [
                    { id: 'gpt-4o', object: 'model' },
                    { id: 'gpt-4o-mini', object: 'model' },
                    { id: 'claude-sonnet-4-6-20250514', object: 'model' },
                    { id: 'claude-3-5-haiku-latest', object: 'model' },
                    { id: 'llama-3.3-70b-versatile', object: 'model' },
                ]
            }));
            return;
        }

        // OpenAI /chat/completions endpoint
        if (url.endsWith('/chat/completions') && method === 'POST') {
            let body = '';
            req.on('data', c => body += c);
            req.on('end', () => {
                let model = 'unknown';
                try { model = JSON.parse(body).model || 'unknown'; } catch {}
                const status = model === 'fail-me' ? 500 : 200;
                if (status === 200) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        id: 'chatcmpl-test',
                        object: 'chat.completion',
                        created: Date.now(),
                        model,
                        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
                        usage: { prompt_tokens: 2, completion_tokens: 1 },
                    }));
                } else {
                    res.writeHead(status, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: { message: 'simulated failure', type: 'server_error' } }));
                }
            });
            return;
        }

        // Anthropic /messages endpoint
        if (url.endsWith('/messages') && method === 'POST') {
            let body = '';
            req.on('data', c => body += c);
            req.on('end', () => {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    id: 'msg_test',
                    type: 'message',
                    role: 'assistant',
                    content: [{ type: 'text', text: 'ok' }],
                    model: 'claude-test',
                    stop_reason: 'end_turn',
                    stop_sequence: null,
                    usage: { input_tokens: 2, output_tokens: 1 },
                }));
            });
            return;
        }

        // Anything else is 404
        res.writeHead(404);
        res.end();
    });

    const port = await new Promise(resolve => {
        const s = extraServer.listen(0, '127.0.0.1', () => resolve(s.address().port));
    });
    const base = `http://127.0.0.1:${port}`;

    try {
        await testAsync('extra-providers: discoverOpenAI finds working chat/completions URL', async () => {
            const ep = freshRequire('./lib/extra-providers');
            const parsed = ep.parseBaseURL(base);
            const url = await ep.discoverOpenAI(parsed, 'sk-test-key', 3000);
            assert(url && url.includes('/chat/completions'), `expected chat/completions URL, got ${url}`);
        });

        await testAsync('extra-providers: discoverAnthropic finds working messages URL', async () => {
            const ep = freshRequire('./lib/extra-providers');
            const parsed = ep.parseBaseURL(base);
            const url = await ep.discoverAnthropic(parsed, 'sk-test-key', 3000);
            assert(url && url.includes('/messages'), `expected messages URL, got ${url}`);
        });

        await testAsync('extra-providers: probeModel returns ok for working model', async () => {
            const ep = freshRequire('./lib/extra-providers');
            const chatURL = `${base}/v1/chat/completions`;
            const result = await ep.probeModel(chatURL, 'sk-test-key', 'good-model', 3000);
            assert(result.ok === true, `expected ok=true, got ${JSON.stringify(result)}`);
            assert(typeof result.latencyMs === 'number', 'latencyMs should be a number');
        });

        await testAsync('extra-providers: probeModel returns failure for bad model', async () => {
            const ep = freshRequire('./lib/extra-providers');
            const chatURL = `${base}/v1/chat/completions`;
            const result = await ep.probeModel(chatURL, 'sk-test-key', 'fail-me', 3000);
            assert(result.ok === false, `expected ok=false, got ${JSON.stringify(result)}`);
        });

        await testAsync('extra-providers: probeModels works with stagger', async () => {
            const ep = freshRequire('./lib/extra-providers');
            const chatURL = `${base}/v1/chat/completions`;
            const results = await ep.probeModels(chatURL, 'sk-test-key', ['good-model', 'other-model'], 3000, 50);
            assert(results.size === 2, 'expected 2 results');
            const vals = Array.from(results.values());
            assert(vals[0].ok === true, 'first model ok');
            assert(vals[1].ok === true, 'second model ok');
        });

        await testAsync('extra-providers: probeEntry detects both formats and probes models', async () => {
            const ep = freshRequire('./lib/extra-providers');
            const entry = { baseURL: base, apiKey: 'sk-test-key', models: ['good-model'] };
            const result = await ep.probeEntry(entry, 3000, 3000);
            assert(result.openai && result.openai.includes('/chat/completions'), 'openai URL detected');
            assert(result.anthropic && result.anthropic.includes('/messages'), 'anthropic URL detected');
            assert(result.models.size === 1, 'expected 1 model probe result');
            assert(result.models.get('good-model').ok === true, 'model probe ok');
        });

        await testAsync('extra-providers: registerOne creates brand, keyring entry, and chain links', async () => {
            const ep = freshRequire('./lib/extra-providers');
            const brands = require('./lib/openai-brands');
            const keyringMod = require('./lib/keyring');
            ep.unregisterAll();

            const entry = { baseURL: base, apiKey: 'sk-test-key', models: ['good-model', 'fail-me'] };
            const probeResult = await ep.probeEntry(entry, 3000, 3000);
            assert(probeResult.openai, 'need openai endpoint for registration');

            const rec = ep.registerOne(entry, probeResult);
            assert(rec !== null, 'registerOne should succeed');
            assert(rec.prefix.startsWith('extra-'), `prefix should start with extra-, got ${rec.prefix}`);
            assert(rec.openaiURL && rec.openaiURL.includes('/chat/completions'), 'openai URL in rec');
            assert(rec.anthropicURL && rec.anthropicURL.includes('/messages'), 'anthropic URL in rec');
            assert(rec.workingModels.length === 1, `expected 1 working model, got ${rec.workingModels.length}`);
            assert(rec.failedModels.length === 1, `expected 1 failed model, got ${rec.failedModels.length}`);

            // Verify brand registration
            assert(brands.isBrand(rec.prefix) === true, `isBrand(${rec.prefix}) should be true`);

            // Verify keyring has the key
            const keys = keyringMod.listUsable(rec.envKey);
            assert(keys.length >= 1, `keyring should have key for ${rec.envKey}`);

            // Verify chain links
            const links = ep.getChainLinks();
            assert(links.some(l => l.model.startsWith(rec.prefix)), 'chain links include extra provider');

            // Verify model catalog
            const catalog = ep.getModelCatalog();
            assert(catalog.some(m => m.startsWith(rec.prefix)), 'model catalog includes extra provider');
        });

        await testAsync('extra-providers: loadAndRegister full lifecycle', async () => {
            // Create a temp file with TSV format pointing at our test server
            const tmpPath = require('path').join(require('os').tmpdir(), '.acptoapi-test-extra.txt');
            require('fs').writeFileSync(tmpPath, `${base}\tsk-test-key\tgood-model fail-me\n`, 'utf8');

            // Also point probe cache to a temp file
            const cachePath = require('path').join(require('os').tmpdir(), '.acptoapi-test-extra-probe-cache.json');
            process.env.ACPTOAPI_EXTRA_PROBE_CACHE = cachePath;

            const ep = freshRequire('./lib/extra-providers');
            ep.unregisterAll();
            delete require.cache[require.resolve('./lib/extra-providers')];
            const ep2 = require('./lib/extra-providers');

            const results = await ep2.loadAndRegister(tmpPath);
            assert(results.length >= 1, `expected >=1 registered, got ${results.length}`);

            // Clean up
            try { require('fs').unlinkSync(tmpPath); } catch {}
            try { require('fs').unlinkSync(cachePath); } catch {}
            delete process.env.ACPTOAPI_EXTRA_PROBE_CACHE;
        });

        await testAsync('extra-providers: tryListModels fetches model list from /v1/models', async () => {
            const ep = freshRequire('./lib/extra-providers');
            const models = await ep.tryListModels(`${base}/v1/chat/completions`, 'sk-test-key', 3000);
            assert(Array.isArray(models), 'should return array');
            assert(models.length >= 5, 'expected at least 5 models');
            assert(models.includes('gpt-4o'), 'should include gpt-4o');
        });

        await testAsync('extra-providers: scoreModelID ranks known models above unknown', () => {
            const ep = freshRequire('./lib/extra-providers');
            const known = ep.scoreModelID('gpt-5.5');
            const unknown = ep.scoreModelID('some-obscure-model-v1');
            assert(known > unknown, `known model (${known}) should score higher than unknown (${unknown})`);
        });

        await testAsync('extra-providers: sortModelIDs sorts by quality descending', () => {
            const ep = freshRequire('./lib/extra-providers');
            const sorted = ep.sortModelIDs(['gpt-4o-mini', 'gpt-5.5', 'some-junk-model']);
            assert(sorted[0] === 'gpt-5.5', `expected gpt-5.5 first, got ${sorted[0]}`);
            assert(sorted[sorted.length - 1] === 'some-junk-model', 'junk model should be last');
        });

        await testAsync('extra-providers: loadAndRegister auto-discovers models when file has none', async () => {
            const cachePath = require('path').join(require('os').tmpdir(), '.acptoapi-test-extra-auto-cache.json');
            const tmpPath = require('path').join(require('os').tmpdir(), '.acptoapi-test-extra-auto.txt');
            process.env.ACPTOAPI_EXTRA_PROBE_CACHE = cachePath;
            process.env.ACPTOAPI_EXTRA_MAX_MODELS = '10';
            delete require.cache[require.resolve('./lib/extra-providers')];

            require('fs').writeFileSync(tmpPath, `${base}\tsk-test-key\n`, 'utf8');
            const { loadAndRegister, unregisterAll, listRegistered } = require('./lib/extra-providers');
            unregisterAll();
            const results = await loadAndRegister(tmpPath);

            assert(results.length >= 1, 'should register at least one entry');
            for (const rec of results) {
                const hasProbedModels = rec.workingModels.length > 0 || rec.failedModels.length > 0;
                const hasUntested = rec.untestedModels.length > 0;
                assert(hasProbedModels || hasUntested, `entry ${rec.prefix} should have probed or untested models, got working=${rec.workingModels.length} failed=${rec.failedModels.length} untested=${rec.untestedModels.length}`);
            }

            try { require('fs').unlinkSync(tmpPath); } catch {}
            try { require('fs').unlinkSync(cachePath); } catch {}
            delete process.env.ACPTOAPI_EXTRA_PROBE_CACHE;
            delete process.env.ACPTOAPI_EXTRA_MAX_MODELS;
        });

        await testAsync('extra-providers: probe cache persists to disk via loadAndRegister', async () => {
            const cachePath = require('path').join(require('os').tmpdir(), '.acptoapi-test-extra-probe-cache3.json');
            const tmpPath = require('path').join(require('os').tmpdir(), '.acptoapi-test-extra-cache3.txt');
            process.env.ACPTOAPI_EXTRA_PROBE_CACHE = cachePath;
            delete require.cache[require.resolve('./lib/extra-providers')];

            require('fs').writeFileSync(tmpPath, `${base}\tsk-test-key\tgood-model\n`, 'utf8');
            const { loadAndRegister, unregisterAll } = require('./lib/extra-providers');
            unregisterAll();
            await loadAndRegister(tmpPath);

            assert(require('fs').existsSync(cachePath), 'cache file should exist after probe');
            const cacheContents = JSON.parse(require('fs').readFileSync(cachePath, 'utf8'));
            // sk-test-key (11 chars) → slice(0,4)='sk-t', slice(-4)='-key' → 'sk-t...-key'
            const cacheKey = `${base}|sk-t...-key`;
            assert(cacheContents[cacheKey], `cache should have entry for key "${cacheKey}"`);

            try { require('fs').unlinkSync(tmpPath); } catch {}
            try { require('fs').unlinkSync(cachePath); } catch {}
            delete process.env.ACPTOAPI_EXTRA_PROBE_CACHE;
        });
    } finally {
        extraServer.close();
    }
}

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

        await testAsync('real: single model round-trip completes within 5s', async () => {
            const startedAt = Date.now();
            const r = await sdk.chat({ model: 'localgood/m', messages: [{ role: 'user', content: 'hi' }] });
            const elapsedMs = Date.now() - startedAt;
            assert(r.choices[0].message.content === 'real-reply', 'expected real-reply');
            assert(elapsedMs < 5000, `expected round-trip under 5000ms, took ${elapsedMs}ms`);
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
    .then(() => extraProviderWitness())
    .catch(e => { console.error(`[FAIL] extraProviderWitness: ${e.message}`); failed++; })
    .finally(() => {
        console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
        process.exitCode = failed > 0 ? 1 : 0;
    });
