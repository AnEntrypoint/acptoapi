'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { BRANDS } = require('./openai-brands');
const keyring = require('./keyring');

const TTL_MS = Number(process.env.ACPTOAPI_BRAND_CATALOG_TTL_MS) || 10 * 60 * 1000;
const CACHE_PATH = process.env.ACPTOAPI_BRAND_CATALOG_CACHE
  || path.join(os.homedir(), '.acptoapi', 'brand-catalog-cache.json');
const PROBE_TIMEOUT_MS = Number(process.env.ACPTOAPI_BRAND_CATALOG_TIMEOUT_MS) || 8000;

const MODELS_URL_OVERRIDE = {
  codestral: 'https://api.mistral.ai/v1/models',
  zai: 'https://api.z.ai/api/paas/v4/models',
  cohere: 'https://api.cohere.com/v1/models',
  'github-models': 'https://models.github.ai/catalog/models',
};

const MODELS_FILTER = {
  codestral: (id) => /^codestral/i.test(id) && !/embed/i.test(id),
  openrouter: (id) => !/:batch$/i.test(id),
};

function applyModelsFilter(name, ids) {
  const filter = MODELS_FILTER[name];
  return filter ? ids.filter(filter) : ids;
}

function rawBrandUrlThunkThrowsMeansUnconfiguredNotFatal(name) {
  const brand = BRANDS[name];
  if (!brand || !brand.url) return null;
  let url;
  try {
    url = typeof brand.url === 'function' ? brand.url() : brand.url;
  } catch {
    return null;
  }
  return typeof url === 'string' ? url : null;
}

function modelsUrlFor(name) {
  if (Object.prototype.hasOwnProperty.call(MODELS_URL_OVERRIDE, name)) {
    return MODELS_URL_OVERRIDE[name] || null;
  }
  const url = rawBrandUrlThunkThrowsMeansUnconfiguredNotFatal(name);
  if (!url) return null;
  return url
    .replace(/\/chat\/completions$/, '/models')
    .replace(/\/v2\/chat$/, '/v1/models');
}

let _mem = null;

function _load() {
  if (_mem) return _mem;
  try {
    _mem = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  } catch {
    _mem = {};
  }
  return _mem;
}

function _save() {
  if (!_mem) return;
  try {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    const tmp = CACHE_PATH + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(_mem));
    fs.renameSync(tmp, CACHE_PATH);
  } catch {}
}

function isFresh(entry) {
  return !!entry && typeof entry.ts === 'number' && (Date.now() - entry.ts) < TTL_MS;
}

const STALE_CEILING_MS = Number(process.env.ACPTOAPI_BRAND_CATALOG_STALE_CEILING_MS) || 21600000;

function getCachedModels(name) {
  const entry = _load()[name];
  if (!entry || !Array.isArray(entry.models) || !entry.models.length) return [];
  const age = Date.now() - (entry.ts || 0);
  if (age >= STALE_CEILING_MS) return [];
  return entry.models;
}

function peek() {
  const cache = _load();
  return Object.entries(cache).map(([brand, e]) => ({
    brand,
    count: Array.isArray(e.models) ? e.models.length : 0,
    ts: e.ts,
    fresh: isFresh(e),
    reason: e.reason || null,
  }));
}

function reason(name) {
  const entry = _load()[name];
  if (!entry || typeof entry.ts !== 'number') return null;
  if ((Date.now() - entry.ts) >= STALE_CEILING_MS) return null;
  return entry.reason || null;
}

function isAuthDead(name) {
  const r = reason(name);
  return r === 'http_401' || r === 'http_403';
}

function _extractIds(json) {
  const arr = Array.isArray(json && json.data) ? json.data
    : Array.isArray(json && json.models) ? json.models
    : Array.isArray(json) ? json
    : null;
  if (!arr) return null;
  return arr.map(m => (typeof m === 'string' ? m : (m && (m.id || m.name)))).filter(Boolean);
}

async function probeBrand(name, _isRetry = false) {
  const brand = BRANDS[name];
  if (!brand) return { models: [], reason: 'unknown_brand' };

  const url = modelsUrlFor(name);
  if (!url) return { models: [], reason: 'no_models_endpoint' };

  const key = brand.envKey ? keyring.getKey(brand.envKey) : null;
  if (brand.envKey && !key) return { models: [], reason: 'no_key' };

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
  try {
    const headers = key ? { authorization: 'Bearer ' + key } : {};
    const res = await fetch(url, { headers, signal: ctl.signal });
    const text = await res.text();

    if (!res.ok) {
      if ((res.status === 401 || res.status === 403) && brand.envKey && key) {
        try { keyring.markKeyFailed(brand.envKey, key, 'auth'); } catch {}
      }
      return { models: [], reason: 'http_' + res.status };
    }
    if (/creditserror|no payment method/i.test(text)) {
      return { models: [], reason: 'http_402' };
    }

    let json = null;
    try { json = JSON.parse(text); } catch { return { models: [], reason: 'bad_json' }; }
    const ids = _extractIds(json);
    if (!ids) return { models: [], reason: 'unrecognized_shape' };
    return { models: applyModelsFilter(name, ids), reason: null };
  } catch (e) {
    const timedOut = e && e.name === 'AbortError';
    if (timedOut && !_isRetry) return probeBrand(name, true);
    return { models: [], reason: timedOut ? 'timeout' : 'fetch_failed' };
  } finally {
    clearTimeout(timer);
  }
}

async function refreshAll(opts = {}) {
  const force = opts.force === true;
  const concurrency = Number(process.env.ACPTOAPI_BRAND_CATALOG_CONCURRENCY) || 4;
  const cache = _load();

  const hasEnumerableKeyedCatalog = (n) => {
    const brand = BRANDS[n];
    if (!brand.envKey) return false;
    return keyring.hasAnyKey(brand.envKey);
  };
  const names = Object.keys(BRANDS).filter((n) => {
    if (!hasEnumerableKeyedCatalog(n)) return false;
    if (!force && isFresh(cache[n])) return false;
    return true;
  });

  const results = {};
  let cursor = 0;
  const worker = async () => {
    while (cursor < names.length) {
      const name = names[cursor++];
      if (cursor > concurrency) await new Promise(r => setTimeout(r, 50 + Math.random() * 150));
      const out = await probeBrand(name);
      cache[name] = { models: out.models, ts: Date.now(), reason: out.reason };
      results[name] = out;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, names.length) }, worker));

  _mem = cache;
  _save();
  return results;
}

module.exports = {
  modelsUrlFor,
  probeBrand,
  refreshAll,
  getCachedModels,
  peek,
  reason,
  isAuthDead,
  MODELS_URL_OVERRIDE,
  CACHE_PATH,
};
