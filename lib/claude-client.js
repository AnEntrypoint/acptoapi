'use strict';
const { spawn } = require('child_process');
const os = require('os');

const CLAUDE_MODELS = ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-7', 'haiku', 'sonnet', 'opus'];
const CLAUDE_DEFAULT = 'sonnet';

function isClaudeModel(fullModel) {
  return /^claude\//.test(fullModel || '');
}

function parseClaudeModel(fullModel) {
  const m = /^claude\/(.+)$/.exec(fullModel || '');
  return m ? m[1] : CLAUDE_DEFAULT;
}

async function probeClaude(bin = 'claude', timeoutMs = 3000) {
  return new Promise(resolve => {
    const p = spawn(bin, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    const t = setTimeout(() => { p.kill(); resolve(false); }, timeoutMs);
    p.on('exit', code => { clearTimeout(t); resolve(code === 0); });
    p.on('error', () => { clearTimeout(t); resolve(false); });
  });
}

async function* streamClaude({ prompt, model, systemPrompt, bin = 'claude', signal, tools = '', permissionMode = 'default', cwd = os.tmpdir() }) {
  const args = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--no-session-persistence',
    '--disable-slash-commands',
    '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{}}',
    '--setting-sources', '',
    '--permission-mode', permissionMode,
    '--tools', tools,
    '--model', model,
  ];
  if (systemPrompt) args.push('--append-system-prompt', systemPrompt);

  const proc = spawn(bin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    cwd: cwd || undefined,
  });

  if (signal) signal.addEventListener('abort', () => proc.kill(), { once: true });

  const stderrChunks = [];
  proc.stderr.on('data', c => stderrChunks.push(c));

  let buf = '';
  let exited = false;
  let exitCode = null;
  proc.on('exit', code => { exited = true; exitCode = code; });

  for await (const chunk of proc.stdout) {
    buf += chunk.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try { yield JSON.parse(line); } catch {}
    }
  }
  if (buf.trim()) {
    try { yield JSON.parse(buf.trim()); } catch {}
  }
  if (!exited) await new Promise(r => proc.once('exit', r));
  if (exitCode !== 0 && exitCode !== null) {
    const err = Buffer.concat(stderrChunks).toString('utf8');
    throw new Error(`claude exit ${exitCode}: ${err.slice(0, 500)}`);
  }
}

module.exports = { CLAUDE_MODELS, CLAUDE_DEFAULT, isClaudeModel, parseClaudeModel, probeClaude, streamClaude };
