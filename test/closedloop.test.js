const test   = require('node:test');
const assert = require('node:assert');
const fs     = require('fs');
const path   = require('path');
process.env.PLM_TENANT = 'mock'; process.env.APS_CLIENT_ID = 'x'.repeat(30);
require.cache[require.resolve('../lib/auth')] = { exports: { getAccessToken: async () => 'tok' }, loaded: true, id: require.resolve('../lib/auth') };
const cl = require('../lib/closedloop');

/* ---------- a tiny in-memory Fusion Manage with the real workflow scripts of the quality/change template ---------- */

const WS = { 57: 'Items', 99: 'Quality Inspection Plans', 101: 'Quality Inspections', 98: 'Non Conformances', 100: 'Corrective / Preventative Actions',
    83: 'Change Requests', 84: 'Change Orders', 80: 'Change Tasks', 81: 'Change Approval Templates', 95: 'Products', 14: 'Suppliers' };
const PREFIX = { 99: 'QIP', 101: 'QI', 98: 'NC', 100: 'CAPA', 83: 'CR', 84: 'CO' };
const T = (w) => w.trim().split('\n').map((l) => l.split('|').map((x) => x.trim()));
const WORKFLOW = {
    99 : T(`New||Definition
            Approve for Use|Definition|In Use`),
    101: T(`New||Open
            Close|Open|Closed`),
    98 : T(`New||Identification In Progress
            Submit For Review|Identification In Progress|Under Review
            Approve for Disposition|Under Review|Disposition In Progress
            Initiate CAPA|Disposition In Progress|CAPA In Progress`),
    100: T(`New||Originated
            Submit|Originated|Definition
            Proceed to Measurement|Definition|Measurement
            Proceed to Analysis|Measurement|Analysis
            Proceed to Improvement|Analysis|Improvement
            Proceed to Control|Improvement|Control`),
    83 : T(`Start||Create
            Submit for review|Create|Review & Impact Analysis
            Initiate Tasks|Review & Impact Analysis|Perform Tasks
            Submit to CCB|Review & Impact Analysis|Change Control Board Review
            Approve|Change Control Board Review|Change Control Board Review`),
    84 : T(`Start||Preparation
            Initiate Tasks|Preparation|Perform Change`),
    80 : T(`Start||Planned
            Assign Task|Planned|Assigned
            Acknowledge|Assigned|In Work
            Complete Task|In Work|Completed`)
};
const FIELDS = {   // id: [type, picklist]
    99 : { TITLE: ['Single Line Text'], INSPECTION_TYPE: ['Single Selection', 'L_TYPES'], INSPECTED_ITEM: ['Single Selection', 'CUSTOM_LOOKUP_WS_ITEMS'], LOT_SIZE: ['Integer'], NOTES: ['Paragraph'], IMAGE_1: ['Image'] },
    101: { RELATED_QIP: ['Single Selection', 'CUSTOM_LOOKUP_WS_QIP'], DEADLINE: ['Date'], PERFORMED_BY: ['Radio Button', 'L_PERFORMED'], MAXIMUM_FAILURES: ['Integer'], SPAWNED_NON_CONFORMANCE: ['Single Selection', 'CUSTOM_LOOKUP_WS_NC', 'NEVER'] },
    98 : { SEVERITY: ['Radio Button', 'L_SEVERITY'], DESCRIPTION: ['Paragraph'], INITIATE_CAPA: ['Single Selection', 'L_YESNO'], RELATED_CAPA: ['Single Selection', 'CUSTOM_LOOKUP_WS_CAPA', 'NEVER'], CREATED_BY: ['Single Selection', 'CUSTOM_LOOKUP_ALL_USERS_VIEW', 'NEVER'] },
    100: { TITLE: ['Single Line Text'], TEAM: ['Multiple Selection', 'CUSTOM_LOOKUP_ALL_USERS_VIEW'], CREATE_CHANGE_REQUEST: ['Single Selection', 'L_YESNO'], RELATED_CR: ['Single Selection', 'CUSTOM_LOOKUP_WS_CR', 'NEVER'] },
    83 : { TITLE: ['Single Line Text'], DESCRIPTION: ['Paragraph'], CHANGE_TEMPLATE: ['Single Selection', 'CUSTOM_LOOKUP_WS_TEMPLATES'], CHANGE_ORDER: ['Single Selection', 'CUSTOM_LOOKUP_WS_CO', 'NEVER'], COST_1: ['Money'] },
    84 : { TITLE: ['Single Line Text'], DESCRIPTION: ['Paragraph'] },
    80 : { ASSIGNEE: ['Single Selection', 'CUSTOM_LOOKUP_ALL_USERS_VIEW'], COMPLETION_REMARKS: ['Paragraph'], NEW_STATUS_UPDATE: ['Paragraph'] },
    57 : {}, 81: {}, 95: {}, 14: {}
};
const LOOKUPS = {
    CUSTOM_LOOKUP_L_TYPES: ['Final Inspection', 'Incoming Materials'], CUSTOM_LOOKUP_L_PERFORMED: ['Internal QA', 'Vendor QA'],
    CUSTOM_LOOKUP_L_SEVERITY: ['Level 2', 'Level 3', 'Level 1'], CUSTOM_LOOKUP_L_YESNO: ['Yes', 'No'], CUSTOM_LOOKUP_MEASUREMENT_DEVICE: ['Caliper', 'CMM'], CUSTOM_LOOKUP_L_PRIO: ['3 / Low', '1 / High', '2 / Medium']
};
const GRID = { 99: { ID: ['Single Line Text'], REFERENCE: ['Single Line Text'], MEASUREMENT_DEVICE: ['Radio Button', '/api/v3/lookups/CUSTOM_LOOKUP_MEASUREMENT_DEVICE'], NOMINAL: ['Float'], LOWER_TOLERANCE: ['Float'], UPPER_TOLERANCE: ['Float'] },
    101: { ID: ['Single Line Text'], REFERENCE: ['Single Line Text'], NOMINAL: ['Float'], LOWER_TOLERANCE: ['Float'], UPPER_TOLERANCE: ['Float'], ACTUAL: ['Float'], COMMENTS: ['Single Line Text'], RESULT: ['Single Line Text', null, 'NEVER'] } };
