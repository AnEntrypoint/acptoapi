'use strict';

// xAI Grok OAuth device-code flow, ported from NousResearch/hermes-agent
// (hermes_cli/auth.py). Endpoints, client_id and scope are the real values
// live-witnessed in that repo's source (not documented in xai-grok-oauth.md,
// which only describes the CLI-level user experience) -- see
// hermes_cli/auth.py:150-154, :8019-8188 for the reference implementation.
//
// Flow (RFC 8628 device authorization grant):
//   1. OIDC discovery at https://auth.x.ai/.well-known/openid-configuration
//      -> {authorization_endpoint, token_endpoint}
//   2. POST token_endpoint's sibling device-code endpoint
//      (https://auth.x.ai/oauth2/device/code) with client_id+scope
//      -> {device_code, user_code, verification_uri, verification_uri_complete,
//          expires_in, interval}
//   3. User visits verification_uri_complete, approves.
//   4. Poll token_endpoint with
//      grant_type=urn:ietf:params:oauth:grant-type:device_code
//      until access_token+refresh_token arrive (authorization_pending/slow_down
//      are expected interim responses).
//   5. Tokens persisted to disk; access_token is a short-lived JWT, refreshed
//      via grant_type=refresh_token before expiry or reactively on 401.

const fs = require('fs');
const os = require('os');
const path = require('path');

const XAI_OAUTH_ISSUER = 'https://auth.x.ai';
const XAI_OAUTH_DISCOVERY_URL = `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`;
const XAI_OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const XAI_OAUTH_SCOPE = 'openid profile email offline_access grok-cli:access api:access';
const XAI_OAUTH_DEVICE_CODE_URL = `${XAI_OAUTH_ISSUER}/oauth2/device/code`;
const DEFAULT_XAI_OAUTH_BASE_URL = 'https://api.x.ai/v1';

// Proactively refresh once fewer than this many seconds remain on the JWT.
const XAI_ACCESS_TOKEN_REFRESH_SKEW_SECONDS = 3600;

function tokenStorePath() {
  return process.env.ACPTOAPI_XAI_OAUTH_PATH || path.join(os.homedir(), '.acptoapi', 'xai-oauth.json');
}

