// Thin client for the Fusion Manage REST API (https://{tenant}.autodeskplm360.net/api/v3/...)
const config = require('./config');
const auth   = require('./auth');
const { AsyncLocalStorage } = require('async_hooks');

// Impersonation: inside runAs(userId, fn) every request is sent with the 2-legged token of the Server-to-Server app
// and the X-user-id header, so Fusion Manage performs it in the context of that user.
const actor = new AsyncLocalStorage();
const runAs = (userId, fn) => (userId ? actor.run(String(userId), fn) : fn());

async function request(method, urlPath, { body, headers = {}, raw = false } = {}) {
    const cfg = config.load();
    if (!cfg.ready) throw Object.assign(new Error('Tenant and Client ID are not configured'), { status: 400 });
    const asUser = actor.getStore();
    const token = asUser ? await auth.getSsaToken() : await auth.getAccessToken();
    const isForm = body instanceof FormData;
    const res = await fetch(cfg.baseUrl + urlPath, {
        method,
        headers : {
            Authorization : `Bearer ${token}`,
            'X-Tenant'    : cfg.tenant,
            ...(asUser ? { 'X-user-id': asUser } : {}),
            Accept        : 'application/json',
            ...(body && !isForm ? { 'Content-Type': 'application/json' } : {}),
            ...headers
        },
        body : body === undefined ? undefined : (isForm ? body : JSON.stringify(body))
    });
    if (raw) return res;
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
        const msg = (data && (data.message || data.error)) || (typeof data === 'string' ? data.slice(0, 300) : '');
        throw Object.assign(new Error(`${method} ${urlPath} -> ${res.status} ${msg}`), { status: res.status, details: data });
    }
    return { data, headers: res.headers, status: res.status };
}

const get = async (p, o) => (await request('GET', p, o)).data;

async function listAll(urlPath, key = 'items', pageSize = 100) {
    const out = [];
    for (let offset = 0; ; offset += pageSize) {
        const sep  = urlPath.includes('?') ? '&' : '?';
        const page = await get(`${urlPath}${sep}offset=${offset}&limit=${pageSize}`);
        const rows = page[key] || [];
        out.push(...rows);
        if (rows.length < pageSize) break;
    }
    return out;
}

const idOf = (link) => String(link || '').split('/').filter(Boolean).pop();

module.exports = { request, get, listAll, idOf, runAs };
