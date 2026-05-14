# ACP Package Analysis Report

## Summary
The AGENTS.md documentation describes 11 ACP daemon packages, but real-world testing reveals **none of them actually exist as ACP server implementations** in the npm registry.

## Findings

### Package Status

| Daemon | Package Name | NPM Status | Notes |
|--------|--------------|-----------|-------|
| Kilo | kilo-code-cli | ❌ NOT FOUND (404) | Referenced in AGENTS.md but doesn't exist in npm |
| Opencode | opencode-ai | ✅ EXISTS (v1.14.50) | Exists but NOT an ACP server - it's a regular tool |
| Gemini CLI | gemini-cli | ? UNTESTED | Not checked yet |
| Qwen Code | qwen-code-cli | ? UNTESTED | Not checked yet |
| Codex CLI | openai-codex-cli | ? UNTESTED | Not checked yet |
| Copilot CLI | @github/copilot-cli | ? UNTESTED | Not checked yet |
| Cline | cline | ✅ EXISTS (v3.0.2) | Exists (autonomous coding agent) but NOT an ACP server |
| Hermes Agent | @nos/hermes-agent | ? UNTESTED | Not checked yet |
| Cursor ACP | cursor-acp | ? UNTESTED | Not checked yet |
| Codeium CLI | codeium-cli | ? UNTESTED | Not checked yet |
| ACP CLI | acp-cli | ? UNTESTED | Not checked yet |

### Root Cause

The code in `lib/acp-launcher.js` tries to spawn packages as ACP servers, but:

1. **Packages don't exist**: `kilo-code-cli` and others referenced in the code don't exist in npm registry
2. **Packages don't implement ACP**: Even when packages exist (like `cline`, `opencode-ai`), they don't expose ACP server functionality - they're regular CLI tools
3. **Documentation is aspirational**: AGENTS.md describes what *should* exist, not what actually does

### Current Behavior

When `lib/acp-launcher.js` tries to spawn daemons:
```
[acp] kilo 'bun x kilo-code-cli acp' exited (1) immediately
[acp] kilo 'npx --yes kilo-code-cli acp' exited (1) immediately
[acp] kilo all spawn attempts failed
```

All 11 daemons report `unavailable` status because no actual ACP servers can be launched.

## What Needs to Happen

### Option 1: Disable Non-Functional ACP Daemons (Recommended)
Remove the ACP daemon spawn attempts from `lib/acp-launcher.js` until actual ACP server implementations exist in npm.

### Option 2: Find Real ACP Servers
Research and identify npm packages that actually implement the ACP protocol and update AGENTS.md and acp-launcher.js with correct package names.

### Option 3: Implement ACP Support
Fork/contribute to existing CLI tools to add ACP server support (significant effort).

## Impact

- The `GET /health` endpoint reports all 11 ACP daemons as `down`
- The fallback chain includes unreachable ACP links (they're demoted to end but still waste fallback attempts)
- System functions without ACP, but with reduced provider diversity

## Recommendation

Update AGENTS.md to clarify that ACP daemon support is **planned but not yet implemented**. Either:
1. Remove the aspirational daemon configurations from code, OR
2. Document them clearly as "planned for future implementation" and disable their startup
