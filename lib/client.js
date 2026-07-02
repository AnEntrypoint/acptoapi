const { GoogleGenAI } = require('@google/genai');
const keyring = require('./keyring');

let _client = null;

function getClient(apiKey) {
  if (!_client || apiKey) _client = new GoogleGenAI({ apiKey: apiKey || keyring.getKey('GEMINI_API_KEY') });
  return _client;
}

module.exports = { getClient };
