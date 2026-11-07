# AGENTS.md - acptoapi

Non-obvious caveats. Load-bearing facts only.

## Public API - chain SDK

acptoapi owns model resolution, chain fallback, sampler backoff, matrix scoring. Downstream (freddie, thebird) must not reimplement — pass model strings/config only.

`api.chat({model,messages,...})` forms: (1) id `'groq/llama-3.3-70b-versatile'` via `resolveModel`; (2) chain `'groq/x, mistral/y, kilo/z'` → `chain([...])`; (3) `queue/<name>` via `resolveQueue({name,queuesMap?,configPath?,extraQueueSources?})`, sourced `queues.json`→`extraQueueSources`→`config.json` `chains` key→`queuesMap` (last wins); `chain/<name>` = legacy alias for `~/.thebird/config.json`. Server: `createServer({queuesProvider:()=>({...})})` per-request.

Links tried in order; `sampler.isAvailable(prefix)` skips backoff'd links (`sampler_backoff`, no attempt); `opts.matrixSource` demotes `ok:false` cells (`matrix_block`); `onFallback({from,to,reason,error})` fires on failure; `sampler.markFailed(prefix)` skips aggregator prefixes (`isMultiModelPrefix`, or hardcoded `openrouter`, re-exports brands under one prefix — else one bad sub-model backs off the brand) per-model `availability.js` covers them; exhaustion throws `err.chainHistory`/`err.attempted`.

Inspection: `chain([...]).peekNext(n)`, `sampler.peekStatus(provider)`, `getRunHistory()`, `listAllModelsAndQueues(...)`. HTTP: `GET /v1/models`, `/v1/queues`, `/v1/sampler/status`, `/v1/runs`.

**Scope**: no Claude Code CLI spawn, no JSONL history read (removed 2026-05-21; agentgui uses `@anthropic-ai/claude-code`); gemini-cli OAuth removed.

## Protocol Bridge

