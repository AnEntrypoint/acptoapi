'use strict';
// Spawn kilo and opencode ACP daemons in the background if not already running.
// Probes :4780/:4790 first; only spawns if the port is unreachable.

const { spawn } = require('child_process');
const { probe, resolveBackend } = require('./acp-client');

const STATE = { kilo: null, opencode: null }; // child process refs

const CMDS = {
    kilo: { command: process.env.KILO_ACP_CMD || 'kilo-acp', port: 4780 },
    opencode: { command: process.env.OPENCODE_ACP_CMD || 'opencode-acp', port: 4790 },
};

async function isUp(name) {
    try {
        const b = resolveBackend(name);
        return await probe(b, 1500);
    } catch { return false; }
}

function spawnDaemon(name, log) {
    if (STATE[name] && !STATE[name].killed) {
        log(`[acp] ${name} already spawned (pid ${STATE[name].pid})`);
        return;
    }
    const cfg = CMDS[name];
    if (!cfg) return;
    try {
        const proc = spawn(cfg.command, [], {
            stdio: 'ignore',
            detached: true,
            shell: process.platform === 'win32',
            windowsHide: true,
        });
        proc.unref();
        STATE[name] = proc;
        proc.on('error', e => log(`[acp] ${name} spawn error: ${e.message}`));
        proc.on('exit', code => log(`[acp] ${name} exited (${code})`));
        log(`[acp] spawned ${name} (pid ${proc.pid}, command "${cfg.command}")`);
    } catch (e) {
        log(`[acp] ${name} spawn failed: ${e.message}`);
    }
}

async function ensureRunning({ names = ['kilo', 'opencode'], log = () => {} } = {}) {
    const status = {};
    for (const name of names) {
        const up = await isUp(name);
        if (up) { status[name] = 'already_up'; continue; }
        spawnDaemon(name, log);
        status[name] = 'spawned';
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
