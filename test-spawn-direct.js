#!/usr/bin/env node
'use strict';

const path = require('path');

// Test the spawn logic directly
const { ensureRunning } = require('./lib/acp-launcher');

async function test() {
  console.log('Testing ACP daemon spawning...\n');

  const log = msg => console.log(msg);

  // Test just kilo first
  const status = await ensureRunning({
    names: ['kilo', 'opencode'],
    log
  });

  console.log('\n=== Spawn Status ===');
  console.log(JSON.stringify(status, null, 2));

  // Wait a moment and check if any are actually running
  await new Promise(r => setTimeout(r, 2000));

  // Try to probe kilo
  const { probe, resolveBackend } = require('./lib/acp-client');
  try {
    const b = resolveBackend('kilo');
    const isUp = await probe(b, 2000);
    console.log(`\nKilo probe result: ${isUp}`);
  } catch (e) {
    console.log(`\nKilo probe error: ${e.message}`);
  }
}

test().catch(console.error).finally(() => process.exit(0));
