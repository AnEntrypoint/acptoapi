const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CLIENT_ID = process.env.GOOGLE_OAUTH_CLIENT_ID || '';
const CLIENT_SECRET = process.env.GOOGLE_OAUTH_CLIENT_SECRET || '';
const SCOPES = 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile';
const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CODE_ASSIST_BASE = 'https://cloudcode-pa.googleapis.com/v1internal';
const CODE_ASSIST_HEADERS = { 'X-Goog-Api-Client': 'gl-node/22.17.0', 'Client-Metadata': 'ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI' };
const TOKEN_PATH = path.join(process.env.HOME || process.env.USERPROFILE || '.', '.thebird', 'oauth-tokens.json');

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generatePkce() {
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

function readTokens() {
  try { return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8')); } catch { return null; }
}

function writeTokens(tokens) {
  fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
}

async function refreshAccessToken(refreshToken) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLIENT_ID, client_secret: CLIENT_SECRET })
  });
  if (!res.ok) throw new Error('Token refresh failed: ' + await res.text());
  const data = await res.json();
  return { accessToken: data.access_token, refreshToken: data.refresh_token || refreshToken, expiresAt: Date.now() + data.expires_in * 1000 };
}

async function getValidToken() {
  const tokens = readTokens();
  if (!tokens?.refreshToken) return null;
  if (tokens.expiresAt && tokens.expiresAt > Date.now() + 60000) return tokens;
  const refreshed = await refreshAccessToken(tokens.refreshToken);
  const updated = { ...tokens, ...refreshed };
  writeTokens(updated);
  return updated;
}

async function resolveProject(accessToken) {
  const res = await fetch(`${CODE_ASSIST_BASE}:loadCodeAssist`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}`, ...CODE_ASSIST_HEADERS },
    body: JSON.stringify({ metadata: { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' } })
  });
  if (!res.ok) throw new Error('Failed to load Code Assist project');
  const data = await res.json();
  const proj = data.cloudaicompanionProject;
  if (proj) return typeof proj === 'string' ? proj : proj.id;
  const tier = data.allowedTiers?.find(t => t.id === 'free-tier') || data.allowedTiers?.[0];
  if (!tier) throw new Error('No eligible tier: ' + (data.ineligibleTiers?.[0]?.reasonMessage || 'unknown'));
  const obRes = await fetch(`${CODE_ASSIST_BASE}:onboardUser`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}`, ...CODE_ASSIST_HEADERS },
    body: JSON.stringify({ tierId: tier.id || 'legacy-tier', metadata: { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' } })
  });
  if (!obRes.ok) throw new Error('Onboarding failed');
  let op = await obRes.json();
  for (let i = 0; i < 10 && !op.done && op.name; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const pollRes = await fetch(`${CODE_ASSIST_BASE}/${op.name}`, { headers: { Authorization: `Bearer ${accessToken}`, ...CODE_ASSIST_HEADERS } });
    if (pollRes.ok) op = await pollRes.json();
  }
  return op.response?.cloudaicompanionProject?.id;
}

function login(port) {
  return new Promise((resolve, reject) => {
    const { verifier, challenge } = generatePkce();
    const state = crypto.randomBytes(32).toString('hex');
    const callbackUrl = `http://localhost:${port}/callback`;
    const url = new URL(AUTH_URL);
    url.searchParams.set('client_id', CLIENT_ID);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('redirect_uri', callbackUrl);
    url.searchParams.set('scope', SCOPES);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);
    url.searchParams.set('access_type', 'offline');
    url.searchParams.set('prompt', 'consent');

    const server = http.createServer(async (req, res) => {
      const u = new URL(req.url, `http://localhost:${port}`);
      if (!u.pathname.startsWith('/callback')) { res.end('waiting...'); return; }
      if (u.searchParams.get('state') !== state) { res.end('Invalid state'); server.close(); reject(new Error('Invalid state')); return; }
      const code = u.searchParams.get('code');
      try {
        const tokRes = await fetch(TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code, grant_type: 'authorization_code', redirect_uri: callbackUrl, code_verifier: verifier })
        });
        if (!tokRes.ok) throw new Error('Token exchange failed: ' + await tokRes.text());
        const payload = await tokRes.json();
        if (!payload.refresh_token) throw new Error('No refresh token — ensure prompt=consent');
        const projectId = await resolveProject(payload.access_token);
        const tokens = { accessToken: payload.access_token, refreshToken: payload.refresh_token, expiresAt: Date.now() + payload.expires_in * 1000, projectId };
        writeTokens(tokens);
        res.end('Authenticated! You can close this tab.');
        server.close();
        resolve(tokens);
      } catch (e) { res.end('Error: ' + e.message); server.close(); reject(e); }
    });
    server.listen(port, () => {
      console.log(`Open this URL to authenticate:\n${url.toString()}\n`);
      try { const { exec } = require('child_process'); exec(`start "" "${url.toString()}"`); } catch {}
    });
  });
}

async function ensureAuth(port) {
  const existing = await getValidToken();
  if (existing?.accessToken && existing?.projectId) return existing;
  return login(port || 8585);
}

module.exports = { login, ensureAuth, getValidToken, readTokens, writeTokens, resolveProject, CODE_ASSIST_BASE, CODE_ASSIST_HEADERS };
