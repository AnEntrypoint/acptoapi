import { spawn } from 'child_process';

export const CLAUDE_MODELS = ['claude-haiku-4-5', 'claude-sonnet-4-6', 'claude-opus-4-7', 'haiku', 'sonnet', 'opus'];
export const CLAUDE_DEFAULT = 'sonnet';

export function isClaudeModel(fullModel) {
  return /^claude\//.test(fullModel || '');
}

export function parseClaudeModel(fullModel) {
  const m = /^claude\/(.+)$/.exec(fullModel || '');
  return m ? m[1] : CLAUDE_DEFAULT;
}

export async function probeClaude(bin = 'claude', timeoutMs = 3000) {
  return new Promise(resolve => {
    const p = spawn(bin, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
    const t = setTimeout(() => { p.kill(); resolve(false); }, timeoutMs);
    p.on('exit', code => { clearTimeout(t); resolve(code === 0); });
    p.on('error', () => { clearTimeout(t); resolve(false); });
  });
}

export async function* streamClaude({ prompt, model, systemPrompt, bin = 'claude', signal }) {
  const args = [
    '-p', prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--no-session-persistence',
    '--permission-mode', 'bypassPermissions',
    '--model', model,
  ];
  if (systemPrompt) args.push('--append-system-prompt', systemPrompt);

  const proc = spawn(bin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
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
      try { yield JSON.parse(line); } catch { /* partial / non-JSON stderr-merged line */ }
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