function _readStore() {
  try {
    const raw = fs.readFileSync(tokenStorePath(), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function _writeStore(data) {
  const p = tokenStorePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p);
}

// Refuse any endpoint not on the xAI origin -- pins a cached/discovered URL
// against MITM substitution during initial discovery (mirrors hermes_cli's
// _xai_validate_oauth_endpoint / _xai_validate_inference_base_url).
function _assertXaiOrigin(url, field) {
  let u;
  try { u = new URL(url); } catch { throw new Error(`xAI OAuth ${field} is not a valid URL: ${url}`); }
  if (u.protocol !== 'https:') throw new Error(`xAI OAuth ${field} must be https: ${url}`);
  const host = (u.hostname || '').toLowerCase();
  if (host !== 'x.ai' && !host.endsWith('.x.ai')) {
    throw new Error(`xAI OAuth ${field} host '${host}' is not on the xAI origin (expected x.ai or *.x.ai): ${url}`);
  }
  return url;
}

function validateInferenceBaseUrl(candidate, fallback) {
  const trimmed = (candidate || '').trim().replace(/\/+$/, '');
  if (!trimmed) return fallback;
  try {
    _assertXaiOrigin(trimmed, 'base_url');
    return trimmed;
  } catch {
    return fallback;
  }
}

async function _discovery(timeoutMs = 15000) {
  const r = await fetch(XAI_OAUTH_DISCOVERY_URL, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`xAI OIDC discovery failed (HTTP ${r.status})`);
  const payload = await r.json();
  const authorization_endpoint = String(payload.authorization_endpoint || '').trim();
  const token_endpoint = String(payload.token_endpoint || '').trim();
  if (!authorization_endpoint || !token_endpoint) throw new Error('xAI OIDC discovery response missing required endpoints');
  _assertXaiOrigin(authorization_endpoint, 'authorization_endpoint');
  _assertXaiOrigin(token_endpoint, 'token_endpoint');
  return { authorization_endpoint, token_endpoint };
}

async function requestDeviceCode(scope = XAI_OAUTH_SCOPE) {
  const r = await fetch(XAI_OAUTH_DEVICE_CODE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ client_id: XAI_OAUTH_CLIENT_ID, scope }),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`xAI device-code request failed (HTTP ${r.status})${text ? `: ${text}` : ''}`);
  }
  const payload = await r.json();
  const required = ['device_code', 'user_code', 'verification_uri', 'verification_uri_complete', 'expires_in', 'interval'];
  const missing = required.filter((k) => !(k in payload));
  if (missing.length) throw new Error(`xAI device-code response missing fields: ${missing.join(', ')}`);
  return payload;
}

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function pollDeviceToken(tokenEndpoint, deviceCode, expiresInSec, pollIntervalSec) {
  const deadline = Date.now() + Math.max(1, expiresInSec) * 1000;
  let interval = Math.max(1, pollIntervalSec);
  while (Date.now() < deadline) {
    const r = await fetch(tokenEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: XAI_OAUTH_CLIENT_ID,
        device_code: deviceCode,
      }),
    });
    if (r.status === 200) {
      const payload = await r.json();
      if (!payload.access_token) throw new Error('xAI device-code token response missing access_token');
      if (!payload.refresh_token) throw new Error('xAI device-code token response missing refresh_token');
      return payload;
    }
    let errorPayload;
    try { errorPayload = await r.json(); } catch { throw new Error(`xAI device-code polling returned non-JSON error (HTTP ${r.status})`); }
    const errorCode = String(errorPayload.error || '');
    if (errorCode === 'authorization_pending') { await sleep(interval * 1000); continue; }
    if (errorCode === 'slow_down') { interval = Math.min(interval + 1, 30); await sleep(interval * 1000); continue; }
    const description = errorPayload.error_description || errorPayload.error || `HTTP ${r.status}`;
    throw new Error(`xAI device-code token polling failed: ${description}`);
  }
  throw new Error('Timed out waiting for xAI device authorization');
}

// Full login flow: discovery -> request device code -> print instructions ->
// poll until approved -> persist tokens to disk. Returns the saved token record.
async function login({ onPrompt } = {}) {
  const discovery = await _discovery();
  const deviceData = await requestDeviceCode();
  const verificationUrl = deviceData.verification_uri_complete || deviceData.verification_uri;
  const userCode = String(deviceData.user_code);
  const expiresIn = Number(deviceData.expires_in);
  const interval = Number(deviceData.interval);

  const prompt = onPrompt || ((msg) => console.log(msg));
  prompt('');
  prompt('To continue:');
  prompt(`  1. Open: ${verificationUrl}`);
  prompt(`  2. If prompted, enter code: ${userCode}`);
  prompt(`Waiting for approval (polling every ${Math.max(1, interval)}s)...`);

  const payload = await pollDeviceToken(discovery.token_endpoint, deviceData.device_code, expiresIn, interval);

  const baseUrl = validateInferenceBaseUrl(
    process.env.XAI_BASE_URL,
    DEFAULT_XAI_OAUTH_BASE_URL,
  );

  const record = {
    tokens: {
      access_token: String(payload.access_token),
      refresh_token: String(payload.refresh_token),
      id_token: String(payload.id_token || ''),
      expires_in: payload.expires_in,
      token_type: String(payload.token_type || 'Bearer'),
      last_refresh: new Date().toISOString(),
    },
    discovery,
    base_url: baseUrl,
    saved_at: new Date().toISOString(),
  };
  _writeStore(record);
  prompt(`  Saved xAI OAuth credentials to ${tokenStorePath()}`);
  return record;
}

// True when a JWT-shaped access_token's `exp` claim is within skewSeconds of now.
function isAccessTokenExpiring(accessToken, skewSeconds = 0) {
  if (typeof accessToken !== 'string' || !accessToken.includes('.')) return false;
  try {
    const parts = accessToken.split('.');
    if (parts.length < 2) return false;
    const payloadB64 = parts[1].replace(/-/g, '+').replace(/_/g, '/').padEnd(parts[1].length + ((4 - (parts[1].length % 4)) % 4), '=');
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'));
    const exp = payload.exp;
    if (typeof exp !== 'number') return false;
    return exp <= (Date.now() / 1000) + Math.max(0, skewSeconds);
  } catch {
    return false;
  }
}

