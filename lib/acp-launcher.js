'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { probe, resolveBackend } = require('./acp-client');
const { StdioAcpWrapper } = require('./stdio-acp-wrapper');

const STATE = {};
const WRAPPERS = {};
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

const CMDS = {
    kilo: {
        port: 4780,
        wrapper: true,
        attempts: process.env.KILO_ACP_CMD
            ? [{ shell: process.env.KILO_ACP_CMD }]
            : [
                { command: 'bun', args: ['x', 'kilocode', 'acp'], stdio: true },
                { command: 'npx', args: ['--yes', 'kilocode', 'acp'], stdio: true },
                { command: 'kilocode', args: ['acp'], stdio: true },
                { command: 'kilo', args: ['acp'], stdio: true },
            ],
    },
    opencode: {
        port: 4790,
        wrapper: true,
        attempts: process.env.OPENCODE_ACP_CMD
            ? [{ shell: process.env.OPENCODE_ACP_CMD }]
            : [
                { command: 'bun', args: ['x', 'opencode-ai', 'acp'], stdio: true },
                { command: 'npx', args: ['--yes', 'opencode-ai', 'acp'], stdio: true },
                { command: 'opencode', args: ['acp'], stdio: true },
            ],
    },
    'qwen-code': {
        port: 4820,
        attempts: process.env.QWEN_CODE_ACP_CMD
            ? [{ shell: process.env.QWEN_CODE_ACP_CMD }]
            : [
                { command: 'bun', args: ['x', 'qwen-code-cli', 'acp'] },
                { command: 'npx', args: ['--yes', 'qwen-code-cli', 'acp'] },
                { command: 'qwen-code', args: ['acp'] },
            ],
    },
    'codex-cli': {
        port: 4830,
        attempts: process.env.CODEX_CLI_ACP_CMD
            ? [{ shell: process.env.CODEX_CLI_ACP_CMD }]
            : [
                { command: 'bun', args: ['x', 'openai-codex-cli', 'acp'] },
                { command: 'npx', args: ['--yes', 'openai-codex-cli', 'acp'] },
                { command: 'codex-cli', args: ['acp'] },
            ],
    },
    'copilot-cli': {
        port: 4840,
        attempts: process.env.COPILOT_CLI_ACP_CMD
            ? [{ shell: process.env.COPILOT_CLI_ACP_CMD }]
            : [
                { command: 'gh', args: ['copilot', 'acp'] },
                { command: 'bun', args: ['x', '@github/copilot-cli', 'acp'] },
                { command: 'npx', args: ['--yes', '@github/copilot-cli', 'acp'] },
            ],
    },
    'cline': {
        port: 4850,
        attempts: process.env.CLINE_ACP_CMD
            ? [{ shell: process.env.CLINE_ACP_CMD }]
            : [
                { command: 'bun', args: ['x', 'cline', 'acp'] },
                { command: 'npx', args: ['--yes', 'cline', 'acp'] },
                { command: 'cline', args: ['acp'] },
            ],
    },
    'hermes-agent': {
        port: 4860,
        attempts: process.env.HERMES_ACP_CMD
            ? [{ shell: process.env.HERMES_ACP_CMD }]
            : [
                { command: 'bun', args: ['x', '@nos/hermes-agent', 'acp'] },
                { command: 'npx', args: ['--yes', '@nos/hermes-agent', 'acp'] },
            ],
    },
    'cursor-acp': {
        port: 4870,
        attempts: process.env.CURSOR_ACP_CMD
            ? [{ shell: process.env.CURSOR_ACP_CMD }]
            : [
                { command: 'bun', args: ['x', 'cursor-acp', 'acp'] },
                { command: 'npx', args: ['--yes', 'cursor-acp', 'acp'] },
                { command: 'cursor-acp', args: ['acp'] },
            ],
    },
    'codeium-cli': {
        port: 4880,
        attempts: process.env.CODEIUM_ACP_CMD
            ? [{ shell: process.env.CODEIUM_ACP_CMD }]
            : [
                { command: 'codeium-cli', args: ['acp'] },
                { command: 'codeium', args: ['command', 'acp'] },
                { command: 'bun', args: ['x', 'codeium-cli', 'acp'] },
                { command: 'npx', args: ['--yes', 'codeium-cli', 'acp'] },
            ],
    },
    'acp-cli': {
        port: 4890,
        attempts: process.env.ACP_CLI_CMD
            ? [{ shell: process.env.ACP_CLI_CMD }]
            : [
                { command: 'bun', args: ['x', 'acp-cli', 'daemon', 'start'] },
                { command: 'npx', args: ['--yes', 'acp-cli', 'daemon', 'start'] },
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

const _cmdCache = {};
function commandExistsSync(cmd) {
    if (cmd in _cmdCache) return _cmdCache[cmd];
    try {
        const { execSync } = require('child_process');
        if (process.platform === 'win32') {
            execSync(`where ${cmd}`, { stdio: 'pipe', windowsHide: true, timeout: 500 });
        } else {
            execSync(`which ${cmd}`, { stdio: 'pipe', timeout: 500 });
        }
        _cmdCache[cmd] = true;
    } catch {
        _cmdCache[cmd] = false;
    }
    return _cmdCache[cmd];
}

const HAS_BUN = commandExistsSync('bun');
const HAS_NPX = commandExistsSync('npx');

async function commandExists(cmd) {
    if (cmd === 'bun') return HAS_BUN;
    if (cmd === 'npx') return HAS_NPX;
    return commandExistsSync(cmd);
}

async function spawnDaemon(name, log) {
    if (STATE[name] && !STATE[name].killed) {
        log(`[acp] ${name} already spawned (pid ${STATE[name].pid})`);
        return STATE[name];
    }
    if (WRAPPERS[name] && WRAPPERS[name].ready) {
        log(`[acp] ${name} wrapper already running (port ${WRAPPERS[name].port})`);
        return WRAPPERS[name];
    }

    const cfg = CMDS[name];
    if (!cfg) return null;

    registerCleanupHandler();

    for (const attempt of cfg.attempts) {
        const desc = attempt.shell ? attempt.shell : `${attempt.command} ${(attempt.args || []).join(' ')}`.trim();

        if (!attempt.shell && !(await commandExists(attempt.command))) {
            continue;
        }

        try {
          if (attempt.stdio && cfg.wrapper) {
            const wrapper = new StdioAcpWrapper(name, attempt.command, attempt.args, cfg.port);
            try {
              await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('wrapper startup timeout')), 3000);
                wrapper.once('ready', () => {
                  clearTimeout(timeout);
                  resolve();
                });
                wrapper.once('error', err => {
                  clearTimeout(timeout);
                  reject(err);
                });
                wrapper.start().catch(reject);
              });
              WRAPPERS[name] = wrapper;
              const msg = `spawned ${name} wrapper (port ${cfg.port}) via "${desc}"`;
              log(`[acp] ${msg}`);
              logAcp('wrapper_success', msg);
              wrapper.on('error', err => {
                logAcp('wrapper_error', `${name}: ${err.message}`);
              });
              wrapper.on('stderr', chunk => {
                const txt = String(chunk).trim();
                if (txt) log(`[acp:${name}:stderr] ${txt}`);
              });
              wrapper.on('subprocess-exit', code => {
                logAcp('wrapper_subprocess_exit', `${name} subprocess exited (${code})`);
                delete WRAPPERS[name];
              });
              return wrapper;
            } catch (e) {
              const msg = `${name} wrapper '${desc}' failed: ${e.message}`;
              log(`[acp] ${msg}`);
              logAcp('wrapper_failed', msg);
              continue;
            }
          }

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

function resolveWindowsExe(cmd) {
    try {
        const { execSync } = require('child_process');
        const out = execSync(`where ${cmd}`, {
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore'],
            windowsHide: true,
            timeout: 800,
        });
        const lines = out.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
        const exe = lines.find(l => /\.exe$/i.test(l));
        if (exe) return exe;
        return lines[0] || cmd;
    } catch {
        return cmd;
    }
}

function spawnWindowsDaemon(name, attempt, desc, log) {
    const nulFd = getStdioDestFile();
    const CREATE_NO_WINDOW = 0x08000000;
    const spawnOpts = {
        stdio: nulFd === null ? 'ignore' : ['ignore', nulFd, nulFd],
        detached: true,
        windowsHide: true,
        creationFlags: CREATE_NO_WINDOW,
    };

    if (attempt.shell) {
        return spawn(process.env.ComSpec || 'cmd.exe', ['/D', '/S', '/C', attempt.shell], {
            ...spawnOpts,
            windowsVerbatimArguments: false,
        });
    }

    const resolved = resolveWindowsExe(attempt.command);
    const args = attempt.args || [];

    if (/\.exe$/i.test(resolved)) {
        return spawn(resolved, args, spawnOpts);
    }

    const quoted = args.map(a => /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a).join(' ');
    const fullCmd = `${resolved} ${quoted}`.trim();
    return spawn(process.env.ComSpec || 'cmd.exe', ['/D', '/S', '/C', fullCmd], {
        ...spawnOpts,
        windowsVerbatimArguments: false,
    });
}

function spawnUnixDaemon(name, attempt, desc, log) {
    const stdio = 'ignore';
    return attempt.shell
        ? spawn(attempt.shell, [], { stdio, detached: true, shell: true })
        : spawn(attempt.command, attempt.args || [], { stdio, detached: true });
}

async function ensureRunning({ names = ['kilo', 'opencode', 'qwen-code', 'codex-cli', 'copilot-cli', 'cline', 'hermes-agent', 'cursor-acp', 'codeium-cli', 'acp-cli'], log = () => {} } = {}) {
    if (!process.env.ACPTOAPI_ENABLE_ACP) {
        logAcp('ensure_running_skipped', 'ACP auto-launch disabled (set ACPTOAPI_ENABLE_ACP=1 to enable)');
        return {};
    }
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

function liveDaemons() {
    const liveNames = new Set();
    for (const name of Object.keys(WRAPPERS)) {
        if (WRAPPERS[name] && WRAPPERS[name].ready) liveNames.add(name);
    }
    for (const name of Object.keys(STATE)) {
        if (STATE[name] && !STATE[name].killed) liveNames.add(name);
    }
    return liveNames;
}

module.exports = { ensureRunning, isUp, spawnDaemon, registerDaemon, CMDS, liveDaemons };
