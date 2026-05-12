'use strict';
const { runStream, runChat, normalizeLink, prefixOf, preCheck } = require('./chain-machine');
const { loadConfig } = require('./config');

const RUN_HISTORY = [];
const HISTORY_MAX = 50;

function recordRun(actor, meta) {
  const entry = {
    ts: Date.now(),
    startedAt: Date.now(),
    state: 'running',
    history: [],
    servedBy: null,
    finishedAt: null,
    requestedModel: meta?.requestedModel || null,
    resolvedLinks: meta?.resolvedLinks || [],
    attempted: [],
    finalModel: null,
  };
  RUN_HISTORY.push(entry);
  if (RUN_HISTORY.length > HISTORY_MAX) RUN_HISTORY.shift();
  actor.subscribe(snap => {
    entry.state = String(snap.value);
    entry.history = snap.context.history;
    entry.servedBy = snap.context.servedBy;
    if (snap.context.servedBy) entry.finalModel = snap.context.servedBy;
    if (snap.status === 'done') entry.finishedAt = Date.now();
  });
  return entry;
}

function getRunHistory() {
  return RUN_HISTORY.slice();
}

function resolveNamedChain(name) {
  const cfg = loadConfig();
  const chains = cfg.chains || {};
  const def = chains[name];
  if (!def) return null;
  if (Array.isArray(def)) return { links: def.map(normalizeLink), defaults: {} };
  if (def.links) return { links: def.links.map(normalizeLink), defaults: def.defaults || {} };
  return null;
}

function listNamedChains() {
  const cfg = loadConfig();
  return Object.keys(cfg.chains || {});
}

function chain(linksOrName, defaultsOrOpts = {}) {
  if (typeof linksOrName === 'string') {
    const named = resolveNamedChain(linksOrName);
    if (!named) throw new Error(`No named chain: ${linksOrName}. Defined: ${listNamedChains().join(', ') || '(none)'}`);
    return chain(named.links, { ...named.defaults, ...defaultsOrOpts });
  }
  if (!Array.isArray(linksOrName) || linksOrName.length === 0) {
    throw new Error('chain() requires a non-empty array of models');
  }
  const links = linksOrName.map(normalizeLink);
  const defaults = defaultsOrOpts || {};
  const sdk = require('./sdk');
  function peekNext(n = 3) {
    const sampler = require('./sampler');
    const out = [];
    for (let i = 0; i < links.length && out.length < n; i++) {
      const l = links[i];
      const prefix = prefixOf(l.model);
      const pc = preCheck(l, { sampler, _matrixData: defaults._matrixData });
      out.push({
        index: i,
        model: l.model,
        prefix,
        fallbackOn: l.fallbackOn || defaults.fallbackOn || ['error'],
        blocked: !pc.ok,
        reason: pc.ok ? null : pc.reason,
      });
    }
    return out;
  }
  return {
    models: links.map(l => l.model),
    links,
    chat: (opts) => runChat(links, { ...defaults, ...opts }, (o) => sdk.chat(o), recordRun),
    stream: (opts) => runStream(links, { ...defaults, ...opts }, (o) => sdk.stream(o), recordRun),
    peekNext,
  };
}

function fallback(first, defaults = {}) {
  const links = [normalizeLink(first)];
  const builder = {
    then(next) { links.push(normalizeLink(next)); return builder; },
    onFallback(fn) { defaults.onFallback = fn; return builder; },
    fallbackOn(reasons) { defaults.fallbackOn = reasons; return builder; },
    timeout(ms) { defaults.timeout = ms; return builder; },
    build() { return chain(links, defaults); },
    chat(opts) { return chain(links, defaults).chat(opts); },
    stream(opts) { return chain(links, defaults).stream(opts); },
    get models() { return links.map(l => l.model); },
    get links() { return links.slice(); },
  };
  return builder;
}

module.exports = { chain, fallback, resolveNamedChain, listNamedChains, getRunHistory };
