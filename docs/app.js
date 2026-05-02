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

async function initModels(endpoint) {
  const sel = $('model');
  let models = FALLBACK_MODELS;
  try {
    const r = await fetch(endpoint.replace(/\/$/, '') + '/models', { signal: AbortSignal.timeout(2000) });
    if (r.ok) {
      const data = await r.json();
      if (data.data?.length) models = data.data.map(m => m.id);
    }
  } catch { /* fallback */ }
  sel.innerHTML = models.map(m => `<option value="${m}">${m}</option>`).join('');
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
  const model = $('model').value;
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
        stats.textContent = `${chunks} chunks · first ${firstChunkMs}ms · ${Math.round(performance.now() - t0)}ms total`;
        render();
      }
    }
    stats.textContent = `done · ${chunks} chunks · first ${firstChunkMs}ms · ${Math.round(performance.now() - t0)}ms total`;
  } catch (e) {
    stats.textContent = 'error: ' + e.message;
    state.content = 'ERROR: ' + e.message + '\n\nIs agentapi running on ' + endpoint + ' ?\n\nStart it with:\n  npx agentapi\n\nAnd ensure kilo is serving:\n  kilo serve --port 4780';
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
  document.querySelectorAll('.output-tab').forEach(t => t.addEventListener('click', () => setTab(t.dataset.tab)));
  setTab('content');
}

init();
