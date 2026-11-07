const { createFormat } = require('./openai-compat');

module.exports = createFormat({ reasoningDelta: true, responseModel: (model) => model });
