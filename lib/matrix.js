'use strict';
const fs = require('fs');

const CACHE = new Map();
const TTL_MS = 60000;

async function fetchUrl(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
  if (!r.ok) throw new Error(`matrix HTTP ${r.status}`);
  return r.json();
}

async function loadMatrix(source) {
  if (!source) return null;
  const key = String(source);
  const cached = CACHE.get(key);
  if (cached && cached.expires > Date.now()) return cached.data;
  let data = null;
  if (typeof source === 'function') {
    data = await source();
  } else if (/^https?:\/\//.test(source)) {
    try { data = await fetchUrl(source); } catch { data = null; }
  } else {
    try { data = JSON.parse(fs.readFileSync(source, 'utf8')); } catch { data = null; }
  }
  CACHE.set(key, { data, expires: Date.now() + TTL_MS });
  return data;
}

function matrixScore(provider, model, matrix) {
  if (!matrix || !Array.isArray(matrix.providers)) return { ok: null, mode_count: 0 };
  const p = matrix.providers.find(x => x.id === provider || x.name === provider);
  if (!p || !Array.isArray(p.models)) return { ok: null, mode_count: 0 };
  const m = p.models.find(x => x.id === model || x.name === model);
  if (!m) return { ok: null, mode_count: 0 };
  if (typeof m.usable_in_any_mode === 'boolean') {
    const modes = m.modes ? Object.keys(m.modes).length : 0;
    return { ok: m.usable_in_any_mode, mode_count: modes };
  }
  if (m.modes && typeof m.modes === 'object') {
    const vals = Object.values(m.modes);
    const ok = vals.some(v => v && v.ok === true);
    return { ok, mode_count: vals.length };
  }
  return { ok: null, mode_count: 0 };
}

function clearMatrixCache() { CACHE.clear(); }

module.exports = { loadMatrix, matrixScore, clearMatrixCache };
