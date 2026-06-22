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
