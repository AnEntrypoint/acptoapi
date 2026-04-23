#!/usr/bin/env node
import { createServer } from '../lib/server.js';

const args = process.argv.slice(2);
const get = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };
const port = Number(get('--port', process.env.PORT || 4800));
const kiloBase = get('--kilo', process.env.ACP_KILO_URL);
const opencodeBase = get('--opencode', process.env.ACP_OPENCODE_URL);

const backends = {};
if (kiloBase) backends.kilo = { base: kiloBase };
if (opencodeBase) backends.opencode = { base: opencodeBase };

createServer({ port, backends }).catch(e => { console.error('startup failed:', e.message); process.exit(1); });
