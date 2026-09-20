'use strict';
const m = require('./lib/model-token-limits');
const cases = {
  grokOmit: m.clampMaxTokensForModel('xai-oauth/grok-4.6', 256000),
  xaiOmit: m.clampMaxTokensForModel('xai/grok-4.6', 500000),
  groqClamp: m.clampMaxTokensForModel('groq/qwen/qwen3.8-27b', 256000),
  otherKeep: m.clampMaxTokensForModel('openrouter/foo', 256000),
  omitTrue: m.shouldOmitMaxTokens('xai-oauth/grok-4.6'),
  omitBare: m.shouldOmitMaxTokens('grok-4.6'),
  strip: m.stripMaxTokens({ model: 'grok-4.6', max_tokens: 256000, messages: [{ role: 'user', content: 'hi' }] }),
  err: m.isPromptLengthReservationError("This model's maximum prompt length is 500000 but the request contains 500943 tokens."),
  notErr: m.isPromptLengthReservationError('max_tokens must be less than or equal to 16384'),
  jsonOmit: JSON.stringify({ max_tokens: m.clampMaxTokensForModel('xai-oauth/grok-4.6', 256000), model: 'grok-4.6' }),
};
console.log(JSON.stringify(cases, null, 2));
if (cases.grokOmit !== undefined) throw new Error('grok should omit');
if (cases.xaiOmit !== undefined) throw new Error('xai should omit');
if (cases.groqClamp !== 16384) throw new Error('groq should clamp');
if (cases.otherKeep !== 256000) throw new Error('other should keep');
if (!cases.omitTrue) throw new Error('omitTrue');
if (cases.omitBare) throw new Error('bare model should not omit by prefix');
if (cases.strip.max_tokens !== undefined) throw new Error('strip failed');
if (!cases.err) throw new Error('err detect');
if (cases.notErr) throw new Error('false positive');
if (cases.jsonOmit.includes('max_tokens')) throw new Error('JSON still has max_tokens');
console.log('OK');