GRID[83] = GRID[84] = { ID: ['Single Line Text'], DEPENDS_ON: ['Single Line Text'], TITLE: ['Single Line Text'], DESCRIPTION: ['Paragraph'], PRIORITY: ['Single Selection', '/api/v3/lookups/CUSTOM_LOOKUP_L_PRIO'], ASSIGNEE: ['Single Selection', '/api/v3/lookups/CUSTOM_LOOKUP_ALL_USERS_VIEW'], ITEMS_TO_CHANGE: ['Multiple Selection', '/api/v3/lookups/CUSTOM_LOOKUP_WS_ITEMS'], TARGET_START_DATE: ['Date'], TARGET_EFFORT: ['Integer'], TASK: ['Single Selection', '/api/v3/lookups/CUSTOM_LOOKUP_WS_TASKS', 'NEVER'] };

function makeTenant() {
    const items = new Map(); const counters = {}; const calls = [];
    const link = (ws, id) => `/api/v3/workspaces/${ws}/items/${id}`;
    const create = (ws, f = {}) => {
        counters[ws] = (counters[ws] || 0) + 1;
        const id = ws * 1000 + counters[ws];
        const it = { ws, id, f: { ...f }, state: WORKFLOW[ws]?.[0][2] || 'x', rows: [], rowSeq: 1, descriptor: '' };
        if (PREFIX[ws]) it.f.NUMBER = `${PREFIX[ws]}-${String(counters[ws]).padStart(6, '0')}`;
        items.set(link(ws, id), it); return it;
    };
    const ref = (it) => ({ link: link(it.ws, it.id), title: it.f.NUMBER || it.f.TITLE });
    // template item with 1 CR task and 4 CO tasks
    const tpl = create(81, { NAME: 'Mechanical Change Template' });
    tpl.descriptor = 'Mechanical Change Template';
    for (const [p, title] of [['Change Request', 'Identify & assess impact'], ['Change Order', 'Update Mechanical Design'], ['Change Order', 'Update EBOM'], ['Change Order', 'Share updated design'], ['Change Order', 'Update MBOM']]) {
        tpl.rows.push({ rowId: tpl.rowSeq++, cells: { PROCESS: p, TITLE: title } });
    }
    const component = create(57, { NUMBER: '9411-012', TITLE: 'Fan Assembly' }); component.descriptor = '9411-012 - Fan Assembly';
    const seedGrid = (it, kind) => { for (const r of tpl.rows.filter((x) => x.cells.PROCESS === kind)) it.rows.push({ rowId: it.rowSeq++, cells: { TITLE: r.cells.TITLE } }); };
    const spawnTasks = (parent) => {
        parent.rows.forEach((r, i) => { const t = create(80, { TITLE: r.cells.TITLE }); t.state = 'Assigned'; t.parent = parent; t.descriptor = `${parent.f.NUMBER} - ${r.cells.ID || (i + 1) * 50} - ${r.cells.TITLE}`; r.cells.TASK = 'x'; });
    };
    const spawn = { // script behaviour keyed by `${ws}:${transition}`
        '101:Close': (it) => {
            const fails = it.rows.filter((r) => r.cells.RESULT === 'FAIL').length;
            it.f.RESULT = fails > 0 ? 'FAIL' : 'PASS';
            if (fails > it.f.MAXIMUM_FAILURES) { const nc = create(98, { NONCONFORMING_ITEM: it.f.INSPECTED_ITEM }); it.f.SPAWNED_NON_CONFORMANCE = ref(nc); nc.f.SPAWNED_BY = ref(it); }
        },
        '98:Initiate CAPA': (it) => { const c = create(100, { TITLE: 'CAPA for ' + it.f.NUMBER }); it.f.RELATED_CAPA = ref(c); c.f.SPAWNED_BY_NCR = ref(it); },
        '100:Proceed to Control': (it) => { if (it.f.CREATE_CHANGE_REQUEST?.link?.endsWith('/1')) { const c = create(83, { TITLE: it.f.TITLE }); seedGrid(c, 'Change Request'); it.f.RELATED_CR = ref(c); } },
        '83:Initiate Tasks': (it) => spawnTasks(it),
        '83:Approve': (it) => { const co = create(84, { TITLE: it.f.TITLE }); seedGrid(co, 'Change Order'); it.f.CHANGE_ORDER = ref(co); co.parentCr = it; it.state = 'Change Order in progress'; },
        '84:Initiate Tasks': (it) => spawnTasks(it),
        '80:Complete Task': (it) => {
            const sibs = [...items.values()].filter((t) => t.ws === 80 && t.parent === it.parent);
            if (it.parent.ws === 83 && sibs.every((t) => t.state === 'Completed' || t === it)) it.parent.state = 'Review & Impact Analysis';
            if (it.parent.ws === 84) { const next = sibs.find((t) => t.state === 'Planned'); if (next) next.state = 'Assigned'; }
        }
    };
    const json = (b, status = 200, h = {}) => new Response(b === undefined ? null : JSON.stringify(b), { status, headers: h });
    const detail = (it) => ({ __self__: link(it.ws, it.id), title: it.descriptor || it.f.NUMBER, currentState: { title: it.state },
        sections: [{ fields: Object.entries(it.f).map(([k, v]) => ({ __self__: `${link(it.ws, it.id)}/views/1/fields/${k}`, value: v })) }] });
    const rowJson = (r) => ({ rowData: [{ title: 'Row Id', value: r.rowId }, ...Object.entries(r.cells).map(([k, v]) => ({ __self__: `x/views/13/fields/${k}`, title: k, value: v }))] });
    const setFields = (it, ws, sections) => {
        for (const s of sections) for (const f of s.fields) {
            const id = plm_id(f.__self__);
            if (FIELDS[ws][id]?.[2] === 'NEVER') throw Object.assign(new Error('read only'), { status: 400 });
            it.f[id] = f.value;
        }
    };
    const plm_id = (l) => l.split('/').pop();
    const applyGrid = (it, ws, rowData) => {
        const cells = {};
        for (const c of rowData) cells[plm_id(c.__self__)] = c.value && typeof c.value === 'object' && c.value.link ? { title: c.value.link.split('/').pop(), link: c.value.link } : c.value;
        return cells;
    };
    const judge = (r) => {
        const { NOMINAL: n, LOWER_TOLERANCE: lo, UPPER_TOLERANCE: hi, ACTUAL: a } = r.cells;
        if (a !== undefined) r.cells.RESULT = a >= n - lo && a <= n + hi ? 'PASS' : 'FAIL';
    };

    const seedQi = (it) => {
        const qip = items.get(it.f.RELATED_QIP.link);
        it.f.MAXIMUM_FAILURES = 0;
        for (const r of qip.rows) it.rows.push({ rowId: it.rowSeq++, cells: { ...r.cells } });
    };
    global.fetch = async (url, opts = {}) => {
        const u = new URL(String(url)); const p = u.pathname; const m = opts.method || 'GET';
        const body = opts.body && typeof opts.body === 'string' ? JSON.parse(opts.body) : null;
        calls.push(`${m} ${p}`);
        let g;
        if (m === 'GET' && p === '/api/v3/workspaces') return json({ items: Object.entries(WS).map(([id, title]) => ({ link: `/api/v3/workspaces/${id}`, title })) });
        if (m === 'GET' && p === '/api/v3/users/@me') return json({ userId: 'me@mock.com', displayName: 'Me Mock' });
        if (m === 'GET' && p === '/api/v3/users') return json({ users: [{ link: '/api/v3/users/me@mock.com', title: 'Me Mock' }] });
        if ((g = p.match(/^\/api\/v3\/lookups\/(.+)$/)) && m === 'GET') return json({ items: (LOOKUPS[g[1]] || []).map((t, i) => ({ link: `${p}/options/${i + 1}`, title: t })) });
        if ((g = p.match(/^\/api\/v3\/workspaces\/(\d+)\/fields$/))) return json({ fields: Object.entries(FIELDS[g[1]]).map(([id, [type, pick, edit]]) => ({
            __self__: `/api/v3/workspaces/${g[1]}/views/1/fields/${id}`, name: id, type: { title: type }, picklist: pick ? (pick.startsWith('/') || pick.startsWith('CUSTOM') ? pick.replace(/^(?!\/)/, '/api/v3/lookups/') : `/api/v3/lookups/CUSTOM_LOOKUP_${pick}`) : null, editability: edit || 'ALWAYS' })) });
        if ((g = p.match(/^\/api\/v3\/workspaces\/(\d+)\/sections$/))) return json([{ __self__: `/api/v3/workspaces/${g[1]}/sections/7`, name: 'S', fields: Object.keys(FIELDS[g[1]]).map((id) => ({ __self__: `/api/v3/workspaces/${g[1]}/views/1/fields/${id}` })) }]);
        if ((g = p.match(/^\/api\/v3\/workspaces\/(\d+)\/views\/13\/fields$/))) return json({ fields: Object.entries(GRID[g[1]] || {}).map(([id, [type, pick, edit]]) => ({ __self__: `x/${id}`, name: id, type: { title: type }, picklist: pick || null, editability: edit || 'ALWAYS' })) });
        if ((g = p.match(/^\/api\/v3\/workspaces\/(\d+)\/workflows\/1\/states$/))) return json({ states: [...new Set(WORKFLOW[g[1]].flatMap((t) => [t[1], t[2]]).filter(Boolean))].map((n, i) => ({ link: `/s/${i}`, name: n })) });
        if ((g = p.match(/^\/api\/v3\/workspaces\/(\d+)\/workflows\/1\/transitions$/))) return json(WORKFLOW[g[1]].map((t) => ({ name: t[0], __self__: `/t/${t[0]}`, fromState: t[1] ? { title: t[1] } : undefined, toState: { title: t[2] } })));
        if (m === 'GET' && (g = p.match(/^\/api\/v3\/workspaces\/(\d+)\/items$/))) return json({ items: [...items.values()].filter((i) => i.ws === Number(g[1])).map((i) => ({ __self__: link(i.ws, i.id), descriptor: i.descriptor || i.f.NUMBER })) });
        if (m === 'POST' && (g = p.match(/^\/api\/v3\/workspaces\/(\d+)\/items$/))) {
            const it = create(Number(g[1])); setFields(it, g[1], body.sections); if (g[1] === '101') seedQi(it);
            return json({}, 201, { location: `https://mock.autodeskplm360.net${link(it.ws, it.id)}` });
        }
        if ((g = p.match(/^(\/api\/v3\/workspaces\/(\d+)\/items\/\d+)(\/.*)?$/))) {
            const it = items.get(g[1]); const rest = g[3] || '';
            if (!it) return json({ message: 'not found' }, 404);
            if (m === 'GET' && rest === '') return json(detail(it));
            if (m === 'PUT' && rest === '') { it.uploads = (it.uploads || 0) + 1; return new Response(null, { status: 204 }); }
            if (m === 'PATCH' && rest === '') { try { setFields(it, g[2], body.sections); } catch (e) { return json({ message: e.message }, 400); } return new Response(null, { status: 204 }); }
            if (m === 'GET' && rest === '/workflows/1/transitions') return json(WORKFLOW[g[2]].filter((t) => t[1] === it.state).map((t) => ({ name: t[0], __self__: `/t/${t[0]}`, toState: { title: t[2] } })));
            if (m === 'POST' && rest === '/workflows/1/transitions') {
                const name = new Headers(opts.headers).get('content-location').split('/').pop();
                const t = WORKFLOW[g[2]].find((x) => x[0] === name && x[1] === it.state);
                if (!t) return json({ message: 'bad transition' }, 400);
                it.state = t[2]; spawn[`${g[2]}:${name}`]?.(it);
                return json({}, 200);
            }
            if (rest.startsWith('/views/13/rows')) {
                if (m === 'GET') return json({ rows: it.rows.map(rowJson) });
                if (m === 'POST') { it.rows.push({ rowId: it.rowSeq++, cells: applyGrid(it, g[2], body.rowData) }); return json({}, 201); }
                if (m === 'DELETE') { it.rows = it.rows.filter((x) => String(x.rowId) !== rest.split('/').pop()); return new Response(null, { status: 204 }); }
                if (m === 'PUT') { const r = it.rows.find((x) => String(x.rowId) === rest.split('/').pop()); Object.assign(r.cells, applyGrid(it, g[2], body.rowData)); judge(r); return new Response(null, { status: 204 }); }
            }
        }
        return json({ message: 'unmocked ' + m + ' ' + p }, 404);
    };
    return { items, calls, component, tpl, link, create };
}

