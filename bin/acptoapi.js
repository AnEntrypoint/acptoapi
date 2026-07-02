#!/usr/bin/env node
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');

// Load dotenv from both locations with ~/.acptoapi/.env taking precedence
const devDotEnv = path.join(path.resolve(__dirname, '..'), '.env');
const userDotEnv = path.join(os.homedir(), '.acptoapi', '.env');

// Load the dev .env file first
if (fs.existsSync(devDotEnv)) {
  require('dotenv').config({ path: devDotEnv });
}

// Load the user .env file if it exists (overrides dev env)
if (fs.existsSync(userDotEnv)) {
  require('dotenv').config({ path: userDotEnv });
}

const { createServer } = require('../lib/server');

// Last-resort guard: log unhandled rejections instead of letting the default
// node behavior tear the whole acptoapi process (and every ACP daemon it
// supervises) down. The chain logic recovers from any individual provider
// failure by falling through to the next link; an uncaught rejection here
// is always recoverable in spirit.
process.on('unhandledRejection', (err) => {
  console.error('[acptoapi] unhandledRejection:', err && err.message || err);
});
process.on('uncaughtException', (err) => {
  console.error('[acptoapi] uncaughtException:', err && err.message || err);
});

const args = process.argv.slice(2);
const get = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const port = Number(get('--port', process.env.PORT || 4800));
const kiloBase = get('--kilo', process.env.ACP_KILO_URL);
const opencodeBase = get('--opencode', process.env.ACP_OPENCODE_URL);
const claudeBase = get('--claude', process.env.ACP_CLAUDE_URL);

const backends = {};
if (kiloBase) backends.kilo = { base: kiloBase };
if (opencodeBase) backends.opencode = { base: opencodeBase };
if (claudeBase) backends.claude = { base: claudeBase };

// Curated free-tier metadata: which providers genuinely offer a no-cost tier
// (permanent free allowance or a trial that doesn't require a credit card),
// and where to sign up for a key. `free: false` entries are paid-only or
// require billing info even for a "free trial" - excluded from --missing-free.
// `free: 'local'` entries need no signup at all (self-hosted / no key).
const FREE_TIER_INFO = {
  anthropic:      { free: false, signupUrl: 'https://console.anthropic.com/settings/keys', note: 'paid, no permanent free tier' },
  gemini:         { free: true,  signupUrl: 'https://aistudio.google.com/apikey', note: 'generous free tier via Google AI Studio' },
  ollama:         { free: 'local', signupUrl: 'https://ollama.com/download', note: 'local install, no API key or signup needed' },
  bedrock:        { free: false, signupUrl: 'https://console.aws.amazon.com/bedrock/', note: 'AWS billing account required' },
  groq:           { free: true,  signupUrl: 'https://console.groq.com/keys', note: 'free tier, generous rate limits' },
  openrouter:     { free: true,  signupUrl: 'https://openrouter.ai/keys', note: 'many models with a ":free" suffix, no cost' },
  together:       { free: true,  signupUrl: 'https://api.together.ai/settings/api-keys', note: 'free trial credits on signup' },
  deepseek:       { free: false, signupUrl: 'https://platform.deepseek.com/api_keys', note: 'pay-as-you-go, very low cost, no permanent free tier' },
  xai:            { free: false, signupUrl: 'https://console.x.ai/', note: 'requires billing setup' },
  cerebras:       { free: true,  signupUrl: 'https://cloud.cerebras.ai/', note: 'free tier available' },
  perplexity:     { free: false, signupUrl: 'https://www.perplexity.ai/settings/api', note: 'requires billing setup' },
  mistral:        { free: true,  signupUrl: 'https://console.mistral.ai/api-keys', note: 'free tier (La Plateforme) with rate limits' },
  fireworks:      { free: true,  signupUrl: 'https://fireworks.ai/account/api-keys', note: 'free trial credits on signup' },
  openai:         { free: false, signupUrl: 'https://platform.openai.com/api-keys', note: 'requires billing setup' },
  nvidia:         { free: true,  signupUrl: 'https://build.nvidia.com/', note: 'free API credits via NVIDIA NIM' },
  sambanova:      { free: true,  signupUrl: 'https://cloud.sambanova.ai/apis', note: 'free tier available' },
  cloudflare:     { free: true,  signupUrl: 'https://dash.cloudflare.com/?to=/:account/ai/workers-ai', note: 'Workers AI free tier (per Cloudflare account)' },
  zai:            { free: true,  signupUrl: 'https://z.ai/manage-apikey/apikey-list', note: 'free tier for GLM models' },
  qwen:           { free: true,  signupUrl: 'https://dashscope.console.aliyun.com/apiKey', note: 'free trial credits (Alibaba Cloud account)' },
  codestral:      { free: true,  signupUrl: 'https://console.mistral.ai/codestral', note: 'free for individual/non-commercial use' },
  'opencode-zen':  { free: true,  signupUrl: 'https://opencode.ai/', note: 'curated free-tier routing service' },
  meta:           { free: false, signupUrl: 'https://www.llama-api.com/', note: 'requires billing setup' },
  cohere:         { free: true,  signupUrl: 'https://dashboard.cohere.com/api-keys', note: 'free trial key, no credit card, non-commercial rate-limited' },
  aion:           { free: true,  signupUrl: 'https://aionlabs.ai/', note: 'permanent free tier, no API key required for base access' },
  librechat:      { free: 'local', signupUrl: 'https://www.librechat.ai/docs/quick_start/local_setup', note: 'self-hosted aggregator, no signup' },
};

if (args.includes('--missing-free')) {
  const { listBrands, getBrand } = require('../lib/openai-brands');
  const builtins = [
    { name: 'anthropic', envKey: 'ANTHROPIC_API_KEY' },
    { name: 'gemini', envKey: 'GEMINI_API_KEY' },
    { name: 'ollama', envKey: null },
    { name: 'bedrock', envKey: 'AWS_ACCESS_KEY_ID' },
  ];
  const all = [...builtins, ...listBrands().map(b => ({ name: b, envKey: getBrand(b).envKey }))];
  const missing = all.filter(({ name, envKey }) => {
    const info = FREE_TIER_INFO[name];
    if (!info || info.free !== true) return false; // skip paid-only and local (no key needed)
    return envKey && !process.env[envKey];
  });
  if (missing.length === 0) {
    console.log('All free-tier providers with a signup key are already configured.');
  } else {
    console.log(`${missing.length} free-tier provider(s) not yet configured:\n`);
    for (const { name, envKey } of missing) {
      const info = FREE_TIER_INFO[name];
      console.log(`${name} (${envKey})`);
      console.log(`  signup: ${info.signupUrl}`);
      console.log(`  note:   ${info.note}\n`);
    }
  }
  process.exit(0);
} else if (args.includes('--probe')) {
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
  if (!names.length) { console.log('(no chains defined; add `chains:` to ~/.acptoapi/config.json or set ACPTOAPI_CONFIG)'); process.exit(0); }
  for (const n of names) {
    const r = resolveNamedChain(n);
    console.log(`${n}: ${r.links.map(l => l.model).join(' -> ')}`);
  }
  process.exit(0);
} else {
  const cmd = args[0];
  if (cmd === 'claude') {
    const claudeArgs = args.slice(1);
    const { runClaude } = require('../index');
    runClaude({ args: claudeArgs, port }).catch(e => { console.error('claude startup failed:', e.message); process.exit(1); });
  } else {
    createServer({ port, backends }).catch(e => { console.error('startup failed:', e.message); process.exit(1); });
  }
}
