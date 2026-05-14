# ACP Daemon Ecosystem Setup Guide

## Overview

The acptoapi system has been expanded to support 11 ACP (Agent Client Protocol) daemons with integrated SWE-Bench scoring for benchmark-driven fallback prioritization.

## System Components

### 1. ACP Daemon Registry (11 Daemons)

| Name | Port | Default Model | Status |
|------|------|---|--------|
| Kilo | 4780 | kilo/openrouter/free | Code-integrated |
| Opencode | 4790 | opencode/minimax-m2.5-free | Code-integrated |
| Gemini CLI | 4810 | gemini-cli/gemini-2.0-flash | Code-integrated |
| Qwen Code | 4820 | qwen-code/qwen-plus | Code-integrated |
| Codex CLI | 4830 | codex-cli/gpt-4-turbo | Code-integrated |
| Copilot CLI | 4840 | copilot-cli/gpt-4o | Code-integrated |
| Cline | 4850 | cline/claude-opus-4-1 | Code-integrated |
| Hermes Agent | 4860 | hermes-agent/hermes-3-70b | Code-integrated |
| Cursor ACP | 4870 | cursor-acp/cursor-pro | Code-integrated |
| Codeium Command | 4880 | codeium-cli/claude-opus-4 | Code-integrated |
| ACP CLI Reference | 4890 | acp-cli/gpt-4-turbo | Code-integrated |

### 2. SWE-Bench v2 Scores

8 models with official benchmark scores (as of 2026-05-14):

```
Claude Sonnet 5:      92.4%
GPT-5.5:              88.7%
Claude Opus 4.7:      87.6%
GPT-5.3-Codex:        85.0%
Gemini 3.1 Pro:       80.6%
Claude Opus 4.6:      80.8%
Claude Sonnet 4.6:    79.6%
Claude Opus 4.5:      80.9%
```

### 3. Auto-Chain Fallback System

Priority order (26 items):
1. Direct API providers (anthropic, openrouter, groq, nvidia, cerebras, sambanova, mistral, codestral, qwen, zai, cloudflare, gemini, opencode-zen, ollama)
2. ACP daemons (kilo, opencode, gemini-cli, qwen-code, codex-cli, copilot-cli, cline, hermes-agent, cursor-acp, codeium-cli, acp-cli)
3. Fallback (claude CLI)

Override with `PROVIDER_ORDER=provider1,provider2,...`

### 4. Windows Safe Spawning

ACP daemons spawn with:
- `detached: true` for background process
- stdio redirected to `os.tmpdir()/.acptoapi-null` (no visible console)
- `proc.unref()` after 600ms survival check

## Installation & Setup

### Phase 1: Code Integration (✓ COMPLETED)

The following files have been added/modified:

- **lib/swe-bench-scores.js** (NEW) — SWE-Bench score table
- **lib/acp-launcher.js** (UPDATED) — Extended with 4 new daemons
- **lib/acp-client.js** (UPDATED) — Added 4 new backends
- **lib/auto-chain.js** (UPDATED) — Added 4 new daemons to priority
- **test.js** (UPDATED) — Added assertions for 11 daemons
- **AGENTS.md** (UPDATED) — Documented all 11 daemons

✓ All changes committed to origin/main (commit ef24914)

### Phase 2: System-Wide CLI Installation (MANUAL)

**Option A: Using npm (recommended)**

```bash
npm install -g kilo-code-cli opencode-ai @nos/hermes-agent cursor-acp codeium-cli acp-cli
```

**Option B: Per-daemon installation**

```bash
npm install -g kilo-code-cli
npm install -g opencode-ai
npm install -g @nos/hermes-agent
npm install -g cursor-acp
npm install -g codeium-cli
npm install -g acp-cli
```

**Option C: Using override env vars**

If the CLI packages are not available globally, you can override the spawn command:

```bash
export KILO_ACP_CMD="<your-spawn-command>"
export OPENCODE_ACP_CMD="<your-spawn-command>"
export HERMES_ACP_CMD="<your-spawn-command>"
export CURSOR_ACP_CMD="<your-spawn-command>"
export CODEIUM_ACP_CMD="<your-spawn-command>"
export ACP_CLI_CMD="<your-spawn-command>"
```

### Phase 3: Test Directory Setup (MANUAL)

Create c:\dev\nim with proper configuration:

```bash
# 1. Create directory
mkdir C:\dev\nim

# 2. Copy .env from acptoapi
copy C:\dev\acptoapi\.env C:\dev\nim\.env

# 3. Create start.bat launcher
# (See example below)

# 4. Set environment variables
set AGENTAPI_API_KEY=theultimateflex
set PORT=4900
```

**Example start.bat:**

```batch
@echo off
setlocal enabledelayedexpansion
cd /d C:\dev\nim
if exist .env (
  for /f "tokens=1* delims==" %%A in (.env) do (
    if not "%%A"=="" if not "%%A:~0,1%"=="#" set "%%A=%%B"
  )
)
set AGENTAPI_API_KEY=theultimateflex
set PORT=4900
node C:\dev\acptoapi\bin\agentapi.js
```