/* ---------- story ---------- */

const story = (tenant, name) => ({
    name,
    vars: { engineer: '@me', planner: '@me', component: tenant.link(57, tenant.component.id), template: tenant.link(81, tenant.tpl.id), product: '/api/v3/workspaces/95/items/1', supplier: '/api/v3/workspaces/14/items/1' },
    qip: {
        create: { TITLE: 'Final inspection', INSPECTION_TYPE: 'Final Inspection', INSPECTED_ITEM: '$component', LOT_SIZE: 10, NOTES: ['one', 'two'], IMAGE_1: { generate: { type: 'card', title: 'Sampling plan', lines: ['## Lot of 10', 'Accept 0 failures'] } } },
        grid: [
            { ID: '101', REFERENCE: 'Bore', MEASUREMENT_DEVICE: 'Caliper', NOMINAL: 25, LOWER_TOLERANCE: 0, UPPER_TOLERANCE: 0.02 },
            { ID: '102', REFERENCE: 'Hole position', MEASUREMENT_DEVICE: 'CMM', NOMINAL: 100, LOWER_TOLERANCE: 0.5, UPPER_TOLERANCE: 0.5 }
        ],
        stages: [{ id: 'approve-plan', transition: 'Approve for Use', comment: 'ok' }]
    },
    qi: {
        create: { RELATED_QIP: '$qip', DEADLINE: '@today-14', PERFORMED_BY: 'Internal QA' },
        results: { 101: { ACTUAL: 25.06, COMMENTS: 'oversize' }, 102: { ACTUAL: 101.4 } },
        stages: [{ id: 'close-inspection', transition: 'Close', comment: 'fail' }]
    },
    nc: { stages: [
        { fields: { SEVERITY: 'Level 1', DESCRIPTION: 'Bore oversize' }, transition: 'Submit For Review' },
        { transition: 'Approve for Disposition' },
        { id: 'initiate-capa', fields: { INITIATE_CAPA: 'Yes' }, transition: 'Initiate CAPA' }
    ] },
    capa: { stages: [
        { fields: { TITLE: 'Fix bore', TEAM: ['@me'] }, transition: 'Submit' }, { transition: 'Proceed to Measurement' }, { transition: 'Proceed to Analysis' }, { transition: 'Proceed to Improvement' },
        { fields: { CREATE_CHANGE_REQUEST: 'Yes' }, transition: 'Proceed to Control' }
    ] },
    cr: {
        taskPlan: [{ ID: '10', TITLE: 'Root cause analysis with engineering', PRIORITY: '1 / High', ASSIGNEE: '$engineer', TARGET_START_DATE: '@today', TARGET_EFFORT: 12 }],
        tasks: [{ match: 'Root cause', fields: { ASSIGNEE: '$engineer', COMPLETION_REMARKS: 'done' }, transitions: [{ name: 'Acknowledge' }, { name: 'Complete Task', comment: 'RCA done' }] }],
        stages: [
            { id: 'submit-cr', fields: { CHANGE_TEMPLATE: '$template', DESCRIPTION: 'Change the hub' }, transition: 'Submit for review' },
            { id: 'initiate-cr-tasks', taskPlan: true, transition: 'Initiate Tasks', runTasks: true, await: { state: 'Review & Impact Analysis' } },
            { fields: { COST_1: 18000 }, transition: 'Submit to CCB' },
            { id: 'ccb-approve', transition: 'Approve', await: { state: 'Change Order in progress' } }
        ]
    },
    co: {
        taskPlan: [
            { ID: '10', TITLE: 'Update the hub design', ASSIGNEE: '$engineer', ITEMS_TO_CHANGE: ['$component'], TARGET_EFFORT: 40 },
            { ID: '20', DEPENDS_ON: '10', TITLE: 'Update the MBOM and routing', ASSIGNEE: '$planner', TARGET_EFFORT: 12 },
            { ID: '30', DEPENDS_ON: '20', TITLE: 'Schedule the production cutover', ASSIGNEE: '$planner' }
        ],
        tasks: [
            { match: 'Update the hub design', transitions: [{ name: 'Acknowledge' }, { name: 'Complete Task' }] },
            { match: 'MBOM', fields: { ASSIGNEE: '$planner' } }
        ],
        stages: [{ id: 'initiate-co-tasks', fields: { DESCRIPTION: 'Implement' }, taskPlan: true, transition: 'Initiate Tasks', runTasks: true, await: { state: 'Perform Change' } }]
    }
});
const FAST = { pollMs: 1, spawnTimeoutMs: 300, stateTimeoutMs: 300, transitionWaitMs: 300, taskTimeoutMs: 300 };
const stateFile = (n) => path.join(__dirname, '..', 'work', `closedloop-${n}-state.json`);
const cleanup = (n) => { try { fs.unlinkSync(stateFile(n)); } catch { /* none */ } };
test.after(() => { for (const n of ['dry-test', 'dry-bad', 'real-test', 'resume-test', 'nospawn-test', 'stop-test', 'stop-co-test']) fs.rmSync(path.join(__dirname, '..', 'work', `closedloop-${n}-images`), { recursive: true, force: true }); });

