'use strict';

const SWE_BENCH_SCORES = {
  // Source: https://codingfleet.com/blog/swe-bench-pro-leaderboard-2026/ (Jul 2026)
  // SWE-bench Pro leaderboard - headline scores corroborated (Fable 5 80.3, Opus 4.8 69.2, Sonnet 5 63.2, GPT-5.5 58.6, Grok 4.5 64.7, Hy3 57.9).
  'claude/mythos-preview': 80.3,
  'claude/fable-5': 80.0,
  'claude/sonnet-5': 63.2,
  'claude/opus-4.8': 69.2,
  'claude/opus-4.7': 64.3,
  'claude/opus-4.5': 57.1,
  'claude/opus-4.6': 53.4,
  'gpt/5.5': 58.6,
  'gpt/5.4': 57.7,
  'gpt/5.3-codex': 56.8,
  'gpt/5.2': 55.6,
  'gpt/4.1': 54.6,
  'gpt/4/turbo': 54.6,
  'glm/5.2': 62.1,
  'glm/5.1': 58.4,
  'glm/5': 55.1,
  'glm/4.7': 73.8,
  'glm/4-plus': 72.4,
  'grok/4.5': 64.7,
  'grok/4.20': 51.8,
  'grok/code-fast-1': 70.8,
  'kimi/k2.6': 58.6,
  'kimi/k2.5-reasoning': 76.8,
  'kimi/k2.5': 50.7,
  'deepseek/v4-pro-max': 55.4,
  'deepseek/v4-pro-high': 54.4,
  'deepseek/v4-pro': 52.1,
  'deepseek/v4-flash-max': 52.6,
  'deepseek/v4-flash-high': 52.3,
  'deepseek/v4-flash': 49.1,
  'deepseek/v3': 42.0,
  'qwen/3.7-max': 60.6,
  'qwen/3.7-plus': 57.6,
  'qwen/3.6-max': 57.3,
  'qwen/3.6-plus': 56.6,
  'qwen/3.6-27b': 53.5,
  'qwen/3.5-397b': 50.9,
  'qwen/3.6-35b-a3b': 49.5,
  'qwen/plus': 72.4,
  'mimo/v2-pro': 57.2,
  'mimo/v2': 56.1,
  'mimo/v2-omni': 74.8,
  'mimo/v2-flash': 73.4,
  'gemini/2.5-pro': 55.1,
  'gemini/2.0-flash': 58.0,
  'muse/spark': 52.4,
  'minimax/m3': 59.0,
  'minimax/m2.7': 56.2,
  'minimax/m2.5-free': 78.0,
  'laguna/m.1': 49.2,
  'laguna/xs.2': 46.3,

  // Anthropic direct API (may be re-exposed via brand or proxy)
  'anthropic/claude-opus-4': 80.8,
  'anthropic/claude-sonnet-4': 79.6,
  'anthropic/claude-haiku-4.5': 73.3,

  // Gemini models (Google)
  'google/gemini-2.5-pro': 55.1,
  'google/gemini-2.0-flash': 58.0,
  'google/gemini-3.5-flash': 55.1,

  // Ollama local models (typical deployments)
  'ollama/llama3.2': 65.0,
  'ollama/llama2': 60.0,
  'ollama/mistral': 62.0,
  'ollama/neural-chat': 61.0,

  // OpenRouter aggregated free tier
  'openrouter/auto': 75.0,
  'openrouter/gemini-flash-lite': 65.0,

  // Fallback aliases for compatibility
  'claude/haiku': 73.3,
  'claude/sonnet': 79.6,
  'claude/opus': 80.8,
  'gpt/4': 54.6,
  'gpt/4o': 80.0,
  'mistral/large': 77.6,
  'mistral/medium': 77.6,

  // Groq models (verified available via groq.com/docs/models)
  // Note: Groq hosts various models; base model scores apply
  'groq/llama-3.3-70b-versatile': 79.6,
  'groq/llama-3.1-8b-instant': 72.0,
  'groq/openai-gpt-oss-120b': 77.0,
  'groq/openai-gpt-oss-20b': 65.0,
  'groq/qwen-3-32b': 78.8,

  // Cerebras-hosted models (same base models, different inference host)
  'cerebras/llama-3.3-70b': 79.6,
  'cerebras/zai-org/glm-5.2': 62.1,
  'cerebras/zai/glm/4/7': 73.8,

  // SambaNova-hosted Llama (same base as groq/cerebras, different host)
  'sambanova/meta-llama-3.3-70b-instruct': 79.6,
  'sambanova/Meta-Llama-3.3-70B-Instruct': 79.6,

  // Codestral (Mistral, published SWE-bench Pro)
  'codestral/codestral-latest': 72.2,

  // Zhipu ZAI models
  'zai/glm-4-plus': 72.4,

  // Cloudflare Workers AI routes to Llama 3.3 70B (fp8 quantized)
  'cloudflare/@cf/meta/llama-3.3-70b-instruct-fp8-fast': 79.6,

  // ACP daemon inner-model scores  - these are the model ids after the daemon
  // prefix is stripped by getModelScore()'s ACP_PREFIXES check. Each entry
  // uses the normalized lookup form (lowercased, hyphens→slashes) so the
  // exact-match path in getModelScore() resolves without hitting the fallback.
  'openrouter/free': 55.0,         // OpenRouter free-tier routing (aggregator, last-resort)
  'qwen/plus': 72.4,               // Qwen commercial API (matches Qwen 3.5 27b capability)
  'hermes/3/70b': 68.0,            // Nous Hermes 3 70B (est.)
  'cursor/pro': 65.0,               // Cursor pro model (est.)
  'minimax/m2/5/free': 78.0,       // MiniMax m2.5 free (est.)
  'chatjimmy/llama3/1/8b': 60.0,    // Llama 3.1 8B hosted by ChatJimmy
  'opencode-zen/hy3-free': 57.9,    // Tencent Hy3 (opencode-zen) - SWE-bench Pro 57.9% (codingfleet.com, Jul 2026). Auto-chain preferred default.

  // Extra-provider fallback models (~/.acptoapi/extra-providers.txt auto-discovery)
  'deepseek-chat': 65.0,
  'gpt-4o-mini': 50.0,
  'gemini-2.5-flash': 50.0,
  'llama-4-maverick': 68.0,
  'llama-4-scout': 52.0,
  'command-r-plus-08-2024': 40.0,
  'mistral-tiny': 35.0,
};

