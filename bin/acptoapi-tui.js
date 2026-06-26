#!/usr/bin/env node
'use strict';
// acptoapi-tui — atomic CLI by default, optional interactive TUI.
//
// Default (no args): prints help.
// Subcommands (atomic, JSON to stdout — agent-friendly):
//   status                       merged snapshot of server health + key counts
//   chains [list|get N|add N L…|del N]
//   queues [list|get N|add N L…|del N]
//   models                       working models from /debug/probe-live
//   sampler                      provider availability + backoff
//   runs                         recent chain run history
//   providers                    ACP daemon health
//   auto-chain                   resolved fallback order
//   config                       redacted server config
//   metrics                      prometheus-style metrics text
//   tui                          enter interactive multi-pane TUI
//
// Env: ACPTOAPI_URL (default http://localhost:4800), ACPTOAPI_API_KEY (legacy AGENTAPI_API_KEY also honored).

const fs = require('fs');
const path = require('path');
const os = require('os');

const URL_ = process.env.ACPTOAPI_URL || 'http://localhost:4800';
const KEY = process.env.ACPTOAPI_API_KEY || process.env.AGENTAPI_API_KEY || '';
const CHAINS_PATH = process.env.ACPTOAPI_CHAINS_PATH || path.join(os.homedir(), '.acptoapi', 'chains.json');
const QUEUES_PATH = process.env.ACPTOAPI_QUEUES_PATH || path.join(os.homedir(), '.acptoapi', 'queues.json');
const H = KEY ? { authorization: 'Bearer ' + KEY } : {};

async function api(p, init) {
  const r = await fetch(URL_ + p, { ...(init || {}), headers: { ...H, ...(init && init.body ? { 'content-type': 'application/json' } : {}) } }).catch(e => ({ ok: false, _err: e.message }));
  if (!r.ok) return { ok: false, status: r.status, error: r._err || ('http ' + r.status) };
  const txt = await r.text();
  try { return { ok: true, data: JSON.parse(txt) }; } catch { return { ok: true, data: txt }; }
}

function readLocal(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function writeLocal(file, obj) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(obj, null, 2)); }

function out(obj) { process.stdout.write(JSON.stringify(obj, null, 2) + '\n'); }
function die(msg, code = 1) { process.stderr.write(msg + '\n'); process.exit(code); }

const HELP = `acptoapi-tui — observe and configure a running acptoapi server

USAGE
  acptoapi-tui                       show this help
  acptoapi-tui tui                   open interactive multi-pane TUI
  acptoapi-tui <verb> [args]         atomic JSON for agents / scripting

OBSERVE
  status                             merged snapshot (health + chain/model/run counts)
  chains [get <name>]                list / inspect named fallback chains
  queues [get <name>]                list / inspect named model queues
  models                             working models from live probe (latency-sorted)
  sampler                            per-provider availability + backoff state
  runs                               recent chain runs with fallback history
  providers                          ACP daemon health probes
  auto-chain                         the resolved auto-fallback order
  config                             redacted server config (env keys, defaults)
  metrics                            prometheus-style metrics text

CONFIGURE
  chains add <name> <model> [model…]   create / overwrite a runtime chain
  chains del <name>                    delete a runtime chain
  queues add <name> <model> [model…]   create / overwrite a named queue
  queues del <name>                    delete a named queue

ENV
  ACPTOAPI_URL          server base URL (default http://localhost:4800)
  ACPTOAPI_API_KEY      bearer token if server requires auth (legacy AGENTAPI_API_KEY also honored)
  ACPTOAPI_CHAINS_PATH  local fallback when server unreachable (default ~/.acptoapi/chains.json)
  ACPTOAPI_QUEUES_PATH  local fallback queues file (default ~/.acptoapi/queues.json)

EXAMPLES
  acptoapi-tui status
  acptoapi-tui chains add fast groq/llama-3.3-70b-versatile cerebras/llama-3.3-70b
  acptoapi-tui models | jq '.[] | select(.latencyMs < 500)'
  acptoapi-tui tui
`;

