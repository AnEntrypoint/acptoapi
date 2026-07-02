'use strict';
// Model availability manager: only list models from the curated KNOWN dictionary.
// Every model must be:
// 1. In KNOWN (explicitly curated)
// 2. Have a swebench score (verified quality)
// 3. Be available (env key present or auto-launch works)
// 4. Not currently in sampler backoff (exponential backoff on failures)
// 5. Pass live probe (when enabled): lightweight 1-token request to verify endpoint responds

const fs = require('fs');
const path = require('path');
const os = require('os');
const { getBrand, isBrand } = require('./openai-brands');
const { getModelScore } = require('./swe-bench-scores');
const sampler = require('./sampler');
const keyring = require('./keyring');

const PROBE_ENABLED = process.env.ACPTOAPI_LIVE_PROBE === '1';
const PROBE_TTL_MS = Number(process.env.ACPTOAPI_PROBE_TTL_MS) || 600000;
const PROBE_CACHE_PATH = process.env.ACPTOAPI_PROBE_CACHE_PATH || path.join(os.homedir(), '.acptoapi', 'probe-cache.json');

let _probeCache = null;
function loadProbeCache() {
  if (_probeCache) return _probeCache;
  try { _probeCache = JSON.parse(fs.readFileSync(PROBE_CACHE_PATH, 'utf8')); } catch { _probeCache = {}; }
  return _probeCache;
}
function saveProbeCache() {
  if (!_probeCache) return;
  try {
    fs.mkdirSync(path.dirname(PROBE_CACHE_PATH), { recursive: true });
    fs.writeFileSync(PROBE_CACHE_PATH, JSON.stringify(_probeCache, null, 2));
  } catch {}
}
function clearProbeCache() { _probeCache = null; }

async function probeProvider(provider) {
  const cache = loadProbeCache();
  const now = Date.now();
  const cached = cache[provider];
  if (cached && (now - cached.ts) < PROBE_TTL_MS) return cached.ok;
  let ok = false;
  try {
    if (provider === 'anthropic') {
      const key = keyring.getKey('ANTHROPIC_API_KEY');
      if (!key) { ok = false; } else {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
          signal: AbortSignal.timeout(5000),
        });
        ok = r.ok || r.status === 429;
      }
    } else if (provider === 'gemini' || provider === 'google') {
      const key = keyring.getKey('GEMINI_API_KEY');
      if (!key) { ok = false; } else {
        const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + key, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: 'hi' }] }], generationConfig: { maxOutputTokens: 1 } }),
          signal: AbortSignal.timeout(5000),
        });
        ok = r.ok || r.status === 429;
      }
    } else if (isBrand(provider)) {
      const brand = getBrand(provider);
      if (brand) {
        const key = keyring.getKey(brand.envKey);
        if (key) {
          const url = typeof brand.url === 'function' ? brand.url() : brand.url;
          const r = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
            body: JSON.stringify({ model: 'test', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
            signal: AbortSignal.timeout(5000),
          });
          ok = r.ok || r.status === 429;
        }
      }
    } else if (provider === 'ollama') {
      const r = await fetch(process.env.OLLAMA_URL || 'http://localhost:11434/api/tags', { signal: AbortSignal.timeout(3000) });
      ok = r.ok;
    } else if (['kilo','opencode','qwen-code','codex-cli','copilot-cli','cline','hermes-agent','cursor-acp','codeium-cli','acp-cli'].includes(provider)) {
      ok = true;
    } else {
      ok = true;
    }
  } catch { ok = false; }
  cache[provider] = { ok, ts: now };
  saveProbeCache();
  return ok;
}

async function probeAllProviders() {
  if (!PROBE_ENABLED) return {};
  const providers = Object.keys(KNOWN);
  const results = {};
  await Promise.all(providers.map(async (p) => { results[p] = await probeProvider(p); }));
  return results;
}

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

function _probeOk(provider) {
  if (!PROBE_ENABLED) return true;
  const cache = loadProbeCache();
  const cached = cache[provider];
  if (!cached) return true;
  return cached.ok;
}

async function getAvailableModelsLive({ log = () => {}, force = false } = {}) {
    const out = [];
    for (const [provider, models] of Object.entries(KNOWN)) {
        if (!isAvailable(provider)) {
            log(`[known] ${provider}: no env key`);
            continue;
        }
        const status = sampler.peekStatus(provider);
        if (status && status.nextRetryAt) {
            const now = Date.now();
            const msUntilRetry = status.nextRetryAt - now;
            if (msUntilRetry > 0) {
                log(`[known] ${provider}: in backoff for ${Math.round(msUntilRetry / 1000)}s (failCount=${status.failCount})`);
                continue;
            }
        }
        if (PROBE_ENABLED || force) {
            const ok = await probeProvider(provider);
            if (!ok) {
                log(`[known] ${provider}: probe FAILED`);
                continue;
            }
        }
        const bucket = ACP_DAEMON_NAMES.has(provider) ? 'acp' : 'direct';
        for (const model of models) {
            const fullId = `${provider}/${model}`;
            const score = getModelScore(fullId);
            if (!score) {
                log(`[known] ${fullId}: no swebench score (SKIPPING)`);
                continue;
            }
            out.push({ provider, model, score, bucket });
        }
    }
    const direct = out.filter(m => m.bucket === 'direct').sort((a, b) => b.score - a.score);
    const acp = out.filter(m => m.bucket === 'acp').sort((a, b) => b.score - a.score);
    const sorted = [...direct, ...acp];
    log(`[known] listed ${sorted.length} models (${direct.length} direct, ${acp.length} ACP)`);
    return sorted;
}

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
        if (!_probeOk(provider)) {
            log(`[known] ${provider}: probe cached FAILED`);
            continue;
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

module.exports = { getAvailableModels, getAvailableModelsLive, buildChainFromModels, isAvailable, probeProvider, probeAllProviders, clearProbeCache, loadProbeCache };
