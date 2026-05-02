'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');

const DEFAULT_DIR = path.join(os.homedir(), '.claude', 'projects');
const DEBOUNCE_MS = 16;

class JsonlWatcher extends EventEmitter {
  constructor(projectsDir = DEFAULT_DIR) {
    super();
    this._dir = projectsDir;
    this._tails = new Map();
    this._convs = new Map();
    this._emitted = new Map();
    this._timers = new Map();
    this._seqs = new Map();
    this._streaming = new Set();
    this._watcher = null;
  }

  start() {
    if (!fs.existsSync(this._dir)) return this;
    this._scan(this._dir, 0);
    try {
      this._watcher = fs.watch(this._dir, { recursive: true }, (_, f) => {
        if (f && f.endsWith('.jsonl')) this._debounce(path.join(this._dir, f));
      });
      this._watcher.on('error', e => this.emit('error', e));
    } catch (e) { this.emit('error', e); }
    return this;
  }

  stop() {
    if (this._watcher) try { this._watcher.close(); } catch (_) {}
    for (const s of this._tails.values()) if (s.fd !== null) try { fs.closeSync(s.fd); } catch (_) {}
    for (const t of this._timers.values()) clearTimeout(t);
    this._tails.clear(); this._convs.clear(); this._emitted.clear();
    this._timers.clear(); this._seqs.clear(); this._streaming.clear();
  }

  _scan(dir, depth) {
    if (depth > 4) return;
    try {
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        const fp = path.join(dir, d.name);
        if (d.isFile() && d.name.endsWith('.jsonl')) this._debounce(fp);
        else if (d.isDirectory()) this._scan(fp, depth + 1);
      }
    } catch (_) {}
  }

  _debounce(fp) {
    const t = this._timers.get(fp);
    if (t) clearTimeout(t);
    this._timers.set(fp, setTimeout(() => { this._timers.delete(fp); this._read(fp); }, DEBOUNCE_MS));
  }

  _read(fp) {
    let s = this._tails.get(fp);
    if (!s) { s = { fd: null, offset: 0, partial: '' }; this._tails.set(fp, s); }
    try {
      if (s.fd === null) s.fd = fs.openSync(fp, 'r');
      const stat = fs.fstatSync(s.fd);
      if (stat.size <= s.offset) return;
      const buf = Buffer.allocUnsafe(stat.size - s.offset);
      const n = fs.readSync(s.fd, buf, 0, buf.length, s.offset);
      s.offset += n;
      const text = s.partial + buf.toString('utf8', 0, n);
      const lines = []; let start = 0, idx;
      while ((idx = text.indexOf('\n', start)) !== -1) { lines.push(text.slice(start, idx)); start = idx + 1; }
      s.partial = text.slice(start);
      const fallbackSid = path.basename(fp, '.jsonl');
      for (const l of lines) this._line(l, fallbackSid, fp);
    } catch (e) {
      if (e.code !== 'ENOENT') this.emit('error', e);
      if (s.fd !== null) { try { fs.closeSync(s.fd); } catch (_) {} s.fd = null; }
    }
  }

  _line(line, fallbackSid, fp) {
    line = line.trim();
    if (!line) return;
    let e;
    try { e = JSON.parse(line); } catch (_) { return; }
    if (!e) return;
    const sid = e.sessionId || fallbackSid;
    if (!sid) return;
    const conv = this._conv(sid, e, fp);
    if (!conv) return;
    this._route(conv, sid, e);
  }

  _conv(sid, e, fp) {
    if (this._convs.has(sid)) return this._convs.get(sid);
    if (e.type === 'queue-operation' || e.type === 'last-prompt') return null;
    if (e.type === 'user' && e.isMeta) return null;
    const dir = fp ? path.dirname(fp) : '';
    const isSubagent = /[\\/]subagents$/.test(dir);
    const projectDir = fp ? path.basename(isSubagent ? path.dirname(path.dirname(dir)) : path.dirname(fp)) : '';
    const parentSid = isSubagent ? path.basename(path.dirname(dir)) : null;
    const cwd = e.cwd || projectDir || '';
    const branch = e.gitBranch || '';
    const base = path.basename(cwd);
    const title = isSubagent ? `[agent] ${base}` : (branch ? `${branch} @ ${base}` : base);
    const conv = { id: sid, title, cwd, file: fp || null, parentSid, isSubagent };
    this._convs.set(sid, conv);
    this.emit('conversation_created', { conversation: conv, timestamp: Date.now() });
    return conv;
  }

  _seq(sid) { const n = (this._seqs.get(sid) || 0) + 1; this._seqs.set(sid, n); return n; }

  _startStreaming(conv, sid) {
    if (this._streaming.has(sid)) return;
    this._streaming.add(sid);
    this.emit('streaming_start', { conversationId: conv.id, conversation: conv, timestamp: Date.now() });
  }

  _endStreaming(conv, sid) {
    if (!this._streaming.has(sid)) return;
    this._streaming.delete(sid);
    this.emit('streaming_complete', { conversationId: conv.id, conversation: conv, seq: this._seq(sid), timestamp: Date.now() });
  }

  _push(conv, sid, block, role) {
    this.emit('streaming_progress', { conversationId: conv.id, conversation: conv, block, role, seq: this._seq(sid), timestamp: Date.now() });
  }

  _route(conv, sid, e) {
    if (e.type === 'queue-operation' || e.type === 'last-prompt') return;
    if (e.type === 'user' && e.isMeta) {
      this._startStreaming(conv, sid);
      const content = e.message?.content;
      const text = typeof content === 'string' ? content : (Array.isArray(content) ? content.filter(b => b?.type === 'text').map(b => b.text).join('') : '');
      if (text.trim()) this._push(conv, sid, { type: 'text', text, isMeta: true }, 'user');
      return;
    }
    if (e.isApiErrorMessage && e.error === 'rate_limit') {
      this.emit('streaming_error', { conversationId: conv.id, error: 'Rate limit hit', recoverable: true, timestamp: Date.now() });
      return;
    }
    if (e.type === 'system') {
      if (e.subtype === 'init') { this._startStreaming(conv, sid); return; }
      if (e.subtype === 'turn_duration' || e.subtype === 'stop_hook_summary') { this._endStreaming(conv, sid); return; }
      this._startStreaming(conv, sid);
      this._push(conv, sid, { type: 'system', subtype: e.subtype, model: e.model, cwd: e.cwd, tools: e.tools }, 'system');
      return;
    }
    if (e.type === 'assistant' && e.message?.content) {
      this._startStreaming(conv, sid);
      const key = `${sid}:${e.message.id}`;
      const prev = this._emitted.get(key) || 0;
      const newBlocks = e.message.content.slice(prev);
      if (newBlocks.length > 0) {
        this._emitted.set(key, e.message.content.length);
        for (const b of newBlocks) if (b?.type) this._push(conv, sid, b, 'assistant');
      }
      if (e.message.stop_reason) this._emitted.delete(key);
      return;
    }
    if (e.type === 'user' && e.message?.content) {
      this._startStreaming(conv, sid);
      const content = e.message.content;
      if (typeof content === 'string') {
        if (content.trim()) this._push(conv, sid, { type: 'text', text: content }, 'user');
      } else if (Array.isArray(content)) {
        for (const b of content) {
          if (!b || !b.type) continue;
          if (b.type === 'tool_result') this._push(conv, sid, b, 'tool_result');
          else this._push(conv, sid, b, 'user');
        }
      }
      return;
    }
    if (e.type === 'result') {
      this._push(conv, sid, { type: 'result', result: e.result, subtype: e.subtype, duration_ms: e.duration_ms, total_cost_usd: e.total_cost_usd, is_error: e.is_error || false }, 'result');
      this._endStreaming(conv, sid);
    }
  }
}

