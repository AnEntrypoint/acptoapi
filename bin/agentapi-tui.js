#!/usr/bin/env node
'use strict';
// acptoapi TUI — curses-like terminal UI for editing named fallback chains.
// Uses raw ANSI escape sequences so we have zero dependencies.
// Talks to a running acptoapi server via /v1/chains. Falls back to direct
// named-chains.js manipulation when no server is running.

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

// ANSI helpers
const ESC = '\x1b[';
const clear = () => process.stdout.write(ESC + '2J' + ESC + 'H');
const move = (r, c) => process.stdout.write(ESC + r + ';' + c + 'H');
const dim = (s) => '\x1b[2m' + s + '\x1b[0m';
const bold = (s) => '\x1b[1m' + s + '\x1b[0m';
const inv = (s) => '\x1b[7m' + s + '\x1b[0m';
const cyan = (s) => '\x1b[36m' + s + '\x1b[0m';
const yellow = (s) => '\x1b[33m' + s + '\x1b[0m';
const red = (s) => '\x1b[31m' + s + '\x1b[0m';
const green = (s) => '\x1b[32m' + s + '\x1b[0m';
const hideCursor = () => process.stdout.write(ESC + '?25l');
const showCursor = () => process.stdout.write(ESC + '?25h');

function termSize() {
    return { rows: process.stdout.rows || 24, cols: process.stdout.columns || 80 };
}

// ---------- chain source: server first, then local file ----------
const CHAINS_FILE = process.env.ACPTOAPI_CHAINS_PATH || path.join(os.homedir(), '.acptoapi', 'chains.json');
const SERVER_URL = process.env.ACPTOAPI_URL || 'http://localhost:4800';
const API_KEY = process.env.AGENTAPI_API_KEY || '';

async function serverGet() {
    try {
        const r = await fetch(SERVER_URL + '/v1/chains', { headers: { authorization: 'Bearer ' + (API_KEY || 'none') } });
        if (!r.ok) return null;
        return await r.json();
    } catch { return null; }
}

async function serverPost(name, links) {
    try {
        const r = await fetch(SERVER_URL + '/v1/chains', {
            method: 'POST',
            headers: { 'content-type': 'application/json', authorization: 'Bearer ' + (API_KEY || 'none') },
            body: JSON.stringify({ name, links }),
        });
        return r.ok;
    } catch { return false; }
}

async function serverDelete(name) {
    try {
        const r = await fetch(SERVER_URL + '/v1/chains?name=' + encodeURIComponent(name), {
            method: 'DELETE',
            headers: { authorization: 'Bearer ' + (API_KEY || 'none') },
        });
        return r.ok;
    } catch { return false; }
}

function loadFromFile() {
    try {
        if (!fs.existsSync(CHAINS_FILE)) return {};
        return JSON.parse(fs.readFileSync(CHAINS_FILE, 'utf8')) || {};
    } catch { return {}; }
}

function writeToFile(obj) {
    fs.mkdirSync(path.dirname(CHAINS_FILE), { recursive: true });
    fs.writeFileSync(CHAINS_FILE, JSON.stringify(obj, null, 2));
}

// ---------- model probe info ----------
async function probeResults() {
    try {
        const r = await fetch(SERVER_URL + '/debug/probe-live', { headers: { authorization: 'Bearer ' + (API_KEY || 'none') } });
        if (!r.ok) return null;
        const j = await r.json();
        return Array.isArray(j.results) ? j.results : null;
    } catch { return null; }
}

// ---------- UI state ----------
const state = {
    chains: {},                  // {name: [links]}
    builtin: [],                 // names that are read-only
    chainNames: [],              // ordered list for navigation
    cursor: 0,                   // index in chainNames
    mode: 'list',                // 'list' | 'edit' | 'new' | 'help' | 'message'
    editing: null,               // {name, links, linkCursor, buf}
    inputBuf: '',
    message: '',
    messageColor: 'cyan',
    source: 'file',              // 'server' or 'file'
    workingModels: [],           // from /debug/probe-live
};

