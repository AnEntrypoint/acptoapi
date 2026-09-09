'use strict';

// OpenAI/ChatGPT (Codex) OAuth. Unlike xai-oauth.js, this is NOT an RFC 8628
// device-code flow, so it does not reuse okeydokey's generic engine for the
// login mechanics -- OpenAI's own device-auth endpoints have a different
// shape (a separate poll-for-authorization-code step, then a distinct PKCE
// authorization_code exchange where the SERVER, not the client, generates
// and returns code_verifier). It still reuses okeydokey's generic
// createFileTokenStore (on-disk token record) and isJwtExpiring (refresh
// scheduling), since those are genuinely provider-agnostic.
//
// Endpoints, client_id and the device/token flow shape are the real values
// live-witnessed in NousResearch/hermes-agent (hermes_cli/auth_codex.py and
// hermes_cli/auth_constants.py), which documents importing the same
// credentials openai/codex's own CLI writes to ~/.codex/auth.json.
//
// The actual inference call is NOT OpenAI's Chat Completions API -- ChatGPT's
// backend (chatgpt.com/backend-api/codex) only speaks the Responses API
// (input/instructions/tool items, response.* SSE events), confirmed from
// openai/codex's own Rust source (codex-rs/model-provider-info,
// codex-rs/codex-api/src/endpoint/responses.rs, codex-rs/codex-api/src/common.rs)
// and codex-rs/login/src/auth/default_client.rs (the `originator: codex_cli_rs`
// header ChatGPT's backend requires). translateToResponses/translateFromResponses
// below convert to/from that shape so the rest of acptoapi keeps working with
// a plain OpenAI-chat-completions-shaped request/response, same contract
// xai-oauth.chatCompletion already provides.
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createFileTokenStore, isJwtExpiring } = require('okeydokey/device-code');

const OPENAI_OAUTH_ISSUER = 'https://auth.openai.com';
const OPENAI_OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const OPENAI_OAUTH_TOKEN_URL = `${OPENAI_OAUTH_ISSUER}/oauth/token`;
const OPENAI_OAUTH_DEVICE_USERCODE_URL = `${OPENAI_OAUTH_ISSUER}/api/accounts/deviceauth/usercode`;
const OPENAI_OAUTH_DEVICE_TOKEN_URL = `${OPENAI_OAUTH_ISSUER}/api/accounts/deviceauth/token`;
const DEFAULT_OPENAI_OAUTH_BASE_URL = 'https://chatgpt.com/backend-api/codex';
const OPENAI_ORIGINATOR = 'codex_cli_rs';
const OPENAI_OAUTH_USER_AGENT = 'acptoapi-openai-oauth/1.0';

// Proactively refresh once fewer than this many seconds remain on the JWT.
// Hermes uses 120s; a background-serving proxy benefits from a bit more
// slack so a slow request never races an about-to-expire token.
const OPENAI_ACCESS_TOKEN_REFRESH_SKEW_SECONDS = 300;

const DEVICE_CODE_MAX_WAIT_MS = 15 * 60 * 1000; // OpenAI's own device-auth window

function tokenStorePath() {
  return process.env.ACPTOAPI_OPENAI_OAUTH_PATH || path.join(os.homedir(), '.acptoapi', 'openai-oauth.json');
}

const store = createFileTokenStore({
  path: tokenStorePath,
  onCorrupt: ({ path: file, error }) => console.log(
    `[acptoapi] openai-oauth: token store at ${file} is corrupted (invalid JSON: ${error.message}) -- treating as logged out; run 'node bin/acptoapi.js --openai-oauth-login' to fix`,
  ),
});

function readRecord() { return store.read(); }
function writeRecord(record) { return store.write({ ...record, saved_at: new Date().toISOString() }); }

function resolvedBaseUrl(record) {
  const candidate = (process.env.OPENAI_CODEX_BASE_URL || (record && record.base_url) || '').trim().replace(/\/+$/, '');
  return candidate || DEFAULT_OPENAI_OAUTH_BASE_URL;
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': OPENAI_OAUTH_USER_AGENT },
    body: JSON.stringify(body),
  });
  return res;
}

