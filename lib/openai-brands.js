'use strict';

const BRANDS = {
  groq:       { url: 'https://api.groq.com/openai/v1/chat/completions',           envKey: 'GROQ_API_KEY' },
  openrouter: { url: 'https://openrouter.ai/api/v1/chat/completions',             envKey: 'OPENROUTER_API_KEY' },
  together:   { url: 'https://api.together.xyz/v1/chat/completions',              envKey: 'TOGETHER_API_KEY' },
  deepseek:   { url: 'https://api.deepseek.com/chat/completions',                 envKey: 'DEEPSEEK_API_KEY' },
  xai:        { url: 'https://api.x.ai/v1/chat/completions',                      envKey: 'XAI_API_KEY' },
  cerebras:   { url: 'https://api.cerebras.ai/v1/chat/completions',               envKey: 'CEREBRAS_API_KEY' },
  perplexity: { url: 'https://api.perplexity.ai/chat/completions',                envKey: 'PERPLEXITY_API_KEY' },
  mistral:    { url: 'https://api.mistral.ai/v1/chat/completions',                envKey: 'MISTRAL_API_KEY' },
  fireworks:  { url: 'https://api.fireworks.ai/inference/v1/chat/completions',    envKey: 'FIREWORKS_API_KEY' },
  openai:     { url: 'https://api.openai.com/v1/chat/completions',                envKey: 'OPENAI_API_KEY' },
  nvidia:     { url: 'https://integrate.api.nvidia.com/v1/chat/completions',     envKey: 'NVIDIA_KEY' },
};

const EMBEDDING_BRANDS = {
  openai:    { url: 'https://api.openai.com/v1/embeddings',                envKey: 'OPENAI_API_KEY' },
  together:  { url: 'https://api.together.xyz/v1/embeddings',              envKey: 'TOGETHER_API_KEY' },
  mistral:   { url: 'https://api.mistral.ai/v1/embeddings',                envKey: 'MISTRAL_API_KEY' },
  voyage:    { url: 'https://api.voyageai.com/v1/embeddings',              envKey: 'VOYAGE_API_KEY' },
  deepseek:  { url: 'https://api.deepseek.com/embeddings',                 envKey: 'DEEPSEEK_API_KEY' },
};

function isBrand(prefix) { return Object.prototype.hasOwnProperty.call(BRANDS, prefix); }
function getBrand(prefix) { return BRANDS[prefix]; }
function listBrands() { return Object.keys(BRANDS); }
function getEmbeddingBrand(prefix) { return EMBEDDING_BRANDS[prefix]; }
function listEmbeddingBrands() { return Object.keys(EMBEDDING_BRANDS); }

function azureChatURL({ resource, deployment, apiVersion = '2024-08-01-preview' }) {
  return `https://${resource}.openai.azure.com/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;
}

module.exports = { BRANDS, EMBEDDING_BRANDS, isBrand, getBrand, listBrands, getEmbeddingBrand, listEmbeddingBrands, azureChatURL };
