# acptoapi

**Unified chain SDK + any-to-any AI protocol bridge.** acptoapi is the canonical home for LLM model resolution, chain fallback, sampler backoff, and matrix-aware scoring. Point any SDK (OpenAI, Anthropic, Gemini) at it  - requests route to any backend (Groq, Anthropic API, Gemini, Ollama, Kilo Code, opencode, AWS Bedrock, and 20+ OpenAI-compatible brands) and stream back in the wire format the client expects.

## Overview

acptoapi does three things:

1. **Model resolution**  - a `<provider>/<model>` string resolves to a concrete backend (URL, env key, provider kind). One syntax, every vendor.
2. **Chain fallback**  - comma-separated model strings or named queues are tried in priority order. Driven by an xstate v5 finite state machine; every transition is observable via `getRunHistory()`.
3. **Sampler backoff + matrix-aware scoring**  - a per-provider exponential-backoff sampler skips known-down providers before an attempt; an optional capability matrix demotes models that can't serve a given mode to the end of the chain.

It runs two ways: as a **programmatic SDK** (`require('acptoapi')`, server-free) and as an **HTTP server** (`npx acptoapi`) exposing OpenAI-, Anthropic-, and Gemini-compatible endpoints.

**Downstream consumers**  - [freddie](https://github.com/AnEntrypoint), [casey](https://github.com/AnEntrypoint), and [thebird](https://github.com/AnEntrypoint)  - depend on acptoapi as the single source of truth for resolution, chaining, sampler backoff, and matrix scoring. They pass model strings and config; they must **not** reimplement any of these locally.

## Installation

```bash
npm install acptoapi
```

Or run the server with no install:

```bash
npx acptoapi          # starts on :4800
bun x acptoapi        # same, via bun
```

Requires Node.js >= 18.

## Quick start

Set a key for at least one provider, import `chat` / `stream`, and pass a model string.

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

### 1. Single model

```js
const { chat } = require('acptoapi');

const r = await chat({
  model: 'anthropic/claude-haiku-4-5',
  messages: [{ role: 'user', content: 'Say hi in three words.' }],
});
console.log(r.choices[0].message.content);
```

The prefix (`anthropic/`, `groq/`, `ollama/`, ...) selects the backend automatically. `resolveModel('anthropic/claude-haiku-4-5')` returns `{ provider:'anthropic', model:'claude-haiku-4-5', env:'ANTHROPIC_API_KEY', prefix:'anthropic' }` if you want to inspect routing without invoking.

### 2. Comma-separated chain

A comma-separated string is dispatched as a fallback chain  - each link tried in order until one succeeds. Whitespace is tolerated.

```js
const { chat } = require('acptoapi');

const r = await chat({
  model: 'groq/llama-3.3-70b-versatile, mistral/mistral-tiny, kilo/openrouter/free',
  messages: [{ role: 'user', content: 'Say hi.' }],
  onFallback: ({ from, to, reason }) => console.log(`${from} -> ${to} (${reason})`),
});
console.log(r.choices[0].message.content);
```

If Groq 404s or rate-limits, the chain descends to Mistral, then to the free Kilo daemon. `getRunHistory()` records each attempt with its reason.

### 3. Named queue

Define a queue once in `~/.acptoapi/queues.json` (see [Configuration](#configuration)):

```json
{ "queues": { "fast": ["groq/llama-3.3-70b-versatile", "mistral/mistral-tiny"] } }
```

Then reference it by name with the `queue/` prefix:

```js
const { chat } = require('acptoapi');

const r = await chat({
  model: 'queue/fast',
  messages: [{ role: 'user', content: 'Say hi.' }],
});
console.log(r.choices[0].message.content);
```

`'chain/<name>'` is a legacy alias that reads `~/.thebird/config.json` chains  - both forms work.

### Streaming

`stream(...)` returns an async iterable of internal events. Pick the output wire format with `output: 'openai' | 'anthropic' | 'gemini' | 'events'`.

```js
const { stream } = require('acptoapi');

for await (const ev of stream({
  model: 'anthropic/claude-haiku-4-5',
  messages: [{ role: 'user', content: 'Count to five.' }],
  output: 'events',
})) {
  if (ev.type === 'text-delta') process.stdout.write(ev.textDelta);
}
```

### As a drop-in server

```bash
npx acptoapi
```

```js
import OpenAI from 'openai';
const client = new OpenAI({ baseURL: 'http://localhost:4800/v1', apiKey: 'none' });
const r = await client.chat.completions.create({
  model: 'groq/llama-3.3-70b-versatile, mistral/mistral-tiny',  // comma-chain works over HTTP too
  messages: [{ role: 'user', content: 'hi' }],
});
```

The Anthropic SDK (`baseURL: 'http://localhost:4800'`, `POST /v1/messages`) and Gemini SDK (`/v1beta/models/...`) work identically.

## Configuration

### Queue sources (resolution order)

When you reference `queue/<name>`, sources are merged in this order  - later sources win:

1. `process.env.ACPTOAPI_QUEUES` or `~/.acptoapi/queues.json`  - primary store. JSON `{ "queues": { "<name>": [...] } }` or flat `{ "<name>": [...] }`.
2. `extraQueueSources: [paths]`  - additional file paths, per-call override.
3. `~/.thebird/config.json` `chains` key  - backward compatibility.
4. `queuesMap: { "<name>": [...] }`  - in-memory injection, highest priority.

```json
// ~/.acptoapi/queues.json
{
  "queues": {
    "fast":  ["groq/llama-3.3-70b-versatile", "groq/llama-3.1-8b-instant"],
    "smart": ["anthropic/claude-sonnet-4-6", "openrouter/anthropic/claude-sonnet-4.6"],
    "free":  ["kilo/openrouter/free", "opencode/minimax-m2.5-free"]
  }
}
```

Server-level injection: `createServer({ queuesProvider: () => ({ ... }) })`  - the provider runs per-request, merged into `/v1/models` and `/v1/queues`.

### Built-in named chains

Use these names directly without any config: `fast`, `cheap`, `smart`, `reasoning`, `free`, `hermes-free`, `local`. See `lib/named-chains.js`. List the resolved links with `acptoapi --list-chains`.

### Environment variables

| Variable | Purpose | Default |
|----------|---------|---------|
| `PORT` | Server port | `4800` |
| `ANTHROPIC_API_KEY` | Anthropic direct (`anthropic/`) |  - |
| `GEMINI_API_KEY` | Google Gemini (`gemini/`) |  - |
| `GROQ_API_KEY` | Groq (`groq/`) |  - |
| `OPENAI_API_KEY` | OpenAI (`openai/`) |  - |
| `OPENROUTER_API_KEY` | OpenRouter (`openrouter/`) |  - |
| `OLLAMA_URL` | Local Ollama (`ollama/`) | `http://localhost:11434` |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_REGION` | Bedrock (`bedrock/`) | region `us-east-1` |
| `PROVIDER_ORDER` | Comma-separated auto-chain priority | see below |
| `ACPTOAPI_QUEUES` | Override default queues file path | `~/.acptoapi/queues.json` |
| `ACPTOAPI_API_KEY` | Optional bearer auth for the server |  - (open) |

Run `npx acptoapi --probe` to print which provider env vars are currently set, and `npx acptoapi --list-brands` for all 20+ supported OpenAI-compatible brand prefixes.

**Multi-key per provider:** every `*_API_KEY` accepts extras as `GROQ_API_KEY_1` ... `GROQ_API_KEY_99` (or `ACPTOAPI_KEYS_GROQ_API_KEY=["k1","k2"]`). Keys rotate automatically on `auth`/`rate_limit` before the chain falls through. Inspect via `GET /v1/keyring/status`.

**Auto-chain** (`model: 'auto'`): default provider priority is
`anthropic, openrouter, groq, nvidia, cerebras, sambanova, mistral, codestral, qwen, zai, cloudflare, gemini, ollama, kilo, opencode, ...`.
Only providers with a present env key appear. Override with `PROVIDER_ORDER`. Inspect the resolved chain at `GET /debug/auto-chain`.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| **401 / 403** (`AuthError`) | Missing or invalid provider key | Run `npx acptoapi --probe` to confirm the env var is set. Check the key prefix at `GET /v1/keyring/status`. The key is auto-marked `auth`-failed and the next key (or chain link) is tried. |
| **429** (`RateLimitError`) | Provider rate limit hit | The sampler marks the provider down with exponential backoff (`30s -> 60s -> 2m -> 4m -> 8m`) and skips it on the next attempt (reason `sampler_backoff`). Add a fallback link or a second key. Inspect via `GET /v1/sampler/status`. |
| **Timeout** | Slow/unreachable upstream | Set a per-link `timeout` and a fallback link  - the chain advances on `reason:'timeout'`. Example: `chain([{ model:'anthropic/...', timeout:5000 }, 'groq/...'])`. |
| `Failed to parse URL from undefined` | Stale acptoapi version | Upgrade  - the `from:'openai'` carrier-strip bug for brand-prefix single-shots was fixed in 1.0.57. |
| Chain exhausted | Every link failed | The thrown error carries `err.chainHistory` and `err.attempted`  - read them, or call `getRunHistory()` for the full per-attempt trace. |
| `queue not found or empty: <name>` | Queue name missing from all sources | Check `~/.acptoapi/queues.json` and `GET /v1/queues` (lists every resolved queue and its source). |

`GET /debug/chains` returns defined chains plus the last 50 runs (state, links tried, reasons)  - the fastest way to see what the FSM actually did.

## CLI / TUI

### Server CLI (`acptoapi`)

```bash
npx acptoapi                      # start server on :4800
npx acptoapi --port 8080          # custom port
PORT=4000 node bin/acptoapi.js    # run straight from a repo checkout (no install)
npx acptoapi --kilo <url> --opencode <url>
npx acptoapi --probe              # show which provider env vars are set
npx acptoapi --list-brands        # list OpenAI-compatible brand prefixes
npx acptoapi --list-chains        # list named chains and their resolved links
npx acptoapi --update             # clear npx/bun caches, report latest npm version
```

### TUI / control CLI (`acptoapi-tui`)

Atomic JSON-to-stdout subcommands (agent-friendly) plus an interactive multi-pane mode. Targets a running server at `ACPTOAPI_URL` (default `http://localhost:4800`).

```bash
npx acptoapi-tui status           # merged server health + key counts
npx acptoapi-tui chains [list|get N|add N L...|del N]
npx acptoapi-tui queues [list|get N|add N L...|del N]
npx acptoapi-tui models           # working models from live probe
npx acptoapi-tui sampler          # provider availability + backoff
npx acptoapi-tui runs             # recent chain run history
npx acptoapi-tui providers        # ACP daemon health
npx acptoapi-tui auto-chain       # resolved fallback order
npx acptoapi-tui tui              # interactive multi-pane TUI
```

## HTTP endpoints (summary)

| Endpoint | Purpose |
|----------|---------|
| `POST /v1/chat/completions` | OpenAI Chat Completions (streaming + non-streaming) |
| `POST /v1/messages` | Anthropic Messages drop-in, any backend |
| `POST /v1beta/models/:model:generateContent` | Gemini drop-in (also `:streamGenerateContent`) |
| `POST /v1/embeddings` | OpenAI-format embeddings, prefix-routed |
| `GET /v1/models` | Live-probed model + `queue/<name>` rows |
| `GET /v1/queues` | Defined queues with links and source |
| `GET /v1/sampler/status` | Per-provider availability + backoff |
| `GET /v1/runs` | `GET /debug/chains` | Chain run history |
| `GET /debug/auto-chain` | Resolved auto-fallback chain |
| `GET /v1/keyring/status` | Per-provider key health (masked) |
| `GET /health` | `GET /metrics` | Liveness + Prometheus metrics |

Optional bearer auth: set `ACPTOAPI_API_KEY=<secret>`; clients send `Authorization: Bearer <secret>` (or `x-api-key`). `/health`, `/metrics`, `/debug/*`, and demo assets stay public.

## Model prefixes

| prefix | backend | key |
|--------|---------|-----|
| `anthropic/` | Anthropic API direct | `ANTHROPIC_API_KEY` |
| `gemini/` | Google Gemini | `GEMINI_API_KEY` |
| `ollama/` | Local Ollama | `OLLAMA_URL` (no key) |
| `bedrock/` | AWS Bedrock Converse | AWS creds |
| `kilo/` | `opencode/` | ACP daemons (free) | none (auto-spawned) |
| `groq/` `openrouter/` `nvidia/` `cerebras/` `sambanova/` `mistral/` `codestral/` `qwen/` `zai/` `cloudflare/` `together/` `deepseek/` `xai/` `perplexity/` `fireworks/` `opencode-zen/` `openai/` | OpenAI-compatible brand passthrough | `<BRAND>_API_KEY` (Cloudflare also needs `CLOUDFLARE_ACCOUNT_ID`) |

Bare model IDs (no prefix) route to kilo.

## API documentation

Full technical reference  - model-string syntax, chain semantics, inspection helpers (`peekNext`, `peekStatus`, `getRunHistory`), the `translate()` pipeline, the eight formats and providers, ACP daemon launcher, multi-key keyring, and the xstate chain machine  - lives in **[AGENTS.md](./AGENTS.md)**.

## License

MIT
