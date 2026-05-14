# AGENTS.md — agentapi

Non-obvious technical caveats for agents working on this repo.

## Public API — unified chain SDK (since 1.0.57)

acptoapi is the canonical home for LLM model resolution, chain fallback, sampler backoff, and matrix-aware scoring. **Downstream consumers (freddie, thebird, etc.) must NOT reimplement these locally.** The SDK delegates everything; consumers pass model strings and config.

### Model string syntax

`api.chat({ model, messages, ... })` accepts three forms:

1. **Single model id** — `'groq/llama-3.3-70b-versatile'`, `'anthropic/claude-haiku-4-5'`, `'ollama/llama3.2'`. Resolved via `resolveModel(model)`.
2. **Comma-separated chain** — `'groq/llama-3.3-70b-versatile, mistral/mistral-tiny, claude-cli/haiku'`. Whitespace tolerated. Dispatched as `chain([...])`.
3. **`queue/<name>`** — named queue from `~/.acptoapi/queues.json` (default) or injected sources. Resolved via `resolveQueue({name, queuesMap?, configPath?, extraQueueSources?})`.

Also: `'chain/<name>'` — legacy alias of `queue/`, reads `~/.thebird/config.json` chains. Both supported.

### Queue sources (in resolution order)

1. `process.env.ACPTOAPI_QUEUES` or `~/.acptoapi/queues.json` — primary store. JSON `{queues: {<name>: [<model>, ...]}}` or flat `{<name>: [...]}`.
2. `extraQueueSources: [...]` opt — additional file paths. Per-call override.
3. `~/.thebird/config.json` `chains` key — backward compat.
4. `queuesMap` opt — in-memory `{<name>: [...]}` merged last (highest priority).

Server-level injection: `createServer({queuesProvider: () => ({...})})` — provider function called per-request, merged into `/v1/models` queue rows and `/v1/queues`.

### Chain semantics

`api.chat({model: 'a,b,c', messages, onFallback})`:
- Each link tried in order.
- Before invocation, `sampler.isAvailable(prefix)` consulted — if backoff-blocked, link is skipped without an attempt (reason `sampler_backoff`).
- If `opts.matrixSource` is set (file path, URL, or function returning `{providers: [{id, models: [{id, usable_in_any_mode, modes}]}]}`), cells with `ok:false` for any mode are demoted to the END of the chain. `matrix_block` reason if encountered.
- On link failure (`error`/`rate_limit`/`timeout`/`empty`/`content_policy`), `onFallback({from, to, reason, error})` fires, chain advances.
- **`sampler.markFailed(prefix)` is NOT called when the next link shares the same prefix** — preserves "bad model id, try sibling" without triggering full provider backoff.
- On exhaustion, throws with `err.chainHistory` and `err.attempted` populated.

### Inspection helpers

- `chain([...]).peekNext(n)` — returns next-N candidates `[{index, model, prefix, fallbackOn, blocked, reason}]` after sampler+matrix filtering. For dashboard "next-up" UI.
- `sampler.peekStatus(provider)` — `{available, lastFailedAt, nextRetryAt, failCount}`.
- `getRunHistory()` — per-invocation entries `{ts, requestedModel, resolvedLinks, attempted, finalModel, history, ...}`.
- `listAllModelsAndQueues({matrixSource, queueSources, queuesMap})` — OpenAI-models-shape rows mixing `{id, object:'model'}` and `{id:'queue/<name>', object:'queue', links}`.

### HTTP surface

- `GET /v1/models` — includes `{id: 'queue/<name>', object: 'queue', queue_links: [...], source}` rows.
- `GET /v1/queues` — `{queues: [{name, links, source}]}`.
- `GET /v1/sampler/status` — `{status: [{provider, ok, failCount, nextCheckIn}]}`.
- `GET /v1/runs` — `{runs: [...]}` — chain run history.

### openai-compat fix

