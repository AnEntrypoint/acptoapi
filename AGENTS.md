# AGENTS.md - acptoapi

Non-obvious caveats for this repo. Compacted 2026-09-21 (was 95KB). Load-bearing facts only.

## Public API - chain SDK

acptoapi owns model resolution, chain fallback, sampler backoff, matrix scoring. Downstream (freddie, thebird) must not reimplement — pass model strings/config only.

`api.chat({model,messages,...})` model forms: (1) single id `'groq/llama-3.3-70b-versatile'` via `resolveModel`; (2) comma chain `'groq/x, mistral/y, kilo/z'` → `chain([...])`; (3) `queue/<name>` via `resolveQueue({name,queuesMap?,configPath?,extraQueueSources?})`, sourced `queues.json`→`extraQueueSources`→`config.json` `chains` key→in-memory `queuesMap` (last wins); `chain/<name>` = legacy alias reading `~/.thebird/config.json`. Server injection: `createServer({queuesProvider:()=>({...})})` per-request.

Chain semantics: links tried in order; `sampler.isAvailable(prefix)` precheck skips a backoff'd link (`sampler_backoff`, no attempt); `opts.matrixSource` demotes `ok:false` cells to the end (`matrix_block`); `onFallback({from,to,reason,error})` fires per failure; `sampler.markFailed(prefix)` skips aggregator prefixes (`isMultiModelPrefix`, or hardcoded `openrouter`, which re-exports many brands under one prefix — else one bad sub-model backs off the whole brand) since per-model `availability.js` covers them; exhaustion throws `err.chainHistory`/`err.attempted`.

Inspection: `chain([...]).peekNext(n)`, `sampler.peekStatus(provider)`, `getRunHistory()`, `listAllModelsAndQueues(...)`. HTTP: `GET /v1/models`, `/v1/queues`, `/v1/sampler/status`, `/v1/runs`.

**Scope**: no Claude Code CLI spawn, no JSONL history read (removed 2026-05-21; agentgui uses `@anthropic-ai/claude-code`/`ccsniff` directly); gemini-cli OAuth path removed same change.

## Protocol Bridge

