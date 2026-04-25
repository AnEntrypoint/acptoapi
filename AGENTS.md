# AGENTS.md — acp2openai

Non-obvious technical caveats for agents working on this repo.

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

## Brand Routing (HTTP Passthrough Pattern)

OpenAI-compatible brand prefixes (groq, openrouter, together, deepseek, xai, cerebras, perplexity, mistral, fireworks, openai) route via **HTTP passthrough**, not through the `translate()` pipeline.

### Why Passthrough, Not translate()

Mapping raw request bodies through `translate()` requires converting to canonical format via `toParams()`, which expects well-formed OpenAI-compat parameters. Brand requests may send raw/vendor-specific bodies that don't fit. Passthrough is simpler and correct: fetch upstream, stream response bytes unchanged.

### Implementation

- **Dispatch table**: `lib/openai-brands.js` maps prefix → vendor URL + env key
- **Detection**: `splitBrandModel(model)` regex `/^([a-z0-9-]+)\/(.+)$/` extracts prefix and model name; `isBrand(prefix)` validates
- **Handling**: `lib/server.js` `handleBrandChat()` fetches upstream, streams body through unchanged
- **API coverage**: Applies to chat, embeddings (`POST /v1/embeddings`), and token counting (`POST /v1/messages/count_tokens` — heuristic: length / 4)

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

**Symptom**: "Try it live" button disappears—mint text on mint background. Witness via `getComputedStyle(element).color` on docs server.

**Fix**: Scope the descendant anchor rule with `:not()` pseudo-class to exclude button components:
```css
.app-main a:not(.btn):not(.btn-primary):not(.btn-ghost) {
  color: var(--panel-accent);
}
```

**Root cause**: CSS variable definitions (e.g., `--panel-accent-fg = #0B0B09`) were correct; the problem was selector specificity, not variable resolution. Specificity arithmetic: `.app-main a` = 0,1,2 (class + element) vs `.btn-primary` = 0,1,0 (single class), so descendant wins.
