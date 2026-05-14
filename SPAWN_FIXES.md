# ACP Daemon Spawn Fixes

## Issue

All 11 ACP daemons were failing to spawn with "exited (1) immediately" when the server started via `bun x acptoapi@latest`. This was happening even though the CLI tools (kilo, opencode, gemini) were installed and available.

## Root Causes Identified and Fixed

### 1. **Incorrect Package Names in CMDS Configuration**

The spawn configuration in `lib/acp-launcher.js` contained wrong package names:

| Daemon | Before | After | Fix |
|--------|--------|-------|-----|
| Kilo | `@agentclientprotocol/claude-agent-acp` | `kilo-code-cli` | Correct npm package name |
| Qwen | `qwen-code` | `qwen-code-cli` | Added `-cli` suffix for npm |
| Codex | `@zed-industries/codex-acp`, `@agentclientprotocol/codex-acp` | `openai-codex-cli` | Correct package |
| Codeium | `codeium` | `codeium-cli` | Explicit CLI package |

### 2. **Missing `acp` Subcommand**

Several daemons require the `acp` subcommand when invoked via their bare binary names:

- `opencode-acp acp` (was: `opencode-acp`, `opencode`)
- `opencode acp` (was: `opencode`)
- `gemini acp` (was: not included, added as first attempt)
- `qwen-code acp` (was: not included, added)
- `codex-cli acp` (was: not included, added)
- `codeium-cli acp` (was: `codeium acp`, reordered)

### 3. **Windows Command Quoting Issue**

When constructing the command string for `cmd.exe /C`, the code was quoting commands like:
```
"bun" x kilo-code-cli
```

This doesn't work correctly in cmd.exe. System commands like `bun` and `npx` should not be quoted.

**Fix**: Only quote non-system commands:
```javascript
if (attempt.command === 'bun' || attempt.command === 'npx') {
    cmdStr = `${attempt.command} ${args}`.trim();  // No quotes
} else {
    cmdStr = `"${attempt.command}" ${args}`.trim();  // Quoted
}
```

## Spawn Attempt Order

The new spawn sequence (per AGENTS.md) is:

### Kilo (port 4780)
1. `bun x kilo-code-cli`
2. `npx --yes kilo-code-cli`
3. `kilo-acp` (bare command)
4. `kilo acp` (with acp subcommand)

### Opencode (port 4790)
1. `bun x opencode-ai`
2. `npx --yes opencode-ai`
3. `opencode-acp acp`
4. `opencode acp`

### Gemini CLI (port 4810)
1. `gemini acp` (bare command first—fastest if installed)
2. `bun x gemini-cli`
3. `npx --yes gemini-cli`

### Qwen Code (port 4820)
1. `bun x qwen-code-cli`
2. `npx --yes qwen-code-cli`
3. `qwen-code acp`

### Codex CLI (port 4830)
1. `bun x openai-codex-cli`
2. `npx --yes openai-codex-cli`
3. `codex-cli acp`

### Copilot CLI (port 4840)
1. `gh copilot acp`
2. `bun x @github/copilot-cli`
3. `npx --yes @github/copilot-cli`

### Cline (port 4850)
1. `bun x cline`
2. `npx --yes cline`
3. `cline` (bare command)

### Hermes Agent (port 4860)
1. `bun x @nos/hermes-agent`
2. `npx --yes @nos/hermes-agent`

### Cursor ACP (port 4870)
1. `bun x cursor-acp`
2. `npx --yes cursor-acp`
3. `cursor-acp` (bare command)

### Codeium CLI (port 4880)
1. `codeium-cli acp` (bare command first)
2. `codeium command`
3. `bun x codeium-cli`
4. `npx --yes codeium-cli`

### ACP CLI (port 4890)
1. `acp daemon start`
2. `npx --yes acp-cli daemon start`
3. `bun x acp-cli daemon start`

## Testing

To verify the fixes:

```bash
# Start the server
bun x acptoapi@latest

# In another terminal, check daemon status
curl http://localhost:4800/health
```

Expected output should show multiple backends online (kilo, opencode, gemini-cli, etc.).

## Changes Made

Commit: `fec1181` - "fix: correct ACP daemon package names and spawn command quoting"

Files modified:
- `lib/acp-launcher.js`: Updated CMDS configuration and Windows spawn logic

## Environment Variables

Users can override spawn attempts with environment variables:

```bash
# Override entire kilo spawn sequence
$env:KILO_ACP_CMD = "kilo-code-cli --acp"

# Override opencode
$env:OPENCODE_ACP_CMD = "opencode-ai --daemon"

# Similar for all other daemons
$env:GEMINI_CLI_ACP_CMD = "..."
$env:QWEN_CODE_ACP_CMD = "..."
# ... etc
```
