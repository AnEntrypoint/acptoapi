'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline/promises');
const { createFileTokenStore } = require('okeydokey/device-code');

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
const GEMINI_OPENAI_COMPAT_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const GEMINI_OAUTH_REDIRECT_URI = 'http://localhost';
const GEMINI_OAUTH_SCOPES = ['https://www.googleapis.com/auth/generative-language', 'openid', 'email'];
const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const ACCESS_TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 120000;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 2000;
const TRANSIENT_ERROR_RE = /fetch failed|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|socket hang up|network/i;

class GeminiOAuthError extends Error {
  constructor(message, { status, permanent = false } = {}) {
    super(message);
    this.name = 'GeminiOAuthError';
    this.status = status;
    this.permanent = permanent;
  }
}

const LOGIN_HINT = "Run 'node bin/acptoapi.js --gemini-oauth-login' to sign in with Google.";

const loginRequired = (reason) => new GeminiOAuthError(`${reason} ${LOGIN_HINT}`, { status: 401, permanent: true });

function tokenStorePath() {
  return process.env.ACPTOAPI_GEMINI_OAUTH_PATH || path.join(os.homedir(), '.acptoapi', 'gemini-oauth.json');
}

const store = createFileTokenStore({
  path: tokenStorePath,
  onCorrupt: ({ path: file, error }) => console.log(
    `[acptoapi] gemini-oauth: token store at ${file} is corrupted (invalid JSON: ${error.message}) -- treating as logged out; ${LOGIN_HINT}`,
  ),
});

function codeChallengeFor(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function createPkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: codeChallengeFor(verifier) };
}

function buildAuthorizationUrl({ clientId, state, codeChallenge }) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: GEMINI_OAUTH_REDIRECT_URI,
    scope: GEMINI_OAUTH_SCOPES.join(' '),
    state,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
  });
  return `${GOOGLE_AUTH_ENDPOINT}?${params}`;
}

function parseAuthorizationInput(input, expectedState) {
  const text = String(input ?? '').trim();
  if (!text) throw new GeminiOAuthError('No authorization code was pasted.');
  if (!/[?&=]/.test(text)) return text;
  const query = (text.includes('?') ? text.slice(text.indexOf('?') + 1) : text).split('#')[0];
  const params = new URLSearchParams(query);
  if (params.has('error')) throw new GeminiOAuthError(`Google did not grant access: ${params.get('error')}`);
  if (params.get('state') !== expectedState) {
    throw new GeminiOAuthError('The pasted URL is from a different login attempt (state mismatch). Start the login again and paste the URL it produces.');
  }
  const code = params.get('code');
  if (!code) throw new GeminiOAuthError('The pasted value has no code parameter.');
  return code;
}

function clientSecretForm() {
  const secret = process.env.GEMINI_OAUTH_CLIENT_SECRET;
  return secret ? { client_secret: secret } : {};
}

async function postToken(form) {
  const res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

function tokenEndpointError(context, { status, data }) {
  const detail = (data?.error_description || data?.error || 'no error body').replace(/\.$/, '');
  const hint = data?.error === 'invalid_client' ? ' Check GEMINI_OAUTH_CLIENT_ID and GEMINI_OAUTH_CLIENT_SECRET.' : '';
  return new GeminiOAuthError(`${context} failed (HTTP ${status}): ${detail}.${hint}`, { status });
}

function tokensFromResponse(data, previousRefreshToken) {
  const expiresIn = Number(data.expires_in);
  if (!data.access_token || !Number.isFinite(expiresIn)) {
    throw new GeminiOAuthError('Google returned a token response without access_token or expires_in.');
  }
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || previousRefreshToken,
    expires_at: Date.now() + expiresIn * 1000,
    scope: data.scope || '',
    token_type: data.token_type || 'Bearer',
  };
}

function identityFromIdToken(idToken, clientId) {
  if (!idToken) throw new GeminiOAuthError('Google returned no id_token; the openid and email scopes are required.');
  let claims;
  try {
    claims = JSON.parse(Buffer.from(idToken.split('.')[1] || '', 'base64url').toString('utf8'));
  } catch {
    throw new GeminiOAuthError('Google returned an unreadable id_token.');
  }
  if (!claims.sub || !claims.email) throw new GeminiOAuthError('id_token is missing sub or email.');
  if (claims.aud !== clientId) throw new GeminiOAuthError('id_token audience does not match GEMINI_OAUTH_CLIENT_ID.');
  if (!GOOGLE_ISSUERS.has(claims.iss)) throw new GeminiOAuthError('id_token issuer is not Google.');
  if (claims.exp * 1000 <= Date.now()) throw new GeminiOAuthError('id_token has expired.');
  return { sub: claims.sub, email: claims.email };
}

async function exchangeCode({ code, verifier, clientId }) {
  const res = await postToken({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    client_id: clientId,
    redirect_uri: GEMINI_OAUTH_REDIRECT_URI,
    ...clientSecretForm(),
  });
  if (!res.ok) throw tokenEndpointError('Token exchange', res);
  if (!res.data.refresh_token) {
    throw new GeminiOAuthError(
      'Google issued no refresh_token. Remove this app at https://myaccount.google.com/permissions and run the login again.',
      { status: res.status },
    );
  }
  return res.data;
}