class JsonlReplayer extends JsonlWatcher {
  constructor(projectsDir = DEFAULT_DIR) { super(projectsDir); }

  replay({ since = 0, files: fileFilter = null } = {}) {
    const all = [];
    const collect = (dir, depth) => {
      if (depth > 5) return;
      try {
        for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
          const fp = path.join(dir, d.name);
          if (d.isFile() && d.name.endsWith('.jsonl')) all.push(fp);
          else if (d.isDirectory()) collect(fp, depth + 1);
        }
      } catch {}
    };
    if (fs.existsSync(this._dir)) collect(this._dir, 0);
    const chosen = fileFilter ? all.filter(fileFilter) : all;
    let emitted = 0;
    for (const fp of chosen) {
      const fallbackSid = path.basename(fp, '.jsonl');
      let data;
      try { data = fs.readFileSync(fp, 'utf8'); } catch { continue; }
      for (const line of data.split('\n')) {
        if (!line.trim()) continue;
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (!e) continue;
        const t = e.timestamp ? Date.parse(e.timestamp) : 0;
        if (since && t && t < since) continue;
        const sid = e.sessionId || fallbackSid;
        if (!sid) continue;
        const conv = this._conv(sid, e, fp);
        if (!conv) continue;
        this._route(conv, sid, e);
        emitted++;
      }
    }
    this.emit('replay_complete', { files: chosen.length, events: emitted, timestamp: Date.now() });
    return { files: chosen.length, events: emitted };
  }
}

module.exports = { JsonlWatcher, JsonlReplayer, DEFAULT_DIR };
