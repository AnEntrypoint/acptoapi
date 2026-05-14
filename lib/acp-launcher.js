'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { probe, resolveBackend } = require('./acp-client');

const STATE = {};
const DEVNULL = process.platform === 'win32' ? 'nul' : '/dev/null';

let stdioDest = null;
function getStdioDestFile() {
  if (!stdioDest) {
    const nullFile = path.join(os.tmpdir(), '.acptoapi-null');
    try {
      if (!fs.existsSync(nullFile)) {
        fs.writeFileSync(nullFile, '');
      }
      stdioDest = fs.openSync(nullFile, 'a');
    } catch (e) {
      return null;
    }
  }
  return stdioDest;
}

let cleanupRegistered = false;
function registerCleanupHandler() {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  const cleanup = () => {
    const names = Object.keys(STATE);
    if (names.length === 0) return;
    logAcp('cleanup', `terminating ${names.length} spawned daemon(s)`);
    for (const name of names) {
      const proc = STATE[name];
      if (proc && !proc.killed) {
        try {
          if (process.platform === 'win32') {
            require('child_process').execSync(`taskkill /F /PID ${proc.pid} 2>nul`, { windowsHide: true });
          } else {
            proc.kill('SIGTERM');
          }
          logAcp('cleanup', `terminated ${name} (pid ${proc.pid})`);
        } catch (e) {
          logAcp('cleanup', `error terminating ${name}: ${e.message}`);
        }
      }
    }
    if (stdioDest) {
      try { fs.closeSync(stdioDest); } catch {}
    }
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(130); });
  process.on('SIGTERM', () => { cleanup(); process.exit(143); });
}

function logAcp(phase, msg) {
  const ts = new Date().toISOString();
  const logDir = path.join(os.homedir(), '.claude', 'gm-log', new Date().toISOString().slice(0, 10));
  const logFile = path.join(logDir, 'acp-launcher.jsonl');
  try {
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const entry = JSON.stringify({ ts, phase, msg }) + '\n';
    fs.appendFileSync(logFile, entry);
  } catch {}
}

