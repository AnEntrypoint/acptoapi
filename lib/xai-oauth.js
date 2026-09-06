'use strict';

// xAI Grok OAuth, configured over okeydokey's device-code engine. The RFC 8628
// mechanics -- discovery, origin pinning, the device grant, polling through
// authorization_pending/slow_down, refresh, the permanently-dead refresh
// marker, and the atomic on-disk token record -- all live in
// okeydokey/device-code. What remains here is what is actually specific to
// xAI: its endpoints, client id and scope, its inference base URL, the 403
// that means "this account is not entitled to API access", and the chat call.
//
// Endpoints, client_id and scope are the real values live-witnessed in
// NousResearch/hermes-agent (hermes_cli/auth.py:150-154), not documented in
// xai-grok-oauth.md, which only describes the CLI-level user experience.
const os = require('os');
const path = require('path');
const {
  createDeviceCodeSession,
  createFileTokenStore,
  requestDeviceAuthorization,
  assertAllowedOrigin,
  isJwtExpiring,
  RefreshRejectedError,
} = require('okeydokey/device-code');

const XAI_OAUTH_ISSUER = 'https://auth.x.ai';
const XAI_OAUTH_DISCOVERY_URL = `${XAI_OAUTH_ISSUER}/.well-known/openid-configuration`;
const XAI_OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';
const XAI_OAUTH_SCOPE = 'openid profile email offline_access grok-cli:access api:access';
// xAI's discovery document does not advertise a device_authorization_endpoint,
// so the sibling of its token endpoint is named explicitly.
const XAI_OAUTH_DEVICE_CODE_URL = `${XAI_OAUTH_ISSUER}/oauth2/device/code`;
const DEFAULT_XAI_OAUTH_BASE_URL = 'https://api.x.ai/v1';
const XAI_ALLOWED_HOSTS = ['x.ai'];

// Proactively refresh once fewer than this many seconds remain on the JWT.
const XAI_ACCESS_TOKEN_REFRESH_SKEW_SECONDS = 3600;

function tokenStorePath() {
  return process.env.ACPTOAPI_XAI_OAUTH_PATH || path.join(os.homedir(), '.acptoapi', 'xai-oauth.json');
}

// Records written before this module moved onto okeydokey keep their endpoints
// under `discovery`. Both names are read and both are written, so an existing
// login survives the move in either direction and nobody is made to
// re-authenticate for a refactor.
function createCompatibleStore() {
  const base = createFileTokenStore({
    path: tokenStorePath,
    onCorrupt: ({ path: file, error }) => console.log(
      `[acptoapi] xai-oauth: token store at ${file} is corrupted (invalid JSON: ${error.message}) -- treating as logged out; run 'node bin/acptoapi.js --xai-oauth-login' to fix`,
    ),
  });
  return {
    get path() { return base.path; },
    read() {
      const record = base.read();
      if (!record) return null;
      if (!record.endpoints && record.discovery) return { ...record, endpoints: record.discovery };
      return record;
    },
    write(record) {
      return base.write({ ...record, discovery: record.endpoints ?? record.discovery, saved_at: new Date().toISOString() });
    },
    update(mutate) {
      const current = this.read();
      if (!current) return null;
      return this.write(mutate(current) ?? current);
    },
  };
}

const session = createDeviceCodeSession({
  store: createCompatibleStore(),
  clientId: XAI_OAUTH_CLIENT_ID,
  scope: XAI_OAUTH_SCOPE,
  issuer: XAI_OAUTH_ISSUER,
  discoveryUrl: XAI_OAUTH_DISCOVERY_URL,
  deviceAuthorizationUrl: XAI_OAUTH_DEVICE_CODE_URL,
  allowedHosts: XAI_ALLOWED_HOSTS,
  refreshSkewSeconds: XAI_ACCESS_TOKEN_REFRESH_SKEW_SECONDS,
});

function validateInferenceBaseUrl(candidate, fallback) {
  const trimmed = (candidate || '').trim().replace(/\/+$/, '');
  if (!trimmed) return fallback;
  try {
    assertAllowedOrigin(trimmed, XAI_ALLOWED_HOSTS, 'base_url');
    return trimmed;
  } catch {
    return fallback;
  }
}

function resolvedBaseUrl(record) {
  return validateInferenceBaseUrl(process.env.XAI_BASE_URL, (record && record.base_url) || DEFAULT_XAI_OAUTH_BASE_URL);
}

