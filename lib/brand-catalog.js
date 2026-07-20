'use strict';

// Live per-brand model enumeration.
//
// buildAutoChain historically contributed exactly ONE hardcoded DEFAULT_MODELS
// entry per brand provider, while ACP daemons already expanded from a live
// catalog (ACP_MODEL_CACHE). That asymmetry capped the chain at ~11 links even
// with 600+ models actually reachable upstream. This module gives brand
// providers the same live-catalog treatment the ACP tier already had.
//
// Witnessed live (2026-07-19, real keys from ~/.acptoapi/.env):
//   openrouter 338, nvidia 119, mistral 72, opencode-zen 55, groq 15,
//   sambanova 6, cerebras 3  ->  608 models across 7 brands.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { BRANDS } = require('./openai-brands');
const keyring = require('./keyring');

const TTL_MS = Number(process.env.ACPTOAPI_BRAND_CATALOG_TTL_MS) || 600000; // 10min
const CACHE_PATH = process.env.ACPTOAPI_BRAND_CATALOG_CACHE
  || path.join(os.homedir(), '.acptoapi', 'brand-catalog-cache.json');
const PROBE_TIMEOUT_MS = Number(process.env.ACPTOAPI_BRAND_CATALOG_TIMEOUT_MS) || 8000;

// Per-brand models-endpoint overrides. The default rule derives the models URL
// from the brand's chat/completions URL, which holds for most OpenAI-compat
// vendors. These are the witnessed exceptions where the naive
// chat/completions -> /models swap does NOT hold:
//   codestral -> the codestral key enumerates against api.mistral.ai/v1/models
//                (its own codestral.mistral.ai/v1/models 404s "no Route matched")
//                -> 72 models live.
//   zai       -> z.ai's OpenAI-compat models list is under /api/paas/v4/models,
//                not /v1/models (which 404s nginx) -> 8 models live (glm-4.6 etc).
//   cohere    -> chat is /v2/chat; models list is /v1/models.
// A `false` value means "this brand has no enumerable catalog"; the caller
// falls back to the static DEFAULT_MODELS entry for it instead.
const MODELS_URL_OVERRIDE = {
  codestral: 'https://api.mistral.ai/v1/models',
  zai: 'https://api.z.ai/api/paas/v4/models',
  cohere: 'https://api.cohere.com/v1/models',
  // GitHub Models exposes its list as a catalog, not an OpenAI /models list.
  // The catalog returns [{id, ...}] so _extractIds handles it directly.
  'github-models': 'https://models.github.ai/catalog/models',
};

// Derive the models URL from a brand's chat URL. Returns null when the brand's
// url thunk throws (e.g. cloudflare with CLOUDFLARE_API_KEY set but
// CLOUDFLARE_ACCOUNT_ID missing) -- a throwing thunk means "not configured",
// never a reason to abort the whole sweep.
function modelsUrlFor(name) {
  if (Object.prototype.hasOwnProperty.call(MODELS_URL_OVERRIDE, name)) {
    return MODELS_URL_OVERRIDE[name] || null;
  }
  // Read the RAW brand, never getBrand() -- getBrand wraps the url thunk in a
  // getter that re-invokes it on property access, so `getBrand(name).url` would
  // throw here (e.g. cloudflare with CLOUDFLARE_ACCOUNT_ID unset) before any
  // try/catch could see it. Invoke the raw thunk ourselves, guarded.
  const brand = BRANDS[name];
  if (!brand || !brand.url) return null;
  let url;
  try {
    url = typeof brand.url === 'function' ? brand.url() : brand.url;
  } catch {
    return null; // unconfigured provider, not a fatal error
  }
  if (typeof url !== 'string') return null;
  return url
    .replace(/\/chat\/completions$/, '/models')
    .replace(/\/v2\/chat$/, '/v1/models');
}

// ---- disk cache -----------------------------------------------------------

let _mem = null; // { [brand]: { models: string[], ts: number, reason?: string } }

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
    fs.renameSync(tmp, CACHE_PATH); // atomic; concurrent watchers never see a partial file
  } catch { /* cache is best-effort */ }
}

function isFresh(entry) {
  return !!entry && typeof entry.ts === 'number' && (Date.now() - entry.ts) < TTL_MS;
}

// A catalog older than this is never used at all, fresh or not -- a genuinely
// abandoned entry (the brand hasn't been re-probed in hours) is more likely
// wrong than a 72-model list that just turned 11 minutes old. Far looser than
// TTL_MS on purpose: TTL_MS controls when a re-probe is DUE, not when the
// existing data becomes unusable.
const STALE_CEILING_MS = Number(process.env.ACPTOAPI_BRAND_CATALOG_STALE_CEILING_MS) || 21600000; // 6h

