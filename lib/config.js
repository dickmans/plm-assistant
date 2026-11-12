// Tenant configuration: tenant name + APS Client ID (public client, PKCE - no secret needed).
// Optional: Client ID + secret of a whitelisted "Server-to-Server App", used only for impersonation (acting as other users).
// Source order: environment variables > config/tenant.json. Re-read on every call so skills can update it live.
const fs   = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '..', 'config', 'tenant.json');

function load() {
    let c = {};
    if (fs.existsSync(FILE)) c = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const tenant   = (process.env.PLM_TENANT    || c.tenant   || '').trim();
    const clientId = (process.env.APS_CLIENT_ID || c.clientId || '').trim();
    const port     = Number(process.env.PORT || c.port || 8090);
    const ssaClientId     = (process.env.APS_SSA_CLIENT_ID     || c.ssaClientId     || '').trim();
    const ssaClientSecret = (process.env.APS_SSA_CLIENT_SECRET || c.ssaClientSecret || '').trim();
    return {
        tenant, clientId, port, ssaClientId, ssaClientSecret,
        impersonationReady: Boolean(ssaClientId && ssaClientSecret),
        redirectUri : `http://localhost:${port}/callback`,
        baseUrl     : tenant ? `https://${tenant}.autodeskplm360.net` : '',
        ready       : Boolean(tenant && clientId)
    };
}

// ssa: { clientId, clientSecret } sets the optional Server-to-Server app; undefined keeps the stored one (same tenant only); null removes it.
function save(tenant, clientId, port, ssa) {
    if (!/^[a-zA-Z0-9_-]+$/.test(tenant)) throw new Error('Invalid tenant name (letters, digits, - and _ only)');
    if (!/^[a-zA-Z0-9]{20,}$/.test(clientId)) throw new Error('Invalid Client ID format');
    let old = {};
    if (fs.existsSync(FILE)) old = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const out = { tenant, clientId, port: port || 8090 };
    if (ssa === undefined) {
        if (old.tenant === tenant && old.ssaClientId && old.ssaClientSecret) { out.ssaClientId = old.ssaClientId; out.ssaClientSecret = old.ssaClientSecret; }
    } else if (ssa) {
        if (!/^[a-zA-Z0-9]{20,}$/.test(ssa.clientId || '')) throw new Error('Invalid Server-to-Server Client ID format');
        if (!ssa.clientSecret || /\s/.test(ssa.clientSecret)) throw new Error('Invalid Server-to-Server Client Secret');
        out.ssaClientId = ssa.clientId; out.ssaClientSecret = ssa.clientSecret;
    }
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(out, null, 2) + '\n', { mode: 0o600 });
}

module.exports = { load, save, FILE };