const lastUpdated = '2026-07-09';

function sortByBenchmark(chain = []) {
  if (!chain || chain.length === 0) return chain;
  return [...chain].sort((a, b) => {
    const scoreA = getModelScore(a.model) || 0;
    const scoreB = getModelScore(b.model) || 0;
    return scoreB - scoreA;
  });
}

// ACP daemon prefixes whose model id is the underlying canonical model
const ACP_PREFIXES = new Set(['kilo','opencode','qwen-code','codex-cli','copilot-cli','cline','hermes-agent','cursor-acp','codeium-cli','acp-cli']);

function getModelScore(modelId) {
  if (!modelId) return null;
  // Strip ACP daemon prefix so cline/claude-opus-4-1 looks up as claude-opus-4-1
  let id = modelId;
  const slash = id.indexOf('/');
  if (slash > 0 && (ACP_PREFIXES.has(id.slice(0, slash)) || /^extra-\d+$/.test(id.slice(0, slash)))) {
    id = id.slice(slash + 1);
  }
  const normalized = id.toLowerCase()
    .replace(/^(anthropic|google|openai)\//, '')
    .replace(/-/g, '/')
    .replace(/\//g, '/');
  const exact = SWE_BENCH_SCORES[normalized] || SWE_BENCH_SCORES[id] || SWE_BENCH_SCORES[modelId];
  if (exact != null) return exact;
  // Fallback: match by model name component, preferring longest (most specific)
  // match. Minimum 3 chars to avoid false positives (e.g. "5" matching inside
  // "minimax-m2.5-free").
  let best = null;
  let bestLen = 0;
  for (const [key, score] of Object.entries(SWE_BENCH_SCORES)) {
    const modelPart = key.split('/')[1] || '';
    if (modelPart && modelPart.length >= 3 && id.includes(modelPart) && modelPart.length > bestLen) {
      best = score;
      bestLen = modelPart.length;
    }
  }
  return best;
}


module.exports = { SWE_BENCH_SCORES, sortByBenchmark, getModelScore, lastUpdated };
