// Closed-loop demo data utility.
//
// Builds one connected story in Fusion Manage:
//   Quality Inspection Plan -> Quality Inspection -> Non Conformance -> CAPA -> Change Request -> Change Order (+ Change Tasks)
//
// How it works: the follow-up records (NC, CAPA, CR, CO, change tasks) are NOT created here. In a standard Fusion Manage
// quality/change setup their link fields are read-only and workflow scripts spawn them when a transition fires
// (QI "Close" -> NC, NC "Initiate CAPA" -> CAPA, CAPA "Proceed to Control" -> CR, CR "Approve" -> CO, "Initiate Tasks" -> tasks).
// So this module creates the QIP and the QI, then fills fields and performs the real workflow transitions stage by stage,
// waits for the spawned record, and continues with it. All content (field values, comments) comes from a "story" JSON
// written by the skill; this module only executes it.
//
// Safe by default: dryRun validates everything (fields, picklists, links, transition names) and writes nothing.
const fs   = require('fs');
const path = require('path');
const plm  = require('./plm');
const ppm  = require('./ppm');
const config = require('./config');
const images = require('./storyimages');

const WORK_DIR  = ppm.WORK_DIR;
const PROCESSES = ['qip', 'qi', 'nc', 'capa', 'cr', 'co'];
const LABEL = { qip: 'Quality Inspection Plan', qi: 'Quality Inspection', nc: 'Non Conformance', capa: 'CAPA', cr: 'Change Request', co: 'Change Order', task: 'Change Task' };
const WS_TITLES = {
    component : /^items(\s+and\s+boms)?$/i,
    qip       : /^quality inspection plans?$/i,
    qi        : /^quality inspections?$/i,
    nc        : /^non[\s-]*conformances?$/i,
    capa      : /^corrective\s*\/?\s*preventa?tive actions?$/i,
    cr        : /^change requests?$/i,
    co        : /^change orders?$/i,
    task      : /^change tasks?$/i,
    template  : /^change approval templates?$/i,
    product   : /^products?$/i,
    supplier  : /^suppliers?$/i
};
// Link field on the parent record that points to the record its transition spawned
const SPAWN = {
    nc   : { from: 'qi',   field: 'SPAWNED_NON_CONFORMANCE' },
    capa : { from: 'nc',   field: 'RELATED_CAPA' },
    cr   : { from: 'capa', field: 'RELATED_CR' },
    co   : { from: 'cr',   field: 'CHANGE_ORDER' }
};
const DEFAULTS  = { pollMs: 2000, spawnTimeoutMs: 90000, stateTimeoutMs: 90000, transitionWaitMs: 20000, taskTimeoutMs: 90000 };
const PLACEHOLDER = '/api/v3/dry-run/placeholder';
class StopSignal extends Error {
    constructor(proc, stage, link) { super(`stopped before "${stage.id}"`); this.proc = proc; this.stage = stage; this.link = link; }
}

/* ---------- small helpers ---------- */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm  = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
const same  = (a, b) => norm(a) === norm(b);
const esc   = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const slug  = (s) => String(s || 'story').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'story';

