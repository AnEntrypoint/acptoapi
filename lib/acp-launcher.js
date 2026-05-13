'use strict';
// Spawn kilo and opencode ACP daemons in the background if not already running.
// Probes :4780/:4790 first; only spawns if the port is unreachable.

const { spawn } = require('child_process');
const { probe, resolveBackend } = require('./acp-client');

const STATE = { kilo: null, opencode: null }; // child process refs

// Each daemon has an ordered list of (command, args) tuples to try.
// Override the whole list with KILO_ACP_CMD / OPENCODE_ACP_CMD (shell string).
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
};

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
    for (const attempt of cfg.attempts) {
        const desc = attempt.shell ? attempt.shell : `${attempt.command} ${(attempt.args || []).join(' ')}`.trim();
        try {
            const proc = attempt.shell
                ? spawn(attempt.shell, [], { stdio: 'ignore', detached: true, shell: true, windowsHide: true })
                : spawn(attempt.command, attempt.args || [], {
                    stdio: 'ignore', detached: true,
                    shell: process.platform === 'win32',
                    windowsHide: true,
                });
            proc.unref();
            // Give it a brief moment to fail-fast on ENOENT
            const survived = await new Promise(resolve => {
                let done = false;
                proc.once('error', e => { if (done) return; done = true; log(`[acp] ${name} '${desc}' error: ${e.code || e.message}`); resolve(false); });
                proc.once('exit', code => { if (done) return; done = true; log(`[acp] ${name} '${desc}' exited (${code}) immediately`); resolve(false); });
                setTimeout(() => { if (done) return; done = true; resolve(true); }, 600);
            });
            if (survived) {
                STATE[name] = proc;
                proc.on('exit', code => log(`[acp] ${name} pid ${proc.pid} exited (${code})`));
                log(`[acp] spawned ${name} (pid ${proc.pid}) via "${desc}"`);
                return proc;
            }
        } catch (e) {
            log(`[acp] ${name} '${desc}' threw: ${e.message}`);
        }
    }
    log(`[acp] ${name} all spawn attempts failed`);
    return null;
}

async function ensureRunning({ names = ['kilo', 'opencode'], log = () => {} } = {}) {
    const status = {};
    for (const name of names) {
        const up = await isUp(name);
        if (up) { status[name] = 'already_up'; continue; }
        const proc = await spawnDaemon(name, log);
        status[name] = proc ? 'spawned' : 'unavailable';
    }
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

module.exports = { ensureRunning, waitForReady, isUp, spawnDaemon };
