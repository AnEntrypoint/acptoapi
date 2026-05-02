const { translate } = require('../translate');
const { getFormat } = require('../formats/index');

class Anthropic {
  constructor({ provider = 'gemini', apiKey, baseURL, defaultHeaders = {}, ...config } = {}) {
    this._provider = defaultHeaders['x-provider'] || provider;
    this._apiKey = apiKey;
    this._config = config;
    this.messages = {
      create: (params) => this._create(params),
      stream: (params) => this._stream(params),
    };
  }

  _opts(params) {
    return { from: 'anthropic', provider: this._provider, apiKey: this._apiKey, ...params };
  }

  _stream(params) {
    return { fullStream: translate(this._opts(params)), warnings: Promise.resolve([]) };
  }

  async _create(params) {
    if (params.stream) return this._stream(params);
    const fmt = getFormat('anthropic');
    const events = [];
    for await (const ev of translate(this._opts(params))) events.push(ev);
    return fmt.toResponse(events);
  }
}

module.exports = { Anthropic };
