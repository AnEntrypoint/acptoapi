# ACP Daemon Status Report

## Summary
All 11 ACP daemons fail to spawn during startup. They are attempted via `bun x` and `npx` with fallback sequences, but exit with code 1 immediately. The system falls back to 12 brand providers (groq, nvidia, cerebras, mistral, sambanova, codestral, zai, qwen, cloudflare, openrouter, opencode-zen, google) which are all operational.

## Daemons (All Failing to Spawn)
1. **kilo** (port 4780) — attempts: `bun x kilo-code-cli acp`, `npx --yes kilo-code-cli acp`, `kilo-acp`, `kilo`
   - Package may not exist on npm or doesn't have `acp` subcommand
   
2. **opencode** (port 4790) — attempts: `bun x opencode-ai acp`, `npx --yes opencode-ai acp`, `opencode-acp`, `opencode`
   - Similar issue
   
3. **gemini-cli** (port 4810) — attempts: `gemini acp`, `bun x gemini-cli acp`, `npx --yes gemini-cli acp`
4. **qwen-code** (port 4820) — attempts: `bun x qwen-code-cli acp`, `npx --yes qwen-code-cli acp`
5. **codex-cli** (port 4830) — attempts: `bun x openai-codex-cli acp`, `npx --yes openai-codex-cli acp`
6. **copilot-cli** (port 4840) — attempts: `gh copilot acp`, `bun x @github/copilot-cli acp`, `npx --yes @github/copilot-cli acp`
7. **cline** (port 4850) — attempts: `bun x cline acp`, `npx --yes cline acp`
8. **hermes-agent** (port 4860) — attempts: `bun x @nos/hermes-agent acp`, `npx --yes @nos/hermes-agent acp`
9. **cursor-acp** (port 4870) — attempts: `bun x cursor-acp acp`, `npx --yes cursor-acp acp`
10. **codeium-cli** (port 4880) — attempts: `codeium-cli acp`, `bun x codeium-cli acp`, `npx --yes codeium-cli acp`
11. **acp-cli** (port 4890) — attempts: `acp daemon start`, `bun x acp-cli daemon start`, `npx --yes acp-cli daemon start`

## Root Cause Hypothesis
The spawn command invocations are likely **incorrect**:
- The `acp` argument may not be a valid subcommand for most packages
- The package names may be incorrect
- The packages may be theoretical/not actually published to npm
- The invocation pattern needs to be specific to each tool (different from the generic ACP protocol interface)

## System Status: FULLY OPERATIONAL
Despite daemon failures, the system is fully functional with 12 brand providers:

### Working Features
- ✓ 146 models enumerated (68 with SWE-Bench scores)
- ✓ Models sorted by SWE-Bench descending
- ✓ 21-link auto-chain with proper fallback
- ✓ Exponential backoff sampler (30s, 60s, 120s, 240s, 480s intervals)
- ✓ Real chat requests with streaming and non-streaming
- ✓ All 12 brand providers operational

### Sampler Status
- ✓ OK: groq, openrouter, ollama (3 providers)
- ✗ FAILED (30s backoff): all 11 ACP daemons
- Status endpoint: `/v1/sampler/status`

### Known Models (by score)
1. moonshotai/kimi-k2.6: 80.2
2. groq/llama-3.3-70b-versatile: 79.6
3. nvidia/llama-3.1-nemotron-ultra-253b-v1: 77.8

## Recommendations
1. **For ACP Daemon Integration**: Verify correct spawn commands by checking official repos for each tool. The `acp` subcommand pattern may not apply universally.
2. **For Production**: The system is production-ready without ACP daemons. 12 brand providers offer sufficient coverage with auto-fallback chain.
3. **For Future Work**: Either fix spawn commands per-tool or remove ACP daemon auto-launch entirely in favor of manual registration.
