const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');
process.env.PLM_TENANT = 'mock'; process.env.APS_CLIENT_ID = 'x'.repeat(30);
require.cache[require.resolve('../lib/auth')] = { exports: { getAccessToken: async () => 'tok', getSsaToken: async () => 'ssa' }, loaded: true, id: require.resolve('../lib/auth') };
const rq = require('../lib/requirements');

/* ---------- a tiny in-memory Fusion Manage with the requirements management scripts ---------- */

const WS = { 142: 'Requirement Specifications', 143: 'Requirements', 144: 'Requirement Validations', 145: 'Requirement Approvals', 57: 'Items', 95: 'Products' };
const T = (w) => w.trim().split('\n').map((l) => l.split('|').map((x) => x.trim()));
const WORKFLOW = {
    144: T(`Start||Planning
            Assign|Planning|Preparation
            Finish Preparation|Preparation|Execution
            Finish Execution|Execution|Reporting
            Close|Reporting|Completed
            Submit for acknowledgement|Reporting|Acknowledgement
            Acknowledge|Acknowledgement|Acknowledgement
            Close|Acknowledgement|Completed`),
    145: T(`Start||Definition
            Submit for review|Definition|Internal Review
            Approve|Internal Review|Released
            Request External Review|Internal Review|External Review
            External Approval|External Review|Released`)
};
const FIELDS = {   // id: [type, picklist, editability]
    142: { TITLE: ['Single Line Text'], DESCRIPTION: ['Paragraph'], GROUP_NAME: ['Single Selection', 'GROUPS'], ID: ['Single Line Text', null, 'NEVER'], TOP_LEVEL_REQUIREMENT: ['Single Selection', 'CUSTOM_LOOKUP_WS_REQUIREMENTS', 'NEVER'], INTERNAL_APPROVERS: ['Multiple Selection', 'CUSTOM_LOOKUP_ALL_USERS_VIEW'], FILENAME_1: ['Single Line Text'], FILE_DATE_1: ['Date'] },
    143: { REQUIREMENT_SPECIFICATION: ['Single Selection', 'CUSTOM_LOOKUP_WS_SPECS'], SPECIFICATION_ID: ['Single Line Text', null, 'NEVER'], ID: ['Single Line Text'], TITLE: ['Single Line Text'], DESCRIPTION: ['Paragraph'], SOURCE: ['Single Selection', 'SOURCES'], TYPE: ['Radio Button', 'TYPES'], PRIORITY: ['Radio Button', 'ASSESS'],
        LABOR_COST: ['Integer'], TOTAL_COST: ['Integer', null, 'NEVER'], IMAGE_1: ['Image'], DEPENDENT_REQUIREMENTS: ['Multiple Selection', 'CUSTOM_LOOKUP_WS_REQUIREMENTS'], DEPENDENT_REQUIREMENTS_COMMENTS: ['Paragraph'], VALIDATION_PROCESS: ['Single Selection', 'CUSTOM_LOOKUP_WS_VALS'], TEST_PROCEDURE: ['Paragraph'], EXPECTED_RESULT: ['Paragraph'], SUCCESS_CRITERIA: ['Paragraph'] },
    144: { REQUIREMENT_SPECIFICATION: ['Single Selection', 'CUSTOM_LOOKUP_WS_SPECS'], TITLE: ['Single Line Text'], TYPE: ['Single Selection', 'VTYPES'], ASSIGNEE_1: ['Single Selection', 'CUSTOM_LOOKUP_ALL_USERS_VIEW'], TARGET_DATE_1: ['Date'], IS_REPETITION: ['Check Box'], TEST_RUN_IMAGE_1: ['Image'],
        REPETITION_REQUIRED: ['Radio Button', 'YESNO'], REPETITION_DATE: ['Date'], NEXT_VALIDATION: ['Single Selection', 'CUSTOM_LOOKUP_WS_VALS', 'NEVER'], RESULT: ['Single Selection', 'RESULTS', 'NEVER'] },
    145: { REQUIREMENT_SPECIFICATION: ['Single Selection', 'CUSTOM_LOOKUP_WS_SPECS'], TITLE: ['Single Line Text'], DESCRIPTION: ['Paragraph'], CHANGE_REASON: ['Single Line Text'], INTERNAL_APPROVERS: ['Multiple Selection', 'CUSTOM_LOOKUP_ALL_USERS_VIEW'], EXTERNAL_APPROVERS: ['Multiple Selection', 'CUSTOM_LOOKUP_ALL_USERS_VIEW'] },
    95 : { TITLE: ['Single Line Text'], REQUIREMENTS: ['Single Selection', 'CUSTOM_LOOKUP_WS_REQUIREMENTS'], ENGINEERING_BOM: ['Single Selection', 'CUSTOM_LOOKUP_WS_ITEMS'], NPI_PROJECT: ['Single Selection', 'CUSTOM_LOOKUP_WS_PROJECTS'] },
    57 : { TITLE: ['Single Line Text'] }
};
const GRID = {
    142: { DATE: ['Date'], DECISION: ['Single Line Text'], RATIONALE: ['Paragraph'] },
    144: { STEP: ['Single Line Text'], TEST_PROCEDURE: ['Paragraph'], EXPECTED_RESULT: ['Paragraph'], SUCCESS_CRITERIA: ['Paragraph'], BASE_REQUIREMENT: ['Single Selection', '/api/v3/lookups/CUSTOM_LOOKUP_WS_REQUIREMENTS', 'NEVER'], RESULT: ['Radio Button', '/api/v3/lookups/CUSTOM_LOOKUP_RESULTS'], COMMENTS: ['Paragraph'] }
};
const LOOKUPS = {
    CUSTOM_LOOKUP_GROUPS: ['Product Management', 'Engineering'], CUSTOM_LOOKUP_SOURCES: ['Marketing', 'Customer', 'Engineering'], CUSTOM_LOOKUP_TYPES: ['Functional', 'Safety', 'Top Level', 'Sub Level'],
    CUSTOM_LOOKUP_ASSESS: ['unknown', '1 / High', '2 / Med', '3 / Low'], CUSTOM_LOOKUP_VTYPES: ['Final', 'Initial'], CUSTOM_LOOKUP_YESNO: ['Yes', 'No'], CUSTOM_LOOKUP_RESULTS: ['Pending', 'Failed', 'Success', 'Conditional Success']
};
// the names the utility reads for the skill
Object.assign(LOOKUPS, { CUSTOM_LOOKUP_REQUIREMENTS_MANAGEMENT_GROUPS: LOOKUPS.CUSTOM_LOOKUP_GROUPS, CUSTOM_LOOKUP_REQUIREMENT_SOURCES: LOOKUPS.CUSTOM_LOOKUP_SOURCES, CUSTOM_LOOKUP_REQUIREMENT_TYPES: LOOKUPS.CUSTOM_LOOKUP_TYPES,
    CUSTOM_LOOKUP_REQUIREMENT_ASSESSMENT: LOOKUPS.CUSTOM_LOOKUP_ASSESS, CUSTOM_LOOKUP_REQUIREMENT_TEST_RESULT: LOOKUPS.CUSTOM_LOOKUP_RESULTS, CUSTOM_LOOKUP_TEST_TYPES: LOOKUPS.CUSTOM_LOOKUP_VTYPES });

