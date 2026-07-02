# Changelog

All notable changes are documented here. Entries use `[X.Y.Z] YYYY-MM-DD` headers.
Each line is prefixed `feat:`, `fix:`, `BREAKING:`, or `deprecation:` (with a migration path).
Patch-level CI version bumps (`ci: bump version [skip ci]`) are omitted as separate entries;
their content is folded into the following real entry. Plain ASCII only.

## [1.0.131] - 2026-07-02

- fix: `chain/<name>` now falls back to the `named-chains.js` builtin registry instead of failing when the name isn't in a runtime config.
- fix: quoted hyphenated key in `provider-maps.js`; added missing type declarations and docs.
- fix: hardened security - provider key reads routed through keyring, request body size capped, non-loopback bind hardened, unresolvable model now returns 400 instead of falling through silently.
- fix: `test.js` no longer hangs indefinitely - `activityInterval` unref'd, ACP autolaunch disabled in tests.
- feat: invisible chain fallback verification plus live per-model availability tracking.

## [1.0.130] - 2026-07-01

- fix: `queue/<name>` with an empty name now throws instead of silently falling through.
- fix: bumped node engines floor to `>=20.19.0` (required by a `require(esm)` dependency).
- fix: added attributable cerebras/sambanova SWE-bench scores; documented known scoring gap.
- fix: wired bedrock into `auto-chain`; fixed cerebras model drift.
- fix: nvidia model id normalization; auto-chain default fixes.

## [1.0.124] - 2026-06-28

- fix: actionable hints and sanitized messages on all error responses.

## [1.0.123] - 2026-06-26

- feat: free-tier chain reordered per remoteopenclaw.com best-free-models ranking; new `hermes-free` named chain (free online APIs best-first, then no-key ACP daemons). See `lib/named-chains.js`.
- feat: witnessed Claude Code CLI integration end-to-end against the live bridge.
- fix: ASCII-only sweep across source and docs.

## [1.0.120] - 2026-06-23

- feat: Anthropic <-> OpenAI format translation, dynamic live model probe (`lib/model-probe-live.js`), passthrough emitter, expanded real-backend test suite.
- feat: smart model selection - two-tier chain sort (capability tier, then SWE-bench score) so the strongest available model leads the chain.
- feat: `google/` alias for `gemini/`; unified endpoint routing so OpenAI, Anthropic, and Gemini surfaces share one resolution path.

## [1.0.118] - 2026-06-12

- feat: model tools-capability ranking (`capability-tier`).
- feat: in-process LRU response cache plus idle pretest warmup.
- fix: engineering-DNA hardening - honest errors (no silent catastrophic modes), resilience on every failure path, tighter data model, subtractive cleanup.
- fix: closed silent rejection sinks; two-tier auto-chain with a probe cap; last-resort `unhandledRejection` guard.
- fix: per-link timeout honored; doubled ACP model prefix fixed so `auto` reaches a live model.
- fix: chain always falls back seamlessly - rate-limit is never surfaced to the caller.
- fix: ACP daemons autolaunch by default; model cache refreshed before each chat chain.
- fix: CORS preflight now allows `x-cwd`, `anthropic-version`, and `anthropic-dangerous-direct-browser-access` (needed by freddie `callLLM` and direct browser Anthropic POST).
- fix: auto-chain live-daemon filter, strong-model picker, and corrected kilo spawn command.
- fix: `/v1/models` lists the kilo + opencode catalog, sorted by SWE-bench score.
- fix: `/v1/chat/completions` treats `model` as a queue selector; unknown names fall through to the default queue. Non-streaming requests always run through the xstate fallback chain.
- fix (windows): dropped `DETACHED_PROCESS` from spawn `creationFlags` (source of conhost popups); split `cmd.exe` args so `CREATE_NO_WINDOW` propagates through `.cmd` shims - kills kilo/opencode popup windows.

## [1.0.115] - 2026-05-xx

- feat: `chatjimmy` ultimate-backup provider; hardened ACP `bunx`/`npx` fallback spawn ladder.
- feat: local Ollama embedding fallback.
- BREAKING: removed Claude Code CLI spawning and session-history reading. Consumers needing Claude Code chat or JSONL history must depend on `@anthropic-ai/claude-code` and `ccsniff` directly.
- BREAKING: removed the gemini-cli OAuth path (`lib/cloud-generate.js`, `lib/oauth.js`, the `claude/` and `cloud/` model prefixes) - Google's gemini-cli is being discontinued upstream.
- BREAKING: stripped legacy history endpoints, the gemini-cli daemon, and `claude`/`cloud` aliases. Decoupled from `.thebird` (config now lives under `~/.acptoapi/`).
- fix: ACP backends default to lazy-launch.
- fix: security - addressed audit findings.
- fix: embeddings - inject `defaultModel` for cloud autopick on bare-model requests.
- fix (windows): suppressed conhost/popup flashes via direct `.exe` spawn + `CREATE_NO_WINDOW`; canonical invisible-batch spawn pattern.

## [1.0.57] - 2026-05-13