// Each daemon has an ordered list of (command, args) tuples to try.
// Override the whole list with <NAME>_ACP_CMD (shell string).
const CMDS = {
    kilo: {
        port: 4780,
        attempts: process.env.KILO_ACP_CMD
            ? [{ shell: process.env.KILO_ACP_CMD }]
            : [
                { command: 'kilo-acp', args: [] },
                { command: 'kilo', args: ['acp'] },
                { command: 'npx', args: ['--yes', 'kilo-code-cli', 'acp'] },
                { command: 'bunx', args: ['kilo-code-cli', 'acp'] },
            ],
    },
    opencode: {
        port: 4790,
        attempts: process.env.OPENCODE_ACP_CMD
            ? [{ shell: process.env.OPENCODE_ACP_CMD }]
            : [
                { command: 'opencode-acp', args: [] },
                { command: 'opencode', args: ['acp'] },
                { command: 'npx', args: ['--yes', 'opencode-ai', 'acp'] },
                { command: 'bunx', args: ['opencode-ai', 'acp'] },
            ],
    },
    'gemini-cli': {
        port: 4810,
        attempts: process.env.GEMINI_CLI_ACP_CMD
            ? [{ shell: process.env.GEMINI_CLI_ACP_CMD }]
            : [
                { command: 'gemini', args: ['acp'] },
                { command: 'npx', args: ['--yes', 'gemini-cli', 'acp'] },
                { command: 'bunx', args: ['gemini-cli', 'acp'] },
            ],
    },
    'qwen-code': {
        port: 4820,
        attempts: process.env.QWEN_CODE_ACP_CMD
            ? [{ shell: process.env.QWEN_CODE_ACP_CMD }]
            : [
                { command: 'qwen-code', args: ['acp'] },
                { command: 'npx', args: ['--yes', 'qwen-code-cli', 'acp'] },
                { command: 'bunx', args: ['qwen-code-cli', 'acp'] },
            ],
    },
    'codex-cli': {
        port: 4830,
        attempts: process.env.CODEX_CLI_ACP_CMD
            ? [{ shell: process.env.CODEX_CLI_ACP_CMD }]
            : [
                { command: 'codex-cli', args: ['acp'] },
                { command: 'npx', args: ['--yes', 'openai-codex-cli', 'acp'] },
                { command: 'bunx', args: ['openai-codex-cli', 'acp'] },
            ],
    },
    'copilot-cli': {
        port: 4840,
        attempts: process.env.COPILOT_CLI_ACP_CMD
            ? [{ shell: process.env.COPILOT_CLI_ACP_CMD }]
            : [
                { command: 'gh', args: ['copilot', 'acp'] },
                { command: 'copilot-cli', args: ['acp'] },
                { command: 'npx', args: ['--yes', '@github/copilot-cli', 'acp'] },
            ],
    },
    'cline': {
        port: 4850,
        attempts: process.env.CLINE_ACP_CMD
            ? [{ shell: process.env.CLINE_ACP_CMD }]
            : [
                { command: 'cline', args: ['acp'] },
                { command: 'npx', args: ['--yes', 'cline', 'acp'] },
                { command: 'bunx', args: ['cline', 'acp'] },
            ],
    },
    'hermes-agent': {
        port: 4860,
        attempts: process.env.HERMES_ACP_CMD
            ? [{ shell: process.env.HERMES_ACP_CMD }]
            : [
                { command: 'hermes-acp', args: [] },
                { command: 'npx', args: ['--yes', '@nos/hermes-agent', 'acp'] },
                { command: 'bunx', args: ['@nos/hermes-agent', 'acp'] },
            ],
    },
    'cursor-acp': {
        port: 4870,
        attempts: process.env.CURSOR_ACP_CMD
            ? [{ shell: process.env.CURSOR_ACP_CMD }]
            : [
                { command: 'cursor-acp', args: [] },
                { command: 'npx', args: ['--yes', 'cursor-acp', 'acp'] },
                { command: 'bunx', args: ['cursor-acp', 'acp'] },
            ],
    },
    'codeium-cli': {
        port: 4880,
        attempts: process.env.CODEIUM_ACP_CMD
            ? [{ shell: process.env.CODEIUM_ACP_CMD }]
            : [
                { command: 'codeium-cli', args: ['acp'] },
                { command: 'codeium', args: ['command'] },
                { command: 'npx', args: ['--yes', 'codeium-cli', 'acp'] },
                { command: 'bunx', args: ['codeium-cli', 'acp'] },
            ],
    },
    'acp-cli': {
        port: 4890,
        attempts: process.env.ACP_CLI_CMD
            ? [{ shell: process.env.ACP_CLI_CMD }]
            : [
                { command: 'acp', args: ['daemon', 'start'] },
                { command: 'npx', args: ['--yes', 'acp-cli', 'daemon', 'start'] },
                { command: 'bunx', args: ['acp-cli', 'daemon', 'start'] },
            ],
    },
};

function registerDaemon(name, port, attempts) {
    CMDS[name] = { port, attempts };
}

async function isUp(name) {
    try {
        const b = resolveBackend(name);
        return await probe(b, 1500);
    } catch { return false; }
}