// ---------- atomic subcommands ----------
async function cmdStatus() {
  const [h, c, m, s, r, p] = await Promise.all([api('/health'), api('/v1/chains'), api('/debug/probe-live'), api('/v1/sampler/status'), api('/v1/runs'), api('/debug/providers')]);
  out({
    server: URL_,
    reachable: h.ok,
    backends: h.ok && h.data ? h.data.backends || [] : [],
    chains: c.ok && c.data ? Object.keys(c.data.chains || {}).length : 0,
    builtin_chains: c.ok && c.data ? (c.data.builtin || []).length : 0,
    working_models: m.ok && m.data ? (m.data.models || m.data.results || []).length : 0,
    sampler_entries: s.ok && s.data ? (s.data.status || []).length : 0,
    recent_runs: r.ok && r.data ? (r.data.runs || []).length : 0,
    providers_up: p.ok && Array.isArray(p.data) ? p.data.filter(x => x.status === 'ok').length : 0,
    providers_total: p.ok && Array.isArray(p.data) ? p.data.length : 0,
  });
}

async function cmdChains(args) {
  const sub = args[0];
  if (!sub || sub === 'list') {
    const r = await api('/v1/chains');
    if (r.ok) return out(r.data);
    return out({ chains: readLocal(CHAINS_PATH) || {}, builtin: [], source: 'file' });
  }
  if (sub === 'get') {
    const name = args[1] || die('chains get <name>');
    const r = await api('/v1/chains');
    if (r.ok) return out({ name, links: (r.data.chains || {})[name] || null });
    const local = readLocal(CHAINS_PATH) || {};
    return out({ name, links: local[name] || null });
  }
  if (sub === 'add') {
    const name = args[1] || die('chains add <name> <model> [model…]');
    const links = args.slice(2);
    if (!links.length) die('need at least one model');
    const r = await api('/v1/chains', { method: 'POST', body: JSON.stringify({ name, links }) });
    if (r.ok) return out(r.data);
    const all = readLocal(CHAINS_PATH) || {};
    all[name] = links; writeLocal(CHAINS_PATH, all);
    return out({ ok: true, name, links, source: 'file' });
  }
  if (sub === 'del') {
    const name = args[1] || die('chains del <name>');
    const r = await api('/v1/chains?name=' + encodeURIComponent(name), { method: 'DELETE' });
    if (r.ok) return out(r.data);
    const all = readLocal(CHAINS_PATH) || {};
    delete all[name]; writeLocal(CHAINS_PATH, all);
    return out({ ok: true, name, source: 'file' });
  }
  die('unknown chains subcommand: ' + sub);
}

async function cmdQueues(args) {
  const sub = args[0];
  const readQ = () => { const f = readLocal(QUEUES_PATH); return (f && f.queues) || f || {}; };
  if (!sub || sub === 'list') {
    const r = await api('/v1/queues');
    if (r.ok) return out(r.data);
    return out({ queues: readQ(), source: 'file' });
  }
  if (sub === 'get') {
    const name = args[1] || die('queues get <name>');
    return out({ name, links: readQ()[name] || null });
  }
  if (sub === 'add') {
    const name = args[1] || die('queues add <name> <model> [model…]');
    const links = args.slice(2);
    if (!links.length) die('need at least one model');
    const f = readLocal(QUEUES_PATH) || { queues: {} };
    if (!f.queues) f.queues = {};
    f.queues[name] = links; writeLocal(QUEUES_PATH, f);
    return out({ ok: true, name, links });
  }
  if (sub === 'del') {
    const name = args[1] || die('queues del <name>');
    const f = readLocal(QUEUES_PATH) || { queues: {} };
    if (f.queues) delete f.queues[name];
    writeLocal(QUEUES_PATH, f);
    return out({ ok: true, name });
  }
  die('unknown queues subcommand: ' + sub);
}

async function cmdSimple(endpoint) {
  const r = await api(endpoint);
  if (!r.ok) die('server unreachable at ' + URL_ + ' (' + (r.error || r.status) + ')', 2);
  out(r.data);
}

