// update-timelines utility: moves outdated planning/tracking dates of the demo data to the present.
//  - A "timeline" is one root record plus its child records (e.g. Engineering Project + Activities, Change Request + Change Tasks),
//    or a single record for standalone workspaces (Change Orders, Problem Reports, ...).
//  - Every date of a timeline is shifted by the SAME whole number of weeks, so durations and weekdays never change.
//  - The shift is chosen so that the earliest still-pending target date lands in the previous or the current week
//    (dates that are already missed are good for the demo story). Timelines with no pending date use their latest date.
//  - Timelines that are not outdated (anchor already in the window or later) are left alone. Dry run by default.
const fs   = require('fs');
const path = require('path');
const plm  = require('./plm');

const WORK_DIR = path.join(__dirname, '..', 'work');
const DAY = 86400000;

// root: workspace title of the timeline root. children: workspaces whose records belong to a root (matched through a link field).
// A workspace without children is "standalone": every record is its own timeline.
const GROUPS = [
    { key: 'engineering', label: 'Engineering Projects',  root: /^engineering projects?$/i,  children: [/^engineering project activities$/i] },
    { key: 'ppm',         label: 'Projects (PPM)',        root: /^projects?$/i,              children: [/^project phases$/i, /^project tasks$/i] },
    { key: 'innovation',  label: 'Innovation Projects',   root: /^innovation projects?$/i,   children: [/^sprint activities$/i] },
    { key: 'changeRequests', label: 'Change Requests',    root: /^change requests?$/i,       children: [/^change tasks$/i] },
    { key: 'changeOrders', label: 'Change Orders',         root: /^change orders?$/i },
    { key: 'leanChangeOrders', label: 'Lean Change Orders', root: /^lean change orders?$/i },
    { key: 'problemReports', label: 'Problem Reports',     root: /^problem reports?$/i },
    { key: 'supplier',    label: 'Supplier Collaboration', root: /^supplier packages?$/i,    children: [/^supplier deliverables$/i] },
    { key: 'ideas',       label: 'Product Ideation',      root: /^ideas$/i },
    { key: 'quality',     label: 'Quality Inspections',   root: /^quality inspections?$/i },
    { key: 'audits',      label: 'Audits',                root: /^audits?$/i }
];

const TERMINAL = /complete|closed|released|implemented|cancel|reject|done|selected|approved|obsolete/i;
const FORWARD  = /TARGET|PLANNED|DUE|DEADLINE|FOLLOWUP|EXPECTED|NEXT|FINAL/i;   // fields that describe the plan, not what happened
const SKIP_STATE = /template/i;                                                                     // template records carry no real timeline
const ISO = /^\d{4}-\d{2}-\d{2}/;

/* ---------- date helpers (UTC, whole days) ---------- */
const toDay   = (s) => Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / DAY;
const fromDay = (n) => new Date(n * DAY).toISOString().slice(0, 10);
const weekday = (day) => (new Date(day * DAY).getUTCDay() + 6) % 7;            // Monday = 0
const mondayOf = (day) => day - weekday(day);

/**
 * Whole-week shift (in days, multiple of 7) that puts anchorDay into the target week.
 * week 'this' = the current Mon-Sun week, 'previous' = the week before.
 * Returns 0 when the anchor is already inside the window [Monday of the previous week, end of time).
 */
function shiftFor(anchorDay, todayDay, week = 'this') {
    const windowStart = mondayOf(todayDay) - 7;
    if (anchorDay >= windowStart) return 0;
    const targetMonday = mondayOf(todayDay) - (week === 'previous' ? 7 : 0);
    const target = targetMonday + weekday(anchorDay);
    return target - anchorDay;                                                   // multiple of 7 by construction
}

/* ---------- reading ---------- */
async function pool(items, size, fn) {
    const out = new Array(items.length); let next = 0;
    await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
        while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
    }));
    return out;
}

async function dateFieldTypes(wsId) {
    const res = await plm.get(`/api/v3/workspaces/${wsId}/fields`);
    const ids = new Set(), editability = {};
    for (const f of res.fields || []) {
        const id = plm.idOf(f.__self__);
        editability[id] = f.editability;
        if (f.type && /^date$/i.test(f.type.title || '')) ids.add(id);
    }
    return { ids, editability };
}

