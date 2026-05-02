'use strict';
const STOP = new Set(['the','a','an','and','or','but','of','to','in','on','for','is','it','this','that','with','as','by','at','be','from']);

function tokenize(s) {
  if (!s) return [];
  const out = [];
  const re = /[A-Za-z0-9_]{2,}/g;
  let m;
  while ((m = re.exec(String(s).toLowerCase())) !== null) {
    if (!STOP.has(m[0])) out.push(m[0]);
  }
  return out;
}

function buildIndex(docs, getText) {
  const N = docs.length;
  const df = new Map();
  const lens = new Array(N);
  const tfs = new Array(N);
  let total = 0;
  for (let i = 0; i < N; i++) {
    const toks = tokenize(getText ? getText(docs[i]) : docs[i]);
    const tf = new Map();
    for (const t of toks) tf.set(t, (tf.get(t) || 0) + 1);
    for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1);
    tfs[i] = tf;
    lens[i] = toks.length;
    total += toks.length;
  }
  const avgdl = total / Math.max(1, N);
  const idf = new Map();
  for (const [t, n] of df) idf.set(t, Math.log(1 + (N - n + 0.5) / (n + 0.5)));
  return { N, avgdl, idf, tfs, lens, docs };
}

function search(idx, query, { k1 = 1.5, b = 0.75, limit = 50 } = {}) {
  const qToks = [...new Set(tokenize(query))];
  if (!qToks.length) return [];
  const scores = new Float64Array(idx.N);
  const matched = new Array(idx.N);
  for (const t of qToks) {
    const w = idx.idf.get(t);
    if (w === undefined) continue;
    for (let i = 0; i < idx.N; i++) {
      const f = idx.tfs[i].get(t);
      if (!f) continue;
      const dl = idx.lens[i];
      const norm = 1 - b + b * (dl / (idx.avgdl || 1));
      const s = w * ((f * (k1 + 1)) / (f + k1 * norm));
      scores[i] += s;
      if (!matched[i]) matched[i] = [];
      matched[i].push(t);
    }
  }
  const ranked = [];
  for (let i = 0; i < idx.N; i++) if (scores[i] > 0) ranked.push({ i, score: scores[i], terms: matched[i] });
  ranked.sort((a, b) => b.score - a.score);
  return ranked.slice(0, limit);
}

function snippet(text, terms, max = 240) {
  if (!text) return '';
  const lc = text.toLowerCase();
  let pos = -1;
  for (const t of terms || []) { const p = lc.indexOf(t); if (p >= 0 && (pos < 0 || p < pos)) pos = p; }
  if (pos < 0) return text.slice(0, max);
  const start = Math.max(0, pos - 60);
  const end = Math.min(text.length, start + max);
  return (start > 0 ? '…' : '') + text.slice(start, end) + (end < text.length ? '…' : '');
}

module.exports = { tokenize, buildIndex, search, snippet };
