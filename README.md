# acptoapi

Any-to-any AI protocol bridge. Point any SDK (OpenAI, Anthropic, Gemini) at it — requests route to any backend (Kilo Code, opencode, Claude CLI, Anthropic API, Gemini, Ollama, AWS Bedrock) and stream back in the wire format the client expects.

## Quickstart

```bash
npx acptoapi                    # defaults: :4800, kilo :4780, opencode :4790
npx acptoapi --port 8080        # custom port
```

Then point any AI SDK at `http://localhost:4800`.

## Demo

- **Built-in**: `http://localhost:4800/` when acptoapi is running (no CORS, full streaming)
- **GH Pages**: https://anentrypoint.github.io/acptoapi (browser-blocked from loopback by Chrome PNA — use built-in demo instead)

## Usage

### OpenAI SDK (any backend)

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

### Anthropic SDK (any backend)

```js
import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic({ baseURL: 'http://localhost:4800', apiKey: 'none' });

const stream = await client.messages.create({
  model: 'gemini-2.0-flash',
  messages: [{ role: 'user', content: 'hi' }],
  max_tokens: 1024,
  stream: true,
});
for await (const ev of stream) { /* standard Anthropic SDK events */ }
```

### Gemini SDK (any backend)

```js
import { GoogleGenerativeAI } from '@google/generative-ai';
const genai = new GoogleGenerativeAI({ baseUrl: 'http://localhost:4800' });
const model = genai.getGenerativeModel({ model: 'kilo/kilo-auto/free' });
const result = await model.generateContentStream('hi');
```

## Model prefixes

| prefix | backend | notes |
|--------|---------|-------|
| `kilo/` | Kilo Code ACP | free models available |
| `opencode/` | opencode ACP | free models available |
| `claude/` | Claude Code CLI | local OAuth, no API key needed |
| `anthropic/` | Anthropic API direct | requires `ANTHROPIC_API_KEY` |
| `gemini/` | Google Gemini API | requires `GEMINI_API_KEY` |
| `ollama/` | Local Ollama | requires Ollama running at `OLLAMA_URL` |
| `bedrock/` | AWS Bedrock Converse | requires AWS credentials |

Bare model IDs (no prefix) route to kilo.

### Example model IDs

- `kilo/x-ai/grok-code-fast-1:optimized:free` — free, default
- `kilo/kilo-auto/free`
- `opencode/minimax-m2.5-free`
- `claude/sonnet`, `claude/haiku`, `claude/opus`
- `anthropic/claude-sonnet-4-6`
- `gemini/gemini-2.0-flash`, `gemini/gemini-2.5-pro`
- `ollama/llama3.2:latest` (any locally pulled model)
- `bedrock/anthropic.claude-3-5-sonnet-20241022-v2:0`

## Endpoints

### OpenAI-compatible

- `POST /v1/chat/completions` — streaming + non-streaming
- `GET /v1/models` — live-probed list across all backends

### Anthropic-compatible

- `POST /v1/messages` — Anthropic Messages API drop-in, any backend

### Gemini-compatible

- `POST /v1beta/models/:model:streamGenerateContent` — Gemini streaming API drop-in
- `POST /v1beta/models/:model:generateContent` — Gemini non-streaming
- `GET /v1beta/models` — model list in Gemini format

### Observability

- `GET /debug/providers` — live probe all backends with latency
- `GET /debug/config` — active config (secrets redacted)
- `POST /debug/translate` — echo internal event stream for any `{from,to,provider,...}` request
- `GET /health`

## Programmatic translate API

```js
const { translate, buffer } = require('acptoapi/lib/translate');

// Stream any format through any provider, get any format back
for await (const ev of translate({ from: 'openai', to: 'anthropic', provider: 'gemini', model: 'gemini-2.0-flash', messages: [...] })) {
  if (ev.type === 'sse') process.stdout.write(ev.raw);
}

// Buffer to response object
const response = await buffer({ from: 'anthropic', to: 'openai', provider: 'ollama', model: 'llama3.2', messages: [...] });
```

Supported `from`/`to` formats: `anthropic`, `openai`, `gemini`, `acp`, `mistral`, `cohere`, `ollama`, `bedrock`

Supported `provider` values: `gemini`, `openai-compat`, `acp`, `cloud`, `router`, `anthropic`, `ollama`, `bedrock`

## Internal event model

All formats convert through a common event stream:

| event type | fields | maps from |
|-----------|--------|-----------|
| `start-step` | — | message start |
| `text-delta` | `textDelta` | token |
| `reasoning-delta` | `reasoningDelta` | thinking / reasoning_content |
| `tool-call` | `toolCallId`, `toolName`, `args` | function call |
| `tool-result` | `toolCallId`, `toolName`, `result` | tool output |
| `finish-step` | `finishReason` | stop / tool-calls / error |
| `error` | `error` | stream error |

## Config

CLI flags or env:

| flag | env | default |
|------|-----|---------|
| `--port` | `PORT` | `4800` |
| `--kilo <url>` | `ACP_KILO_URL` | `http://localhost:4780` |
| `--opencode <url>` | `ACP_OPENCODE_URL` | `http://localhost:4790` |
| `--claude-bin <path>` | `CLAUDE_BIN` | `claude` |
| — | `ANTHROPIC_API_KEY` | — |
| — | `GEMINI_API_KEY` | — |
| — | `OLLAMA_URL` | `http://localhost:11434` |
| — | `AWS_ACCESS_KEY_ID` | — |
| — | `AWS_SECRET_ACCESS_KEY` | — |
| — | `AWS_REGION` | `us-east-1` |
| — | `AWS_SESSION_TOKEN` | — |

## Why

The AI provider landscape is fragmented: each has its own wire protocol, streaming format, and auth scheme. acptoapi normalises all of them through a shared internal event model — any input wire format → internal events → any output wire format → any provider backend. One bridge, every direction.

## License

MIT