// Synchronous, no-network read of the cached catalog. This is the path
// buildAutoChain uses so a cold exec never blocks on the network.
//
// Serves STALE data (past TTL_MS but under STALE_CEILING_MS) rather than
// discarding it: a model catalog rarely changes minute to minute, and nothing
// in this process refreshes the cache on its own timer unless the standalone
// HTTP server (lib/server.js) or the readiness prober is running -- an
// in-process consumer (e.g. casey, which never boots lib/server.js) got a
// ONE-TIME catalog populated at first probe and then, the instant TTL_MS
// elapsed, buildAutoChain permanently fell back to each brand's single static
// DEFAULT_MODELS entry for the rest of the process's life: a live-witnessed
// flicker where the exact same buildAutoChain('auto') call returned 11
// diverse links one moment and 9 links (missing two real, working, keyed
// brands) minutes later with zero code change in between, purely because the
// TTL clock crossed 10 minutes between the two calls. Age is still recorded
// (isFresh) so callers that care can tell fresh from stale, but "stale" no
// longer means "treat as absent."
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

// Last recorded probe reason for a brand (null if the probe succeeded, no
// entry exists past STALE_CEILING_MS, or the brand was never probed). Used by
// the chain builder to exclude auth-dead brands rather than falling them back
// to a static default. Mirrors getCachedModels' staleness handling: a TTL-
// expired-but-recent auth failure (a dead key stays dead) must keep excluding
// the brand, not silently readmit it into the chain to fail the same 401
// again the moment TTL_MS elapses -- only STALE_CEILING_MS (hours, not
// minutes) treats the reason as unknown, in case the key was fixed meanwhile
// and nothing has re-probed it yet.
function reason(name) {
  const entry = _load()[name];
  if (!entry || typeof entry.ts !== 'number') return null;
  if ((Date.now() - entry.ts) >= STALE_CEILING_MS) return null;
  return entry.reason || null;
}

// A brand whose fresh catalog probe failed authentication -- its configured key
// is dead, so any static-default model for it is guaranteed to 401 too.
function isAuthDead(name) {
  const r = reason(name);
  return r === 'http_401' || r === 'http_403';
}

// ---- live probing ---------------------------------------------------------

function _extractIds(json) {
  const arr = Array.isArray(json && json.data) ? json.data
    : Array.isArray(json && json.models) ? json.models
    : Array.isArray(json) ? json
    : null;
  if (!arr) return null;
  return arr.map(m => (typeof m === 'string' ? m : (m && (m.id || m.name)))).filter(Boolean);
}

// Probe ONE brand's catalog. Never throws -- every failure path is recorded as
// a reason on the cache entry so a dead brand is visible rather than silent.
async function probeBrand(name) {
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
      // A 401/403 on the catalog endpoint means the configured key is dead.
      // Surface it via the keyring so the provider is demoted rather than
      // occupying a chain slot that is guaranteed to fail.
      if ((res.status === 401 || res.status === 403) && brand.envKey && key) {
        try { keyring.markKeyFailed(brand.envKey, key, 'auth'); } catch {}
      }
      return { models: [], reason: 'http_' + res.status };
    }

    let json = null;
    try { json = JSON.parse(text); } catch { return { models: [], reason: 'bad_json' }; }
    const ids = _extractIds(json);
    if (!ids) return { models: [], reason: 'unrecognized_shape' };
    return { models: ids, reason: null };
  } catch (e) {
    return { models: [], reason: e && e.name === 'AbortError' ? 'timeout' : 'fetch_failed' };
  } finally {
    clearTimeout(timer);
  }
}

// Refresh every brand that has a usable key. Bounded concurrency + jitter so a
// discovery sweep does not itself trip provider rate limits (each brand is a
// distinct host, but a burst across many keys still reads as a spike).
async function refreshAll(opts = {}) {
  const force = opts.force === true;
  const concurrency = Number(process.env.ACPTOAPI_BRAND_CATALOG_CONCURRENCY) || 4;
  const cache = _load();

  const names = Object.keys(BRANDS).filter((n) => {
    const brand = BRANDS[n];
    if (brand.envKey && !keyring.hasAnyKey(brand.envKey)) return false;
    if (!force && isFresh(cache[n])) return false;
    return true;
  });

  const results = {};
  let cursor = 0;
  const worker = async () => {
    while (cursor < names.length) {
      const name = names[cursor++];
      // Stagger: small jittered gap between probes on the same worker so the
      // sweep spreads out instead of firing as one synchronized burst.
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
