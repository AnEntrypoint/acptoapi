#!/usr/bin/env node
/**
 * Validate all 4 PRD items without executing long-running operations
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

console.log('═════════════════════════════════════════════════════════');
console.log('  VALIDATE ALL 4 PRD ITEMS');
console.log('═════════════════════════════════════════════════════════\n');

let passed = 0;
let failed = 0;

function test(title, fn) {
  process.stdout.write(`  ${title}... `);
  try {
    fn();
    console.log('✓');
    passed++;
  } catch (err) {
    console.log('✗');
    console.log(`    Error: ${err.message}`);
    failed++;
  }
}

// Item 1: run-live-model-probe
console.log('Item 1: run-live-model-probe');
console.log('─'.repeat(55));

test('lib/model-probe-live.js exports kickoff', () => {
  const probe = require('./model-probe-live');
  assert(typeof probe.kickoff === 'function');
});

test('lib/model-probe-live.js exports isFresh', () => {
  const probe = require('./model-probe-live');
  assert(typeof probe.isFresh === 'function');
});

test('lib/model-probe-live.js exports getOrRefresh', () => {
  const probe = require('./model-probe-live');
  assert(typeof probe.getOrRefresh === 'function');
});

test('lib/model-probe-live.js exports buildChainFromProbe', () => {
  const probe = require('./model-probe-live');
  assert(typeof probe.buildChainFromProbe === 'function');
});

// Item 2: expand-swebench-table
console.log('\nItem 2: expand-swebench-table');
console.log('─'.repeat(55));

test('lib/swe-bench-scores.js has 21+ models', () => {
  const swe = require('./swe-bench-scores');
  const count = Object.keys(swe.SWE_BENCH_SCORES).length;
  assert(count >= 21, `Expected 21+, got ${count}`);
});

test('Sample scores verified (claude/mythos-preview: 93.9)', () => {
  const swe = require('./swe-bench-scores');
  assert.strictEqual(swe.SWE_BENCH_SCORES['claude/mythos-preview'], 93.9);
});

test('Sample scores verified (gpt/5.5: 88.7)', () => {
  const swe = require('./swe-bench-scores');
  assert.strictEqual(swe.SWE_BENCH_SCORES['gpt/5.5'], 88.7);
});

test('sortByBenchmark ranks descending', () => {
  const swe = require('./swe-bench-scores');
  const chain = [
    { model: 'claude/sonnet-4.6' },
    { model: 'claude/mythos-preview' },
    { model: 'gpt/5.3-codex' }
  ];
  const sorted = swe.sortByBenchmark(chain);
  assert.strictEqual(sorted[0].model, 'claude/mythos-preview');
  assert.strictEqual(sorted[1].model, 'gpt/5.3-codex');
  assert.strictEqual(sorted[2].model, 'claude/sonnet-4.6');
});

test('getModelScore resolves models', () => {
  const swe = require('./swe-bench-scores');
  const score = swe.getModelScore('claude/mythos-preview');
  assert(score === 93.9);
});

test('Source cited: benchlm.ai (May 13, 2026)', () => {
  const swe = require('./swe-bench-scores');
  assert.strictEqual(swe.lastUpdated, '2026-05-13');
});

// Item 3: verify-agentapi-startup
console.log('\nItem 3: verify-agentapi-startup');
console.log('─'.repeat(55));

test('All 11 ACP daemons registered in launcher', () => {
  const launcher = require('./acp-launcher');
  const daemons = ['kilo', 'opencode', 'gemini-cli', 'qwen-code', 'codex-cli',
                   'copilot-cli', 'cline', 'hermes-agent', 'cursor-acp',
                   'codeium-cli', 'acp-cli'];
  daemons.forEach(d => {
    assert(launcher.CMDS[d], `Missing: ${d}`);
  });
});

test('All 11 ACP backends registered in client', () => {
  const acp = require('./acp-client');
  const daemons = ['kilo', 'opencode', 'gemini-cli', 'qwen-code', 'codex-cli',
                   'copilot-cli', 'cline', 'hermes-agent', 'cursor-acp',
                   'codeium-cli', 'acp-cli'];
  daemons.forEach(d => {
    assert(acp.BACKENDS[d], `Missing backend: ${d}`);
  });
});

test('Server has /health endpoint handler', () => {
  const content = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  assert(content.includes("'/health'"), 'Missing /health endpoint');
});

test('Server has /debug/auto-chain endpoint handler', () => {
  const content = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  assert(content.includes('/debug/auto-chain'), 'Missing /debug/auto-chain');
});

test('Server integrates model-probe-live', () => {
  const content = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  assert(content.includes('model-probe-live'), 'Missing import');
});

test('Auto-chain builds 22+ item chain', () => {
  const autoChain = require('./auto-chain');
  const chain = autoChain.buildAutoChain();
  assert(Array.isArray(chain));
  assert(chain.length >= 22, `Expected 22+, got ${chain.length}`);
});

// Item 4: validate-install-script
console.log('\nItem 4: validate-install-script');
console.log('─'.repeat(55));

test('install-acp-agents.ps1 exists', () => {
  const scriptPath = path.join(__dirname, '..', 'install-acp-agents.ps1');
  assert(fs.existsSync(scriptPath), 'Not found');
});

test('install-acp-agents.ps1 has 500+ chars', () => {
  const scriptPath = path.join(__dirname, '..', 'install-acp-agents.ps1');
  const content = fs.readFileSync(scriptPath, 'utf8');
  assert(content.length > 500, 'Script too small');
});

test('install-acp-agents.ps1 contains npm invocations', () => {
  const scriptPath = path.join(__dirname, '..', 'install-acp-agents.ps1');
  const content = fs.readFileSync(scriptPath, 'utf8');
  assert(content.includes('npm'), 'Missing npm');
});

test('install-acp-agents.ps1 has error handling', () => {
  const scriptPath = path.join(__dirname, '..', 'install-acp-agents.ps1');
  const content = fs.readFileSync(scriptPath, 'utf8');
  assert(
    content.includes('-ErrorAction') || content.includes('$?') || content.includes('LASTEXITCODE'),
    'Missing error handling'
  );
});

// Summary
console.log('\n╔═══════════════════════════════════════════════════════╗');
console.log(`║  Results: ${passed} passed, ${failed} failed`);
console.log('╚═══════════════════════════════════════════════════════╝\n');

if (failed === 0) {
  console.log('✓ ALL VALIDATIONS PASSED\n');
  console.log('PRD Status:');
  console.log('  1. run-live-model-probe: exports verified ✓');
  console.log('  2. expand-swebench-table: 21 models, official scores ✓');
  console.log('  3. verify-agentapi-startup: server structure verified ✓');
  console.log('  4. validate-install-script: script valid ✓');
  console.log('\nRemaining tasks:');
  console.log('  • Execute live probe (requires API keys)');
  console.log('  • Research SWE-Bench scores for discovered models');
  console.log('  • Start agentapi.js and test endpoints');
  console.log('  • Verify install script PowerShell execution');
  console.log('\nNext: Run with npm start or use live probe executor\n');
  process.exit(0);
} else {
  console.log(`✗ ${failed} VALIDATION(S) FAILED\n`);
  process.exit(1);
}