function makeTenant(opts = {}) {
    const items = new Map(); const counters = {}; const calls = []; const acting = []; const targets = new Map(); const bom = new Map(); const rels = []; const affected = new Map();
    const link = (ws, id) => `/api/v3/workspaces/${ws}/items/${id}`;
    const create = (ws, f = {}) => {
        counters[ws] = (counters[ws] || 0) + 1;
        const id = ws * 1000 + counters[ws];
        const it = { ws, id, f: { ...f }, state: WORKFLOW[ws]?.[0][2] || 'Unreleased', rows: [], rowSeq: 1, descriptor: '', uploads: 0 };
        items.set(link(ws, id), it); return it;
    };
    const ref = (it) => ({ link: link(it.ws, it.id), title: it.descriptor });
    const descriptor = (it) => { if (it.ws === 143) it.descriptor = `${it.f.ID || '?'} - ${it.f.TITLE}`; else if (it.ws === 142) it.descriptor = `${it.f.ID} - ${it.f.TITLE}`; else if (it.ws === 144) it.descriptor = `RV-${it.id} - ${it.f.TITLE}`; else it.descriptor = it.f.TITLE || ''; };
    // template items
    const product = create(95, { TITLE: 'Bike', NPI_PROJECT: { link: '/api/v3/workspaces/86/items/1', title: 'P1' } }); product.descriptor = 'P-1 - Bike';
    const ebomRoot = create(57, { TITLE: 'BIKE-000' }); ebomRoot.descriptor = 'BIKE-000 - Bike';
    const hub = create(57, { TITLE: 'Hub' }); hub.descriptor = 'B-100 - Hub';
    const motor = create(57, { TITLE: 'Motor' }); motor.descriptor = 'B-200 - Motor';
    product.f.ENGINEERING_BOM = ref(ebomRoot);
    bom.set(link(57, ebomRoot.id), [hub, motor]);
    const spawn = {
        '144:Close': (it) => {
            if (!/Yes/.test(it.f.REPETITION_REQUIRED?.title || '')) return;
            if (opts.noRepetitionScript) return;
            const n = create(144, { ...it.f, TITLE: it.f.TITLE, IS_REPETITION: true, REPETITION_REQUIRED: undefined, NEXT_VALIDATION: undefined }); descriptor(n);
            for (const r of it.rows) n.rows.push({ rowId: n.rowSeq++, cells: { ...r.cells, PREVIOUS_RESULT: r.cells.RESULT?.title, RESULT: { title: 'Pending' }, COMMENTS: '' } });   // all steps are copied
            it.f.NEXT_VALIDATION = ref(n);
        },
        '145:Approve': (it) => release(it), '145:External Approval': (it) => release(it)
    };
    const release = (ra) => { for (const l of affected.get(link(ra.ws, ra.id)) || []) items.get(l).state = 'Released'; };
    const json = (b, status = 200, h = {}) => new Response(b === undefined ? null : JSON.stringify(b), { status, headers: h });
    const idOf = (l) => l.split('/').pop();
    const detail = (it) => ({ __self__: link(it.ws, it.id), title: it.descriptor, currentState: { title: it.state },
        sections: [{ fields: Object.entries(it.f).filter(([, v]) => v !== undefined).map(([k, v]) => ({ __self__: `${link(it.ws, it.id)}/views/1/fields/${k}`, value: v })) }] });
    const rowJson = (r) => ({ rowData: [{ title: 'Row Id', value: r.rowId }, ...Object.entries(r.cells).map(([k, v]) => ({ __self__: `x/views/13/fields/${k}`, title: k, value: v }))] });
    const setFields = (it, ws, sections) => {
        for (const s of sections) for (const f of s.fields) {
            const id = idOf(f.__self__);
            if (!FIELDS[ws][id]) throw Object.assign(new Error('unknown field ' + id), { status: 400 });
            if (FIELDS[ws][id][2] === 'NEVER' && id !== 'SPECIFICATION_ID') throw Object.assign(new Error('read only ' + id), { status: 400 });
            it.f[id] = f.value;
        }
        descriptor(it);
    };
    const gridCells = (rowData) => {
        const cells = {};
        for (const c of rowData) {
            const v = c.value;
            cells[idOf(c.__self__)] = v && typeof v === 'object' && v.link
                ? { link: v.link, title: items.get(v.link)?.descriptor || idOf(v.link) }
                : v;
        }
        return cells;
    };
    const nameOfOption = (p, link_) => (LOOKUPS[p.replace(/^.*\//, '')] || [])[Number(idOf(link_)) - 1];
    // lookups returned for results: store {title}
    const normResult = (cells) => { if (cells.RESULT?.link) cells.RESULT = { title: nameOfOption('CUSTOM_LOOKUP_RESULTS', cells.RESULT.link), link: cells.RESULT.link }; return cells; };
    const normOptions = (it) => { for (const k of ['REPETITION_REQUIRED']) if (it.f[k]?.link) it.f[k] = { link: it.f[k].link, title: nameOfOption('CUSTOM_LOOKUP_YESNO', it.f[k].link) }; };

    global.fetch = async (url, o = {}) => {
        const u = new URL(String(url)); const p = u.pathname; const m = o.method || 'GET';
        const body = o.body && typeof o.body === 'string' ? JSON.parse(o.body) : null;
        calls.push(`${m} ${p}`);
        const xuser = new Headers(o.headers).get('x-user-id');
        if (xuser && m !== 'GET') acting.push([m, p, xuser]);
        let g;
        if (m === 'GET' && p === '/api/v3/workspaces') return json({ items: Object.entries(WS).map(([id, title]) => ({ link: `/api/v3/workspaces/${id}`, title })) });
        if (m === 'GET' && p === '/api/v3/users/@me') return json({ userId: xuser || 'me@mock.com', displayName: 'Me Mock' });
        if (m === 'GET' && p === '/api/v3/users') return json({ users: [{ link: '/api/v3/users/me@mock.com', title: 'Me Mock' }, { link: '/api/v3/users/eric', title: 'Eric Edwards' }] });
        if ((g = p.match(/^\/api\/v3\/lookups\/(.+)$/)) && m === 'GET') {
            if (/ALL_USERS/.test(g[1])) return json({ items: [{ link: `${p}/options/1`, title: 'Me Mock' }, { link: `${p}/options/2`, title: 'Eric Edwards' }] });
            return json({ items: (LOOKUPS[g[1]] || []).map((t, i) => ({ link: `${p}/options/${i + 1}`, title: t })) });
        }
        if ((g = p.match(/^\/api\/v3\/workspaces\/(\d+)\/fields$/))) return json({ fields: Object.entries(FIELDS[g[1]]).map(([id, [type, pick, edit]]) => ({
            __self__: `/api/v3/workspaces/${g[1]}/views/1/fields/${id}`, name: id, type: { title: type }, picklist: pick ? (pick.startsWith('CUSTOM') ? `/api/v3/lookups/${pick}` : `/api/v3/lookups/CUSTOM_LOOKUP_${pick}`) : null, editability: edit || 'ALWAYS' })) });
        if ((g = p.match(/^\/api\/v3\/workspaces\/(\d+)\/sections$/))) return json([{ __self__: `/api/v3/workspaces/${g[1]}/sections/7`, name: 'S', fields: Object.keys(FIELDS[g[1]]).map((id) => ({ __self__: `/api/v3/workspaces/${g[1]}/views/1/fields/${id}` })) }]);
        if ((g = p.match(/^\/api\/v3\/workspaces\/(\d+)\/views\/13\/fields$/))) return json({ fields: Object.entries(GRID[g[1]] || {}).map(([id, [type, pick, edit]]) => ({ __self__: `x/${id}`, name: id, type: { title: type }, picklist: pick || null, editability: edit || 'ALWAYS' })) });
        if ((g = p.match(/^\/api\/v3\/workspaces\/(\d+)\/workflows\/1\/states$/))) return json({ states: [...new Set(WORKFLOW[g[1]].flatMap((t) => [t[1], t[2]]).filter(Boolean))].map((n, i) => ({ link: `/s/${i}`, name: n })) });
        if ((g = p.match(/^\/api\/v3\/workspaces\/(\d+)\/workflows\/1\/transitions$/))) return json(WORKFLOW[g[1]].map((t) => ({ name: t[0], __self__: `/t/${t[0]}`, fromState: t[1] ? { title: t[1] } : undefined, toState: { title: t[2] } })));
        if (m === 'GET' && (g = p.match(/^\/api\/v3\/workspaces\/(\d+)\/items$/))) return json({ items: [...items.values()].filter((i) => i.ws === Number(g[1])).map((i) => ({ __self__: link(i.ws, i.id), descriptor: i.descriptor })) });
        if (m === 'GET' && p === '/api/v3/search-results') return json({ items: [...items.values()].filter((i) => i.ws === 95).map((i) => ({ __self__: link(i.ws, i.id), descriptor: i.descriptor })) });
        if (m === 'POST' && (g = p.match(/^\/api\/v3\/workspaces\/(\d+)\/items$/))) {
            const ws = Number(g[1]);
            if (ws === 143) {   // derived field: the tenant wants the id of the related specification on create
                const f = body.sections.flatMap((x) => x.fields);
                const specRef = f.find((x) => idOf(x.__self__) === 'REQUIREMENT_SPECIFICATION')?.value?.link;
                const sid = f.find((x) => idOf(x.__self__) === 'SPECIFICATION_ID')?.value;
                if (specRef && items.get(specRef).f.ID !== sid) { calls.push('DERIVED-REJECT'); return json([{ code: 'error.derived.invalidDerivedFieldValue', arguments: [items.get(specRef).f.ID], field: { __self__: '/api/v3/workspaces/143/views/1/fields/SPECIFICATION_ID' } }], 400); }
            }
            const it = create(ws);
            try { setFields(it, ws, body.sections); } catch (e) { items.delete(link(it.ws, it.id)); return json({ message: e.message }, 400); }
            normOptions(it);
            if (ws === 142) {   // script: ID and Top Level Requirement
                it.f.ID = '0009'; descriptor(it);
                const top = create(143, { REQUIREMENT_SPECIFICATION: ref(it), TITLE: 'Top Level Requirement', ID: '0009.000', TYPE: { title: 'Top Level' } }); descriptor(top);
                it.f.TOP_LEVEL_REQUIREMENT = ref(top);
            }
            if (ws === 143 && !opts.noIdScript) { it.f.ID = `0009.${String(counters[143] - 1).padStart(3, '0')}`; descriptor(it); }
            return json({}, 201, { location: `https://mock.autodeskplm360.net${link(it.ws, it.id)}` });
        }
        if ((g = p.match(/^\/api\/v3\/workspaces\/(\d+)\/items\/(\d+)\/bom$/)) && m === 'GET') {
            const root = items.get(link(g[1], g[2])); const nodes = [{ item: { link: link(root.ws, root.id), urn: `u.${root.ws}.${root.id}`, title: root.descriptor } }]; const edges = [];
            for (const c of bom.get(link(root.ws, root.id)) || []) { nodes.push({ item: { link: link(c.ws, c.id), urn: `u.${c.ws}.${c.id}`, title: c.descriptor + ' [REV:w]' } }); edges.push({ parent: `u.${root.ws}.${root.id}`, child: `u.${c.ws}.${c.id}`, itemNumber: edges.length + 1 }); }
            return json({ nodes, edges });
        }
        if ((g = p.match(/^(\/api\/v3\/workspaces\/(\d+)\/items\/\d+)(\/.*)?$/))) {
            const it = items.get(g[1]); const rest = g[3] || '';
            if (!it) return json({ message: 'not found' }, 404);
            if (m === 'GET' && rest === '') return json(detail(it));
            if (m === 'PUT' && rest === '') { it.uploads++; return new Response(null, { status: 204 }); }
            if (m === 'PATCH' && rest === '') {
                if (g[2] === '95' && opts.productForbidden) return json({ message: 'denied EDIT_ITEMS' }, 403);
                try { setFields(it, g[2], body.sections); } catch (e) { return json({ message: e.message }, 400); }
                normOptions(it); return new Response(null, { status: 204 });
            }
            if (m === 'POST' && rest === '/bom-items') {
                const list = bom.get(g[1]) || []; list.push(items.get(body.item.link)); bom.set(g[1], list);
                items.get(body.item.link).parent = g[1];
                return json({}, 201, { location: `https://mock.autodeskplm360.net${g[1]}/bom-items/${list.length}` });
            }
            if (m === 'POST' && rest === '/views/10') { rels.push([g[1], new Headers(o.headers).get('content-location').split('/').pop(), body.direction.type]); return json({}, 201); }
            if (m === 'POST' && rest === '/affected-items') { affected.set(g[1], body); return json([{ result: 'SUCCESS' }]); }
            if (m === 'GET' && rest === '/views/11') return json({ affectedItems: (affected.get(g[1]) || []).map((l) => ({ __self__: `${g[1]}/views/11/affected-items/${idOf(l)}`, item: { link: l, title: items.get(l).descriptor }, targetTransition: targets.get(`${g[1]}|${l}`) ? { link: targets.get(`${g[1]}|${l}`) } : undefined, transitions: [{ id: 14, name: 'Release', __self__: '/api/v3/workflows/1/transitions/14' }] })) });
            if (m === 'PUT' && rest.startsWith('/views/11/affected-items/')) { const l = Object.keys(Object.fromEntries(items)).find((k) => k.endsWith('/' + idOf(rest))); targets.set(`${g[1]}|${l}`, body.targetTransition.link); return new Response(null, { status: 204 }); }
            if (m === 'GET' && rest === '/workflows/1/transitions') return json((WORKFLOW[g[2]] || []).filter((t) => t[1] === it.state).map((t) => ({ name: t[0], __self__: `/t/${t[0]}`, toState: { title: t[2] } })));
            if (m === 'POST' && rest === '/workflows/1/transitions') {
                const name = new Headers(o.headers).get('content-location').split('/').pop();
                const t = WORKFLOW[g[2]].find((x) => x[0] === name && x[1] === it.state);
                if (!t) return json({ message: 'bad transition' }, 400);
                if (g[2] === '145' && name === 'Submit for review' && (affected.get(g[1]) || []).some((l) => !targets.get(`${g[1]}|${l}`))) return json({ message: 'All managed items must have a Lifecycle option selected' }, 400);
                if (g[2] === '144' && name === 'Finish Execution' && it.rows.some((r) => r.cells.RESULT?.title === 'Pending')) return json({ message: 'Test result is not set for all steps' }, 400);
                it.state = t[2]; spawn[`${g[2]}:${name}`]?.(it);
                return json({}, 200);
            }
            if (rest.startsWith('/views/13/rows')) {
                if (m === 'GET') return json({ rows: it.rows.map(rowJson) });
                if (m === 'POST') { it.rows.push({ rowId: it.rowSeq++, cells: normResult(gridCells(body.rowData)) }); return json({}, 201); }
                if (m === 'PUT') { const r = it.rows.find((x) => String(x.rowId) === rest.split('/').pop()); r.cells = normResult(gridCells(body.rowData)); return new Response(null, { status: 204 }); }
            }
        }
        return json({ message: 'unmocked ' + m + ' ' + p }, 404);
    };
    return { items, calls, acting, bom, rels, affected, product, link, create };
}

/* ---------- story ---------- */

const node = (key, title, extra = {}, children) => ({ key, title, fields: { DESCRIPTION: `${title} description`, SOURCE: 'Engineering', TYPE: 'Functional', PRIORITY: '1 / High', LABOR_COST: 1000, ...extra.fields }, ...(extra.implementedBy ? { implementedBy: extra.implementedBy } : {}), ...(children ? { children } : {}) });
const story = (t, name) => ({
    name,
    vars: { product: t.link(95, t.product.id) },
    spec: { fields: { TITLE: 'Bike spec', DESCRIPTION: ['a', 'b'], GROUP_NAME: 'Engineering', INTERNAL_APPROVERS: ['@me'], FILENAME_1: 'f.pdf', FILE_DATE_1: '@today-5' }, topLevel: { DESCRIPTION: 'Root' }, decisions: [{ DATE: '@today', DECISION: 'Use hub motor', RATIONALE: 'Simple' }] },
    requirements: [
        node('drive', 'Drive', { fields: { TYPE: 'Sub Level' } }, [
            node('range', 'Range', { implementedBy: ['B-200'], fields: { TEST_PROCEDURE: 'Ride', EXPECTED_RESULT: 'Far', SUCCESS_CRITERIA: '60 km', IMAGE_1: { generate: { type: 'card', title: 'Range', lines: ['## x', 'y'] } } } }),
            node('power', 'Power', { implementedBy: ['B-100 - Hub', 'B-200'], fields: { DEPENDENT_REQUIREMENTS: ['range'], DEPENDENT_REQUIREMENTS_COMMENTS: 'needs range' } })
        ]),
        node('safety', 'Safety', { fields: { TYPE: 'Sub Level' } }, [
            node('brake', 'Braking', { fields: { TYPE: 'Safety' } }, [node('pads', 'Brake pads')])
        ]),
        node('misc', 'Miscellaneous', { fields: { TYPE: 'Sub Level' } }, [node('bell', 'Bell')])
    ],
    approvals: [
        { id: 'ra-drive', node: 'drive', fields: { TITLE: 'Release drive', CHANGE_REASON: 'Initial', INTERNAL_APPROVERS: ['@me'] }, comments: { approve: 'ok' } },
        { id: 'ra-safety', node: 'safety', external: true, fields: { TITLE: 'Release safety', EXTERNAL_APPROVERS: ['@me'] } }
    ],
    validations: [
        { key: 'v-range', title: 'Range test', fields: { TYPE: 'Final', ASSIGNEE_1: 'Eric Edwards', TARGET_DATE_1: '@today' }, executionFields: { TEST_RUN_IMAGE_1: { generate: { type: 'card', title: 'Run', lines: ['## r'] } } },
            steps: [{ requirement: 'range', RESULT: 'Failed', COMMENTS: 'only 40 km' }, { requirement: 'power', RESULT: 'Success' }],
            closing: { REPETITION_REQUIRED: 'Yes', REPETITION_DATE: '@today+10' },
            repeat: { end: 'Completed', steps: [{ requirement: 'range', RESULT: 'Success', COMMENTS: 'Fixed' }] } },
        { key: 'v-brake', title: 'Brake test', steps: [{ requirement: 'pads', RESULT: 'Success' }], end: 'Reporting' },
        { key: 'v-bell', title: 'Bell test', steps: [{ requirement: 'bell' }], end: 'Planning' }
    ]
});
const FAST = { pollMs: 1, specTimeoutMs: 300, idTimeoutMs: 20, spawnTimeoutMs: 100, transitionWaitMs: 300 };
const stateFile = (n) => path.join(__dirname, '..', 'work', `requirements-${n}-state.json`);
const cleanup = (n) => { try { fs.unlinkSync(stateFile(n)); } catch { /* none */ } };
test.after(() => { for (const n of ['req-dry', 'req-real', 'req-resume', 'req-noid', 'req-norep', 'req-403', 'req-minimal', 'req-imp']) { fs.rmSync(path.join(__dirname, '..', 'work', `requirements-${n}-images`), { recursive: true, force: true }); cleanup(n); } });
const byTitle = (t, ws, title) => [...t.items.values()].find((i) => i.ws === ws && i.f.TITLE === title);

/* ---------- tests ---------- */

test('story shape checks', () => {
    const t = makeTenant();
    const s = story(t, 'x');
    assert.deepEqual(rq.checkStoryShape(s), []);
    const bad = story(t, 'x');
    bad.requirements[0].children[0].children = [{ key: 'l4', title: 'l4', children: [{ key: 'l5', title: 'l5', children: [{ key: 'l6', title: 'l6' }] }] }];
    assert.match(rq.checkStoryShape(bad).join('\n'), /level 5/);
    const dup = story(t, 'x'); dup.requirements[1].key = 'drive';
    assert.match(rq.checkStoryShape(dup).join('\n'), /duplicate requirement key/);
    const flat = story(t, 'x'); flat.requirements.forEach((n) => delete n.children);
    assert.match(rq.checkStoryShape(flat).join('\n'), /at least 2 levels/);
    const ap = story(t, 'x'); ap.approvals[0].node = 'range';
    assert.match(rq.checkStoryShape(ap).join('\n'), /level 1/);
    const rep = story(t, 'x'); rep.validations[0].steps[0].RESULT = 'Success';
    assert.match(rq.checkStoryShape(rep).join('\n'), /at least one failed step/);
    const past = story(t, 'x'); delete past.validations[1].steps[0].RESULT;
    assert.match(rq.checkStoryShape(past).join('\n'), /needs a RESULT/);
});

test('approval route and external approvers must agree', () => {
    const t = makeTenant();
    const a = story(t, 'x'); a.approvals[0].fields.EXTERNAL_APPROVERS = ['@me'];
    assert.match(rq.checkStoryShape(a).join('\n'), /only allows the external route/);
    const b = story(t, 'x'); b.approvals[1].fields.EXTERNAL_APPROVERS = undefined;
    assert.match(rq.checkStoryShape(b).join('\n'), /needs EXTERNAL_APPROVERS/);
});

test('dry run validates everything and writes nothing', async () => {
    const t = makeTenant();
    const r = await rq.run(story(t, 'req-dry'), { dryRun: true });
    assert.deepEqual(r.errors, []);
    assert.equal(t.calls.filter((c) => /^(POST|PATCH|PUT)/.test(c)).length, 0);
    assert.ok(r.steps.some((s) => /ra-safety.*External Approval/.test(s.step)));
    assert.ok(r.steps.some((s) => /v-range#2/.test(s.step)));
    assert.ok(r.steps.some((s) => s.process === 'product'));
    assert.equal(r.coverage.requirementsTotal, 8);
    assert.ok(r.images.length >= 2);
});

test('dry run reports bad fields, picklists, EBOM items, users and workflow paths', async () => {
    const t = makeTenant();
    const s = story(t, 'req-dry');
    s.requirements[0].children[0].fields.NOPE = 1;
    s.requirements[0].children[0].fields.PRIORITY = '9 / Nope';
    s.requirements[0].children[1].implementedBy = ['X-1'];
    s.spec.fields.INTERNAL_APPROVERS = ['Nobody'];
    s.approvals[0].end = 'Nowhere';
    const r = await rq.run(s, { dryRun: true });
    const text = r.errors.join('\n');
    assert.match(text, /field NOPE does not exist/);
    assert.match(text, /"9 \/ Nope" is not an option/);
    assert.match(text, /"X-1" was not found in the engineering BOM/);
    assert.match(text, /"Nobody" is not an option of user field/);
    assert.match(text, /end must be one of Definition/);
});

test('dry run flags a transition that is impossible in the tenant workflow', async () => {
    const t = makeTenant();
    const saved = WORKFLOW[145].splice(3, 1);            // remove "Request External Review"
    try {
        const r = await rq.run(story(t, 'req-dry'), { dryRun: true });
        assert.match(r.errors.join('\n'), /"Request External Review" is not possible from state "Internal Review"/);
    } finally { WORKFLOW[145].splice(3, 0, ...saved); }
});

test('real run builds the structure, relationships, validations, approvals and the product link', async () => {
    const name = 'req-real'; cleanup(name);
    const t = makeTenant();
    const r = await rq.run(story(t, name), { dryRun: false, timing: FAST });
    assert.deepEqual(r.errors, [], JSON.stringify(r.errors));

    // specification, top level requirement and decisions
    const spec = [...t.items.values()].find((i) => i.ws === 142);
    assert.equal(spec.f.DESCRIPTION, '<ul><li>a</li><li>b</li></ul>', 'array text becomes a bullet list');
    const top = t.items.get(spec.f.TOP_LEVEL_REQUIREMENT.link);
    assert.equal(top.f.DESCRIPTION, '<p>Root</p>');

    // structure: top -> 3 level 1 nodes -> children
    const kids = (it) => (t.bom.get(t.link(it.ws, it.id)) || []).map((c) => c.f.TITLE);
    assert.deepEqual(kids(top), ['Drive', 'Safety', 'Miscellaneous']);
    assert.deepEqual(kids(byTitle(t, 143, 'Drive')), ['Range', 'Power']);
    assert.deepEqual(kids(byTitle(t, 143, 'Braking')), ['Brake pads']);
    assert.match(byTitle(t, 143, 'Drive').f.TYPE.link, /\/options\/4$/, 'container defaults to Sub Level');
    assert.equal(byTitle(t, 143, 'Range').uploads, 1, 'requirement image uploaded');
    assert.equal(t.calls.filter((c) => c === 'DERIVED-REJECT').length, 1, 'the derived SPECIFICATION_ID is learned once and reused');
    // references resolved to real links in the second pass
    assert.equal(byTitle(t, 143, 'Power').f.DEPENDENT_REQUIREMENTS[0].link, t.link(143, byTitle(t, 143, 'Range').id));

    // implemented by
    const hub = [...t.items.values()].find((i) => i.descriptor === 'B-100 - Hub'), motor = [...t.items.values()].find((i) => i.descriptor === 'B-200 - Motor');
    assert.equal(t.rels.length, 3);
    assert.ok(t.rels.some(([from, to, dir]) => from === t.link(143, byTitle(t, 143, 'Range').id) && to === String(motor.id) && dir === 'Bi-Directional'));
    assert.ok(t.rels.some(([, to]) => to === String(hub.id)));

    // validations: steps, results, states
    const v = (title) => byTitle(t, 144, title);
    assert.equal(v('Range test').state, 'Completed');
    assert.equal(v('Brake test').state, 'Reporting');
    assert.equal(v('Bell test').state, 'Planning');
    assert.equal(v('Range test').rows.length, 2);
    assert.equal(v('Range test').rows.find((x) => /Range/.test(x.cells.BASE_REQUIREMENT.title)).cells.RESULT.title, 'Failed');
    assert.equal(v('Range test').uploads, 1, 'test run image uploaded');
    // repetition for the failed requirement, spawned by the script, continues up to Execution
    const next = t.items.get(v('Range test').f.NEXT_VALIDATION.link);
    assert.equal(next.state, 'Completed', 'the repetition is finished: the passed step was carried over');
    assert.equal(next.rows.length, 2);
    assert.deepEqual(next.rows.map((x) => x.cells.RESULT.title).sort(), ['Success', 'Success']);
    assert.equal(next.f.IS_REPETITION, true);
    // the requirement points to its current validation
    assert.equal(byTitle(t, 143, 'Range').f.VALIDATION_PROCESS.link, t.link(144, next.id));
    assert.equal(byTitle(t, 143, 'Bell').f.VALIDATION_PROCESS.link, t.link(144, v('Bell test').id));

    // approvals: only the approved level 1 subtrees are released
    const state = (title) => byTitle(t, 143, title).state;
    for (const n of ['Drive', 'Range', 'Power', 'Safety', 'Braking', 'Brake pads']) assert.equal(state(n), 'Released', n);
    for (const n of ['Miscellaneous', 'Bell']) assert.equal(state(n), 'Unreleased', n);
    assert.equal(byTitle(t, 145, 'Release drive').state, 'Released');
    assert.equal(byTitle(t, 145, 'Release safety').state, 'Released');
    assert.equal([...t.affected.values()].map((a) => a.length).join(','), '3,3');

    // product link, always
    assert.equal(t.product.f.REQUIREMENTS.link, t.link(143, top.id));
    assert.ok(r.items.length >= 14);
    assert.equal(r.items.filter((i) => i.process === 'Requirement Approval').length, 2);

    // order: everything that edits requirements happens before the first release
    const firstApproval = t.calls.findIndex((c) => /workspaces\/145\/items$/.test(c));
    const lastReqWrite = t.calls.map((c, i) => [c, i]).filter(([c]) => /^(POST|PATCH) \/api\/v3\/workspaces\/143\/items/.test(c)).pop()[1];
    assert.ok(lastReqWrite < firstApproval, 'requirements are finished before approvals release them');
    cleanup(name);
});

test('a failed run resumes without duplicates', async () => {
    const name = 'req-resume'; cleanup(name);
    const t = makeTenant();
    const saved = WORKFLOW[145].splice(3, 1);            // "Request External Review" missing: the second approval fails in a real run
    const s = story(t, name);
    const first = await rq.run(s, { dryRun: false, timing: FAST });
    WORKFLOW[145].splice(3, 0, ...saved);
    assert.ok(!first.ok);
    assert.match(first.stoppedWith, /Request External Review/);
    assert.match(first.hint, /Nothing is rolled back/);
    const counts = () => ({ req: [...t.items.values()].filter((i) => i.ws === 143).length, val: [...t.items.values()].filter((i) => i.ws === 144).length, spec: [...t.items.values()].filter((i) => i.ws === 142).length });
    const before = counts();
    const second = await rq.run(story(t, name), { dryRun: false, timing: FAST });
    assert.deepEqual(second.errors, [], JSON.stringify(second.errors));
    assert.deepEqual(counts(), before, 'nothing created twice');
    assert.equal(byTitle(t, 145, 'Release safety').state, 'Released');
    assert.equal(t.product.f.REQUIREMENTS.link, t.link(143, t.items.get([...t.items.values()].find((i) => i.ws === 142).f.TOP_LEVEL_REQUIREMENT.link).id));
    cleanup(name);
});

test('numbers the requirements itself when no script does', async () => {
    const name = 'req-noid'; cleanup(name);
    const t = makeTenant({ noIdScript: true });
    const r = await rq.run(story(t, name), { dryRun: false, timing: FAST });
    assert.deepEqual(r.errors, [], JSON.stringify(r.errors));
    const ids = [...t.items.values()].filter((i) => i.ws === 143 && i.f.TITLE !== 'Top Level Requirement').map((i) => i.f.ID);
    assert.equal(new Set(ids).size, ids.length);
    assert.ok(ids.every((id) => /^0009\.\d{3}$/.test(id)));
    assert.ok(r.warnings.some((w) => /not generated by a script/.test(w)));
    cleanup(name);
});

test('creates the repeated validation itself when the workflow does not spawn it', async () => {
    const name = 'req-norep'; cleanup(name);
    const t = makeTenant({ noRepetitionScript: true });
    const r = await rq.run(story(t, name), { dryRun: false, timing: FAST });
    assert.deepEqual(r.errors, [], JSON.stringify(r.errors));
    assert.ok(r.warnings.some((w) => /did not spawn the repeated validation/.test(w)));
    const reps = [...t.items.values()].filter((i) => i.ws === 144 && i.f.IS_REPETITION === true);
    assert.equal(reps.length, 1);
    assert.equal(reps[0].rows.length, 1);
    cleanup(name);
});

test('explains a 403 on the product', async () => {
    const name = 'req-403'; cleanup(name);
    const t = makeTenant({ productForbidden: true });
    const r = await rq.run(story(t, name), { dryRun: false, timing: FAST });
    assert.ok(!r.ok);
    assert.match(r.stoppedWith, /Admin Override Workflow Locks/);
    cleanup(name);
});

test('impersonation: the stage assignee performs the validation steps', async () => {
    const name = 'req-imp'; cleanup(name);
    process.env.APS_SSA_CLIENT_ID = 'a'.repeat(30); process.env.APS_SSA_CLIENT_SECRET = 'secret';
    try {
        const t = makeTenant();
        const s = story(t, name); s.impersonation = true;
        const dry = await rq.run(s, { dryRun: true });
        assert.deepEqual(dry.errors, []);
        assert.deepEqual(dry.impersonation.actors, ['eric']);
        const r = await rq.run(s, { dryRun: false, timing: FAST });
        assert.deepEqual(r.errors, [], JSON.stringify(r.errors));
        const first = byTitle(t, 144, 'Range test');
        const posts = t.acting.filter(([m, p]) => m === 'POST' && p.includes(`/items/${first.id}/workflows/1/transitions`));
        assert.ok(posts.every((x) => x[2] === 'eric'));
        assert.ok(posts.length >= 1, 'the assignee performed transitions');
        assert.ok(t.acting.every(([, p]) => !p.startsWith('/api/v3/workspaces/145')), 'approvals run as the login user');
    } finally { delete process.env.APS_SSA_CLIENT_ID; delete process.env.APS_SSA_CLIENT_SECRET; cleanup(name); }
});

test('minimal story: no approvals, no validations, no implemented by', async () => {
    const name = 'req-minimal'; cleanup(name);
    const t = makeTenant();
    const s = story(t, name);
    delete s.approvals; delete s.validations; s.requirements.forEach((n) => { n.children.forEach((c) => delete c.implementedBy); });
    const r = await rq.run(s, { dryRun: false, timing: FAST });
    assert.deepEqual(r.errors, [], JSON.stringify(r.errors));
    assert.equal(t.rels.length, 0);
    assert.equal([...t.items.values()].filter((i) => i.ws === 144 || i.ws === 145).length, 0);
    const top = [...t.items.values()].find((i) => i.ws === 143 && i.f.TITLE === 'Top Level Requirement');
    assert.equal(t.product.f.REQUIREMENTS.link, t.link(143, top.id), 'the product is connected regardless');
    cleanup(name);
});

test('resolves a product and reads its engineering BOM for the skill', async () => {
    makeTenant();
    const c = await rq.context('Bike');
    assert.equal(c.ok, true);
    assert.equal(c.product.engineeringBom.title, 'BIKE-000 - Bike');
    assert.deepEqual(c.ebom.map((i) => i.descriptor), ['B-100 - Hub', 'B-200 - Motor']);
    assert.equal(c.me.email, 'me@mock.com');
    assert.deepEqual(c.picklists.groups, ['Product Management', 'Engineering']);
    const none = await rq.context('Spaceship');
    assert.equal(none.ok, false);
});
