'use strict';
function streamOpenAIOAuth(params) {
  return require('../openai-oauth').streamChat(params);
}

module.exports = { streamOpenAIOAuth };
