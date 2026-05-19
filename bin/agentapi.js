#!/usr/bin/env node
'use strict';
require('dotenv').config({ path: require('path').join(require('path').resolve(__dirname, '..'), '.env') });
const { createServer } = require('../lib/server');

const args = process.argv.slice(2);
const get = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const port = Number(get('--port', process.env.PORT || 4800));
const kiloBase = get('--kilo', process.env.ACP_KILO_URL);
const opencodeBase = get('--opencode', process.env.ACP_OPENCODE_URL);

const backends = {};
if (kiloBase) backends.kilo = { base: kiloBase };
if (opencodeBase) backends.opencode = { base: opencodeBase };

if (args.includes('--probe')) {
  (async () => {
    const { listBrands, getBrand } = require('../lib/openai-brands');
    const checks = [
      { name: 'ANTHROPIC_API_KEY', set: !!process.env.ANTHROPIC_API_KEY },
      { name: 'GEMINI_API_KEY', set: !!process.env.GEMINI_API_KEY },
      { name: 'OLLAMA_URL', set: !!process.env.OLLAMA_URL || true, value: process.env.OLLAMA_URL || 'http://localhost:11434' },
      { name: 'AWS_ACCESS_KEY_ID', set: !!process.env.AWS_ACCESS_KEY_ID },
    ];
    for (const b of listBrands()) {
      const k = getBrand(b).envKey;
      checks.push({ name: `${b} (${k})`, set: !!process.env[k] });
    }
    for (const c of checks) console.log(`${c.set ? 'OK ' : '-- '} ${c.name}${c.value ? ' = ' + c.value : ''}`);
    process.exit(0);
  })();
} else if (args.includes('--update')) {
  (async () => {
    const { execSync } = require('child_process');
    const opts = { stdio: 'inherit', windowsHide: true };
    const tryRun = (cmd) => { try { execSync(cmd, opts); return true; } catch { return false; } };
    console.log('[acptoapi] clearing npx + bun caches and re-fetching @latest...');
    tryRun('npm cache clean --force');
    tryRun(process.platform === 'win32' ? 'rmdir /s /q "%LOCALAPPDATA%\\npm-cache\\_npx" 2>nul' : 'rm -rf ~/.npm/_npx');
    tryRun(process.platform === 'win32' ? 'rmdir /s /q "%LOCALAPPDATA%\\..\\Roaming\\npm-cache\\_npx" 2>nul' : 'true');
    tryRun('bun pm cache rm');
    const latest = (() => { try { return require('child_process').execSync('npm view acptoapi version', { windowsHide: true }).toString().trim(); } catch { return '(unknown)'; } })();
    console.log(`[acptoapi] latest on npm: ${latest}`);
    console.log('[acptoapi] next invocation of `bunx acptoapi@latest` or `npx -y acptoapi@latest` will fetch fresh.');
    process.exit(0);
  })();
} else if (args.includes('--list-brands')) {
  const { listBrands } = require('../lib/openai-brands');
  for (const b of listBrands()) console.log(b);
  process.exit(0);
} else if (args.includes('--list-chains')) {
  const { listNamedChains, resolveNamedChain } = require('../lib/chain');
  const names = listNamedChains();
  if (!names.length) { console.log('(no chains defined; add `chains:` to ~/.thebird/config.json or set THEBIRD_CONFIG)'); process.exit(0); }
  for (const n of names) {
    const r = resolveNamedChain(n);
    console.log(`${n}: ${r.links.map(l => l.model).join(' → ')}`);
  }
  process.exit(0);
} else {
  createServer({ port, backends }).catch(e => { console.error('startup failed:', e.message); process.exit(1); });
}