async function postForm(url, data) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': OPENAI_OAUTH_USER_AGENT },
    body: new URLSearchParams(data).toString(),
  });
  return res;
}

// Step 1: request a user code + device_auth_id.
async function requestDeviceCode() {
  const res = await postJson(OPENAI_OAUTH_DEVICE_USERCODE_URL, { client_id: OPENAI_OAUTH_CLIENT_ID });
  if (res.status === 429) {
    const retryAfter = res.headers.get('retry-after');
    throw new Error(`OpenAI is rate-limiting Codex login requests (HTTP 429).${retryAfter ? ` Retry in ${retryAfter}s.` : ' Wait a minute and try again.'}`);
  }
  if (!res.ok) throw new Error(`Device code request returned status ${res.status}`);
  const data = await res.json();
  const interval = Math.max(3, Number(data.interval) || 5);
  if (!data.user_code || !data.device_auth_id) throw new Error('Device code response missing required fields');
  return { userCode: data.user_code, deviceAuthId: data.device_auth_id, interval };
}

// Step 2 happens in the caller (onPrompt shows the URL + code).

// Step 3: poll until sign-in completes. 403/404 = still pending.
async function pollForAuthorizationCode({ deviceAuthId, userCode, interval }, { signal } = {}) {
  const start = Date.now();
  while (Date.now() - start < DEVICE_CODE_MAX_WAIT_MS) {
    if (signal?.aborted) throw new Error('Login cancelled');
    await new Promise(r => setTimeout(r, interval * 1000));
    const res = await postJson(OPENAI_OAUTH_DEVICE_TOKEN_URL, { device_auth_id: deviceAuthId, user_code: userCode });
    if (res.status === 200) return res.json();
    if (res.status !== 403 && res.status !== 404) {
      throw new Error(`Device auth polling returned status ${res.status}`);
    }
  }
  throw new Error('Login timed out after 15 minutes');
}

// Step 4: swap the authorization code (+ server-issued code_verifier) for tokens.
async function exchangeAuthorizationCode({ authorization_code: code, code_verifier: codeVerifier }) {
  if (!code || !codeVerifier) throw new Error('Device auth response missing authorization_code or code_verifier');
  const res = await postForm(OPENAI_OAUTH_TOKEN_URL, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: `${OPENAI_OAUTH_ISSUER}/deviceauth/callback`,
    client_id: OPENAI_OAUTH_CLIENT_ID,
    code_verifier: codeVerifier,
  });
  if (!res.ok) throw new Error(`Token exchange returned status ${res.status}`);
  const tokens = await res.json();
  if (!tokens.access_token) throw new Error('Token exchange did not return an access_token');
  return tokens;
}

async function login({ onPrompt } = {}) {
  const prompt = onPrompt || ((msg) => console.log(msg));
  const { userCode, deviceAuthId, interval } = await requestDeviceCode();
  prompt('');
  prompt('To continue:');
  prompt(`  1. Open: ${OPENAI_OAUTH_ISSUER}/codex/device`);
  prompt(`  2. Enter code: ${userCode}`);
  prompt(`Waiting for sign-in (polling every ${interval}s)...`);
  const codeResp = await pollForAuthorizationCode({ deviceAuthId, userCode, interval });
  const tokens = await exchangeAuthorizationCode(codeResp);
  const record = {
    tokens: { access_token: tokens.access_token, refresh_token: tokens.refresh_token },
    base_url: DEFAULT_OPENAI_OAUTH_BASE_URL,
    last_refresh: new Date().toISOString(),
  };
  writeRecord(record);
  try {
    const availability = require('./availability');
    for (const m of availability.getAll()) {
      if (m.model.startsWith('openai-oauth/')) availability.reset(m.model);
    }
  } catch {}
  prompt(`  Saved OpenAI OAuth credentials to ${tokenStorePath()}`);
  return record;
}

