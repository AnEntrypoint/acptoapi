'use strict';

const DEFAULT_ORDER = ['anthropic','openrouter','groq','nvidia','cerebras','sambanova','mistral','codestral','qwen','zai','github-models','cloudflare','gemini','bedrock','opencode-zen','opencode-north','opencode','mimo','ollama','openai-oauth','xai-oauth','gemini-oauth','kilo','qwen-code','codex-cli','copilot-cli','cline','hermes-agent','cursor-acp','codeium-cli','acp-cli','chatjimmy','cohere','aion'];


const DEFAULT_MODELS = {
  anthropic:      'anthropic/claude-haiku-4-5-20251001',
  groq:           'groq/llama-3.3-70b-versatile',
  nvidia:         'nvidia/moonshotai/kimi-k2.6',
  cerebras:       'cerebras/gpt-oss-120b',
  bedrock:        'bedrock/anthropic.claude-3-5-haiku-20241022-v1:0',
  sambanova:      'sambanova/Meta-Llama-3.3-70B-Instruct',
  mistral:        'mistral/mistral-large-latest',
  codestral:      'codestral/codestral-latest',
  qwen:           'qwen/qwen-plus',
  zai:            'zai/glm-4-plus',
  cloudflare:     'cloudflare/@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  openrouter:     'openrouter/auto',
  gemini:         'gemini/gemini-2.0-flash',
  ollama:       'ollama/llama3.2',
  kilo:           'kilo/openrouter/free',
  opencode:       'opencode/minimax-m2.5-free',
  'opencode-north': 'opencode/openai/gpt-4o',
  'opencode-zen':    'opencode-zen/kimi-k3',
  mimo:          'mimo/v2-pro',
  'qwen-code':    'qwen-code/qwen-plus',
  'codex-cli':    'codex-cli/gpt-4-turbo',
  'copilot-cli':  'copilot-cli/gpt-4o',
  cline:          'cline/claude-opus-4-1',
  'hermes-agent': 'hermes-agent/hermes-3-70b',
  'cursor-acp':   'cursor-acp/cursor-pro',
  'codeium-cli':  'codeium-cli/claude-opus-4',
  'acp-cli':      'acp-cli/gpt-4-turbo',
  'xai-oauth':    'xai-oauth/grok-4.7',
  'openai-oauth': process.env.ACPTOAPI_OPENAI_OAUTH_MODEL || 'openai-oauth/gpt-5.6-terra',
  'gemini-oauth': process.env.ACPTOAPI_GEMINI_OAUTH_MODEL || 'gemini-oauth/gemini-2.5-flash',
  chatjimmy:      'chatjimmy/llama3.1-8B',
  cohere:         'cohere/command-r-plus',
  aion:           'aion/aion-2.5',
  'github-models': 'github-models/openai/gpt-4.1',
};


const FALLBACK_REASONS = ['error', 'timeout', 'rate_limit', 'empty', 'content_policy', 'sampler_backoff', 'matrix_block', 'auth', 'fetch_failed', 'credit_dead'];

const FALLBACK_ON = ['error', 'rate_limit', 'timeout', 'empty', 'auth', 'fetch_failed', 'content_policy', 'sampler_backoff', 'matrix_block', 'credit_dead'];

const FALLBACK_ON_NAMED = ['error', 'rate_limit', 'timeout', 'empty', 'credit_dead', 'auth', 'fetch_failed', 'content_policy', 'sampler_backoff', 'matrix_block'];

const FALLBACK_ON_DYNAMIC = ['error', 'rate_limit', 'timeout', 'empty', 'auth', 'fetch_failed', 'content_policy', 'sampler_backoff', 'matrix_block'];

const STATIC_FALLBACK_KEYS = ['anthropic', 'groq', 'nvidia', 'cerebras', 'sambanova', 'mistral', 'codestral', 'qwen', 'zai', 'cloudflare', 'openrouter', 'gemini', 'ollama'];
const STATIC_FALLBACK = Object.fromEntries(STATIC_FALLBACK_KEYS.map((key) => [key, key === 'cerebras' ? 'cerebras/llama-3.3-70b' : DEFAULT_MODELS[key]]));

module.exports = { DEFAULT_ORDER, DEFAULT_MODELS, FALLBACK_REASONS, FALLBACK_ON, FALLBACK_ON_NAMED, FALLBACK_ON_DYNAMIC, STATIC_FALLBACK };
