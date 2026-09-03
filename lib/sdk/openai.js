const { translate } = require('../translate');
const { getFormat } = require('../formats/index');

class OpenAI {
  constructor({ baseURL, apiKey, provider = 'openai-compat', ...config } = {}) {
    this._provider = provider;
    this._apiKey = apiKey;
    this._baseURL = baseURL;
    this._config = config;
    this.chat = {
      completions: {
        create: (params) => this._create(params),
      },
    };
  }

  _opts(params) {
    return {
      from: 'openai',
      provider: this._provider,
      apiKey: this._apiKey,
      url: this._baseURL ? this._baseURL + '/chat/completions' : undefined,
      ...params,
    };
  }

  _stream(params) {
    return translate(this._opts(params));
  }

  async _create(params) {
    if (params.stream) return this._stream(params);
    const fmt = getFormat('openai');
    const events = [];
    for await (const ev of translate(this._opts(params))) events.push(ev);
    return fmt.toResponse(events);
  }
}

module.exports = { OpenAI };
