'use strict';

const SWE_BENCH_SCORES = {
  'claude/sonnet-5': 92.4,
  'gpt/5.5': 88.7,
  'claude/opus-4.7': 87.6,
  'gpt/5.3-codex': 85.0,
  'gemini/3.1-pro': 80.6,
  'claude/opus-4.6': 80.8,
  'claude/sonnet-4.6': 79.6,
  'claude/opus-4.5': 80.9,
};

const lastUpdated = '2026-05-14';

function sortByBenchmark(chain = []) {
  if (!chain || chain.length === 0) return chain;
  return [...chain].sort((a, b) => {
    const scoreA = getModelScore(a.model) || 0;
    const scoreB = getModelScore(b.model) || 0;
    return scoreB - scoreA;
  });
}

function getModelScore(modelId) {
  if (!modelId) return null;
  const normalized = modelId.toLowerCase()
    .replace(/^(anthropic|google|openai)\//, '')
    .replace(/-/g, '/')
    .replace(/\//g, '/');
  const exact = SWE_BENCH_SCORES[normalized] || SWE_BENCH_SCORES[modelId];
  if (exact) return exact;
  for (const [key, score] of Object.entries(SWE_BENCH_SCORES)) {
    if (modelId.includes(key.split('/')[1] || '')) return score;
  }
  return null;
}

module.exports = { SWE_BENCH_SCORES, sortByBenchmark, getModelScore, lastUpdated };