- feat: unified chain SDK surface - `chat({model: 'a,b,c'})` comma-separated model strings resolve to a priority chain (whitespace tolerated, backward compat preserved for single model id).
- feat: `chat({model: 'queue/<name>'})` named-queue prefix as alias for `chain/<name>`, with externally-configurable sources via `extraQueueSources: [paths]`. Default file `~/.acptoapi/queues.json`; opt `queuesMap` for in-memory injection.
- feat: `lib/queues.js` - `resolveQueue({name, queuesMap?, configPath?, extraQueueSources?})` and `listAllQueues(...)`.
- feat: `lib/matrix.js` - `loadMatrix(path|url|fn)` with 60s cache, `matrixScore(provider, model, matrix)` returning `{ok:bool|null, mode_count:n}`, `clearMatrixCache()`.
- feat: sampler-aware chain - `chain-machine` consults `sampler.isAvailable(prefix)` before each link; if backoff-blocked, emits `FALLBACK` with `reason:'sampler_backoff'` without an attempt.
- feat: matrix-aware chain - pass `opts.matrixSource`; cells with `ok:false` are demoted to the end of the chain (`matrix_block` short-circuit if encountered).
- feat: `chain([...]).peekNext(n)` - returns next-N candidates `[{index, model, prefix, fallbackOn, blocked, reason}]` for dashboard "next-up" UI.
- feat: `sampler.peekStatus(provider, model)` - returns `{available, lastFailedAt, nextRetryAt, failCount}` for diagnostics.
- feat: `listAllModelsAndQueues({matrixSource, queueSources, queuesMap})` - OpenAI-models-shape rows mixing `{id, object:'model'}` and `{id:'queue/<name>', object:'queue', links}`.
- feat: expanded run-history - `getRunHistory()` entries now carry `{ts, requestedModel, resolvedLinks, attempted:[{model,ms,ok,reason}], finalModel}`.
- feat: new HTTP routes on `createServer` - `/v1/queues`, `/v1/sampler/status`, `/v1/runs`. `/v1/models` now appends `queue/<name>` rows.
- feat: `createServer({queuesProvider})` - function returning a `{name: [...links]}` map merged into queue listings.
- fix: `sdk.chat`/`sdk.stream` for `openai-compat` providers - previously `from:'openai'` stripped the `{url,apiKey,body}` carrier before reaching the provider, causing `fetch URL undefined`. Now skipped when provider is openai-compat; single-shot brand-prefix calls (`chat({model:'groq/...'})`) work for the first time.
- fix: `chain-machine` no longer marks the entire provider prefix as failed when the next chain link shares the same prefix - preserves "bad model id, try sibling" semantics without triggering full provider backoff. A bare `error` reason no longer triggers sampler markFailed; only `rate_limit`/`timeout`/`content_policy` do.

## [1.0.30] - 2026-05-01

- feat: `lib/sampler.js` - exponential backoff availability sampler (5-step: 30s -> 60s -> 120s -> 240s -> 480s); exports `createSampler` factory and singleton `isAvailable`/`markFailed`/`markOk`/`getStatus`/`probe`/`startSampler`/`stopSampler`.
- feat: `lib/provider-maps.js` - `PROVIDER_KEYS` (provider -> env var) and `PROVIDER_DEFAULTS` (provider -> default model) covering 17 providers, derived from `BRANDS` + `auto-chain` data.
- feat: `index.js` now exports all sampler functions, `PROVIDER_KEYS`, `PROVIDER_DEFAULTS`, `buildAutoChain`, `createCircuitBreaker`.
- feat: configurable multi-provider fallback chain (`lib/auto-chain.js`).
- feat: 7 new providers - sambanova, cloudflare, zai, qwen, codestral, opencode-zen (plus nvidia fixed).
- feat: `PROVIDER_ORDER` env var for comma-separated provider priority configuration.
- feat: `GET /debug/auto-chain` endpoint - returns resolved chain links and order.
- feat: auto-model routing in `/v1/messages` when model is `auto`.
- feat: Ollama streaming provider (`lib/providers/ollama.js`) with NDJSON, tool-call loop, 404 -> BridgeError.
- feat: `reasoning-delta` SSE handler added to anthropic, openai, gemini, acp format files.
- feat: `/debug/providers`, `/debug/config`, `/debug/translate` endpoints added to server.
- feat: Cohere v2 Chat API format (`lib/formats/cohere.js`) with toParams, toResponse, toSSE.
- feat: `GET /debug/anthropic` - uptime, routing table, env-key presence, and last 20 `/v1/messages` request log.
- fix: `NVIDIA_KEY` renamed to `NVIDIA_API_KEY` throughout.
- fix: brand prefix models (groq/, cerebras/, etc.) now correctly route through brand passthrough from `/v1/messages` endpoint; previously fell through to NVIDIA/Gemini.
- fix: npm publish in CI now uses continue-on-error so OTP-protected legacy tokens don't fail the CI gate; syntax job remains authoritative.
- fix: bare `claude-*` model names (no slash) sent by Claude Code CLI - e.g. `claude-sonnet-4-6` - were not recognised by `inferredProvider()`, which only matched the `claude/` prefix. Fixed in `lib/server.js handleAnthropicMessages`: bare `claude-*` without slash now routes through auto-chain when `ANTHROPIC_API_KEY` is absent, or to `anthropic/<model>` when present. Original model preserved on `body.originalModel` and surfaced in `/debug/anthropic` log.

## [1.0.0] - 2026-04-25

- feat: initial protocol bridge architecture - eight formats (`lib/formats/`: openai, anthropic, gemini, kilo, mistral, cohere, ollama, bedrock) and eight providers (`lib/providers/`: openai, kilo, unknown, anthropic, anthropic-via-openai, ollama, bedrock, gemini) registered in the `translate()` pipeline.
- feat: core `translate({from, to, provider, ...params})` pipeline - any (from, to, provider) triple works.
- feat: SDK drop-in compatibility endpoints - `POST /v1/messages`, `POST /v1beta/models/:model:streamGenerateContent`, `POST /v1beta/models/:model:generateContent`, `GET /v1beta/models`.
- feat: dynamic `GET /v1/models` model enumeration driven by env config (no hardcoded model lists).
- feat: reasoning content passthrough (`reasoning-delta` internal event type) mapped to Anthropic thinking blocks and OpenAI `reasoning_content`.
