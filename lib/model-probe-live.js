'use strict';
// Model availability manager: only list models from the curated KNOWN dictionary.
// Every model must be:
// 1. In KNOWN (explicitly curated)
// 2. Have a swebench score (verified quality)
// 3. Be available (env key present or auto-launch works)
// 4. Not currently in sampler backoff (exponential backoff on failures)

const { getBrand, isBrand } = require('./openai-brands');
const { getModelScore } = require('./swe-bench-scores');
const sampler = require('./sampler');
const keyring = require('./keyring');

// Curated KNOWN models: only these are exposed. Every entry must have a swebench score.
const KNOWN = {
    // Anthropic direct API
    anthropic: [
        'claude-opus-4',
        'claude-sonnet-4',
        'claude-haiku-4.5',
    ],
    // Google Gemini
    google: [
        'gemini-2.5-pro',
        'gemini-2.0-flash',
    ],
    // Groq
    groq: [
        'llama-3.3-70b-versatile',
        'llama-3.1-8b-instant',
    ],
    // OpenRouter (aggregator)
    openrouter: [
        'auto',
        'gemini-flash-lite',
    ],
    // Ollama (local)
    ollama: [
        'llama3.2',
        'llama2',
    ],
    // ACP daemons (11 total)
    kilo: [
        'openrouter/free',
    ],
    opencode: [
        'minimax-m2.5-free',
    ],
    'qwen-code': [
        'qwen-plus',
    ],
    'codex-cli': [
        'code-davinci-003',
    ],
    'copilot-cli': [
        'gpt-4o',
    ],
    'cline': [
        'claude-opus-4-1',
    ],
    'hermes-agent': [
        'hermes-3-70b',
    ],
    'cursor-acp': [
        'cursor-pro',
    ],
    'codeium-cli': [
        'claude-opus-4',
    ],
    'acp-cli': [
        'gpt-4-turbo',
    ],
};

function isAvailable(provider) {
    if (!KNOWN[provider]) return false;
    if (provider === 'anthropic') return !!process.env.ANTHROPIC_API_KEY;
    if (provider === 'google') return !!process.env.GEMINI_API_KEY;
    if (provider === 'gemini') return !!process.env.GEMINI_API_KEY;
    if (provider === 'ollama') return true;
    // All 11 ACP daemons are always available (auto-spawned on server startup)
    if (['kilo', 'opencode', 'gemini-cli', 'qwen-code', 'codex-cli', 'copilot-cli', 'cline', 'hermes-agent', 'cursor-acp', 'codeium-cli', 'acp-cli'].includes(provider)) {
        return true;
    }
    if (isBrand(provider)) {
        try {
            const b = getBrand(provider);
            if (!b) return false;
            if (provider === 'cloudflare') return !!process.env.CLOUDFLARE_ACCOUNT_ID && keyring.hasAnyKey('CLOUDFLARE_API_KEY');
            return keyring.hasAnyKey(b.envKey);
        } catch { return false; }
    }
    return false;
}

const ACP_DAEMON_NAMES = new Set(['kilo','opencode','qwen-code','codex-cli','copilot-cli','cline','hermes-agent','cursor-acp','codeium-cli','acp-cli']);

function getAvailableModels({ log = () => {} } = {}) {
    const direct = [];
    const acp = [];
    for (const [provider, models] of Object.entries(KNOWN)) {
        if (!isAvailable(provider)) {
            log(`[known] ${provider}: no env key`);
            continue;
        }
        // Check if provider is in exponential backoff from sampler
        const status = sampler.peekStatus(provider);
        if (status && status.nextRetryAt) {
            const now = Date.now();
            const msUntilRetry = status.nextRetryAt - now;
            if (msUntilRetry > 0) {
                log(`[known] ${provider}: in backoff for ${Math.round(msUntilRetry / 1000)}s (failCount=${status.failCount})`);
                continue;
            }
        }
        const bucket = ACP_DAEMON_NAMES.has(provider) ? acp : direct;
        for (const model of models) {
            const fullId = `${provider}/${model}`;
            const score = getModelScore(fullId);
            if (!score) {
                log(`[known] ${fullId}: no swebench score (SKIPPING)`);
                continue;
            }
            bucket.push({ provider, model, score });
        }
    }
    direct.sort((a, b) => b.score - a.score);
    acp.sort((a, b) => b.score - a.score);
    const out = [...direct, ...acp];
    log(`[known] listed ${out.length} models (${direct.length} direct, ${acp.length} ACP)`);
    return out;
}

function buildChainFromModels(models, { localFallbacks = [] } = {}) {
    const links = (models || []).map(m => ({ model: `${m.provider}/${m.model}`, fallbackOn: ['error','rate_limit','timeout','empty'] }));
    for (const fallback of localFallbacks) {
        links.push({ model: fallback, fallbackOn: ['error','rate_limit','timeout','empty'] });
    }
    return links;
}

module.exports = { getAvailableModels, buildChainFromModels, isAvailable };