Any-to-any bridge. 8 formats (`lib/formats/`): openai, anthropic, gemini, kilo, mistral, cohere, ollama, bedrock — all in `translate()`, any in/out. 8 providers (`lib/providers/`): openai, kilo, unknown, anthropic, anthropic-via-openai, ollama, bedrock, gemini. Provider adapters under `lib/providers/*.js` are thin shims (e.g. `providers/openai-oauth.js` re-exports `lib/openai-oauth.js`'s `streamChat`; mechanics outside `providers/`).

`translate({from,to,provider,...params})` — any triple. `makeChunk`/`makeFinal`/`genId`/`openAIMessagesToACP`/`createEventMapper` live in `lib/translate.js` for ESM named imports. Endpoints: `POST /v1/messages`, Gemini `streamGenerateContent`/`generateContent`/`GET /v1beta/models`, `GET /debug/providers|config`, `POST /debug/translate` (8 core providers only — brand prefixes 500, use `/v1/chat/completions`). `GET /v1/models` is dynamic — never hardcode. `reasoning-delta` maps Anthropic thinking blocks ↔ OpenAI `reasoning_content` when both support it.

`lib/capabilities.js`'s `STRIPPED_TOOLS` (`fs_read`,`bash`,`exec_js`,`recall`,`kv_get` — plugkit/rs-exec internals) is always stripped by `stripUnsupported`/`stripInternalTools`. `lib/formats/openai.js`'s `toResponse(events,model='')` echoes the model; `usage` is always `0` (no counts in events).

**openai-compat single-shot fix**: `buildParams` drops `from` only when `provider==='openai-compat'` (else strips the `{url,apiKey,body}` carrier). `"Failed to parse URL from undefined"` = stale acptoapi.

**`lib/providers/openai.js` quirks**: thinking model behind an aggregator (deepseek/kimi/glm ids) 400s forced `tool_choice` — downgrade to `'auto'`. Some aggregator nodes are Anthropic-format Go servers rejecting bare `tool_choice`; retry SAME-REQUEST-ONLY with `{type:'any'}`, never cached per-model (same id hits either shape) — but cached per `(url,model)` process-lifetime (fast-fail+slow-retry can exceed the 10s link timeout). Bare 5xx without JSON body: one retry, never 4xx. `thinking` is Anthropic-only, stripped by `stripAnthropicOnlyKeys`. `tools`: execute-map object = provider runs the loop; bare Array = caller executes — conflating misreports "not found".

## Multi-key per provider (lib/keyring.js -> okeydokey)

okeydokey implements it; `keyring.js` is a ~60-line adapter (`getKey`/`markKeyFailed`/`peekStatus`) — never reimplement ordering/backoff/masking/rotation. Every envKey (`GROQ_API_KEY`) takes N keys: primary, `_1`..`_99`, `ACPTOAPI_KEYS_GROQ_API_KEY=["a","b"]`. `ENV_ALIASES` (`GOOGLE_API_KEY`<->`GEMINI_API_KEY`) resolve at one chokepoint (else alias-only keys invisible).

`getKey`/`listUsable` skip cooldown-blocked keys; `markKeyFailed` backs off `[30s,60s,2m,4m,8m]` (distinct from sampler.js). 401/403→`auth`, 429→`rate_limit`, 5xx→`upstream_5xx` (provider fault, not backoff-worthy). `keyring.rotateKeys(envKey,attempt,{onRotate})` is the shared rotation loop (`handleBrandChat`/`executeBrandModel`/`passthrough.js`): advances on auth/rate_limit, stops else. Log: `key-rotate provider=<name> reason=<r> key-index=<i> next-index=<i+1>`. `reset()` clears the ring. `POST /v1/embeddings` is `410 embeddings_not_here`. Direct `process.env[envKey]` reads are forbidden outside keyring.js. `GET /v1/keyring/status` → per-key `{index,key(masked),ok,failCount,lastFailedAt,lastReason,inBackoff,nextRetryInMs}`.

## ACP Daemons (lib/acp-launcher.js)

10 local daemons (JSON-RPC/stdio, fixed ports), auto-spawn via `ensureRunning()` — **opt-in, default OFF**, gated `ACPTOAPI_ENABLE_ACP=1` (also gates ACP-tier inclusion). Once on, `ACPTOAPI_ENABLE_ACP_AUTOLAUNCH=0` opts out of auto-spawn only.

|Daemon | Port | Default model | Cmd | Key|
|---|---|---|---|---|
|Kilo | 4780 | kilo/openrouter/free | KILO_ACP_CMD | none|
|Opencode | 4790 | opencode/minimax-m2.5-free | OPENCODE_ACP_CMD | none|
|Qwen Code | 4820 | qwen-code/qwen-plus | QWEN_CODE_ACP_CMD | QWEN_API_KEY|
|Codex CLI | 4830 | codex-cli/gpt-4-turbo | CODEX_CLI_ACP_CMD | OPENAI_API_KEY|
|Copilot CLI | 4840 | copilot-cli/gpt-4o | COPILOT_CLI_ACP_CMD | GITHUB_TOKEN|
|Cline | 4850 | cline/claude-opus-4-1 | CLINE_ACP_CMD | ANTHROPIC_API_KEY|
|Hermes Agent | 4860 | hermes-agent/hermes-3-70b | HERMES_ACP_CMD | none|
|Cursor ACP | 4870 | cursor-acp/cursor-pro | CURSOR_ACP_CMD | none|
|Codeium Command | 4880 | codeium-cli/claude-opus-4 | CODEIUM_ACP_CMD | optional|
|ACP CLI Reference | 4890 | acp-cli/gpt-4-turbo | ACP_CLI_CMD | none|

Tries bare binary → subcommand → npx → bunx, 600ms fail-fast/attempt. Windows: stdio to temp files (`os.tmpdir()/.acptoapi-null`) not `'ignore'`, avoiding console windows. Extend: `registerBackend(name,{base,providerID,defaultModel})`+`registerDaemon(name,port,[{command,args}])`. `GET /health` → `{backends:{...}}` up/down per port.

## Auto-Fallback Chain (lib/auto-chain.js)

`buildAutoChain(targetModel?)` detects env-keyed brands, built-ins (`anthropic`/`gemini` via key; `ollama` via 30s-cached live probe against `OLLAMA_URL`, not unconditional), ACP daemons (if enabled). `chatjimmy` is **opt-in** via `ACPTOAPI_ENABLE_CHATJIMMY=1` (else a dead entry wins cold-tiebreak slots).

`DEFAULT_ORDER`: anthropic, openrouter, groq, nvidia, cerebras, sambanova, mistral, codestral, qwen, zai, github-models, cloudflare, gemini, bedrock, opencode-zen, opencode-north, opencode, mimo, ollama, kilo, qwen-code, codex-cli, copilot-cli, cline, hermes-agent, cursor-acp, codeium-cli, acp-cli, chatjimmy, cohere, aion (no `claude` CLI entry). Override `PROVIDER_ORDER=a,b,c`. `GET /debug/auto-chain` → `{links,order,available}`.

Providers (`lib/openai-brands.js`, prefix→env key): groq/openrouter/nvidia/cerebras/sambanova/mistral/codestral/qwen/zai/opencode-zen/together/deepseek/xai/perplexity/fireworks each map to `<PREFIX>_API_KEY`; cloudflare needs CLOUDFLARE_API_KEY+CLOUDFLARE_ACCOUNT_ID; librechat (self-hosted, `localhost:3040/v1` default, override `LIBRECHAT_URL`) key optional. `registerBrand(name,{url,envKey})` extends dynamically.

Per-ACP-daemon allowlist is regex (id contains `"free"`), override `<NAME>_MODEL_FILTER`. `ACPTOAPI_PREFERRED_AUTO_MODEL` unshifts one model. Not-yet-live ACP daemons appear (lazy-spawn); once any live, chain restricts to the live set. `CHAT_COMPLETION_INCAPABLE_RE` excludes audio/FIM/embed/moderation/OCR/TTS ids. NVIDIA NIM is free for any key — 404 is a deployment gap, not billing. `modelFamily()` collapses re-hosted duplicates across brands in round-robin.

## Live brand-catalog (lib/brand-catalog.js)

`refreshAll({force?})` probes each keyed brand's `/v1/models`, bounded concurrency 4 (`ACPTOAPI_BRAND_CATALOG_CONCURRENCY`), persists `~/.acptoapi/brand-catalog-cache.json` (TTL 10min); `buildAutoChain` reads via `getCachedModels(name)` without network. `STALE_CEILING_MS`(6h) ≫ TTL — TTL=re-probe due, ceiling=data unusable; serves stale-under-ceiling data, avoiding static defaults without a refresh timer. `probeBrand` retries once on AbortError.

`modelsUrlFor` reads RAW `BRANDS[name]` in try/catch (never `getBrand`) so an unconfigured brand yields `null`. `MODELS_URL_OVERRIDE`: codestral→`api.mistral.ai/v1/models`, zai→`api.z.ai/api/paas/v4/models`, cohere→`/v1/models`, github-models→`models.github.ai/catalog/models`. **`MODELS_FILTER`** guards over-enumeration (a borrowed-host catalog answers "what exists" not "what this chat URL accepts"): `codestral: id=>/^codestral/i.test(id)&&!/embed/i.test(id)` (60 enumerated, 2 chat-servable); `openrouter: id=>!/:batch$/i.test(id)` (`:batch` ids 404 openrouter's sync chat). Absent = trust every id.

Auth/credit-dead: 401/403 probe records `reason:http_401/403`+`keyring.markKeyFailed`; `buildAutoChain` excludes via `brandCatalog.isAuthDead(name)` (credit-dead comes from `lib/availability.js`). Round-robin: top-N/brand(6) by SWE-bench via `rrOrder` (stripped on return). Disable `ACPTOAPI_DISABLE_BRAND_CATALOG=1`. `GET /v1/brand-catalog` → `{brands:[{brand,count,ts,fresh,reason}]}`.

## Preemptive readiness prober (lib/readiness.js)

Periodic real 1-token requests to top-K auto-chain candidates feed `availability.recordSuccess/recordFailure` — real requests start with an already-verified lead. Distinct from sampler (per-prefix breaker, hollow brand probes) and boot-probe (one-shot). `isFresh(model)` skips a candidate whose last probe or real-traffic result is within `freshMs`; sampler-backoff'd providers skipped; `Promise.race` timeout, never a `signal` opt on `sdk.chat` (brands 400 on it).

Two boot paths, DIFFERENT env var names: standalone daemon (`server.js`) starts `readiness.start()`+warm-up, opt out `ACPTOAPI_DISABLE_READINESS=1`; in-process SDK (`index.js`'s `ensureReadinessStarted`, non-server consumers like freddie) opts out `ACPTOAPI_READINESS_DISABLE=1` — one does not affect the other. `GET /v1/readiness` → `{candidates:[{model,lastProbeTs,ok,latencyMs,rank,fresh,nextProbeInMs}]}`. Env: `ACPTOAPI_READINESS_INTERVAL_MS`(120000), `_FRESH_MS`(90000), `_TOPK`(5), `_MAX_PER_PROVIDER`(2), `_PROBE_TIMEOUT_MS`(8000), `_SPACING_MS`(200).

**xai-oauth carve-out**: `BUILTIN_KEYS` is `null` (OAuth store, not env var) — generic probe resolves `env:null`, sends `Bearer undefined` (structural false-401). `probeOne` special-cases `model.startsWith('xai-oauth/')` → `xaiOauth.chatCompletion(...)` with `{maxRetries:0,quiet:true}`.

## Brand Routing (HTTP Passthrough)

Brand prefixes (groq, openrouter, together, deepseek, xai, cerebras, perplexity, mistral, fireworks, openai) route via HTTP passthrough not `translate()` (brand bodies may not fit `toParams()`'s OpenAI-compat shape). `lib/openai-brands.js` maps prefix→URL+key; `splitBrandModel`/`isBrand`/`normalizeModelId` live once in **`lib/model-id.js`** (`server.js`+`passthrough.js` `require` it). Distinct from `sdk.js`'s `splitPrefix` (own registry, not raw brand ids). `normalizeModelId({normalize:true})` rewrites dashed GLM ids to dotted (`z-ai/glm-5-1`→`z-ai/glm-5.1`).

`handleBrandChat()` fetches+streams unchanged; covers chat + `POST /v1/messages/count_tokens` (length/4). `getBrand(prefix)` resolves function-valued URLs at call time (Cloudflare). **Dead code (filed, unfixed)**: `passthrough.js`'s `/v1/images/generations`/`/v1/audio/speech` entries are unreachable — `server.js` intercepts them via `media-passthrough.js`; only `/v1/moderations`/`/v1/rerank` reach `passthrough.js`.

## xAI Grok OAuth (lib/xai-oauth.js)

Provider `xai-oauth`, RFC 8628 device-code, store `~/.acptoapi/xai-oauth.json`, CLI `node bin/acptoapi.js --xai-oauth-login`. Endpoints/client_id/scope from NousResearch/hermes-agent's `auth.py`, not xAI docs — its discovery doc lacks `device_authorization_endpoint`, so `{issuer}/oauth2/device/code` is hardcoded. Engine is okeydokey's `device-code`. Token store reads/writes `discovery` and `endpoints` keys.

Single-flight refresh: real traffic, the 401 handler, and readiness's probe can all trigger `session.refresh()` at once; a replayed already-rotated refresh_token looks like account compromise, so `singleFlightRefresh()` dedups via one promise. Real-traffic calls had no `timeoutMs` (probes had 8s) and could stall; `ACPTOAPI_XAI_OAUTH_TIMEOUT_MS`(120000ms default) abort-guards every call.

**"Personal team" spending-limit 403** (`personal-team-blocked:spending-limit`) self-heals in ~a day, NOT `credit_dead` — classified `RATE_LIMIT` so the sampler retries, not excluded permanently; no Retry-After from xAI, so `ACPTOAPI_XAI_SPENDING_LIMIT_RETRY_AFTER_SECONDS`(24h default) feeds `availability.js`'s deadline path, clamped by `MAX_RETRY_AFTER_MS`(15min) unless raised.

**max_tokens**: xAI subtracts it from remaining prompt budget — a large cap can reject a fitting prompt. `clampMaxTokensForModel` returns `undefined` for `xai-oauth`/`xai` so callers omit it. General case (`model-token-limits.js`): a named chain reuses one max_tokens across every link; a smaller-ceiling later link 400s (e.g. Groq qwen3.8-27b "<=16384"), reading as generic `error` and backoff for a param mismatch not an outage — clamped per-model/per-prefix before dispatch.

## OpenAI/ChatGPT Codex OAuth (lib/openai-oauth.js)

Provider `openai-oauth`. NOT device-code like xai-oauth — OpenAI's flow polls for an auth code then a PKCE exchange where the SERVER returns `code_verifier`; reuses okeydokey's `createFileTokenStore`/`isJwtExpiring`. Endpoints/client_id/flow from NousResearch/hermes-agent's `auth_codex.py`; same creds openai/codex's CLI writes to `~/.codex/auth.json`.

`readCredential()` prefers the shared Codex CLI/IDE session at `~/.codex/auth.json` (`CODEX_HOME` override) over the legacy store; `ACPTOAPI_OPENAI_OAUTH_PATH` always wins (incl empty-as-opt-out). Writes merge refreshed token fields+timestamp, atomic tmp+rename. Poll 403/404 = "still pending".

**Inference = Responses API, not Chat Completions**: `chatgpt.com/backend-api/codex` speaks `input`/`instructions`/tool items, `response.*` SSE, needs `originator: codex_cli_rs`. `translateToResponses`/`streamChat` convert to/from that shape, yielding `start-step`/`text-delta`/`tool-call`/`finish-step` events. Public `max_output_tokens` is rejected by this endpoint, omitted. `chatgptAccountIdFrom` best-effort-decodes `ChatGPT-Account-Id` from the JWT. This module ≠ `lib/providers/openai-oauth.js` (thin shim). Same `envKey:null` as xai-oauth — `buildParams` builds no openai-compat URL/key pair for either.

## Gemini OAuth (lib/gemini-oauth.js)

Google authorization-code + PKCE (S256), from Gemini-OAuth-Flow-Boilerplate. Provider `gemini-oauth/<model>` (default `gemini-2.5-flash`, `ACPTOAPI_GEMINI_OAUTH_MODEL`); `gemini/` uses `GEMINI_API_KEY`. Wired like xai-oauth: `openai-brands` entry (envKey null), sdk `buildParams`, auto-chain (only when logged in and not refresh-dead), readiness `oauthProbe`, `/v1/models`, `/v1/messages` gate. Requests run through the chain (`handleChat`); `handleGeminiOauthChat` (direct pass-through, streaming) runs only with `ACPTOAPI_DISABLE_CHAIN=1`. CLI `--gemini-oauth-login`/`--gemini-oauth-logout`; store `~/.acptoapi/gemini-oauth.json` (`ACPTOAPI_GEMINI_OAUTH_PATH`) via okeydokey `createFileTokenStore`. Needs `GEMINI_OAUTH_CLIENT_ID` (Desktop app), optional `GEMINI_OAUTH_CLIENT_SECRET`; refresh reuses the stored client id. Browser sign-in: `startCallbackServer` binds `127.0.0.1` on an ephemeral port for login (closed in `finally`); redirect `http://127.0.0.1:<port>/` (loopback ok for Desktop client). `state` is checked on every callback; stray requests 404, ignored. Terminal paste fallback: empty input re-prompts, non-empty bad input fails. `ACPTOAPI_GEMINI_OAUTH_NO_BROWSER=1` prints the link only; `ACPTOAPI_GEMINI_OAUTH_TIMEOUT_MS` (300000 default) bounds the wait.

`access_type=offline&prompt=consent` is required for a refresh token; login fails if Google omits one (boilerplate stored ''). Google access tokens are opaque, not JWTs: expiry `expires_at`, never `isJwtExpiring`. Only `invalid_grant` sets `refresh_dead`, not `invalid_client`. Testing-status refresh tokens can expire after 7 days. Unverified with a real token: the chat endpoint (fake creds reach Google, 401). Known gaps: in-process `sdk.chat` lacks reactive refresh on 401 (same as xai); a no-credentials request records a sampler failure, so the provider is skipped briefly after login.

## sdk.js buildParams caveats

A prior version force-converted bare-string `tool_choice`→`{type:'required'}` for EVERY openai-compat request — broke real backends, reverted; `anthropic_tool_choice_to_openai` converts `{type:'any'}`→bare string. Before `buildParams` special-cased `r.prefix==='xai-oauth'`, in-process `sdk.chat()` sent `apiKey:undefined` regardless of freshness; `xai-oauth.json`'s `base_url` is a bare root, `buildParams` appends `/chat/completions`. `maybeNamedChain` special-cases literal `'auto'` before prefix resolution (else `splitPrefix` falls to `'kilo'`, ECONNREFUSED); a zero-link `buildAutoChain('auto')` throws a real error, not a synthesized one.

## Testing: No Mocks, Only Real Backends

No mocks: no mock providers, no monkey-patched `sdk.stream`/`sdk.chat`, no stub HTTP. Fallback tests pair a real-but-failing first link with a working fallback.

## Chain Fallback Architecture (xstate v5)

`lib/chain-machine.js` drives fallback via an xstate v5 FSM, not a linear loop — states `trying`/`done`/`exhausted`, events `SUCCESS`/`FALLBACK{reason,error}`. `getRunHistory()` is a live stream of FSM transitions (last 50), not a log file. `FALLBACK_REASONS` (full 10-item set): `error, timeout, rate_limit, empty, content_policy, sampler_backoff, matrix_block, auth, fetch_failed, credit_dead` — no explicit `fallbackOn` defaults to this set. **Named chains AND `buildAutoChain` links pin the SAME full 10-item set** (else a pinned OAuth first link's 403→`auth` strands the chain). SDK `chat`/`stream` early-branch on `model:'chain/<name>'` → `lib/chain.js`.

## Model resolution + dynamic defaults

`resolveModel(model)` (`sdk.js:21`) → `{provider,model,env,url}`; `splitPrefix` splits prefix/rest; `resolveQueue`(`queues.js:38`) resolves `queue/<name>`; `splitBrandModel`/`normalizeModelId` in `lib/model-id.js`. `lib/model-resolver.js` is DIFFERENT — probes live models for a strong dynamic default, caches `~/.acptoapi/models-cache.json`; freshness check requires `age>=0` (a future timestamp would read perpetually fresh). `PROVIDER_KEYS`(29)/`PROVIDER_DEFAULTS`(34) export from `lib/provider-maps.js`, re-exported at root — freddie's source of truth.

**kilo protocol**: kilo+opencode share one protocol (SSE `GET /event`+REST session/message). Open SSE BEFORE `POST /session/<id>/message` else events drop; terminate on `session.idle`; only assembled content surfaces.

**Live model probe** (`lib/model-probe-live.js`): static curated `KNOWN` dict (SWE-bench score per entry), not dynamic. `getAvailableModels()` = passive cache read; `getAvailableModelsLive({log,force})` = active 1-token probe. `GET /debug/probe-live[?force=1]` triggers it. Env: `ACPTOAPI_LIVE_PROBE=1`, `ACPTOAPI_PROBE_TTL_MS`(600000), `ACPTOAPI_PROBE_CACHE_PATH`. (`_PROBE_CAP`/`_CONCURRENCY`/`_OLLAMA` do NOT exist.)

**Named chains**: `model:<chain-name>` resolves runtime registry (`chains.json`+`ACPTOAPI_CHAINS`+`POST /v1/chains`) → built-in → auto-chain if unrecognized. `BUILTIN.auto` is a `null` sentinel — `handleAnthropicMessages` special-cases it to the live auto-chain path. Built-ins: `fast`, `cheap`, `smart`, `reasoning`, `free`, `hermes-free`, `local` — re-verified, dead ids swapped.

## Error Classification (lib/chain-machine.js, lib/sampler.js, lib/keyring.js)

`chain-machine.js` alone decides chain-advance-vs-surface. `classifyError(err)`: err.code checks run BEFORE numeric/message checks (else dead code). `AbortError`→`'aborted'` first, excluded from `FALLBACK_REASONS`/`PROVIDER_LEVEL_HEALTH_REASONS`. 402/"no payment method"/"insufficient credits"→`credit_dead` — **`markCreditDead`/`isCreditDead` live in `lib/availability.js`, per model id, NOT `brand-catalog.js`** (brand-wide exclusion drops working models). Rest: 429→`rate_limit`; 401/403→`auth`; ECONNREFUSED/ENOTFOUND/ETIMEDOUT→`fetch_failed`; timeout→`timeout`; content-policy/safety/blocked→`content_policy`; else→`error`.

`sampler_backoff`/`matrix_block` come from `preCheck()` pre-invocation, not `classifyError`. `empty` synthesizes post-call on no text/tool-call. 4th preCheck reason `model_unhealthy`: `failStreak>=5` AND `availability.score<0` — persists via `availability-cache.json` (sampler in-memory-only). **Last-link bypass**: all 3 preCheck gates skip on the LAST link — else a single-provider chain with 5+ failures is blocked permanently with zero live attempts, surviving restarts. `peekNext()` diagnostic does NOT apply this bypass.

**Sampler** (`lib/sampler.js`, per-**prefix** breaker): `[3s,8s,20s,60s,3m,8m]` escalation (distinct from keyring's per-key schedule), only tripped for `error,timeout,rate_limit,auth,fetch_failed,empty` on a non-aggregator prefix. Learned recovery floor: records real recovery time (last 8), backs off `min(fixedStep,min(recentRecoveries))` floored at 500ms — a fast-recovering provider stops waiting the full escalation.

**Same-link retry**: 4x identical reason advances early. Excludes `auth`/`rate_limit`/`content_policy` (no point retrying). Timeout: `link.timeout ?? opts.timeout ?? DEFAULT_LINK_TIMEOUT_MS` (nullish coalescing — `||` wrongly treated explicit `0` as absent). `handleChat` passes `opts.sameLinkRetryBudgetMs` for single-link chains so a healthy 60s+ stream isn't refused mid-stream. Soft-failure tracking feeds `availability.js`'s `softFailStreak` only. Content policy is terminal for built-in named chains, advances for the full-set default.

## HTTP error taxonomy (lib/errors.js)

A DIFFERENT `classifyError` from chain-machine.js's — maps `(status,message,provider)`→`BridgeError` subclass for SDK-caller reporting. First match: 401/403→AuthError, 429→RateLimitError, 408/timeout→TimeoutError, 413/context-length→ContextWindowError, 451/safety→ContentPolicyError, >=500→ProviderError, else→BridgeError. Fields: `message`(redacted), `status`, `code`, `retryable`(false for Auth/ContextWindow/ContentPolicy/BridgeError, true otherwise), `provider`, `headers`, `name`. `GeminiError` is a bare `BridgeError` alias; separate vocabulary despite shared names.

## Chain fluidity: wall-clock budget, streaming

`availability.js`'s `latencyPenalty` caps at `LATENCY_PENALTY_CAP_MS`, matching the success bonus — an extreme-latency outlier fully cancels a maxed success streak. `model_unhealthy` waits bound to `MODEL_UNHEALTHY_WAIT_BUDGET_MS`(10s, shorter than sampler_backoff — no ETA). `inFlightFailures` Map updates on EVERY same-link retry (not just exhaustion) so a concurrent request sees an active storm. `CHAIN_WALL_CLOCK_BUDGET_MS`(90s, or `opts.chainBudgetMs`) bounds the SUM across all links; past deadline throws `CHAIN_BUDGET_EXCEEDED`.

Env-var collision: `ACPTOAPI_CHAIN_LINK_TIMEOUT_MS` applies only without `opts.timeout`, but `handleChat` computes `linkTimeout` from `ACPTOAPI_LINK_TIMEOUT_MS`, overriding it (falls back to `ACPTOAPI_CHAIN_LINK_TIMEOUT_MS` before the 120000 default). Tune `ACPTOAPI_LINK_TIMEOUT_MS` to your slowest reliable free model.

**Real streaming**: `handleChat`'s streaming branch used to run the full non-streamed `runChat` and synthesize one fake SSE chunk (zero real bytes). Runs `runStream` with a `streamFn` wrapping `sdk.stream()`, forwarding real events live; `res.writeHead` defers until the served model is known, so streamed responses carry `X-Acptoapi-Served-Model`/`-Chain-Attempts`/`-Chain-Exhausted`.

## Invisible fallback + availability tracking (lib/availability.js)

Chain fallback leaks no bookkeeping into a successful HTTP body. `runChat`/`runStream` attach `result.__chainAttempted` (SDK-only contract); `handleChat` reads it for logging/headers, `delete`s it before `json(res,...)`. `handleAnthropicMessages` never attaches on success. **Rule**: any handler serializing a chain result to HTTP MUST strip `__chainAttempted` first.

Per-model health updated every attempt; `recordSuccess` EMA-updates latency (decay 0.3). `score(model)`: `0` only if unseen; failure penalty (`min(failStreak,10)*2`) applies at `failStreak>=1` regardless of sample count (one failure demotes below unseen); success bonus (cap 10→30) requires `totalSamples>=2`. `effectiveFailStreak` decays continuously (30-min half-life), not a TTL. `MAX_RETRY_AFTER_MS`(15min) caps a provider Retry-After.

`buildAutoChain` calls `rerank` WITHIN each tier — continuous re-rank, not permanent removal (unlike `matrixSource`'s demote-to-end). Disable `ACPTOAPI_DISABLE_AVAILABILITY_RANK=1`. `GET /v1/availability` → per-model rows sorted by rank. Singleton hydrates `~/.acptoapi/availability-cache.json`, flushes every 10 records. Env: `ACPTOAPI_AVAILABILITY_CACHE_PATH`, `_PERSIST=0`, `_MIN_SAMPLES`, `_LATENCY_DECAY`. `model-resolver.js`'s `refreshAll` runs providers concurrently — cold ttft 53s→12s.

**Response cache** (`lib/response-cache.js`): `set()` gates writes on `isJsonSerializable(value)` instead of letting `clone()` fail lazily on a later hit (a non-serializable value returned the ORIGINAL mutable object on read).

## Configuration - ~/.acptoapi + env vars

|File | Override env | Format|
|---|---|---|
|config.json | ACPTOAPI_CONFIG (then THEBIRD_CONFIG) | `{chains:{name:[...]}}`, `${ENV}` interpolation|
|queues.json | ACPTOAPI_QUEUES | `{queues:{name:[...]}}` or flat|
|chains.json | ACPTOAPI_CHAINS_PATH | `{name:[...]}`, merged over built-ins|
|probe-cache.json | ACPTOAPI_PROBE_CACHE_PATH | `{provider/model:{ok,ts}}`|
|acp-probe-cache.json | ACPTOAPI_ACP_PROBE_CACHE | `{daemon:{ok,ts}}`, 24h TTL|
|availability-cache.json | ACPTOAPI_AVAILABILITY_CACHE_PATH | per-model health|

**Boot stagger** (`server.js` listen, fire-and-forget/unref'd): model-probe-live 5000ms, swe-bench-scores 6000ms, brand-catalog refresh 8000ms, readiness warm-up 11000ms (readiness's own interval starts immediately) — staggered since 3+ on the same ~5000ms timer timed out `refreshAll` under boot contention. `ACPTOAPI_DISABLE_BOOT_PROBE=1`/`_DISABLE_PROBE=1` skip the model-probe pass.

**Env groups**: config paths — `ACPTOAPI_CONFIG`, `THEBIRD_CONFIG`, `ACPTOAPI_QUEUES`, `ACPTOAPI_CHAINS`, `ACPTOAPI_CHAINS_PATH`, `ACPTOAPI_PROBE_CACHE_PATH`, `ACPTOAPI_ACP_PROBE_CACHE`. Routing — `PROVIDER_ORDER`, `ACPTOAPI_DISABLE_AVAILABILITY_RANK=1`, `ACPTOAPI_FREE_TIER_MODE=1` (free-tier to TAIL, never head), `ACPTOAPI_ENABLE_ACP=1` (daemon switch, off), `ACPTOAPI_ENABLE_CHATJIMMY=1` (off), daemon overrides (ACP table), `ACPTOAPI_ENABLE_ACP_AUTOLAUNCH=0`. Keys — Multi-key section. Server — `PORT`(4800), `ACPTOAPI_API_KEY`, `OLLAMA_URL`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, AWS creds, `ACPTOAPI_MAX_BODY_BYTES`(10485760, else `413`), `ACPTOAPI_REQUIRE_AUTH_ON_BIND=1`.

**bin/acptoapi.js**: dotenv loads dev-repo `.env` then `~/.acptoapi/.env`, neither `override:true` — only unset keys are set, so the FIRST-loaded value wins (dev-repo), opposite of load order. First run copies `.env.example`→`~/.acptoapi/.env` if absent. `unhandledRejection`/`uncaughtException` only log, never crash. **index.js**: `extra-providers.js`'s `start()` is fire-and-forget — first call blocks on `ep.loadAndRegisterAsync()`, bounded by `ACPTOAPI_EXTRA_PROVIDERS_BOOT_WAIT_MS`(15000ms), so an early `chat()` can't reference an unregistered `extra-N/*` model.

**Add a queue**: write `~/.acptoapi/queues.json` `{"queues":{"myqueue":[...]}}`, no restart. **Runtime chain**: `POST /v1/chains {"name":"x","links":[...]}`.

## Observability - debug endpoints, CLI

Base `http://127.0.0.1:4800`. `/health`, `/metrics` public; rest needs `ACPTOAPI_API_KEY` (bearer/`x-api-key`).

|Endpoint | Returns|
|---|---|
|GET /health | `{ok,backends:[prefix...]}`|
|GET /debug/providers | `[{name,status,latencyMs}]` — live 2s ACP probe|
|GET /debug/auto-chain | `{links,order,available}`|
|GET /debug/chains | `{defined,recent}`|
|GET /debug/probe-live[?force=1] | `{models,chain,logs}`|
|GET /debug/config | Runtime config, keys redacted|
|POST /debug/translate | Test `{from,to,provider,...}` — 8 core providers only|
|GET /v1/models | Mixed model/queue rows|
|GET /v1/queues, /v1/chains | POST/DELETE on chains|
|GET /v1/sampler/status | `{status:[{provider,ok,failCount,nextCheckIn,neverProbed?}]}` — merges sampler's Map with configured providers; synthesizes `{ok:null,neverProbed:true}` for never-dispatched|
|GET /v1/availability, /v1/runs, /v1/keyring/status | Above|
|GET /v1/cache/stats, POST /v1/cache/clear | Response-cache|
|GET /v1/pretest/stats, POST /v1/pretest/run | Pretest|
|GET /debug/why?model=<id> | `{model,prefix,wouldBeSelectable,blockers:[{layer,detail}],score,availability}` — unifies sampler+keyring gating|

`nextCheckIn>0`→backoff'd until elapsed. `ok:null`+`neverProbed:true`→configured, never dispatched. `/v1/keyring/status` `nextRetryInMs>0`→key cooling. `/v1/runs` `history[]`=`{model,reason,error}`, `attempted[]`=`{model,ms,ok,reason}`. `/debug/providers` `status:'unreachable'`→ACP daemon silent past 2s.

**CLI**: `acptoapi` (start, `--port N`), `--probe` (key presence), `--missing-free` (free-tier providers lacking a key + signup URL), `--list-brands`, `--list-chains`, `--list-models [--port N]` (availability-ranked), `--xai-oauth-login`, `--gemini-oauth-login`, `--gemini-oauth-logout`, `--update`. No TUI.

## gm state

`.gm/prd.yml`, `.gm/mutables.yml`, `.gm/memories/`, `.gm/disciplines/`, `.gm/next-step.md` and committed dream-rsi/memory rows are cross-session state. Runtime spools, browser profiles, caches, sqlite DBs, per-turn counters, dream-rsi scratch, `.playwriter/`, `runs/`, `.agentplug-kv/` are machine-local, ignored. Crash dumps (`*.stackdump`) and gateway stdout/stderr captures (`*.out.log`, `*.err.log`) are untracked. `.env` and `.env.local` are untracked.