async function poll(fn, { timeoutMs, intervalMs, label }) {
    const t0 = Date.now();
    for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() - t0 >= timeoutMs) throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${label}`);
        await sleep(intervalMs);
    }
}

function fieldValue(detail, id) {
    for (const s of detail?.sections || []) for (const f of s.fields || []) if (plm.idOf(f.__self__) === id) return f.value;
    return undefined;
}
const linkOf  = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? (v.link || v.__self__ || null) : null);
const textOf  = (v) => (v && typeof v === 'object' ? (v.title ?? v.value ?? '') : (v ?? ''));
const stateOf = (detail) => detail?.currentState?.title || detail?.currentState?.name || '';
const itemPath = (loc) => String(loc || '').slice(String(loc || '').indexOf('/api/v3/'));
const wsOfLink = (link) => (String(link).match(/\/workspaces\/(\d+)\//) || [])[1];

function dateValue(raw) {
    const s = String(raw).trim();
    const m = s.match(/^@today(?:\s*([+-])\s*(\d+))?$/i);
    if (m) {
        const d = new Date();
        if (m[1]) d.setDate(d.getDate() + (m[1] === '-' ? -1 : 1) * Number(m[2]));
        return d.toISOString().slice(0, 10);
    }
    const p = s.replace(/\//g, '-').split('-');
    if (p.length === 3 && p[0].length === 4) return `${p[0]}-${p[1].padStart(2, '0')}-${p[2].padStart(2, '0')}`;
    throw new Error(`"${raw}" is not a date (use YYYY-MM-DD or @today-5)`);
}
function richText(v) {
    if (Array.isArray(v)) return '<ul>' + v.map((x) => `<li>${esc(x)}</li>`).join('') + '</ul>';
    const s = String(v);
    if (/<\/?[a-z][\s\S]*>/i.test(s)) return s;
    return s.split(/\n+/).filter(Boolean).map((p) => `<p>${esc(p)}</p>`).join('');
}
const plainText = (v) => (Array.isArray(v) ? v.join(', ') : String(v)).replace(/<[^>]+>/g, '');

/* ---------- context ---------- */

async function resolveWorkspaces(overrides = {}) {
    const all = await plm.listAll('/api/v3/workspaces');
    const out = {};
    for (const [key, re] of Object.entries(WS_TITLES)) {
        if (overrides[key]) { out[key] = String(overrides[key]); continue; }
        const hit = all.find((w) => re.test(w.title || w.name || ''));
        if (!hit) throw new Error(`Workspace "${key}" was not found in this tenant`);
        out[key] = String(plm.idOf(hit.link));
    }
    return out;
}

async function makeContext(story, opts = {}) {
    const ctx = {
        story, dryRun: opts.dryRun !== false, opts: { ...DEFAULTS, ...(opts.timing || {}) },
        ws: await resolveWorkspaces(story.workspaces), defs: {}, grids: {}, lookups: {}, wf: {}, sim: {}, users: null, me: null,
        imageCache: {}, filled: {}, plan: {}, stopBefore: opts.stopBefore || null, vars: { ...(story.vars || {}) },
        impersonate: opts.impersonate ?? story.impersonation === true,
        actors: new Set(), state: { created: {}, done: {} }, stateFile: path.join(WORK_DIR, `closedloop-${slug(story.name)}-state.json`),
        report: { dryRun: opts.dryRun !== false, name: story.name, steps: [], warnings: [], errors: [], items: [], coverage: {} }
    };
    if (!ctx.dryRun && opts.reset && fs.existsSync(ctx.stateFile)) fs.unlinkSync(ctx.stateFile);
    if (!ctx.dryRun && fs.existsSync(ctx.stateFile)) {
        try { ctx.state = JSON.parse(fs.readFileSync(ctx.stateFile, 'utf8')); ctx.report.resumed = true; } catch { /* start fresh */ }
    }
    return ctx;
}
const saveState = (ctx) => {
    if (ctx.dryRun) return;
    fs.mkdirSync(WORK_DIR, { recursive: true });
    fs.writeFileSync(ctx.stateFile, JSON.stringify(ctx.state, null, 2) + '\n');
};
const step = (ctx, process, what, status = 'ok', detail) => ctx.report.steps.push({ process, step: what, status, ...(detail ? { detail } : {}) });
const warn = (ctx, msg) => { ctx.report.warnings.push(msg); };
// In a dry run every problem is collected; in a real run the first problem stops the work.
function fail(ctx, msg) {
    if (ctx.dryRun) { ctx.report.errors.push(msg); return; }
    throw new Error(msg);
}

async function describe(ctx, wsId) {
    if (!ctx.defs[wsId]) {
        const d = await ppm.describeWorkspace(wsId);
        ctx.defs[wsId] = { list: d.fields, byId: Object.fromEntries(d.fields.map((f) => [f.id, f])) };
    }
    return ctx.defs[wsId];
}
async function describeGrid(ctx, wsId) {
    if (!ctx.grids[wsId]) {
        const r = await plm.get(`/api/v3/workspaces/${wsId}/views/13/fields`);
        const fields = (r.fields || []).map((f) => ({
            id: plm.idOf(f.__self__), name: f.name, type: f.type?.title || '', picklist: f.picklist || null, editable: f.editability !== 'NEVER'
        }));
        ctx.grids[wsId] = { list: fields, byId: Object.fromEntries(fields.map((f) => [f.id, f])) };
    }
    return ctx.grids[wsId];
}

async function getMe(ctx) {
    if (!ctx.me) {
        const u = await plm.get('/api/v3/users/@me');
        ctx.me = { link: `/api/v3/users/${u.userId}`, title: u.displayName, email: u.userId };
    }
    return ctx.me;
}
async function getUsers(ctx) {
    if (!ctx.users) {
        const r = await plm.get('/api/v3/users?limit=500');
        ctx.users = (r.users || r.items || []).map((u) => ({ link: u.link, title: u.title || u.displayName, email: plm.idOf(u.link) }));
    }
    return ctx.users;
}

/* ---------- impersonation ---------- */

// Who performs an action: "$role" (from vars), a user id, a user name, a /api/v3/users/ link or "@me".
// Returns the user id to impersonate, or null when the action runs as the logged-in user (also when impersonation is off).
async function resolveActor(ctx, who) {
    if (!ctx.impersonate || !who) return null;
    let v = String(who).trim();
    if (v.startsWith('$')) v = String(ctx.vars[v.slice(1)] ?? '').trim();
    if (!v || v === '@me') return null;
    v = v.replace(/^\/api\/v3\/users\//, '');
    const users = await getUsers(ctx);
    const u = users.find((x) => same(x.email, v)) || users.find((x) => same(x.title, v));
    const id = u ? u.email : v;                     // internal user id (what the API calls userId)
    if (id === (await getMe(ctx)).email) return null;
    // The X-user-id header needs the login e-mail of the user, not the internal id.
    ctx.userMail ??= {};
    if (ctx.userMail[id] === undefined) {
        try { const d = await plm.get(`/api/v3/users/${encodeURIComponent(id)}`); ctx.userMail[id] = d.email || d.userId || null; }
        catch { ctx.userMail[id] = null; }
    }
    return { id, mail: ctx.userMail[id] };
}
async function actorOf(ctx, who) { const a = await resolveActor(ctx, who); return a ? (a.mail || a.id) : null; }
async function asActor(ctx, who, fn) {
    const id = await actorOf(ctx, who);
    if (!id) return fn();
    ctx.actors.add(id);
    if (ctx.dryRun) return fn();
    return plm.runAs(id, fn);
}
function storyActors(story) {
    const out = new Set();
    for (const p of PROCESSES) {
        const c = story[p] || {};
        if (c.as) out.add(c.as);
        for (const st of c.stages || []) if (st.as) out.add(st.as);
        for (const t of c.tasks || []) { const w = t.as ?? t.fields?.ASSIGNEE; if (w) out.add(w); for (const tr of t.transitions || []) if (tr.as) out.add(tr.as); }
    }
    return [...out];
}
// Before anything is written: Server-to-Server app configured, every acting user exists and the app can really act as them.
async function verifyImpersonation(ctx) {
    if (!config.load().impersonationReady) {
        fail(ctx, 'Impersonation is selected, but no Server-to-Server app is configured. Ask the user for its Client ID and Client Secret and save them (setup skill, step 3).');
        return false;
    }
    const me = (await getMe(ctx)).email;
    const actors = new Map();
    for (const who of storyActors(ctx.story)) { const a = await resolveActor(ctx, who); if (a) actors.set(a.id, a); }
    const users = await getUsers(ctx);
    let ok = true;
    for (const a of actors.values()) {
        if (!users.some((u) => same(u.email, a.id))) { fail(ctx, `Impersonation: user "${a.id}" was not found in the tenant`); ok = false; continue; }
        try {
            const u = await plm.runAs(a.mail || a.id, () => plm.get('/api/v3/users/@me'));
            if (!same(u.userId, a.id)) { fail(ctx, `Impersonation: acting as "${a.id}" returned user "${u.userId}"`); ok = false; }
        } catch (e) { fail(ctx, `Impersonation as "${a.id}" failed: ${e.message.slice(0, 200)}. The Server-to-Server app must be whitelisted in the tenant (General Settings) and the user needs a valid e-mail address.`); ok = false; }
    }
    const ids = new Set(actors.keys());
    ctx.report.impersonation = { enabled: true, loginUser: me, actors: [...ids] };
    step(ctx, 'run', `impersonation verified for ${ids.size} user(s): ${[...ids].join(', ') || 'none besides the login user'}`, ctx.dryRun ? 'dry-run' : 'ok');
    return ok;
}

async function lookupOptions(ctx, picklist) {
    if (!ctx.lookups[picklist]) {
        const rows = await plm.listAll(picklist, 'items', 100);
        ctx.lookups[picklist] = rows.map((o) => ({ link: o.link || o.__self__, title: String(o.title ?? o.name ?? o.value ?? '') }));
    }
    return ctx.lookups[picklist];
}

/* ---------- value conversion ---------- */

function pickByTitle(options, raw, what) {
    const q = norm(raw);
    let hits = options.filter((o) => norm(o.title) === q);
    if (!hits.length) hits = options.filter((o) => norm(o.title).startsWith(q));
    if (!hits.length) hits = options.filter((o) => norm(o.title).includes(q));
    if (hits.length === 1) return hits[0].link;
    const list = options.slice(0, 15).map((o) => o.title).join(', ') + (options.length > 15 ? ', ...' : '');
    throw new Error(hits.length ? `"${raw}" is ambiguous for ${what} (${hits.map((h) => h.title).join(', ')})` : `"${raw}" is not an option of ${what} (options: ${list})`);
}

async function resolveLinkRaw(ctx, def, raw) {
    if (raw && typeof raw === 'object' && raw.link) return raw.link;
    const s = String(raw).trim();
    if (s.startsWith('$')) {
        const name = s.slice(1);
        const v = ctx.vars[name] || ctx.state.created[name];
        if (v) return /^\/api\//.test(v) ? v : resolveLinkRaw(ctx, def, v);   // vars may hold "@me", an email or a user name
        if (ctx.dryRun) return PLACEHOLDER;
        throw new Error(`Unknown reference ${s} (not in vars and not created yet)`);
    }
    if (s === '@me') return (await getMe(ctx)).link;
    if (s.startsWith('/api/')) return s;
    const pick = def.picklist || '';
    if (/ALL_USERS|USERS/i.test(pick)) {
        const users = await getUsers(ctx);
        const byMail = users.find((u) => same(u.email, s));
        if (byMail) return byMail.link;
        return pickByTitle(users, s, `user field ${def.id}`);
    }
    if (/CUSTOM_LOOKUP_WS_/i.test(pick)) throw new Error(`${def.id} points to records: give a link (/api/v3/workspaces/...) or a $variable, not "${s}"`);
    if (!pick) throw new Error(`${def.id} has no picklist, cannot resolve "${s}"`);
    return pickByTitle(await lookupOptions(ctx, pick), s, `${def.name} (${def.id})`);
}

// A user picklist can be restricted to a few users (the lookup then holds fewer users than the tenant). A plain user
// link is silently ignored there, so map the user to the matching lookup option; warn when the user is not offered.
const nameKey = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9\u00c0-\u024f ]+/g, ' ').split(/\s+/).filter(Boolean).sort().join(' ');
async function userName(ctx, link) {
    ctx.userNames = ctx.userNames || {};
    if (!ctx.userNames[link]) {
        const known = (await getUsers(ctx)).find((u) => u.link === link);
        let name = known && known.title && known.title.trim();
        if (!name) { try { const u = await plm.get(link); name = (u.displayName || '').trim() || [u.firstName, u.lastName].filter(Boolean).join(' '); } catch { name = ''; } }
        ctx.userNames[link] = name || plm.idOf(link);
    }
    return ctx.userNames[link];
}
async function resolveLink(ctx, def, raw) {
    const link = await resolveLinkRaw(ctx, def, raw);
    if (!/^\/api\/v3\/users\//.test(String(link)) || !/USERS/i.test(def.picklist || '')) return link;
    let opts = [];
    try { opts = await lookupOptions(ctx, def.picklist); } catch { return link; }
    if (!opts.length) return link;
    const key = nameKey(await userName(ctx, link));
    const hit = opts.find((o) => nameKey(o.title) === key);
    if (hit) return hit.link;
    warn(ctx, `${def.name} (${def.id}): ${await userName(ctx, link)} is not in this field's picklist (${opts.slice(0, 8).map((o) => o.title).join(', ')}${opts.length > 8 ? ', ...' : ''}); the tenant may ignore the value`);
    return link;
}

