'use strict';
const { isBrand, getBrand, BRANDS: BRANDS_RAW } = require('./openai-brands');
const { getDefaultModelSync, refreshAll, getDefaultModel } = require('./model-resolver');

const DEFAULT_ORDER = ['anthropic','openrouter','groq','nvidia','cerebras','sambanova','mistral','codestral','qwen','zai','cloudflare','gemini','opencode-zen','ollama','kilo','opencode','claude'];

const DEFAULT_MODELS = {
  anthropic:      'anthropic/claude-haiku-4-5-20251001',
  groq:           'groq/llama-3.3-70b-versatile',
  nvidia:         'nvidia/deepseek-ai/deepseek-r1',
  cerebras:       'cerebras/llama-3.3-70b',
  sambanova:      'sambanova/Meta-Llama-3.3-70B-Instruct',
  mistral:        'mistral/mistral-large-latest',
  codestral:      'codestral/codestral-latest',
  qwen:           'qwen/qwen-plus',
  zai:            'zai/glm-4-plus',
  cloudflare:     'cloudflare/@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  openrouter:     'openrouter/auto',
  gemini:         'gemini/gemini-2.0-flash',
  ollama:         'ollama/llama3.2',
  kilo:           'kilo/openrouter/free',
  opencode:       'opencode/minimax-m2.5-free',
  claude:         'claude/sonnet',
};

const BUILTIN_KEYS = {
  anthropic: 'ANTHROPIC_API_KEY',
  gemini:    'GEMINI_API_KEY',
  ollama:    null,
  kilo:      null,
  opencode:  null,
  claude:    null,
};

const FALLBACK_ON = ['error', 'rate_limit', 'timeout', 'empty'];

function hasProvider(name) {
  if (name in BUILTIN_KEYS) {
    const key = BUILTIN_KEYS[name];
    if (key) return !!process.env[key];
    if (name === 'ollama') return true;
    if (name === 'kilo' || name === 'opencode' || name === 'claude') return true;
    return false;
  }
  if (isBrand(name)) {
    const b = BRANDS_RAW[name] || null;
    if (!b || !process.env[b.envKey]) return false;
    if (name === 'cloudflare' && !process.env.CLOUDFLARE_ACCOUNT_ID) return false;
    return true;
  }
  return false;
}

function getOrder() {
  const envOrder = process.env.PROVIDER_ORDER;
  if (!envOrder || !envOrder.trim()) return DEFAULT_ORDER;
  return envOrder.split(',').map(s => s.trim()).filter(Boolean);
}

function buildAutoChain(targetModel) {
  const order = getOrder();
  const available = order.filter(hasProvider);
  const links = [];
  const seen = new Set();
  if (targetModel && targetModel !== 'auto') {
    links.push({ model: targetModel, fallbackOn: FALLBACK_ON });
    const prefix = targetModel.split('/')[0];
    seen.add(prefix);
  }
  for (const name of available) {
    if (seen.has(name)) continue;
    const model = getDefaultModelSync(name) || DEFAULT_MODELS[name];
    if (!model) continue;
    links.push({ model, fallbackOn: FALLBACK_ON });
    seen.add(name);
  }
  return links;
}

async function buildAutoChainLive(targetModel) {
  const order = getOrder();
  const available = order.filter(hasProvider);
  await refreshAll(available);
  return buildAutoChain(targetModel);
}

module.exports = { buildAutoChain, buildAutoChainLive, DEFAULT_ORDER, DEFAULT_MODELS, hasProvider, getOrder, getDefaultModel, getDefaultModelSync };