function hasCredentials() {
  const record = readRecord();
  return !!(record && record.tokens && record.tokens.access_token && record.tokens.refresh_token);
}

async function forceRefresh() {
  const record = readRecord();
  if (!record || !record.tokens || !record.tokens.refresh_token) {
    throw new Error("No OpenAI OAuth refresh token found. Run 'node bin/acptoapi.js --openai-oauth-login' first.");
  }
  const res = await postForm(OPENAI_OAUTH_TOKEN_URL, {
    grant_type: 'refresh_token',
    refresh_token: record.tokens.refresh_token,
    client_id: OPENAI_OAUTH_CLIENT_ID,
  });
  if (res.status === 429) {
    const err = new Error('OpenAI Codex token refresh was rate-limited (HTTP 429)');
    err.status = 429;
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`OpenAI Codex token refresh failed (HTTP ${res.status}). Run 'node bin/acptoapi.js --openai-oauth-login' to re-authenticate.`);
    err.status = res.status;
    throw err;
  }
  const refreshed = await res.json();
  if (!refreshed.access_token) throw new Error('Codex token refresh response was missing access_token');
  const updated = {
    ...record,
    tokens: {
      access_token: refreshed.access_token,
      refresh_token: refreshed.refresh_token || record.tokens.refresh_token,
    },
    last_refresh: new Date().toISOString(),
  };
  writeRecord(updated);
  return { bearer: updated.tokens.access_token, baseUrl: resolvedBaseUrl(updated) };
}

async function getCredentials() {
  if (!hasCredentials()) {
    throw new Error("No OpenAI OAuth credentials found. Run 'node bin/acptoapi.js --openai-oauth-login' first.");
  }
  const record = readRecord();
  if (isJwtExpiring(record.tokens.access_token, OPENAI_ACCESS_TOKEN_REFRESH_SKEW_SECONDS)) {
    return forceRefresh();
  }
  return { bearer: record.tokens.access_token, baseUrl: resolvedBaseUrl(record) };
}

// Best-effort ChatGPT-Account-Id, decoded from the JWT's private claims --
// some account shapes require it on every inference request.
function chatgptAccountIdFrom(accessToken) {
  try {
    const payload = JSON.parse(Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf8'));
    return payload?.['https://api.openai.com/auth']?.chatgpt_account_id || null;
  } catch { return null; }
}

// --- Chat-completions <-> Responses API translation -----------------------

function textOf(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(b => (typeof b === 'string' ? b : b?.text || '')).join('');
  }
  return '';
}

function translateToResponses(body) {
  const input = [];
  let instructions = '';
  for (const m of body.messages || []) {
    if (m.role === 'system' || m.role === 'developer') {
      instructions += (instructions ? '\n\n' : '') + textOf(m.content);
      continue;
    }
    if (m.role === 'user') {
      input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: textOf(m.content) }] });
      continue;
    }
    if (m.role === 'assistant') {
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
        for (const tc of m.tool_calls) {
          input.push({ type: 'function_call', call_id: tc.id, name: tc.function?.name, arguments: tc.function?.arguments ?? '{}' });
        }
        const text = textOf(m.content);
        if (text) input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
      } else {
        input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: textOf(m.content) }] });
      }
      continue;
    }
    if (m.role === 'tool') {
      input.push({ type: 'function_call_output', call_id: m.tool_call_id, output: textOf(m.content) });
      continue;
    }
  }
  const tools = Array.isArray(body.tools) && body.tools.length
    ? body.tools.map(t => ({ type: 'function', name: t.function?.name, description: t.function?.description, parameters: t.function?.parameters || { type: 'object', properties: {} } }))
    : undefined;
  return {
    model: body.model,
    instructions,
    input,
    ...(tools ? { tools, tool_choice: 'auto', parallel_tool_calls: true } : {}),
    store: false,
    stream: true,
    include: [],
    ...(body.max_tokens ? { max_output_tokens: body.max_tokens } : {}),
  };
}

