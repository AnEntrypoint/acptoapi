'use strict';

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
const XAI_OAUTH_DEVICE_CODE_URL = `${XAI_OAUTH_ISSUER}/oauth2/device/code`;
const DEFAULT_XAI_OAUTH_BASE_URL = 'https://api.x.ai/v1';
const XAI_ALLOWED_HOSTS = ['x.ai'];

const XAI_ACCESS_TOKEN_REFRESH_SKEW_SECONDS = 3600;

function tokenStorePath() {
  return process.env.ACPTOAPI_XAI_OAUTH_PATH || path.join(os.homedir(), '.acptoapi', 'xai-oauth.json');
}

function createDualEndpointsAndDiscoveryFieldStore() {
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
  store: createDualEndpointsAndDiscoveryFieldStore(),
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
  resetStaleAvailabilityHistoryForPrefix('xai-oauth/');
  prompt(`  Saved xAI OAuth credentials to ${tokenStorePath()}`);
  return record;
}

function resetStaleAvailabilityHistoryForPrefix(modelPrefix) {
  try {
    const availability = require('./availability');
    for (const m of availability.getAll()) {
      if (m.model.startsWith(modelPrefix)) availability.reset(m.model);
    }
  } catch {}
}

function hasCredentials() { return session.hasCredentials(); }
function isRefreshDead() { return session.isRefreshDead(); }
function isAccessTokenExpiring(accessToken, skewSeconds = 0) { return isJwtExpiring(accessToken, skewSeconds); }

let _refreshInFlight = null;
function singleFlightRefresh() {
  if (!_refreshInFlight) {
    _refreshInFlight = session.refresh().finally(() => { _refreshInFlight = null; });
  }
  return _refreshInFlight;
}

async function getCredentials() {
  if (!session.hasCredentials()) {
    throw new Error("No xAI OAuth credentials found. Run 'node bin/acptoapi.js --xai-oauth-login' first.");
  }
  const record = session.read();
  let bearer = record?.tokens?.access_token;
  if (!bearer || isJwtExpiring(bearer, XAI_ACCESS_TOKEN_REFRESH_SKEW_SECONDS)) {
    try {
      bearer = (await singleFlightRefresh()).tokens.access_token;
    } catch (err) {
      throw describeRefreshFailure(err);
    }
  }
  return { bearer, baseUrl: resolvedBaseUrl(session.read()) };
}

async function forceRefresh() {
  let record;
  try {
    record = await singleFlightRefresh();
  } catch (err) {
    throw describeRefreshFailure(err);
  }
  return { bearer: record.tokens.access_token, baseUrl: resolvedBaseUrl(record) };
}

const XAI_OAUTH_MAX_RETRIES = Number(process.env.ACPTOAPI_XAI_OAUTH_MAX_RETRIES) || 5;
const XAI_OAUTH_RETRY_BASE_MS = Number(process.env.ACPTOAPI_XAI_OAUTH_RETRY_BASE_MS) || 2000;
const XAI_OAUTH_DEFAULT_FETCH_ABORT_TIMEOUT_MS = Number(process.env.ACPTOAPI_XAI_OAUTH_TIMEOUT_MS) || 120000;

function isTransientFetchError(e) {
  return /fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket hang up|network/i.test(e?.message || '');
}

function isPersonalTeamSpendingLimitBlock(responseText) {
  return /spending.?limit|personal-team-blocked/i.test(responseText);
}

async function chatCompletion(upstreamModelBody, { timeoutMs, quiet, maxRetries } = {}) {
  let body = upstreamModelBody;
  const { stripMaxTokens } = require('./model-token-limits');
  if (body && (body.max_tokens != null || body.max_completion_tokens != null)) {
    body = stripMaxTokens(body);
  }
  const effectiveMaxRetries = maxRetries != null ? maxRetries : XAI_OAUTH_MAX_RETRIES;
  const effectiveTimeoutMs = timeoutMs != null ? timeoutMs : XAI_OAUTH_DEFAULT_FETCH_ABORT_TIMEOUT_MS;
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
        if (r.status === 403 && isPersonalTeamSpendingLimitBlock(text)) {
          e.code = 'RATE_LIMIT';
          e.retryAfter = Number(process.env.ACPTOAPI_XAI_SPENDING_LIMIT_RETRY_AFTER_SECONDS) || 24 * 60 * 60;
        }
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
