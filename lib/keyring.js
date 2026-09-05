'use strict';

// Credential handling lives in okeydokey, the centralized credential broker.
// This file is the adapter that keeps acptoapi's long-standing envKey-shaped
// vocabulary (getKey/markKeyFailed/peekStatus, and the `key` field name that
// GET /v1/keyring/status has always published) over okeydokey's generic
// credential ring. Nothing here reimplements ordering, backoff or masking --
// a second implementation of any of those is how two surfaces measuring one
// credential's health start disagreeing about it.
const { createEnvKeyring, rotateCredentials, DEFAULT_BACKOFF_STEPS_MS } = require('okeydokey/keyring');

// Env var names that are the SAME real credential under a different name --
// Google issues one Gemini API key that its own docs/SDKs refer to
// interchangeably as GEMINI_API_KEY or GOOGLE_API_KEY. Every gemini call/
// detection site in this codebase (client.js, model-probe-live.js,
// model-resolver.js, sdk.js, server.js -- five separate hardcoded
// GEMINI_API_KEY references) only ever checked the one name, so a real,
// working key configured under the OTHER name was silently invisible
// everywhere at once -- live-witnessed: a configured GOOGLE_API_KEY never
// entered the candidate pool across a whole session (zero google/gemini
// entries in the availability cache) despite gemini being correctly present
// in PROVIDER_ORDER. Aliasing once at THIS chokepoint fixes every call site
// at once, rather than needing five separate hardcoded-name fixes that would
// inevitably drift out of sync again.
const ENV_ALIASES = { GEMINI_API_KEY: ['GOOGLE_API_KEY'] };

const ring = createEnvKeyring({
  env: process.env,
  indexedSuffixMax: 99,          // GROQ_API_KEY_1 .. GROQ_API_KEY_99
  bagPrefix: 'ACPTOAPI_KEYS_',   // ACPTOAPI_KEYS_GROQ_API_KEY=["k1","k2"]
  aliases: ENV_ALIASES,
});

function getKeys(envKey) { return ring.list(envKey); }
function hasAnyKey(envKey) { return ring.has(envKey); }
function getKey(envKey) { return ring.select(envKey); }
function listUsable(envKey) { return ring.usable(envKey); }
function markKeyFailed(envKey, key, reason) { ring.markFailed(envKey, key, reason); }
function markKeyOk(envKey, key) { ring.markOk(envKey, key); }
function reset(envKey, key) { ring.reset(envKey, key); }
function registerKey(envKey, value) { ring.register(envKey, value); }
function classify(status) { return ring.classify(status); }

// `key` rather than okeydokey's `credential`: GET /v1/keyring/status, the
// docs demo UI and the CLI all read this field name.
function peekStatus(envKey) {
  return ring.status(envKey).map((row) => ({
    index: row.index,
    key: row.credential,
    ok: row.ok,
    failCount: row.failCount,
    lastFailedAt: row.lastFailedAt,
    lastReason: row.lastReason,
    inBackoff: row.inBackoff,
    nextRetryInMs: row.nextRetryInMs,
  }));
}

// The shared rotate-on-auth/rate-limit loop. Every caller that talks to a
// keyed upstream goes through this rather than writing the loop again.
function rotateKeys(envKey, attempt, opts) {
  return rotateCredentials(ring, envKey, attempt, opts);
}

module.exports = {
  getKeys, getKey, listUsable, hasAnyKey,
  markKeyFailed, markKeyOk, reset,
  peekStatus, classify,
  registerKey,
  rotateKeys,
  _BACKOFF_STEPS_MS: DEFAULT_BACKOFF_STEPS_MS,
};
