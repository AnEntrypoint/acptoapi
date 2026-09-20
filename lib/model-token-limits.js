'use strict';

const MODEL_MAX_TOKENS = {
  'groq/qwen/qwen3.8-27b': 16384,
};

const PREFIX_MAX_TOKENS = {
  groq: 16384,
};

function shouldOmitMaxTokens(model) {
  if (!model || typeof model !== 'string') return false;
  const prefix = model.split('/')[0];
  return prefix === 'xai-oauth' || prefix === 'xai';
}

function clampMaxTokensForModel(model, requested) {
  if (requested == null) return requested;
  if (shouldOmitMaxTokens(model)) return undefined;
  const exact = MODEL_MAX_TOKENS[model];
  if (exact != null) return Math.min(requested, exact);
  const prefix = typeof model === 'string' ? model.split('/')[0] : null;
  const prefixCap = prefix ? PREFIX_MAX_TOKENS[prefix] : undefined;
  if (prefixCap != null) return Math.min(requested, prefixCap);
  return requested;
}

function stripMaxTokens(body) {
  if (!body || typeof body !== 'object') return body;
  const { max_tokens, max_completion_tokens, ...rest } = body;
  return rest;
}

function isPromptLengthReservationError(text) {
  return /maximum prompt length/i.test(text || '') && /tokens/i.test(text || '');
}

module.exports = {
  clampMaxTokensForModel,
  shouldOmitMaxTokens,
  stripMaxTokens,
  isPromptLengthReservationError,
  MODEL_MAX_TOKENS,
  PREFIX_MAX_TOKENS,
};