async function toApiValue(ctx, def, raw) {
    if (raw === null || raw === '') return null;
    const t = (def.type || '').toLowerCase();
    if (/multiple|multi/.test(t)) {
        const arr = Array.isArray(raw) ? raw : [raw];
        const links = [...new Set(await Promise.all(arr.map((x) => resolveLink(ctx, def, x))))];
        return links.map((link) => ({ link }));
    }
    if (/selection|radio|picklist|linking/.test(t) || (def.picklist && !/check/.test(t))) return { link: await resolveLink(ctx, def, raw) };
    if (/check/.test(t)) return raw === true || /^(true|yes|1)$/i.test(String(raw));
    if (/integer/.test(t)) { const n = parseInt(raw, 10); if (Number.isNaN(n)) throw new Error(`"${raw}" is not an integer`); return n; }
    if (/float|number|decimal|money/.test(t)) {
        const n = Number(raw); if (Number.isNaN(n)) throw new Error(`"${raw}" is not a number`);
        return /money/.test(t) ? String(n) : n;      // money fields are only accepted as strings by the tenant
    }
    if (/date/.test(t) && !/time/.test(t)) return dateValue(raw);
    if (/paragraph/.test(t) && !/w\/o/.test(t)) return richText(raw);
    return plainText(raw);
}

function buildSections(wsId, defs, entries, link) {
    const bySection = new Map();
    for (const [id, value] of entries) {
        const sid = defs.byId[id].section?.id;
        if (!sid) throw new Error(`Field ${id} has no section - cannot write it`);
        const sectionLink = link ? `${link}/views/1/sections/${sid}` : `/api/v3/workspaces/${wsId}/sections/${sid}`;
        const fieldLink   = link ? `${link}/views/1/fields/${id}`    : `/api/v3/workspaces/${wsId}/views/1/fields/${id}`;
        if (!bySection.has(sectionLink)) bySection.set(sectionLink, { link: sectionLink, fields: [] });
        bySection.get(sectionLink).fields.push({ __self__: fieldLink, value });
    }
    return [...bySection.values()];
}

/* ---------- images ---------- */

async function componentImage(ctx) {
    if (!ctx.imageCache.component) {
        let l = linkOf(fieldValue(await plm.get(ctx.vars.component), 'IMAGE'));
        // Fall back to the affected product's picture when the component has none
        if (!l && ctx.vars.product) l = linkOf(fieldValue(await plm.get(ctx.vars.product), 'IMAGE'));
        if (!l) throw new Error('the component (and the product) has no image');
        // The image endpoint only answers to this Accept header; the content-type it reports is unreliable, so sniff the bytes.
        const res = await plm.request('GET', l, { raw: true, headers: { Accept: 'application/octet-stream' } });
        if (!res.ok) throw new Error(`component image download failed (${res.status})`);
        const buf = Buffer.from(await res.arrayBuffer());
        const kind = images.sniff(buf);
        if (!kind) throw new Error('the component image is neither PNG nor JPEG');
        ctx.imageCache.component = { buf, type: kind.type, name: `component.${kind.ext}` };
    }
    return ctx.imageCache.component;
}
async function componentPhoto(ctx) {
    if (ctx.imageCache.photo === undefined) {
        try { ctx.imageCache.photo = images.decodeImage((await componentImage(ctx)).buf); } catch { ctx.imageCache.photo = null; }
        if (!ctx.imageCache.photo) warn(ctx, 'The component photo could not be decoded (needs PNG, or JPEG on macOS), so annotated images show a placeholder instead of the photo');
    }
    return ctx.imageCache.photo;
}
function inspectionRows(ctx) {
    const grid = ctx.story.qip?.grid || [], results = ctx.story.qi?.results || {};
    const rows = [];
    for (const [key, vals] of Object.entries(results)) {
        const g = grid.find((r) => same(r.ID, key) || same(r.REFERENCE, key));
        if (g && vals.ACTUAL !== undefined) rows.push({ label: g.REFERENCE || g.ID, nominal: Number(g.NOMINAL), lo: Number(g.LOWER_TOLERANCE ?? 0), hi: Number(g.UPPER_TOLERANCE ?? 0), actual: Number(vals.ACTUAL), unit: g.UNITS || '' });
    }
    return rows;
}
async function recordSummaries(ctx) {
    const out = {};
    for (const proc of PROCESSES) {
        const link = ctx.state.created[proc];
        if (link && !ctx.dryRun) { const d = await getItem(link); out[proc] = { number: textOf(fieldValue(d, 'NUMBER')), state: stateOf(d) }; }
        else out[proc] = { number: ctx.dryRun ? 'AT RUN TIME' : '-', state: ctx.sim[proc]?.state || '' };
    }
    return out;
}
const imageSpecOf = (raw) => (raw && typeof raw === 'object' ? (raw.generate || (raw.type ? raw : null)) : null);

async function generateImage(ctx, spec, { proc, id }) {
    const base = spec.base ?? '@component';
    let photo = null;
    if (spec.type === 'callout') {
        if (base === '@component') photo = await componentPhoto(ctx);
        else {   // a file in work/ or a URL as the photo to mark up
            try { photo = images.decodeImage((await ppm.loadImage(base)).buf); } catch (e) { warn(ctx, `callout base "${base}" could not be used: ${e.message}`); }
        }
    }
    const buf = images.render(spec, {
        rows: spec.type === 'measurement-chart' && spec.source === 'inspection' ? inspectionRows(ctx) : undefined,
        photo,
        records: spec.type === 'closed-loop' ? await recordSummaries(ctx) : undefined
    });
    const dir = path.join(WORK_DIR, `closedloop-${slug(ctx.story.name)}-images`);
    fs.mkdirSync(dir, { recursive: true });
    const tag = ctx.imgPrefix || proc;
    const file = path.join(dir, `${tag}-${id}.png`);
    fs.writeFileSync(file, buf);
    ctx.report.images = ctx.report.images || [];
    ctx.report.images = ctx.report.images.filter((x) => x.tag !== `${tag}-${id}`);
    ctx.report.images.push({ tag: `${tag}-${id}`, process: ctx.imgPrefix ? `${LABEL[proc]} (${ctx.imgPrefix.replace(/^[a-z]+-task-/, '')})` : LABEL[proc], field: id, type: spec.type, title: spec.title, file: path.relative(path.join(__dirname, '..'), file) });
    return { buf, type: 'image/png', name: `${tag}-${id}.png` };
}
async function loadImageRef(ctx, ref, meta) {
    const spec = imageSpecOf(ref);
    if (spec) return generateImage(ctx, spec, meta);
    if (ref === '@component') return componentImage(ctx);
    return ppm.loadImage(ref);
}

