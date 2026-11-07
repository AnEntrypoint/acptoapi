'use strict';

const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const readline = require('readline/promises');
const oauthCore = require('./oauth-core');

const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';
const GEMINI_OPENAI_COMPAT_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
const GEMINI_OAUTH_SCOPES = ['https://www.googleapis.com/auth/generative-language', 'openid', 'email'];
const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);
const ACCESS_TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 120000;
const MAX_RETRIES = 3;
const RETRY_BASE_MS = 2000;


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
  return oauthCore.tokenStorePath('ACPTOAPI_GEMINI_OAUTH_PATH', 'gemini-oauth.json');
}

const store = oauthCore.createTokenStore({
  envKey: 'ACPTOAPI_GEMINI_OAUTH_PATH',
  filename: 'gemini-oauth.json',
  label: 'gemini-oauth',
  loginHint: LOGIN_HINT,
});

function codeChallengeFor(verifier) {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function createPkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: codeChallengeFor(verifier) };
}

function buildAuthorizationUrl({ clientId, state, codeChallenge, redirectUri }) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
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
  const res = await oauthCore.postForm(GOOGLE_TOKEN_ENDPOINT, form, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
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

async function exchangeCode({ code, verifier, clientId, redirectUri }) {
  const res = await postToken({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    client_id: clientId,
    redirect_uri: redirectUri,
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

function loginTimeoutMs() {
  return Number(process.env.ACPTOAPI_GEMINI_OAUTH_TIMEOUT_MS) || 5 * 60 * 1000;
}

function openInBrowser(url) {
  if (process.env.ACPTOAPI_GEMINI_OAUTH_NO_BROWSER === '1') return false;
  const [command, args] = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function respondPage(res, status, title, body) {
  const escape = (text) => String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`<!doctype html><meta charset="utf-8"><title>${escape(title)}</title><h1>${escape(title)}</h1><p>${escape(body)}</p>`);
}

function startCallbackServer(state) {
  let settle;
  const callback = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  callback.catch(() => {});
  const server = http.createServer((req, res) => {
    const params = new URL(req.url, 'http://127.0.0.1').searchParams;
    if (params.get('state') !== state) {
      res.writeHead(404).end();
      return;
    }
    if (params.has('error')) {
      const reason = params.get('error');
      respondPage(res, 400, 'Sign-in not completed', `Google did not grant access (${reason}). Return to the terminal.`);
      settle.reject(new GeminiOAuthError(`Google did not grant access: ${reason}`));
      return;
    }
    const code = params.get('code');
    if (!code) {
      res.writeHead(404).end();
      return;
    }
    settle.resolve({ code, respond: (status, title, body) => respondPage(res, status, title, body) });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      server.on('error', (e) => settle.reject(e));
      resolve({ server, callback });
    });
  });
}

function lineReader(rl) {
  const queued = [];
  let waiting = null;
  rl.on('line', (line) => {
    if (waiting) {
      const resolve = waiting;
      waiting = null;
      resolve(line);
    } else {
      queued.push(line);
    }
  });
  return () => (queued.length ? Promise.resolve(queued.shift()) : new Promise((resolve) => { waiting = resolve; }));
}

async function pastedCode(nextLine, state) {
  for (;;) {
    const pasted = await nextLine();
    if (pasted.trim()) return { code: parseAuthorizationInput(pasted, state) };
  }
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
  const { server, callback } = await startCallbackServer(state);
  const redirectUri = `http://127.0.0.1:${server.address().port}/`;
  const url = buildAuthorizationUrl({ clientId, state, codeChallenge: challenge, redirectUri });
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const nextLine = lineReader(rl);
  const timeoutMs = loginTimeoutMs();
  let timer;
  const timedOut = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new GeminiOAuthError(
      `Sign-in was not completed within ${Math.round(timeoutMs / 1000)} seconds. Run the login again.`,
    )), timeoutMs);
  });
  let captured = null;
  try {
    console.log('');
    console.log(openInBrowser(url)
      ? 'Opening your browser to sign in with Google. If nothing opens, use this link:'
      : 'Open this link in a browser to sign in with Google:');
    console.log(`  ${url}`);
    console.log('If the browser cannot reach this machine, paste the full address it lands on here and press Enter.');
    captured = await Promise.race([callback, pastedCode(nextLine, state), timedOut]);
    const data = await exchangeCode({ code: captured.code, verifier, clientId, redirectUri });
    const identity = identityFromIdToken(data.id_token, clientId);
    const record = {
      client_id: clientId,
      tokens: tokensFromResponse(data, null),
      ...identity,
      authorized_at: new Date().toISOString(),
      refresh_dead: false,
    };
    store.write(record);
    captured.respond?.(200, 'Gemini sign-in complete', `Signed in as ${identity.email}. You can close this tab.`);
    console.log(`  Signed in as ${identity.email}. Saved Gemini OAuth credentials to ${tokenStorePath()}`);
    return record;
  } catch (e) {
    captured?.respond?.(400, 'Gemini sign-in failed', `${e.message} Return to the terminal.`);
    throw e;
  } finally {
    clearTimeout(timer);
    rl.close();
    server.close();
    server.closeAllConnections();
  }
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

const singleFlightRefresh = oauthCore.createSingleFlight(refreshCredentials);

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
  return oauthCore.postJson(GEMINI_OPENAI_COMPAT_URL, body, { headers: { Authorization: `Bearer ${bearer}` }, signal: AbortSignal.timeout(timeoutMs) });
}

function backoff(attempt, quiet, reason) {
  return oauthCore.retryBackoff(attempt, RETRY_BASE_MS, quiet, `[gemini-oauth] attempt ${attempt + 1}`, `failed (${reason})`);
}

async function openChat(body, { timeoutMs = REQUEST_TIMEOUT_MS, quiet = false } = {}) {
  let { bearer } = await getCredentials();
  let res = await sendChat(body, bearer, timeoutMs);
  if (res.status === 401) {
    if (!quiet) console.log('[gemini-oauth] upstream 401, attempting reactive token refresh');
    ({ bearer } = await forceRefresh());
    res = await sendChat(body, bearer, timeoutMs);
  }
  return res;
}

async function chatCompletion(body, { timeoutMs = REQUEST_TIMEOUT_MS, maxRetries = MAX_RETRIES, quiet = false } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    const retryable = attempt < maxRetries;
    let res;
    try {
      res = await openChat(body, { timeoutMs, quiet });
    } catch (error) {
      if (!retryable || !oauthCore.isTransientFetchError(error)) throw error;
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
    const res = await oauthCore.postForm(GOOGLE_REVOKE_ENDPOINT, { token: record.tokens.refresh_token }, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }).catch(() => null);
    revoked = Boolean(res?.ok);
  }
  fs.rmSync(store.path, { force: true });
  return { stored, revoked };
}

const hasCredentials = () => Boolean(store.read()?.tokens?.refresh_token);
const isRefreshDead = () => Boolean(store.read()?.refresh_dead);

module.exports = {
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
  openChat,
  parseAuthorizationInput,
  tokenStorePath,
};