async function spawnDaemon(name, log) {
    if (STATE[name] && !STATE[name].killed) {
        log(`[acp] ${name} already spawned (pid ${STATE[name].pid})`);
        return STATE[name];
    }
    const cfg = CMDS[name];
    if (!cfg) return null;

    registerCleanupHandler();

    for (const attempt of cfg.attempts) {
        const desc = attempt.shell ? attempt.shell : `${attempt.command} ${(attempt.args || []).join(' ')}`.trim();
        try {
            const proc = process.platform === 'win32'
                ? spawnWindowsDaemon(name, attempt, desc, log)
                : spawnUnixDaemon(name, attempt, desc, log);

            const survived = await new Promise(resolve => {
                let done = false;
                proc.once('error', e => {
                    if (done) return;
                    done = true;
                    const msg = `${name} '${desc}' error: ${e.code || e.message}`;
                    log(`[acp] ${msg}`);
                    logAcp('spawn_error', msg);
                    resolve(false);
                });
                proc.once('exit', code => {
                    if (done) return;
                    done = true;
                    const msg = `${name} '${desc}' exited (${code}) immediately`;
                    log(`[acp] ${msg}`);
                    logAcp('spawn_exit', msg);
                    resolve(false);
                });
                setTimeout(() => { if (done) return; done = true; resolve(true); }, 600);
            });

            if (survived) {
                proc.unref();
                STATE[name] = proc;
                const msg = `spawned ${name} (pid ${proc.pid}) via "${desc}"`;
                log(`[acp] ${msg}`);
                logAcp('spawn_success', msg);
                proc.on('exit', code => {
                    const msg = `${name} pid ${proc.pid} exited (${code})`;
                    log(`[acp] ${msg}`);
                    logAcp('daemon_exit', msg);
                });
                return proc;
            }
        } catch (e) {
            const msg = `${name} '${desc}' threw: ${e.message}`;
            log(`[acp] ${msg}`);
            logAcp('spawn_threw', msg);
        }
    }

    const msg = `${name} all spawn attempts failed`;
    log(`[acp] ${msg}`);
    logAcp('spawn_failed', msg);
    return null;
}

function spawnWindowsDaemon(name, attempt, desc, log) {
    // On Windows, use cmd.exe /B (no window creation) with proper redirection to suppress console windows.
    // The /B flag prevents a new window from being created for the command.
    let cmd, args;

    if (attempt.shell) {
        cmd = 'cmd.exe';
        // /B = don't create a new window, /C = run command and exit
        args = ['/B', '/C', attempt.shell];
    } else {
        cmd = 'cmd.exe';
        // Construct command line to run the process with /B flag
        const argStr = (attempt.args || []).map(a => {
            // Escape args if they contain spaces
            return a.includes(' ') ? `"${a}"` : a;
        }).join(' ');
        args = ['/B', '/C', `${attempt.command} ${argStr}`.trim()];
    }

    // Spawn with stdio redirection to suppress any output and window creation
    const proc = spawn(cmd, args, {
        stdio: ['ignore', 'ignore', 'ignore'],
        detached: true,
        windowsHide: true
    });

    return proc;
}

function spawnUnixDaemon(name, attempt, desc, log) {
    const stdio = 'ignore';
    return attempt.shell
        ? spawn(attempt.shell, [], { stdio, detached: true, shell: true })
        : spawn(attempt.command, attempt.args || [], { stdio, detached: true });
}

async function ensureRunning({ names = ['kilo', 'opencode', 'gemini-cli', 'qwen-code', 'codex-cli', 'copilot-cli', 'cline', 'hermes-agent', 'cursor-acp', 'codeium-cli', 'acp-cli'], log = () => {} } = {}) {
    registerCleanupHandler();
    const status = {};
    const start = Date.now();
    logAcp('ensure_running_start', `checking ${names.join(', ')}`);
    for (const name of names) {
        const up = await isUp(name);
        if (up) {
            status[name] = 'already_up';
            logAcp('ensure_running_probe', `${name} already running`);
            continue;
        }
        const proc = await spawnDaemon(name, log);
        status[name] = proc ? 'spawned' : 'unavailable';
    }
    const elapsed = Date.now() - start;
    logAcp('ensure_running_complete', `elapsed ${elapsed}ms, status: ${JSON.stringify(status)}`);
    return status;
}

async function waitForReady({ name, timeoutMs = 8000, log = () => {} } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        if (await isUp(name)) { log(`[acp] ${name} ready in ${Date.now() - start}ms`); return true; }
        await new Promise(r => setTimeout(r, 500));
    }
    log(`[acp] ${name} not ready after ${timeoutMs}ms`);
    return false;
}

module.exports = { ensureRunning, waitForReady, isUp, spawnDaemon, registerDaemon, CMDS };
