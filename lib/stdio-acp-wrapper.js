'use strict';
const { spawn, execSync } = require('child_process');
const { Readable, Writable } = require('stream');
const http = require('http');
const { EventEmitter } = require('events');
const { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } = require('@agentclientprotocol/sdk');

// Resolve a bare command name to its actual .exe on Windows. cmd.exe + .cmd
// shim chains re-enter conhost (visible window flash) even with
// windowsHide:true on the parent. Spawning the real .exe directly lets
// CREATE_NO_WINDOW propagate cleanly through one parent. Falls back to the
// original command name if no .exe is found on PATH.
function resolveWindowsExe(cmd) {
  if (process.platform !== 'win32') return cmd;
  try {
    const out = execSync(`where ${cmd}`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 800,
    });
    const lines = out.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const exe = lines.find(l => /\.exe$/i.test(l));
    return exe || lines[0] || cmd;
  } catch {
    return cmd;
  }
}

// Bridges a stdio ACP agent subprocess to an HTTP API. Uses the official
// @agentclientprotocol/sdk for protocol-correct JSON-RPC over ndjson.
class StdioAcpWrapper extends EventEmitter {
  constructor(name, command, args, port) {
    super();
    this.name = name;
    this.command = command;
    this.args = args;
    this.port = port;
    this.server = null;
    this.subprocess = null;
    this.conn = null;
    this.initResult = null;
    this.sessions = new Map();
    this.ready = false;
  }

  async start() {
    return new Promise((resolve, reject) => {
      try {
        // Windows console-window suppression: per the
        // windows-spawn-cmd-shim-flash discipline, going through cmd.exe
        // /D /S /C does NOT propagate CREATE_NO_WINDOW through .cmd shims
        // (bun.cmd, npx.cmd, kilo.cmd) — each shim layer re-enters conhost
        // and pops a visible window. Fix: resolve bare command names to
        // their actual .exe on PATH via `where`, then spawn the .exe
        // directly with windowsHide:true so CREATE_NO_WINDOW applies to
        // the console-subsystem binary itself. For bare shim names that
        // don't resolve to .exe (npx, kilo, opencode npm shims), fall
        // back to cmd.exe with windowsHide:true (the outer cmd is hidden
        // even if downstream shims still flash — that's the best we can
        // do without rewriting how those tools install themselves).
        // CREATE_NO_WINDOW (0x08000000) is inherited by all descendants —
        // .cmd shims that bun-x / npx download and launch never allocate
        // a console window. DETACHED_PROCESS (0x00000008) detaches the
        // process group so signals don't kill the daemon. These flags are
        // Windows-only; Node ignores creationFlags on POSIX.
        const CREATE_NO_WINDOW = 0x08000000;
        const DETACHED_PROCESS = 0x00000008;
        const spawnOpts = {
          stdio: ['pipe', 'pipe', 'pipe'],
          detached: process.platform === 'win32' ? true : false,
          windowsHide: true,
          creationFlags: CREATE_NO_WINDOW | DETACHED_PROCESS,
        };
        if (process.platform === 'win32') {
          const resolved = resolveWindowsExe(this.command);
          if (/\.exe$/i.test(resolved)) {
            this.subprocess = spawn(resolved, this.args, spawnOpts);
          } else {
            // Match acp-launcher.js spawnWindowsDaemon: pass args as separate
            // cmd.exe arguments (no windowsVerbatimArguments). The earlier
            // verbatim path caused .cmd shims to re-allocate conhost windows
            // because the quoting wrapped everything in one verbatim arg,
            // bypassing CREATE_NO_WINDOW inheritance through the shim chain.
            const quoted = this.args.map(a =>
              /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a
            ).join(' ');
            const fullCmd = `${resolved} ${quoted}`.trim();
            this.subprocess = spawn(process.env.ComSpec || 'cmd.exe', ['/D', '/S', '/C', fullCmd], {
              ...spawnOpts,
              windowsVerbatimArguments: false,
            });
          }
        } else {
          this.subprocess = spawn(this.command, this.args, spawnOpts);
        }
        this.subprocess.unref();

        this.subprocess.stderr.on('data', chunk => this.emit('stderr', chunk.toString()));
        this.subprocess.on('error', err => { this.emit('error', err); reject(err); });
        this.subprocess.on('exit', code => { this.emit('subprocess-exit', code); this.ready = false; });

        // Web Stream adapters around the subprocess pipes for the SDK.
        const input = Readable.toWeb(this.subprocess.stdout);
        const output = Writable.toWeb(this.subprocess.stdin);
        const stream = ndJsonStream(output, input);

        this.conn = new ClientSideConnection(() => this.buildClientHandler(), stream);

        this.server = http.createServer((req, res) => this.handleRequest(req, res));
        this.server.listen(this.port, '127.0.0.1', () => {
          this.ready = true;
          this.emit('ready');
          resolve();
        });
        this.server.on('error', err => { this.emit('error', err); reject(err); });
      } catch (err) {
        reject(err);
      }
    });
  }

  // Minimal client handler: agent → client requests/notifications. We accept
  // session/update streaming events and surface them via per-session emitters.
  buildClientHandler() {
    return {
      sessionUpdate: async (params) => {
        const s = this.sessions.get(params.sessionId);
        if (s) s.emitter.emit('update', params);
      },
      requestPermission: async () => ({ outcome: { outcome: 'cancelled' } }),
      readTextFile: async () => { throw new Error('fs not enabled'); },
      writeTextFile: async () => { throw new Error('fs not enabled'); },
    };
  }

