// APS 3-legged OAuth with PKCE (public client). Tokens are persisted in .data/tokens.json (mode 600).
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');
const config = require('./config');

const TOKEN_FILE = path.join(__dirname, '..', '.data', 'tokens.json');
const AUTH_URL   = 'https://developer.api.autodesk.com/authentication/v2/authorize';
const TOKEN_URL  = 'https://developer.api.autodesk.com/authentication/v2/token';
const SCOPE      = 'data:read data:write data:search';

const pending = new Map();  // state -> code_verifier

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function readTokens() {
    try { return JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')); } catch { return null; }
}
function writeTokens(t) {
    fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
    fs.writeFileSync(TOKEN_FILE, JSON.stringify(t, null, 2), { mode: 0o600 });
}

function loginUrl() {
    const cfg = config.load();
    if (!cfg.ready) throw new Error('Tenant and Client ID are not configured yet');
    const verifier = b64url(crypto.randomBytes(32));
    const state    = b64url(crypto.randomBytes(16));
    pending.set(state, verifier);
    const q = new URLSearchParams({
        response_type : 'code',
        client_id     : cfg.clientId,
        redirect_uri  : cfg.redirectUri,
        scope         : SCOPE,
        code_challenge: b64url(crypto.createHash('sha256').update(verifier).digest()),
        code_challenge_method: 'S256',
        state
    });
    return `${AUTH_URL}?${q}`;
}

async function tokenRequest(params) {
    const res = await fetch(TOKEN_URL, {
        method  : 'POST',
        headers : { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
        body    : new URLSearchParams(params)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`APS token request failed (${res.status}): ${data.developerMessage || data.error_description || data.error || ''}`);
    return data;
}
function store(data, previous) {
    writeTokens({
        accessToken  : data.access_token,
        refreshToken : data.refresh_token || previous?.refreshToken,   // refresh tokens are single use: persist the new one at once
        expiresAt    : Date.now() + (data.expires_in - 30) * 1000,
        tenant       : config.load().tenant
    });
}

async function handleCallback(code, state) {
    const verifier = pending.get(state);
    if (!verifier) throw new Error('Unknown or expired login state - start the login again');
    pending.delete(state);
    const cfg = config.load();
    store(await tokenRequest({
        grant_type: 'authorization_code', code, code_verifier: verifier,
        client_id: cfg.clientId, redirect_uri: cfg.redirectUri
    }));
}

let refreshing = null;
async function getAccessToken() {
    const t = readTokens();
    if (!t) throw Object.assign(new Error('Not logged in - open /login in a browser'), { status: 401 });
    if (t.tenant !== config.load().tenant) throw Object.assign(new Error('Stored login belongs to another tenant - log in again'), { status: 401 });
    if (Date.now() < t.expiresAt) return t.accessToken;
    if (!t.refreshToken) throw Object.assign(new Error('Session expired - log in again'), { status: 401 });
    refreshing ??= tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refreshToken, client_id: config.load().clientId, scope: SCOPE })
        .then((d) => { store(d, t); return d.access_token; })
        .catch((e) => { throw Object.assign(e, { status: 401 }); })
        .finally(() => { refreshing = null; });
    return refreshing;
}

// 2-legged token of the optional Server-to-Server app, used only to act as another user (impersonation).
// The secret is read from the config on demand and never logged or returned.
let ssaToken = null;
async function getSsaToken() {
    const cfg = config.load();
    if (!cfg.impersonationReady) {
        throw Object.assign(new Error('Impersonation needs the Client ID and secret of a whitelisted Server-to-Server app (run the setup skill)'), { status: 400 });
    }
    if (ssaToken && ssaToken.clientId === cfg.ssaClientId && Date.now() < ssaToken.expiresAt) return ssaToken.value;
    const res = await fetch(TOKEN_URL, {
        method  : 'POST',
        headers : {
            'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json',
            Authorization : 'Basic ' + Buffer.from(`${cfg.ssaClientId}:${cfg.ssaClientSecret}`).toString('base64')
        },
        body    : new URLSearchParams({ grant_type: 'client_credentials', scope: SCOPE })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(`APS token request of the Server-to-Server app failed (${res.status}): ${data.developerMessage || data.error_description || data.error || ''}`), { status: 401 });
    ssaToken = { clientId: cfg.ssaClientId, value: data.access_token, expiresAt: Date.now() + (data.expires_in - 60) * 1000 };
    return ssaToken.value;
}

function status() {
    const t = readTokens();
    const cfg = config.load();
    return {
        configured : cfg.ready, tenant: cfg.tenant, clientIdSet: Boolean(cfg.clientId), impersonationConfigured: cfg.impersonationReady,
        loggedIn   : Boolean(t && t.tenant === cfg.tenant && (Date.now() < t.expiresAt || t.refreshToken))
    };
}
function logout() { try { fs.unlinkSync(TOKEN_FILE); } catch {} }

module.exports = { loginUrl, handleCallback, getAccessToken, getSsaToken, status, logout };