/* ---------- tests ---------- */

test('date tokens and rich text', () => {
    assert.match(cl.dateValue('@today'), /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(cl.dateValue('2026-1-5'), '2026-01-05');
    assert.throws(() => cl.dateValue('soon'));
    assert.equal(cl.richText(['a', 'b']), '<ul><li>a</li><li>b</li></ul>');
    assert.equal(cl.richText('x & y\nz'), '<p>x &amp; y</p><p>z</p>');
});

test('dry run validates the whole chain and writes nothing', async () => {
    const t = makeTenant();
    const r = await cl.run(story(t, 'dry-test'), { dryRun: true });
    assert.deepEqual(r.errors, []);
    assert.equal(t.calls.filter((c) => /^(POST|PATCH|PUT)/.test(c)).length, 0, 'no writes in a dry run');
    assert.ok(r.steps.some((s) => s.step.includes('2 out-of-tolerance')));
    assert.ok(r.steps.some((s) => s.process === 'co' && s.step.includes('drive 2 change task')));
    assert.ok(r.steps.some((s) => s.process === 'co' && /replace the template tasks by 3/.test(s.step)));
    assert.ok(r.images.some((i) => i.field === 'IMAGE_1' && i.type === 'card'), 'image preview rendered');
});

test('dry run reports unknown fields, bad picklist values, bad transitions and a passing inspection', async () => {
    const t = makeTenant();
    const s = story(t, 'dry-bad');
    s.nc.stages[0].fields.NOPE = 'x';
    s.nc.stages[0].fields.SEVERITY = 'Level 9';
    s.capa.stages[1].transition = 'Proceed to Control';
    s.cr.tasks[0].match = 'does not exist';
    s.co.taskPlan[1].DEPENDS_ON = '99';
    s.qi.results = { 101: { ACTUAL: 25 }, 102: { ACTUAL: 100 } };
    const r = await cl.run(s, { dryRun: true });
    const text = r.errors.join('\n');
    assert.match(text, /field NOPE does not exist/);
    assert.match(text, /"Level 9" is not an option/);
    assert.match(text, /"Proceed to Control" is not possible from state "Definition"/);
    assert.match(text, /matches no task of the task plan/);
    assert.match(text, /depends on "99"/);
    assert.ok(r.warnings.some((w) => /will not spawn a Non Conformance/.test(w)));
});

test('real run executes the chain, ends with CO pending and one completed task', async () => {
    const name = 'real-test'; cleanup(name);
    const t = makeTenant();
    const r = await cl.run(story(t, name), { dryRun: false, timing: FAST });
    assert.deepEqual(r.errors, [], JSON.stringify(r.errors));
    const byProc = Object.fromEntries(r.items.map((i) => [i.process, i]));
    assert.equal(byProc['Quality Inspection Plan'].state, 'In Use');
    assert.equal(byProc['Quality Inspection'].state, 'Closed');
    assert.equal(byProc['Non Conformance'].state, 'CAPA In Progress');
    assert.equal(byProc['CAPA'].state, 'Control');
    assert.equal(byProc['Change Request'].state, 'Change Order in progress');
    assert.equal(byProc['Change Order'].state, 'Perform Change');

    const tasks = [...t.items.values()].filter((i) => i.ws === 80);
    const cr = [...t.items.values()].find((i) => i.ws === 83);
    const co = [...t.items.values()].find((i) => i.ws === 84);
    assert.equal(tasks.filter((x) => x.parent === cr && x.state === 'Completed').length, 1, 'CR has its completed analysis task');
    const coTasks = tasks.filter((x) => x.parent === co);
    assert.equal(coTasks.length, 3, 'tasks come from the story plan, not the template');
    assert.deepEqual(coTasks.map((x) => x.f.TITLE).sort(), ['Schedule the production cutover', 'Update the MBOM and routing', 'Update the hub design']);
    assert.equal(tasks.filter((x) => x.parent === cr).length, 1, 'CR template task replaced by the story task');
    assert.equal(coTasks.filter((x) => x.state === 'Completed').length, 1, 'only one CO task completed');
    assert.ok(coTasks.some((x) => x.state === 'Assigned'), 'others still pending');

    // content made it through
    const nc = [...t.items.values()].find((i) => i.ws === 98);
    assert.equal(nc.f.DESCRIPTION, '<p>Bore oversize</p>');
    assert.equal(nc.f.SEVERITY.link.split('/').pop(), '3');          // "Level 1" is the third option
    const qip = [...t.items.values()].find((i) => i.ws === 99);
    assert.equal(qip.rows.length, 2);
    assert.equal(qip.f.NOTES, '<ul><li>one</li><li>two</li></ul>');
    assert.deepEqual(co.f.DESCRIPTION, '<p>Implement</p>');
    assert.equal(qip.uploads, 1, 'generated image uploaded');
    assert.ok(r.images.length >= 1);
    assert.ok(fs.existsSync(stateFile(name)));
    cleanup(name);
});

test('a failed run can be resumed without creating duplicates', async () => {
    const name = 'resume-test'; cleanup(name);
    const t = makeTenant();
    const s = story(t, name);
    s.capa.stages[1].transition = 'Proceed to Control';                 // impossible from "Definition"
    const first = await cl.run(s, { dryRun: false, timing: FAST });
    assert.ok(!first.ok);
    assert.match(first.stoppedWith, /not available/);
    assert.match(first.hint, /Nothing is rolled back/);
    const created = [...t.items.values()].filter((i) => PREFIX[i.ws]).length;

    const fixed = story(t, name);                                        // correct story, same name -> resume
    const second = await cl.run(fixed, { dryRun: false, timing: FAST });
    assert.deepEqual(second.errors, [], JSON.stringify(second.errors));
    assert.equal([...t.items.values()].filter((i) => i.ws === 99).length, 1, 'QIP not created twice');
    assert.equal([...t.items.values()].filter((i) => i.ws === 101).length, 1, 'QI not created twice');
    assert.ok([...t.items.values()].filter((i) => PREFIX[i.ws]).length > created);
    cleanup(name);
});

test('refuses to close an inspection that would not spawn a Non Conformance', async () => {
    const name = 'nospawn-test'; cleanup(name);
    const t = makeTenant();
    const s = story(t, name);
    s.qi.results = { 101: { ACTUAL: 25 }, 102: { ACTUAL: 100 } };
    const r = await cl.run(s, { dryRun: false, timing: FAST });
    assert.match(r.stoppedWith, /would not spawn a Non Conformance/);
    assert.equal([...t.items.values()].filter((i) => i.ws === 98).length, 0);
    cleanup(name);
});

test('image renderer produces valid PNGs for every type', () => {
    const si = require('../lib/storyimages');
    const rows = [{ label: 'Bore', nominal: 25, lo: 0, hi: 0.02, actual: 25.06, unit: 'mm' }, { label: 'Height', nominal: 95, lo: 0.05, hi: 0.05, actual: 95, unit: 'mm' }];
    const specs = [
        { type: 'measurement-chart', title: 'Result', source: 'inspection' },
        { type: 'trend-chart', title: 'Trend', points: [1, 1.1, 1.3, 1.6], usl: 1.5, lsl: 0.9 },
        { type: 'bar-chart', title: 'Cost', bars: [{ label: 'A', value: 10 }, { label: 'B', value: 20 }] },
        { type: 'comparison', title: 'Compare', rows: [{ label: 'Tol', before: 0.1, after: 0.02, unit: 'mm' }] },
        { type: 'callout', title: 'Callout', callouts: [{ x: 0.5, y: 0.5, label: 'Here' }] },
        { type: 'card', title: 'Card \u00b1 \u00d8', lines: ['## Head', 'Line one'] },
        { type: 'closed-loop', highlight: 'nc' }
    ];
    for (const spec of specs) {
        const png = si.render(spec, { rows, photo: null, records: { nc: { number: 'NC-1', state: 'Open' } } });
        const d = si.decodePng(png);
        assert.ok(d && d.w === 1280 && d.h === 720, spec.type);
    }
    assert.throws(() => si.render({ type: 'nope' }), /unknown image type/);
    assert.throws(() => si.render({ type: 'trend-chart', points: [1] }), /at least 3 points/);
});

test('stopBefore prepares the stage and stops; the next run continues without duplicates', async () => {
    const name = 'stop-test'; cleanup(name);
    const t = makeTenant();
    const bad = await cl.run(story(t, name), { dryRun: true, stopBefore: 'nope' });
    assert.match(bad.errors.join(), /not a stage id/);

    const dry = await cl.run(story(t, name), { dryRun: true, stopBefore: 'close-inspection' });
    assert.ok(dry.stopped && dry.next.stage === 'close-inspection');

    const first = await cl.run(story(t, name), { dryRun: false, timing: FAST, stopBefore: 'close-inspection' });
    assert.ok(first.ok && first.stopped, JSON.stringify(first.errors));
    assert.equal(first.next.transition, 'Close');
    assert.match(first.next.record, /^QI-/);
    const qi = [...t.items.values()].find((i) => i.ws === 101);
    assert.equal(qi.state, 'Open');
    assert.equal([...t.items.values()].filter((i) => i.ws === 98).length, 0, 'no NC yet');

    const second = await cl.run(story(t, name), { dryRun: false, timing: FAST });
    assert.deepEqual(second.errors, [], JSON.stringify(second.errors));
    assert.equal(qi.state, 'Closed');
    assert.equal([...t.items.values()].filter((i) => i.ws === 101).length, 1);
    assert.equal([...t.items.values()].find((i) => i.ws === 84).state, 'Perform Change');
    cleanup(name);
});

test('stopBefore the CO task start leaves the customised task plan in the grid and no tasks', async () => {
    const name = 'stop-co-test'; cleanup(name);
    const t = makeTenant();
    const r = await cl.run(story(t, name), { dryRun: false, timing: FAST, stopBefore: 'initiate-co-tasks' });
    assert.ok(r.ok && r.stopped, JSON.stringify(r.errors));
    const co = [...t.items.values()].find((i) => i.ws === 84);
    assert.equal(co.state, 'Preparation');
    assert.deepEqual(co.rows.map((x) => x.cells.TITLE.replace(/<.*?>/g, '')), ['Update the hub design', 'Update the MBOM and routing', 'Schedule the production cutover']);
    assert.equal([...t.items.values()].filter((i) => i.ws === 80 && i.parent === co).length, 0);
    cleanup(name);
});