async function refresh() {
    const remote = await serverGet();
    if (remote) {
        state.source = 'server';
        state.chains = remote.chains || {};
        state.builtin = remote.builtin || [];
        const pl = await probeResults();
        if (pl) state.workingModels = pl.map(r => r.provider + '/' + r.model);
    } else {
        state.source = 'file';
        state.chains = loadFromFile();
        state.builtin = [];
        state.workingModels = [];
    }
    state.chainNames = Object.keys(state.chains).sort();
    if (state.cursor >= state.chainNames.length) state.cursor = Math.max(0, state.chainNames.length - 1);
}

// ---------- rendering ----------
function drawHeader() {
    const { cols } = termSize();
    const title = bold(' acptoapi TUI — named fallback chains ');
    const src = state.source === 'server' ? green('● server ' + SERVER_URL) : yellow('● file ' + CHAINS_FILE);
    move(1, 1);
    process.stdout.write(inv(title.padEnd(cols, ' ')));
    move(2, 1);
    process.stdout.write(' source: ' + src);
    move(3, 1);
    process.stdout.write(dim(' '.padEnd(cols, '─')));
}

function drawFooter() {
    const { rows, cols } = termSize();
    move(rows - 1, 1);
    process.stdout.write(dim(' '.padEnd(cols, '─')));
    move(rows, 1);
    const help = state.mode === 'list'
        ? dim(' [↑/↓] move  [enter] edit  [n] new  [d] delete  [r] refresh  [?] help  [q] quit ')
        : state.mode === 'edit' || state.mode === 'new'
            ? dim(' [↑/↓] move  [a] add link  [d] delete link  [s] save  [esc] cancel ')
            : state.mode === 'help'
                ? dim(' [any key] back ')
                : dim(' ' + state.message + ' ');
    process.stdout.write(help.slice(0, cols));
}

function drawList() {
    const { rows, cols } = termSize();
    const top = 4;
    const bottom = rows - 2;
    const visible = bottom - top - 1;
    let start = 0;
    if (state.cursor >= visible) start = state.cursor - visible + 1;
    move(top, 1);
    process.stdout.write(bold(' name'.padEnd(20)) + bold('links'.padEnd(60)) + bold('source'));
    for (let i = 0; i < Math.min(visible, state.chainNames.length); i++) {
        const idx = start + i;
        if (idx >= state.chainNames.length) break;
        const name = state.chainNames[idx];
        const links = state.chains[name] || [];
        const summary = links.slice(0, 3).join(', ') + (links.length > 3 ? ` (+${links.length - 3})` : '');
        const src = state.builtin.includes(name) ? dim('builtin') : cyan('runtime');
        const row = ' ' + name.padEnd(20) + summary.slice(0, 58).padEnd(60) + src;
        move(top + 1 + i, 1);
        if (idx === state.cursor) process.stdout.write(inv(row.slice(0, cols)));
        else process.stdout.write(row.slice(0, cols));
        // clear rest of line
        process.stdout.write(ESC + '0K');
    }
    // clear remaining lines
    for (let i = state.chainNames.length; i < visible; i++) {
        move(top + 1 + i, 1); process.stdout.write(ESC + '0K');
    }
}

function drawEditor() {
    const { rows, cols } = termSize();
    const top = 4;
    const e = state.editing;
    move(top, 1);
    process.stdout.write(bold(' editing chain: ') + cyan(e.name) + (state.mode === 'new' ? yellow('  [new]') : ''));
    move(top + 1, 1);
    process.stdout.write(dim(' '.padEnd(cols, '─')));
    move(top + 2, 1);
    process.stdout.write(bold(' #  link'));
    for (let i = 0; i < e.links.length; i++) {
        move(top + 3 + i, 1);
        const row = ' ' + String(i + 1).padStart(2) + '  ' + e.links[i];
        if (i === e.linkCursor) process.stdout.write(inv(row.slice(0, cols)));
        else process.stdout.write(row.slice(0, cols));
        process.stdout.write(ESC + '0K');
    }
    // clear rest
    for (let i = e.links.length; i < rows - top - 6; i++) {
        move(top + 3 + i, 1); process.stdout.write(ESC + '0K');
    }
    if (state.inputBuf || state.mode === 'edit' || state.mode === 'new') {
        const inputRow = rows - 3;
        move(inputRow, 1);
        process.stdout.write(dim(' '.padEnd(cols, '─')));
        move(inputRow + 1, 1);
        process.stdout.write(' add link: ' + state.inputBuf);
        process.stdout.write(ESC + '0K');
    }
}

