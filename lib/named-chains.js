'use strict';
// Built-in named fallback chains. Callers select one by sending it as the
// `model` field in /v1/messages or /v1/chat/completions. Unrecognized names
// fall back to the dynamic auto-chain (default behavior).
//
// Add custom chains via:
//   - ~/.acptoapi/chains.json     { "<name>": ["model/a", "model/b", ...] }
//   - process.env.ACPTOAPI_CHAINS '{"name":["model/a","model/b"]}' (JSON)
//   - registerChain(name, [...links]) at runtime

const fs = require('fs');
const path = require('path');
const os = require('os');

const FALLBACK_ON = ['error', 'rate_limit', 'timeout', 'empty'];

// Built-in presets. The names are the "easy way" — caller passes one of these
// as the model and gets a curated chain.
const BUILTIN = {
    // Free/cheap models first, then ACP, then claude CLI as last resort.
    'fast':       ['groq/llama-3.3-70b-versatile', 'groq/llama-3.1-8b-instant', 'cerebras/llama-3.3-70b'],
    'cheap':      ['openrouter/google/gemini-3.1-flash-lite', 'groq/llama-3.1-8b-instant', 'mistral/mistral-tiny-latest'],
    'smart':      ['anthropic/claude-sonnet-4-6', 'openrouter/anthropic/claude-sonnet-4.6', 'mistral/mistral-large-latest'],
    'reasoning':  ['openrouter/deepseek/deepseek-v4-pro', 'sambanova/DeepSeek-V3.2', 'nvidia/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning'],
    'free':       ['openrouter/google/gemini-3.1-flash-lite', 'kilo/openrouter/free', 'opencode/minimax-m2.5-free'],
    'local':      ['ollama/llama3.2', 'kilo/openrouter/free', 'opencode/minimax-m2.5-free'],
    // The default behavior chain (also what bare claude-* resolves to with no API keys).
    'auto':       null, // sentinel — handled by handleAnthropicMessages live/static path
};

let _runtime = {};
let _loadedFiles = false;

function chainsPath() {
    return process.env.ACPTOAPI_CHAINS_PATH || path.join(os.homedir(), '.acptoapi', 'chains.json');
}

function loadFromFile() {
    const p = chainsPath();
    try {
        if (!fs.existsSync(p)) return {};
        const j = JSON.parse(fs.readFileSync(p, 'utf8'));
        return j && typeof j === 'object' ? j : {};
    } catch { return {}; }
}

function loadFromEnv() {
    const raw = process.env.ACPTOAPI_CHAINS;
    if (!raw) return {};
    try { return JSON.parse(raw); } catch { return {}; }
}

function ensureLoaded() {
    if (_loadedFiles) return;
    _loadedFiles = true;
    _runtime = { ...loadFromFile(), ...loadFromEnv() };
}

function registerChain(name, links) {
    if (!Array.isArray(links) || links.length === 0) throw new Error('links must be a non-empty array');
    ensureLoaded();
    _runtime[name] = links;
}

function unregisterChain(name) {
    ensureLoaded();
    if (!(name in _runtime)) return false;
    delete _runtime[name];
    return true;
}

function listChains() {
    ensureLoaded();
    return {
        builtin: Object.keys(BUILTIN),
        runtime: Object.keys(_runtime),
    };
}

function resolveChain(name) {
    if (!name || typeof name !== 'string') return null;
    ensureLoaded();
    const cleaned = name.replace(/^chain\//, '').replace(/^queue\//, '');
    const links = _runtime[cleaned] || _runtime[name] || BUILTIN[cleaned] || BUILTIN[name];
    if (!links) return null;
    return links.map(model => ({ model, fallbackOn: FALLBACK_ON }));
}

module.exports = { resolveChain, registerChain, unregisterChain, listChains, BUILTIN };
