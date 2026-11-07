'use strict';
const os = require('os');
const path = require('path');
const { createFileTokenStore } = require('okeydokey/device-code');
const TRANSIENT_FETCH_ERROR_RE = /fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket hang up|network/i;
function tokenStorePath(envKey, filename) { return process.env[envKey] || path.join(os.homedir(), '.acptoapi', filename); }
function createTokenStore({ envKey, filename, label, loginHint }) { return createFileTokenStore({ path: () => tokenStorePath(envKey, filename), onCorrupt: ({ path: file, error }) => console.log(`[acptoapi] ${label}: token store at ${file} is corrupted (invalid JSON: ${error.message}) -- treating as logged out; ${loginHint}`) }); }
function createLoginPrompt(onPrompt) { return onPrompt || ((msg) => console.log(msg)); }
function promptLogin(prompt, url, userCode, intervalSeconds, codePrompt, waitPhrase) {
  prompt('');
  prompt('To continue:');
  prompt(`  1. Open: ${url}`);
  prompt(`  2. ${codePrompt}: ${userCode}`);
  prompt(`Waiting for ${waitPhrase} (polling every ${Math.max(1, intervalSeconds)}s)...`);
}
function resolveBaseUrl(candidate, fallback, validate = () => true) {
  const trimmed = (candidate || '').trim().replace(/\/+$/, '');
  if (!trimmed) return fallback;
  try { if (validate(trimmed) !== false) return trimmed; } catch {}
  return fallback;
}
function createSingleFlight(task) { let inFlight = null; return () => (inFlight ??= task().finally(() => { inFlight = null; })); }
function isTransientFetchError(error) { return TRANSIENT_FETCH_ERROR_RE.test(error?.message || ''); }
function resetStaleAvailabilityHistoryForPrefix(modelPrefix) { try { const availability = require('./availability'); for (const m of availability.getAll()) if (m.model.startsWith(modelPrefix)) availability.reset(m.model); } catch {} }
function postRequest(url, contentType, body, { headers = {}, signal } = {}) { return fetch(url, { method: 'POST', headers: { 'Content-Type': contentType, ...headers }, body, ...(signal ? { signal } : {}) }); }
function postJson(url, body, options) { return postRequest(url, 'application/json', JSON.stringify(body), options); }
function postForm(url, form, options) { return postRequest(url, 'application/x-www-form-urlencoded', new URLSearchParams(form).toString(), options); }
function retryBackoff(attempt, baseMs, quiet, label, reason) { const delay = baseMs * 2 ** attempt; if (!quiet) console.log(`${label} ${reason}, retrying in ${delay}ms`); return new Promise((resolve) => setTimeout(resolve, delay)); }
module.exports = { createLoginPrompt, createSingleFlight, createTokenStore, isTransientFetchError, postForm, postJson, promptLogin, resetStaleAvailabilityHistoryForPrefix, resolveBaseUrl, retryBackoff, tokenStorePath };