/* ---------- writing fields ---------- */

async function prepareFields(ctx, proc, fields) {
    const wsId = ctx.ws[proc];
    const defs = await describe(ctx, wsId);
    const out = { normal: [], readOnly: [], images: [] };
    for (const [id, raw] of Object.entries(fields || {})) {
        if (id.startsWith('_') || raw === undefined) continue;
        const def = defs.byId[id];
        if (!def) { fail(ctx, `${LABEL[proc]}: field ${id} does not exist`); continue; }
        (ctx.filled[proc] ||= new Set()).add(id);
        if (!def.section) { fail(ctx, `${LABEL[proc]}: field ${id} is not part of any section and cannot be written`); continue; }
        if (/image/i.test(def.type)) {
            if (raw === '@component' && ctx.dryRun && ctx.componentHasImage === undefined) {
                ctx.componentHasImage = Boolean(linkOf(fieldValue(await plm.get(ctx.vars.component), 'IMAGE'))
                    || (ctx.vars.product && linkOf(fieldValue(await plm.get(ctx.vars.product), 'IMAGE'))));
            }
            if (raw === '@component' && ctx.dryRun && !ctx.componentHasImage) warn(ctx, `${LABEL[proc]}.${id}: the component has no image, "@component" will be skipped`);
            if (ctx.dryRun && imageSpecOf(raw)) {   // render in the dry run: validates the spec and writes a preview file
                try { await generateImage(ctx, imageSpecOf(raw), { proc, id }); } catch (e) { fail(ctx, `${LABEL[proc]}.${id}: image - ${e.message}`); }
            }
            if (raw) out.images.push([id, raw]);
            continue;
        }
        try {
            const value = await toApiValue(ctx, def, raw);
            (def.editable ? out.normal : out.readOnly).push([id, value]);
        } catch (e) { fail(ctx, `${LABEL[proc]}.${id}: ${e.message}`); }
    }
    return out;
}

// Writes everything except the "normal" fields of a brand-new item (those travel in the POST).
async function commitFields(ctx, proc, link, prepared, { includeNormal }) {
    const wsId = ctx.ws[proc];
    const defs = await describe(ctx, wsId);
    if (includeNormal && prepared.normal.length) {
        try { await plm.request('PATCH', link, { body: { sections: buildSections(wsId, defs, prepared.normal, link) } }); }
        catch (e) {
            if (e.status !== 400 || prepared.normal.length < 2) throw e;
            // Find the field(s) the tenant rejects: write them one by one (the valid ones stay written).
            const bad = [];
            for (const entry of prepared.normal) {
                try { await plm.request('PATCH', link, { body: { sections: buildSections(wsId, defs, [entry], link) } }); }
                catch (e2) { bad.push(`${entry[0]} (${e2.message.replace(/^.*-> \d+\s*/, '').slice(0, 100)})`); }
            }
            if (bad.length) throw new Error(`${LABEL[proc]}: the tenant rejected field(s) ${bad.join('; ')}`);
        }
    }
    // Read-only fields are normally owned by scripts; try them one by one and downgrade failures to warnings.
    for (const entry of prepared.readOnly) {
        try { await plm.request('PATCH', link, { body: { sections: buildSections(wsId, defs, [entry], link) } }); }
        catch (e) { warn(ctx, `${LABEL[proc]}.${entry[0]} is read-only in this tenant and was not set (${e.message.slice(0, 120)})`); }
    }
    for (const [id, ref] of prepared.images) {
        try { await ppm.uploadImage(link, id, await loadImageRef(ctx, ref, { proc, id })); }
        catch (e) { warn(ctx, `${LABEL[proc]}.${id}: image skipped - ${e.message}`); }
    }
}

async function applyFields(ctx, proc, link, fields) {
    const prepared = await prepareFields(ctx, proc, fields);
    if (ctx.dryRun) {
        step(ctx, proc, `set ${Object.keys(fields || {}).filter((k) => !k.startsWith('_')).length} fields`, 'dry-run');
        for (const [id] of prepared.readOnly) warn(ctx, `${LABEL[proc]}.${id} is read-only; the utility will try, but the tenant may ignore it`);
        return;
    }
    await commitFields(ctx, proc, link, prepared, { includeNormal: true });
    step(ctx, proc, `set ${prepared.normal.length + prepared.readOnly.length + prepared.images.length} fields`);
}

async function createItem(ctx, proc, fields) {
    const wsId = ctx.ws[proc];
    const defs = await describe(ctx, wsId);
    const prepared = await prepareFields(ctx, proc, fields);
    if (ctx.dryRun) { step(ctx, proc, `create ${LABEL[proc]}`, 'dry-run'); return null; }
    let res;
    try {
        res = await plm.request('POST', `/api/v3/workspaces/${wsId}/items`, { body: { sections: buildSections(wsId, defs, prepared.normal, null) } });
    } catch (e) {
        // Some tenants validate fields derived from a source record (for example the QI from its plan) on create and
        // report the expected values. Retry once with exactly those values.
        const derived = (Array.isArray(e.details) ? e.details : []).filter((d) => d.code === 'error.derived.invalidDerivedFieldValue' && d.field && d.arguments?.length);
        if (e.status !== 400 || !derived.length) throw e;
        const have = new Set(prepared.normal.map(([id]) => id));
        const extra = [];
        for (const d of derived) {
            const id = plm.idOf(d.field.__self__);
            const def = defs.byId[id];
            if (!def || have.has(id)) continue;
            const arg = d.arguments[0];
            const t = (def.type || '').toLowerCase();
            let value = arg;
            if (def.picklist && /radio|selection|picklist/.test(t)) value = { link: `${def.picklist.replace(/\/options\/?$/, '')}/options/${arg}` };
            else if (/integer/.test(t)) value = parseInt(arg, 10);
            else if (/image/.test(t)) value = /^\d+$/.test(arg) ? parseInt(arg, 10) : arg;
            extra.push([id, value]);
        }
        if (!extra.length) throw e;
        res = await plm.request('POST', `/api/v3/workspaces/${wsId}/items`, { body: { sections: buildSections(wsId, defs, [...prepared.normal, ...extra], null) } });
    }
    const link = itemPath(res.headers.get('location'));
    if (!link) throw new Error(`${LABEL[proc]} was created but no location was returned`);
    ctx.state.created[proc] = link;
    saveState(ctx);
    await commitFields(ctx, proc, link, prepared, { includeNormal: false });
    step(ctx, proc, `create ${LABEL[proc]}`, 'ok', link);
    return link;
}

/* ---------- workflow ---------- */