`api.chat({model: 'groq/...'})` (or any brand-prefix model id) now works in single-shot — previously the `from:'openai'` path stripped the `{url, apiKey, body}` carrier in `buildParams`. The fix conditionally drops `from` when `provider === 'openai-compat'`. If you see `Failed to parse URL from undefined`, you've imported an older acptoapi.

## Claude Code CLI non-interactive streaming (for facade/bridge work)

Invocation: `claude -p "<prompt>" --output-format stream-json --verbose --include-partial-messages --model <alias>`.

- `--verbose` is REQUIRED alongside `--output-format stream-json` or the CLI refuses.
- Without `--include-partial-messages` you only get `assistant` and `result` summary events — no token-level deltas. With it, raw Anthropic API `stream_event` entries (message_start, content_block_start, content_block_delta, content_block_stop, message_delta, message_stop) are emitted.
- The CLI writes a stderr WARNING `no stdin data received in 3s, proceeding without it` when nothing is piped. Harmless. Suppress by redirecting stdin (`< NUL` on Windows, `< /dev/null` on Unix), or by using `--input-format stream-json` (then stdin is the real input channel and the warning does not appear).
- `--fallback-model` only works together with `--print`.
- Disable all tools with `--tools ""` (empty string), or whitelist with `--tools "Bash,Edit,..."`.

NDJSON event types on stdout:
- `system` (subtype: `init`, `hook_started`, `hook_response`, `status`)
- `stream_event` — wraps raw Anthropic deltas; only present with `--include-partial-messages`
- `assistant` — full assembled message per content block; DUPLICATES the content already seen in `stream_event`s. Do not double-count.
- `user` — synthetic turn carrying `tool_result` blocks during the agentic loop
- `rate_limit_event`
- `result` (subtype: `success` | `error`) — terminal, has `result` text, `stop_reason`, `usage`, `total_cost_usd`, `num_turns`, `duration_ms`

Content block delta shapes inside `stream_event.event.delta`:
- `text_delta` with `.text` → user-visible tokens
- `input_json_delta` with `.partial_json` → tool-call arguments streamed char-by-char; must be concatenated across deltas for the same `content_block.index` before JSON.parse

`content_block_start` carries either `content_block.type:"text"` or `content_block.type:"tool_use"` (with `id`, `name`, `input:{}`). `message_delta.delta.stop_reason` ∈ `end_turn | tool_use | max_tokens | stop_sequence`.

Claude Code runs tools itself during `-p` (agentic). A single run's stream may interleave multiple assistant messages with tool_use/tool_result turns. To preserve fidelity in an OpenAI-compat facade: map `text_delta` → `delta.content`, `tool_use` (+ accumulated `input_json_delta`) → `delta.tool_calls`, and surface `tool_result`-bearing user events (otherwise they are silently dropped and the client loses context of what the agent did).

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
- POST /v1/messages — Anthropic SDK target
- POST /v1beta/models/:model:streamGenerateContent — Gemini streaming
- POST /v1beta/models/:model:generateContent — Gemini non-streaming
- GET /v1beta/models — Gemini model list

**Observability:**
- GET /debug/providers — List configured providers
- GET /debug/config — Runtime config dump
- POST /debug/translate — Test translate(from, to, provider)

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

## ACP Daemons — Kilo, Opencode, Gemini CLI, Qwen Code, Codex CLI, Copilot CLI, Cline (lib/acp-launcher.js)

acptoapi spawns and manages ACP (Agent Client Protocol) daemons — local agent processes that listen on defined ports and communicate via JSON-RPC over stdio. Seven daemons are auto-launched on boot via `ensureRunning()`:

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

