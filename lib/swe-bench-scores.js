'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const CACHE_TTL_MS = Number(process.env.ACPTOAPI_SWEBENCH_CACHE_TTL_MS) || 24 * 60 * 60 * 1000;
const CACHE_PATH = process.env.ACPTOAPI_SWEBENCH_CACHE_PATH || path.join(os.homedir(), '.acptoapi', 'swebench-scores-cache.json');
const SOURCE_URL = 'https://benchlm.ai/benchmarks/swePro';

let _cache = null;

function loadCache() {
  if (_cache) return _cache;
  try { _cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8')); } catch { _cache = null; }
  return _cache;
}

function saveCache(cache) {
  _cache = cache;
  try {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
  } catch {}
}

function isFresh(cache) {
  return !!cache && typeof cache.fetchedAt === 'number' && (Date.now() - cache.fetchedAt) < CACHE_TTL_MS;
}

async function fetchLiveScores() {
  const res = await fetch(SOURCE_URL, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; acptoapi-swe-bench-refresh/1.0)' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`swe-bench-pro fetch failed: HTTP ${res.status}`);
  const html = await res.text();
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
  if (!m) throw new Error('swe-bench-pro fetch: __NEXT_DATA__ payload not found (site structure may have changed)');
  const data = JSON.parse(m[1]);
  const leaderboard = data && data.props && data.props.pageProps && data.props.pageProps.leaderboard;
  if (!Array.isArray(leaderboard) || !leaderboard.length) throw new Error('swe-bench-pro fetch: leaderboard array missing/empty in payload');
  const scores = {};
  for (const entry of leaderboard) {
    const slug = entry && (entry.slug || entry.sourceModelId);
    if (!slug || typeof entry.score !== 'number') continue;
    scores[String(slug).toLowerCase()] = entry.score;
  }
  return { scores, lastUpdated: (data.props.pageProps.lastUpdated || null), fetchedAt: Date.now() };
}

async function refreshSweBenchScoresLive({ force = false } = {}) {
  const existing = loadCache();
  if (!force && isFresh(existing)) return existing;
  try {
    const fresh = await fetchLiveScores();
    saveCache(fresh);
    return fresh;
  } catch {
    return existing;
  }
}

const ALIASES_TO_LEADERBOARD_SLUG = {
  'claude/opus': 'claude-opus-4-8',
  'claude/sonnet': 'claude-sonnet-5',
  'anthropic/claude-opus-4-8': 'claude-opus-4-8',
  'anthropic/claude-sonnet-5': 'claude-sonnet-5',
};

const ACP_PREFIXES_WITH_CANONICAL_MODEL_IDS = new Set(['kilo','opencode','qwen-code','codex-cli','copilot-cli','cline','hermes-agent','cursor-acp','codeium-cli','acp-cli']);

const MIN_SLUG_LEN_FOR_SUBSTRING_MATCH = 4;

function getModelScore(modelId) {
  if (!modelId) return null;
  const cache = loadCache();
  const scores = (cache && cache.scores) || null;
  if (!scores) return null;

  let id = modelId;
  const slash = id.indexOf('/');
  if (slash > 0 && (ACP_PREFIXES_WITH_CANONICAL_MODEL_IDS.has(id.slice(0, slash)) || /^extra-\d+$/.test(id.slice(0, slash)))) {
    id = id.slice(slash + 1);
  }
  const idLower = id.toLowerCase();

  if (ALIASES_TO_LEADERBOARD_SLUG[idLower] && scores[ALIASES_TO_LEADERBOARD_SLUG[idLower]] != null) return scores[ALIASES_TO_LEADERBOARD_SLUG[idLower]];
  if (scores[idLower] != null) return scores[idLower];
  const bareSlugAfterLastSlash = idLower.includes('/') ? idLower.slice(idLower.lastIndexOf('/') + 1) : idLower;
  if (scores[bareSlugAfterLastSlash] != null) return scores[bareSlugAfterLastSlash];

  let best = null;
  let bestLen = 0;
  for (const [slug, score] of Object.entries(scores)) {
    if (slug.length >= MIN_SLUG_LEN_FOR_SUBSTRING_MATCH && idLower.includes(slug) && slug.length > bestLen) {
      best = score;
      bestLen = slug.length;
    }
  }
  return best;
}

function sortByBenchmark(chain = []) {
  if (!chain || chain.length === 0) return chain;
  return [...chain].sort((a, b) => {
    const scoreA = getModelScore(a.model) || 0;
    const scoreB = getModelScore(b.model) || 0;
    return scoreB - scoreA;
  });
}

module.exports = { getModelScore, sortByBenchmark, refreshSweBenchScoresLive, loadCache, CACHE_PATH, CACHE_TTL_MS, SOURCE_URL };
