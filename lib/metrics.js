'use strict';

const counters = Object.create(null);
const histograms = Object.create(null);
const startTime = Date.now();

function inc(name, labels = {}) {
  const key = name + '|' + JSON.stringify(labels);
  counters[key] = (counters[key] || { name, labels, value: 0 });
  counters[key].value++;
}

function observe(name, value, labels = {}) {
  const key = name + '|' + JSON.stringify(labels);
  if (!histograms[key]) histograms[key] = { name, labels, count: 0, sum: 0 };
  histograms[key].count++;
  histograms[key].sum += value;
}

function fmtLabels(l) {
  const k = Object.keys(l);
  if (!k.length) return '';
  return '{' + k.map(x => `${x}="${String(l[x]).replace(/"/g, '\\"')}"`).join(',') + '}';
}

function render() {
  const lines = [];
  lines.push('# HELP agentapi_uptime_seconds Process uptime in seconds');
  lines.push('# TYPE agentapi_uptime_seconds gauge');
  lines.push(`agentapi_uptime_seconds ${(Date.now() - startTime) / 1000}`);
  const seenC = new Set();
  for (const c of Object.values(counters)) {
    if (!seenC.has(c.name)) { lines.push(`# TYPE ${c.name} counter`); seenC.add(c.name); }
    lines.push(`${c.name}${fmtLabels(c.labels)} ${c.value}`);
  }
  const seenH = new Set();
  for (const h of Object.values(histograms)) {
    if (!seenH.has(h.name)) { lines.push(`# TYPE ${h.name} summary`); seenH.add(h.name); }
    lines.push(`${h.name}_count${fmtLabels(h.labels)} ${h.count}`);
    lines.push(`${h.name}_sum${fmtLabels(h.labels)} ${h.sum}`);
  }
  return lines.join('\n') + '\n';
}

function snapshot() {
  return { counters: Object.values(counters), histograms: Object.values(histograms), uptimeSeconds: (Date.now() - startTime) / 1000 };
}

module.exports = { inc, observe, render, snapshot };
