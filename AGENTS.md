# AGENTS.md  - acptoapi

Non-obvious technical caveats for agents working on this repo.

## Public API  - unified chain SDK (since 1.0.57)

acptoapi is the canonical home for LLM model resolution, chain fallback, sampler backoff, and matrix-aware scoring. **Downstream consumers (freddie, thebird, etc.) must NOT reimplement these locally.** The SDK delegates everything; consumers pass model strings and config.

### Model string syntax

`api.chat({ model, messages, ... })` accepts three forms:

1. **Single model id**  - `'groq/llama-3.3-70b-versatile'`, `'anthropic/claude-haiku-4-5'`, `'ollama/llama3.2'`. Resolved via `resolveModel(model)`.
2. **Comma-separated chain**  - `'groq/llama-3.3-70b-versatile, mistral/mistral-tiny, kilo/openrouter/free'`. Whitespace tolerated. Dispatched as `chain([...])`.
3. **`queue/<name>`**  - named queue from `~/.acptoapi/queues.json` (default) or injected sources. Resolved via `resolveQueue({name, queuesMap?, configPath?, extraQueueSources?})`.

Also: `'chain/<name>'`  - legacy alias of `queue/`, reads `~/.thebird/config.json` chains. Both supported.

### Queue sources (in resolution order)

1. `process.env.ACPTOAPI_QUEUES` or `~/.acptoapi/queues.json`  - primary store. JSON `{queues: {<name>: [<model>, ...]}}` or flat `{<name>: [...]}`.
2. `extraQueueSources: [...]` opt  - additional file paths. Per-call override.
3. `~/.thebird/config.json` `chains` key  - backward compat.
4. `queuesMap` opt  - in-memory `{<name>: [...]}` merged last (highest priority).

Server-level injection: `createServer({queuesProvider: () => ({...})})`  - provider function called per-request, merged into `/v1/models` queue rows and `/v1/queues`.

### Chain semantics

`api.chat({model: 'a,b,c', messages, onFallback})`:
- Each link tried in order.
- Before invocation, `sampler.isAvailable(prefix)` consulted  - if backoff-blocked, link is skipped without an attempt (reason `sampler_backoff`).
- If `opts.matrixSource` is set (file path, URL, or function returning `{providers: [{id, models: [{id, usable_in_any_mode, modes}]}]}`), cells with `ok:false` for any mode are demoted to the END of the chain. `matrix_block` reason if encountered.
- On link failure (`error`/`rate_limit`/`timeout`/`empty`/`content_policy`), `onFallback({from, to, reason, error})` fires, chain advances.
- **`sampler.markFailed(prefix)` is NOT called when the next link shares the same prefix**  - preserves "bad model id, try sibling" without triggering full provider backoff.
- On exhaustion, throws with `err.chainHistory` and `err.attempted` populated.

### Inspection helpers

- `chain([...]).peekNext(n)`  - returns next-N candidates `[{index, model, prefix, fallbackOn, blocked, reason}]` after sampler+matrix filtering. For dashboard "next-up" UI.
- `sampler.peekStatus(provider)`  - `{available, lastFailedAt, nextRetryAt, failCount}`.
- `getRunHistory()`  - per-invocation entries `{ts, requestedModel, resolvedLinks, attempted, finalModel, history, ...}`.
- `listAllModelsAndQueues({matrixSource, queueSources, queuesMap})`  - OpenAI-models-shape rows mixing `{id, object:'model'}` and `{id:'queue/<name>', object:'queue', links}`.

### HTTP surface

- `GET /v1/models`  - includes `{id: 'queue/<name>', object: 'queue', queue_links: [...], source}` rows.
- `GET /v1/queues`  - `{queues: [{name, links, source}]}`.
- `GET /v1/sampler/status`  - `{status: [{provider, ok, failCount, nextCheckIn}]}`.
- `GET /v1/runs`  - `{runs: [...]}`  - chain run history.

### openai-compat fix

`api.chat({model: 'groq/...'})` (or any brand-prefix model id) now works in single-shot  - previously the `from:'openai'` path stripped the `{url, apiKey, body}` carrier in `buildParams`. The fix conditionally drops `from` when `provider === 'openai-compat'`. If you see `Failed to parse URL from undefined`, you've imported an older acptoapi.

## Scope

acptoapi does NOT spawn the local Claude Code CLI and does NOT read Claude Code session history. Both were removed (2026-05-21). Consumers that need Claude Code chat or JSONL history (e.g. agentgui) must depend on `@anthropic-ai/claude-code` and `ccsniff` directly. Also: gemini-cli OAuth path (`lib/cloud-generate.js`, `lib/oauth.js`, the `claude/` and `cloud/` prefixes) was removed in the same change  - Google's gemini-cli is being discontinued upstream.

## Protocol Bridge Architecture (2026-04-25 expansion)

Project transformed from single-protocol OpenAI facade into any-to-any AI protocol bridge.

### Eight Formats (lib/formats/)

- `openai.js`, `anthropic.js`, `gemini.js`, `kilo.js` (legacy)
- `mistral.js`, `cohere.js`, `ollama.js`, `bedrock.js` (new)

All 8 registered in `translate()` pipeline. Any format can be input, any format can be output.

### Eight Providers (lib/providers/)