function drawHelp() {
    const { rows, cols } = termSize();
    const text = [
        '',
        ' ' + bold('acptoapi TUI'),
        '',
        ' navigate    [↑/↓] up/down through chains',
        ' edit chain  [enter] on a runtime chain (builtins are read-only)',
        ' new chain   [n] then type a name + add links',
        ' delete      [d] removes the highlighted runtime chain',
        ' refresh     [r] re-reads chains from server or file',
        ' help        [?] this screen',
        ' quit        [q]',
        '',
        ' in editor:',
        ' add link    [a] then type a model id (e.g. groq/llama-3.3-70b-versatile)',
        ' delete link [d] removes the highlighted link',
        ' save        [s] persists the chain',
        ' cancel      [esc] drops unsaved changes',
        '',
        ' source: ' + (state.source === 'server' ? 'live acptoapi server at ' + SERVER_URL : 'local file ' + CHAINS_FILE),
        ' working models discovered: ' + state.workingModels.length,
        '',
    ];
    for (let i = 0; i < text.length && i < rows - 5; i++) {
        move(4 + i, 1);
        process.stdout.write(text[i].slice(0, cols));
        process.stdout.write(ESC + '0K');
    }
}

function render() {
    drawHeader();
    if (state.mode === 'help') drawHelp();
    else if (state.mode === 'edit' || state.mode === 'new') drawEditor();
    else drawList();
    drawFooter();
}

function flash(msg, color = 'cyan') {
    state.message = msg;
    state.messageColor = color;
    state.mode = 'message';
    render();
    setTimeout(() => { if (state.mode === 'message') { state.mode = 'list'; render(); } }, 1500);
}

// ---------- save logic ----------
async function saveChain(name, links) {
    if (state.source === 'server') {
        const ok = await serverPost(name, links);
        if (!ok) return false;
    } else {
        const all = loadFromFile();
        all[name] = links;
        writeToFile(all);
    }
    await refresh();
    return true;
}

async function deleteChain(name) {
    if (state.builtin.includes(name)) return false;
    if (state.source === 'server') {
        const ok = await serverDelete(name);
        if (!ok) return false;
    } else {
        const all = loadFromFile();
        delete all[name];
        writeToFile(all);
    }
    await refresh();
    return true;
}

