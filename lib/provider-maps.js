'use strict';
const { BRANDS } = require('./openai-brands');
const { DEFAULT_MODELS } = require('./auto-chain');

const EXTRA_KEYS = {
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
  google: 'GOOGLE_API_KEY',
  ollama: null,
  bedrock: 'AWS_ACCESS_KEY_ID',
  opencode: 'OPENCODE_ZEN_API_KEY',
};

const EXTRA_DEFAULTS = {
  anthropic: 'claude-3-5-haiku-20241022',
  google: 'gemini-1.5-flash',
  gemini: 'gemini-2.0-flash',
  ollama: 'llama3.2',
  bedrock: 'anthropic.claude-instant-v1',
  opencode: 'opencode-o3',
};

const PROVIDER_KEYS = {};
const PROVIDER_DEFAULTS = {};

for (const [name, brand] of Object.entries(BRANDS)) {
  if (brand && brand.envKey) PROVIDER_KEYS[name] = brand.envKey;
}

for (const [name, val] of Object.entries(EXTRA_KEYS)) {
  if (val) PROVIDER_KEYS[name] = val;
}

for (const [name, model] of Object.entries(DEFAULT_MODELS)) {
  const bare = model.replace(/^[^/]+\//, '');
  PROVIDER_DEFAULTS[name] = bare;
}

for (const [name, model] of Object.entries(EXTRA_DEFAULTS)) {
  PROVIDER_DEFAULTS[name] = model;
}

module.exports = { PROVIDER_KEYS, PROVIDER_DEFAULTS };
