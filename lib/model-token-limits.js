'use strict';
// Real per-model max_tokens ceilings, live-witnessed via a provider's own 400.
//
// A named chain (e.g. queue/grok-with-fallback) reuses ONE caller-supplied
// max_tokens value across every link, sized for whichever model the caller's
// own config names first (Freddie sends 256000, sized for gemini's
// effectively-unbounded output cap). A later link with a genuinely smaller
// hard ceiling then gets that same oversized value verbatim and the
// provider flatly rejects the request -- witnessed 2026-09-08, Groq on
// qwen/qwen3.8-27b:
//   "max_tokens must be less than or equal to 16384, the maximum value for
//    max_tokens is less than the context_window for this model"
// classifyError has no signal to distinguish this deterministic param
// mismatch from a real outage, so the whole link reads as a generic
// 'error' -- a perfectly healthy model looks dead. Clamping max_tokens to
// the serving model's own real ceiling before the request goes out avoids
// the 400 entirely, on every link, every time.
const MODEL_MAX_TOKENS = {
  'groq/qwen/qwen3.8-27b': 16384,
};

// Conservative fallback per provider prefix when the specific model isn't
// listed above -- most groq-hosted models cap well under a generic
// gemini/xai-oauth-sized max_tokens.
const PREFIX_MAX_TOKENS = {
  groq: 16384,
};

// xAI (api.x.ai, both the OAuth brand and the static-key brand) subtracts a
// requested max_tokens from the remaining prompt budget. Agent runners
// (Freddie default 256000, sized for DeepSeek/Gemini output) send that cap
// on every turn; xAI then reports "This model's maximum prompt length is
// 500000 but the request contains 500943 tokens" and rejects a prompt that
// fits the real window. Live-witnessed 2026-09-10 on xai-oauth/grok-4.6:
// chain exhausted as a generic `error` while the same model accepts the
// prompt when max_tokens is omitted. Return undefined so callers drop the
// field (JSON.stringify omits undefined) and xAI does not reserve output
// against the prompt.
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
