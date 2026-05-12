'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { probeModels } = require('./model-prober');
const { getBrand, isBrand } = require('./openai-brands');

const CACHE_DIR = path.join(os.homedir(), '.acptoapi');
const CACHE_FILE = path.join(CACHE_DIR, 'models-cache.json');
const TTL_MS = 24 * 60 * 60 * 1000;

const STATIC_FALLBACK = {
  anthropic:  'anthropic/claude-haiku-4-5-20251001',
  groq:       'groq/llama-3.3-70b-versatile',
  nvidia:     'nvidia/meta/llama-3.3-70b-instruct',
  cerebras:   'cerebras/llama3.1-70b',
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
  } catch (e) { /* non-fatal */ }
}

function keyHash(provider) {
  const brand = isBrand(provider) ? getBrand(provider) : null;
  const env = brand?.envKey || (provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : provider === 'gemini' ? 'GEMINI_API_KEY' : null);
  const k = env ? (process.env[env] || '') : '';
  return crypto.createHash('sha256').update(k).digest('hex').slice(0, 16);
}

function pickCheap(models) {
  if (!Array.isArray(models) || models.length === 0) return null;
  const filtered = models.filter(m => !SKIP_HINTS.some(h => m.toLowerCase().includes(h)));
  const sorted = [...filtered].sort((a, b) => {
    const aCheap = CHEAP_HINTS.some(h => a.toLowerCase().includes(h)) ? 0 : 1;
    const bCheap = CHEAP_HINTS.some(h => b.toLowerCase().includes(h)) ? 0 : 1;
    return aCheap - bCheap;
  });
  return sorted[0] || filtered[0] || models[0];
}

async function getDefaultModel(provider, opts = {}) {
  const { force = false, prober = probeModels } = opts;
  const cache = loadCache();
  const kh = keyHash(provider);
  const entry = cache[provider];
  if (!force && entry && entry.keyHash === kh && Date.now() - entry.ts < TTL_MS && entry.model) {
    return entry.model;
  }
  const brand = isBrand(provider) ? getBrand(provider) : null;
  const apiKey = brand ? process.env[brand.envKey] : null;
  try {
    const probe = await prober(provider, apiKey);
    if (probe && Array.isArray(probe.models) && probe.models.length > 0) {
      const picked = pickCheap(probe.models);
      if (picked) {
        const full = picked.startsWith(provider + '/') ? picked : provider + '/' + picked;
        cache[provider] = { model: full, keyHash: kh, ts: Date.now(), source: 'live' };
        saveCache(cache);
        return full;
      }
    }
  } catch { /* fall through */ }
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
  for (const p of providers) out[p] = await getDefaultModel(p, { force: true });
  return out;
}

module.exports = { getDefaultModel, getDefaultModelSync, refreshAll, STATIC_FALLBACK, CACHE_FILE };
