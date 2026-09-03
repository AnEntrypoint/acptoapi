'use strict';
// Live-fetched SWE-bench Pro leaderboard, disk-cached with a TTL -- mirrors
// lib/model-probe-live.js's probe-cache pattern (fetch -> disk cache -> sync
// reader). This file used to hand-maintain a static SWE_BENCH_SCORES table;
// most entries in that table were fabricated (no real model on
// SWE-bench Pro's leaderboard for e.g. Groq/Cerebras/SambaNova-hosted Llama
// variants -- Llama 3.x is not submitted to this benchmark by any vendor at
// all), presented with no marker distinguishing invented numbers from real
// ones. Rather than re-guess replacement numbers, scores are now fetched live
// from https://benchlm.ai/benchmarks/swePro, whose page embeds a genuine
// Next.js SSR JSON payload (__NEXT_DATA__ -> props.pageProps.leaderboard,
// each entry {model, slug, score, sourceModelId, ...}) -- witnessed directly
// (curl, no browser rendering needed) to be real, parseable, and internally
// consistent with corroborating spot-checks against a second aggregator
// (morphllm.com/swe-bench-pro) and Tencent's own Hy3 release note. A model
// simply absent from the fetched leaderboard gets no score (getModelScore
// returns null), which is honest -- unranked, not guessed.

const fs = require('fs');
const path = require('path');
const os = require('os');

const CACHE_TTL_MS = Number(process.env.ACPTOAPI_SWEBENCH_CACHE_TTL_MS) || 24 * 60 * 60 * 1000; // 24h
const CACHE_PATH = process.env.ACPTOAPI_SWEBENCH_CACHE_PATH || path.join(os.homedir(), '.acptoapi', 'swebench-scores-cache.json');
const SOURCE_URL = 'https://benchlm.ai/benchmarks/swePro';

// { scores: {slug: score}, lastUpdated: <site's own "lastUpdated" string>, fetchedAt: <ms> } | null
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

// Real network fetch + parse. Never throws -- a failed fetch (offline, site
// change, rate limit) leaves the existing cache (however stale) in place
// rather than wiping known-good data; the caller decides whether stale data
// is acceptable via isFresh().
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

// Refresh the on-disk cache from the live source. force=true refetches even
// if the current cache is still within TTL. Returns the fresh (or, on fetch
// failure, the existing) cache -- never throws, matching the rest of this
// module's fail-open-to-"no score" discipline rather than fail-open-to-a-
// guessed-number discipline.
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

// A few caller-side aliases that never appear as their own slug on the
// leaderboard (freddie's default model strings, generic provider/tier
// aliases) but should resolve to a real fetched entry. Maps an alias to the
// SAME slug key the live leaderboard uses -- not an independent number, so
// it always tracks whatever the live fetch currently says for that model.
const ALIASES = {
  'claude/opus': 'claude-opus-4-8',
  'claude/sonnet': 'claude-sonnet-5',
  'anthropic/claude-opus-4-8': 'claude-opus-4-8',
  'anthropic/claude-sonnet-5': 'claude-sonnet-5',
};

// ACP daemon prefixes whose model id is the underlying canonical model
const ACP_PREFIXES = new Set(['kilo','opencode','qwen-code','codex-cli','copilot-cli','cline','hermes-agent','cursor-acp','codeium-cli','acp-cli']);

// Synchronous read against whatever is currently cached on disk (populated
// by a prior refreshSweBenchScoresLive() call -- boot-time callers should
// await that once; this stays sync because it is called from hot per-request
// ranking paths, same constraint the old static table had). No live cache
// yet (fresh install, first run before any refresh completed) or a model
// absent from the leaderboard both return null -- unranked, never guessed.
function getModelScore(modelId) {
  if (!modelId) return null;
  const cache = loadCache();
  const scores = (cache && cache.scores) || null;
  if (!scores) return null;

  let id = modelId;
  const slash = id.indexOf('/');
  if (slash > 0 && (ACP_PREFIXES.has(id.slice(0, slash)) || /^extra-\d+$/.test(id.slice(0, slash)))) {
    id = id.slice(slash + 1);
  }
  const idLower = id.toLowerCase();

  if (ALIASES[idLower] && scores[ALIASES[idLower]] != null) return scores[ALIASES[idLower]];
  if (scores[idLower] != null) return scores[idLower];
  // The caller's model id is a provider/host string like
  // 'anthropic/claude-opus-4-8' or 'openrouter/claude-mythos-5'; the
  // leaderboard's own slugs are bare ('claude-opus-4-8'). Try the part after
  // the last slash as an exact slug match before falling to substring.
  const lastPart = idLower.includes('/') ? idLower.slice(idLower.lastIndexOf('/') + 1) : idLower;
  if (scores[lastPart] != null) return scores[lastPart];

  // Fallback: substring match against real leaderboard slugs, preferring the
  // longest (most specific) match, matching the old table's discipline.
  // Minimum 4 chars (leaderboard slugs are longer/more specific than the old
  // static table's short keys, e.g. 'gpt-5-2' vs a bare '5-2') to avoid false
  // positives.
  let best = null;
  let bestLen = 0;
  for (const [slug, score] of Object.entries(scores)) {
    if (slug.length >= 4 && idLower.includes(slug) && slug.length > bestLen) {
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
