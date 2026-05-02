'use strict';
const path = require('path');
const { JsonlWatcher, JsonlReplayer, DEFAULT_DIR } = require('./watcher');
const { buildIndex, search, snippet, tokenize } = require('./bm25');

function blockText(b) {
  if (!b) return '';
  if (typeof b.text === 'string') return b.text;
  if (typeof b.content === 'string') return b.content;
  if (Array.isArray(b.content)) return b.content.map(c => c?.text || '').join('');
  if (b.input) { try { return JSON.stringify(b.input); } catch { return ''; } }
  return '';
}

function flattenEvent(ev, idx) {
  const c = ev.conversation || {};
  const b = ev.block || {};
  return {
    i: idx,
    ts: ev.timestamp || 0,
    sid: c.id || '',
    parent: c.parentSid || null,
    cwd: c.cwd || '',
    project: path.basename(c.cwd || ''),
    isSubagent: !!c.isSubagent,
    role: ev.role,
    type: b.type || null,
    tool: b.name || null,
    text: blockText(b),
    isError: !!b.is_error || ev.role === 'streaming_error',
    cost: b.total_cost_usd || null,
    duration: b.duration_ms || null,
    subtype: b.subtype || null,
    model: b.model || null,
  };
}

class HistoryStore {
  constructor(projectsDir) {
    this.projectsDir = projectsDir || DEFAULT_DIR;
    this.events = [];
    this.errors = [];
    this.fileCount = 0;
    this.index = null;
    this.lastBuilt = 0;
    this.watcher = null;
    this.sseClients = new Set();
    this.convs = new Map();
  }

  loadOnce() {
    const r = new JsonlReplayer(this.projectsDir);
    let i = 0;
    r.on('conversation_created', ev => this.convs.set(ev.conversation.id, ev.conversation));
    r.on('streaming_progress', ev => { this.events.push(flattenEvent(ev, i++)); });
    r.on('streaming_error', ev => { this.errors.push({ ts: ev.timestamp, sid: ev.conversationId, error: ev.error, recoverable: ev.recoverable }); });
    const stats = r.replay({});
    this.fileCount = stats.files;
    this.rebuildIndex();
    return stats;
  }

  rebuildIndex() {
    this.index = buildIndex(this.events, e => e.text);
    this.lastBuilt = Date.now();
  }

  startLive() {
    if (this.watcher) return;
    this.watcher = new JsonlWatcher(this.projectsDir);
    this.watcher.on('conversation_created', ev => { this.convs.set(ev.conversation.id, ev.conversation); this.broadcast('conversation', { conv: ev.conversation, ts: ev.timestamp }); });
    this.watcher.on('streaming_progress', ev => {
      const fl = flattenEvent(ev, this.events.length);
      this.events.push(fl);
      this.broadcast('event', fl);
    });
    this.watcher.on('streaming_error', ev => {
      const e = { ts: ev.timestamp, sid: ev.conversationId, error: ev.error, recoverable: ev.recoverable };
      this.errors.push(e);
      this.broadcast('error', e);
    });
    this.watcher.on('streaming_start', ev => this.broadcast('start', { sid: ev.conversationId, ts: ev.timestamp }));
    this.watcher.on('streaming_complete', ev => this.broadcast('complete', { sid: ev.conversationId, ts: ev.timestamp }));
    this.watcher.start();
  }

  stop() {
    if (this.watcher) this.watcher.stop();
    for (const r of this.sseClients) try { r.end(); } catch {}
    this.sseClients.clear();
  }

  broadcast(kind, data) {
    const payload = `event: ${kind}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.sseClients) { try { res.write(payload); } catch {} }
  }

  snapshot() {
    const sids = new Set(), projects = new Set(), tools = new Map();
    let earliest = Infinity, latest = 0, bytes = 0;
    for (const e of this.events) {
      sids.add(e.sid); if (e.project) projects.add(e.project);
      if (e.tool) tools.set(e.tool, (tools.get(e.tool) || 0) + 1);
      if (e.ts < earliest) earliest = e.ts;
      if (e.ts > latest) latest = e.ts;
      bytes += (e.text || '').length;
    }
    return {
      events: this.events.length, sessions: sids.size, projects: projects.size,
      tools: tools.size, errors: this.errors.length, files: this.fileCount,
      bytes, earliest: earliest === Infinity ? 0 : earliest, latest, indexedAt: this.lastBuilt,
    };
  }

  sessions() {
    const map = new Map();
    for (const e of this.events) {
      let s = map.get(e.sid);
      if (!s) {
        const conv = this.convs.get(e.sid) || {};
        s = { sid: e.sid, title: conv.title || '', project: e.project, cwd: e.cwd, parent: e.parent, isSubagent: e.isSubagent, first: e.ts, last: e.ts, events: 0, tools: 0, userTurns: 0, cost: 0, errors: 0 };
        map.set(e.sid, s);
      }
      s.events++;
      if (e.ts < s.first) s.first = e.ts;
      if (e.ts > s.last) s.last = e.ts;
      if (e.type === 'tool_use') s.tools++;
      if (e.role === 'user' && e.type === 'text') s.userTurns++;
      if (e.cost) s.cost += e.cost;
      if (e.isError) s.errors++;
    }
    return [...map.values()].sort((a, b) => b.last - a.last);
  }

  sessionEvents(sid) {
    return this.events.filter(e => e.sid === sid);
  }

  search(q, { limit = 50, role, type, project, sid } = {}) {
    if (!this.index) this.rebuildIndex();
    const hits = search(this.index, q, { limit: limit * 4 });
    const out = [];
    for (const h of hits) {
      const e = this.events[h.i];
      if (role && e.role !== role) continue;
      if (type && e.type !== type) continue;
      if (project && e.project !== project) continue;
      if (sid && !e.sid.startsWith(sid)) continue;
      out.push({ ...e, score: h.score, terms: h.terms, snippet: snippet(e.text, h.terms) });
      if (out.length >= limit) break;
    }
    return out;
  }
}

let _shared = null;
function getStore(projectsDir) {
  if (_shared) return _shared;
  _shared = new HistoryStore(projectsDir);
  _shared.loadOnce();
  _shared.startLive();
  return _shared;
}

module.exports = { HistoryStore, getStore, flattenEvent, blockText };