// ---------- keyboard handling ----------
async function onKey(str, key) {
    if (!key) key = {};

    if (state.mode === 'list') {
        if (key.name === 'q' || key.ctrl && key.name === 'c') { cleanup(); process.exit(0); }
        else if (key.name === 'up') { state.cursor = Math.max(0, state.cursor - 1); }
        else if (key.name === 'down') { state.cursor = Math.min(state.chainNames.length - 1, state.cursor + 1); }
        else if (key.name === 'r') { await refresh(); flash('refreshed (' + state.chainNames.length + ' chains)', 'green'); return; }
        else if (key.name === '?') { state.mode = 'help'; }
        else if (key.name === 'n') {
            state.mode = 'new';
            state.editing = { name: '', links: [], linkCursor: -1, buf: '' };
            state.inputBuf = '';
            // collect name first
            state.message = 'name: ';
            promptName();
            return;
        }
        else if (key.name === 'return') {
            const name = state.chainNames[state.cursor];
            if (!name) return;
            if (state.builtin.includes(name)) { flash('builtin chains are read-only', 'yellow'); return; }
            state.mode = 'edit';
            state.editing = { name, links: [...(state.chains[name] || [])], linkCursor: 0, buf: '' };
        }
        else if (key.name === 'd') {
            const name = state.chainNames[state.cursor];
            if (!name) return;
            if (state.builtin.includes(name)) { flash('builtin chains cannot be deleted', 'yellow'); return; }
            const ok = await deleteChain(name);
            flash(ok ? `deleted ${name}` : 'delete failed', ok ? 'green' : 'red');
            return;
        }
    } else if (state.mode === 'edit' || state.mode === 'new') {
        const e = state.editing;
        if (state.inputBuf !== null && state.inputBuf !== undefined && state._addingLink) {
            if (key.name === 'return') {
                if (state.inputBuf.trim()) e.links.push(state.inputBuf.trim());
                state.inputBuf = '';
                state._addingLink = false;
                e.linkCursor = e.links.length - 1;
            } else if (key.name === 'escape') {
                state.inputBuf = '';
                state._addingLink = false;
            } else if (key.name === 'backspace') {
                state.inputBuf = state.inputBuf.slice(0, -1);
            } else if (str && !key.ctrl && !key.meta && str.length === 1) {
                state.inputBuf += str;
            }
        } else {
            if (key.name === 'escape') { state.mode = 'list'; state.editing = null; }
            else if (key.name === 'up') { e.linkCursor = Math.max(0, e.linkCursor - 1); }
            else if (key.name === 'down') { e.linkCursor = Math.min(e.links.length - 1, e.linkCursor + 1); }
            else if (key.name === 'a') { state._addingLink = true; state.inputBuf = ''; }
            else if (key.name === 'd') {
                if (e.links.length === 0) return;
                e.links.splice(e.linkCursor, 1);
                e.linkCursor = Math.max(0, Math.min(e.links.length - 1, e.linkCursor));
            }
            else if (key.name === 's') {
                if (!e.name) { flash('chain needs a name', 'red'); return; }
                if (e.links.length === 0) { flash('chain needs at least one link', 'red'); return; }
                const ok = await saveChain(e.name, e.links);
                if (ok) {
                    flash(`saved ${e.name} (${e.links.length} links)`, 'green');
                    state.mode = 'list';
                    state.editing = null;
                    return;
                } else flash('save failed', 'red');
            }
        }
    } else if (state.mode === 'help') {
        state.mode = 'list';
    }
    render();
}

function promptName() {
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    const { rows } = termSize();
    move(rows - 2, 1);
    process.stdout.write('new chain name: ');
    process.stdout.write(ESC + '0K');
    showCursor();

    let buf = '';
    const handler = (data) => {
        for (const ch of data) {
            if (ch === '\r' || ch === '\n') {
                if (buf.trim()) {
                    state.editing.name = buf.trim();
                    process.stdin.removeListener('data', handler);
                    hideCursor();
                    render();
                    return;
                }
            } else if (ch === '\x7f' || ch === '\b') {
                buf = buf.slice(0, -1);
                process.stdout.write('\b \b');
            } else if (ch === '\x1b') {
                // escape — cancel
                process.stdin.removeListener('data', handler);
                state.mode = 'list';
                state.editing = null;
                hideCursor();
                render();
                return;
            } else if (ch >= ' ' && ch <= '~') {
                buf += ch;
                process.stdout.write(ch);
            }
        }
    };
    process.stdin.on('data', handler);
}

function cleanup() {
    showCursor();
    process.stdout.write(ESC + '0m');
    clear();
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
}

async function main() {
    await refresh();
    clear();
    hideCursor();
    render();
    if (!process.stdin.isTTY) {
        console.error('TUI requires an interactive terminal (TTY).');
        process.exit(1);
    }
    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.on('keypress', (str, key) => { onKey(str, key).catch(e => flash(e.message, 'red')); });
    process.on('SIGINT', () => { cleanup(); process.exit(0); });
    process.on('exit', cleanup);
}

main().catch(e => { cleanup(); console.error(e.stack || e); process.exit(1); });