- **Gemini CLI** (port 4810, `gemini-cli/gemini-2.0-flash`)
  - Official: https://github.com/google/gemini-cli
  - Auto-spawn attempts: bare `gemini`, `gemini acp`, `npx gemini-cli`, `bunx gemini-cli`
  - Override with `GEMINI_CLI_ACP_CMD=<shell-string>` (e.g., `GEMINI_CLI_ACP_CMD=~/go/bin/gemini serve`)
  - Requires: `GEMINI_API_KEY` env var for upstream calls

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

- `registerBackend()` — adds to `BACKENDS` global, updates `splitModel()` regex
- `registerDaemon()` — adds to `CMDS` global, enrolled in `ensureRunning()` boot sequence
- New backends automatically appear in `GET /debug/providers` and chain fallback rankings

### Health Check

`GET /health` returns `{ backends: { kilo, opencode, gemini-cli, qwen-code, codex-cli, ... } }` showing daemon status (up/down per port).

## Auto-Fallback Chain (lib/auto-chain.js)

`buildAutoChain(targetModel?)` auto-detects available providers from env and returns a priority-ordered array of chain links.

### Provider Detection

- Brand providers (groq, nvidia, cerebras, etc.): checked via `isBrand()` + env key presence in `lib/openai-brands.js`
- Built-in providers: `anthropic` → `ANTHROPIC_API_KEY`, `gemini` → `GEMINI_API_KEY`, `ollama` → always available (no key required)
- ACP daemons: `kilo`, `opencode`, `gemini-cli`, `qwen-code`, `codex-cli`, `copilot-cli`, `cline` → always available (auto-spawned on boot if not running)

### Priority Order

Default: `anthropic, openrouter, groq, nvidia, cerebras, sambanova, mistral, codestral, qwen, zai, cloudflare, gemini, opencode-zen, ollama, kilo, opencode, gemini-cli, qwen-code, codex-cli, copilot-cli, cline, claude`

- Direct API providers (anthropic, gemini) come first by priority
- Brand providers (groq, nvidia, etc.) ranked by `PROVIDER_ORDER` env if set
- ACP daemons (kilo, opencode, gemini-cli, qwen-code, codex-cli, copilot-cli, cline) come before `claude` CLI fallback
- `claude` (local CLI) is always last

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

Cloudflare URL is dynamic: `https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1/chat/completions` — `CLOUDFLARE_ACCOUNT_ID` is required alongside `CLOUDFLARE_API_KEY`.

## Brand Routing (HTTP Passthrough Pattern)

OpenAI-compatible brand prefixes (groq, openrouter, together, deepseek, xai, cerebras, perplexity, mistral, fireworks, openai) route via **HTTP passthrough**, not through the `translate()` pipeline.

### Why Passthrough, Not translate()

Mapping raw request bodies through `translate()` requires converting to canonical format via `toParams()`, which expects well-formed OpenAI-compat parameters. Brand requests may send raw/vendor-specific bodies that don't fit. Passthrough is simpler and correct: fetch upstream, stream response bytes unchanged.

### Implementation

- **Dispatch table**: `lib/openai-brands.js` maps prefix → vendor URL + env key
- **Detection**: `splitBrandModel(model)` regex `/^([a-z0-9-]+)\/(.+)$/` extracts prefix and model name; `isBrand(prefix)` validates
- **Handling**: `lib/server.js` `handleBrandChat()` fetches upstream, streams body through unchanged
- **API coverage**: Applies to chat, embeddings (`POST /v1/embeddings`), and token counting (`POST /v1/messages/count_tokens` — heuristic: length / 4)
- **Function URLs**: `getBrand(prefix)` resolves function-valued URLs at call time (e.g., Cloudflare dynamic account URL)

## Testing: No Mocks, Only Real Backends

agentapi forbids mocks anywhere in tests. This includes:
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

