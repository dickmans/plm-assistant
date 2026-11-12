const test   = require('node:test');
const assert = require('node:assert');
process.env.PLM_TENANT = 'mock'; process.env.APS_CLIENT_ID = 'x'.repeat(30);
require.cache[require.resolve('../lib/auth')] = { exports: { getAccessToken: async () => 'tok' }, loaded: true, id: require.resolve('../lib/auth') };
const ppm = require('../lib/ppm');

const created = []; const puts = [];
const fields = { fields: [
    { __self__: '/api/v3/workspaces/1/views/1/fields/TITLE', name: 'Title', type: { title: 'Single Line Text' } },
    { __self__: '/api/v3/workspaces/1/views/1/fields/DESCRIPTION', name: 'Description', type: { title: 'Paragraph' } },
    { __self__: '/api/v3/workspaces/1/views/1/fields/IMAGE', name: 'Image', type: { title: 'Image' } },
    { __self__: '/api/v3/workspaces/1/views/1/fields/PARENT', name: 'Product Category', type: { title: 'Single Selection' } } ] };
const sections = { sections: [{ link: '/api/v3/workspaces/1/sections/9', name: 'Basic', fields: fields.fields.map((f) => ({ __self__: f.__self__ })) }] };

global.fetch = async (url, opts = {}) => {
    const u = String(url), m = opts.method || 'GET';
    const json = (b, status = 200, h = {}) => new Response(JSON.stringify(b), { status, headers: h });
    if (u.includes('/fields')) return json(fields);
    if (u.includes('/sections')) return json(sections);
    if (m === 'GET' && /\/items\?/.test(u)) return json({ items: [{ link: '/api/v3/workspaces/1/items/5', title: 'Existing' }] });
    if (m === 'POST') { created.push(JSON.parse(opts.body)); return json({}, 201, { location: `https://mock.autodeskplm360.net/api/v3/workspaces/1/items/${100 + created.length}` }); }
    if (m === 'PUT') { puts.push(opts.body); return new Response(null, { status: 204 }); }
    if (u.startsWith('https://img.test/')) return new Response(Buffer.from('png'), { headers: { 'content-type': 'image/png' } });
    if (/\/items\/\d+$/.test(u)) return json({ title: 'x' });
    return json({}, 404);
};
const one = { workspaceId: 1, titleField: 'TITLE', descriptionField: 'DESCRIPTION', imageField: 'IMAGE', parentField: 'PARENT' };
const mapping = { categories: one, lines: one, products: one };
const plan = { categories: [{ name: 'Existing' }, { name: 'New cat', description: 'd', image: 'https://img.test/a.png' }], lines: [], products: [] };

test('dry run writes nothing, skips existing', async () => {
    const r = await ppm.apply(plan, mapping, { dryRun: true });
    assert.equal(created.length, 0);
    assert.equal(r.existing.length, 1);
    assert.equal(r.errors.length, 0);
});
test('real run creates, links and uploads image', async () => {
    const r = await ppm.apply({ ...plan, lines: [{ name: 'L1', category: 'New cat' }] }, mapping, { dryRun: false });
    assert.equal(r.errors.length, 0, JSON.stringify(r.errors));
    assert.ok(created[0].sections[0].fields.find((f) => f.__self__.endsWith('/TITLE')).value === 'New cat');
    assert.equal(puts.length, 1);
    const line = created[1].sections[0].fields.find((f) => f.__self__.endsWith('/PARENT'));
    assert.deepEqual(line.value, { link: '/api/v3/workspaces/1/items/101' });
});