  async ensureInitialized() {
    if (this.initResult) return this.initResult;
    this.initResult = await this.conn.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      clientInfo: { name: 'acptoapi', version: '1.0.0' },
    });
    return this.initResult;
  }

  handleRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const path = url.pathname;

    if (path === '/models' && req.method === 'GET') return this.handleListModels(req, res);
    if (path === '/session' && req.method === 'POST') return this.handleCreateSession(req, res);
    if (path.startsWith('/session/') && req.method === 'POST') {
      const parts = path.split('/');
      if (parts[3] === 'message') return this.handleMessage(req, res, parts[2]);
    }
    if (path === '/event' && req.method === 'GET') return this.handleEvents(req, res);

    res.writeHead(404);
    res.end('Not Found');
  }

  // Discover models from session/new response. Real ACP agents (gemini-cli,
  // opencode, kilo) advertise via TWO mechanisms — we accept either:
  //   1. result.models = { availableModels:[{modelId,name,description?}], currentModelId }
  //      (gemini-cli + opencode top-level extension)
  //   2. result.configOptions[].category === "model" with {currentValue, options:[{value,name}]}
  //      (opencode spec-compliant SessionConfigOption)
  async handleListModels(req, res) {
    try {
      await this.ensureInitialized();
      const result = await this.conn.newSession({ cwd: process.cwd(), mcpServers: [] });

      let models = [];
      let currentValue = null;
      let configId = null;

      const avail = result?.models?.availableModels;
      if (Array.isArray(avail) && avail.length) {
        models = avail.map(m => ({ id: m.modelId, name: m.name || m.modelId, description: m.description || null }));
        currentValue = result.models.currentModelId || null;
      } else {
        const configOptions = Array.isArray(result?.configOptions) ? result.configOptions : [];
        const modelOpt = configOptions.find(o => o?.category === 'model');
        const opts = Array.isArray(modelOpt?.options) ? modelOpt.options : [];
        models = opts.map(c => ({
          id: c?.value || c?.id,
          name: c?.name || c?.value || c?.id,
          description: c?.description || null,
        })).filter(m => m.id);
        currentValue = modelOpt?.currentValue || null;
        configId = modelOpt?.id || null;
      }

      this.conn.closeSession?.({ sessionId: result.sessionId }).catch(() => {});
      this.json(res, { models, currentValue, configId });
    } catch (err) {
      this.json(res, { models: [], error: err.message });
    }
  }

  async handleCreateSession(req, res) {
    try {
      await this.ensureInitialized();
      const result = await this.conn.newSession({ cwd: process.cwd(), mcpServers: [] });
      const id = result.sessionId;
      const emitter = new EventEmitter();
      emitter.setMaxListeners(0);
      this.sessions.set(id, { id, emitter, result });
      this.json(res, { id });
    } catch (err) {
      res.writeHead(500); res.end(err.message);
    }
  }

  async handleMessage(req, res, sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) { res.writeHead(404); res.end('Session not found'); return; }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      try {
        const msg = JSON.parse(body);
        const text = msg?.parts?.find(p => p.type === 'text')?.text
                  || (typeof msg?.text === 'string' ? msg.text : '')
                  || (typeof msg === 'string' ? msg : '');
        if (msg?.model?.modelID) {
          // Prefer session/set_model (kilo/opencode/gemini all implement this).
          // Fall back to session/set_config_option for spec-only agents.
          try {
            if (this.conn.unstable_setSessionModel) {
              await this.conn.unstable_setSessionModel({ sessionId, modelId: msg.model.modelID });
            } else {
              const configId = session.result?.configOptions?.find(o => o?.category === 'model')?.id;
              if (configId) await this.conn.setSessionConfigOption?.({ sessionId, configId, value: msg.model.modelID });
            }
          } catch {}
        }
        const promptResult = await this.conn.prompt({
          sessionId,
          prompt: [{ type: 'text', text }],
        });
        session.emitter.emit('update', { sessionId, update: { sessionUpdate: 'session.idle', stopReason: promptResult?.stopReason || 'end_turn' } });
        this.json(res, { ok: true });
      } catch (err) {
        res.writeHead(500); res.end(err.message);
      }
    });
  }

  handleEvents(req, res) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const forward = (params) => {
      try { res.write(`data: ${JSON.stringify(params)}\n\n`); } catch {}
    };
    for (const s of this.sessions.values()) s.emitter.on('update', forward);

    req.on('close', () => {
      for (const s of this.sessions.values()) s.emitter.off('update', forward);
    });
  }

  json(res, obj) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  }

  shutdown() {
    return new Promise(resolve => {
      const finish = () => {
        if (this.subprocess && !this.subprocess.killed) {
          this.subprocess.unref();
          this.subprocess.kill('SIGTERM');
          setTimeout(() => {
            if (this.subprocess && !this.subprocess.killed) this.subprocess.kill('SIGKILL');
            resolve();
          }, 1000);
        } else {
          resolve();
        }
      };
      if (this.server) this.server.close(finish); else finish();
    });
  }
}

module.exports = { StdioAcpWrapper };