async function refreshTokens(tokenEndpoint, refreshToken, timeoutMs = 20000) {
  if (!refreshToken) throw new Error('xAI OAuth is missing refresh_token; re-authenticate');
  _assertXaiOrigin(tokenEndpoint, 'token_endpoint');
  const r = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: XAI_OAUTH_CLIENT_ID, refresh_token: refreshToken }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    if (r.status === 403) {
      throw new Error(
        `xAI token refresh failed with HTTP 403${detail ? `: ${detail}` : ''}. This OAuth account is not ` +
        'authorized for xAI API access -- xAI may restrict API/OAuth use to specific SuperGrok tiers. ' +
        'Set XAI_API_KEY and use the plain xai/ brand instead, or upgrade at https://x.ai/grok.',
      );
    }
    throw new Error(`xAI token refresh failed (HTTP ${r.status})${detail ? `: ${detail}` : ''}`);
  }
  const payload = await r.json();
  const accessToken = String(payload.access_token || '').trim();
  if (!accessToken) throw new Error('xAI token refresh response missing access_token');
  return {
    access_token: accessToken,
    refresh_token: String(payload.refresh_token || refreshToken).trim(),
    id_token: String(payload.id_token || ''),
    expires_in: payload.expires_in,
    token_type: String(payload.token_type || 'Bearer'),
    last_refresh: new Date().toISOString(),
  };
}

// Resolve a usable bearer token + base_url, refreshing on disk if the cached
// access_token is expiring or missing. Throws if no credentials are stored.
async function getCredentials() {
  const store = _readStore();
  if (!store || !store.tokens || !store.tokens.access_token) {
    throw new Error("No xAI OAuth credentials found. Run 'node bin/acptoapi.js --xai-oauth-login' first.");
  }
  let tokens = store.tokens;
  let discovery = store.discovery;
  if (!discovery || !discovery.token_endpoint) {
    discovery = await _discovery();
  }
  if (isAccessTokenExpiring(tokens.access_token, XAI_ACCESS_TOKEN_REFRESH_SKEW_SECONDS)) {
    const refreshed = await refreshTokens(discovery.token_endpoint, tokens.refresh_token);
    tokens = { ...tokens, ...refreshed };
    store.tokens = tokens;
    store.discovery = discovery;
    _writeStore(store);
  }
  const baseUrl = validateInferenceBaseUrl(
    process.env.XAI_BASE_URL,
    store.base_url || DEFAULT_XAI_OAUTH_BASE_URL,
  );
  return { bearer: tokens.access_token, baseUrl };
}

// Force a refresh regardless of expiry (used reactively on a 401 from upstream).
async function forceRefresh() {
  const store = _readStore();
  if (!store || !store.tokens || !store.tokens.refresh_token) {
    throw new Error('No xAI OAuth refresh_token on disk; re-authenticate');
  }
  const discovery = store.discovery && store.discovery.token_endpoint ? store.discovery : await _discovery();
  const refreshed = await refreshTokens(discovery.token_endpoint, store.tokens.refresh_token);
  store.tokens = { ...store.tokens, ...refreshed };
  store.discovery = discovery;
  _writeStore(store);
  return { bearer: store.tokens.access_token, baseUrl: validateInferenceBaseUrl(process.env.XAI_BASE_URL, store.base_url || DEFAULT_XAI_OAUTH_BASE_URL) };
}

function hasCredentials() {
  const store = _readStore();
  return !!(store && store.tokens && store.tokens.access_token);
}

module.exports = {
  DEFAULT_XAI_OAUTH_BASE_URL,
  XAI_OAUTH_CLIENT_ID,
  XAI_OAUTH_SCOPE,
  XAI_OAUTH_DISCOVERY_URL,
  XAI_OAUTH_DEVICE_CODE_URL,
  tokenStorePath,
  login,
  requestDeviceCode,
  getCredentials,
  forceRefresh,
  hasCredentials,
  isAccessTokenExpiring,
  validateInferenceBaseUrl,
};