function requestDeviceCode(scope = XAI_OAUTH_SCOPE) {
  return requestDeviceAuthorization({
    deviceAuthorizationUrl: XAI_OAUTH_DEVICE_CODE_URL,
    clientId: XAI_OAUTH_CLIENT_ID,
    scope,
    allowedHosts: XAI_ALLOWED_HOSTS,
  });
}

// xAI answers 403 to a refresh from an account without API entitlement. The
// generic engine cannot know that; the actionable wording belongs here.
function describeRefreshFailure(err) {
  if (err instanceof RefreshRejectedError && err.status === 403) {
    return new Error(
      `${err.message}. This OAuth account is not authorized for xAI API access -- xAI may restrict ` +
      'API/OAuth use to specific SuperGrok tiers. Set XAI_API_KEY and use the plain xai/ brand instead, ' +
      'or upgrade at https://x.ai/grok.',
    );
  }
  if (err instanceof RefreshRejectedError && err.permanent) {
    return new Error(`${err.message}. Run 'node bin/acptoapi.js --xai-oauth-login' again to re-authenticate.`);
  }
  return err;
}

async function login({ onPrompt } = {}) {
  const prompt = onPrompt || ((msg) => console.log(msg));
  const record = await session.authorize({
    extra: { base_url: resolvedBaseUrl(null) },
    onPrompt: ({ verificationUriComplete, verificationUri, userCode, intervalSeconds }) => {
      prompt('');
      prompt('To continue:');
      prompt(`  1. Open: ${verificationUriComplete || verificationUri}`);
      prompt(`  2. If prompted, enter code: ${userCode}`);
      prompt(`Waiting for approval (polling every ${Math.max(1, intervalSeconds)}s)...`);
    },
  });
  // A fresh successful login means any prior failure history for xai-oauth
  // models is stale evidence from a now-fixed credential problem (an
  // expired/corrupted token store makes every request fail regardless of the
  // model's real reachability) -- without this, availability.js's per-model
  // rank stays punished by outage-era samples until enough new traffic decays
  // it out naturally, so a freshly-fixed model sits ranked below
  // genuinely-worse options for no reason tied to its real health.
  try {
    const availability = require('./availability');
    for (const m of availability.getAll()) {
      if (m.model.startsWith('xai-oauth/')) availability.reset(m.model);
    }
  } catch {}
  prompt(`  Saved xAI OAuth credentials to ${tokenStorePath()}`);
  return record;
}

function hasCredentials() { return session.hasCredentials(); }
function isRefreshDead() { return session.isRefreshDead(); }
function isAccessTokenExpiring(accessToken, skewSeconds = 0) { return isJwtExpiring(accessToken, skewSeconds); }

// Resolve a usable bearer token + base_url, refreshing on disk if the cached
// access_token is expiring or missing.
async function getCredentials() {
  if (!session.hasCredentials()) {
    throw new Error("No xAI OAuth credentials found. Run 'node bin/acptoapi.js --xai-oauth-login' first.");
  }
  let bearer;
  try {
    bearer = await session.accessToken();
  } catch (err) {
    throw describeRefreshFailure(err);
  }
  return { bearer, baseUrl: resolvedBaseUrl(session.read()) };
}

// Force a refresh regardless of expiry (used reactively on a 401 from upstream).
async function forceRefresh() {
  let record;
  try {
    record = await session.refresh();
  } catch (err) {
    throw describeRefreshFailure(err);
  }
  return { bearer: record.tokens.access_token, baseUrl: resolvedBaseUrl(record) };
}

// Single source of truth for "make an authenticated xai-oauth chat request."
// Both server.js's executeXaiOauthModel (real traffic) and readiness.js's
// probeOne (health probing) previously diverged: real traffic went through
// this credential-aware path while readiness probes were routed through the
// generic sdk.chat()/openai-compat pipeline, which has no knowledge of the
// on-disk OAuth store and so sent `Authorization: Bearer undefined` on every
// probe -- every readiness probe for xai-oauth/* failed with a literal
// "Incorrect API key provided" regardless of whether the real token was
// healthy, silently poisoning availability.js's failStreak with false
// negatives from the first probe pass onward.
const XAI_OAUTH_MAX_RETRIES = Number(process.env.ACPTOAPI_XAI_OAUTH_MAX_RETRIES) || 5;
const XAI_OAUTH_RETRY_BASE_MS = Number(process.env.ACPTOAPI_XAI_OAUTH_RETRY_BASE_MS) || 2000;

