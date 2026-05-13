'use strict';
// Live model probe: enumerate models from each configured provider,
// chat-probe each with a 1-token prompt, return the working ones.

const { probeModels, listSupportedProviders } = require('./model-prober');
const { getBrand, isBrand } = require('./openai-brands');

const CACHE_TTL_MS = 10 * 60 * 1000;
const CHAT_PROBE_TIMEOUT_MS = 6000;
const MAX_MODELS_PER_PROVIDER = Number(process.env.ACPTOAPI_PROBE_CAP || 100);
const PROBE_CONCURRENCY = Number(process.env.ACPTOAPI_PROBE_CONCURRENCY || 12);

let _cache = null;
let _inFlight = null;

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
            method: 'POST', headers,
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

// Bounded-concurrency map
async function pMap(items, fn, concurrency) {
    const out = new Array(items.length);
    let i = 0;
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
        while (true) {
            const idx = i++;
            if (idx >= items.length) return;
            out[idx] = await fn(items[idx], idx);
        }
    });
    await Promise.all(workers);
    return out;
}

async function probeAllProviders({ providers, log = () => {} } = {}) {
    let list;
    if (providers) list = providers;
    else {
        let supported = [];
        try { supported = listSupportedProviders(); } catch { supported = []; }
        list = supported.filter(p => { try { return !!pickEnvKey(p); } catch { return false; } });
    }
    log(`[probe] enumerating models for ${list.length} provider(s): ${list.join(', ')}`);

    // 1. list models per provider in parallel
    const listings = await Promise.all(list.map(async provider => {
        const apiKey = pickEnvKey(provider);
        const r = await probeModels(provider, apiKey);
        if (!r.models || !r.models.length) {
            log(`[probe] ${provider}: list failed (${r.error || 'no models'})`);
            return { provider, models: [] };
        }
        const candidates = r.models.slice(0, MAX_MODELS_PER_PROVIDER);
        log(`[probe] ${provider}: probing ${candidates.length} of ${r.models.length} models`);
        return { provider, models: candidates };
    }));

    // 2. flatten to {provider, model} pairs and probe with bounded concurrency
    const pairs = [];
    for (const { provider, models } of listings) for (const model of models) pairs.push({ provider, model });

    const results = await pMap(pairs, async ({ provider, model }) => {
        const r = await chatProbe(provider, model);
        if (r.ok) log(`[probe] ok   ${provider}/${model} (${r.ms}ms)`);
        else log(`[probe] fail ${provider}/${model} (${r.reason})`);
        return { provider, model, ...r };
    }, PROBE_CONCURRENCY);

    const out = results.filter(r => r.ok).map(r => ({ provider: r.provider, model: r.model, ms: r.ms }));
    out.sort((a, b) => a.ms - b.ms);
    log(`[probe] done: ${out.length} working / ${pairs.length} probed`);
    return out;
}

function isFresh() {
    return _cache && Date.now() - _cache.ts < CACHE_TTL_MS;
}

async function getOrRefresh({ force = false, log = () => {} } = {}) {
    if (!force && isFresh()) return _cache.results;
    if (_inFlight) return _inFlight;
    _inFlight = (async () => {
        try {
            const results = await probeAllProviders({ log });
            _cache = { ts: Date.now(), results };
            return results;
        } finally { _inFlight = null; }
    })();
    return _inFlight;
}

function kickoff(log = () => {}) {
    if (isFresh() || _inFlight) return;
    getOrRefresh({ log }).catch(e => log(`[probe] kickoff error: ${e.message}`));
}

function getCachedResults() {
    return _cache ? _cache.results : null;
}

function buildChainFromProbe(results, { localFallbacks = ['kilo/openrouter/free', 'opencode/minimax-m2.5-free', 'claude/sonnet'] } = {}) {
    const links = (results || []).map(r => ({ model: `${r.provider}/${r.model}`, fallbackOn: ['error','rate_limit','timeout','empty'] }));
    for (const m of localFallbacks) {
        links.push({ model: m, fallbackOn: ['error','rate_limit','timeout','empty'] });
    }
    return links;
}

module.exports = { probeAllProviders, getOrRefresh, getCachedResults, buildChainFromProbe, chatProbe, kickoff, isFresh };