async function loadWorkflow(ctx, wsId) {
    if (!ctx.wf[wsId]) {
        const [st, tr] = await Promise.all([plm.get(`/api/v3/workspaces/${wsId}/workflows/1/states`), plm.get(`/api/v3/workspaces/${wsId}/workflows/1/transitions`)]);
        const stateName = {};
        for (const s of (Array.isArray(st) ? st : st.states || st.items || [])) stateName[plm.idOf(s.link || s.__self__)] = s.name || s.title;
        const arr = Array.isArray(tr) ? tr : tr.transitions || tr.items || [];
        ctx.wf[wsId] = arr.map((t) => ({
            name: t.name, label: t.customLabel,
            from: t.fromState ? (stateName[plm.idOf(t.fromState.link)] || t.fromState.title) : null,
            to  : t.toState   ? (stateName[plm.idOf(t.toState.link)]   || t.toState.title)   : null
        }));
    }
    return ctx.wf[wsId];
}

async function simState(ctx, proc) {
    if (!ctx.sim[proc]) {
        const wf = await loadWorkflow(ctx, ctx.ws[proc]);
        const start = wf.find((t) => !t.from);
        ctx.sim[proc] = { state: start?.to || null };
    }
    return ctx.sim[proc];
}

async function availableTransitions(link) {
    const r = await plm.get(`${link}/workflows/1/transitions`);
    return (Array.isArray(r) ? r : r.transitions || r.items || []).map((t) => ({
        name: t.name, label: t.customLabel, link: t.__self__ || t.link, to: t.toState?.title || null
    }));
}

async function checkQiFailures(ctx, link) {
    const detail = await plm.get(link);
    const max = parseInt(textOf(fieldValue(detail, 'MAXIMUM_FAILURES')), 10);
    const rows = await getRows(link);
    const fails = rows.filter((r) => /FAIL/i.test(String(r.cells.RESULT || r.cells.FLAG || ''))).length;
    if (!Number.isNaN(max) && fails <= max) {
        throw new Error(`The inspection has ${fails} failing measurement(s) but allows up to ${max}: closing it would not spawn a Non Conformance. Add more out-of-tolerance results to qi.results.`);
    }
}

async function performTransition(ctx, proc, link, name, comment, { waitMs } = {}) {
    if (ctx.dryRun) {
        const sim = await simState(ctx, proc);
        const wf  = await loadWorkflow(ctx, ctx.ws[proc]);
        const t = wf.find((x) => (same(x.name, name) || same(x.label, name)) && x.from && same(x.from, sim.state));
        if (!t) {
            const avail = wf.filter((x) => x.from && same(x.from, sim.state)).map((x) => x.name);
            fail(ctx, `${LABEL[proc]}: transition "${name}" is not possible from state "${sim.state}" (possible: ${avail.join(', ') || 'none'})`);
            return;
        }
        sim.state = t.to;
        step(ctx, proc, `transition "${name}" -> ${t.to}`, 'dry-run');
        return;
    }
    if (proc === 'qi' && /^close$/i.test(name)) await checkQiFailures(ctx, link);
    let list = [];
    const t = await poll(async () => {
        list = await availableTransitions(link);
        return list.find((x) => same(x.name, name) || same(x.label, name)) || null;
    }, { timeoutMs: waitMs ?? ctx.opts.transitionWaitMs, intervalMs: ctx.opts.pollMs, label: `transition "${name}"` })
        .catch((e) => {
            if (!/^Timed out/.test(e.message)) throw e;
            throw new Error(`${LABEL[proc]}: transition "${name}" is not available (state "${list.length ? '' : 'unknown'}"; available: ${list.map((x) => x.name).join(', ') || 'none'})`);
        });
    await plm.request('POST', `${link}/workflows/1/transitions`, { body: { comment: comment || '' }, headers: { 'Content-Location': t.link } });
    if (t.to) {
        try { await poll(async () => same(stateOf(await plm.get(link)), t.to), { timeoutMs: ctx.opts.transitionWaitMs, intervalMs: ctx.opts.pollMs, label: `state ${t.to}` }); }
        catch { warn(ctx, `${LABEL[proc]}: after "${name}" the state did not become "${t.to}" (a script may have moved it on)`); }
    }
    step(ctx, proc, `transition "${name}"`, 'ok', t.to ? `-> ${t.to}` : undefined);
}

async function awaitState(ctx, proc, link, spec) {
    const target = typeof spec === 'string' ? spec : spec.state;
    const timeoutMs = (spec.timeoutSec ? spec.timeoutSec * 1000 : ctx.opts.stateTimeoutMs);
    if (ctx.dryRun) { (await simState(ctx, proc)).state = target; step(ctx, proc, `wait for script to reach "${target}"`, 'dry-run'); return; }
    await poll(async () => same(stateOf(await plm.get(link)), target), { timeoutMs, intervalMs: ctx.opts.pollMs, label: `${LABEL[proc]} to reach state "${target}"` });
    step(ctx, proc, `reached "${target}"`);
}

/* ---------- grids ---------- */

function parseRow(row) {
    const cells = {};
    let rowId = null;
    for (const c of row.rowData || []) {
        if (c.title === 'Row Id') { rowId = c.value; continue; }
        cells[plm.idOf(c.__self__)] = c.value && typeof c.value === 'object' ? (c.value.title ?? c.value.link) : c.value;
    }
    return { rowId, cells };
}
async function getRows(link) {
    const r = await plm.get(`${link}/views/13/rows?limit=500`);
    return (r?.rows || []).map(parseRow);
}
async function rowPayload(ctx, wsId, values, { force = false } = {}) {
    const grid = await describeGrid(ctx, wsId);
    const rowData = [];
    for (const [id, raw] of Object.entries(values)) {
        const def = grid.byId[id];
        if (!def) throw new Error(`grid column ${id} does not exist (columns: ${grid.list.map((f) => f.id).join(', ')})`);
        if (def.editable === false && !force) throw new Error(`grid column ${id} is read-only`);
        let value = raw;
        const t = (def.type || '').toLowerCase(), d2 = { id, name: def.name, picklist: def.picklist };
        if (raw === null || raw === '') value = null;
        else if (/multiple/.test(t)) value = [...new Set(await Promise.all((Array.isArray(raw) ? raw : [raw]).map((x) => resolveLink(ctx, d2, x))))].map((link) => ({ link }));
        else if (def.picklist) value = { link: await resolveLink(ctx, d2, raw) };
        else if (/integer/.test(t)) value = parseInt(raw, 10);
        else if (/float|number|money/.test(t)) value = Number(raw);
        else if (/date/.test(t)) value = dateValue(raw);
        else if (/paragraph/.test(t) && !/w\/o/.test(t)) value = richText(raw);
        else value = String(raw);
        rowData.push({ __self__: `/api/v3/workspaces/${wsId}/views/13/fields/${id}`, value });
    }
    return { rowData };
}

function measurementStatus(row, actual) {
    const nominal = Number(row.NOMINAL), lo = Number(row.LOWER_TOLERANCE ?? 0), hi = Number(row.UPPER_TOLERANCE ?? 0);
    return actual >= nominal - lo - 1e-9 && actual <= nominal + hi + 1e-9 ? 'PASS' : 'FAIL';
}

async function fillQipGrid(ctx, link) {
    const rows = ctx.story.qip.grid || [];
    const wsId = ctx.ws.qip;
    for (const row of rows) {
        try {
            const body = await rowPayload(ctx, wsId, row);
            if (!ctx.dryRun) await plm.request('POST', `${link}/views/13/rows`, { body });
        } catch (e) { fail(ctx, `${LABEL.qip} grid row ${row.ID || row.REFERENCE}: ${e.message}`); }
    }
    step(ctx, 'qip', `add ${rows.length} measurement rows`, ctx.dryRun ? 'dry-run' : 'ok');
}

