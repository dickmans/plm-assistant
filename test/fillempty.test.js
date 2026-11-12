const test   = require('node:test');
const assert = require('node:assert');
process.env.PLM_TENANT = 'mock'; process.env.APS_CLIENT_ID = 'x'.repeat(30);
require.cache[require.resolve('../lib/auth')] = { exports: { getAccessToken: async () => 'tok' }, loaded: true, id: require.resolve('../lib/auth') };
const fe = require('../lib/fillempty');

const patches = [];
const F = (id, type, picklist) => ({ __self__: `/api/v3/workspaces/81/views/1/fields/${id}`, name: id, type: { title: type }, picklist, editability: 'ALWAYS' });
const fields = { fields: [F('CR_COORDINATOR', 'Single Selection', '/api/v3/lookups/CUSTOM_LOOKUP_ALL_USERS_VIEW'),
                          F('CO_COORDINATOR', 'Single Selection', '/api/v3/lookups/CUSTOM_LOOKUP_ALL_USERS_VIEW'),
                          F('OTHER', 'Single Selection', '/api/v3/lookups/SOMETHING')] };
const sections = [{ link: '/api/v3/workspaces/81/sections/7', name: 'Change Requests', fields: fields.fields.map((f) => ({ __self__: f.__self__ })) }];
const detail = (cr, co) => ({ sections: [{ link: '/api/v3/workspaces/81/items/1/views/1/sections/7', fields: [
    { __self__: '/api/v3/workspaces/81/items/1/views/1/fields/CR_COORDINATOR', value: cr },
    { __self__: '/api/v3/workspaces/81/items/1/views/1/fields/CO_COORDINATOR', value: co },
    { __self__: '/api/v3/workspaces/81/items/1/views/1/fields/OTHER', value: null }] }] });

global.fetch = async (url, opts = {}) => {
    const u = String(url), m = opts.method || 'GET';
    const json = (b, status = 200) => new Response(JSON.stringify(b), { status });
    if (u.endsWith('/users/@me')) return json({ userId: 'me@x.com', displayName: 'Jane Doe' });
    if (/\/workspaces\?/.test(u)) return json({ items: [{ link: '/api/v3/workspaces/81', title: 'Change Approval Templates' }] });
    if (u.includes('/lookups/CUSTOM_LOOKUP_ALL_USERS_VIEW')) return json({ items: [{ link: '/api/v3/lookups/CUSTOM_LOOKUP_ALL_USERS_VIEW/options/1', title: 'Other, Person' }, { link: '/api/v3/lookups/CUSTOM_LOOKUP_ALL_USERS_VIEW/options/107', title: 'Doe, Jane' }] });
    if (/workspaces\/81\/fields/.test(u)) return json(fields);
    if (/workspaces\/81\/sections/.test(u)) return json(sections);
    if (/workspaces\/81\/items\?/.test(u)) return json({ items: [{ __self__: '/api/v3/workspaces/81/items/1', descriptor: 'T1' }] });
    if (m === 'GET' && /items\/1$/.test(u)) return json(detail(null, { link: '/api/v3/users/someone' }));
    if (m === 'PATCH') { patches.push(JSON.parse(opts.body)); return new Response(null, { status: 204 }); }
    return json({}, 404);
};

test('dry run reports the empty field and writes nothing', async () => {
    const r = await fe.run({ dryRun: true, only: ['changeTemplates'] });
    assert.equal(patches.length, 0);
    assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
    assert.deepEqual(r.filled[0].fields, ['CR_COORDINATOR']);
    assert.equal(r.skipped, 1);
});
test('real run fills only the empty field with my lookup option', async () => {
    const r = await fe.run({ dryRun: false, only: ['changeTemplates'] });
    assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
    assert.equal(patches.length, 1);
    const f = patches[0].sections[0].fields;
    assert.equal(f.length, 1);
    assert.ok(f[0].__self__.endsWith('/CR_COORDINATOR'));
    assert.deepEqual(f[0].value, { link: '/api/v3/lookups/CUSTOM_LOOKUP_ALL_USERS_VIEW/options/107' });
});
test('name matching ignores order and punctuation', () => {
    assert.equal(fe.nameKey('Doe, Jane'), fe.nameKey('Jane Doe'));
});