**Symptom**: "Try it live" button disappears—mint text on mint background. Witness via `getComputedStyle(element).color` on docs server.

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
- **Run history**: `getRunHistory()` subscribes to actor snapshots and returns the last 50 runs. This is NOT a log file or array — it's a live stream of FSM state transitions.
- **Fallback reasons**: Canonical set is `['error', 'timeout', 'rate_limit', 'empty', 'content_policy']`. Default `fallbackOn = ['error']` means other reasons are terminal.
- **SDK integration**: `chat`/`stream` methods in `lib/sdk.js` early-branch on `model: 'chain/<name>'` and delegate to `lib/chain.js`. Old `streamChain`/`chatChain` now wrap the chain builder.
- **Config-driven chains**: Named chains (e.g., `chain('fallback-to-gemini')`) resolve links via `loadConfig().chains`. `--list-chains` CLI flag and `GET /debug/chains` enumerate defined and recent chains.
- **Why xstate not floosie**: `floosie` was evaluated and rejected because it is pure ESM (CJS friction) with 5 heavy transitive deps. xstate FSM alone provides deterministic state transitions and event handling without the ESM/CJS wrap/unwrap dance. Unused `flowie` dep was removed in the same commit.

## Test Launcher (nim directory)

Persistent test server at c:\dev\nim (copy of .env, start.bat launcher script):

- **start.bat**: Loads .env (provider keys), sets AGENTAPI_API_KEY=theultimateflex and PORT=4900, runs `node c:\dev\acptoapi\bin\agentapi.js`.
- **Probe pattern** (run from c:\dev\test): Set ANTHROPIC_BASE_URL=http://127.0.0.1:4900, ANTHROPIC_AUTH_TOKEN=theultimateflex, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1, then invoke `claude -p "<prompt>" --output-format stream-json --verbose --include-partial-messages --debug`.
- **Auto-chain routing**: Bare `claude-*` model names from CLI route through auto-chain (first link defaults to groq/llama-3.3-70b-versatile with current .env keys).
- **Health check**: `curl http://127.0.0.1:4900/health` returns 200 with backends list. Confirms server is up.
- **Daemon launch**: Do NOT use `nohup cmd //c start.bat &` from bash — leaves a dead shell. Instead use Node `spawn({ detached: true, stdio: ['ignore', fileHandle, fileHandle] })` for a real persistent daemon.

## model-resolver.js + dynamic defaults (2026-05-12)

`lib/model-resolver.js` resolves a `<provider>/<model>` string to `{provider, model, env, url}`. `PROVIDER_KEYS` (env var per provider) and `PROVIDER_DEFAULTS` (default model per provider) are exported from `lib/provider-maps.js` and re-exported from `acptoapi` root. Freddie consumes both via `createRequire(import.meta.url)` in `src/agent/llm_resolver.js` — single source of truth for the 17 supported providers (anthropic, openai, groq, google, mistral, cerebras, nvidia, openrouter, sambanova, codestral, zai, qwen, cloudflare, opencode, kilo, claude-cli, ollama).

Default model selection: if caller passes only `provider`, resolver fills in `PROVIDER_DEFAULTS[provider]`. Updates to the defaults table land in this repo, propagate to freddie on next `npm install` (or `node scripts/sync-upstream.mjs`).

## kilo protocol notes (2026-05-12)

Kilo + opencode ACP daemons speak the same protocol (SSE event stream + REST session/message). Required ordering: open `GET /event` SSE BEFORE `POST /session/<id>/message` or events drop. Terminate on `session.idle`. Surfaces only assembled content (no tool_calls back to caller). Implementations in consumers (e.g., freddie `src/agent/llm_resolver.js::acpChat`) must mirror this ordering.

## Live model probe (2026-05-13)

`lib/model-probe-live.js` enumerates each configured provider's `/models` endpoint, chat-probes up to `ACPTOAPI_PROBE_CAP` (default 100) models per provider with a 1-token request, and caches the working set sorted by latency. `handleAnthropicMessages` auto-uses this chain whenever `isFresh()` is true; otherwise it kicks off the probe in the background and uses the static `buildAutoChain` for the current request.