async function readWorkspace(ws, wsId, parentWsId) {
    const { ids, editability } = await dateFieldTypes(wsId);
    const list = (await plm.listAll(`/api/v3/workspaces/${wsId}/items`).catch(() => [])) || [];
    const recs = await pool(list, 6, async (it) => {
        const link = it.link || it.__self__;
        const d = await plm.get(link);
        const state = (d.currentState && d.currentState.title) || '';
        const dates = [];
        let parent = null;
        for (const s of d.sections || []) for (const f of s.fields || []) {
            const id = plm.idOf(f.__self__);
            if (ids.has(id) && typeof f.value === 'string' && ISO.test(f.value)) {
                dates.push({ field: id, value: f.value.slice(0, 10), section: plm.idOf(s.link || s.__self__), editability: editability[id] });
            }
            if (parentWsId && !parent && f.value && f.value.link && new RegExp(`/workspaces/${parentWsId}/items/`).test(f.value.link)) parent = f.value.link;
        }
        return { workspace: ws, workspaceId: wsId, link, title: it.descriptor || d.title || link, state, dates, parent };
    });
    return recs.filter((r) => r.dates.length && !SKIP_STATE.test(r.state));
}

/* ---------- planning ---------- */
function planTimeline(name, records, todayDay, week) {
    const all = records.flatMap((r) => r.dates.map((d) => ({ r, ...d, day: toDay(d.value) })));
    if (!all.length) return null;
    const pending = all.filter((d) => !TERMINAL.test(d.r.state) && FORWARD.test(d.field));
    const anchor = pending.length ? pending.reduce((a, b) => (b.day < a.day ? b : a))
                                  : all.reduce((a, b) => (b.day > a.day ? b : a));
    let shift = shiftFor(anchor.day, todayDay, week);
    // Dates of things that already happened (actual starts/completions, submittals, ...) must not move into the future:
    // cap the shift (in whole weeks) so the latest of them stays on or before today. Pending dates may then land earlier.
    const happened = all.filter((d) => !FORWARD.test(d.field));
    let capped = false;
    if (shift && happened.length) {
        const cap = Math.max(0, Math.floor((todayDay - Math.max(...happened.map((d) => d.day))) / 7) * 7);
        // only cap when the pending anchor still lands in the window; otherwise the pending-date goal wins (and the warning below reports it)
        if (cap < shift && anchor.day + cap >= mondayOf(todayDay) - 7) { shift = cap; capped = true; }
    }
    const first = Math.min(...all.map((d) => d.day)), last = Math.max(...all.map((d) => d.day));
    const t = { timeline: name, records: records.length, dates: all.length, shiftDays: shift, limited: capped, anchor: { record: anchor.r.title, field: anchor.field, from: anchor.value, to: fromDay(anchor.day + shift), basis: pending.length ? 'earliest pending' : 'latest date' },
                span: { from: fromDay(first), to: fromDay(last), newFrom: fromDay(first + shift), newTo: fromDay(last + shift) }, warnings: [] };
    if (!shift) { t.skipped = capped ? 'recent completed dates leave no room to shift' : 'not outdated'; return t; }
    if (capped) t.warnings.push(`shift limited so completed dates stay in the past: earliest pending date lands ${fromDay(anchor.day + shift)} instead of the target week`);
    const future = all.filter((d) => TERMINAL.test(d.r.state) && d.day + shift > todayDay);
    if (future.length) t.warnings.push(`${future.length} date(s) of completed records would land after today (${[...new Set(future.map((d) => d.field))].slice(0, 4).join(', ')})`);
    t.changes = records.map((r) => ({ record: r.title, link: r.link, workspaceId: r.workspaceId, state: r.state,
        dates: r.dates.map((d) => ({ field: d.field, section: d.section, editability: d.editability, from: d.value, to: fromDay(toDay(d.value) + shift) })) }));
    return t;
}

async function collect({ only } = {}) {
    const all = await plm.listAll('/api/v3/workspaces');
    const find = (re) => all.find((w) => re.test(String(w.title || w.name || '').trim()));
    const warnings = [], timelines = [];
    for (const g of GROUPS.filter((x) => !only || only.includes(x.key))) {
        const rootWs = find(g.root);
        if (!rootWs) { warnings.push(`${g.label}: workspace not found`); continue; }
        const rootId = plm.idOf(rootWs.link || rootWs.__self__);
        const roots = await readWorkspace(rootWs.title, rootId, null);
        const kids = [];
        for (const re of g.children || []) {
            const ws = find(re);
            if (!ws) { warnings.push(`${g.label}: child workspace ${re} not found`); continue; }
            kids.push(...await readWorkspace(ws.title, plm.idOf(ws.link || ws.__self__), rootId));
        }
        const byRoot = new Map(roots.map((r) => [r.link, [r]]));
        for (const k of kids) {
            if (k.parent && byRoot.has(k.parent)) byRoot.get(k.parent).push(k);
            else if (k.parent) byRoot.set(k.parent, [k]);          // root has no dates itself, children still form its timeline
            else byRoot.set(k.link, [k]);                          // orphan child: own timeline
        }
        for (const [rootLink, recs] of byRoot) timelines.push({ group: g, key: rootLink, recs });
    }
    return { timelines, warnings };
}