function genId(prefix) { return `${prefix}_${crypto.randomBytes(12).toString('hex')}`; }

// Raw Responses-API SSE call, one attempt, no retry/refresh (that lives in
// streamChat below, mirroring the rest of acptoapi's provider generators).
async function* rawResponsesStream(responsesBody, { bearer, baseUrl, accountId, timeoutMs }) {
  const url = `${baseUrl.replace(/\/+$/, '')}/responses`;
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
    Authorization: `Bearer ${bearer}`,
    originator: OPENAI_ORIGINATOR,
    'User-Agent': OPENAI_OAUTH_USER_AGENT,
    session_id: genId('sess'),
  };
  if (accountId) headers['ChatGPT-Account-Id'] = accountId;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(responsesBody),
    ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const e = new Error(`openai-oauth ${res.status}: ${text.slice(0, 300)}`);
    e.status = res.status;
    if (res.status === 429) e.code = 'RATE_LIMIT';
    throw e;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const d = line.slice(6).trim();
        if (!d || d === '[DONE]') continue;
        let ev;
        try { ev = JSON.parse(d); } catch { continue; }
        yield ev;
      }
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

// Drives a Responses-API turn and yields the SAME event shape every other
// provider generator in lib/providers/*.js uses (start-step/text-delta/
// tool-call/finish-step), so this plugs into translate.js's generic
// provider dispatch (lib/providers/index.js) exactly like openai.js,
// anthropic.js, etc. -- the rest of acptoapi never needs to know Codex
// speaks Responses, not Chat Completions, under the hood.
async function* streamChat({ model, messages, system, tools, max_tokens, timeoutMs } = {}) {
  const body = { model, messages: system ? [{ role: 'system', content: system }, ...(messages || [])] : (messages || []), tools: Array.isArray(tools) ? tools : undefined, max_tokens };
  const responsesBody = translateToResponses(body);
  let creds;
  try {
    creds = await getCredentials();
  } catch (e) {
    e.status = 401;
    throw e;
  }
  yield { type: 'start-step' };
  let attempted401Refresh = false;
  const toolCallsMap = {};
  let sawToolCall = false;
  while (true) {
    try {
      const accountId = chatgptAccountIdFrom(creds.bearer);
      for await (const ev of rawResponsesStream(responsesBody, { ...creds, accountId, timeoutMs })) {
        const type = ev.type;
        if (type === 'response.output_text.delta' && typeof ev.delta === 'string') {
          yield { type: 'text-delta', textDelta: ev.delta };
        } else if (type === 'response.output_item.done' && ev.item?.type === 'function_call') {
          sawToolCall = true;
          const id = ev.item.call_id || genId('call');
          let args; try { args = JSON.parse(ev.item.arguments || '{}'); } catch { args = {}; }
          toolCallsMap[id] = { toolCallId: id, toolName: ev.item.name, args };
        } else if (type === 'response.failed' || type === 'error') {
          const msg = ev.response?.error?.message || ev.error?.message || 'openai-oauth response.failed';
          throw new Error(msg);
        }
      }
      break;
    } catch (e) {
      if (e.status === 401 && !attempted401Refresh) {
        attempted401Refresh = true;
        console.log('[openai-oauth] upstream 401, attempting reactive token refresh');
        creds = await forceRefresh();
        continue;
      }
      throw e;
    }
  }
  if (sawToolCall) {
    for (const tc of Object.values(toolCallsMap)) yield { type: 'tool-call', ...tc };
    yield { type: 'finish-step', finishReason: 'tool-calls' };
  } else {
    yield { type: 'finish-step', finishReason: 'stop' };
  }
}

module.exports = {
  DEFAULT_OPENAI_OAUTH_BASE_URL,
  OPENAI_OAUTH_CLIENT_ID,
  tokenStorePath,
  login,
  hasCredentials,
  getCredentials,
  forceRefresh,
  streamChat,
  translateToResponses,
  chatgptAccountIdFrom,
};
