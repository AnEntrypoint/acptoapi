'use strict';

const { getBrand, BRANDS } = require('./openai-brands');

const MODELS_PATH_MAP = {
  anthropic: null,
  gemini: null,
  ollama: 'http://localhost:11434/api/tags',
};

const CACHE_TTL_MS = 5 * 60 * 1000;

function createModelProber() {
  const cache = new Map();

  function modelsUrl(provider) {
    if (provider in MODELS_PATH_MAP) return MODELS_PATH_MAP[provider];
    const brand = getBrand(provider);
    if (!brand || !brand.url) return null;
    const base = brand.url.replace(/\/chat\/completions$/, '');
    return base + '/models';
  }

  function parseModels(provider, json) {
    if (provider === 'ollama') {
      return (json.models || []).map(m => m.name || m.model).filter(Boolean);
    }
    if (Array.isArray(json.data)) return json.data.map(m => m.id || m.name).filter(Boolean);
    if (Array.isArray(json.models)) return json.models.map(m => m.id || m.name).filter(Boolean);
    return [];
  }

  async function fetchModels(provider, apiKey) {
    const url = modelsUrl(provider);
    if (!url) return null;
    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`${res.status}`);
    const json = await res.json();
    return parseModels(provider, json);
  }

  async function probe(provider, apiKey) {
    const cached = cache.get(provider);
    if (cached && Date.now() - cached.ts < CACHE_TTL_MS) return cached;
    try {
      const models = await fetchModels(provider, apiKey);
      const entry = { models, error: null, ts: Date.now() };
      cache.set(provider, entry);
      return entry;
    } catch (e) {
      const entry = { models: null, error: e.message, ts: Date.now() };
      cache.set(provider, entry);
      return entry;
    }
  }

  function getCached(provider) {
    return cache.get(provider) || null;
  }

  function listSupportedProviders() {
    return Object.keys(BRANDS).filter(p => {
      try { return modelsUrl(p) !== null; } catch { return false; }
    });
  }

  return { probe, getCached, listSupportedProviders, modelsUrl };
}

const _singleton = createModelProber();

module.exports = {
  createModelProber,
  probeModels: (p, k) => _singleton.probe(p, k),
  getCachedModels: (p) => _singleton.getCached(p),
  listSupportedProviders: () => _singleton.listSupportedProviders(),
};
