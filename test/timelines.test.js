const test   = require('node:test');
const assert = require('node:assert');
process.env.PLM_TENANT = 'mock'; process.env.APS_CLIENT_ID = 'x'.repeat(30);
require.cache[require.resolve('../lib/auth')] = { exports: { getAccessToken: async () => 'tok' }, loaded: true, id: require.resolve('../lib/auth') };
const tl = require('../lib/timelines');

const patches = [];
const F = (id, type = 'Date') => ({ __self__: `/api/v3/workspaces/5/views/1/fields/${id}`, name: id, type: { title: type }, editability: 'NEVER' });
const fv = (id, value) => ({ __self__: `/api/v3/workspaces/5/items/1/views/1/fields/${id}`, value });
const item = (state, vals) => ({ currentState: { title: state }, sections: [{ link: '/api/v3/workspaces/5/items/1/views/1/sections/9', fields: Object.entries(vals).map(([k, v]) => fv(k, v)) }] });

// Change Orders (standalone): one task already done (2024-03-04), one pending target date (2024-03-18)
global.fetch = async (url, opts = {}) => {
    const u = String(url), m = opts.method || 'GET';
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status });
    if (/\/workspaces\?/.test(u)) return json({ items: [{ link: '/api/v3/workspaces/5', title: 'Change Orders' }] });
    if (/workspaces\/5\/fields/.test(u)) return json({ fields: [F('START_DATE'), F('TARGET_DATE'), F('TITLE', 'Single Line Text')] });
    if (/workspaces\/5\/items\?/.test(u)) return json({ items: [{ __self__: '/api/v3/workspaces/5/items/1', descriptor: 'CO-1' }] });
    if (m === 'GET' && /items\/1$/.test(u)) return json(item('Perform Change', { START_DATE: '2024-03-04', TARGET_DATE: '2024-03-18', TITLE: 'x' }));
    if (m === 'PATCH') { patches.push(JSON.parse(opts.body)); return new Response(null, { status: 204 }); }
    return json({}, 404);
};

test('shiftFor moves by whole weeks and keeps the weekday', () => {
    const today = tl.toDay('2026-11-11');                 // Wednesday
    const anchor = tl.toDay('2024-03-18');                // Monday
    const shift = tl.shiftFor(anchor, today, 'this');
    assert.equal(shift % 7, 0);
    assert.equal(tl.fromDay(anchor + shift), '2026-11-09');   // Monday of the current week
    assert.equal(tl.fromDay(anchor + tl.shiftFor(anchor, today, 'previous')), '2026-11-02');
});
test('shiftFor leaves current and future anchors alone', () => {
    const today = tl.toDay('2026-11-11');
    assert.equal(tl.shiftFor(tl.toDay('2026-11-03'), today), 0);     // previous week
    assert.equal(tl.shiftFor(tl.toDay('2027-02-01'), today), 0);     // future
});
test('dry run plans one shared shift and writes nothing', async () => {
    const r = await tl.run({ dryRun: true, only: ['changeOrders'], today: '2026-11-11' });
    assert.equal(patches.length, 0);
    assert.equal(r.updated.length, 1);
    assert.equal(r.updated[0].anchor.field, 'TARGET_DATE');             // earliest pending date
    assert.equal(r.updated[0].anchor.to, '2026-11-09');
    const d = r.updated[0].changes[0].dates;
    assert.equal(tl.toDay(d[1].to) - tl.toDay(d[0].to), 14);            // duration unchanged
});
test('real run patches every date by the same amount', async () => {
    const r = await tl.run({ dryRun: false, only: ['changeOrders'], today: '2026-11-11' });
    assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
    assert.equal(patches.length, 1);
    const vals = Object.fromEntries(patches[0].sections[0].fields.map((f) => [f.__self__.split('/').pop(), f.value]));
    assert.deepEqual(vals, { START_DATE: '2026-10-26', TARGET_DATE: '2026-11-09' });
});
test('shift is capped so completed dates never land after today', () => {
    const today = tl.toDay('2026-11-11');
    const rec = (title, state, dates) => ({ title, state, link: '/x/' + title, workspaceId: 1, dates: dates.map(([field, value]) => ({ field, value, section: '1', editability: 'NEVER' })) });
    const plan = tl.planTimeline('P', [rec('done', 'Completed', [['ACTUAL_COMPLETION_DATE', '2024-06-14']]),
                                       rec('open', 'Assigned', [['TARGET_COMPLETION_DATE', '2024-06-10']])], today, 'this');
    assert.equal(plan.shiftDays % 7, 0);
    assert.ok(tl.toDay('2024-06-14') + plan.shiftDays <= today);
    assert.equal(plan.limited, true);
});
