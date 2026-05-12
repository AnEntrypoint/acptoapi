'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_QUEUE_PATH = path.join(os.homedir(), '.acptoapi', 'queues.json');

function loadFile(fp) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return null; }
}

function normalizeEntries(val) {
  if (!val) return null;
  const arr = Array.isArray(val) ? val : (Array.isArray(val.links) ? val.links : null);
  if (!arr) return null;
  return arr.map(x => typeof x === 'string' ? { model: x } : (x && x.model ? x : null)).filter(Boolean);
}

function loadAllSources({ configPath, extraQueueSources = [], queuesMap = null } = {}) {
  const sources = [];
  const defaultPath = configPath || process.env.ACPTOAPI_QUEUES || DEFAULT_QUEUE_PATH;
  const def = loadFile(defaultPath);
  if (def) sources.push({ source: defaultPath, queues: def.queues || def });
  for (const p of extraQueueSources) {
    const f = loadFile(p);
    if (!f) continue;
    sources.push({ source: p, queues: f.queues || f });
  }
  try {
    const { loadConfig } = require('./config');
    const cfg = loadConfig();
    if (cfg && cfg.chains) sources.push({ source: 'thebird', queues: cfg.chains });
  } catch {}
  if (queuesMap) sources.push({ source: 'inline', queues: queuesMap });
  return sources;
}

function resolveQueue({ name, queuesMap, configPath, extraQueueSources } = {}) {
  if (!name || typeof name !== 'string') throw new Error('resolveQueue: name required');
  const sources = loadAllSources({ configPath, extraQueueSources, queuesMap });
  let hit = null;
  for (const s of sources) {
    if (s.queues && Object.prototype.hasOwnProperty.call(s.queues, name)) {
      const links = normalizeEntries(s.queues[name]);
      if (links && links.length) hit = { links, source: s.source };
    }
  }
  if (!hit) throw new Error(`queue not found or empty: ${name}`);
  return hit;
}

function listAllQueues({ queuesMap, configPath, extraQueueSources } = {}) {
  const sources = loadAllSources({ configPath, extraQueueSources, queuesMap });
  const seen = new Map();
  for (const s of sources) {
    if (!s.queues) continue;
    for (const [name, val] of Object.entries(s.queues)) {
      const links = normalizeEntries(val);
      if (!links || !links.length) continue;
      seen.set(name, { name, links: links.map(l => l.model), source: s.source });
    }
  }
  return Array.from(seen.values());
}

module.exports = { resolveQueue, listAllQueues, DEFAULT_QUEUE_PATH };