// Real traffic's own call site (server.js's executeXaiOauthModel) never
// passed a `timeoutMs` at all -- unlike readiness.js's probeOne, which
// explicitly passes CONF.probeTimeoutMs() (8000ms) on every probe. Without
// it, doFetch's `...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) }
// : {})` attaches NO abort signal to the raw fetch, so a real request's
// underlying TCP/TLS connection can stall indefinitely with nothing to ever
// cancel it -- chain-machine.js's outer `Promise.race([promise,
// rejectAfter(timeout)])` only stops the CALLER from waiting, it does not
// abort the dangling fetch, which keeps running in the background holding a
// socket open and contending with any concurrent credential refresh on the
// same shared okeydokey session. Live-witnessed: a bare xai-oauth/grok-4.6
// request hung 85+ seconds with zero response while GET /v1/readiness
// reported that exact model healthy from the prober's own probe seconds
// earlier -- the prober's probeOne always aborts at 8s; real traffic never
// aborted at all. This default applies whenever a caller does not pass its
// own timeoutMs, so every chatCompletion call is fetch-level abort-guarded
// regardless of call site.
const XAI_OAUTH_DEFAULT_TIMEOUT_MS = Number(process.env.ACPTOAPI_XAI_OAUTH_TIMEOUT_MS) || 120000;

function isTransientFetchError(e) {
  return /fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket hang up|network/i.test(e?.message || '');
}

// body must already carry the upstream `model` (no acptoapi prefix) and
// `stream: false`. Pass { quiet: true } to suppress per-attempt console.log
// (readiness probes run every ~2min and would otherwise be as noisy as real
// request traffic for routine transient retries). Pass { maxRetries } to
// override XAI_OAUTH_MAX_RETRIES -- readiness probes pass 0 so a probe that
// hits its own outer Promise.race timeout doesn't leave a multi-attempt
// backoff loop (up to ~62s at the default 5 retries) still running detached
// in the background after the probe already gave up and moved on.
async function chatCompletion(body, { timeoutMs, quiet, maxRetries } = {}) {
  const effectiveMaxRetries = maxRetries != null ? maxRetries : XAI_OAUTH_MAX_RETRIES;
  const effectiveTimeoutMs = timeoutMs != null ? timeoutMs : XAI_OAUTH_DEFAULT_TIMEOUT_MS;
  let creds;
  try {
    creds = await getCredentials();
  } catch (e) {
    e.status = 401;
    throw e;
  }
  const url = `${creds.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const doFetch = (bearer) => fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
    body: JSON.stringify(body),
    ...(effectiveTimeoutMs ? { signal: AbortSignal.timeout(effectiveTimeoutMs) } : {}),
  });

  let lastErr = null;
  for (let attempt = 0; attempt <= effectiveMaxRetries; attempt++) {
    try {
      let r = await doFetch(creds.bearer);
      if (r.status === 401) {
        if (!quiet) console.log('[xai-oauth] upstream 401, attempting reactive token refresh');
        const refreshed = await forceRefresh();
        creds = { ...creds, bearer: refreshed.bearer };
        r = await doFetch(refreshed.bearer);
      }
      const text = await r.text();
      if (!r.ok) {
        const e = new Error(`xai-oauth ${r.status}: ${text.slice(0, 200)}`);
        e.status = r.status;
        if (r.status === 429) e.code = 'RATE_LIMIT';
        if ((r.status === 429 || r.status >= 500) && attempt < effectiveMaxRetries) {
          lastErr = e;
          const delay = XAI_OAUTH_RETRY_BASE_MS * Math.pow(2, attempt);
          if (!quiet) console.log(`[xai-oauth] attempt ${attempt + 1}/${effectiveMaxRetries + 1} failed (HTTP ${r.status}), retrying in ${delay}ms`);
          await new Promise(res => setTimeout(res, delay));
          continue;
        }
        throw e;
      }
      try { return JSON.parse(text); } catch { throw new Error('xai-oauth: non-JSON response'); }
    } catch (e) {
      if (isTransientFetchError(e) && attempt < effectiveMaxRetries) {
        lastErr = e;
        const delay = XAI_OAUTH_RETRY_BASE_MS * Math.pow(2, attempt);
        if (!quiet) console.log(`[xai-oauth] attempt ${attempt + 1}/${effectiveMaxRetries + 1} network error (${e.message}), retrying in ${delay}ms`);
        await new Promise(res => setTimeout(res, delay));
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error('xai-oauth: retries exhausted');
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
  isRefreshDead,
  isAccessTokenExpiring,
  validateInferenceBaseUrl,
  chatCompletion,
};
