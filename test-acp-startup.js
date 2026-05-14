#!/usr/bin/env node
'use strict';

const { ensureRunning } = require('./lib/acp-launcher');

async function test() {
  console.log('=== ACP Daemon Startup Test ===\n');
  console.log('System info:');
  console.log(`  Platform: ${process.platform}`);
  console.log(`  Node: ${process.version}`);
  console.log(`  cwd: ${process.cwd()}\n`);

  const messages = [];
  const log = msg => {
    console.log(msg);
    messages.push(msg);
  };

  console.log('Attempting to start daemons...\n');
  const status = await ensureRunning({
    names: ['kilo', 'opencode', 'gemini-cli'],
    log
  });

  console.log('\n=== Results ===');
  console.log(JSON.stringify(status, null, 2));

  const failed = Object.entries(status).filter(([_, s]) => s === 'unavailable');
  const spawned = Object.entries(status).filter(([_, s]) => s === 'spawned');

  console.log(`\nSummary: ${spawned.length} spawned, ${failed.length} unavailable`);
  if (spawned.length > 0) {
    console.log(`Spawned: ${spawned.map(([n]) => n).join(', ')}`);
  }
  if (failed.length > 0) {
    console.log(`Unavailable (not installed): ${failed.map(([n]) => n).join(', ')}`);
  }

  process.exit(0);
}

test().catch(err => {
  console.error('Test error:', err);
  process.exit(1);
});
