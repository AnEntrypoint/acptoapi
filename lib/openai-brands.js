'use strict';

const BRANDS = {
  groq:           { url: 'https://api.groq.com/openai/v1/chat/completions',                                                         envKey: 'GROQ_API_KEY' },
  openrouter:     { url: 'https://openrouter.ai/api/v1/chat/completions',                                                            envKey: 'OPENROUTER_API_KEY' },
  together:       { url: 'https://api.together.xyz/v1/chat/completions',                                                             envKey: 'TOGETHER_API_KEY' },
  deepseek:       { url: 'https://api.deepseek.com/chat/completions',                                                                envKey: 'DEEPSEEK_API_KEY' },
  xai:            { url: 'https://api.x.ai/v1/chat/completions',                                                                     envKey: 'XAI_API_KEY' },
  cerebras:       { url: 'https://api.cerebras.ai/v1/chat/completions',                                                              envKey: 'CEREBRAS_API_KEY' },
  perplexity:     { url: 'https://api.perplexity.ai/chat/completions',                                                               envKey: 'PERPLEXITY_API_KEY' },
  mistral:        { url: 'https://api.mistral.ai/v1/chat/completions',                                                               envKey: 'MISTRAL_API_KEY' },
  fireworks:      { url: 'https://api.fireworks.ai/inference/v1/chat/completions',                                                   envKey: 'FIREWORKS_API_KEY' },
  openai:         { url: 'https://api.openai.com/v1/chat/completions',                                                               envKey: 'OPENAI_API_KEY' },
  nvidia:         { url: 'https://integrate.api.nvidia.com/v1/chat/completions',                                                     envKey: 'NVIDIA_API_KEY' },
  sambanova:      { url: 'https://api.sambanova.ai/v1/chat/completions',                                                             envKey: 'SAMBANOVA_API_KEY' },
  cloudflare:     { url: () => {
    const acct = process.env.CLOUDFLARE_ACCOUNT_ID;
    if (!acct) throw new Error('cloudflare provider requires CLOUDFLARE_ACCOUNT_ID env (token at ' + (process.env.CLOUDFLARE_API_KEY ? 'CLOUDFLARE_API_KEY set' : 'CLOUDFLARE_API_KEY missing') + '); list accounts: curl -H "Authorization: Bearer $CLOUDFLARE_API_KEY" https://api.cloudflare.com/client/v4/accounts');
    return `https://api.cloudflare.com/client/v4/accounts/${acct}/ai/v1/chat/completions`;
  }, envKey: 'CLOUDFLARE_API_KEY' },
  zai:            { url: 'https://api.z.ai/v1/chat/completions',                                                                     envKey: 'ZAI_API_KEY' },
  qwen:           { url: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions',                                       envKey: 'QWEN_API_KEY' },
  codestral:      { url: 'https://codestral.mistral.ai/v1/chat/completions',                                                         envKey: 'CODESTRAL_API_KEY' },
  'opencode-zen': { url: 'https://api.opencode.ai/v1/chat/completions',                                                              envKey: 'OPENCODE_ZEN_API_KEY' },
};

const EMBEDDING_BRANDS = {
  openai:    { url: 'https://api.openai.com/v1/embeddings',                envKey: 'OPENAI_API_KEY' },
  together:  { url: 'https://api.together.xyz/v1/embeddings',              envKey: 'TOGETHER_API_KEY' },
  mistral:   { url: 'https://api.mistral.ai/v1/embeddings',                envKey: 'MISTRAL_API_KEY' },
  voyage:    { url: 'https://api.voyageai.com/v1/embeddings',              envKey: 'VOYAGE_API_KEY' },
  deepseek:  { url: 'https://api.deepseek.com/embeddings',                 envKey: 'DEEPSEEK_API_KEY' },
};

function isBrand(prefix) { return Object.prototype.hasOwnProperty.call(BRANDS, prefix); }
function getBrand(prefix) {
  const b = BRANDS[prefix];
  if (!b) return undefined;
  if (typeof b.url === 'function') {
    const fn = b.url;
    const out = { ...b };
    Object.defineProperty(out, 'url', { get() { return fn(); }, enumerable: true });
    return out;
  }
  return b;
}
function listBrands() { return Object.keys(BRANDS); }
function getEmbeddingBrand(prefix) { return EMBEDDING_BRANDS[prefix]; }
function listEmbeddingBrands() { return Object.keys(EMBEDDING_BRANDS); }

function azureChatURL({ resource, deployment, apiVersion = '2024-08-01-preview' }) {
  return `https://${resource}.openai.azure.com/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
}

module.exports = { BRANDS, EMBEDDING_BRANDS, isBrand, getBrand, listBrands, getEmbeddingBrand, listEmbeddingBrands, azureChatURL };
