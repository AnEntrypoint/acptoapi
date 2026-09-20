'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const FALLBACK_ON = ['error', 'rate_limit', 'timeout', 'empty', 'credit_dead', 'auth', 'fetch_failed', 'content_policy', 'sampler_backoff', 'matrix_block'];

const AUTO_CHAIN_SENTINEL = null;

const BUILTIN = {
    'fast':       ['groq/llama-3.3-70b-versatile', 'groq/llama-3.1-8b-instant', 'cerebras/llama-3.3-70b'],
    'cheap':      ['openrouter/google/gemini-3.1-flash-lite', 'groq/llama-3.1-8b-instant', 'mistral/mistral-tiny-latest'],
    'smart':      ['anthropic/claude-sonnet-4-6', 'openrouter/anthropic/claude-sonnet-4.6', 'mistral/mistral-large-latest'],
    'reasoning':  ['openrouter/deepseek/deepseek-v4-pro', 'sambanova/DeepSeek-V3.2', 'nvidia/nvidia/nemotron-3-nano-omni-30b-a3b-reasoning'],
    'free':       ['groq/llama-4-scout', 'openrouter/free', 'google/gemini-2.5-flash', 'kilo/openrouter/free', 'opencode/minimax-m2.5-free'],
    'local':      ['ollama/llama3.2', 'kilo/openrouter/free', 'opencode/minimax-m2.5-free'],
    'hermes-free': ['groq/llama-4-scout', 'openrouter/free', 'google/gemini-2.5-flash', 'kilo/openrouter/free', 'opencode/minimax-m2.5-free', 'hermes-agent/hermes-3-70b'],
    'auto':       AUTO_CHAIN_SENTINEL,
    'glm-zen':    ['opencode-zen/kimi-k3', 'cerebras/zai-glm-4.7'],
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
