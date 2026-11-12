// Requirements demo data utility.
//
// Builds, for one product, a complete requirements story in Fusion Manage (template "Requirements Management"):
//   Requirement Specification (spawns the Top Level Requirement) -> Requirements in a 2 to 4 level BOM structure
//   -> optional "Implemented By" relationships to items of the product's engineering BOM
//   -> optional Requirement Validations (steps grid, results, repetitions of failed validations)
//   -> optional Requirement Approvals (each releases one level 1 node with everything below it)
//   -> the top level requirement is written into the Products record (field REQUIREMENTS), always.
//
// Order matters: requirements are revision controlled, a release creates a new working version. Everything that edits the
// requirements (fields, structure, relationships) and everything that links them (validation steps) therefore happens
// BEFORE the approvals release them.
//
// All content comes from a "story" JSON written by the skill; this module only executes it. Safe by default:
// dryRun validates fields, picklists, links, workflow transitions and EBOM items, and writes nothing.
const fs   = require('fs');
const path = require('path');
const plm  = require('./plm');
const ppm  = require('./ppm');
const config = require('./config');
const images = require('./storyimages');
const { toolkit: tk, dateValue } = require('./closedloop');

const WORK_DIR = ppm.WORK_DIR;
const WS_TITLES = {
    spec    : /^requirement specifications?$/i,
    req     : /^requirements?$/i,
    val     : /^requirement validations?$/i,
    appr    : /^requirement approvals?$/i,
    item    : /^items(\s+and\s+boms)?$/i,
    product : /^products?$/i
};
const LABEL = { spec: 'Requirement Specification', req: 'Requirement', val: 'Requirement Validation', appr: 'Requirement Approval', product: 'Product' };
const PLACEHOLDER = '/api/v3/dry-run/placeholder';
const MAX_LEVELS = 4;
const REF_FIELDS = ['DEPENDENT_REQUIREMENTS', 'CONFLICTING_REQUIREMENTS'];     // written after all requirements exist
const SCRIPT_FIELDS = new Set(['ID', 'ICON']);                                 // owned by scripts, never counted as unfilled
const DEFAULTS = { pollMs: 1500, specTimeoutMs: 45000, idTimeoutMs: 6000, spawnTimeoutMs: 60000, transitionWaitMs: 20000 };
const VALIDATION_PATH = [                                       // Planning -> ... -> Completed
    { state: 'Planning',    next: 'Assign',             to: 'Preparation' },
    { state: 'Preparation', next: 'Finish Preparation', to: 'Execution' },
    { state: 'Execution',   next: 'Finish Execution',   to: 'Reporting' },
    { state: 'Reporting',   next: 'Close',              to: 'Completed' }
];
const VALIDATION_STATES = ['Planning', 'Preparation', 'Execution', 'Reporting', 'Acknowledgement', 'Completed'];
const APPROVAL_STATES = ['Definition', 'Internal Review', 'External Review', 'Released'];

/* ---------- helpers ---------- */

const { same, norm, slug, sleep, poll, linkOf, textOf, stateOf, fieldValue, itemPath } = tk;
const getItem = (link) => plm.get(link);
// Run fn as another user (impersonation) when the story enables it and `who` is not the login user.
const as = (ctx, who, fn) => (ctx.impersonate && who ? tk.asActor(ctx, who, fn) : fn());
// Some transitions are restricted to the assignee of the stage: Preparation = ASSIGNEE_1, Execution = ASSIGNEE_2, Reporting = ASSIGNEE_3.
const STAGE_ASSIGNEE = { Planning: null, Preparation: 'ASSIGNEE_1', Execution: 'ASSIGNEE_2', Reporting: 'ASSIGNEE_3', Acknowledgement: 'ASSIGNEE_3' };
const idOfUrn = (urn) => String(urn || '').split('.').pop();
const stripRev = (s) => String(s || '').replace(/\s*\[REV:[^\]]*\]\s*$/, '').trim();
const imageSpecOf = (raw) => (raw && typeof raw === 'object' ? (raw.generate || (raw.type ? raw : null)) : null);
const explain = (e) => {
    const d = Array.isArray(e.details) ? e.details.map((x) => `${x.field?.__self__ ? plm.idOf(x.field.__self__) + ': ' : ''}${x.message || x.code || ''}`).filter(Boolean).join('; ') : '';
    return `${e.message}${d ? ` (${d})` : ''}`;
};

function walk(nodes, fn, depth = 1, parent = null) {
    (nodes || []).forEach((n, i) => { fn(n, depth, parent, i); walk(n.children, fn, depth + 1, n); });
}
function flatten(story) { const out = []; walk(story.requirements, (n, depth, parent, index) => out.push({ node: n, depth, parent, index })); return out; }
function subtree(node) { const out = []; walk([node], (n) => out.push(n)); return out; }
const titleOf = (n) => n.title || n.fields?.TITLE || '';

/* ---------- context ---------- */

async function resolveWorkspaces(overrides = {}) {
    const all = await plm.listAll('/api/v3/workspaces');
    const out = {};
    for (const [key, re] of Object.entries(WS_TITLES)) {
        if (overrides[key]) { out[key] = String(overrides[key]); continue; }
        const hit = all.find((w) => re.test(w.title || w.name || ''));
        if (!hit) throw new Error(`Workspace "${key}" was not found in this tenant (is the Requirements Management template installed?)`);
        out[key] = String(plm.idOf(hit.link));
    }
    return out;
}

