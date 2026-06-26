'use strict';
// Integration witness: chain selection, named chains, fallthrough, sampler backoff.
// Mock-free — tests routing logic, not LLM responses (no live API calls made here).

const assert = require('assert');

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

// ---- summary ----
console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