- `openai`, `kilo`, `unknown` (legacy)
- `anthropic` (direct API via ANTHROPIC_API_KEY)
- `anthropic-via-openai` (facade routing)
- `ollama` (local instance at OLLAMA_URL, default http://localhost:11434)
- `bedrock` (AWS via AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION, optional AWS_SESSION_TOKEN)
- `gemini` (via GEMINI_API_KEY)

All 8 registered. Any provider can route requests, format conversion happens transparently.

### Core Pipeline: translate()

```javascript
translate({ from, to, provider, ...params })
```

- `from`: input protocol (format name)
- `to`: output protocol (format name)
- `provider`: backend to route to (provider name)
- `...params`: format-specific fields (model, messages, etc.)

Any (from, to, provider) triple works. Transform happens mid-pipeline.

### New Server Endpoints (lib/server.js)

**SDK drop-in compatibility:**
- POST /v1/messages  - Anthropic SDK target
- POST /v1beta/models/:model:streamGenerateContent  - Gemini streaming
- POST /v1beta/models/:model:generateContent  - Gemini non-streaming
- GET /v1beta/models  - Gemini model list

**Observability:**
- GET /debug/providers  - List configured providers
- GET /debug/config  - Runtime config dump
- POST /debug/translate  - Test translate(from, to, provider)

Use /debug/translate to troubleshoot any format/provider combination before integrating.

### Model Enumeration

GET /v1/models returns dynamic list:
- `kilo`, `opencode`, `claude` (always)
- `anthropic` (if ANTHROPIC_API_KEY set)
- `gemini` (if GEMINI_API_KEY set)
- Ollama models from /api/tags at OLLAMA_URL (e.g., llama2, mistral)

**Important:** Do not hardcode expected models. List is driven by env config.

### Reasoning Content Passthrough

New internal event type: `reasoning-delta` with `{ reasoningDelta: string }` payload.

Maps to:
- Anthropic thinking blocks (Claude models with extended thinking)
- OpenAI reasoning_content (o1 models)

When translating between formats, preserve reasoning blocks if both source and target support them. Check format docs for reasoning field names (may vary: `thinking`, `reasoning_content`, `content[type=thinking]`, etc.).

## Multi-key per provider (lib/keyring.js, 2026-05-19)

Every provider envKey (e.g. `GROQ_API_KEY`) accepts N keys seamlessly:

- Primary: `GROQ_API_KEY`
- Additional: `GROQ_API_KEY_1` ... `GROQ_API_KEY_99` (each contributes one key, in declared order, deduped)
- Escape hatch: `ACPTOAPI_KEYS_GROQ_API_KEY=["key-a","key-b"]` (JSON array)

`lib/keyring.js` is the single source of truth  - `getKey(envKey)` returns the first usable key (skipping cooldown-blocked ones); `listUsable(envKey)` returns all currently-usable keys in declared order; `markKeyFailed(envKey, key, reason)` records a per-key backoff with steps `[30s, 60s, 2m, 4m, 8m]` mirroring `lib/sampler.js`. Classification: 401/403 -> `auth`, 429 -> `rate_limit`, 5xx -> `upstream_5xx` (not backoff-worthy; provider issue not key issue).

`handleBrandChat` and `handleEmbeddings` in `lib/server.js` rotate keys inline on `auth`/`rate_limit` responses, only falling through to the next chain link after every key for the provider is exhausted. Server log emits `[acptoapi] key-rotate provider=<name> reason=<r> key-index=<i> next-index=<i+1>` on each rotation.

Direct `process.env[envKey]` reads outside `lib/keyring.js` are forbidden for known provider keys  - all consumers (sdk.js, server.js, passthrough.js, media-passthrough.js, auto-chain.js, model-resolver.js, model-probe-live.js) route through the keyring.

**Observability:** `GET /v1/keyring/status` returns `{providers: [{provider, envKey, keys: [{index, key (masked: 'prefix...suffix'), ok, failCount, lastFailedAt, lastReason, inBackoff, nextRetryInMs}]}]}`.

Witness (2026-05-19): with `GROQ_API_KEY=<bad>` + `GROQ_API_KEY_2=<real>`, POST `/v1/chat/completions model=groq/llama-3.3-70b-versatile` returned 200 with assistant content; server log shows the bad key got marked `auth` failed and the real key served the response  - no provider fallback triggered.

## ACP Daemons  - 10 Agents (lib/acp-launcher.js)

acptoapi spawns and manages ACP (Agent Client Protocol) daemons  - local agent processes that listen on defined ports and communicate via JSON-RPC over stdio. Ten daemons are auto-launched on boot via `ensureRunning()`:

- **Kilo** (port 4780, `kilo/openrouter/free`)
  - Official: https://github.com/kilo-language/kilo-code
  - Auto-spawn attempts: bare `kilo-acp`, `kilo acp`, `npx kilo-code-cli`, `bunx kilo-code-cli`
  - Override with `KILO_ACP_CMD=<shell-string>`
  - Requires: No API key (uses OpenRouter free tier fallback)

- **Opencode** (port 4790, `opencode/minimax-m2.5-free`)
  - Official: https://github.com/opencode-ai/opencode
  - Auto-spawn attempts: bare `opencode-acp`, `opencode acp`, `npx opencode-ai`, `bunx opencode-ai`
  - Override with `OPENCODE_ACP_CMD=<shell-string>`
  - Requires: No API key (uses Minimax free tier)

- **Qwen Code** (port 4820, `qwen-code/qwen-plus`)
  - Official: https://github.com/QwenLM/qwen-code
  - Auto-spawn attempts: bare `qwen-code`, `qwen-code acp`, `npx qwen-code-cli`, `bunx qwen-code-cli`
  - Override with `QWEN_CODE_ACP_CMD=<shell-string>`
  - Requires: `QWEN_API_KEY` env var for upstream calls

- **Codex CLI** (port 4830, `codex-cli/gpt-4-turbo`)
  - Official: https://github.com/anthropics/codex-cli (if available)
  - Auto-spawn attempts: bare `codex-cli`, `codex-cli acp`, `npx openai-codex-cli`, `bunx openai-codex-cli`
  - Override with `CODEX_CLI_ACP_CMD=<shell-string>`
  - Requires: `OPENAI_API_KEY` env var for upstream calls

- **Copilot CLI** (port 4840, `copilot-cli/gpt-4o`)
  - Official: https://github.com/github/copilot-cli
  - Auto-spawn attempts: `gh copilot acp`, bare `copilot-cli`, `npx @github/copilot-cli`, `bunx @github/copilot-cli`
  - Override with `COPILOT_CLI_ACP_CMD=<shell-string>`
  - Requires: `GITHUB_TOKEN` env var for authentication (via `gh` CLI)

- **Cline** (port 4850, `cline/claude-opus-4-1`)
  - Official: https://github.com/cline/cline
  - Auto-spawn attempts: bare `cline`, `npx cline`, `bunx cline`
  - Override with `CLINE_ACP_CMD=<shell-string>`
  - Requires: `ANTHROPIC_API_KEY` env var for upstream calls

- **Hermes Agent** (port 4860, `hermes-agent/hermes-3-70b`)
  - Official: https://github.com/NousResearch/hermes-agent
  - Auto-spawn attempts: bare `hermes-acp`, `npx @nos/hermes-agent`, `bunx @nos/hermes-agent`
  - Override with `HERMES_ACP_CMD=<shell-string>`
  - Requires: No API key (uses integrated model provider)

- **Cursor ACP** (port 4870, `cursor-acp/cursor-pro`)
  - Official: https://github.com/roshan-c/cursor-acp
  - Auto-spawn attempts: bare `cursor-acp`, `npx cursor-acp`, `bunx cursor-acp`
  - Override with `CURSOR_ACP_CMD=<shell-string>`
  - Requires: No API key (bridges Cursor CLI)

- **Codeium Command** (port 4880, `codeium-cli/claude-opus-4`)
  - Official: https://help.codeium.com (Codeium official ACP integration)
  - Auto-spawn attempts: `codeium-cli acp`, `codeium command`, `npx codeium-cli`, `bunx codeium-cli`
  - Override with `CODEIUM_ACP_CMD=<shell-string>`
  - Requires: `CODEIUM_API_KEY` env var (optional, falls back to unauthenticated)

- **ACP CLI Reference** (port 4890, `acp-cli/gpt-4-turbo`)
  - Official: https://github.com/acp-protocol/acp-cli (Rust reference implementation)
  - Auto-spawn attempts: `acp daemon start`, `npx acp-cli daemon start`, `bunx acp-cli daemon start`
  - Override with `ACP_CLI_CMD=<shell-string>`
  - Requires: No API key (reference implementation)

### Windows Spawning Behavior

On Windows, daemons spawn with stdio redirected to temp files (`os.tmpdir()/.acptoapi-null`) instead of 'ignore'. This prevents visible console windows from appearing while properly detaching the process. The spool's `spawn({ detached: true, stdio: ['ignore', fileHandle, fileHandle] })` uses `proc.unref()` AFTER survival check (600ms) to ensure daemonization.

File handles are cleaned on process exit via `atexit` hook. This approach is safer and more reliable than `stdio: 'ignore'` on Windows, where child processes may inherit the parent's console context.

### Daemon Registration API

Extend the daemon registry dynamically:

```javascript
const { registerBackend, BACKENDS } = require('./lib/acp-client');
const { registerDaemon, CMDS } = require('./lib/acp-launcher');

registerBackend('my-daemon', { 
  base: 'http://localhost:9999', 
  providerID: 'my-provider', 
  defaultModel: 'my-provider/model-id' 
});
registerDaemon('my-daemon', 9999, [
  { command: 'my-daemon', args: [] },
  { command: 'my-daemon', args: ['serve'] },
]);
```

- `registerBackend()`  - adds to `BACKENDS` global, updates `splitModel()` regex
- `registerDaemon()`  - adds to `CMDS` global, enrolled in `ensureRunning()` boot sequence
- New backends automatically appear in `GET /debug/providers` and chain fallback rankings

### Health Check

`GET /health` returns `{ backends: { kilo, opencode, qwen-code, codex-cli, ... } }` showing daemon status (up/down per port).

## Auto-Fallback Chain (lib/auto-chain.js)

`buildAutoChain(targetModel?)` auto-detects available providers from env and returns a priority-ordered array of chain links.

### Provider Detection

- Brand providers (groq, nvidia, cerebras, etc.): checked via `isBrand()` + env key presence in `lib/openai-brands.js`
- Built-in providers: `anthropic` -> `ANTHROPIC_API_KEY`, `gemini` -> `GEMINI_API_KEY`, `ollama` -> always available (no key required)
- ACP daemons: `kilo`, `opencode`, `qwen-code`, `codex-cli`, `copilot-cli`, `cline`, `hermes-agent`, `cursor-acp`, `codeium-cli`, `acp-cli` -> always available (auto-spawned on boot if not running)

### Priority Order

Default: `anthropic, openrouter, groq, nvidia, cerebras, sambanova, mistral, codestral, qwen, zai, cloudflare, gemini, bedrock, opencode-zen, opencode-north, opencode, mimo, ollama, kilo, qwen-code, codex-cli, copilot-cli, cline, hermes-agent, cursor-acp, codeium-cli, acp-cli, chatjimmy`

- Direct API providers (anthropic, gemini) come first by priority
- Brand providers (groq, nvidia, etc.) ranked by `PROVIDER_ORDER` env if set
- ACP daemons (kilo, opencode, qwen-code, codex-cli, copilot-cli, cline, ...) follow

Override with `PROVIDER_ORDER=groq,nvidia,anthropic` (comma-separated). Only providers with available env keys appear in the chain.

### Usage

```js
const { buildAutoChain } = require('./lib/auto-chain');
const links = buildAutoChain();
// returns: [{ model: 'groq/llama-3.3-70b-versatile', fallbackOn: ['error','rate_limit','timeout','empty'] }, ...]
```

Pass `model: 'auto'` to the Anthropic-compat endpoint to trigger auto-chain routing. First available provider in priority order is selected.

### Observability

`GET /debug/auto-chain` returns `{ links: [...], order: [...] }` showing the current resolved chain.

### Providers Supported (lib/openai-brands.js)

| Prefix | Env Key |
|--------|---------|
| groq | GROQ_API_KEY |
| openrouter | OPENROUTER_API_KEY |
| nvidia | NVIDIA_API_KEY |
| cerebras | CEREBRAS_API_KEY |
| sambanova | SAMBANOVA_API_KEY |
| mistral | MISTRAL_API_KEY |
| codestral | CODESTRAL_API_KEY |
| qwen | QWEN_API_KEY |
| zai | ZAI_API_KEY |
| cloudflare | CLOUDFLARE_API_KEY + CLOUDFLARE_ACCOUNT_ID |
| opencode-zen | OPENCODE_ZEN_API_KEY |
| together | TOGETHER_API_KEY |
| deepseek | DEEPSEEK_API_KEY |
| xai | XAI_API_KEY |
| perplexity | PERPLEXITY_API_KEY |
| fireworks | FIREWORKS_API_KEY |

Cloudflare URL is dynamic: `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1/chat/completions`  - `CLOUDFLARE_ACCOUNT_ID` is required alongside `CLOUDFLARE_API_KEY`.

## Brand Routing (HTTP Passthrough Pattern)

OpenAI-compatible brand prefixes (groq, openrouter, together, deepseek, xai, cerebras, perplexity, mistral, fireworks, openai) route via **HTTP passthrough**, not through the `translate()` pipeline.

### Why Passthrough, Not translate()

Mapping raw request bodies through `translate()` requires converting to canonical format via `toParams()`, which expects well-formed OpenAI-compat parameters. Brand requests may send raw/vendor-specific bodies that don't fit. Passthrough is simpler and correct: fetch upstream, stream response bytes unchanged.

### Implementation

- **Dispatch table**: `lib/openai-brands.js` maps prefix -> vendor URL + env key
- **Detection**: `splitBrandModel(model)` regex `/^([a-z0-9-]+)\/(.+)$/` extracts prefix and model name; `isBrand(prefix)` validates
- **Handling**: `lib/server.js` `handleBrandChat()` fetches upstream, streams body through unchanged
- **API coverage**: Applies to chat, embeddings (`POST /v1/embeddings`), and token counting (`POST /v1/messages/count_tokens`  - heuristic: length / 4)
- **Function URLs**: `getBrand(prefix)` resolves function-valued URLs at call time (e.g., Cloudflare dynamic account URL)

## Testing: No Mocks, Only Real Backends

acptoapi forbids mocks anywhere in tests. This includes:
- No mock providers in test.js
- No monkey-patching of sdk.stream or sdk.chat
- No stub HTTP responses

All SDK and chain behavior must be witnessed via **real backends**:
- kilo server on :4780
- opencode server on :4790
- Real Anthropic/Gemini/Ollama via environment keys

For fallback chain tests, use a **real-but-failing target** as the first link (e.g., unreachable URL, missing env key) paired with a **real working backend** as the fallback. This tests actual failover behavior without mock layers.

Rationale: User design requirement. Only real content validates the bridge's correctness.

## CSS Specificity Cascade in app-shell.css

The `.app-main a` descendant rule has higher CSS specificity than `.btn-primary` (descendant combinator + element selector vs single class). This causes generic anchor styles to override button colors, rendering buttons invisible when text and background are both the same accent color.

**Symptom**: "Try it live" button disappears - mint text on mint background. Witness via `getComputedStyle(element).color` on docs server.

**Fix**: Scope the descendant anchor rule with `:not()` pseudo-class to exclude button components:
```css
.app-main a:not(.btn):not(.btn-primary):not(.btn-ghost) {
  color: var(--panel-accent);
}
```

**Root cause**: CSS variable definitions (e.g., `--panel-accent-fg = #0B0B09`) were correct; the problem was selector specificity, not variable resolution. Specificity arithmetic: `.app-main a` = 0,1,2 (class + element) vs `.btn-primary` = 0,1,0 (single class), so descendant wins.

## Chain Fallback Architecture (xstate v5)

Chain fallback is driven by **xstate v5 FSM** (`lib/chain-machine.js`), not a linear retry loop. Non-obvious aspects:

- **State machine**: `setup({}).createMachine(...)` defines states `trying`, `done`, `exhausted` and events `SUCCESS` and `FALLBACK { reason, error }`. Actors are created via `createActor(machine)` and pumped by async drivers (`runStream`/`runChat`).
- **Run history**: `getRunHistory()` subscribes to actor snapshots and returns the last 50 runs. This is NOT a log file or array  - it's a live stream of FSM state transitions.
- **Fallback reasons**: Canonical set (`FALLBACK_REASONS`, chain-machine.js:4) is the full 9-item list `['error', 'timeout', 'rate_limit', 'empty', 'content_policy', 'sampler_backoff', 'matrix_block', 'auth', 'fetch_failed']`  - see "Error Classification" below for the authoritative breakdown. When a link has no explicit `fallbackOn`, `shouldFallback()` defaults to this FULL set (every reason advances the chain), not `['error']` alone. Built-in named chains (`lib/named-chains.js` `FALLBACK_ON`) narrow this per-link to the 4-item `['error','rate_limit','timeout','empty']`; `buildAutoChain` (`lib/auto-chain.js` `FALLBACK_ON`) pins the full 9-item set `['error','rate_limit','timeout','empty','auth','fetch_failed','content_policy','sampler_backoff','matrix_block']` per link  - the two constants are NOT identical despite both being named `FALLBACK_ON`.
- **SDK integration**: `chat`/`stream` methods in `lib/sdk.js` early-branch on `model: 'chain/<name>'` and delegate to `lib/chain.js`. Old `streamChain`/`chatChain` now wrap the chain builder.
- **Config-driven chains**: Named chains (e.g., `chain('fallback-to-gemini')`) resolve links via `loadConfig().chains`. `--list-chains` CLI flag and `GET /debug/chains` enumerate defined and recent chains.
- **Why xstate not floosie**: `floosie` was evaluated and rejected because it is pure ESM (CJS friction) with 5 heavy transitive deps. xstate FSM alone provides deterministic state transitions and event handling without the ESM/CJS wrap/unwrap dance. Unused `flowie` dep was removed in the same commit.

## Test Launcher (nim directory)

Persistent test server at c:\dev\nim (copy of .env, start.bat launcher script):

- **start.bat**: Loads .env (provider keys), sets ACPTOAPI_API_KEY=theultimateflex and PORT=4900, runs `node c:\dev\acptoapi\bin\acptoapi.js`.
- **Probe pattern** (run from c:\dev\test): Set ANTHROPIC_BASE_URL=http://127.0.0.1:4900, ANTHROPIC_AUTH_TOKEN=theultimateflex, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1, then invoke `claude -p "<prompt>" --output-format stream-json --verbose --include-partial-messages --debug`.
- **Auto-chain routing**: Bare `claude-*` model names from CLI route through auto-chain (first link defaults to groq/llama-3.3-70b-versatile with current .env keys).
- **Health check**: `curl http://127.0.0.1:4900/health` returns 200 with backends list. Confirms server is up.
- **Daemon launch**: Do NOT use `nohup cmd //c start.bat &` from bash  - leaves a dead shell. Instead use Node `spawn({ detached: true, stdio: ['ignore', fileHandle, fileHandle] })` for a real persistent daemon.

## Model resolution + dynamic defaults (2026-05-12)

`resolveModel(model)` (`lib/sdk.js:21`) resolves a `<provider>/<model>` string to `{provider, model, env, url}`. `splitPrefix` (`lib/sdk.js`) does the prefix/rest split; `resolveQueue` (`lib/queues.js:38`) resolves `queue/<name>` strings; `splitBrandModel` is duplicated independently in `lib/server.js` and `lib/passthrough.js` (NOT a single shared implementation - keep these in sync manually if the split logic changes). Note: `lib/model-resolver.js` is a DIFFERENT module - it probes live models per-provider to pick a strong dynamic default and caches to `~/.acptoapi/models-cache.json`; it is unrelated to the `<provider>/<model>` string-parsing functions above despite the similar name.

`PROVIDER_KEYS` (env var per provider) and `PROVIDER_DEFAULTS` (default model per provider) are exported from `lib/provider-maps.js` and re-exported from `acptoapi` root. Freddie consumes both via `createRequire(import.meta.url)` in `src/agent/llm_resolver.js`  - single source of truth for the 17 supported providers (anthropic, openai, groq, google, mistral, cerebras, nvidia, openrouter, sambanova, codestral, zai, qwen, cloudflare, opencode, kilo, claude-cli, ollama).

Default model selection: if caller passes only `provider`, resolver fills in `PROVIDER_DEFAULTS[provider]`. Updates to the defaults table land in this repo, propagate to freddie on next `npm install` (or `node scripts/sync-upstream.mjs`).

## kilo protocol notes (2026-05-12)

Kilo + opencode ACP daemons speak the same protocol (SSE event stream + REST session/message). Required ordering: open `GET /event` SSE BEFORE `POST /session/<id>/message` or events drop. Terminate on `session.idle`. Surfaces only assembled content (no tool_calls back to caller). Implementations in consumers (e.g., freddie `src/agent/llm_resolver.js::acpChat`) must mirror this ordering.

## Live model probe (2026-05-13, corrected 2026-07-02)

`lib/model-probe-live.js` does NOT dynamically fetch each provider's `/models` endpoint - it works from a static, curated `KNOWN` dictionary (`lib/model-probe-live.js:104`) where every entry must carry a SWE-bench score. `getAvailableModels()` is the passive path: reads the on-disk/in-memory probe cache (per-model `{ok, ts}`, TTL-gated) without making any real network calls. `getAvailableModelsLive({log, force})` is the ACTIVE path: chat-probes models from `KNOWN` with a 1-token request and writes `saveProbeCache()` to disk. Until 2026-07-02, `GET /debug/probe-live` only ever called the passive `getAvailableModels()` - `getAvailableModelsLive`/`probeProvider`/`probeAllProviders` were exported but never invoked anywhere, so `ACPTOAPI_LIVE_PROBE=1`, the `x-live-probe` header, and `?force=1` all had zero effect and the on-disk cache was never actually written by any reachable path. Fixed: the endpoint now checks `?force=1` or `x-live-probe: 1` and calls `getAvailableModelsLive({force: true})`, which bypasses the boot-time `PROBE_ENABLED` gate per-request.

Real env vars (verify against the file before trusting any OTHER env var name for this module - several previously-documented ones here, `ACPTOAPI_PROBE_CAP`, `ACPTOAPI_DISABLE_PROBE`, `ACPTOAPI_PROBE_CONCURRENCY`, `ACPTOAPI_PROBE_OLLAMA`, and a function named `isFresh()`, do NOT exist anywhere in the codebase and were stale documentation removed in this correction):
- `ACPTOAPI_LIVE_PROBE=1`  - enables active probing at server boot; without it, only the passive cache-reading path runs unless a request forces it.
- `ACPTOAPI_PROBE_TTL_MS=N`  - in-memory and on-disk cache TTL (default 600000ms = 10min).
- `ACPTOAPI_PROBE_CACHE_PATH=<file>`  - defaults to `~/.acptoapi/probe-cache.json`; persists across reboots.

Endpoints:
- `GET /debug/probe-live[?force=1]` (or header `x-live-probe: 1`)  - `force=1`/the header triggers a real active probe via `getAvailableModelsLive`; without it, serves the passive cached view.
- `GET /v1/chains`  - list built-in + runtime named chains with their resolved links.
- `POST /v1/chains` body `{name, links: [...]}`  - register a runtime chain.
- `DELETE /v1/chains?name=<name>`  - remove a runtime chain.

## Named chain selection (2026-05-13)

Caller sends `model: <chain-name>` in `/v1/messages` (or `/v1/chat/completions`). Resolution order: runtime registry (`~/.acptoapi/chains.json` + `ACPTOAPI_CHAINS` env JSON + `POST /v1/chains`) -> built-in (`fast`, `cheap`, `smart`, `reasoning`, `free`, `local`). Unrecognized name falls through to default auto-chain so any caller-supplied model that isn't a chain still works.

Built-ins in `lib/named-chains.js`:
- `fast`  - groq llama 3.3-70b -> groq 3.1-8b -> cerebras 3.3-70b
- `cheap`  - openrouter gemini flash-lite -> groq 3.1-8b -> mistral-tiny
- `smart`  - anthropic sonnet-4-6 -> openrouter claude-sonnet-4.6 -> mistral-large
- `reasoning`  - openrouter deepseek-v4-pro -> sambanova DeepSeek-V3.2 -> nvidia nemotron-3-nano-reasoning
- `free`  - groq llama-4-scout -> openrouter/free -> google gemini-2.5-flash -> kilo/openrouter free -> opencode/minimax free
- `hermes-free`  - ordered free models for Hermes Agent (per remoteopenclaw.com best-free-models-for-hermes): free online APIs best-first (groq llama-4-scout -> openrouter/free -> google gemini-2.5-flash) then no-key ACP daemons (kilo/openrouter free -> opencode/minimax free -> hermes-agent/hermes-3-70b)
- `local`  - ollama llama3.2 -> kilo/openrouter free -> opencode/minimax free

## ACP auto-launch (2026-05-13)

`lib/acp-launcher.js` probes `:4780` (kilo) and `:4790` (opencode) at server boot. If down, tries an ordered list of spawn commands per daemon: bare binary, subcommand, npx, bunx. Override the entire attempt list with `KILO_ACP_CMD=...` / `OPENCODE_ACP_CMD=...` (shell string). `ACPTOAPI_DISABLE_ACP_AUTOLAUNCH=1` opts out.

Each attempt is given 600ms to fail-fast (ENOENT, immediate exit) before moving to the next. The chain treats kilo + opencode as the second-to-last fallback before the claude CLI. If both daemons fail to launch, the chain still tries the links  - they just return "fetch failed" quickly and fall through.

## Default fallback order (2026-05-13)

`lib/auto-chain.js` DEFAULT_ORDER = `anthropic, openrouter, groq, nvidia, cerebras, sambanova, mistral, codestral, qwen, zai, cloudflare, gemini, bedrock, opencode-zen, opencode-north, opencode, mimo, ollama, kilo, qwen-code, codex-cli, copilot-cli, cline, hermes-agent, cursor-acp, codeium-cli, acp-cli, chatjimmy`. There is no `claude` (CLI) entry  - the CLI-spawn path was removed from this repo's scope (see "Scope" section above); `chatjimmy` (always available, no key required) is now the last entry. ACP daemons (`kilo`, `qwen-code`, `codex-cli`, `copilot-cli`, `cline`, `hermes-agent`, `cursor-acp`, `codeium-cli`, `acp-cli`) and always-available built-ins (`ollama`, `opencode`, `chatjimmy`) fill out the tail; direct API/brand providers fill the head in priority order (env-key presence required via `hasProvider()`). Override the whole order with `PROVIDER_ORDER=a,b,c`.

## Error Classification  - fallback reasons (lib/chain-machine.js, lib/sampler.js, lib/keyring.js)

Chain fallback is reason-driven. `lib/chain-machine.js` is the single source of truth for which failures advance the chain vs. surface to the caller.

### Canonical reason set

`FALLBACK_REASONS` (chain-machine.js:4) = `['error', 'timeout', 'rate_limit', 'empty', 'content_policy', 'sampler_backoff', 'matrix_block', 'auth', 'fetch_failed']`.

`classifyError(err)` (chain-machine.js:6) maps a thrown error to a reason:
- `err.code === 'RATE_LIMIT'` or message matches `/rate.?limit|429|quota/i` -> `rate_limit`
- `err.code === 'AUTH'` or message matches `/401|403|invalid api key|unauthorized/i` -> `auth`
- `err.code === 'FETCH_FAILED'` or message matches `/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT/i` -> `fetch_failed`
- `err.code === 'TIMEOUT'` or message matches `/timeout|timed out/i` -> `timeout`
- message matches `/content.?policy|safety|blocked/i` -> `content_policy`
- anything else -> `error`

`sampler_backoff` and `matrix_block` are NOT produced by `classifyError`; they come from `preCheck()` (chain-machine.js:40) **before** a link is invoked  - `sampler_backoff` when `sampler.isAvailable(prefix)` is false, `matrix_block` when the matrix scores the cell `ok:false`. `empty` is synthesized post-call when a finished response yielded no text/tool-call (`isEmptyResult`, chain-machine.js:272).

### Terminal vs. trigger-next-link

`shouldFallback(reason, fallbackOn)` (chain-machine.js:21) decides. **When a link has no explicit `fallbackOn`, the default is the FULL `FALLBACK_REASONS` set**  - every reason advances the chain, so a `rate_limit`/`auth`/`timeout`/`content_policy` is never surfaced to the caller as long as another link remains. Only when a caller explicitly narrows `fallbackOn` (e.g. `['error']`) do the omitted reasons become terminal (the error is rethrown immediately).

- Built-in named chains (`lib/named-chains.js:15`) pin `fallbackOn = ['error', 'rate_limit', 'timeout', 'empty']` per link  - `auth`/`content_policy`/`fetch_failed` are terminal for those chains.
- `buildAutoChain` links pin `['error','rate_limit','timeout','empty']` likewise.
- On exhaustion the last error is rethrown with `err.chainHistory` (per-link `{model, reason, error}`) and `err.attempted` (per-link `{model, ms, ok, reason}`) populated.

### Sampler backoff strategy (lib/sampler.js)

Per-**provider-prefix** (not per-model, not per-key) circuit breaker. `BACKOFF_STEPS_MS = [30000, 60000, 120000, 240000, 480000]` (30s -> 1m -> 2m -> 4m -> 8m, capped). `markFailed(prefix)` increments `failCount` and sets `nextCheck = now + STEPS[min(failCount-1, 4)]`. While `nextCheck > now`, `isAvailable(prefix)` returns false -> `preCheck` blocks the link with reason `sampler_backoff` (no upstream call made). `markOk(prefix)` resets `failCount`/`nextCheck`/`lastFailedAt` to clean.

**Critical sibling rule** (chain-machine.js:178, :259): `sampler.markFailed(prefix)` is called on a link failure ONLY when `prefix !== nextPrefix` AND `reason !== 'error'`. If the next link shares the same provider prefix (e.g. a bad model id followed by a sibling model on the same provider), the provider is NOT marked failed  - preserves "try a sibling model" without tripping full-provider backoff. A bare `error` reason also never trips the sampler (only the categorized transient reasons do). On link success, `markOk(prefix)` clears the breaker.

The background sampler (`startSampler`, default interval 3600000ms = 1h) re-probes providers whose `nextCheck` has elapsed; `if (interval.unref)` so it never holds the process open.

### Rate-limit handling and key rotation (lib/keyring.js)

Two layers, distinct granularity:

1. **Provider-level** (sampler): a `rate_limit` failure trips the prefix breaker per the sibling rule above, demoting the whole provider for the backoff window.
2. **Key-level** (keyring, per `(envKey, key)`): `handleBrandChat`/`handleEmbeddings` rotate keys INLINE before falling to the next chain link. `keyring.classify(status)` (keyring.js:137): `401|403 -> auth`, `429 -> rate_limit`, `>=500 -> upstream_5xx`. **`upstream_5xx` is deliberately NOT backoff-worthy**  - a 5xx is the provider's fault, not the key's, so the key is not penalized. `markKeyFailed` applies the same `[30s,60s,2m,4m,8m]` per-key backoff for `auth`/`rate_limit`.

**Key rotation order**: `listUsable(envKey)` returns keys in DECLARED order (`GROQ_API_KEY`, then `_1`.._99`, then the `ACPTOAPI_KEYS_<NAME>` JSON-array escape hatch), filtering out any key currently in backoff. `getKey(envKey)` returns the first usable key, or  - when ALL keys are in backoff  - the one whose backoff expires soonest (so callers attempt rather than hard-fail). Server log emits `[acptoapi] key-rotate provider=<name> reason=<r> key-index=<i> next-index=<i+1>` on each rotation. Only after every key for a provider is exhausted does the chain fall through to the next link.

### Content policy behavior

`content_policy` (message matches `/content.?policy|safety|blocked/i`) is a first-class reason. It does NOT trip the sampler breaker by default (it is not in the per-link `fallbackOn` of built-in chains, so for those it is terminal). For chains using the default full `FALLBACK_REASONS`, a content-policy refusal advances to the next link  - useful when one provider's safety filter rejects a prompt another provider accepts. It is never silently swallowed: it lands in `chainHistory` with `reason: 'content_policy'`.

## HTTP error taxonomy (lib/errors.js)  - distinct from the chain-fallback reason enum above

This is a **different `classifyError`** from the one in `lib/chain-machine.js` documented in the section above. `chain-machine.js::classifyError(err)` maps a thrown JS error to one of the `FALLBACK_REASONS` strings used to decide chain advancement. `errors.js::classifyError(status, message, provider)` is unrelated in purpose: it maps a raw HTTP status code + message string to a typed `BridgeError` subclass, used for structured error reporting to SDK callers (not for chain routing decisions). The two do not call each other and the reason-string vocabulary (`'rate_limit'`, `'auth'`, ...) is not the same object as the error-class vocabulary (`RateLimitError`, `AuthError`, ...), though the names rhyme.

### classifyError(status, message, provider) mapping (lib/errors.js:74-84)

```js
function classifyError(status, message, provider) {
  const opts = { status, provider };
  const msg = message || '';
  if (status === 401 || status === 403) return new AuthError(msg, opts);
  if (status === 429) return new RateLimitError(msg, opts);
  if (status === 408 || /timeout/i.test(msg)) return new TimeoutError(msg, opts);
  if (status === 413 || /context.?length|token.?limit|too.?long/i.test(msg)) return new ContextWindowError(msg, opts);
  if (status === 451 || /safety|blocked|content.?policy|harmful/i.test(msg)) return new ContentPolicyError(msg, opts);
  if (typeof status === 'number' && status >= 500) return new ProviderError(msg, { ...opts, retryable: true });
  return new BridgeError(msg, { ...opts, retryable: false });
}
```

Order matters  - checks run top-to-bottom, first match wins. Message-pattern checks (`timeout`, `context.?length`, `safety`) are fallbacks for providers that don't set the matching numeric status.

### Error class shapes

All classes extend `BridgeError`, declared in both `lib/errors.js` and `index.d.ts`. Every instance carries:

- `message`  - passed through `redactKeys()` first, so API keys embedded in upstream error bodies are masked to `...<last4>` before ever reaching a log or caller.
- `status`  - the HTTP status code (or `undefined` if not status-derived).
- `code`  - optional caller-supplied code, not set by `classifyError` itself.
- `retryable`  - boolean, defaulted per-class (see table below); can be overridden via the `opts` object passed to the constructor.
- `provider`  - the provider name string passed through from the caller.
- `headers`  - optional, used by `parseRetryAfterHeader` to read a `retry-after` header off the original response.
- `name`  - set per subclass (`'AuthError'`, `'RateLimitError'`, etc.) instead of the default `'Error'`.

| Class | Trigger | `retryable` |
|-------|---------|--------------|
| `AuthError` | 401 / 403 | `false` |
| `RateLimitError` | 429 | `true` |
| `TimeoutError` | 408 or `/timeout/i` in message | `true` |
| `ContextWindowError` | 413 or `/context.?length\|token.?limit\|too.?long/i` | `false` |
| `ContentPolicyError` | 451 or `/safety\|blocked\|content.?policy\|harmful/i` | `false` |
| `ProviderError` | status >= 500 | `true` |
| `BridgeError` (fallthrough) | anything else | `false` |

`index.d.ts` (lib/errors.js:110-125) declares the same shape: `BridgeError` extends `Error` with `status`, `code`, `retryable`, `provider`, `headers` fields, and `AuthError`/`RateLimitError`/`TimeoutError`/`ContextWindowError`/`ContentPolicyError`/`ProviderError` are declared as empty subclasses (`extends BridgeError {}`)  - the distinguishing behavior (default `retryable` value, `name`) lives only in the `.js` runtime, not in the type declarations. `GeminiError` is a bare alias for `BridgeError` (`const GeminiError = BridgeError`), not a real subclass.

`isRetryable(err)` (errors.js:86) prefers `err.retryable` when `err instanceof BridgeError`; for plain (non-`BridgeError`) errors it falls back to inspecting `status`/`code` for `429`/`>=500` or matching `/quota|rate.?limit|overloaded|unavailable/i` in the message. `withRetry(fn, maxRetries=3)` (errors.js:120) is the only consumer wired to this taxonomy today  - it retries with exponential backoff (capped 16s, jittered) honoring any `Retry-After` header or Gemini-style `RetryInfo` detail parsed by `parseRetryDelay`.

### Relationship to the chain-fallback reason enum

These are separate concerns that happen to overlap in vocabulary:

- The chain-machine reason enum (`FALLBACK_REASONS`) decides whether the **chain** advances to the next link.
- The `errors.js` class taxonomy decides how an error is **reported/retried** once it reaches an SDK caller (e.g. via `withRetry`), independent of whether a multi-link chain is in play at all.
- Nothing in `lib/chain-machine.js` constructs or inspects `BridgeError` subclasses, and nothing in `lib/errors.js` reads `FALLBACK_REASONS` or calls `sampler`/`keyring`. A caller could in principle use `withRetry` around a single (non-chain) `queue/`/`chain/` model call and get both behaviors, but they are not integrated  - `classifyError` (errors.js) is not invoked anywhere inside the chain-machine fallback path today.

## Invisible fallback + live availability tracking (lib/availability.js, 2026-07-02)

### Fallback is invisible to the caller

Chain fallback never leaks its internal bookkeeping into a successful HTTP response body. `runChat`/`runStream` (lib/chain-machine.js) attach `result.__chainAttempted` (an array of `{model, ms, ok, reason}` per link tried) to the raw return value on success  - this is intentional for SDK callers (`sdk.chat`, `chain().chat`) who want programmatic visibility into which link served the response. The HTTP layer strips it before the caller sees it: `handleChat` (server.js, `/v1/chat/completions`) reads `result.__chainAttempted` for logging/the `X-Acptoapi-Served-Model` header, then `delete result.__chainAttempted` before `json(res, ...)`. `handleAnthropicMessages` (`/v1/messages`) never attaches chain metadata to a successful result at all  - it only exposes a `tried[]` array on the final 503 exhaustion error, which is diagnostic information on total failure, not a success-path leak.

**Rule for new response paths**: any handler that calls `runChat`/`runStream`/`chain().chat()` and serializes the result to an HTTP client MUST `delete result.__chainAttempted` (or otherwise strip chain internals) before sending the body. Chain metadata on success is an SDK-only contract, never an HTTP-response contract.

### Availability tracking (lib/availability.js)

Distinct from `lib/sampler.js`'s per-provider-**prefix** circuit breaker (which only answers "should we even try this provider right now"), `lib/availability.js` tracks per-**model** health with positive signal: `{model, ok, successStreak, failStreak, totalSamples, avgLatencyMs, lastSuccessTs, lastFailTs}`. Updated on every chain-link attempt in `runChat`/`runStream` (both success and failure branches), alongside the existing `sampler.markOk`/`markFailed` calls.

- `recordSuccess(model, latencyMs)`  - increments `successStreak`, resets `failStreak`, updates `avgLatencyMs` via an exponential moving average (`LATENCY_DECAY = 0.3`, newest sample weighted 30%).
- `recordFailure(model)`  - increments `failStreak`, resets `successStreak`.
- `score(model)`  - returns `0` (neutral) only for a truly unseen model (`totalSamples === 0`). **Asymmetric threshold (2026-07-02)**: failure-based penalty (`min(failStreak,10)*2`) applies as soon as `failStreak >= 1`, regardless of `totalSamples`  - a single confirmed failure is more informative than no data, so it demotes the model below neutral immediately. Success-based promotion (`min(successStreak,10)`) still requires `totalSamples >= MIN_SAMPLES_FOR_RANK` (default 2) before contributing  - one success could be luck, so a model needs a second confirming sample before it's ranked ahead of untested peers. Net: `successBonus - failPenalty - latencyPenalty`, where `successBonus` is gated by the sample threshold but `failPenalty` is not. A model with exactly one recorded failure now ranks strictly below an unseen model of the same chain; a model with exactly one recorded success still ranks equal (neutral) to an unseen model.
- `rerank(links)`  - stable sort by descending score; ties (including all-neutral) keep original order. Single-link arrays return the identical array reference (no-op).
- `MIN_SAMPLES_FOR_RANK` and `LATENCY_DECAY` are overridable via `ACPTOAPI_AVAILABILITY_MIN_SAMPLES` and `ACPTOAPI_AVAILABILITY_LATENCY_DECAY` (both `Number(process.env.X) || default` pattern, same as `model-probe-live.js`'s `PROBE_TTL_MS`).

### Dynamic chain reordering vs. matrix-block demotion

`buildAutoChain` (lib/auto-chain.js) calls `availability.rerank(sorted)` after the existing direct/ACP-tier + SWE-bench-score sort and the optional tool-capability reorder, but before the `ACPTOAPI_AUTO_CHAIN_CAP` slice  - so live-health reordering happens WITHIN each tier (direct providers still precede ACP-wrapped ones), not across them. This is a continuous score-based re-rank, not a binary demotion: a recently-failing model is never permanently removed, only sorted later, and can climb back to the front the moment it starts succeeding again. It differs from `opts.matrixSource`'s `reorderByMatrix` (chain-machine.js), which demotes `ok:false` cells to the END of the chain in one binary partition step based on a static/externally-loaded matrix, not live per-request outcomes. Disable dynamic reordering with `ACPTOAPI_DISABLE_AVAILABILITY_RANK=1`.

### Observability

`GET /v1/availability` returns `{ availability: [{model, ok, successStreak, failStreak, totalSamples, avgLatencyMs, lastSuccessTs, lastFailTs, rank}, ...] }` sorted by descending `rank`, mirroring the shape of `GET /v1/sampler/status` but at model granularity instead of provider-prefix granularity.

### Disk persistence (2026-07-02)

The exported singleton (`_singleton = createAvailabilityTracker({ persist: true })`) hydrates its Map from `~/.acptoapi/availability-cache.json` on module load and periodically flushes back to disk, so learned health data survives server restarts  - the common `bunx`/`npx` cold-start usage pattern otherwise threw away all ranking signal every run. Direct calls to `createAvailabilityTracker()` (no args) default to `persist: false`  - only the module's exported singleton persists, mirroring how most callers (`lib/auto-chain.js`, `lib/chain-machine.js`, `lib/server.js`) consume the module-level `recordSuccess`/`recordFailure`/etc. functions rather than the factory directly.

- **Save trigger**: batched write every `SAVE_EVERY_N_RECORDS = 10` `recordSuccess`/`recordFailure` calls (a plain counter, not a `setInterval`/TTL like `model-probe-live.js`'s probe cache)  - chosen because there is no natural polling cadence to hook a timer to here (recordSuccess/recordFailure fire per chain-link attempt, potentially many times per second under load), so a write-count batch bounds the worst-case data-loss window (<=9 unsaved records) without managing/unref'ing a timer.
- **`reset(model)`** also clears the on-disk file (single-model reset rewrites the file minus that model; full reset deletes the file)  - keeps `test.js`'s `av.reset()`-then-assert pattern correct even if a stale cache file exists in the environment.
- **`flush()`**  - exported alongside the other singleton functions for callers that want to force an immediate write (e.g. before graceful shutdown) instead of waiting for the batch counter.
- Env vars: `ACPTOAPI_AVAILABILITY_CACHE_PATH` (default `~/.acptoapi/availability-cache.json`), `ACPTOAPI_AVAILABILITY_PERSIST=0` (opt out of disk persistence entirely; default on).

## Configuration  - ~/.acptoapi directory + env vars

### ~/.acptoapi/ directory structure

All config files live under `~/.acptoapi/` (`os.homedir()`), each independently overridable by env var.

| File | Loader | Override env | Format |
|------|--------|-------------|--------|
| `config.json` | lib/config.js:21 | `ACPTOAPI_CONFIG` (then `THEBIRD_CONFIG` -> `~/.thebird/config.json`) | `{ "chains": { "<name>": [...] }, ... }`. Values support `${ENV_VAR}` / `$ENV_VAR` interpolation (config.js:5). Powers `chain/<name>` and `queue/<name>` backward-compat resolution. |
| `queues.json` | lib/queues.js:6 | `ACPTOAPI_QUEUES` | `{ "queues": { "<name>": ["model/a", "model/b"] } }` OR flat `{ "<name>": [...] }`. Entries may be strings or `{model, fallbackOn, timeout}` objects. |
| `chains.json` | lib/named-chains.js:40 | `ACPTOAPI_CHAINS_PATH` | `{ "<name>": ["model/a", "model/b", ...] }`  - runtime named chains, merged OVER built-ins. |
| `probe-cache.json` | lib/model-probe-live.js:20 | `ACPTOAPI_PROBE_CACHE_PATH` | `{ "<provider/model>": { ok: bool, ts: <ms> } }`  - live-probe working set, persists across reboots so cold `bunx` invocations skip warmup. |
| `acp-probe-cache.json` | lib/auto-chain.js:248 | `ACPTOAPI_ACP_PROBE_CACHE` | `{ "<daemon>": { ok, ts } }`  - ACP daemon reachability cache (24h TTL default). |
| `availability-cache.json` | lib/availability.js | `ACPTOAPI_AVAILABILITY_CACHE_PATH` | `{ "<provider/model>": {model, ok, successStreak, failStreak, totalSamples, avgLatencyMs, lastSuccessTs, lastFailTs} }`  - per-model live health tracking, persists across reboots. Opt out with `ACPTOAPI_AVAILABILITY_PERSIST=0`. |

### Resolution precedence

- **Queues** (lib/queues.js `loadAllSources`): `ACPTOAPI_QUEUES`/`queues.json` -> `extraQueueSources: [...]` per-call paths -> `~/.acptoapi/config.json` `chains` key -> in-memory `queuesMap` (last write wins). Later sources override earlier ones for the same name.
- **Named chains** (lib/named-chains.js `resolveChain`): runtime registry (`chains.json` + `ACPTOAPI_CHAINS` env JSON + `POST /v1/chains`) -> built-ins (`fast`, `cheap`, `smart`, `reasoning`, `free`, `hermes-free`, `local`). Unrecognized name falls through to the auto-chain, so any caller `model` that isn't a chain still routes.

### Environment variables

**Config paths**: `ACPTOAPI_CONFIG`, `THEBIRD_CONFIG`, `ACPTOAPI_QUEUES`, `ACPTOAPI_CHAINS` (inline JSON), `ACPTOAPI_CHAINS_PATH`, `ACPTOAPI_PROBE_CACHE_PATH`, `ACPTOAPI_ACP_PROBE_CACHE`.

**Live probe** (lib/model-probe-live.js): `ACPTOAPI_LIVE_PROBE=1` (force live chain on cold cache; per-request via `x-live-probe: 1` header), `ACPTOAPI_DISABLE_PROBE=1` (disable startup background probe), `ACPTOAPI_PROBE_CAP=N` (max models/provider, default 100), `ACPTOAPI_PROBE_CONCURRENCY=N` (in-flight probes, default 12), `ACPTOAPI_PROBE_TTL_MS=N` (default 600000 = 10min), `ACPTOAPI_PROBE_OLLAMA=1` (include local ollama), `ACPTOAPI_ACP_PROBE_TTL_MS=N` (ACP cache TTL, default 86400000 = 24h), `ACPTOAPI_PROBE_INTERVAL_MS=N` (sampler interval, default 3600000 = 1h).

**Boot probe** (lib/server.js, in the `server.listen` callback): ~5s after the server starts listening (after ACP daemon autolaunch is kicked off), a fire-and-forget `getAvailableModelsLive({force: true})` runs once so the probe cache has real data before the first user request, rather than only being populated by an explicit `?force=1` debug call or `ACPTOAPI_LIVE_PROBE=1`. It never blocks `server.listen`'s callback (not awaited, `.catch(() => {})`, timer is `.unref()`'d). `ACPTOAPI_DISABLE_BOOT_PROBE=1` skips it entirely. It also self-skips when `ACPTOAPI_DISABLE_PROBE=1` is set (existing no-network-at-boot convention, used by test.js) or when `ACPTOAPI_LIVE_PROBE=1` is already set (that flag already forces live probing per-request, so firing again here would be redundant).

**Routing**: `PROVIDER_ORDER=a,b,c` (override auto-chain priority order; only env-keyed providers appear). `ACPTOAPI_DISABLE_AVAILABILITY_RANK=1` (disable live per-model health reordering in `buildAutoChain`; see Invisible fallback + live availability tracking). `ACPTOAPI_FREE_TIER_MODE=1` (opt-in: after all other `buildAutoChain` sorting, stably move free-tier links - ollama, kilo, opencode, gemini, groq, and any `openrouter/*:free`-style model id - to the head of the chain, ahead of paid/premium links; unset is byte-identical to default ordering). `ACPTOAPI_AVAILABILITY_CACHE_PATH` (path override for the on-disk availability health cache, default `~/.acptoapi/availability-cache.json`), `ACPTOAPI_AVAILABILITY_PERSIST=0` (disable disk persistence of per-model health data; default on).

**Daemon spawn overrides** (shell strings, lib/acp-launcher.js): `KILO_ACP_CMD`, `OPENCODE_ACP_CMD`, `QWEN_CODE_ACP_CMD`, `CODEX_CLI_ACP_CMD`, `COPILOT_CLI_ACP_CMD`, `CLINE_ACP_CMD`, `HERMES_ACP_CMD`, `CURSOR_ACP_CMD`, `CODEIUM_ACP_CMD`, `ACP_CLI_CMD`. Opt out of all autolaunch with `ACPTOAPI_DISABLE_ACP_AUTOLAUNCH=1`.

**Provider keys** (lib/keyring.js  - multi-key): primary `<PROVIDER>_API_KEY`, additional `<PROVIDER>_API_KEY_1`..`_99`, JSON-array escape hatch `ACPTOAPI_KEYS_<ENVKEY>=["k1","k2"]`. See the Multi-key section above for the full provider->envKey table.

**Server**: `PORT` (default 4800; `--port` flag wins), `ACPTOAPI_API_KEY` (auth token), `OLLAMA_URL` (default `http://localhost:11434`), `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`/`AWS_REGION`/`AWS_SESSION_TOKEN` (bedrock), `ACPTOAPI_MAX_BODY_BYTES` (default `10485760` = 10MB; `readBody` throws a `413 payload_too_large` once the accumulated request body exceeds this, instead of buffering an unbounded body into memory), `ACPTOAPI_REQUIRE_AUTH_ON_BIND=1` (opt-in strict mode: if `ACPTOAPI_BIND` is set to a non-loopback address without `ACPTOAPI_API_KEY`/`AGENTAPI_API_KEY` configured, `createServer()` closes the listening socket and rejects its startup Promise instead of warn-and-continue; default behavior when unset is unchanged  - warn and start).

### How to add a custom queue / override defaults

Add a queue (no restart needed for file-based; re-read per request):
```bash
mkdir -p ~/.acptoapi
cat > ~/.acptoapi/queues.json <<'EOF'
{ "queues": { "myqueue": ["groq/llama-3.3-70b-versatile", "mistral/mistral-tiny", "kilo/openrouter/free"] } }
EOF
# then call with model: "queue/myqueue"
```

Register a runtime chain over HTTP (lives until process exit unless also persisted to chains.json):
```bash
curl -X POST http://127.0.0.1:4800/v1/chains \
  -H 'content-type: application/json' \
  -d '{"name":"mychain","links":["groq/llama-4-scout","openrouter/free"]}'
```

Override the auto-chain provider priority: `PROVIDER_ORDER=groq,nvidia,anthropic`. Override a single daemon's launch: `KILO_ACP_CMD='npx -y kilo-code-cli acp'`. Override a default model per provider: edit `PROVIDER_DEFAULTS` in `lib/provider-maps.js` (single source of truth, propagates to downstream consumers on `npm install`).

## Observability  - debug endpoints, schemas, CLI

Default base `http://127.0.0.1:4800` (set by `--port`/`PORT`). All endpoints are GET unless noted. `/health`, `/metrics`, `/`, `/demo*` and the static assets are public; everything else requires the `ACPTOAPI_API_KEY` bearer/`x-api-key` when configured.

### Endpoint reference

| Endpoint | Returns |
|----------|---------|
| `GET /health` | `{ ok: true, backends: [<prefix>, ...] }`  - list of registered ACP backend prefixes (server.js:1010). Liveness probe. |
| `GET /debug/providers` | Array `[{ name, status: 'ok'|'unreachable', latencyMs }]`  - live 2s reachability probe of each ACP daemon (server.js:1014). |
| `GET /debug/auto-chain` | `{ links: [{model, fallbackOn}], order: [<provider>...], available: [<model>...] }`  - resolved auto-chain from current env (server.js:1061). |
| `GET /debug/chains` | `{ defined: [{name, links, defaults}], recent: [<run>...] }`  - config-defined chains (from `~/.acptoapi/config.json` `chains`) + last 50 runs (server.js:1026). |
| `GET /debug/probe-live[?force=1]` | `{ models: [...], chain: [<model>...], logs: [<str>...] }`  - live-probe working set + probe activity log (server.js:1065). |
| `GET /debug/config` | Runtime config dump with provider keys REDACTED (server.js:1072). |
| `POST /debug/translate` | Test a `{from, to, provider, ...params}` triple end-to-end (server.js:1152). |
| `GET /v1/models` | OpenAI-models shape; mixes `{id, object:'model'}` and `{id:'queue/<name>', object:'queue', queue_links:[...], source}` rows (server.js:981). Dynamic  - driven by env config + ollama `/api/tags`; do NOT hardcode expected models. |
| `GET /v1/queues` | `{ queues: [{name, links: [<model>...], source}] }`  - all resolved queues across sources (server.js:982). |
| `GET /v1/chains` | `{ chains: {<name>: [<model>...]}, builtin: [...], runtime: [...] }`  - built-in + runtime named chains (server.js:1031). `POST` body `{name, links:[...]}` registers (201); `DELETE ?name=<n>` removes. |
| `GET /v1/sampler/status` | `{ status: [{provider, ok, failCount, nextCheckIn, neverProbed?}] }`  - per-provider circuit-breaker state; `nextCheckIn` is ms until the breaker re-opens (server.js:987). The route handler merges `sampler.getStatus()` (providers the sampler has actually observed via `markFailed`/`markOk`) with `getOrder().filter(hasProvider)` from `lib/auto-chain.js`  - any configured (env-keyed) provider absent from the sampler's own Map gets a synthesized `{provider, ok: null, failCount: 0, nextCheckIn: 0, neverProbed: true}` row instead of being silently omitted. This merge happens at the HTTP layer, not inside `lib/sampler.js`, specifically to avoid `sampler.js` importing `auto-chain.js` (circular dependency, same lazy-require pattern auto-chain.js itself uses for `acp-launcher.js`). Once a provider is actually dispatched to, `markFailed`/`markOk` gives it a real Map entry and `neverProbed` no longer appears for it. |
| `GET /v1/availability` | `{ availability: [{model, ok, successStreak, failStreak, totalSamples, avgLatencyMs, lastSuccessTs, lastFailTs, rank}] }`  - per-model live health tracking (lib/availability.js), sorted by descending `rank`. See "Invisible fallback + live availability tracking" above. |
| `GET /v1/runs` | `{ runs: [{ts, requestedModel, resolvedLinks, resolvedLinksWithRank, attempted, finalModel, history, state, servedBy, startedAt, finishedAt}] }`  - last 50 chain runs (server.js:1001). `resolvedLinksWithRank: [{model, availabilityRank}]` is captured alongside the flat `resolvedLinks` string array at the moment the chain is built (`lib/chain-machine.js` `snapshotAvailabilityRanks()`, called from both `runChat`/`runStream` right before `registerRun`)  - it snapshots `require('./availability').peek(model).rank` per link so a run's ordering can be correlated against the live-health score that (if `availability.rerank` reordered the chain) produced it, rather than only the post-hoc flat list. Added field, not a replacement  - existing consumers of `resolvedLinks` are unaffected. |
| `GET /v1/keyring/status` | `{ providers: [{provider, envKey, keys: [{index, key (masked 'prefix...suffix'), ok, failCount, lastFailedAt, lastReason, inBackoff, nextRetryInMs}]}] }`  - per-key health (server.js:988). |
| `GET /v1/cache/stats`, `POST /v1/cache/clear` | Response-cache stats / clear (server.js:1002). |
| `GET /v1/pretest/stats`, `POST /v1/pretest/run` | Pretest stats / run-once (server.js:1004). |
| `GET /debug/why?model=<id>` | `{ model, prefix, rest, wouldBeSelectable, blockers: [{layer: 'sampler'|'keyring', detail}], score, scored, availability, matrixNote }`  - unifies sampler backoff + keyring key availability into a single gating verdict for one model id; `score`/`availability` are informational only and never affect `wouldBeSelectable`; matrix scoring is request-scoped and not evaluated here. Requires `ACPTOAPI_API_KEY` like `/debug/config`. |

### Example curls

```bash
curl -s http://127.0.0.1:4800/health
curl -s http://127.0.0.1:4800/v1/sampler/status | jq '.status[] | select(.ok==false)'   # providers in backoff
curl -s http://127.0.0.1:4800/v1/keyring/status | jq '.providers[].keys[] | select(.inBackoff)'  # keys cooling down
curl -s http://127.0.0.1:4800/v1/runs | jq '.runs[-1] | {requestedModel, finalModel, history}'  # last run's fallback path
curl -s http://127.0.0.1:4800/debug/auto-chain | jq '.available'
curl -s http://127.0.0.1:4800/debug/probe-live?force=1 | jq '.chain'
curl -s -X POST http://127.0.0.1:4800/debug/translate -H 'content-type: application/json' \
  -d '{"from":"openai","to":"anthropic","provider":"groq","model":"groq/llama-3.3-70b-versatile","messages":[{"role":"user","content":"hi"}]}'
```

### Field interpretation

- `/v1/sampler/status` `nextCheckIn > 0` -> provider is in backoff and `preCheck` will skip it with reason `sampler_backoff` until it elapses. `ok: null` with no `neverProbed` flag means the sampler has a Map entry but hasn't recorded a definitive result yet; `ok: null` WITH `neverProbed: true` means the provider is configured (has a usable key) but has never been dispatched to at all  - distinct from "observed and currently neutral".
- `/v1/keyring/status` `nextRetryInMs > 0` (`inBackoff: true`) -> that specific key is cooling down; rotation will pick the next usable key. `lastReason` is `auth`/`rate_limit`/`upstream_5xx`.
- `/v1/runs` `history[]` entries are `{model, reason, error}`  - the exact per-link reason chain. `attempted[]` (on the thrown error / `result.__chainAttempted`) carries `{model, ms, ok, reason}` for latency forensics. `finalModel`/`servedBy` is the link that succeeded (null if exhausted). `resolvedLinksWithRank[]` entries are `{model, availabilityRank}`  - the `lib/availability.js` score for each link captured when the chain was built, for correlating fallback order against live-health ranking rather than only the static list.
- `/debug/providers` `status: 'unreachable'` means the ACP daemon at that port did not answer within 2s  - the chain still tries it but it fast-fails to the next link.

### CLI reference (bin/acptoapi.js)

- `acptoapi` (no flags)  - start the server (`--port N`, `--kilo <url>`, `--opencode <url>`).
- `acptoapi --probe`  - print env-key presence per provider (`OK`/`--` per key) and exit.
- `acptoapi --list-brands`  - list OpenAI-compat brand prefixes.
- `acptoapi --list-chains`  - list config-defined named chains (`<name>: a -> b -> c`).
- `acptoapi --update`  - clear npx/bun caches and report the latest npm version (forces fresh `bunx acptoapi@latest`).

There is no separate TUI; the demo UI is served at `GET /` (`/demo`) with static assets (`app.js`, `app-shell.css`).

@.gm/next-step.md
