const { BridgeError } = require('../errors');

const FORMATS = {
  anthropic: require('./anthropic'),
  openai: require('./openai'),
  gemini: require('./gemini'),
  acp: require('./acp'),
  mistral: require('./mistral'),
  ollama: require('./ollama'),
  cohere: require('./cohere'),
  bedrock: require('./bedrock'),
};

function getFormat(name) {
  if (!FORMATS[name]) throw new BridgeError(`Unknown format: ${name}`, { retryable: false });
  return FORMATS[name];
}

module.exports = { getFormat, FORMATS };
