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
