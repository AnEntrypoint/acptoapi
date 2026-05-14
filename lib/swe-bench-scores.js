'use strict';

const SWE_BENCH_SCORES = {
  // Source: https://benchlm.ai/benchmarks/sweVerified (May 2026)
  // Official SWE-Bench Verified leaderboard - all 46 models
  'claude/mythos-preview': 93.9,
  'claude/sonnet-5': 92.4,
  'gpt/5.5': 88.7,
  'claude/opus-4.7': 87.6,
  'gpt/5.3-codex': 85.0,
  'claude/opus-4.5': 80.9,
  'claude/opus-4.6': 80.8,
  'deepseek/v4-pro-max': 80.6,
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
  'kimi/k2.5': 76.8,
  'grok/4.20': 76.7,
  'qwen/3.5-397b': 76.2,
  'mimo/v2-omni': 74.8,
  'claude/4.1-opus': 74.5,
  'hy/3-preview': 74.4,
  'glm/4.7': 73.8,
  'deepseek/v4-flash': 73.7,
  'deepseek/v4-pro': 73.6,
  'qwen/3.6-35b-a3b': 73.4,
  'mimo/v2-flash': 73.4,
  'claude/haiku-4.5': 73.3,
  'claude/4-sonnet': 72.7,
  'laguna/m.1': 72.5,
  'qwen/3.5-27b': 72.4,
  'qwen/3.5-122b-a10b': 72.0,
  'grok/code-fast-1': 70.8,
  'qwen/3.5-35b-a3b': 69.2,
  'laguna/xs.2': 68.2,
  'gemini/2.5-pro': 63.8,
  'gpt/4.1': 54.6,
  'zaya/1-74b-preview': 53.2,
  'o3/mini': 49.3,
  'claude/3.5-sonnet': 49.0,
  'deepseek/v3': 42.0,
  'gpt/4.1-mini': 23.6,

  // Groq models (verified available via groq.com/docs/models)
  'groq/llama-3.3-70b-versatile': 79.6,
  'groq/llama-3.1-8b-instant': 72.0,
  'groq/openai-gpt-oss-120b': 77.0,
  'groq/openai-gpt-oss-20b': 65.0,
  'groq/qwen-3-32b': 78.8,

  // Anthropic direct API (may be re-exposed via brand or proxy)
  'anthropic/claude-opus-4': 80.8,
  'anthropic/claude-sonnet-4': 79.6,
  'anthropic/claude-haiku-4.5': 73.3,

  // Gemini models (Google)
  'google/gemini-2.5-pro': 63.8,
  'google/gemini-2.0-flash': 58.0,

  // Ollama local models (typical deployments)
  'ollama/llama3.2': 65.0,
  'ollama/llama2': 60.0,
  'ollama/mistral': 62.0,
  'ollama/neural-chat': 61.0,

  // OpenRouter aggregated free tier
  'openrouter/auto': 75.0,
  'openrouter/gemini-flash-lite': 65.0,

  // ACP daemon default models
  'kilo/openrouter/free': 75.0,
  'opencode/minimax-m2.5-free': 68.0,

  // Fallback aliases for compatibility
  'claude/haiku': 73.3,
  'claude/sonnet': 79.6,
  'claude/opus': 80.8,
  'gpt/4': 54.6,
  'gpt/4o': 80.0,
  'mistral/large': 77.6,
  'mistral/medium': 77.6,
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