async function login() {
  const clientId = process.env.GEMINI_OAUTH_CLIENT_ID;
  if (!clientId) {
    throw new GeminiOAuthError(
      'GEMINI_OAUTH_CLIENT_ID is not set. Create an OAuth client of type "Desktop app" in Google Cloud Console, enable the Generative Language API, and export its client ID.',
    );
  }
  const { verifier, challenge } = createPkce();
  const state = crypto.randomBytes(16).toString('base64url');
  const url = buildAuthorizationUrl({ clientId, state, codeChallenge: challenge });
  console.log('');
  console.log('To continue:');
  console.log(`  1. Open: ${url}`);
  console.log('  2. Approve access. The browser then opens http://localhost/?code=... and shows an error page; that is expected.');
  console.log("  3. Copy the full address from the browser's address bar and paste it below.");
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let pasted;
  try {
    pasted = await rl.question('Redirect URL: ');
  } finally {
    rl.close();
  }
  const code = parseAuthorizationInput(pasted, state);
  const data = await exchangeCode({ code, verifier, clientId });
  const identity = identityFromIdToken(data.id_token, clientId);
  const record = {
    client_id: clientId,
    tokens: tokensFromResponse(data, null),
    ...identity,
    authorized_at: new Date().toISOString(),
    refresh_dead: false,
  };
  store.write(record);
  console.log(`  Signed in as ${identity.email}. Saved Gemini OAuth credentials to ${tokenStorePath()}`);
  return record;
}

async function refreshCredentials() {
  const record = store.read();
  if (!record?.tokens?.refresh_token) throw loginRequired('No Gemini OAuth refresh token is stored.');
  const res = await postToken({
    grant_type: 'refresh_token',
    refresh_token: record.tokens.refresh_token,
    client_id: record.client_id,
    ...clientSecretForm(),
  });
  if (!res.ok) {
    if (res.data?.error === 'invalid_grant') {
      store.write({ ...record, refresh_dead: true });
      throw loginRequired(
        'Google rejected the Gemini OAuth refresh token. It is revoked when the grant is removed or the password changes, and for apps in Testing status it can expire after 7 days.',
      );
    }
    throw tokenEndpointError('Token refresh', res);
  }
  const next = { ...record, tokens: tokensFromResponse(res.data, record.tokens.refresh_token), refresh_dead: false };
  store.write(next);
  return next;
}

let inFlightRefresh = null;

function singleFlightRefresh() {
  inFlightRefresh ??= refreshCredentials().finally(() => { inFlightRefresh = null; });
  return inFlightRefresh;
}

async function getCredentials() {
  const record = store.read();
  if (!record?.tokens?.refresh_token) throw loginRequired('No Gemini OAuth credentials found.');
  if (record.refresh_dead) throw loginRequired('The stored Gemini OAuth refresh token was rejected earlier.');
  const { access_token: bearer, expires_at: expiresAt } = record.tokens;
  if (!bearer || Date.now() + ACCESS_TOKEN_REFRESH_SKEW_MS >= expiresAt) {
    const refreshed = await singleFlightRefresh();
    return { bearer: refreshed.tokens.access_token, email: refreshed.email };
  }
  return { bearer, email: record.email };
}

async function forceRefresh() {
  const refreshed = await singleFlightRefresh();
  return { bearer: refreshed.tokens.access_token };
}

function sendChat(body, bearer, timeoutMs) {
  return fetch(GEMINI_OPENAI_COMPAT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}

function backoff(attempt, quiet, reason) {
  const delay = RETRY_BASE_MS * 2 ** attempt;
  if (!quiet) console.log(`[gemini-oauth] attempt ${attempt + 1} failed (${reason}), retrying in ${delay}ms`);
  return new Promise((resolve) => setTimeout(resolve, delay));
}

async function chatCompletion(body, { timeoutMs = REQUEST_TIMEOUT_MS, maxRetries = MAX_RETRIES, quiet = false } = {}) {
  let { bearer } = await getCredentials();
  for (let attempt = 0; ; attempt += 1) {
    const retryable = attempt < maxRetries;
    let res;
    try {
      res = await sendChat(body, bearer, timeoutMs);
      if (res.status === 401) {
        if (!quiet) console.log('[gemini-oauth] upstream 401, attempting reactive token refresh');
        ({ bearer } = await forceRefresh());
        res = await sendChat(body, bearer, timeoutMs);
      }
    } catch (error) {
      if (!retryable || !TRANSIENT_ERROR_RE.test(error?.message || '')) throw error;
      await backoff(attempt, quiet, error.message);
      continue;
    }
    const text = await res.text();
    if (res.ok) {
      try {
        return JSON.parse(text);
      } catch {
        throw new GeminiOAuthError('gemini-oauth: non-JSON response', { status: res.status });
      }
    }
    if ((res.status === 429 || res.status >= 500) && retryable) {
      await backoff(attempt, quiet, `HTTP ${res.status}`);
      continue;
    }
    throw new GeminiOAuthError(`gemini-oauth ${res.status}: ${text.slice(0, 200)}`, { status: res.status });
  }
}

async function logout() {
  const record = store.read();
  const stored = Boolean(record?.tokens?.refresh_token);
  let revoked = false;
  if (stored) {
    const res = await fetch(GOOGLE_REVOKE_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: record.tokens.refresh_token }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }).catch(() => null);
    revoked = Boolean(res?.ok);
  }
  fs.rmSync(store.path, { force: true });
  return { stored, revoked };
}

const hasCredentials = () => Boolean(store.read()?.tokens?.refresh_token);
const isRefreshDead = () => Boolean(store.read()?.refresh_dead);

module.exports = {
  GEMINI_OAUTH_REDIRECT_URI,
  GEMINI_OAUTH_SCOPES,
  GEMINI_OPENAI_COMPAT_URL,
  GOOGLE_AUTH_ENDPOINT,
  GeminiOAuthError,
  buildAuthorizationUrl,
  chatCompletion,
  codeChallengeFor,
  createPkce,
  getCredentials,
  forceRefresh,
  hasCredentials,
  isRefreshDead,
  login,
  logout,
  parseAuthorizationInput,
  tokenStorePath,
};