async function makeContext(story, opts = {}) {
    const dryRun = opts.dryRun !== false;
    const ctx = {
        story, dryRun, opts: { ...DEFAULTS, ...(opts.timing || {}) },
        ws: await resolveWorkspaces(story.workspaces), defs: {}, grids: {}, lookups: {}, wf: {}, users: null, me: null,
        vars: { ...(story.vars || {}) }, filled: {}, sim: {}, ebom: null, derived: {},
        impersonate: opts.impersonate ?? story.impersonation === true, actors: new Set(), userMail: {},
        state: { created: {}, done: {} }, stateFile: path.join(WORK_DIR, `requirements-${slug(story.name)}-state.json`),
        report: { dryRun, name: story.name, steps: [], warnings: [], errors: [], items: [], images: [], coverage: {} }
    };
    if (!dryRun && opts.reset && fs.existsSync(ctx.stateFile)) fs.unlinkSync(ctx.stateFile);
    if (!dryRun && fs.existsSync(ctx.stateFile)) {
        try { ctx.state = JSON.parse(fs.readFileSync(ctx.stateFile, 'utf8')); ctx.report.resumed = true; } catch { /* start fresh */ }
        // Re-register the requirement keys so that $key references resolve again
        for (const [k, link] of Object.entries(ctx.state.created)) if (k.startsWith('req:')) ctx.vars[k.slice(4)] = link;
        if (ctx.state.created.spec) ctx.vars.spec = ctx.state.created.spec;
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
function fail(ctx, msg) {
    if (ctx.dryRun) { ctx.report.errors.push(msg); return; }
    throw new Error(msg);
}
// Run one unit of work once: skipped when a previous run already finished it (real runs only).
async function once(ctx, key, fn) {
    if (!ctx.dryRun && ctx.state.done[key]) return false;
    await fn();
    if (!ctx.dryRun) { ctx.state.done[key] = true; saveState(ctx); }
    return true;
}
const created = (ctx, key) => ctx.state.created[key];
const remember = (ctx, key, link) => { ctx.state.created[key] = link; ctx.vars[key.replace(/^req:/, '')] = link; saveState(ctx); };

/* ---------- writing fields ---------- */

async function generateImage(ctx, spec, tag) {
    const buf = images.render({ footer: 'ILLUSTRATIVE DEMO IMAGE - GENERATED FOR THE REQUIREMENTS STORY', ...spec }, {});
    const dir = path.join(WORK_DIR, `requirements-${slug(ctx.story.name)}-images`);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${tag}.png`);
    fs.writeFileSync(file, buf);
    ctx.report.images = ctx.report.images.filter((x) => x.tag !== tag);
    ctx.report.images.push({ tag, type: spec.type, title: spec.title, file: path.relative(path.join(__dirname, '..'), file) });
    return { buf, type: 'image/png', name: `${tag}.png` };
}
async function loadImageRef(ctx, ref, tag) {
    const spec = imageSpecOf(ref);
    return spec ? generateImage(ctx, spec, tag) : ppm.loadImage(ref);
}

// Sort the story fields into: normal (written with the create/PATCH), images, and read-only ones that are skipped.
async function prepareFields(ctx, proc, fields, tag) {
    const defs = await tk.describe(ctx, ctx.ws[proc]);
    const out = { normal: [], images: [] };
    for (const [id, raw] of Object.entries(fields || {})) {
        if (id.startsWith('_') || raw === undefined) continue;
        const def = defs.byId[id];
        if (!def) { fail(ctx, `${LABEL[proc]} ${tag}: field ${id} does not exist`); continue; }
        if (!def.section) { fail(ctx, `${LABEL[proc]} ${tag}: field ${id} is not part of any section and cannot be written`); continue; }
        if (!def.editable) { warn(ctx, `${LABEL[proc]} ${tag}: ${id} is read-only (set by a script) and was skipped`); continue; }
        (ctx.filled[proc] ||= {})[id] = (ctx.filled[proc][id] || 0) + 1;
        if (/image/i.test(def.type)) {
            if (raw && ctx.dryRun && imageSpecOf(raw)) {
                try { await generateImage(ctx, imageSpecOf(raw), `${slug(tag)}-${id}`); } catch (e) { fail(ctx, `${LABEL[proc]} ${tag}.${id}: image - ${e.message}`); }
            }
            if (raw) out.images.push([id, raw]);
            continue;
        }
        try { out.normal.push([id, await tk.toApiValue(ctx, def, raw)]); } catch (e) { fail(ctx, `${LABEL[proc]} ${tag}.${id}: ${e.message}`); }
    }
    return out;
}

async function patchFields(ctx, proc, link, entries, tag) {
    if (!entries.length) return;
    const defs = await tk.describe(ctx, ctx.ws[proc]);
    try { await plm.request('PATCH', link, { body: { sections: tk.buildSections(ctx.ws[proc], defs, entries, link) } }); }
    catch (e) {
        if (e.status !== 400 || entries.length < 2) throw new Error(`${LABEL[proc]} ${tag}: ${explain(e)}`);
        const bad = [];     // find the rejected field(s); the valid ones stay written
        for (const entry of entries) {
            try { await plm.request('PATCH', link, { body: { sections: tk.buildSections(ctx.ws[proc], defs, [entry], link) } }); }
            catch (e2) { bad.push(`${entry[0]} (${explain(e2).replace(/^.*-> \d+\s*/, '').slice(0, 120)})`); }
        }
        if (bad.length) throw new Error(`${LABEL[proc]} ${tag}: the tenant rejected field(s) ${bad.join('; ')}`);
    }
}
async function uploadImages(ctx, proc, link, list, tag) {
    for (const [id, ref] of list) {
        try { await ppm.uploadImage(link, id, await loadImageRef(ctx, ref, `${slug(tag)}-${id}`)); }
        catch (e) { warn(ctx, `${LABEL[proc]} ${tag}.${id}: image skipped - ${e.message}`); }
    }
}

async function createItem(ctx, proc, fields, tag) {
    const wsId = ctx.ws[proc];
    const defs = await tk.describe(ctx, wsId);
    const prepared = await prepareFields(ctx, proc, fields, tag);
    if (ctx.dryRun) { step(ctx, proc, `create ${LABEL[proc]} "${tag}" (${prepared.normal.length + prepared.images.length} fields)`, 'dry-run'); return PLACEHOLDER; }
    // Fields derived from the related specification (for example SPECIFICATION_ID) are validated on create: the tenant reports the
    // expected value, which is learned from the first rejection and sent with every following create of that kind.
    const learned = (ctx.derived ||= {})[proc] ||= {};
    const post = (extra) => plm.request('POST', `/api/v3/workspaces/${wsId}/items`, { body: { sections: tk.buildSections(wsId, defs, [...prepared.normal, ...extra], null) } });
    const have = new Set(prepared.normal.map(([id]) => id));
    const extraOf = () => Object.entries(learned).filter(([id]) => !have.has(id) && defs.byId[id]);
    let res;
    try { res = await post(extraOf()); }
    catch (e) {
        const derived = (Array.isArray(e.details) ? e.details : []).filter((d) => /derived/i.test(d.code || '') && d.field && d.arguments?.length);
        if (e.status !== 400 || !derived.length) throw new Error(`${LABEL[proc]} ${tag}: ${explain(e)}`);
        for (const d of derived) {
            const id = plm.idOf(d.field.__self__);
            const t = (defs.byId[id]?.type || '').toLowerCase();
            learned[id] = /integer/.test(t) ? parseInt(d.arguments[0], 10) : d.arguments[0];
        }
        try { res = await post(extraOf()); } catch (e2) { throw new Error(`${LABEL[proc]} ${tag}: ${explain(e2)}`); }
    }
    const link = itemPath(res.headers.get('location'));
    if (!link) throw new Error(`${LABEL[proc]} ${tag} was created but no location was returned`);
    await uploadImages(ctx, proc, link, prepared.images, tag);
    step(ctx, proc, `create ${LABEL[proc]} "${tag}"`, 'ok', link);
    return link;
}
async function updateItem(ctx, proc, link, fields, tag) {
    const prepared = await prepareFields(ctx, proc, fields, tag);
    if (ctx.dryRun) { step(ctx, proc, `set ${prepared.normal.length + prepared.images.length} fields of "${tag}"`, 'dry-run'); return; }
    await patchFields(ctx, proc, link, prepared.normal, tag);
    await uploadImages(ctx, proc, link, prepared.images, tag);
    step(ctx, proc, `set ${prepared.normal.length + prepared.images.length} fields of "${tag}"`);
}

/* ---------- workflow ---------- */

async function simState(ctx, proc, key) {
    const k = `${proc}:${key}`;
    if (!ctx.sim[k]) { const wf = await tk.loadWorkflow(ctx, ctx.ws[proc]); ctx.sim[k] = { state: wf.find((t) => !t.from)?.to || null }; }
    return ctx.sim[k];
}
async function transition(ctx, proc, key, link, name, comment) {
    if (ctx.dryRun) {
        const sim = await simState(ctx, proc, key);
        const wf  = await tk.loadWorkflow(ctx, ctx.ws[proc]);
        const t = wf.find((x) => (same(x.name, name) || same(x.label, name)) && x.from && same(x.from, sim.state));
        if (!t) {
            const avail = wf.filter((x) => x.from && same(x.from, sim.state)).map((x) => x.name);
            fail(ctx, `${LABEL[proc]} "${key}": transition "${name}" is not possible from state "${sim.state}" (possible: ${avail.join(', ') || 'none'})`);
            return null;
        }
        sim.state = t.to;
        step(ctx, proc, `"${key}": transition "${name}" -> ${t.to}`, 'dry-run');
        return t.to;
    }
    let list = [];
    const t = await poll(async () => { list = await tk.availableTransitions(link); return list.find((x) => same(x.name, name) || same(x.label, name)) || null; },
        { timeoutMs: ctx.opts.transitionWaitMs, intervalMs: ctx.opts.pollMs, label: `transition "${name}"` })
        .catch((e) => {
            if (!/^Timed out/.test(e.message)) throw e;
            throw new Error(`${LABEL[proc]} "${key}": transition "${name}" is not available (available: ${list.map((x) => x.name).join(', ') || 'none'})`);
        });
    try { await plm.request('POST', `${link}/workflows/1/transitions`, { body: { comment: comment || '' }, headers: { 'Content-Location': t.link } }); }
    catch (e) { throw new Error(`${LABEL[proc]} "${key}": transition "${name}" failed: ${explain(e)}`); }
    if (t.to) {
        try { await poll(async () => same(stateOf(await getItem(link)), t.to), { timeoutMs: ctx.opts.transitionWaitMs, intervalMs: ctx.opts.pollMs, label: `state ${t.to}` }); }
        catch { warn(ctx, `${LABEL[proc]} "${key}": after "${name}" the state did not become "${t.to}" (a script may have moved it on)`); }
    }
    step(ctx, proc, `"${key}": transition "${name}"`, 'ok', t.to ? `-> ${t.to}` : undefined);
    return t.to;
}

/* ---------- specification ---------- */

async function buildSpec(ctx) {
    const spec = ctx.story.spec || {};
    const title = spec.fields?.TITLE || spec.title;
    await once(ctx, 'spec:create', async () => {
        const link = await createItem(ctx, 'spec', { ...spec.fields, TITLE: title }, 'specification');
        if (!ctx.dryRun) remember(ctx, 'spec', link); else { ctx.state.created.spec = link; }
        if (ctx.dryRun) return;
        // The creation script generates the ID and the Top Level Requirement
        const detail = await poll(async () => { const d = await getItem(link); return linkOf(fieldValue(d, 'TOP_LEVEL_REQUIREMENT')) ? d : null; },
            { timeoutMs: ctx.opts.specTimeoutMs, intervalMs: ctx.opts.pollMs, label: 'the Top Level Requirement of the specification' });
        ctx.state.created.top = linkOf(fieldValue(detail, 'TOP_LEVEL_REQUIREMENT'));
        ctx.state.created.specId = textOf(fieldValue(detail, 'ID'));
        saveState(ctx);
    });
    if (ctx.dryRun) { ctx.state.created.top = PLACEHOLDER; ctx.state.created.specId = '0000'; }
    ctx.vars.spec = ctx.state.created.spec;
    // Top level requirement: describe it
    if (spec.topLevel) await once(ctx, 'spec:top', () => updateItem(ctx, 'req', ctx.state.created.top, spec.topLevel.fields || spec.topLevel, 'top level requirement'));
    // Decisions grid
    const rows = spec.decisions || [];
    if (rows.length) await once(ctx, 'spec:decisions', async () => {
        for (const row of rows) {
            try {
                const body = await tk.rowPayload(ctx, ctx.ws.spec, row);
                if (!ctx.dryRun) await plm.request('POST', `${ctx.state.created.spec}/views/13/rows`, { body });
            } catch (e) { fail(ctx, `${LABEL.spec} decision "${row.DECISION}": ${e.message}`); }
        }
        step(ctx, 'spec', `add ${rows.length} decisions`, ctx.dryRun ? 'dry-run' : 'ok');
    });
}

/* ---------- requirements structure ---------- */

async function ensureId(ctx, link, seq) {
    if (ctx.dryRun) return;
    const idOf = async () => textOf(fieldValue(await getItem(link), 'ID'));
    try { await poll(async () => (await idOf()) || null, { timeoutMs: ctx.opts.idTimeoutMs, intervalMs: ctx.opts.pollMs, label: 'the requirement ID' }); return; }
    catch { /* the script did not number it: do it here */ }
    const id = `${ctx.state.created.specId}.${String(seq).padStart(3, '0')}`;
    await patchFields(ctx, 'req', link, [['ID', id]], id);
    warn(ctx, `Requirement IDs are not generated by a script on creation in this tenant: "${id}" was assigned by the utility`);
}

async function addToBom(ctx, parentLink, childLink, index) {
    if (ctx.dryRun) return;
    try { await plm.request('POST', `${parentLink}/bom-items`, { body: { quantity: 1, isPinned: false, itemNumber: index + 1, item: { link: childLink } } }); }
    catch (e) { throw new Error(`Add requirement to its parent: ${explain(e)}`); }
}

async function buildRequirements(ctx) {
    const items = flatten(ctx.story);
    let seq = 0;
    const parentLinkOf = (it) => (it.parent ? created(ctx, `req:${it.parent.key}`) || PLACEHOLDER : ctx.state.created.top);
    for (const it of items) {
        const { node, depth } = it;
        seq++;
        const key = `req:${node.key}`;
        const fields = { ...node.fields };
        for (const f of REF_FIELDS) delete fields[f];
        if (node.children?.length && !fields.TYPE) fields.TYPE = 'Sub Level';
        await once(ctx, `${key}:create`, async () => {
            const link = await createItem(ctx, 'req', { REQUIREMENT_SPECIFICATION: ctx.state.created.spec, ...fields, TITLE: titleOf(node) }, `${titleOf(node)} (level ${depth})`);
            if (ctx.dryRun) { ctx.vars[node.key] = PLACEHOLDER; return; }
            remember(ctx, key, link);
            await ensureId(ctx, link, seq);
            await addToBom(ctx, parentLinkOf(it), link, it.index);
            step(ctx, 'req', `"${titleOf(node)}" added below ${it.parent ? `"${titleOf(it.parent)}"` : 'the top level requirement'}`);
        });
        if (ctx.dryRun) ctx.vars[node.key] = PLACEHOLDER;
    }
    // Second pass: references between requirements (all of them exist now)
    for (const { node } of items) {
        const refs = Object.fromEntries(REF_FIELDS.concat(REF_FIELDS.map((f) => `${f}_COMMENTS`)).filter((f) => node.fields?.[f] !== undefined).map((f) => [f, node.fields[f]]));
        if (!Object.keys(refs).length) continue;
        for (const f of REF_FIELDS) {      // map keys to links
            if (refs[f] === undefined) continue;
            refs[f] = (Array.isArray(refs[f]) ? refs[f] : [refs[f]]).map((k) => (ctx.vars[k] ? `$${k}` : k));
        }
        await once(ctx, `req:${node.key}:refs`, () => updateItem(ctx, 'req', created(ctx, `req:${node.key}`), refs, `${titleOf(node)} references`));
    }
}

/* ---------- implemented by (EBOM items) ---------- */

async function loadEbom(ctx) {
    if (ctx.ebom) return ctx.ebom;
    ctx.ebom = { items: [], error: null };
    const productLink = ctx.vars.product;
    if (!productLink) { ctx.ebom.error = 'story.vars.product is not set'; return ctx.ebom; }
    const root = linkOf(fieldValue(await getItem(productLink), 'ENGINEERING_BOM'));
    if (!root) { ctx.ebom.error = 'the product has no Engineering BOM'; return ctx.ebom; }
    ctx.ebom.items = (await readBom(root)).map((n) => ({ link: n.link, descriptor: n.descriptor }));
    return ctx.ebom;
}
function matchEbomItem(ebom, ref) {
    const q = norm(ref);
    const exact = ebom.items.filter((i) => norm(i.descriptor) === q || norm(i.descriptor).startsWith(q + ' - ') || plm.idOf(i.link) === String(ref));
    return [...new Map(exact.map((i) => [i.link, i])).values()];
}

async function buildImplementedBy(ctx) {
    const nodes = flatten(ctx.story).filter((x) => x.node.implementedBy?.length);
    if (!nodes.length) return;
    const ebom = await loadEbom(ctx);
    if (ebom.error) { fail(ctx, `Implemented By: ${ebom.error}`); return; }
    for (const { node } of nodes) {
        for (const ref of node.implementedBy) {
            const hits = matchEbomItem(ebom, ref);
            if (hits.length !== 1) { fail(ctx, `Implemented By of "${titleOf(node)}": "${ref}" ${hits.length ? 'is ambiguous' : 'was not found in the engineering BOM'}`); continue; }
            const item = hits[0];
            await once(ctx, `rel:${node.key}:${plm.idOf(item.link)}`, async () => {
                if (ctx.dryRun) { step(ctx, 'req', `"${titleOf(node)}" implemented by ${item.descriptor}`, 'dry-run'); return; }
                const reqLink = created(ctx, `req:${node.key}`);
                try {
                    await plm.request('POST', `${reqLink}/views/10`, {
                        body: { description: node.implementedByNote || 'Implements this requirement', direction: { type: 'Bi-Directional' } },
                        headers: { 'Content-Location': `${reqLink}/views/10/linkable-items/${plm.idOf(item.link)}` }
                    });
                } catch (e) { throw new Error(`Implemented By "${titleOf(node)}" -> ${item.descriptor}: ${explain(e)}`); }
                step(ctx, 'req', `"${titleOf(node)}" implemented by ${item.descriptor}`);
            });
        }
    }
}

/* ---------- validations ---------- */

const resultOf = (s) => (s.RESULT === undefined ? 'Pending' : s.RESULT);
function gridRow(ctx, v, s, { withResult }) {
    const req = flatten(ctx.story).find((x) => x.node.key === s.requirement)?.node;
    const src = req?.fields || {};
    const row = {
        STEP: s.STEP !== undefined ? String(s.STEP) : undefined,
        TEST_PROCEDURE: s.TEST_PROCEDURE ?? src.TEST_PROCEDURE, EXPECTED_RESULT: s.EXPECTED_RESULT ?? src.EXPECTED_RESULT, SUCCESS_CRITERIA: s.SUCCESS_CRITERIA ?? src.SUCCESS_CRITERIA,
        BASE_REQUIREMENT: `$${s.requirement}`,
        RESULT: withResult ? resultOf(s) : 'Pending',
        COMMENTS: withResult ? s.COMMENTS : undefined
    };
    if (s.RELATED_REQUIREMENTS) row.RELATED_REQUIREMENTS = s.RELATED_REQUIREMENTS.map((k) => `$${k}`);
    return Object.fromEntries(Object.entries(row).filter(([, x]) => x !== undefined && x !== ''));
}

async function validationRows(link) { return tk.getRows(link); }

// Set the results of the steps in the Execution state. A row update replaces the whole row, so every column is sent again.
async function applyResults(ctx, v, vkey, link, steps, { baseTitles } = {}) {
    if (ctx.dryRun) {
        for (const s of steps) { try { await tk.rowPayload(ctx, ctx.ws.val, gridRow(ctx, v, s, { withResult: true }), { force: true }); } catch (e) { fail(ctx, `${LABEL.val} "${vkey}" step "${s.requirement}": ${e.message}`); } }
        step(ctx, 'val', `"${vkey}": record ${steps.filter((s) => s.RESULT && s.RESULT !== 'Pending').length} of ${steps.length} step results`, 'dry-run');
        return;
    }
    const rows = await validationRows(link);
    for (const s of steps) {
        const title = baseTitles[s.requirement];
        const row = rows.find((r) => same(stripRev(r.cells.BASE_REQUIREMENT), title) || same(r.cells.BASE_REQUIREMENT, title));
        if (!row) throw new Error(`${LABEL.val} "${vkey}": no step row for requirement "${title}" (rows: ${rows.map((r) => r.cells.BASE_REQUIREMENT).join(', ')})`);
        const body = await tk.rowPayload(ctx, ctx.ws.val, gridRow(ctx, v, s, { withResult: true }), { force: true });
        await plm.request('PUT', `${link}/views/13/rows/${row.rowId}`, { body });
    }
    step(ctx, 'val', `"${vkey}": recorded ${steps.length} step results`);
}

async function baseTitlesOf(ctx) {
    const out = {};
    for (const { node } of flatten(ctx.story)) {
        const link = created(ctx, `req:${node.key}`);
        out[node.key] = ctx.dryRun || !link ? titleOf(node) : stripRev(String((await getItem(link)).title || titleOf(node)));
    }
    return out;
}

// Drive one validation process through its path up to `end` (Planning, Preparation, Execution, Reporting, Acknowledgement or Completed).
async function driveValidation(ctx, v, vkey, link, { end, steps, closing, executionFields, comments, titles, assignees = {} }) {
    const endIdx = VALIDATION_STATES.indexOf(end);
    const at = (s) => VALIDATION_STATES.indexOf(s) <= endIdx;
    const c = comments || {};
    const by = (state) => assignees[STAGE_ASSIGNEE[state]];
    for (const p of VALIDATION_PATH) {
        if (!at(p.state)) break;
        if (p.state === 'Execution') {
            await once(ctx, `val:${vkey}:results`, () => as(ctx, by('Execution'), () => applyResults(ctx, v, vkey, link, steps, { baseTitles: titles })));
            if (executionFields) await once(ctx, `val:${vkey}:exec-fields`, () => as(ctx, by('Execution'), () => updateItem(ctx, 'val', link, executionFields, `${vkey} execution`)));
        }
        if (p.state === 'Reporting') {
            if (closing) await once(ctx, `val:${vkey}:closing`, () => as(ctx, by('Reporting'), () => updateItem(ctx, 'val', link, closing, `${vkey} closing`)));
            const ack = end === 'Acknowledgement' || (end === 'Completed' && v.acknowledge);
            if (ack) {
                await once(ctx, `val:${vkey}:submit-ack`, () => as(ctx, by('Reporting'), () => transition(ctx, 'val', vkey, link, 'Submit for acknowledgement', c.submitAcknowledgement || 'Results ready for acknowledgement')));
                if (end === 'Completed') {
                    await once(ctx, `val:${vkey}:ack`, () => as(ctx, by('Acknowledgement'), () => transition(ctx, 'val', vkey, link, 'Acknowledge', c.acknowledge || 'Acknowledged')));
                    await once(ctx, `val:${vkey}:close-ack`, () => as(ctx, by('Acknowledgement'), () => transition(ctx, 'val', vkey, link, 'Close', c.Close || 'Validation closed')));
                }
                break;
            }
        }
        if (!at(p.to)) break;
        await once(ctx, `val:${vkey}:${p.next}`, () => as(ctx, by(p.state), () => transition(ctx, 'val', vkey, link, p.next, c[p.next])));
    }
}

// A requirement points at its current validation (field VALIDATION_PROCESS). Normally the validation scripts set it; when they did not,
// do it here, but only while the field is empty or still points at the previous validation of a repetition.
async function linkRequirements(ctx, vkey, validationLink, steps, replace = []) {
    const defs = await tk.describe(ctx, ctx.ws.req);
    if (!defs.byId.VALIDATION_PROCESS?.editable) return;
    const filled = (ctx.filled.req ||= {});
    if (ctx.dryRun) { filled.VALIDATION_PROCESS = (filled.VALIDATION_PROCESS || 0) + steps.length; step(ctx, 'val', `"${vkey}": make it the current validation of ${steps.length} requirement(s) (when the scripts do not)`, 'dry-run'); return; }
    await sleep(ctx.opts.pollMs);
    let set = 0;
    for (const s of steps) {
        const reqLink = created(ctx, `req:${s.requirement}`);
        try {
            const current = linkOf(fieldValue(await getItem(reqLink), 'VALIDATION_PROCESS'));
            if (current && current !== validationLink && !replace.includes(current)) continue;
            if (current !== validationLink) { await patchFields(ctx, 'req', reqLink, [['VALIDATION_PROCESS', { link: validationLink }]], s.requirement); set++; }
        } catch (e) { warn(ctx, `Requirement "${s.requirement}": the validation process link was not set (${e.message.slice(0, 120)})`); }
    }
    if (set) step(ctx, 'val', `"${vkey}": set as current validation of ${set} requirement(s)`);
}

async function buildValidations(ctx) {
    const list = ctx.story.validations || [];
    if (!list.length) return;
    const titles = await baseTitlesOf(ctx);
    for (const v of list) {
        const vkey = v.key;
        const specLink = ctx.state.created.spec;
        const rowsOf = (steps) => steps.map((s, i) => ({ ...s, STEP: s.STEP ?? i + 1 }));
        const steps = rowsOf(v.steps || []);
        await once(ctx, `val:${vkey}:create`, async () => {
            const link = await createItem(ctx, 'val', { REQUIREMENT_SPECIFICATION: specLink, ...v.fields, TITLE: v.title || v.fields?.TITLE }, v.title || vkey);
            if (!ctx.dryRun) remember(ctx, `val:${vkey}`, link);
            for (const s of steps) {
                try {
                    const body = await tk.rowPayload(ctx, ctx.ws.val, gridRow(ctx, v, s, { withResult: false }), { force: true });
                    if (!ctx.dryRun) await plm.request('POST', `${link}/views/13/rows`, { body });
                } catch (e) { fail(ctx, `${LABEL.val} "${vkey}" step "${s.requirement}": ${explain(e)}`); }
            }
            step(ctx, 'val', `"${vkey}": add ${steps.length} steps`, ctx.dryRun ? 'dry-run' : 'ok');
            await linkRequirements(ctx, vkey, link, steps);
        });
        const link = created(ctx, `val:${vkey}`) || PLACEHOLDER;
        await driveValidation(ctx, v, vkey, link, { end: v.end || 'Completed', steps, closing: v.closing, executionFields: v.executionFields, comments: v.comments, titles, assignees: v.fields });
        // Repetition of failed requirements
        if (v.repeat) await buildRepetition(ctx, v, vkey, link, steps, titles);
    }
}

// The tenant copies ALL steps into the repetition: requirements that passed before come back as Pending with their previous result.
// They get their previous result again (carried over), so that the repetition can be finished.
async function carryOver(ctx, link, rsteps, titles) {
    if (ctx.dryRun || !link || link === PLACEHOLDER) return rsteps;
    const keyOf = (t) => Object.keys(titles).find((k) => same(titles[k], stripRev(t)) || same(titles[k], t));
    const extra = [];
    for (const r of await tk.getRows(link)) {
        const k = keyOf(r.cells.BASE_REQUIREMENT);
        if (!k || rsteps.some((x) => x.requirement === k)) continue;
        const prev = String(r.cells.PREVIOUS_RESULT || '');
        if (/success/i.test(prev)) extra.push({ requirement: k, STEP: r.cells.STEP, RESULT: /conditional/i.test(prev) ? 'Conditional Success' : 'Success', COMMENTS: 'Carried over from the previous validation.' });
    }
    return [...rsteps, ...extra];
}

async function buildRepetition(ctx, v, vkey, link, steps, titles) {
    const r = v.repeat;
    const rkey = `${vkey}#2`;
    const failed = steps.filter((s) => s.RESULT === 'Failed').map((s) => s.requirement);
    let nextLink = created(ctx, `val:${rkey}`);
    if (!nextLink && !ctx.dryRun) {
        nextLink = await poll(async () => linkOf(fieldValue(await getItem(link), 'NEXT_VALIDATION')), { timeoutMs: ctx.opts.spawnTimeoutMs, intervalMs: ctx.opts.pollMs, label: 'the repeated validation' })
            .catch(() => null);
        if (!nextLink) {
            warn(ctx, `${LABEL.val} "${vkey}": the workflow did not spawn the repeated validation; it was created directly (previous validation link may be missing)`);
            nextLink = await createItem(ctx, 'val', { REQUIREMENT_SPECIFICATION: ctx.state.created.spec, ...v.fields, ...r.fields, TITLE: r.title || v.title, IS_REPETITION: true }, `${v.title || vkey} (repetition)`);
            for (const k of failed) {
                const body = await tk.rowPayload(ctx, ctx.ws.val, gridRow(ctx, v, { requirement: k, STEP: 1 }, { withResult: false }), { force: true });
                await plm.request('POST', `${nextLink}/views/13/rows`, { body });
            }
        }
        remember(ctx, `val:${rkey}`, nextLink);
    }
    if (ctx.dryRun) step(ctx, 'val', `"${vkey}": a repetition for ${failed.length} failed requirement(s) is spawned by "Close"`, 'dry-run');
    const rsteps = await carryOver(ctx, nextLink, (r.steps || []).map((s, i) => ({ STEP: i + 1, ...s })), titles);
    await once(ctx, `val:${rkey}:link`, () => linkRequirements(ctx, rkey, nextLink || PLACEHOLDER, (r.steps || []).length ? r.steps : failed.map((k) => ({ requirement: k })), [link]));
    if (r.fields && Object.keys(r.fields).length && !ctx.dryRun) await once(ctx, `val:${rkey}:fields`, () => updateItem(ctx, 'val', nextLink, r.fields, `${rkey} fields`));
    await driveValidation(ctx, v, rkey, nextLink || PLACEHOLDER, { end: r.end || 'Planning', steps: rsteps, closing: r.closing, executionFields: r.executionFields, comments: r.comments, titles, assignees: { ...v.fields, ...r.fields } });
}

/* ---------- approvals ---------- */

async function buildApprovals(ctx) {
    for (const a of ctx.story.approvals || []) {
        const akey = a.id || a.node;
        const root = flatten(ctx.story).find((x) => x.node.key === a.node)?.node;
        if (!root) { fail(ctx, `Approval "${akey}": node "${a.node}" does not exist`); continue; }
        const members = subtree(root);
        await once(ctx, `ra:${akey}:create`, async () => {
            const link = await createItem(ctx, 'appr', { REQUIREMENT_SPECIFICATION: ctx.state.created.spec, ...a.fields }, a.fields?.TITLE || akey);
            if (!ctx.dryRun) remember(ctx, `ra:${akey}`, link);
            if (ctx.dryRun) { step(ctx, 'appr', `"${akey}": add ${members.length} affected requirements (${titleOf(root)} and below)`, 'dry-run'); return; }
            const links = members.map((n) => created(ctx, `req:${n.key}`));
            try { await plm.request('POST', `${link}/affected-items`, { body: links, headers: { Accept: 'application/vnd.autodesk.plm.affected.items.bulk+json' } }); }
            catch (e) { throw new Error(`Approval "${akey}": adding the affected requirements failed: ${explain(e)}`); }
            step(ctx, 'appr', `"${akey}": added ${links.length} affected requirements`);
        });
        const link = created(ctx, `ra:${akey}`) || PLACEHOLDER;
        // Items added through the API have no lifecycle option yet; the workflow refuses to leave Definition without one.
        await once(ctx, `ra:${akey}:lifecycle`, async () => {
            const option = a.lifecycle || 'Release';
            if (ctx.dryRun) { step(ctx, 'appr', `"${akey}": set lifecycle option "${option}" on ${members.length} affected requirements`, 'dry-run'); return; }
            const list = (await plm.get(`${link}/views/11`)).affectedItems || [];
            let n = 0;
            for (const ai of list) {
                if (ai.targetTransition?.link) continue;
                const t = (ai.transitions || []).find((x) => same(x.name, option));
                if (!t) throw new Error(`Approval "${akey}": "${ai.item?.title}" has no lifecycle option "${option}" (available: ${(ai.transitions || []).map((x) => x.name).join(', ') || 'none'})`);
                try { await plm.request('PUT', ai.__self__, { body: { linkedFields: [], targetTransition: { link: t.__self__ || t.link } } }); }
                catch (e) { throw new Error(`Approval "${akey}": setting the lifecycle option of "${ai.item?.title}" failed: ${explain(e)}`); }
                n++;
            }
            step(ctx, 'appr', `"${akey}": set lifecycle option "${option}" on ${n} affected requirements`);
        });
        const end = a.end || 'Released';
        const idx = APPROVAL_STATES.indexOf(end);
        if (idx < 0) { fail(ctx, `Approval "${akey}": end must be one of ${APPROVAL_STATES.join(', ')}`); continue; }
        const c = a.comments || {};
        if (idx >= 1) await once(ctx, `ra:${akey}:submit`, () => transition(ctx, 'appr', akey, link, 'Submit for review', c.submit || 'Please review and approve'));
        const external = end === 'External Review' || (end === 'Released' && a.external === true);
        if (external) {
            await once(ctx, `ra:${akey}:ext`, () => transition(ctx, 'appr', akey, link, 'Request External Review', c.external || 'Please review with the customer'));
            if (end === 'Released') await once(ctx, `ra:${akey}:extok`, () => transition(ctx, 'appr', akey, link, 'External Approval', c.externalApprove || 'Approved by the customer'));
        } else if (idx === 3) {
            await once(ctx, `ra:${akey}:approve`, () => transition(ctx, 'appr', akey, link, 'Approve', c.approve || 'Approved'));
        }
    }
}

/* ---------- product link ---------- */

async function linkProduct(ctx) {
    const productLink = ctx.vars.product;
    if (!productLink) { fail(ctx, 'story.vars.product is required: the top level requirement is always connected to the product'); return; }
    const defs = await tk.describe(ctx, ctx.ws.product);
    if (!defs.byId.REQUIREMENTS) { fail(ctx, 'The Products workspace has no REQUIREMENTS field'); return; }
    const detail = await getItem(productLink).catch(() => null);
    if (!detail) { fail(ctx, `Product ${productLink} was not found`); return; }
    const current = linkOf(fieldValue(detail, 'REQUIREMENTS'));
    if (current && current !== ctx.state.created.top) ctx.report.productHadRequirements = { link: current, title: textOf(fieldValue(detail, 'REQUIREMENTS')) };
    if (ctx.dryRun) { step(ctx, 'product', `connect the top level requirement to ${detail.title || productLink}${current ? ' (replaces the current requirements structure)' : ''}`, 'dry-run'); return; }
    await once(ctx, 'product:link', async () => {
        try { await plm.request('PATCH', productLink, { body: { sections: tk.buildSections(ctx.ws.product, defs, [['REQUIREMENTS', { link: ctx.state.created.top }]], productLink) } }); }
        catch (e) {
            if (e.status === 403) throw new Error(`The product could not be updated (403). Add the permission "Admin Override Workflow Locks" for the Products workspace to your role and run again: ${explain(e)}`);
            throw new Error(`Connect the product: ${explain(e)}`);
        }
        step(ctx, 'product', `top level requirement connected to ${detail.title}`);
    });
}

/* ---------- impersonation ---------- */

// Before anything is written: Server-to-Server app configured and the app can really act as every assignee that performs a step.
async function verifyImpersonation(ctx) {
    if (!config.load().impersonationReady) {
        fail(ctx, 'Impersonation is selected, but no Server-to-Server app is configured (setup skill, step 3).');
        return false;
    }
    const me = (await tk.getMe(ctx)).email;
    const actors = new Map();
    for (const v of ctx.story.validations || []) {
        for (const f of [v.fields, v.repeat?.fields]) for (const k of Object.values(STAGE_ASSIGNEE)) {
            if (!k || !f?.[k]) continue;
            const a = await tk.resolveActor(ctx, f[k]);
            if (a) actors.set(a.id, a);
        }
    }
    const users = await tk.getUsers(ctx);
    let ok = true;
    for (const a of actors.values()) {
        if (!users.some((u) => same(u.email, a.id))) { fail(ctx, `Impersonation: user "${a.id}" was not found in the tenant`); ok = false; continue; }
        try {
            const u = await plm.runAs(a.mail || a.id, () => plm.get('/api/v3/users/@me'));
            if (!same(u.userId, a.id)) { fail(ctx, `Impersonation: acting as "${a.id}" returned user "${u.userId}"`); ok = false; }
        } catch (e) { fail(ctx, `Impersonation as "${a.id}" failed: ${e.message.slice(0, 200)}. The Server-to-Server app must be whitelisted in the tenant and the user needs a valid e-mail address.`); ok = false; }
    }
    ctx.report.impersonation = { enabled: true, loginUser: me, actors: [...actors.keys()] };
    step(ctx, 'run', `impersonation verified for ${actors.size} user(s): ${[...actors.keys()].join(', ') || 'none besides the login user'}`, ctx.dryRun ? 'dry-run' : 'ok');
    return ok;
}

/* ---------- shape checks, coverage, summary ---------- */

function checkStoryShape(story) {
    const errors = [];
    if (!story || typeof story !== 'object') return ['story must be an object'];
    if (!story.name) errors.push('story.name is required');
    if (!story.vars?.product) errors.push('story.vars.product (link of the product) is required');
    if (!story.spec?.fields?.TITLE) errors.push('story.spec.fields.TITLE is required');
    if (!Array.isArray(story.requirements) || !story.requirements.length) errors.push('story.requirements needs at least one level 1 requirement');
    const keys = new Set();
    let maxDepth = 0;
    walk(story.requirements, (n, depth) => {
        maxDepth = Math.max(maxDepth, depth);
        if (!n.key || !/^[a-z0-9][a-z0-9-]*$/i.test(n.key)) errors.push(`requirement "${titleOf(n)}": key is required (letters, digits, -)`);
        else if (keys.has(n.key)) errors.push(`duplicate requirement key "${n.key}"`);
        keys.add(n.key);
        if (!titleOf(n)) errors.push(`requirement ${n.key}: title is required`);
        if (depth > MAX_LEVELS) errors.push(`requirement "${n.key}" is on level ${depth}: at most ${MAX_LEVELS} levels are allowed`);
    });
    if (maxDepth < 2) errors.push('the structure needs at least 2 levels');
    const refs = (k, what) => { if (!keys.has(k)) errors.push(`${what}: unknown requirement key "${k}"`); };
    walk(story.requirements, (n) => {
        for (const f of REF_FIELDS) for (const k of [].concat(n.fields?.[f] || [])) refs(k, `${n.key}.${f}`);
    });
    const topKeys = new Set((story.requirements || []).map((n) => n.key));
    for (const a of story.approvals || []) {
        if (!topKeys.has(a.node)) errors.push(`approval "${a.id || a.node}": node "${a.node}" must be a level 1 requirement key`);
    }
    for (const a of story.approvals || []) {       // the template offers "Approve" only when no external approvers are set
        const ext = [].concat(a.fields?.EXTERNAL_APPROVERS || []).length > 0;
        const end = a.end || 'Released';
        if (!a.external && ext && end === 'Released') errors.push(`approval "${a.id || a.node}": EXTERNAL_APPROVERS are set, so the template only allows the external route: set "external": true or remove the external approvers`);
        if (a.external && !ext) errors.push(`approval "${a.id || a.node}": "external": true needs EXTERNAL_APPROVERS`);
    }
    const seenNodes = new Set();
    for (const a of story.approvals || []) { if (seenNodes.has(a.node)) errors.push(`level 1 node "${a.node}" has two approvals`); seenNodes.add(a.node); }
    const vkeys = new Set();
    for (const v of story.validations || []) {
        if (!v.key) { errors.push(`validation "${v.title}": key is required`); continue; }
        if (vkeys.has(v.key)) errors.push(`duplicate validation key "${v.key}"`); vkeys.add(v.key);
        if (!v.steps?.length) errors.push(`validation "${v.key}" needs steps`);
        const end = v.end || 'Completed';
        if (!VALIDATION_STATES.includes(end)) errors.push(`validation "${v.key}": end must be one of ${VALIDATION_STATES.join(', ')}`);
        for (const s of v.steps || []) refs(s.requirement, `validation ${v.key} step`);
        const past = VALIDATION_STATES.indexOf(end) > VALIDATION_STATES.indexOf('Execution');
        if (past) for (const s of v.steps || []) if (!s.RESULT || s.RESULT === 'Pending') errors.push(`validation "${v.key}": step "${s.requirement}" needs a RESULT because the validation ends in ${end}`);
        const failed = (v.steps || []).filter((s) => s.RESULT === 'Failed').map((s) => s.requirement);
        if (v.repeat) {
            if (end !== 'Completed') errors.push(`validation "${v.key}": a repetition is only spawned when it ends in Completed`);
            if (!/^yes$/i.test(String(v.closing?.REPETITION_REQUIRED || ''))) errors.push(`validation "${v.key}": repeat needs closing.REPETITION_REQUIRED = "Yes"`);
            if (!failed.length) errors.push(`validation "${v.key}": repeat needs at least one failed step`);
            for (const s of v.repeat.steps || []) if (!failed.includes(s.requirement)) errors.push(`validation "${v.key}": repeat step "${s.requirement}" did not fail in the first run`);
        } else if (/^yes$/i.test(String(v.closing?.REPETITION_REQUIRED || ''))) errors.push(`validation "${v.key}": REPETITION_REQUIRED is Yes but there is no repeat block`);
    }
    return errors;
}

async function computeCoverage(ctx) {
    for (const proc of ['spec', 'req', 'val', 'appr']) {
        const defs = await tk.describe(ctx, ctx.ws[proc]);
        const writable = defs.list.filter((f) => f.editable && f.section && !SCRIPT_FIELDS.has(f.id) && !/^MATRIX_/.test(f.id)).map((f) => f.id);
        const filled = ctx.filled[proc] || {};
        ctx.report.coverage[proc] = { filled: writable.filter((id) => filled[id]).length, total: writable.length, unfilled: writable.filter((id) => !filled[id]) };
    }
    // Requirements: also report fields that only some requirements fill
    const reqs = flatten(ctx.story);
    const perField = {};
    for (const { node } of reqs) for (const id of Object.keys(node.fields || {})) perField[id] = (perField[id] || 0) + 1;
    ctx.report.coverage.requirementsTotal = reqs.length;
    ctx.report.coverage.requirementFieldCounts = perField;
}

function viewUrl(wsId, link) {
    const { tenant } = config.load();
    const id = plm.idOf(link);
    return `https://${tenant}.autodeskplm360.net/plm/workspaces/${wsId}/items/itemDetails?view=full&tab=details&mode=view&itemId=urn%60adsk%2Cplm%60tenant%2Cworkspace%2Citem%60${String(tenant).toUpperCase()}%2C${wsId}%2C${id}`;
}
async function summarize(ctx) {
    const add = async (proc, key, label) => {
        const link = ctx.state.created[key];
        if (!link) return;
        const d = await getItem(link).catch(() => null);
        if (!d) return;
        ctx.report.items.push({ process: label, number: textOf(fieldValue(d, 'ID')), title: String(d.title || ''), state: stateOf(d) || d.lifecycle?.title || '', link, url: viewUrl(ctx.ws[proc], link) });
    };
    await add('spec', 'spec', LABEL.spec);
    await add('req', 'top', 'Top Level Requirement');
    for (const { node } of flatten(ctx.story)) await add('req', `req:${node.key}`, LABEL.req);
    for (const v of ctx.story.validations || []) { await add('val', `val:${v.key}`, LABEL.val); if (v.repeat) await add('val', `val:${v.key}#2`, `${LABEL.val} (repetition)`); }
    for (const a of ctx.story.approvals || []) await add('appr', `ra:${a.id || a.node}`, LABEL.appr);
}

/* ---------- public API ---------- */

async function run(story, opts = {}) {
    const shape = checkStoryShape(story);
    if (shape.length) return { ok: false, dryRun: true, errors: shape, warnings: [], steps: [], items: [], coverage: {} };
    const ctx = await makeContext(story, opts);
    try {
        ctx.vars.me = (await tk.getMe(ctx)).link;
        if (!(await getItem(ctx.vars.product).catch(() => null))) { fail(ctx, `Product ${ctx.vars.product} was not found`); if (!ctx.dryRun) return ctx.report; }
        if (ctx.impersonate && !(await verifyImpersonation(ctx))) { ctx.report.ok = false; return ctx.report; }
        await buildSpec(ctx);
        await buildRequirements(ctx);
        await buildImplementedBy(ctx);
        await buildValidations(ctx);
        await buildApprovals(ctx);
        await linkProduct(ctx);
        if (ctx.dryRun) await computeCoverage(ctx);
        else await summarize(ctx);
    } catch (e) {
        ctx.report.errors.push(e.message);
        ctx.report.stoppedWith = e.message;
        if (!ctx.dryRun) {
            ctx.report.hint = `Nothing is rolled back. Fix the cause and run again: finished steps are skipped (state in ${path.relative(path.join(__dirname, '..'), ctx.stateFile)}).`;
            try { await summarize(ctx); } catch { /* best effort */ }
        }
    }
    ctx.report.ok = ctx.report.errors.length === 0;
    return ctx.report;
}

/* ---------- context for the skill ---------- */

async function readBom(rootLink) {
    const b = await plm.get(`${rootLink}/bom?depth=10&revisionBias=working&limit=500`, { headers: { Accept: 'application/vnd.autodesk.plm.bom.bulk+json' } });
    const byId = {};
    for (const n of b.nodes || []) byId[idOfUrn(n.item?.urn)] = n;
    const rootId = plm.idOf(rootLink);
    const kids = {};
    for (const e of b.edges || []) (kids[idOfUrn(e.parent)] ||= []).push(e);
    const out = [];
    const seen = new Set();
    const visit = (id, depth, path_) => {
        for (const e of (kids[id] || []).sort((a, c) => (a.itemNumber || 0) - (c.itemNumber || 0))) {
            const cid = idOfUrn(e.child);
            const n = byId[cid];
            const link = n?.item?.link || `${rootLink.split('/items/')[0]}/items/${cid}`;
            const descriptor = stripRev(n?.item?.title || cid);
            out.push({ link, dmsId: cid, descriptor, level: depth, path: path_, children: (kids[cid] || []).length });
            if (!seen.has(cid)) { seen.add(cid); visit(cid, depth + 1, `${path_} > ${descriptor}`); }
        }
    };
    visit(rootId, 1, stripRev(byId[rootId]?.item?.title || rootId));
    return out;
}

async function findProduct(ref) {
    const ws = (await resolveWorkspaces()).product;
    const q = String(ref).trim();
    const found = new Map();
    const add = (it) => { const l = it.__self__ || it.link; if (l && String(l).includes(`/workspaces/${ws}/`)) found.set(l, { link: l, descriptor: it.descriptor || it.title }); };
    if (/^\d+$/.test(q)) { try { const d = await plm.get(`/api/v3/workspaces/${ws}/items/${q}`); add({ __self__: d.__self__, descriptor: d.title }); } catch { /* not a dmsId */ } }
    try {
        const r = await plm.get(`/api/v3/search-results?query=${encodeURIComponent(q)}&limit=50`);
        for (const it of r.items || []) if (norm(it.descriptor).includes(norm(q))) add(it);
    } catch { /* search is best effort */ }
    if (!found.size) {   // fall back to scanning the product list
        for (const it of await plm.listAll(`/api/v3/workspaces/${ws}/items`)) if (norm(it.descriptor).includes(norm(q))) add(it);
    }
    return [...found.values()];
}

async function context(ref) {
    const candidates = await findProduct(ref);
    if (candidates.length !== 1) return { ok: false, candidates, message: candidates.length ? 'More than one product matches: pick one' : `No product found for "${ref}"` };
    const ws = await resolveWorkspaces();
    const d = await getItem(candidates[0].link);
    const ebomRoot = linkOf(fieldValue(d, 'ENGINEERING_BOM'));
    const product = {
        link: candidates[0].link, dmsId: plm.idOf(candidates[0].link), descriptor: candidates[0].descriptor,
        title: textOf(fieldValue(d, 'TITLE')), description: textOf(fieldValue(d, 'DESCRIPTION')),
        productLine: textOf(fieldValue(d, 'PRODUCT_LINE')), category: textOf(fieldValue(d, 'PRODUCT_CATEGORY')),
        project: linkOf(fieldValue(d, 'NPI_PROJECT')) ? { link: linkOf(fieldValue(d, 'NPI_PROJECT')), title: textOf(fieldValue(d, 'NPI_PROJECT')) } : null,
        engineeringBom: ebomRoot ? { link: ebomRoot, title: textOf(fieldValue(d, 'ENGINEERING_BOM')) } : null,
        requirements: linkOf(fieldValue(d, 'REQUIREMENTS')) ? { link: linkOf(fieldValue(d, 'REQUIREMENTS')), title: textOf(fieldValue(d, 'REQUIREMENTS')) } : null
    };
    const ctx = { dryRun: true, users: null, me: null, lookups: {} };
    let ebom = [];
    if (ebomRoot) {
        ebom = await readBom(ebomRoot);
        // Add descriptions so the skill can pick items that really drive a requirement
        const queue = ebom.slice(0, 160);
        for (let i = 0; i < queue.length; i += 8) {
            await Promise.all(queue.slice(i, i + 8).map(async (n) => {
                try { const it = await getItem(n.link); n.description = textOf(fieldValue(it, 'DESCRIPTION')).replace(/<[^>]+>/g, '').slice(0, 200); } catch { /* optional */ }
            }));
        }
    }
    const lookup = async (name) => (await tk.lookupOptions(ctx, `/api/v3/lookups/${name}`)).map((o) => o.title);
    const existingSpecs = (await plm.listAll(`/api/v3/workspaces/${ws.spec}/items`)).map((i) => i.descriptor);
    return {
        ok: true, product, workspaces: ws, me: await tk.getMe(ctx), users: await tk.getUsers(ctx), ebom, existingSpecifications: existingSpecs,
        picklists: {
            groups: await lookup('CUSTOM_LOOKUP_REQUIREMENTS_MANAGEMENT_GROUPS'), sources: await lookup('CUSTOM_LOOKUP_REQUIREMENT_SOURCES'),
            types: await lookup('CUSTOM_LOOKUP_REQUIREMENT_TYPES'), assessment: await lookup('CUSTOM_LOOKUP_REQUIREMENT_ASSESSMENT'),
            results: await lookup('CUSTOM_LOOKUP_REQUIREMENT_TEST_RESULT'), validationTypes: await lookup('CUSTOM_LOOKUP_TEST_TYPES')
        }
    };
}

module.exports = { run, context, findProduct, checkStoryShape, readBom, flatten, subtree };
