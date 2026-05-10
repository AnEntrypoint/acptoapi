# Changelog

## [Unreleased]

### Added
- `lib/sampler.js`: exponential backoff availability sampler (5-step: 30s→60s→120s→240s→480s); exports `createSampler` factory and singleton `isAvailable`/`markFailed`/`markOk`/`getStatus`/`probe`/`startSampler`/`stopSampler`
- `lib/provider-maps.js`: `PROVIDER_KEYS` (provider → env var) and `PROVIDER_DEFAULTS` (provider → default model) covering 17 providers, derived from `BRANDS` + `auto-chain` data
- `index.js` now exports all sampler functions, `PROVIDER_KEYS`, `PROVIDER_DEFAULTS`, `buildAutoChain`, `createCircuitBreaker`
- Configurable multi-provider fallback chain (lib/auto-chain.js)
- 7 new providers: sambanova, cloudflare, zai, qwen, codestral, opencode-zen (plus nvidia fixed)
- PROVIDER_ORDER env var for comma-separated provider priority configuration
- GET /debug/auto-chain endpoint — returns resolved chain links and order
- Auto-model routing in /v1/messages when model is 'auto'
- Ollama streaming provider (lib/providers/ollama.js) with NDJSON, tool-call loop, 404→BridgeError
- reasoning-delta SSE handler to anthropic, openai, gemini, acp format files
- /debug/providers, /debug/config, /debug/translate endpoints to server
- Cohere v2 Chat API format (lib/formats/cohere.js) with toParams, toResponse, toSSE

### Fixed
- NVIDIA_KEY renamed to NVIDIA_API_KEY throughout
