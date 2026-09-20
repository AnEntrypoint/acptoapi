'use strict';

const { createEnvKeyring, rotateCredentials, DEFAULT_BACKOFF_STEPS_MS } = require('okeydokey/keyring');

const SAME_CREDENTIAL_ENV_ALIASES = { GEMINI_API_KEY: ['GOOGLE_API_KEY'] };

const GROQ_INDEXED_KEY_SUFFIX_MAX = 99;
const ACPTOAPI_KEYS_JSON_BAG_PREFIX = 'ACPTOAPI_KEYS_';

const ring = createEnvKeyring({
  env: process.env,
  indexedSuffixMax: GROQ_INDEXED_KEY_SUFFIX_MAX,
  bagPrefix: ACPTOAPI_KEYS_JSON_BAG_PREFIX,
  aliases: SAME_CREDENTIAL_ENV_ALIASES,
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
