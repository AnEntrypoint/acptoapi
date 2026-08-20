const FALLBACK_MODELS = [
  'claude/sonnet',
  'claude/haiku',
  'claude/opus',
  'kilo/x-ai/grok-code-fast-1:optimized:free',
  'kilo/kilo-auto/free',
  'kilo/openrouter/free',
  'opencode/minimax-m2.5-free',
];

const $ = id => document.getElementById(id);

// Selection state: what the picker currently offers and what's chosen.
const picker = {
  models: [],       // [{id, provider, ok, rank}]
  chains: {},        // {name: [links]}
  queues: [],        // [{name, links, source}]
  mode: 'model',      // 'model' | 'chain' | 'queue'
  filter: '',
  selected: '',
};

function providerOf(id) {
  const i = id.indexOf('/');
  return i === -1 ? id : id.slice(0, i);
}

async function fetchJson(endpoint, path, timeoutMs = 2500) {
  try {
    const r = await fetch(endpoint.replace(/\/$/, '') + path, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

async function loadPickerData(endpoint) {
  const [modelsRes, chainsRes, queuesRes, samplerRes, availRes] = await Promise.all([
    fetchJson(endpoint, '/models'),
    fetchJson(endpoint, '/chains'),
    fetchJson(endpoint, '/queues'),
    fetchJson(endpoint, '/sampler/status'),
    fetchJson(endpoint, '/availability'),
  ]);

  const samplerByProvider = new Map((samplerRes?.status || []).map(s => [s.provider, s]));
  const rankByModel = new Map((availRes?.availability || []).map(a => [a.model, a.rank]));

  let models;
  if (modelsRes?.data?.length) {
    models = modelsRes.data
      .filter(m => m.object === 'model')
      .map(m => {
        const provider = providerOf(m.id);
        const s = samplerByProvider.get(provider);
        return { id: m.id, provider, ok: s ? s.ok : null, rank: rankByModel.get(m.id) };
      });
  } else {
    models = FALLBACK_MODELS.map(id => ({ id, provider: providerOf(id), ok: null, rank: undefined }));
  }
  models.sort((a, b) => (b.rank || 0) - (a.rank || 0) || a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));

  picker.models = models;
  picker.chains = chainsRes?.chains || {};
  picker.queues = (queuesRes?.queues || []);
}

function statusDot(ok) {
  if (ok === true) return '<span class="status-dot ok" title="live-healthy"></span>';
  if (ok === false) return '<span class="status-dot down" title="in backoff"></span>';
  return '<span class="status-dot unknown" title="unprobed"></span>';
}

function currentEntries() {
  if (picker.mode === 'chain') {
    return Object.entries(picker.chains).map(([name, links]) => ({
      value: name, label: name, sub: (links || []).join(' -> '), provider: 'chain', ok: null,
    }));
  }
  if (picker.mode === 'queue') {
    return picker.queues.map(q => ({
      value: `queue/${q.name}`, label: `queue/${q.name}`, sub: (q.links || []).join(' -> '), provider: 'queue', ok: null,
    }));
  }
  return picker.models.map(m => ({
    value: m.id, label: m.id, sub: m.provider, provider: m.provider, ok: m.ok,
  }));
}

function renderPicker() {
  const list = $('picker-list');
  const q = picker.filter.trim().toLowerCase();
  const entries = currentEntries().filter(e => !q || e.label.toLowerCase().includes(q) || e.provider.toLowerCase().includes(q));

  if (!entries.length) {
    list.innerHTML = '<div class="picker-empty">no matches</div>';
    return;
  }

  // Group by provider for the model view; chains/queues render flat.
  if (picker.mode === 'model') {
    const groups = new Map();
    for (const e of entries) {
      if (!groups.has(e.provider)) groups.set(e.provider, []);
      groups.get(e.provider).push(e);
    }
    list.innerHTML = [...groups.entries()].map(([provider, items]) => `
      <div class="picker-group">
        <div class="picker-group-label">${provider}</div>
        ${items.map(e => pickerRow(e)).join('')}
      </div>
    `).join('');
  } else {
    list.innerHTML = entries.map(e => pickerRow(e)).join('');
  }

  list.querySelectorAll('.picker-row').forEach(row => {
    row.addEventListener('click', () => selectEntry(row.dataset.value));
  });
}

function pickerRow(e) {
  const active = e.value === picker.selected ? ' active' : '';
  const dot = picker.mode === 'model' ? statusDot(e.ok) : '';
  return `<div class="picker-row${active}" data-value="${escapeAttr(e.value)}" title="${escapeAttr(e.sub)}">
    ${dot}<span class="picker-row-label">${escapeHtml(e.label)}</span>
    <span class="picker-row-sub">${escapeHtml(e.sub)}</span>
  </div>`;
}

function escapeHtml(s) { return String(s || '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
function escapeAttr(s) { return String(s || '').replace(/"/g, '&quot;'); }

function selectEntry(value) {
  picker.selected = value;
  $('model-value').value = value;
  $('picker-trigger-label').textContent = value || '(none selected)';
  renderPicker();
  closePickerPanel();
}

function setMode(mode) {
  picker.mode = mode;
  document.querySelectorAll('.picker-mode').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  renderPicker();
}

function openPickerPanel() { $('picker-panel').classList.add('open'); $('picker-search').focus(); }
function closePickerPanel() { $('picker-panel').classList.remove('open'); }
function togglePickerPanel() { $('picker-panel').classList.contains('open') ? closePickerPanel() : openPickerPanel(); }

async function initModels(endpoint) {
  await loadPickerData(endpoint);
  const stillValid = picker.selected && picker.models.some(m => m.id === picker.selected);
  if ((!picker.selected || !stillValid) && picker.models.length) selectEntry(picker.models[0].id);
  else renderPicker();
}

const state = { content: '', reasoning: '', raw: [], activeTab: 'content' };

function render() {
  const out = $('output');
  if (state.activeTab === 'content') out.textContent = state.content || '(nothing yet)';
  else if (state.activeTab === 'reasoning') out.textContent = state.reasoning || '(no reasoning)';
  else out.textContent = state.raw.map(r => JSON.stringify(r)).join('\n') || '(no chunks)';
  document.querySelectorAll('.output-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === state.activeTab));
}

function setTab(tab) { state.activeTab = tab; render(); }

async function streamChat() {
  const endpoint = $('endpoint').value.trim();
  const model = $('model-value').value || picker.selected;
  const prompt = $('prompt').value;
  const stats = $('stats');
  const btn = $('send-btn');

  state.content = ''; state.reasoning = ''; state.raw = [];
  render();
  stats.textContent = 'connecting...';
  btn.disabled = true;

  const t0 = performance.now();
  let firstChunkMs = 0;
  let chunks = 0;

  try {
    const r = await fetch(endpoint.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer none' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: true }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${await r.text()}`);

    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 2);
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6);
        if (payload === '[DONE]') { buf = ''; break; }
        const c = JSON.parse(payload);
        chunks++;
        if (!firstChunkMs) firstChunkMs = Math.round(performance.now() - t0);
        state.raw.push(c);
        const d = c.choices?.[0]?.delta || {};
        if (d.content) state.content += d.content;
        if (d.reasoning_content) state.reasoning += d.reasoning_content;
        stats.textContent = `${chunks} chunks - first ${firstChunkMs}ms - ${Math.round(performance.now() - t0)}ms total`;
        render();
      }
    }
    stats.textContent = `done - ${chunks} chunks - first ${firstChunkMs}ms - ${Math.round(performance.now() - t0)}ms total`;
  } catch (e) {
    stats.textContent = 'error: ' + e.message;
    state.content = 'ERROR: ' + e.message + '\n\nIs acptoapi running on ' + endpoint + ' ?\n\nStart it with:\n  npx acptoapi';
    render();
  } finally {
    btn.disabled = false;
  }
}

async function init() {
  const sameOrigin = location.protocol === 'http:' || location.protocol === 'https:';
  const default_endpoint = sameOrigin && !location.host.includes('github.io') ? location.origin + '/v1' : 'http://localhost:4800/v1';
  $('endpoint').value = default_endpoint;
  await initModels(default_endpoint);

  $('send-btn').addEventListener('click', streamChat);
  $('endpoint').addEventListener('change', e => initModels(e.target.value));
  $('picker-trigger').addEventListener('click', togglePickerPanel);
  $('picker-search').addEventListener('input', e => { picker.filter = e.target.value; renderPicker(); });
  document.querySelectorAll('.picker-mode').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
  document.addEventListener('click', e => {
    if (!$('picker-panel').contains(e.target) && !$('picker-trigger').contains(e.target)) closePickerPanel();
  });
  document.querySelectorAll('.output-tab').forEach(t => t.addEventListener('click', () => setTab(t.dataset.tab)));
  setTab('content');
}

init();