// ---------- interactive TUI ----------
async function runTui() {
  if (!process.stdin.isTTY) die('TUI needs a TTY; use atomic subcommands instead — see `acptoapi-tui` for help', 1);
  const readline = require('readline');
  const E = '\x1b[';
  const w = (s) => process.stdout.write(s);
  const fmt = (c, s) => `${E}${c}m${s}${E}0m`;
  const bold = s => fmt(1, s), dim = s => fmt(2, s), inv = s => fmt(7, s);
  const cyan = s => fmt(36, s), yellow = s => fmt(33, s), red = s => fmt(31, s), green = s => fmt(32, s), gray = s => fmt(90, s);
  const stripAnsi = s => String(s).replace(/\x1b\[[0-9;]*m/g, '');
  const trunc = (s, n) => { const v = stripAnsi(s); if (v.length <= n) return s + ' '.repeat(n - v.length); return v.slice(0, n - 1) + '…'; };

  const TABS = [
    { name: 'Chains', fetch: async () => {
        const r = await api('/v1/chains');
        if (r.ok) return Object.entries(r.data.chains || {}).map(([n, l]) => ({ n, l, b: (r.data.builtin || []).includes(n) }));
        const local = readLocal(CHAINS_PATH) || {};
        return Object.entries(local).map(([n, l]) => ({ n, l, b: false }));
      },
      cols: [
        { t: 'name', w: 22, g: r => r.n },
        { t: 'links', w: 56, g: r => r.l.slice(0, 4).join(', ') + (r.l.length > 4 ? ` (+${r.l.length - 4})` : '') },
        { t: 'kind', w: 10, g: r => r.b ? gray('builtin') : cyan('runtime') },
      ],
      editable: true,
    },
    { name: 'Queues', fetch: async () => {
        const r = await api('/v1/queues');
        const qs = r.ok && r.data && Array.isArray(r.data.queues) ? r.data.queues : Object.entries((readLocal(QUEUES_PATH) || {}).queues || readLocal(QUEUES_PATH) || {}).map(([name, links]) => ({ name, links }));
        return qs;
      },
      cols: [
        { t: 'name', w: 22, g: r => r.name },
        { t: 'links', w: 56, g: r => (r.links || []).slice(0, 4).join(', ') + ((r.links || []).length > 4 ? ` (+${r.links.length - 4})` : '') },
        { t: 'source', w: 10, g: r => gray(r.source || '—') },
      ],
    },
    { name: 'Models', fetch: async () => {
        const r = await api('/debug/probe-live');
        return r.ok && r.data ? (r.data.models || r.data.results || []) : [];
      },
      cols: [
        { t: 'provider', w: 18, g: r => r.provider || (r.model || '').split('/')[0] },
        { t: 'model', w: 50, g: r => r.model || r.id || '' },
        { t: 'latency', w: 12, g: r => { const ms = r.latencyMs || r.latency_ms; if (!ms) return gray('—'); return ms < 500 ? green(ms + 'ms') : ms < 2000 ? yellow(ms + 'ms') : red(ms + 'ms'); } },
      ],
    },
    { name: 'Sampler', fetch: async () => { const r = await api('/v1/sampler/status'); return r.ok && r.data ? (r.data.status || []) : []; },
      cols: [
        { t: 'provider', w: 24, g: r => r.provider },
        { t: 'status', w: 14, g: r => r.ok === false ? red('● failing') : r.ok ? green('● ok') : gray('● unknown') },
        { t: 'fails', w: 8, g: r => String(r.failCount || 0) },
        { t: 'next', w: 12, g: r => r.nextCheckIn > 0 ? Math.ceil(r.nextCheckIn / 1000) + 's' : '—' },
      ],
    },
    { name: 'Runs', fetch: async () => { const r = await api('/v1/runs'); return r.ok && r.data ? (r.data.runs || []) : []; },
      cols: [
        { t: 'when', w: 10, g: r => r.ts ? Math.floor((Date.now() - r.ts) / 1000) + 's' : '—' },
        { t: 'requested', w: 28, g: r => r.requestedModel || '?' },
        { t: 'final', w: 28, g: r => r.finalModel || '—' },
        { t: 'hops', w: 6, g: r => String((r.history || r.attempted || []).length || 1) },
        { t: 'ok', w: 6, g: r => r.finalModel ? green('ok') : red('x') },
      ],
    },
    { name: 'Providers', fetch: async () => { const r = await api('/debug/providers'); return r.ok && Array.isArray(r.data) ? r.data : []; },
      cols: [
        { t: 'name', w: 24, g: r => r.name },
        { t: 'status', w: 18, g: r => r.status === 'ok' ? green('● up') : red('● ' + r.status) },
        { t: 'latency', w: 12, g: r => r.latencyMs != null ? r.latencyMs + 'ms' : '—' },
      ],
    },
    { name: 'AutoChain', fetch: async () => { const r = await api('/debug/auto-chain'); return r.ok && r.data && Array.isArray(r.data.links) ? r.data.links.map((l, i) => ({ rank: i + 1, ...l })) : []; },
      cols: [
        { t: 'rank', w: 6, g: r => String(r.rank) },
        { t: 'model', w: 50, g: r => r.model || '?' },
        { t: 'fallback on', w: 24, g: r => Array.isArray(r.fallbackOn) ? r.fallbackOn.join(',') : '—' },
      ],
    },
    { name: 'Config', fetch: async () => {
        const r = await api('/debug/config');
        if (!r.ok || !r.data) return [];
        return Object.entries(r.data).flatMap(([k, v]) => {
          if (v && typeof v === 'object' && !Array.isArray(v)) return Object.entries(v).map(([k2, v2]) => ({ section: k, key: k2, value: JSON.stringify(v2) }));
          return [{ section: '(root)', key: k, value: JSON.stringify(v) }];
        });
      },
      cols: [
        { t: 'section', w: 18, g: r => r.section },
        { t: 'key', w: 28, g: r => r.key },
        { t: 'value', w: 50, g: r => r.value },
      ],
    },
  ];

  const S = { tab: 0, cur: TABS.map(() => 0), data: TABS.map(() => []), mode: 'browse', filter: '', editing: null, msg: '', input: '', inputPrompt: '', onSubmit: null };
  const size = () => ({ rows: process.stdout.rows || 24, cols: process.stdout.columns || 80 });

  async function refresh() {
    await Promise.all(TABS.map(async (t, i) => { S.data[i] = await t.fetch(); }));
    for (let i = 0; i < TABS.length; i++) if (S.cur[i] >= S.data[i].length) S.cur[i] = Math.max(0, S.data[i].length - 1);
  }

  function render() {
    const { rows, cols } = size();
    w(E + '2J' + E + 'H');
    const tabs = TABS.map((t, i) => i === S.tab ? inv(bold(` ${i + 1} ${t.name} `)) : dim(` ${i + 1} ${t.name} `)).join('');
    w(' ' + bold(inv(' acptoapi ')) + tabs + '\n');
    w(' ' + green('● ' + URL_) + (S.filter ? '  ' + dim('filter:') + cyan(' /' + S.filter) : '') + dim('   (auto-refresh 5s)') + '\n');
    w(dim('─'.repeat(cols)) + '\n');

    if (S.mode === 'help') {
      const lines = [
        '', bold(' TUI keys'),
        '   1-' + TABS.length + ' / <-> / tab    switch tab',
        '   up/down              move',
        '   enter               edit (Chains/Queues) / detail',
        '   n / d               new / delete row',
        '   /                   filter (esc to clear)',
        '   r                   refresh',
        '   ?                   help',
        '   q                   quit',
        '', bold(' Editor'),
        '   a                   add line',
        '   d                   delete highlighted',
        '   s                   save',
        '   esc                 cancel',
        '',
        dim(' Atomic CLI (no TUI):'), '   ' + dim(process.argv[1] + ' <verb>'), '',
      ];
      lines.forEach(l => w(' ' + l + '\n'));
    } else if (S.mode === 'edit' || S.mode === 'new') {
      const e = S.editing;
      w(' ' + bold('editing: ') + cyan(e.name || '<new>') + (S.mode === 'new' ? yellow('  [new]') : '') + '\n');
      w(dim('─'.repeat(cols)) + '\n');
      e.items.forEach((it, i) => { const line = ' ' + String(i + 1).padStart(3) + '  ' + it; w((i === e.cursor ? inv(line) : line) + '\n'); });
    } else {
      const tab = TABS[S.tab], data = S.data[S.tab], cur = S.cur[S.tab];
      const filt = S.filter.toLowerCase();
      const rows_ = filt ? data.filter(r => tab.cols.some(c => stripAnsi(String(c.g(r))).toLowerCase().includes(filt))) : data;
      w(' ' + tab.cols.map(c => bold(trunc(c.t, c.w))).join(' ') + '\n');
      const max = rows.length - 6;
      let start = 0; if (cur >= max) start = cur - max + 1;
      for (let i = start; i < Math.min(rows_.length, start + max); i++) {
        const line = ' ' + tab.cols.map(c => trunc(c.g(rows_[i]), c.w)).join(' ');
        w((i === cur ? inv(stripAnsi(line)) : line) + '\n');
      }
      if (rows_.length === 0) w(' ' + dim('(no rows — server reachable? auto-refresh in 5s)') + '\n');
    }

    w(E + size().rows + ';1H');
    if (S.mode === 'input') w(' ' + S.inputPrompt + S.input + '_');
    else if (S.msg) w(' ' + S.msg);
    else if (S.mode === 'help') w(dim(' [any key] back '));
    else if (S.mode === 'edit' || S.mode === 'new') w(dim(' [up/down] move  [a] add  [d] del  [s] save  [esc] cancel '));
    else w(dim(` [1-${TABS.length}/<->] tabs  [up/down] move  [enter] open  [n] new  [d] del  [/] filter  [r] refresh  [?] help  [q] quit `));
  }

  const flash = (m, c = 'cyan') => { S.msg = ({ cyan, green, red, yellow })[c](m); render(); setTimeout(() => { S.msg = ''; render(); }, 1500); };
  const startInput = (p, cb, init = '') => { S.mode = 'input'; S.inputPrompt = p; S.input = init; S.onSubmit = cb; render(); };

  async function key(str, k) {
    k = k || {};
    if (k.ctrl && k.name === 'c') { cleanup(); process.exit(0); }
    if (S.mode === 'input') {
      if (k.name === 'return') { const v = S.input.trim(); const cb = S.onSubmit; S.mode = S.editing ? (S.data[S.tab].some(r => r.n === S.editing.name) ? 'edit' : 'new') : 'browse'; S.onSubmit = null; if (cb) await cb(v); render(); return; }
      if (k.name === 'escape') { S.mode = S.editing ? 'edit' : 'browse'; S.onSubmit = null; render(); return; }
      if (k.name === 'backspace') S.input = S.input.slice(0, -1);
      else if (str && str.length === 1 && str >= ' ') S.input += str;
      render(); return;
    }
    if (k.name === 'q' && S.mode !== 'edit' && S.mode !== 'new') { cleanup(); process.exit(0); }
    if (S.mode === 'help') { S.mode = 'browse'; render(); return; }

    if (S.mode === 'edit' || S.mode === 'new') {
      const e = S.editing;
      if (k.name === 'escape') { S.mode = 'browse'; S.editing = null; render(); return; }
      if (k.name === 'up') { e.cursor = Math.max(0, e.cursor - 1); render(); return; }
      if (k.name === 'down') { e.cursor = Math.min(Math.max(0, e.items.length - 1), e.cursor + 1); render(); return; }
      if (k.name === 'a') { startInput('add link: ', v => { if (v) { e.items.push(v); e.cursor = e.items.length - 1; } }); return; }
      if (k.name === 'd') { if (e.items.length) { e.items.splice(e.cursor, 1); e.cursor = Math.max(0, Math.min(e.items.length - 1, e.cursor)); } render(); return; }
      if (k.name === 's') {
        if (!e.name) return flash('needs name', 'red');
        if (!e.items.length) return flash('needs >=1 link', 'red');
        let ok = false;
        if (e.kind === 'chain') {
          const r = await api('/v1/chains', { method: 'POST', body: JSON.stringify({ name: e.name, links: e.items }) });
          if (r.ok) ok = true; else { const all = readLocal(CHAINS_PATH) || {}; all[e.name] = e.items; writeLocal(CHAINS_PATH, all); ok = true; }
        } else if (e.kind === 'queue') {
          const f = readLocal(QUEUES_PATH) || { queues: {} }; if (!f.queues) f.queues = {};
          f.queues[e.name] = e.items; writeLocal(QUEUES_PATH, f); ok = true;
        }
        if (ok) { flash('saved ' + e.name, 'green'); S.mode = 'browse'; S.editing = null; await refresh(); render(); } else flash('save failed', 'red');
        return;
      }
      return;
    }

    if (k.name === '/') { startInput('filter: ', v => { S.filter = v; }, S.filter); return; }
    if (k.name === 'escape') { S.filter = ''; render(); return; }
    if (k.name >= '1' && k.name <= String(TABS.length)) { S.tab = +k.name - 1; render(); return; }
    if (k.name === 'right' || k.name === 'tab') { S.tab = (S.tab + 1) % TABS.length; render(); return; }
    if (k.name === 'left') { S.tab = (S.tab - 1 + TABS.length) % TABS.length; render(); return; }
    if (k.name === 'up') { S.cur[S.tab] = Math.max(0, S.cur[S.tab] - 1); render(); return; }
    if (k.name === 'down') { S.cur[S.tab] = Math.min(Math.max(0, S.data[S.tab].length - 1), S.cur[S.tab] + 1); render(); return; }
    if (k.name === 'r') { await refresh(); flash('refreshed', 'green'); return; }
    if (k.name === '?' || str === '?') { S.mode = 'help'; render(); return; }

    const tabName = TABS[S.tab].name;
    if (tabName === 'Chains') {
      if (k.name === 'return') { const row = S.data[S.tab][S.cur[S.tab]]; if (!row) return; if (row.b) return flash('builtin read-only', 'yellow'); S.editing = { kind: 'chain', name: row.n, items: [...row.l], cursor: 0 }; S.mode = 'edit'; render(); return; }
      if (k.name === 'n') { S.editing = { kind: 'chain', name: '', items: [], cursor: 0 }; startInput('chain name: ', v => { S.editing.name = v; S.mode = 'new'; }); return; }
      if (k.name === 'd') {
        const row = S.data[S.tab][S.cur[S.tab]];
        if (!row || row.b) return flash(row && row.b ? 'builtin' : 'no row', 'yellow');
        const r = await api('/v1/chains?name=' + encodeURIComponent(row.n), { method: 'DELETE' });
        let ok = r.ok;
        if (!ok) { const all = readLocal(CHAINS_PATH) || {}; delete all[row.n]; writeLocal(CHAINS_PATH, all); ok = true; }
        if (ok) await refresh();
        flash(ok ? 'deleted' : 'failed', ok ? 'green' : 'red'); return;
      }
    } else if (tabName === 'Queues') {
      if (k.name === 'return') { const row = S.data[S.tab][S.cur[S.tab]]; if (!row) return; S.editing = { kind: 'queue', name: row.name, items: [...(row.links || [])], cursor: 0 }; S.mode = 'edit'; render(); return; }
      if (k.name === 'n') { S.editing = { kind: 'queue', name: '', items: [], cursor: 0 }; startInput('queue name: ', v => { S.editing.name = v; S.mode = 'new'; }); return; }
      if (k.name === 'd') {
        const row = S.data[S.tab][S.cur[S.tab]];
        if (!row) return;
        const f = readLocal(QUEUES_PATH) || { queues: {} }; if (f.queues) delete f.queues[row.name]; writeLocal(QUEUES_PATH, f);
        await refresh(); flash('deleted', 'green'); return;
      }
    } else if (tabName === 'Runs' && k.name === 'return') {
      const r = S.data[S.tab][S.cur[S.tab]];
      if (r) flash(JSON.stringify((r.history || r.attempted || []).map(h => h.model || h)), 'cyan');
    }
  }

  function cleanup() { w(E + '?25h' + E + '0m' + E + '2J' + E + 'H'); if (process.stdin.isTTY) try { process.stdin.setRawMode(false); } catch {} }

  await refresh();
  w(E + '?25l');
  render();
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.on('keypress', (str, k) => key(str, k).catch(e => flash(e.message, 'red')));
  process.on('SIGINT', () => { cleanup(); process.exit(0); });
  process.on('exit', cleanup);
  process.stdout.on('resize', render);
  setInterval(async () => { if (S.mode === 'browse') { await refresh(); render(); } }, 5000);
}

// ---------- dispatch ----------
async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === '-h' || cmd === '--help' || cmd === 'help') { process.stdout.write(HELP); return; }
  const rest = argv.slice(1);
  try {
    switch (cmd) {
      case 'tui':         return runTui();
      case 'status':      return cmdStatus();
      case 'chains':      return cmdChains(rest);
      case 'queues':      return cmdQueues(rest);
      case 'models':      return cmdSimple('/debug/probe-live');
      case 'sampler':     return cmdSimple('/v1/sampler/status');
      case 'runs':        return cmdSimple('/v1/runs');
      case 'providers':   return cmdSimple('/debug/providers');
      case 'auto-chain':  return cmdSimple('/debug/auto-chain');
      case 'config':      return cmdSimple('/debug/config');
      case 'metrics': {
        const r = await api('/metrics');
        if (!r.ok) die('server unreachable at ' + URL_, 2);
        process.stdout.write(typeof r.data === 'string' ? r.data : JSON.stringify(r.data));
        return;
      }
      default:
        process.stderr.write('unknown command: ' + cmd + '\n\n' + HELP);
        process.exit(2);
    }
  } catch (e) { die(e.stack || e.message || String(e), 1); }
}

main();