Any-to-any bridge. 8 formats (`lib/formats/`): openai, anthropic, gemini, kilo, mistral, cohere, ollama, bedrock — all in `translate()`, any in/out. 8 providers (`lib/providers/`): openai, kilo, unknown, anthropic, anthropic-via-openai, ollama, bedrock, gemini. Provider-adapter modules under `lib/providers/*.js` are thin shims (e.g. `providers/openai-oauth.js` re-exports `lib/openai-oauth.js`'s `streamChat`; real mechanics live outside `providers/`).

`translate({from,to,provider,...params})` — any triple works. `makeChunk`/`makeFinal`/`genId`/`openAIMessagesToACP`/`createEventMapper` live in `lib/translate.js` for ESM named-import reasons only. New endpoints: `POST /v1/messages`, Gemini `streamGenerateContent`/`generateContent`/`GET /v1beta/models`, `GET /debug/providers|config`, `POST /debug/translate` (8 core providers only — brand prefixes 500, use `/v1/chat/completions`). `GET /v1/models` is dynamic — never hardcode. `reasoning-delta` event maps Anthropic thinking blocks ↔ OpenAI `reasoning_content` when both ends support it.

`lib/capabilities.js`'s `STRIPPED_TOOLS` (`fs_read`,`bash`,`exec_js`,`recall`,`kv_get` — plugkit/rs-exec internals) is unconditionally stripped by `stripUnsupported`/`stripInternalTools`. `lib/formats/openai.js`'s `toResponse(events,model='')` echoes the caller's model; `usage` is always `0` (no real counts in the event stream — honest "not measured").

**openai-compat single-shot fix**: `buildParams` drops `from` only when `provider==='openai-compat'` (else the `{url,apiKey,body}` carrier was stripped). `"Failed to parse URL from undefined"` = stale acptoapi.

**`lib/providers/openai.js` quirks**: a thinking model behind an aggregator (deepseek/kimi/glm ids) 400s a forced `tool_choice` — downgrade to `'auto'`. Some aggregator nodes are Anthropic-format Go servers rejecting bare-string `tool_choice`; retry SAME-REQUEST-ONLY with `{type:'any'}`, never cached per-model (same id hits either node shape consecutively) — but cached per `(url,model)` process-lifetime too (fast-fail+slow-retry can exceed the 10s link timeout). A bare 5xx with no JSON body gets one retry, never 4xx. `thinking` is Anthropic-only, stripped via `stripAnthropicOnlyKeys`. `tools`: execute-map object = provider runs the loop; bare Array = caller owns execution — conflating misreports tools as "not found".

## Multi-key per provider (lib/keyring.js -> okeydokey)

Implementation is okeydokey's; `keyring.js` is a ~60-line adapter (`getKey`/`markKeyFailed`/`peekStatus`) — never reimplement ordering/backoff/masking/rotation elsewhere. Every envKey (`GROQ_API_KEY`) takes N keys: primary, `_1`..`_99`, `ACPTOAPI_KEYS_GROQ_API_KEY=["a","b"]` JSON hatch. `ENV_ALIASES` (`GOOGLE_API_KEY`<->`GEMINI_API_KEY`) resolve at this one chokepoint (previously 5 hardcoded reads made an alias-only key invisible everywhere).

`getKey`/`listUsable` skip cooldown-blocked keys; `markKeyFailed` backs off `[30s,60s,2m,4m,8m]` (distinct from sampler.js). 401/403→`auth`, 429→`rate_limit`, 5xx→`upstream_5xx` (provider fault, not backoff-worthy). `keyring.rotateKeys(envKey,attempt,{onRotate})` is the one shared rotation loop (`handleBrandChat`/`executeBrandModel`/`passthrough.js`): advances on auth/rate_limit, stops else. Log: `key-rotate provider=<name> reason=<r> key-index=<i> next-index=<i+1>`. `reset()` no-arg clears the ring. `POST /v1/embeddings` is `410 embeddings_not_here`. Direct `process.env[envKey]` reads for provider keys are forbidden outside keyring.js. `GET /v1/keyring/status` → per-key `{index,key(masked),ok,failCount,lastFailedAt,lastReason,inBackoff,nextRetryInMs}`.

## ACP Daemons (lib/acp-launcher.js)

10 local agent daemons (JSON-RPC/stdio, fixed ports), auto-spawn via `ensureRunning()` — **opt-in, default OFF**, gated `ACPTOAPI_ENABLE_ACP=1` (also gates ACP-tier chain inclusion). Once on, `ACPTOAPI_ENABLE_ACP_AUTOLAUNCH=0` is a secondary opt-out of auto-spawn only.

| Daemon | Port | Default model | Cmd override | Key |
|---|---|---|---|---|
| Kilo | 4780 | kilo/openrouter/free | KILO_ACP_CMD | none |
| Opencode | 4790 | opencode/minimax-m2.5-free | OPENCODE_ACP_CMD | none |
| Qwen Code | 4820 | qwen-code/qwen-plus | QWEN_CODE_ACP_CMD | QWEN_API_KEY |
| Codex CLI | 4830 | codex-cli/gpt-4-turbo | CODEX_CLI_ACP_CMD | OPENAI_API_KEY |
| Copilot CLI | 4840 | copilot-cli/gpt-4o | COPILOT_CLI_ACP_CMD | GITHUB_TOKEN |
| Cline | 4850 | cline/claude-opus-4-1 | CLINE_ACP_CMD | ANTHROPIC_API_KEY |
| Hermes Agent | 4860 | hermes-agent/hermes-3-70b | HERMES_ACP_CMD | none |
| Cursor ACP | 4870 | cursor-acp/cursor-pro | CURSOR_ACP_CMD | none |
| Codeium Command | 4880 | codeium-cli/claude-opus-4 | CODEIUM_ACP_CMD | optional |
| ACP CLI Reference | 4890 | acp-cli/gpt-4-turbo | ACP_CLI_CMD | none |

Tries bare binary → subcommand → npx → bunx, 600ms fail-fast/attempt. Windows: stdio to temp files (`os.tmpdir()/.acptoapi-null`) not `'ignore'`, avoiding console windows while detaching. Extend: `registerBackend(name,{base,providerID,defaultModel})`+`registerDaemon(name,port,[{command,args}])`. `GET /health` → `{backends:{...}}` up/down per port.

## Auto-Fallback Chain (lib/auto-chain.js)

`buildAutoChain(targetModel?)` auto-detects env-keyed brands, built-ins (`anthropic`/`gemini` via key; `ollama` via 30s-cached live probe against `OLLAMA_URL`, not unconditional), ACP daemons (if enabled). `chatjimmy` is **opt-in** via `ACPTOAPI_ENABLE_CHATJIMMY=1` (was wrongly always-on, a dead entry won cold-tiebreak slots while never succeeding).

`DEFAULT_ORDER`: anthropic, openrouter, groq, nvidia, cerebras, sambanova, mistral, codestral, qwen, zai, github-models, cloudflare, gemini, bedrock, opencode-zen, opencode-north, opencode, mimo, ollama, kilo, qwen-code, codex-cli, copilot-cli, cline, hermes-agent, cursor-acp, codeium-cli, acp-cli, chatjimmy, cohere, aion (no `claude` CLI entry). Override `PROVIDER_ORDER=a,b,c`. `GET /debug/auto-chain` → `{links,order,available}`.

Providers (`lib/openai-brands.js`, prefix→env key): groq/openrouter/nvidia/cerebras/sambanova/mistral/codestral/qwen/zai/opencode-zen/together/deepseek/xai/perplexity/fireworks each map to `<PREFIX>_API_KEY`; cloudflare needs CLOUDFLARE_API_KEY+CLOUDFLARE_ACCOUNT_ID; librechat (self-hosted, defaults `localhost:3040/v1`, override `LIBRECHAT_URL`) key is optional. `registerBrand(name,{url,envKey})` extends dynamically.

Findings: per-ACP-daemon model allowlist is regex (id contains `"free"`), override `<NAME>_MODEL_FILTER`. `ACPTOAPI_PREFERRED_AUTO_MODEL` unshifts one model to front. Not-yet-live ACP daemons still appear (lazy-spawn); once any live, chain restricts to the live set. `CHAT_COMPLETION_INCAPABLE_RE` excludes audio/FIM/embed/moderation/OCR/TTS ids. NVIDIA NIM is free for any key — a 404 is a deployment gap not billing. `modelFamily()` collapses re-hosted duplicate models across brands in round-robin.

## Live brand-catalog (lib/brand-catalog.js)

`refreshAll({force?})` probes each keyed brand's `/v1/models` live, bounded concurrency 4 (`ACPTOAPI_BRAND_CATALOG_CONCURRENCY`), persists `~/.acptoapi/brand-catalog-cache.json` (TTL 10min); `buildAutoChain` reads via `getCachedModels(name)`, no network on hot path. `STALE_CEILING_MS`(6h) ≫ TTL — TTL=re-probe due, ceiling=data unusable; serves stale-under-ceiling data so a consumer with no refresh timer doesn't fall to static defaults instantly. `probeBrand` retries once on AbortError.

`modelsUrlFor` reads RAW `BRANDS[name]` in try/catch (never `getBrand`) so an unconfigured brand yields `null` not a throw. `MODELS_URL_OVERRIDE`: codestral→`api.mistral.ai/v1/models`, zai→`api.z.ai/api/paas/v4/models`, cohere→`/v1/models`, github-models→`models.github.ai/catalog/models`. **`MODELS_FILTER`** guards over-enumeration (a borrowed-host catalog answers "what exists on this key" not "what this chat URL accepts"): `codestral: id=>/^codestral/i.test(id)&&!/embed/i.test(id)` (60 enumerated, 2 chat-servable); `openrouter: id=>!/:batch$/i.test(id)` (`:batch` ids 404 openrouter's sync chat unconditionally). Absent = trust every id.

Auth/credit-dead: a 401/403 probe records `reason:http_401/403`+`keyring.markKeyFailed`; `buildAutoChain` excludes via `brandCatalog.isDead(name)` entirely (credit-dead is written from `lib/availability.js`, see Error Classification). Round-robin: top-N/brand(6) by SWE-bench, interleaved via `rrOrder` (stripped on return). Disable `ACPTOAPI_DISABLE_BRAND_CATALOG=1`. `GET /v1/brand-catalog` → `{brands:[{brand,count,ts,fresh,reason}]}`.

## Preemptive readiness prober (lib/readiness.js)

Sends periodic real 1-token requests to top-K auto-chain candidates, feeding `availability.recordSuccess/recordFailure` — real requests start with an already-verified lead. Distinct from sampler (per-prefix breaker, hollow brand probes) and boot-probe (one-shot). `isFresh(model)` skips a candidate whose last probe OR last real-traffic result landed within `freshMs`; sampler-backoff'd providers skipped; `Promise.race` timeout, never a `signal` opt on `sdk.chat` (most brands 400 on it).

Two boot paths, DIFFERENT env var names: standalone daemon (`server.js`) starts `readiness.start()`+warm-up, opt out `ACPTOAPI_DISABLE_READINESS=1`; in-process SDK (`index.js`'s `ensureReadinessStarted`, the path non-server consumers like freddie reach) opts out `ACPTOAPI_READINESS_DISABLE=1` — setting one has zero effect on the other. `GET /v1/readiness` → `{candidates:[{model,lastProbeTs,ok,latencyMs,rank,fresh,nextProbeInMs}]}`. Env: `ACPTOAPI_READINESS_INTERVAL_MS`(120000), `_FRESH_MS`(90000), `_TOPK`(5), `_MAX_PER_PROVIDER`(2), `_PROBE_TIMEOUT_MS`(8000), `_SPACING_MS`(200).

**xai-oauth carve-out**: its `BUILTIN_KEYS` entry is `null` (OAuth store, not env var) — the generic probe path resolves `env:null`, sends `Bearer undefined` (structural false-401). `probeOne` special-cases `model.startsWith('xai-oauth/')` → calls `xaiOauth.chatCompletion(...)` with `{maxRetries:0,quiet:true}`.

## Brand Routing (HTTP Passthrough)

Brand prefixes (groq, openrouter, together, deepseek, xai, cerebras, perplexity, mistral, fireworks, openai) route via HTTP passthrough not `translate()` (brand bodies may not fit `toParams()`'s OpenAI-compat assumption). `lib/openai-brands.js` maps prefix→URL+key; `splitBrandModel`/`isBrand`/`normalizeModelId` now live once in **`lib/model-id.js`** (`server.js`+`passthrough.js` both `require` it, no longer duplicated). Distinct from `sdk.js`'s `splitPrefix` (acptoapi's own registry, not raw brand ids). `normalizeModelId({normalize:true})` rewrites dashed GLM ids to dotted (`z-ai/glm-5-1`→`z-ai/glm-5.1`).

`handleBrandChat()` fetches+streams unchanged; covers chat + `POST /v1/messages/count_tokens` (length/4 heuristic). `getBrand(prefix)` resolves function-valued URLs at call time (Cloudflare's dynamic URL). **Dead code (filed, unfixed)**: `passthrough.js`'s `/v1/images/generations`/`/v1/audio/speech` route entries are unreachable — `server.js` always intercepts those via `media-passthrough.js` first; only `/v1/moderations`/`/v1/rerank` reach `passthrough.js`.

## xAI Grok OAuth (lib/xai-oauth.js)

Provider `xai-oauth`, RFC 8628 device-code, store `~/.acptoapi/xai-oauth.json`, CLI `node bin/acptoapi.js --xai-oauth-login`. Endpoints/client_id/scope live-witnessed from NousResearch/hermes-agent's `auth.py`, not xAI docs — xAI's discovery doc lacks `device_authorization_endpoint`, so `{issuer}/oauth2/device/code` is hardcoded. Engine is okeydokey's `device-code`; `xai-oauth.js` is ~280 lines of xAI config over it. Token store reads/writes both the old `discovery` key and new `endpoints` key.

Single-flight refresh: real traffic, the 401 handler, and readiness's probe can all trigger `session.refresh()` near-simultaneously; a replayed already-rotated refresh_token can look like account compromise, so `singleFlightRefresh()` dedups through one shared promise. Real-traffic calls previously had no `timeoutMs` (probes had 8s) and could stall indefinitely; `ACPTOAPI_XAI_OAUTH_TIMEOUT_MS`(120000ms default) now abort-guards every call.

**"Personal team" spending-limit 403** (`personal-team-blocked:spending-limit`) self-heals in ~a day, NOT `credit_dead` — classified `RATE_LIMIT` so the sampler retries instead of excluding permanently; no Retry-After from xAI, so `ACPTOAPI_XAI_SPENDING_LIMIT_RETRY_AFTER_SECONDS`(24h default) feeds `availability.js`'s deadline path, clamped by `MAX_RETRY_AFTER_MS`(15min) unless raised.

**max_tokens**: xAI subtracts it from remaining prompt budget — a large cap can reject a still-fitting prompt. `clampMaxTokensForModel` returns `undefined` for `xai-oauth`/`xai` so callers omit it. General case (`model-token-limits.js`): a named chain reuses one caller max_tokens across every link; a smaller-ceiling later link 400s (e.g. Groq qwen3.8-27b "<=16384"), reading as generic `error` and sampler-backing-off for a param mismatch not an outage — clamped per-model/per-prefix before dispatch.

## OpenAI/ChatGPT Codex OAuth (lib/openai-oauth.js)

Provider `openai-oauth`. NOT device-code like xai-oauth — OpenAI's flow polls for an auth code then a PKCE exchange where the SERVER returns `code_verifier`; reuses only okeydokey's `createFileTokenStore`/`isJwtExpiring`. Endpoints/client_id/flow live-witnessed from NousResearch/hermes-agent's `auth_codex.py`, importing the same creds openai/codex's real CLI writes to `~/.codex/auth.json`.

`readCredential()` prefers the shared Codex CLI/IDE session at `~/.codex/auth.json` (`CODEX_HOME` override) over this package's legacy store; `ACPTOAPI_OPENAI_OAUTH_PATH` always wins (incl empty-as-opt-out). Writes only merge refreshed token fields+timestamp, atomic tmp+rename. Poll 403/404 = "still pending".

**Inference = Responses API, not Chat Completions**: `chatgpt.com/backend-api/codex` speaks `input`/`instructions`/tool items, `response.*` SSE, requires `originator: codex_cli_rs` header. `translateToResponses`/`streamChat` convert to/from that shape, yielding the standard `start-step`/`text-delta`/`tool-call`/`finish-step` events. Public `max_output_tokens` is rejected by this endpoint, omitted entirely. `chatgptAccountIdFrom` best-effort-decodes `ChatGPT-Account-Id` from the JWT. This module ≠ `lib/providers/openai-oauth.js` (thin shim). Same `envKey:null` shape as xai-oauth — `buildParams` builds no openai-compat URL/key pair for either.

## sdk.js buildParams caveats

A prior version force-converted bare-string `tool_choice`→`{type:'required'}` for EVERY openai-compat request (broader mistake than the per-backend fix above) — broke real backends, reverted; `anthropic_tool_choice_to_openai` already correctly converts `{type:'any'}`→bare string. Before `buildParams` special-cased `r.prefix==='xai-oauth'`, a direct in-process `sdk.chat()` call sent `apiKey:undefined` regardless of freshness; `xai-oauth.json`'s `base_url` is a bare root, `buildParams` appends `/chat/completions`. `maybeNamedChain` special-cases literal `'auto'` before prefix resolution (else falls to `splitPrefix`'s fallback `'kilo'`, ECONNREFUSED); a zero-link `buildAutoChain('auto')` falls through to a real error instead of synthesizing one.

## Testing: No Mocks, Only Real Backends

No mocks anywhere — no mock providers, no monkey-patched `sdk.stream`/`sdk.chat`, no stub HTTP. Fallback tests pair a real-but-failing first link with a real working fallback. `examples/*.js` call `generateGemini`/`streamGemini` directly (bypass translate/chain/keyring) — `GEMINI_API_KEY=... node examples/<file>.js`.

**CSS**: `.app-main a` outweighs `.btn-*` in app-shell.css — buttons need `:not()` on the anchor rule or render invisible

## Chain Fallback Architecture (xstate v5)

`lib/chain-machine.js` drives fallback via an xstate v5 FSM, not a linear retry loop — states `trying`/`done`/`exhausted`, events `SUCCESS`/`FALLBACK{reason,error}`. `getRunHistory()` is a live stream of FSM transitions (last 50), not a log file. `FALLBACK_REASONS` (full 10-item set): `error, timeout, rate_limit, empty, content_policy, sampler_backoff, matrix_block, auth, fetch_failed, credit_dead` — a link with no explicit `fallbackOn` defaults to this full set. **Named chains AND `buildAutoChain` links pin the SAME full 10-item set** (not a narrower 4/5 — a narrow list previously stranded a chain on the exact failure an OAuth-gated first link hits: xai-oauth's 403→`auth` was omitted, so pinning it first never fell back). SDK `chat`/`stream` early-branch on `model:'chain/<name>'` → `lib/chain.js`. xstate chosen over `floosie` (pure ESM, heavy deps).

## Model resolution + dynamic defaults

`resolveModel(model)` (`sdk.js:21`) → `{provider,model,env,url}`; `splitPrefix` splits prefix/rest; `resolveQueue`(`queues.js:38`) resolves `queue/<name>`; `splitBrandModel`/`normalizeModelId` consolidated in `lib/model-id.js`. `lib/model-resolver.js` is a DIFFERENT module — probes live models for a strong dynamic default, caches `~/.acptoapi/models-cache.json`; freshness check requires `age>=0` (a corrupted/future timestamp otherwise reads perpetually fresh). `PROVIDER_KEYS`(29)/`PROVIDER_DEFAULTS`(34) export from `lib/provider-maps.js`, re-exported at root — freddie's source of truth.

**kilo protocol**: kilo+opencode share one protocol (SSE `GET /event`+REST session/message). Open SSE BEFORE `POST /session/<id>/message` or events drop; terminate on `session.idle`; only assembled content surfaces.

**Live model probe** (`lib/model-probe-live.js`): static curated `KNOWN` dict (SWE-bench score per entry), not a dynamic fetch. `getAvailableModels()` = passive cache read; `getAvailableModelsLive({log,force})` = active 1-token probe. `GET /debug/probe-live[?force=1]` triggers active. Env: `ACPTOAPI_LIVE_PROBE=1`, `ACPTOAPI_PROBE_TTL_MS`(600000), `ACPTOAPI_PROBE_CACHE_PATH`. (`_PROBE_CAP`/`_CONCURRENCY`/`_OLLAMA` do NOT exist.)

**Named chains**: `model:<chain-name>` resolves runtime registry (`chains.json`+`ACPTOAPI_CHAINS`+`POST /v1/chains`) → built-in → falls to auto-chain if unrecognized. `BUILTIN.auto` is a `null` sentinel — `handleAnthropicMessages` special-cases it to the live auto-chain path. Built-ins: `fast`, `cheap`, `smart`, `reasoning`, `free`, `hermes-free`, `local` — periodically re-verified, dead ids swapped.

## Error Classification (lib/chain-machine.js, lib/sampler.js, lib/keyring.js)

`chain-machine.js` is the single source of truth for chain-advance-vs-surface. `classifyError(err)`: err.code checks run BEFORE numeric/message checks (previously after → dead code once status already matched). `AbortError`→`'aborted'` first, excluded from `FALLBACK_REASONS`/`PROVIDER_LEVEL_HEALTH_REASONS`. 402/"no payment method"/"insufficient credits"→`credit_dead` — **`markCreditDead`/`isCreditDead` live in `lib/availability.js`, per model id, NOT `brand-catalog.js`** (a multi-model brand can have some models free, others 402ing, on one account; brand-wide exclusion would wrongly drop the working ones). Rest: 429→`rate_limit`; 401/403→`auth`; ECONNREFUSED/ENOTFOUND/ETIMEDOUT→`fetch_failed`; timeout→`timeout`; content-policy/safety/blocked→`content_policy`; else→`error`.

`sampler_backoff`/`matrix_block` come from `preCheck()` pre-invocation, not `classifyError`. `empty` synthesizes post-call on no text/tool-call. 4th preCheck reason `model_unhealthy`: `failStreak>=5` AND `availability.score<0` — persists via `availability-cache.json` (sampler is in-memory-only). **Last-link bypass**: all 3 preCheck gates skip when the checked link is LAST — else a single-provider chain with 5+ failures gets permanently blocked with zero live attempts, surviving restarts. `peekNext()` diagnostic does NOT apply this bypass.

**Sampler** (`lib/sampler.js`, per-**prefix** breaker): `[3s,8s,20s,60s,3m,8m]` escalation (distinct from keyring's per-key schedule), only tripped for `error,timeout,rate_limit,auth,fetch_failed,empty` on a non-aggregator prefix. Learned recovery floor: records real elapsed recovery time (last 8), backs off `min(fixedStep,min(recentRecoveries))` floored at 500ms — a fast-recovering provider stops waiting the full escalation.

**Same-link retry**: 4x identical reason advances early. Excludes `auth`/`rate_limit`/`content_policy` (won't fix by retrying). Timeout: `link.timeout ?? opts.timeout ?? DEFAULT_LINK_TIMEOUT_MS` (nullish coalescing — `||` wrongly treated explicit `0` as absent). `handleChat` passes `opts.sameLinkRetryBudgetMs` override for single-link chains so a healthy 60s+ stream isn't refused mid-stream. Soft-failure tracking feeds `availability.js`'s `softFailStreak` only. Content policy is terminal for built-in named chains, advances for the full-set default.

## HTTP error taxonomy (lib/errors.js)

A DIFFERENT `classifyError` from chain-machine.js's — maps `(status,message,provider)`→`BridgeError` subclass for SDK-caller reporting. First match: 401/403→AuthError, 429→RateLimitError, 408/timeout→TimeoutError, 413/context-length→ContextWindowError, 451/safety→ContentPolicyError, >=500→ProviderError, else→BridgeError. Fields: `message`(redacted), `status`, `code`, `retryable`(false for Auth/ContextWindow/ContentPolicy/BridgeError, true otherwise), `provider`, `headers`, `name`. `GeminiError` is a bare `BridgeError` alias. Fully separate from chain-machine.js's vocabulary despite shared names.

## Chain fluidity: wall-clock budget, streaming

`availability.js`'s `latencyPenalty` caps at `LATENCY_PENALTY_CAP_MS`, matching the success-bonus ceiling — an extreme-latency outlier now fully cancels a maxed success streak (previously capped lower). `model_unhealthy` waits bound to `MODEL_UNHEALTHY_WAIT_BUDGET_MS`(10s, shorter than sampler_backoff's — no real ETA). `inFlightFailures` Map updates on EVERY same-link retry (not just exhaustion) so a concurrent request sees an active storm immediately. `CHAIN_WALL_CLOCK_BUDGET_MS`(90s, or `opts.chainBudgetMs`) bounds the SUM across all links; past deadline throws `CHAIN_BUDGET_EXCEEDED`.

Env-var collision: `ACPTOAPI_CHAIN_LINK_TIMEOUT_MS` only applies when a caller passes no `opts.timeout`, but `handleChat` computes its own `linkTimeout` from `ACPTOAPI_LINK_TIMEOUT_MS`, overriding it (now falls back to `ACPTOAPI_CHAIN_LINK_TIMEOUT_MS` before the 120000 default). Tune `ACPTOAPI_LINK_TIMEOUT_MS` to your slowest reliable free model.

**Real streaming**: `handleChat`'s streaming branch used to run the full non-streamed `runChat` and synthesize one fake SSE chunk at the end (zero real bytes for the whole response). Now runs `runStream` with a `streamFn` wrapping `sdk.stream()`, forwarding real events live; `res.writeHead` defers until the served model is known, so streamed responses now carry `X-Acptoapi-Served-Model`/`-Chain-Attempts`/`-Chain-Exhausted` too.

## Invisible fallback + availability tracking (lib/availability.js)

Chain fallback never leaks bookkeeping into a successful HTTP body. `runChat`/`runStream` attach `result.__chainAttempted` (SDK-only contract); `handleChat` reads it for logging/headers then `delete`s it before `json(res,...)`. `handleAnthropicMessages` never attaches on success. **Rule**: any new handler serializing a chain result to HTTP MUST strip `__chainAttempted` first.

Per-model health, updated every attempt; `recordSuccess` EMA-updates latency (decay 0.3). `score(model)`: `0` only if unseen; failure penalty (`min(failStreak,10)*2`) applies at `failStreak>=1` regardless of sample count (one failure demotes below unseen immediately); success bonus (cap raised 10→30) requires `totalSamples>=2`. `effectiveFailStreak` decays continuously (30-min half-life), not a hard TTL. `MAX_RETRY_AFTER_MS`(15min) caps a provider Retry-After.

`buildAutoChain` calls `rerank` WITHIN each tier — continuous re-rank, not permanent removal (unlike `matrixSource`'s binary demote-to-end). Disable `ACPTOAPI_DISABLE_AVAILABILITY_RANK=1`. `GET /v1/availability` → per-model rows sorted by rank. Singleton hydrates `~/.acptoapi/availability-cache.json`, flushes every 10 record calls. Env: `ACPTOAPI_AVAILABILITY_CACHE_PATH`, `_PERSIST=0`, `_MIN_SAMPLES`, `_LATENCY_DECAY`. `model-resolver.js`'s `refreshAll` now runs providers concurrently — cold ttft 53s→12s.

**Response cache** (`lib/response-cache.js`): `set()` gates writes on `isJsonSerializable(value)` instead of letting `clone()` fail lazily on a later hit (a non-serializable value previously silently returned the ORIGINAL mutable object on read).

## Configuration - ~/.acptoapi + env vars

| File | Override env | Format |
|---|---|---|
| config.json | ACPTOAPI_CONFIG (then THEBIRD_CONFIG) | `{chains:{name:[...]}}`, `${ENV}` interpolation |
| queues.json | ACPTOAPI_QUEUES | `{queues:{name:[...]}}` or flat |
| chains.json | ACPTOAPI_CHAINS_PATH | `{name:[...]}`, merged over built-ins |
| probe-cache.json | ACPTOAPI_PROBE_CACHE_PATH | `{provider/model:{ok,ts}}` |
| acp-probe-cache.json | ACPTOAPI_ACP_PROBE_CACHE | `{daemon:{ok,ts}}`, 24h TTL |
| availability-cache.json | ACPTOAPI_AVAILABILITY_CACHE_PATH | per-model health |

**Boot stagger** (`server.js` listen, fire-and-forget/unref'd): model-probe-live 5000ms, swe-bench-scores 6000ms, brand-catalog refresh 8000ms, readiness warm-up 11000ms (readiness's own interval starts immediately) — staggered since landing 3+ on the same ~5000ms timer previously timed out `refreshAll` under boot contention. `ACPTOAPI_DISABLE_BOOT_PROBE=1`/`_DISABLE_PROBE=1` skip the model-probe pass.

**Env groups**: config paths — `ACPTOAPI_CONFIG`, `THEBIRD_CONFIG`, `ACPTOAPI_QUEUES`, `ACPTOAPI_CHAINS`, `ACPTOAPI_CHAINS_PATH`, `ACPTOAPI_PROBE_CACHE_PATH`, `ACPTOAPI_ACP_PROBE_CACHE`. Routing — `PROVIDER_ORDER`, `ACPTOAPI_DISABLE_AVAILABILITY_RANK=1`, `ACPTOAPI_FREE_TIER_MODE=1` (free-tier to TAIL, never head), `ACPTOAPI_ENABLE_ACP=1` (daemon switch, off), `ACPTOAPI_ENABLE_CHATJIMMY=1` (off), daemon overrides (ACP table), `ACPTOAPI_ENABLE_ACP_AUTOLAUNCH=0`. Keys — Multi-key section. Server — `PORT`(4800), `ACPTOAPI_API_KEY`, `OLLAMA_URL`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, AWS creds, `ACPTOAPI_MAX_BODY_BYTES`(10485760, else `413`), `ACPTOAPI_REQUIRE_AUTH_ON_BIND=1`.

**bin/acptoapi.js**: dotenv loads dev-repo `.env` then `~/.acptoapi/.env`, neither `override:true` — `populate()` only sets unset keys, so the FIRST-loaded value wins (dev-repo), opposite of load order. First run copies `.env.example`→`~/.acptoapi/.env` if absent. `unhandledRejection`/`uncaughtException` only log, never crash. **index.js**: `extra-providers.js`'s `start()` is fire-and-forget — first call now blocks on `ep.loadAndRegisterAsync()`, bounded by `ACPTOAPI_EXTRA_PROVIDERS_BOOT_WAIT_MS`(15000ms), so an early `chat()` can't reference an unregistered `extra-N/*` model.

**Add a queue**: write `~/.acptoapi/queues.json` `{"queues":{"myqueue":[...]}}`, no restart. **Runtime chain**: `POST /v1/chains {"name":"x","links":[...]}`.

## Observability - debug endpoints, CLI

Base `http://127.0.0.1:4800`. `/health`, `/metrics`, `/`, `/demo*`, static assets public; rest needs `ACPTOAPI_API_KEY` (bearer/`x-api-key`).

| Endpoint | Returns |
|---|---|
| GET /health | `{ok,backends:[prefix...]}` |
| GET /debug/providers | `[{name,status,latencyMs}]` — live 2s ACP probe |
| GET /debug/auto-chain | `{links,order,available}` |
| GET /debug/chains | `{defined,recent}` |
| GET /debug/probe-live[?force=1] | `{models,chain,logs}` |
| GET /debug/config | Runtime config, keys redacted |
| POST /debug/translate | Test `{from,to,provider,...}` — 8 core providers only |
| GET /v1/models | Mixed model/queue rows |
| GET /v1/queues, /v1/chains | POST/DELETE on chains |
| GET /v1/sampler/status | `{status:[{provider,ok,failCount,nextCheckIn,neverProbed?}]}` — merges sampler's Map with configured providers, synthesizing `{ok:null,neverProbed:true}` for never-dispatched |
| GET /v1/availability, /v1/runs, /v1/keyring/status | See sections above |
| GET /v1/cache/stats, POST /v1/cache/clear | Response-cache |
| GET /v1/pretest/stats, POST /v1/pretest/run | Pretest |
| GET /debug/why?model=<id> | `{model,prefix,wouldBeSelectable,blockers:[{layer,detail}],score,availability}` — unifies sampler+keyring gating for one id |

`nextCheckIn>0`→backoff'd until elapsed. `ok:null`+`neverProbed:true`→configured but never dispatched. `/v1/keyring/status` `nextRetryInMs>0`→key cooling down. `/v1/runs` `history[]`=`{model,reason,error}`, `attempted[]`=`{model,ms,ok,reason}`. `/debug/providers` `status:'unreachable'`→ACP daemon silent past 2s.

**CLI**: `acptoapi` (start, `--port N`), `--probe` (key presence via keyring), `--missing-free` (free-tier providers with no usable key + signup URL), `--list-brands`, `--list-chains`, `--list-models [--port N]` (ranked by availability), `--xai-oauth-login`, `--update`. No TUI — demo UI at `GET /`/`/demo`.