async function fillQiResults(ctx, link) {
    const results = ctx.story.qi.results || {};
    const qipRows = ctx.story.qip.grid || [];
    let fails = 0;
    if (ctx.dryRun) {
        for (const [key, vals] of Object.entries(results)) {
            const row = qipRows.find((r) => same(r.ID, key) || same(r.REFERENCE, key));
            if (!row) { fail(ctx, `${LABEL.qi}.results: "${key}" matches no row of qip.grid (use the row ID or reference)`); continue; }
            if (vals.ACTUAL !== undefined && measurementStatus(row, Number(vals.ACTUAL)) === 'FAIL') fails++;
            try { await rowPayload(ctx, ctx.ws.qi, vals); } catch (e) { fail(ctx, `${LABEL.qi}.results.${key}: ${e.message}`); }
        }
        if (qipRows.length && Object.keys(results).length < qipRows.length) warn(ctx, `${LABEL.qi}: only ${Object.keys(results).length} of ${qipRows.length} measurement rows have a result`);
        if (!fails) warn(ctx, `${LABEL.qi}: no measurement is out of tolerance, so closing the inspection will not spawn a Non Conformance`);
        else step(ctx, 'qi', `${fails} out-of-tolerance measurement(s) will fail the inspection`, 'dry-run');
        return;
    }
    const rows = await poll(async () => { const r = await getRows(link); return r.length ? r : null; },
        { timeoutMs: ctx.opts.spawnTimeoutMs, intervalMs: ctx.opts.pollMs, label: 'the inspection to copy the plan measurements' });
    // Only plan columns that also exist in the inspection grid can be sent back
    const qiGrid = await describeGrid(ctx, ctx.ws.qi);
    for (const [key, vals] of Object.entries(results)) {
        const planIdx = qipRows.findIndex((r) => same(r.ID, key) || same(r.REFERENCE, key));
        let row = rows.find((r) => same(r.cells.ID, key) || same(r.cells.REFERENCE, key));
        // A row whose plan columns were blanked earlier is found by its position
        if (!row && planIdx >= 0 && rows.length === qipRows.length) row = [...rows].sort((a, b) => Number(a.rowId) - Number(b.rowId))[planIdx];
        if (!row) throw new Error(`${LABEL.qi}: no measurement row "${key}" (rows: ${rows.map((r) => r.cells.ID).join(', ')})`);
        // A row update replaces the whole row, so the columns copied from the plan are sent again with the result
        const PLAN_COLS = ['ID', 'REFERENCE', 'DESCRIPTION', 'MEASUREMENT_DEVICE', 'UNITS', 'NOMINAL', 'LOWER_TOLERANCE', 'UPPER_TOLERANCE'];
        const plan = planIdx >= 0 ? Object.fromEntries(PLAN_COLS.filter((c) => qiGrid.byId[c] && qipRows[planIdx][c] !== undefined).map((c) => [c, qipRows[planIdx][c]])) : {};
        await plm.request('PUT', `${link}/views/13/rows/${row.rowId}`, { body: await rowPayload(ctx, ctx.ws.qi, { ...plan, ...vals }, { force: true }) });
    }
    step(ctx, 'qi', `record ${Object.keys(results).length} measurement results`);
}

/* ---------- change tasks ---------- */

async function templateTasks(ctx, templateLink) {
    const rows = await getRows(templateLink);
    const out = { cr: [], co: [] };
    for (const r of rows) {
        const p = norm(r.cells.PROCESS);
        if (p === 'change request') out.cr.push(r.cells.TITLE);
        else if (p === 'change order') out.co.push(r.cells.TITLE);
    }
    return out;
}

async function findTasks(ctx, parentNumber) {
    const items = await plm.listAll(`/api/v3/workspaces/${ctx.ws.task}/items`);
    // Task descriptors look like "CR-000167 - 10 - Title" or, in some tenants, "CT-CR-000167 - 10 - Title"
    const re = new RegExp(`^(?:[A-Za-z]+-)?${parentNumber.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} - `);
    return items.filter((i) => re.test(String(i.descriptor || '')))
        .map((i) => ({ link: i.__self__ || i.link, title: String(i.descriptor).replace(re, '').replace(/^\S+\s+-\s+/, '') }));
}

// Replaces the task list in the "Task Planning" grid of a Change Request / Change Order (which the template filled)
// by a task list written for the story. The change tasks are spawned from this grid on "Initiate Tasks".
async function applyTaskPlan(ctx, proc, link) {
    const plan = ctx.story[proc].taskPlan;
    if (!plan?.length) return;
    const ids = plan.map((r) => String(r.ID));
    plan.forEach((r) => {
        if (!r.ID || !r.TITLE) fail(ctx, `${LABEL[proc]}.taskPlan: every task needs ID and TITLE`);
        if (r.DEPENDS_ON && (!ids.includes(String(r.DEPENDS_ON)) || String(r.DEPENDS_ON) === String(r.ID))) fail(ctx, `${LABEL[proc]}.taskPlan: task ${r.ID} depends on "${r.DEPENDS_ON}", which is not another task of the plan`);
    });
    if (new Set(ids).size !== ids.length) fail(ctx, `${LABEL[proc]}.taskPlan: task IDs must be unique`);
    const payloads = [];
    for (const row of plan) {
        try { payloads.push(await rowPayload(ctx, ctx.ws[proc], row)); } catch (e) { fail(ctx, `${LABEL[proc]}.taskPlan ${row.ID}: ${e.message}`); }
    }
    ctx.plan[proc] = plan;
    if (ctx.dryRun) { step(ctx, proc, `replace the template tasks by ${plan.length} story tasks in the Task Planning grid`, 'dry-run'); return; }
    const key = `${proc}:taskplan`;
    if (ctx.state.done[key]) { step(ctx, proc, 'task plan already applied', 'skipped'); return; }
    const rows = await poll(async () => { const r = await getRows(link); return r.length ? r : null; }, { timeoutMs: ctx.opts.transitionWaitMs, intervalMs: ctx.opts.pollMs, label: 'the task grid' }).catch(() => []);
    if (rows.some((r) => r.cells.TASK)) throw new Error(`${LABEL[proc]}: change tasks were already created, the task plan can no longer be replaced`);
    for (const r of rows) await plm.request('DELETE', `${link}/views/13/rows/${r.rowId}`);
    for (const body of payloads) await plm.request('POST', `${link}/views/13/rows`, { body });
    ctx.state.done[key] = true;
    saveState(ctx);
    step(ctx, proc, `replaced ${rows.length} template task(s) by ${plan.length} story tasks`);
}

