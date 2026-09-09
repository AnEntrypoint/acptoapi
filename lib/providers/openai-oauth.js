'use strict';
// Thin adapter registering lib/openai-oauth.js's streamChat as a standard
// acptoapi provider generator (see lib/providers/index.js) -- the OAuth
// mechanics and the Responses-API translation live in lib/openai-oauth.js;
// this file only exists so translate.js's generic provider dispatch can
// find it under the 'openai-oauth' provider name, same shape as every
// other lib/providers/*.js module.
function streamOpenAIOAuth(params) {
  return require('../openai-oauth').streamChat(params);
}

module.exports = { streamOpenAIOAuth };
