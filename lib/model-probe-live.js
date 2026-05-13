'use strict';
// Live model probe: enumerate models from each configured provider,
// chat-probe each with a 1-token prompt, return the working ones.
// Result is cached and reused to build a fallback chain.

const { probeModels, listSupportedProviders } = require('./model-prober');
const { getBrand, isBrand } = require('./openai-brands');

const CACHE_TTL_MS = 10 * 60 * 1000;
const CHAT_PROBE_TIMEOUT_MS = 6000;
const MAX_MODELS_PER_PROVIDER = 8;   // cap so we don't probe 100 models on openrouter

let _cache = null;

function pickEnvKey(provider) {
    if (provider === 'anthropic') return process.env.ANTHROPIC_API_KEY;
    if (provider === 'gemini') return process.env.GEMINI_API_KEY;
    if (provider === 'ollama') return null;
    try {
        const b = isBrand(provider) ? getBrand(provider) : null;
        return b ? process.env[b.envKey] : null;
    } catch { return null; }
}

function resolveUrl(provider) {
    if (provider === 'anthropic') return 'https://api.anthropic.com/v1/messages';
    if (provider === 'gemini') return null;
    if (provider === 'ollama') return (process.env.OLLAMA_URL || 'http://localhost:11434') + '/v1/chat/completions';
    try {
        const b = isBrand(provider) ? getBrand(provider) : null;
        if (!b) return null;
        return typeof b.url === 'function' ? b.url() : b.url;
    } catch { return null; }
}

async function chatProbe(provider, modelId) {
    const url = resolveUrl(provider);
    const apiKey = pickEnvKey(provider);
    if (!url) return { ok: false, reason: 'no_url' };
    if (provider !== 'ollama' && !apiKey) return { ok: false, reason: 'no_key' };

    const headers = { 'Content-Type': 'application/json' };
    let body;
    if (provider === 'anthropic') {
        headers['x-api-key'] = apiKey;
        headers['anthropic-version'] = '2023-06-01';
        body = { model: modelId, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] };
    } else {
        if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
        body = { model: modelId, max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] };
    }

    const t0 = Date.now();
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(CHAT_PROBE_TIMEOUT_MS),
        });
        const ms = Date.now() - t0;
        if (res.ok) return { ok: true, ms };
        return { ok: false, reason: `${res.status}`, ms };
    } catch (e) {
        return { ok: false, reason: e.name === 'TimeoutError' ? 'timeout' : (e.message || 'fail').slice(0, 80), ms: Date.now() - t0 };
    }
}

async function probeAllProviders({ providers, log = () => {} } = {}) {
    let list;
    if (providers) list = providers;
    else {
        let supported = [];
        try { supported = listSupportedProviders(); } catch { supported = []; }
        list = supported.filter(p => { try { return !!pickEnvKey(p); } catch { return false; } });
    }
    const out = [];
    for (const provider of list) {
        const apiKey = pickEnvKey(provider);
        const r = await probeModels(provider, apiKey);
        if (!r.models || !r.models.length) {
            log(`[probe] ${provider}: list failed (${r.error || 'no models'})`);
            continue;
        }
        const candidates = r.models.slice(0, MAX_MODELS_PER_PROVIDER);
        log(`[probe] ${provider}: testing ${candidates.length} of ${r.models.length} models`);
        const results = await Promise.all(candidates.map(m => chatProbe(provider, m).then(res => ({ provider, model: m, ...res }))));
        for (const x of results) {
            if (x.ok) {
                log(`[probe] ok   ${provider}/${x.model} (${x.ms}ms)`);
                out.push({ provider, model: x.model, ms: x.ms });
            } else {
                log(`[probe] fail ${provider}/${x.model} (${x.reason})`);
            }
        }
    }
    out.sort((a, b) => a.ms - b.ms);
    return out;
}

async function getOrRefresh({ force = false, log = () => {} } = {}) {
    if (!force && _cache && Date.now() - _cache.ts < CACHE_TTL_MS) return _cache.results;
    const results = await probeAllProviders({ log });
    _cache = { ts: Date.now(), results };
    return results;
}

function getCachedResults() {
    return _cache ? _cache.results : null;
}

function buildChainFromProbe(results, { localFallbacks = ['kilo/openrouter/free', 'opencode/minimax-m2.5-free', 'claude/sonnet'] } = {}) {
    const links = results.map(r => ({ model: `${r.provider}/${r.model}`, fallbackOn: ['error','rate_limit','timeout','empty'] }));
    for (const m of localFallbacks) {
        links.push({ model: m, fallbackOn: ['error','rate_limit','timeout','empty'] });
    }
    return links;
}

module.exports = { probeAllProviders, getOrRefresh, getCachedResults, buildChainFromProbe, chatProbe };