async function runTasks(ctx, proc, parentLink) {
    const cfg = ctx.story[proc].tasks || [];
    if (!cfg.length) return;
    const templateLink = ctx.vars.template;
    const planned = ctx.plan[proc] ? ctx.plan[proc].map((r) => r.TITLE) : null;
    const expected = planned || (templateLink ? (await templateTasks(ctx, templateLink))[proc] : []);

    if (ctx.dryRun) {
        for (const t of cfg) {
            if (!expected.some((title) => norm(title).includes(norm(t.match)))) {
                fail(ctx, `${LABEL[proc]} task "${t.match}" matches no task of the ${planned ? 'task plan' : 'change template'} (tasks: ${expected.join(' | ') || 'none'})`);
            }
            ctx.imgPrefix = `${proc}-task-${slug(t.match)}`;
            await prepareFields(ctx, 'task', t.fields || {});
            ctx.imgPrefix = null;
            const wf = await loadWorkflow(ctx, ctx.ws.task);
            for (const tr of t.transitions || []) if (!wf.some((x) => same(x.name, tr.name))) fail(ctx, `Change task "${t.match}": unknown transition "${tr.name}"`);
        }
        const completing = cfg.filter((t) => (t.transitions || []).some((x) => /complete task|approve & finish/i.test(x.name))).length;
        const wantsCompleted = proc === 'co' ? 1 : null;
        if (wantsCompleted !== null && completing !== wantsCompleted) warn(ctx, `${LABEL[proc]}: ${completing} task(s) get completed; the demo story expects exactly 1 completed and the rest pending`);
        if (proc === 'co' && expected.length < 2) warn(ctx, `The ${planned ? 'task plan' : 'change template'} has only ${expected.length} Change Order task(s); the story needs several`);
        if (proc === 'cr' && expected.length < 1) warn(ctx, 'The change template has no Change Request task, so the root cause analysis task cannot exist');
        step(ctx, proc, `drive ${cfg.length} change task(s) (${planned ? 'plan' : 'template'} provides ${expected.length})`, 'dry-run');
        return;
    }

    const parent = await getItem(parentLink);
    const number = textOf(fieldValue(parent, 'NUMBER'));
    const tasks = await poll(async () => {
        const list = await findTasks(ctx, number);
        return list.length && list.length >= (expected.length || 1) ? list : null;
    }, { timeoutMs: ctx.opts.taskTimeoutMs, intervalMs: ctx.opts.pollMs, label: `change tasks of ${number} to be created` });
    step(ctx, proc, `found ${tasks.length} change task(s) of ${number}`);
    ctx.report.tasks = ctx.report.tasks || [];
    for (const t of cfg) {
        const hit = tasks.find((x) => norm(x.title).includes(norm(t.match)));
        if (!hit) throw new Error(`No change task matching "${t.match}" on ${number} (tasks: ${tasks.map((x) => x.title).join(' | ')})`);
        ctx.imgPrefix = `${proc}-task-${slug(t.match)}`;
        const who = t.as ?? t.fields?.ASSIGNEE;
        try {
            if (t.fields) {
                // The assignment itself is done by the coordinator (login user); everything else by the assignee.
                const { ASSIGNEE, ...rest } = t.fields;
                if (ctx.impersonate && who && ASSIGNEE !== undefined) {
                    await applyFields(ctx, 'task', hit.link, { ASSIGNEE });
                    if (Object.keys(rest).length) await asActor(ctx, who, () => applyFields(ctx, 'task', hit.link, rest));
                } else await applyFields(ctx, 'task', hit.link, t.fields);
            }
        } finally { ctx.imgPrefix = null; }
        for (const [i, tr] of (t.transitions || []).entries()) {
            const key = `task:${hit.link}:${i}`;
            if (ctx.state.done[key]) { step(ctx, 'task', `"${tr.name}" on ${t.match} already done`, 'skipped'); continue; }
            await asActor(ctx, tr.as ?? who, () => performTransition(ctx, 'task', hit.link, tr.name, tr.comment, { waitMs: ctx.opts.taskTimeoutMs }));
            ctx.state.done[key] = true;
            saveState(ctx);
        }
    }
    for (const x of tasks) {
        const d = await getItem(x.link);
        ctx.report.tasks.push({ parent: number, title: x.title, state: stateOf(d), link: x.link });
    }
}

/* ---------- processes ---------- */

const getItem = (link) => plm.get(link);

async function awaitSpawn(ctx, proc) {
    const { from, field } = SPAWN[proc];
    const parent = ctx.state.created[from];
    const link = await poll(async () => linkOf(fieldValue(await getItem(parent), field)),
        { timeoutMs: ctx.opts.spawnTimeoutMs, intervalMs: ctx.opts.pollMs, label: `the ${LABEL[proc]} spawned by the ${LABEL[from]} (field ${field})` })
        .catch((e) => {
            if (!/^Timed out/.test(e.message)) throw e;
            throw new Error(`${e.message}. The workflow script that creates it did not fire: check that the last ${LABEL[from]} transition ran and that its trigger fields are set (for example Initiate CAPA = Yes, Create Change Request = Yes).`);
        });
    ctx.state.created[proc] = link;
    saveState(ctx);
    step(ctx, proc, `${LABEL[proc]} spawned by ${LABEL[from]}`, 'ok', link);
    return link;
}

async function runProcess(ctx, proc) {
    const cfg = ctx.story[proc];
    if (!cfg) throw new Error(`The story has no "${proc}" section`);
    let link = ctx.state.created[proc] || null;

    if (!link) {
        if (cfg.create) link = await asActor(ctx, cfg.as, () => createItem(ctx, proc, cfg.create));
        else if (SPAWN[proc]) link = ctx.dryRun ? null : await awaitSpawn(ctx, proc);
        else throw new Error(`The story has no "${proc}.create" and ${LABEL[proc]} cannot be spawned`);
        if (ctx.dryRun && SPAWN[proc]) step(ctx, proc, `${LABEL[proc]} is spawned by the ${LABEL[SPAWN[proc].from]} workflow (field ${SPAWN[proc].field})`, 'dry-run');
    }
    if (proc === 'qip' && !ctx.state.done['qip:grid'])    { await asActor(ctx, cfg.as, () => fillQipGrid(ctx, link));   ctx.state.done['qip:grid'] = !ctx.dryRun; saveState(ctx); }
    if (proc === 'qi'  && !ctx.state.done['qi:results'])  { await asActor(ctx, cfg.as, () => fillQiResults(ctx, link)); ctx.state.done['qi:results'] = !ctx.dryRun; saveState(ctx); }

    (cfg.stages || []).forEach((s) => { if (!s.transition && !s.fields && !s.await && !s.runTasks && !s.taskPlan) throw new Error(`${proc}: a stage needs fields, transition, runTasks, taskPlan or await`); });
    for (let i = 0; i < (cfg.stages || []).length; i++) {
        const stage = cfg.stages[i];
        const key = `${proc}#${i}`;
        if (!ctx.dryRun && ctx.state.done[key]) { step(ctx, proc, `stage ${i + 1} already done`, 'skipped'); continue; }
        const who = stage.as ?? cfg.as;
        if (stage.fields)     await asActor(ctx, who, () => applyFields(ctx, proc, link, stage.fields));
        if (stage.taskPlan)   await asActor(ctx, who, () => applyTaskPlan(ctx, proc, link));
        if (ctx.stopBefore && stage.id === ctx.stopBefore) throw new StopSignal(proc, stage, link);
        if (stage.transition && !(!ctx.dryRun && ctx.state.done[`${key}:transition`])) {
            await asActor(ctx, who, () => performTransition(ctx, proc, link, stage.transition, stage.comment));
            if (!ctx.dryRun) { ctx.state.done[`${key}:transition`] = true; saveState(ctx); }   // a later failure (tasks, await) must not repeat it
        }
        if (stage.runTasks)   await runTasks(ctx, proc, link);
        if (stage.await)      await awaitState(ctx, proc, link, stage.await);
        ctx.state.done[key] = true;
        saveState(ctx);
    }
}

/* ---------- story checks, coverage, report ---------- */

