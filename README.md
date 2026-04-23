# acptoapi

OpenAI-compatible HTTP facade over ACP (Kilo Code + opencode). Point any OpenAI SDK at it, get Kilo/opencode routing transparently.

## Quickstart

```bash
# 1. Start ACP backend (one or both)
kilo serve --port 4780
opencode serve --port 4790

# 2. Start acptoapi
npx acptoapi                    # defaults: :4800, kilo :4780, opencode :4790
npx acptoapi --port 8080        # custom port

# 3. Point any OpenAI SDK at http://localhost:4800/v1
#    Or open http://localhost:4800/ for the built-in live-streaming demo
```

## Demo

- **Built-in**: `http://localhost:4800/` when acptoapi is running (no CORS, full streaming)
- **GH Pages**: https://anentrypoint.github.io/acptoapi (browser-blocked from loopback by Chrome PNA — use built-in demo instead)

## Usage

```js
import OpenAI from 'openai';
const client = new OpenAI({ baseURL: 'http://localhost:4800/v1', apiKey: 'none' });

const stream = await client.chat.completions.create({
  model: 'kilo/x-ai/grok-code-fast-1:optimized:free',
  messages: [{ role: 'user', content: 'hi' }],
  stream: true,
});
for await (const chunk of stream) process.stdout.write(chunk.choices[0]?.delta?.content || '');
```

## Model selection

Model IDs: `<backend>/<model>` where `<backend>` ∈ `{kilo, opencode}`.

Examples:
- `kilo/x-ai/grok-code-fast-1:optimized:free` (free, default)
- `kilo/kilo-auto/free`
- `opencode/minimax-m2.5-free`

Bare model IDs (no prefix) route to kilo.

## Endpoints

- `POST /v1/chat/completions` — streaming + non-streaming
- `GET /v1/models` — live-probes both backends
- `GET /health`

## Why

ACP (Kilo/opencode HTTP `serve` mode) has a custom protocol: `POST /session`, `POST /session/:id/message`, SSE `/event`. Using it from standard OpenAI-SDK code requires rewriting clients. acptoapi maps:

- OpenAI `messages[]` → ACP text part
- ACP `message.part.delta` → OpenAI `delta.content` / `delta.reasoning_content` (tracked via partID → part.type lookup)
- ACP `tool` part state → OpenAI `tool_calls`
- ACP `session.idle` / `session.turn.close` → `finish_reason: stop`

Streaming uses ACP's true-delta SSE (not accumulating snapshots) for minimum per-token latency.

## Config

CLI flags or env:
- `--port` / `PORT` (4800)
- `--kilo <url>` / `ACP_KILO_URL` (`http://localhost:4780`)
- `--opencode <url>` / `ACP_OPENCODE_URL` (`http://localhost:4790`)

## License

MIT
