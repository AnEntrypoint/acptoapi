'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { probeModels } = require('./model-prober');
const { getBrand, isBrand } = require('./openai-brands');
const keyring = require('./keyring');

const CACHE_DIR = path.join(os.homedir(), '.acptoapi');
const CACHE_FILE = path.join(CACHE_DIR, 'models-cache.json');
const TTL_MS = 24 * 60 * 60 * 1000;

const STATIC_FALLBACK = {
  anthropic:  'anthropic/claude-haiku-4-5-20251001',
  groq:       'groq/llama-3.3-70b-versatile',
  nvidia:     'nvidia/moonshotai/kimi-k2.6',
  cerebras:   'cerebras/llama-3.3-70b',
  sambanova:  'sambanova/Meta-Llama-3.3-70B-Instruct',
  mistral:    'mistral/mistral-large-latest',
  codestral:  'codestral/codestral-latest',
  qwen:       'qwen/qwen-plus',
  zai:        'zai/glm-4-plus',
  cloudflare: 'cloudflare/@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  openrouter: 'openrouter/auto',
  gemini:     'gemini/gemini-2.0-flash',
  ollama:     'ollama/llama3.2',
};

const CHEAP_HINTS = ['haiku','mini','flash','8b','7b','3b','1b','small','nano','lite','tiny','fast'];
const SKIP_HINTS = ['embed','whisper','tts','image','vision-only','rerank','guard','moderation','dall','sd-','stable-diffusion'];

function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); }
  catch { return {}; }
}

function saveCache(cache) {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch (e) {}
}

function keyHash(provider) {
  const brand = isBrand(provider) ? getBrand(provider) : null;
  const env = brand?.envKey || (provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : provider === 'gemini' ? 'GEMINI_API_KEY' : null);
  const k = env ? (keyring.getKey(env) || '') : '';
  return crypto.createHash('sha256').update(k).digest('hex').slice(0, 16);
}

const STRONG_HINTS = ['claude-opus', 'claude-sonnet', 'gpt-5', 'gpt-4', 'kimi-k', 'deepseek-v', 'qwen3-coder', 'qwen-plus', 'qwen-max', 'mixtral-8x', 'llama-3.3', 'llama-3.1-405b', 'llama-3.1-70b', 'large', 'pro', 'premium', '405b', '235b', '120b', '70b'];
const WEAK_HINTS = ['mini', 'flash', 'lite', 'nano', 'tiny', 'small', 'fast', '1b', '3b', '7b', '8b', 'distill', 'preview', 'instant', 'haiku'];

function getSweScore(provider, modelName) {
    try {
        const full = modelName.includes('/') ? modelName : provider + '/' + modelName;
        const { getModelScore } = require('./swe-bench-scores');
        return getModelScore(full) || 0;
    } catch { return 0; }
}

function compareBySweScore(provider, a, b) {
    return getSweScore(provider, b) - getSweScore(provider, a);
}
function compareByStrongHintBucket(aLower, bLower) {
    const aStrong = STRONG_HINTS.some(h => aLower.includes(h)) ? 1 : 0;
    const bStrong = STRONG_HINTS.some(h => bLower.includes(h)) ? 1 : 0;
    return bStrong - aStrong;
}
function compareByWeakHintPenalty(aLower, bLower) {
    const aWeak = WEAK_HINTS.some(h => aLower.includes(h)) ? 1 : 0;
    const bWeak = WEAK_HINTS.some(h => bLower.includes(h)) ? 1 : 0;
    return aWeak - bWeak;
}

function pickStrong(provider, models) {
    if (!Array.isArray(models) || models.length === 0) return null;
    const filtered = models.filter(m => !SKIP_HINTS.some(h => m.toLowerCase().includes(h)));
    if (filtered.length === 0) return null;
    const sorted = [...filtered].sort((a, b) => {
        const aL = a.toLowerCase();
        const bL = b.toLowerCase();
        const byScore = compareBySweScore(provider, a, b);
        if (byScore !== 0) return byScore;
        const byStrongHint = compareByStrongHintBucket(aL, bL);
        if (byStrongHint !== 0) return byStrongHint;
        return compareByWeakHintPenalty(aL, bL);
    });
    return sorted[0] || filtered[0] || models[0];
}

function pickCheap(models) { return pickStrong(null, models); }

async function getDefaultModel(provider, opts = {}) {
  const { force = false, prober = probeModels } = opts;
  const cache = loadCache();
  const kh = keyHash(provider);
  const entry = cache[provider];
  const age = entry ? Date.now() - entry.ts : Infinity;
  if (!force && entry && entry.keyHash === kh && age >= 0 && age < TTL_MS && entry.model) {
    return entry.model;
  }
  const brand = isBrand(provider) ? getBrand(provider) : null;
  const apiKey = brand ? keyring.getKey(brand.envKey) : null;
  try {
    const probe = await prober(provider, apiKey);
    if (probe && Array.isArray(probe.models) && probe.models.length > 0) {
      const picked = pickStrong(provider, probe.models);
      if (picked) {
        const full = picked.startsWith(provider + '/') ? picked : provider + '/' + picked;
        cache[provider] = { model: full, keyHash: kh, ts: Date.now(), source: 'live' };
        saveCache(cache);
        return full;
      }
    }
  } catch {}
  return STATIC_FALLBACK[provider] || null;
}

function getDefaultModelSync(provider) {
  const cache = loadCache();
  const entry = cache[provider];
  if (entry && entry.model) return entry.model;
  return STATIC_FALLBACK[provider] || null;
}

async function refreshAll(providers) {
  const out = {};
  await Promise.all(providers.map(async (p) => { out[p] = await getDefaultModel(p); }));
  return out;
}

module.exports = { getDefaultModel, getDefaultModelSync, refreshAll, STATIC_FALLBACK, CACHE_FILE };