function checkStoryShape(story, stopBefore) {
    const errors = [];
    if (!story || typeof story !== 'object') return ['story must be an object'];
    if (!story.name) errors.push('story.name is required (used for the state file)');
    if (!story.vars?.component) errors.push('story.vars.component (link of the component) is required');
    if (!story.vars?.template) errors.push('story.vars.template (link of the change approval template) is required');
    for (const p of PROCESSES) if (!story[p]) errors.push(`story.${p} is missing`);
    if (story.qip && !story.qip.create) errors.push('story.qip.create is required');
    if (story.qi && !story.qi.create) errors.push('story.qi.create is required');
    if (stopBefore) {
        const ids = PROCESSES.flatMap((p) => (story[p]?.stages || []).map((s) => s.id).filter(Boolean));
        if (!ids.includes(stopBefore)) errors.push(`stopBefore "${stopBefore}" is not a stage id of the story (ids: ${ids.join(', ')})`);
    }
    return errors;
}

async function computeCoverage(ctx) {
    for (const proc of [...PROCESSES, 'task']) {
        const defs = await describe(ctx, ctx.ws[proc]);
        const writable = defs.list.filter((f) => f.editable && f.section && !/^MATRIX_/.test(f.id)).map((f) => f.id);
        const filled = ctx.filled[proc] || new Set();
        ctx.report.coverage[proc] = { filled: writable.filter((id) => filled.has(id)).length, total: writable.length, unfilled: writable.filter((id) => !filled.has(id)) };
    }
}

function viewUrl(wsId, link) {
    const { tenant } = config.load();
    const id = plm.idOf(link);
    return `https://${tenant}.autodeskplm360.net/plm/workspaces/${wsId}/items/itemDetails?view=full&tab=details&mode=view&itemId=urn%60adsk%2Cplm%60tenant%2Cworkspace%2Citem%60${String(tenant).toUpperCase()}%2C${wsId}%2C${id}`;
}
async function summarize(ctx) {
    for (const proc of PROCESSES) {
        const link = ctx.state.created[proc];
        if (!link) continue;
        const d = await getItem(link);
        ctx.report.items.push({
            process: LABEL[proc], number: textOf(fieldValue(d, 'NUMBER')), title: textOf(fieldValue(d, 'TITLE')) || String(d.title || ''),
            state: stateOf(d), link, url: viewUrl(ctx.ws[proc], link)
        });
    }
}

/* ---------- public API ---------- */

async function run(story, opts = {}) {
    const shapeErrors = checkStoryShape(story, opts.stopBefore);
    if (shapeErrors.length) return { dryRun: true, errors: shapeErrors, warnings: [], steps: [], items: [], coverage: {} };
    const ctx = await makeContext(story, opts);
    try {
        const comp = await getItem(ctx.vars.component).catch(() => null);
        if (!comp) { fail(ctx, `Component ${ctx.vars.component} was not found`); if (!ctx.dryRun) return ctx.report; }
        ctx.vars.me = (await getMe(ctx)).link;
        if (ctx.vars.template) await getItem(ctx.vars.template).catch(() => fail(ctx, `Change template ${ctx.vars.template} was not found`));
        if (ctx.impersonate && !(await verifyImpersonation(ctx))) { ctx.report.ok = false; return ctx.report; }
        for (const proc of PROCESSES) await runProcess(ctx, proc);
        if (ctx.dryRun) await computeCoverage(ctx);
        else await summarize(ctx);
    } catch (e) {
        if (e instanceof StopSignal) {
            let number = '';
            if (!ctx.dryRun && e.link) number = textOf(fieldValue(await getItem(e.link), 'NUMBER'));
            ctx.report.stopped = true;
            ctx.report.next = { stage: e.stage.id, process: LABEL[e.proc], record: number || undefined, transition: e.stage.transition, comment: e.stage.comment };
            ctx.report.hint = `Stopped on purpose before "${e.stage.id}": the record is prepared and waiting. Perform "${e.stage.transition || 'the next step'}" in the UI to show it live, or run the same story again without stopBefore to continue.`;
            if (ctx.dryRun) await computeCoverage(ctx); else await summarize(ctx);
            ctx.report.ok = ctx.report.errors.length === 0;
            return ctx.report;
        }
        ctx.report.errors.push(e.message);
        ctx.report.stoppedWith = e.message;
        if (!ctx.dryRun) {
            ctx.report.hint = `Nothing is rolled back. Fix the cause and run again: finished stages are skipped (state in ${path.relative(path.join(__dirname, '..'), ctx.stateFile)}).`;
            try { await summarize(ctx); } catch { /* best effort */ }
        }
    }
    ctx.report.ok = ctx.report.errors.length === 0;
    return ctx.report;
}

/* ---------- context for the skill ---------- */

async function findComponent(ref) {
    const ws = (await resolveWorkspaces()).component;
    const q = String(ref).trim();
    const found = new Map();
    const add = (it) => { const l = it.__self__ || it.link; if (l && wsOfLink(l) === ws) found.set(l, { link: l, descriptor: it.descriptor || it.title }); };
    if (/^\d+$/.test(q)) { try { const d = await plm.get(`/api/v3/workspaces/${ws}/items/${q}`); add({ __self__: d.__self__, descriptor: d.title }); } catch { /* not a dmsId */ } }
    try {
        const r = await plm.get(`/api/v3/search-results?query=${encodeURIComponent(q)}&limit=50`);
        for (const it of r.items || []) if (norm(it.descriptor).startsWith(norm(q) + ' - ') || norm(it.descriptor) === norm(q)) add(it);
    } catch { /* search is best effort */ }
    return [...found.values()];
}

async function context(ref) {
    const candidates = await findComponent(ref);
    if (candidates.length !== 1) return { ok: false, candidates, message: candidates.length ? 'More than one item matches: pick one' : `No item found for "${ref}"` };
    const ws = await resolveWorkspaces();
    const d  = await getItem(candidates[0].link);
    const comp = {
        link: candidates[0].link, dmsId: plm.idOf(candidates[0].link), descriptor: candidates[0].descriptor,
        number: textOf(fieldValue(d, 'NUMBER')), title: textOf(fieldValue(d, 'TITLE')), description: textOf(fieldValue(d, 'DESCRIPTION')),
        type: textOf(fieldValue(d, 'TYPE')), hasImage: Boolean(linkOf(fieldValue(d, 'IMAGE'))), state: stateOf(d)
    };
    const list = async (w) => (await plm.listAll(`/api/v3/workspaces/${w}/items`)).map((i) => ({ link: i.__self__ || i.link, title: i.descriptor || i.title }));
    const templates = [];
    for (const t of await list(ws.template)) templates.push({ ...t, tasks: await templateTasks({}, t.link).catch(() => ({ cr: [], co: [] })) });
    const ctx = { dryRun: true, users: null, me: null };
    return {
        ok: true, component: comp, workspaces: ws, me: await getMe(ctx), users: await getUsers(ctx),
        products: await list(ws.product), suppliers: await list(ws.supplier), templates
    };
}

// Generic building blocks (field conversion, picklists, users, grids, workflow lookups) reused by other demo-data utilities.
// They only rely on a context object with the same shape as the one makeContext() builds (ws, defs, grids, lookups, wf, vars, state, report, dryRun).
const toolkit = { describe, describeGrid, toApiValue, buildSections, getMe, getUsers, lookupOptions, pickByTitle, poll, getRows, rowPayload,
    loadWorkflow, availableTransitions, resolveActor, asActor, fieldValue, linkOf, textOf, stateOf, itemPath, same, norm, slug, sleep, warn, DEFAULTS };
module.exports = { run, context, findComponent, checkStoryShape, StopSignal, dateValue, richText, PROCESSES, toolkit };
