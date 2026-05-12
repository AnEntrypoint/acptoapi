# Changelog

## [1.0.57] - 2026-05-13

### Added — Unified chain SDK surface
- `chat({model: 'a,b,c'})` — comma-separated model strings resolve to a priority chain. Whitespace tolerated. Backward compat preserved (single model id still works).
- `chat({model: 'queue/<name>'})` — named-queue prefix as alias for `chain/<name>`, with externally-configurable sources via `extraQueueSources: [paths]`. Default file `~/.acptoapi/queues.json`; opts `queuesMap` for in-memory injection.
- `lib/queues.js` — `resolveQueue({name, queuesMap?, configPath?, extraQueueSources?})` and `listAllQueues(...)`.
- `lib/matrix.js` — `loadMatrix(path|url|fn)` with 60s cache, `matrixScore(provider, model, matrix)` returning `{ok:bool|null, mode_count:n}`, `clearMatrixCache()`.
- Sampler-aware chain: `chain-machine` consults `sampler.isAvailable(prefix)` before each link; if backoff-blocked, emits `FALLBACK` with `reason:'sampler_backoff'` without an attempt.
- Matrix-aware chain: pass `opts.matrixSource`; cells with `ok:false` are demoted to the end of the chain (`matrix_block` short-circuit if encountered).
- `chain([...]).peekNext(n)` — returns next-N candidates `[{index, model, prefix, fallbackOn, blocked, reason}]` after sampler+matrix filtering. For dashboard "next-up" UI.
- `sampler.peekStatus(provider, model)` — returns `{available, lastFailedAt, nextRetryAt, failCount}` for diagnostics. `lastFailedAt` newly tracked on `markFailed`.
- `listAllModelsAndQueues({matrixSource, queueSources, queuesMap})` — OpenAI-models-shape rows mixing `{id, object:'model'}` and `{id:'queue/<name>', object:'queue', links}`.
- Expanded run-history: `getRunHistory()` entries now carry `{ts, requestedModel, resolvedLinks, attempted:[{model,ms,ok,reason}], finalModel}`.
- New HTTP routes on `createServer`: `/v1/queues`, `/v1/sampler/status`, `/v1/runs`. Route `/v1/models` now appends `queue/<name>` rows.
- `createServer({queuesProvider})` — function returning a `{name: [...links]}` map merged into queue listings.

### Fixed
- `sdk.chat`/`sdk.stream` for `openai-compat` providers: previously `from:'openai'` stripped the `{url,apiKey,body}` carrier before reaching the provider, causing `fetch URL undefined`. Now skipped when provider is openai-compat. Single-shot brand-prefix calls (`chat({model:'groq/...'})`) work via `api.chat` for the first time.
- `chain-machine` no longer marks the entire provider prefix as failed when the next chain link shares the same prefix — preserves "bad model id, try sibling" semantics without triggering full provider backoff. Also: `reason:'error'` (generic non-classified) no longer triggers sampler markFailed; only `rate_limit`/`timeout`/`content_policy`.

### Witnessed
- Real call: `chat({model:'groq/this-model-does-not-exist-xyz,groq/llama-3.3-70b-versatile'})` against live Groq with real `GROQ_API_KEY` — first link 404s, chain descends, second link returns content, `onFallback` fires once, `getRunHistory()` last entry shows `resolvedLinks: ['groq/this-model-does-not-exist-xyz','groq/llama-3.3-70b-versatile']`, `finalModel: 'groq/llama-3.3-70b-versatile'`. See `test.js` "Witnessed real call" block.

## [Unreleased]

### Added
- `lib/sampler.js`: exponential backoff availability sampler (5-step: 30s→60s→120s→240s→480s); exports `createSampler` factory and singleton `isAvailable`/`markFailed`/`markOk`/`getStatus`/`probe`/`startSampler`/`stopSampler`
- `lib/provider-maps.js`: `PROVIDER_KEYS` (provider → env var) and `PROVIDER_DEFAULTS` (provider → default model) covering 17 providers, derived from `BRANDS` + `auto-chain` data
- `index.js` now exports all sampler functions, `PROVIDER_KEYS`, `PROVIDER_DEFAULTS`, `buildAutoChain`, `createCircuitBreaker`
- Configurable multi-provider fallback chain (lib/auto-chain.js)
- 7 new providers: sambanova, cloudflare, zai, qwen, codestral, opencode-zen (plus nvidia fixed)
- PROVIDER_ORDER env var for comma-separated provider priority configuration
- GET /debug/auto-chain endpoint — returns resolved chain links and order
- Auto-model routing in /v1/messages when model is 'auto'
- Ollama streaming provider (lib/providers/ollama.js) with NDJSON, tool-call loop, 404→BridgeError
- reasoning-delta SSE handler to anthropic, openai, gemini, acp format files
- /debug/providers, /debug/config, /debug/translate endpoints to server
- Cohere v2 Chat API format (lib/formats/cohere.js) with toParams, toResponse, toSSE

### Fixed
- NVIDIA_KEY renamed to NVIDIA_API_KEY throughout
- Brand prefix models (groq/, cerebras/, etc.) now correctly route through brand passthrough from /v1/messages endpoint; previously fell through to NVIDIA/Gemini
- npm publish in CI now uses continue-on-error so OTP-protected legacy tokens don't fail the CI gate; syntax job remains authoritative

### Added
- GET /debug/anthropic — uptime, routing table, env-key presence, and last 20 /v1/messages request log

### Claude Code CLI compatibility (witnessed against local server on :4900)

Probe: `claude -p "say hi in 3 words" --output-format stream-json --verbose --include-partial-messages` with `ANTHROPIC_BASE_URL=http://127.0.0.1:4900`, `ANTHROPIC_AUTH_TOKEN=theultimateflex`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`.

What worked:
- Auth: server accepts both `Authorization: Bearer <token>` and `x-api-key: <token>` against `AGENTAPI_API_KEY`. Claude Code sends Bearer; accepted.
- Full streaming turn observed end-to-end: `message_start` → `content_block_start` → `content_block_delta(text_delta)` → `content_block_stop` → `message_delta(stop_reason: end_turn)` → `message_stop` → `result(success)`.
- Real upstream text returned to Claude Code ("Hello there friend.") via auto-chain → openrouter/auto.
- `modelUsage` block in result correctly tagged `claude-sonnet-4-6`.

What broke (now fixed):
- Bare `claude-*` model names (no slash) sent by Claude Code CLI — e.g. `claude-sonnet-4-6` — were not recognised by `inferredProvider()`, which only matched `claude/` prefix. They fell through to the `gemini`/`nvidia` default branch and produced no useful routing. Fixed in `lib/server.js handleAnthropicMessages`: bare `claude-*` without slash now routes through auto-chain when `ANTHROPIC_API_KEY` is absent, or to `anthropic/<model>` when present. Original model preserved on `body.originalModel` and surfaced in `/debug/anthropic` log.
- `/debug/anthropic` log entry's `originalModel` field previously only populated when `x-provider` header was set. Now always populated when the bare-claude rewrite path triggers, so the log clearly shows incoming `claude-sonnet-4-6` → resolved upstream.