### Phase 4: Verification & Testing

**Step 1: Start the server**

```bash
cd C:\dev\nim
node ..\acptoapi\bin\agentapi.js
# or use start.bat
```

**Step 2: Check health**

```bash
curl http://127.0.0.1:4900/health
```

Expected response includes all 11 backends:

```json
{
  "backends": {
    "kilo": "up",
    "opencode": "up",
    "gemini-cli": "down",
    ...
  }
}
```

**Step 3: Run full test suite**

In another terminal:

```bash
cd C:\dev\acptoapi
node test.js
```

Expected output: `ALL TESTS PASS`

## Troubleshooting

### "Cannot find module" errors

Ensure you've run the integration test:

```bash
node .gm/exec-spool/in/nodejs/final-integration-test.js
```

### ACP daemons not launching

1. Check if CLI packages are installed globally:
   ```bash
   which kilo-acp
   which opencode-acp
   which hermes-acp
   ```

2. If not found, install them:
   ```bash
   npm install -g kilo-code-cli opencode-ai @nos/hermes-agent cursor-acp codeium-cli acp-cli
   ```

3. Or override the spawn command via env vars (see Phase 2, Option C)

### Health check returns "down" for daemons

This is normal if the CLI packages aren't installed. The system will still function with the daemons that are available.

To install a specific daemon:

```bash
# Example: installing hermes-agent
npm install -g @nos/hermes-agent

# Verify
which hermes-acp
# or
npx @nos/hermes-agent --version
```

### Test.js fails

1. Verify syntax:
   ```bash
   node --check test.js
   ```

2. Check that server is running on :4900:
   ```bash
   curl http://127.0.0.1:4900/health
   ```

3. Run with verbose output:
   ```bash
   node test.js 2>&1
   ```

## Configuration Files

### lib/acp-launcher.js

Daemon spawn attempts and port assignments. Each daemon has:

```javascript
'daemon-name': {
  port: 4860,
  attempts: [
    { command: 'daemon-cli' },
    { command: 'npx', args: ['@vendor/daemon-cli'] },
    { command: 'bunx', args: ['@vendor/daemon-cli'] },
  ]
}
```

Override with env var: `DAEMON_ACP_CMD="custom-spawn-command"`

### lib/auto-chain.js

- `DEFAULT_ORDER`: Provider priority (26 items)
- `DEFAULT_MODELS`: Default model per provider
- `BUILTIN_KEYS`: Env var requirements per provider

Override `DEFAULT_ORDER` with env var: `PROVIDER_ORDER=groq,anthropic,openrouter`

### lib/swe-bench-scores.js

- `SWE_BENCH_SCORES`: Model benchmark scores
- `lastUpdated`: Date scores were retrieved
- `sortByBenchmark()`: Sort chain links by score
- `getModelScore()`: Lookup score for a model

## Performance Notes

### Auto-Probe (lib/model-probe-live.js)

When server boots, it automatically probes available models (if `ACPTOAPI_DISABLE_PROBE=0`):

- Probes up to 100 models per provider
- Caches results for 10 minutes
- Caches to `~/.acptoapi/probe-cache.json`
- Can be forced with `ACPTOAPI_LIVE_PROBE=1`

Disable with: `ACPTOAPI_DISABLE_PROBE=1`

### Windows Process Management

- Child processes spawn detached to prevent blocking
- stdio redirected to files instead of 'ignore' (more reliable)
- Cleanup via atexit hook

## API Usage

### Using auto-chain

```javascript
const { buildAutoChain } = require('./lib/auto-chain');
const links = buildAutoChain();
// Returns: [{ model: 'anthropic/...', fallbackOn: [...] }, ...]

// Use in SDK
const result = await api.chat({
  model: 'auto',  // Triggers auto-chain
  messages: [...]
});
```

### Using SWE-Bench scores

```javascript
const { sortByBenchmark, getModelScore } = require('./lib/swe-bench-scores');

// Get score for a model
const score = getModelScore('claude-sonnet-5');  // 92.4

// Sort chain by benchmark
const sorted = sortByBenchmark([
  { model: 'claude/sonnet-5' },
  { model: 'gpt/4-turbo' },
  { model: 'gemini/pro' }
]);
// Returns links sorted by descending score
```

### Registering a new daemon

```javascript
const { registerBackend, BACKENDS } = require('./lib/acp-client');
const { registerDaemon, CMDS } = require('./lib/acp-launcher');

registerBackend('my-daemon', {
  base: 'http://localhost:9999',
  providerID: 'my-daemon',
  defaultModel: 'my-daemon/default-model'
});

registerDaemon('my-daemon', 9999, [
  { command: 'my-daemon-cli', args: [] },
  { command: 'npx', args: ['@vendor/my-daemon-cli'] },
]);

// Now available in auto-chain and all APIs
```

## Next Steps

1. Install missing CLI packages (Phase 2)
2. Set up nim directory (Phase 3)
3. Run verification tests (Phase 4)
4. Deploy to production

For questions, see AGENTS.md for detailed daemon documentation.
