const { GoogleGenAI } = require('@google/genai');

let _client = null;

function getClient(apiKey) {
  if (!_client || apiKey) _client = new GoogleGenAI({ apiKey: apiKey || process.env.GEMINI_API_KEY });
  return _client;
}

module.exports = { getClient };