Knobs:
- `ACPTOAPI_LIVE_PROBE=1` — force live chain even on cold cache (per-request via header `x-live-probe: 1`).
- `ACPTOAPI_DISABLE_PROBE=1` — disable startup background probe entirely.
- `ACPTOAPI_PROBE_CAP=N` — max models per provider (default 100).
- `ACPTOAPI_PROBE_CONCURRENCY=N` — bounded in-flight chat-probes (default 12).
- `ACPTOAPI_PROBE_TTL_MS=N` — in-memory and on-disk TTL (default 10min).
- `ACPTOAPI_PROBE_CACHE_PATH=<file>` — defaults to `~/.acptoapi/probe-cache.json`; persists across reboots so cold `bunx` invocations skip the 30–60s warmup.
- `ACPTOAPI_PROBE_OLLAMA=1` — include local ollama in the probe even without `OLLAMA_URL` set.

Probe covers brand providers (groq, openrouter, …) plus anthropic, gemini, ollama when their env keys are present. Each model gets one billable token charged on first probe (and once per TTL window). Disable with `ACPTOAPI_DISABLE_PROBE=1` if cost is a concern.

Endpoints:
- `GET /debug/probe-live[?force=1]` — list working models, the chain, and probe activity log.
- `GET /v1/chains` — list built-in + runtime named chains with their resolved links.
- `POST /v1/chains` body `{name, links: [...]}` — register a runtime chain.
- `DELETE /v1/chains?name=<name>` — remove a runtime chain.

## Named chain selection (2026-05-13)

Caller sends `model: <chain-name>` in `/v1/messages` (or `/v1/chat/completions`). Resolution order: runtime registry (`~/.acptoapi/chains.json` + `ACPTOAPI_CHAINS` env JSON + `POST /v1/chains`) → built-in (`fast`, `cheap`, `smart`, `reasoning`, `free`, `local`). Unrecognized name falls through to default auto-chain so any caller-supplied model that isn't a chain still works.

Built-ins in `lib/named-chains.js`:
- `fast` — groq llama 3.3-70b → groq 3.1-8b → cerebras 3.3-70b
- `cheap` — openrouter gemini flash-lite → groq 3.1-8b → mistral-tiny
- `smart` — anthropic sonnet-4-6 → openrouter claude-sonnet-4.6 → mistral-large
- `reasoning` — openrouter deepseek-v4-pro → sambanova DeepSeek-V3.2 → nvidia nemotron-3-nano-reasoning
- `free` — openrouter gemini flash-lite → kilo/openrouter free → opencode/minimax free
- `local` — ollama llama3.2 → kilo/openrouter free → opencode/minimax free

## ACP auto-launch (2026-05-13)

`lib/acp-launcher.js` probes `:4780` (kilo) and `:4790` (opencode) at server boot. If down, tries an ordered list of spawn commands per daemon: bare binary, subcommand, npx, bunx. Override the entire attempt list with `KILO_ACP_CMD=…` / `OPENCODE_ACP_CMD=…` (shell string). `ACPTOAPI_DISABLE_ACP_AUTOLAUNCH=1` opts out.

Each attempt is given 600ms to fail-fast (ENOENT, immediate exit) before moving to the next. The chain treats kilo + opencode as the second-to-last fallback before the claude CLI. If both daemons fail to launch, the chain still tries the links — they just return "fetch failed" quickly and fall through.

## Default fallback order (2026-05-13)

`lib/auto-chain.js` DEFAULT_ORDER = `anthropic, openrouter, groq, nvidia, cerebras, sambanova, mistral, codestral, qwen, zai, cloudflare, gemini, opencode-zen, ollama, kilo, opencode, claude`. `claude` (CLI) is always last. `kilo`/`opencode` (ACP daemons) come before `claude`. Direct API providers fill the head of the chain in priority order (env-key presence required). Override the whole order with `PROVIDER_ORDER=a,b,c`.
