// update-empty-user-selections utility: puts the logged-in user into EMPTY user picklists of template-like records.
//  - Change Approval Templates:        every "... Coordinator" field
//  - Products:                         every user picklist in section "Milestones & Checklists" (Approver 1-5)
//  - Engineering Project Templates:    every user picklist in section "Project Team Members" (Users Team 1-5)
// Fields that already hold a value are never touched. Dry run by default.
const plm  = require('./plm');
const ppm  = require('./ppm');

// A rule picks a workspace by title and the fields to fill by section and/or field name.
const RULES = [
    { key: 'changeTemplates', label: 'Change Approval Templates',     workspace: /^change approval templates?$/i,     field: /coordinator/i },
    { key: 'products',        label: 'Products',                      workspace: /^products?$/i,                      section: /milestones\s*(&|and)\s*checklists/i },
    { key: 'projectTemplates', label: 'Engineering Project Templates', workspace: /^engineering project templates?$/i, section: /project\s*team\s*members/i }
];

const isUserPicklist = (f) => /USERS/i.test(f.picklist || '');
const isMulti = (f) => /multi/i.test(f.type || '');
const nameKey = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9À-ɏ ]+/g, ' ').split(/\s+/).filter(Boolean).sort().join(' ');
const isEmpty = (v) => v == null || v === '' || (Array.isArray(v) && v.length === 0) || (typeof v === 'object' && !Array.isArray(v) && !v.link && !v.__self__);

async function getMe() {
    const u = await plm.get('/api/v3/users/@me');
    return { id: u.userId, name: u.displayName || [u.firstName, u.lastName].filter(Boolean).join(' ') || u.userId };
}

// The user picklist is a lookup; its options are not users but option links, so find my own option by name.
async function myOption(picklist, me, cache) {
    if (!(picklist in cache)) {
        const rows = await plm.listAll(picklist, 'items', 100);
        const key = nameKey(me.name);
        const hit = rows.find((o) => nameKey(o.title ?? o.name) === key);
        cache[picklist] = hit ? (hit.link || hit.__self__) : null;
    }
    return cache[picklist];
}

function valueFor(def, link) {
    return isMulti(def) ? [{ link }] : { link };
}

/**
 * Scan all items of the three workspaces and (unless dryRun) fill the empty fields.
 * options: { dryRun = true, only = [rule keys] }
 */
async function run({ dryRun = true, only } = {}) {
    const report = { dryRun, user: null, workspaces: [], filled: [], skipped: 0, warnings: [], errors: [] };
    const me = await getMe();
    report.user = me;
    const all = await plm.listAll('/api/v3/workspaces');
    const options = {};

    for (const rule of RULES.filter((r) => !only || only.includes(r.key))) {
        const ws = all.find((w) => rule.workspace.test(String(w.title || w.name || '').trim()));
        if (!ws) { report.warnings.push(`${rule.label}: workspace not found`); continue; }
        const wsId = plm.idOf(ws.link || ws.__self__);
        const d = await ppm.describeWorkspace(wsId);
        const targets = d.fields.filter((f) => isUserPicklist(f) && f.editable
            && (!rule.section || (f.section && rule.section.test(f.section.name)))
            && (!rule.field || rule.field.test(f.name || '') || rule.field.test(f.id)));
        if (!targets.length) { report.warnings.push(`${rule.label}: no matching user picklist fields`); continue; }
        const byId = Object.fromEntries(targets.map((f) => [f.id, f]));
        const summary = { rule: rule.key, workspace: rule.label, workspaceId: wsId, fields: targets.map((f) => f.id), items: 0 };
        report.workspaces.push(summary);

        const items = await plm.listAll(`/api/v3/workspaces/${wsId}/items`);
        for (const it of items) {
            const link = it.link || it.__self__;
            const title = it.descriptor || it.title || link;
            summary.items++;
            try {
                const detail = await plm.get(link);
                const bySection = new Map(), filledIds = [];
                for (const s of detail.sections || []) for (const f of s.fields || []) {
                    const id = plm.idOf(f.__self__);
                    const def = byId[id];
                    if (!def) continue;
                    if (!isEmpty(f.value)) { report.skipped++; continue; }
                    const opt = await myOption(def.picklist, me, options);
                    if (!opt) {
                        const w = `${def.name} (${id}): ${me.name} is not offered by its picklist, skipped`;
                        if (!report.warnings.includes(w)) report.warnings.push(w);
                        continue;
                    }
                    const sectionLink = plm.idOf(s.link || s.__self__);
                    if (!bySection.has(sectionLink)) bySection.set(sectionLink, { link: `${link}/views/1/sections/${sectionLink}`, fields: [] });
                    bySection.get(sectionLink).fields.push({ __self__: `${link}/views/1/fields/${id}`, value: valueFor(def, opt) });
                    filledIds.push(id);
                }
                if (!filledIds.length) continue;
                if (!dryRun) await plm.request('PATCH', link, { body: { sections: [...bySection.values()] } });
                report.filled.push({ workspace: rule.label, item: title, link, fields: filledIds });
            } catch (e) {
                const d = e.details;
                if (e.status === 403 && rule.key === 'products' && !report.warnings.some((w) => /Admin Override Workflow Locks/.test(w))) {
                    report.warnings.push('Products returned 403: the user probably needs the permission "Admin Override Workflow Locks" for the Products workspace');
                } const why = Array.isArray(d) ? d.map((x) => x.message).join('; ') : (d && d.message) || '';
                report.errors.push({ workspace: rule.label, item: title, error: `${e.message.slice(0, 120)} ${why}`.trim().slice(0, 300) });
            }
        }
    }
    return report;
}

module.exports = { run, RULES, getMe, nameKey };