/**
 * options: { dryRun = true, only = [group keys], week = 'this' | 'previous', today = 'YYYY-MM-DD' (for tests/preview) }
 */
async function run({ dryRun = true, only, week = 'this', today } = {}) {
    const todayDay = today ? toDay(today) : Math.floor(Date.now() / DAY);
    const report = { dryRun, today: fromDay(todayDay), week, groups: {}, updated: [], skipped: [], warnings: [], errors: [] };
    const { timelines, warnings } = await collect({ only });
    report.warnings.push(...warnings);
    for (const tl of timelines) {
        const plan = planTimeline(tl.recs.find((r) => !r.parent)?.title || tl.recs[0].title, tl.recs, todayDay, week);
        if (!plan) continue;
        const g = report.groups[tl.group.key] || (report.groups[tl.group.key] = { label: tl.group.label, timelines: 0, shifted: 0, notOutdated: 0 });
        g.timelines++;
        if (plan.skipped) { g.notOutdated++; report.skipped.push({ group: tl.group.label, timeline: plan.timeline, anchor: plan.anchor }); continue; }
        g.shifted++;
        const entry = { group: tl.group.label, timeline: plan.timeline, shiftDays: plan.shiftDays, limited: plan.limited, anchor: plan.anchor, span: plan.span, records: plan.records, dates: plan.dates, warnings: plan.warnings, failed: [] };
        report.warnings.push(...plan.warnings.map((w) => `${plan.timeline}: ${w}`));
        if (!dryRun) {
            for (const c of plan.changes) {
                try { await writeRecord(c); }
                catch (e) {
                    // fall back to field-by-field so one read-only field does not block the rest; report what could not be written
                    for (const d of c.dates) {
                        try { await writeRecord({ ...c, dates: [d] }); }
                        catch (e2) { entry.failed.push({ record: c.record, field: d.field, editability: d.editability, error: String(e2.message).slice(0, 160) }); }
                    }
                }
            }
            if (entry.failed.length) report.errors.push({ timeline: plan.timeline, failedFields: entry.failed.length, note: 'timeline only partly shifted: durations are inconsistent until fixed', sample: entry.failed.slice(0, 5) });
        } else entry.changes = plan.changes.slice(0, 3);          // dry run: show a sample of the concrete before/after values
        report.updated.push(entry);
    }
    fs.mkdirSync(WORK_DIR, { recursive: true });
    fs.writeFileSync(path.join(WORK_DIR, `timelines-${dryRun ? 'plan' : 'result'}.json`), JSON.stringify(report, null, 2));
    return report;
}

async function writeRecord(c) {
    const bySection = new Map();
    for (const d of c.dates) {
        if (!bySection.has(d.section)) bySection.set(d.section, { link: `${c.link}/views/1/sections/${d.section}`, fields: [] });
        bySection.get(d.section).fields.push({ __self__: `${c.link}/views/1/fields/${d.field}`, value: d.to });
    }
    await plm.request('PATCH', c.link, { body: { sections: [...bySection.values()] } });
}

/**
 * Write test: PATCHes one date field per workspace with its CURRENT value (no data change) to find out which
 * date fields the API accepts. Dry run (default) only lists the candidates.
 */
async function probe({ dryRun = true, only } = {}) {
    const { timelines } = await collect({ only });
    const seen = new Set(), results = [];
    for (const tl of timelines) for (const r of tl.recs) for (const d of r.dates) {
        const k = `${r.workspaceId}:${d.editability}`;
        if (seen.has(k)) continue;
        seen.add(k);
        const row = { workspace: r.workspace, record: r.title, field: d.field, editability: d.editability };
        if (!dryRun) {
            try { await writeRecord({ link: r.link, dates: [{ field: d.field, section: d.section, to: d.value }] }); row.writable = true; }
            catch (e) { row.writable = false; row.error = String(e.message).slice(0, 160); }
        }
        results.push(row);
    }
    return { dryRun, results };
}

module.exports = { run, probe, shiftFor, planTimeline, toDay, fromDay, GROUPS };
