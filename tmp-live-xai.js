'use strict';
const xai = require('./lib/xai-oauth');
const { clampMaxTokensForModel } = require('./lib/model-token-limits');

(async () => {
  if (!xai.hasCredentials()) {
    console.log('NO_CREDS');
    process.exit(2);
  }
  const requested = 256000;
  const clamped = clampMaxTokensForModel('xai-oauth/grok-4.6', requested);
  console.log('clamp=', clamped);
  const t0 = Date.now();
  try {
    const r = await xai.chatCompletion({
      model: 'grok-4.6',
      messages: [{ role: 'user', content: 'Reply with exactly OK and nothing else.' }],
      max_tokens: requested,
      stream: false,
    }, { timeoutMs: 60000, maxRetries: 0 });
    const text = r?.choices?.[0]?.message?.content;
    const usage = r?.usage;
    console.log(JSON.stringify({
      ok: true,
      ms: Date.now() - t0,
      text: typeof text === 'string' ? text.slice(0, 80) : text,
      usage,
      finish: r?.choices?.[0]?.finish_reason,
    }));
  } catch (e) {
    console.log(JSON.stringify({
      ok: false,
      ms: Date.now() - t0,
      status: e.status,
      code: e.code,
      message: String(e.message || e).slice(0, 400),
    }));
    process.exit(1);
  }
})();
