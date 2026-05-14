'use strict';

const SWE_BENCH_SCORES = {
  // Source: https://benchlm.ai/benchmarks/sweVerified (May 13, 2026)
  // Official SWE-Bench Verified leaderboard scores
  'claude/mythos-preview': 93.9,
  'claude/sonnet-5': 92.4,
  'gpt/5.5': 88.7,
  'claude/opus-4.7': 87.6,
  'gpt/5.3-codex': 85.0,
  'deepseek/v4-pro-max': 80.6,
  'claude/opus-4.5': 80.9,
  'claude/opus-4.6': 80.8,
  'kimi/k2.6': 80.2,
  'gpt/5.2': 80.0,
  'claude/sonnet-4.6': 79.6,
  'deepseek/v4-pro-high': 79.4,
  'deepseek/v4-flash-max': 79.0,
  'qwen/3.6-plus': 78.8,
  'deepseek/v4-flash-high': 78.6,
  'mimo/v2-pro': 78.0,
  'glm/5': 77.8,
  'mistral/medium-3.5-128b': 77.6,
  'muse/spark': 77.4,
  'qwen/3.6-27b': 77.2,
  'claude/sonnet-4.5': 77.2,
  'kimi/k2.5-reasoning': 76.8,
};

const lastUpdated = '2026-05-13';

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
