## [Unreleased]

### Added
- Configurable multi-provider fallback chain (lib/auto-chain.js)
- 7 new providers: nvidia (fixed key), sambanova, cloudflare, zai, qwen, codestral, opencode-zen
- PROVIDER_ORDER env var for priority configuration
- GET /debug/auto-chain endpoint
- Auto-model routing in /v1/messages when model is 'auto'

### Fixed
- NVIDIA_KEY renamed to NVIDIA_API_KEY throughout

# Changelog

## Unreleased

- feat: add Ollama streaming provider (lib/providers/ollama.js) with NDJSON, tool-call loop, 404→BridgeError

- feat: add reasoning-delta SSE handler to anthropic, openai, gemini, acp format files
- feat: add /debug/providers, /debug/config, /debug/translate endpoints to server
- feat: add Cohere v2 Chat API format (lib/formats/cohere.js) with toParams, toResponse, toSSE
