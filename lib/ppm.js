// PPM utility: Product Categories -> Product Lines -> Products
//  - discover(): find the three workspaces and propose a field mapping
//  - apply():    create missing records (idempotent, matched by name), link parents, upload images
const fs   = require('fs');
const path = require('path');
const plm  = require('./plm');

const WORK_DIR     = path.join(__dirname, '..', 'work');
const MAPPING_FILE = path.join(__dirname, '..', 'config', 'ppm-mapping.json');
const LEVELS       = ['categories', 'lines', 'products'];
const NAME_PATTERNS = { categories: /product\s*categor/i, lines: /product\s*line/i, products: /^products?$/i };
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/* ---------- discovery ---------- */

async function describeWorkspace(wsId) {
    const [fieldsRes, sectionsRes] = await Promise.all([
        plm.get(`/api/v3/workspaces/${wsId}/fields`),
        plm.get(`/api/v3/workspaces/${wsId}/sections`, { headers: { Accept: 'application/vnd.autodesk.plm.sections.bulk+json' } })
    ]);
    // The bulk sections endpoint returns a bare array (older shape: { sections: [...] }).
    // Section id is in __self__ (or link); matrix sections nest their fields in matrices[].fields[][].
    const sectionList = Array.isArray(sectionsRes) ? sectionsRes : (sectionsRes.sections || []);
    const sectionId = (s) => plm.idOf(s.__self__ || s.link);
    const sectionOfField = {};
    for (const s of sectionList) {
        const sectionFields = [
            ...(s.fields || []),
            ...(s.matrices || []).flatMap((m) => (m.fields || []).flat())
        ];
        for (const f of sectionFields) {
            if (!f || f.type === 'MATRIX') continue;   // matrices contain empty (null) cells
            const id = plm.idOf(f.__self__ || f.link || f.urn);
            if (id) sectionOfField[id] = { id: sectionId(s), name: s.name };
        }
    }
    // Custom fields report type as { link: '/api/v3/field-types/<n>' }: resolve it to a readable name.
    const typeCache = describeWorkspace.typeCache || (describeWorkspace.typeCache = {});
    const typeName = async (t) => {
        if (!t || typeof t === 'string') return t || '';
        if (t.title) return t.title;
        const tid = plm.idOf(t.link);
        if (!tid) return '';
        if (!(tid in typeCache)) {
            try { typeCache[tid] = String((await plm.get(`/api/v3/field-types/${tid}`)).nameKey || '').replace(/^data\.type\./, '').replace(/\./g, ' '); }
            catch { typeCache[tid] = ''; }
        }
        return typeCache[tid];
    };
    const fields = await Promise.all((fieldsRes.fields || []).map(async (f) => {
        const id = plm.idOf(f.__self__ || f.link) || String(f.urn || '').split('.').pop();
        return {
            id, name: f.name, type: await typeName(f.type),
            picklist: f.picklist || f.lookup || null,
            section: sectionOfField[id] || null,
            editable: f.editability ? f.editability !== 'NEVER' : true
        };
    }));
    return { fields, sections: sectionList.map((s) => ({ id: sectionId(s), name: s.name })) };
}

function proposeMapping(level, fields) {
    const find = (re) => fields.find((f) => re.test(f.id) || re.test(f.name || ''));
    const m = {
        titleField       : (find(/^(TITLE|NAME)$/i) || find(/\b(title|name)\b/i) || {}).id,
        descriptionField : (find(/^DESCRIPTION$/i) || find(/description/i) || {}).id,
        imageField       : (fields.find((f) => /image/i.test(f.type)) || find(/image|picture|thumbnail/i) || {}).id
    };
    if (level === 'lines')    m.parentField = (find(/categor/i) || {}).id;
    if (level === 'products') m.parentField = (fields.find((f) => /line/i.test(f.id + f.name) && !/categor/i.test(f.id + f.name)) || {}).id;
    return m;
}

async function discover() {
    const all = await plm.listAll('/api/v3/workspaces');
    const result = { workspaces: {}, mapping: loadMapping() };
    for (const level of LEVELS) {
        const candidates = all.filter((w) => NAME_PATTERNS[level].test(w.title || w.name || ''));
        const ws = candidates[0];
        if (!ws) { result.workspaces[level] = { found: false }; continue; }
        const wsId = plm.idOf(ws.link);
        const d = await describeWorkspace(wsId);
        result.workspaces[level] = {
            found: true, id: wsId, title: ws.title || ws.name,
            otherCandidates: candidates.slice(1).map((w) => ({ id: plm.idOf(w.link), title: w.title || w.name })),
            fields: d.fields, proposedMapping: { workspaceId: wsId, ...proposeMapping(level, d.fields) }
        };
    }
    return result;
}

function loadMapping() {
    try { return JSON.parse(fs.readFileSync(MAPPING_FILE, 'utf8')); } catch { return null; }
}
function saveMapping(mapping) {
    fs.writeFileSync(MAPPING_FILE, JSON.stringify(mapping, null, 2) + '\n');
}

/* ---------- images ---------- */

async function loadImage(ref) {
    if (!ref) return null;
    if (/^https?:\/\//i.test(ref)) {
        const res = await fetch(ref, { headers: { 'User-Agent': 'Mozilla/5.0 plm-assistant', Accept: 'image/*' }, redirect: 'follow' });
        if (!res.ok) throw new Error(`image download failed (${res.status})`);
        const type = (res.headers.get('content-type') || '').split(';')[0].trim();
        if (!type.startsWith('image/')) throw new Error(`not an image (${type || 'unknown type'})`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > MAX_IMAGE_BYTES) throw new Error('image larger than 10 MB');
        return { buf, type, name: path.basename(new URL(ref).pathname) || 'image' };
    }
    const full = path.resolve(WORK_DIR, ref);                     // local files must live inside work/
    if (!full.startsWith(WORK_DIR + path.sep)) throw new Error('local images must be inside the work/ folder');
    const buf  = fs.readFileSync(full);
    const ext  = path.extname(full).slice(1).toLowerCase().replace('jpg', 'jpeg');
    return { buf, type: `image/${ext || 'png'}`, name: path.basename(full) };
}
const WEAK_TYPES = ['image/svg+xml', 'image/webp', 'image/avif', 'image/gif'];

async function uploadImage(itemPath, imageFieldId, img) {
    const detail = await plm.get(itemPath);
    const fd = new FormData();
    fd.append(imageFieldId, new Blob([img.buf], { type: 'application/octet-stream' }), img.name);
    fd.append('itemDetail', new Blob([JSON.stringify(detail)], { type: 'application/json' }), 'blob');
    await plm.request('PUT', itemPath, { body: fd });
}

/* ---------- records ---------- */

function formatValue(field, value) {
    const t = (field?.type || '').toLowerCase();
    if (value === '' || value == null) return null;
    if (/integer/.test(t))                 return parseInt(value, 10);
    if (/float|money|number|decimal/.test(t)) return Number(value);
    if (/check/.test(t))                   return value === true || /^(true|yes|1)$/i.test(String(value));
    if (/single|radio|picklist|linking/.test(t) && typeof value === 'string' && value.startsWith('/api/')) return { link: value };
    return value;
}

function buildSections(wsId, m, fieldDefs, values) {
    const bySection = new Map();
    for (const [fieldId, raw] of Object.entries(values)) {
        const def = fieldDefs[fieldId];
        if (!def) throw new Error(`Field ${fieldId} does not exist in workspace ${wsId}`);
        if (!def.section) throw new Error(`Field ${fieldId} has no section - cannot write it`);
        const link = `/api/v3/workspaces/${wsId}/sections/${def.section.id}`;
        if (!bySection.has(link)) bySection.set(link, { link, fields: [] });
        bySection.get(link).fields.push({ __self__: `/api/v3/workspaces/${wsId}/views/1/fields/${fieldId}`, value: formatValue(def, raw) });
    }
    return [...bySection.values()];
}

async function existingByName(wsId) {
    const items = await plm.listAll(`/api/v3/workspaces/${wsId}/items`);
    const map = new Map();
    for (const it of items) {
        const link = it.link || it.__self__;
        const name = it.title || it.descriptor || it.itemDescriptor;
        if (!name || !link) continue;
        const full = String(name).trim().toLowerCase();
        map.set(full, link);
        // descriptors look like "PL-039 - Trinity": also match on the bare title
        const bare = full.replace(/^[a-z0-9_]+-\d+\s+-\s+/, '');
        if (bare !== full && !map.has(bare)) map.set(bare, link);
    }
    return map;
}

const REC_LEVELS = { categories: { parent: null }, lines: { parent: 'category' }, products: { parent: 'line' } };

/**
 * plan = { categories:[{name,description,image,fields}], lines:[{name,category,...}], products:[{name,line,...}] }
 * mapping = { categories|lines|products: { workspaceId, titleField, descriptionField, imageField, parentField } }
 */
async function apply(plan, mapping, { dryRun = true } = {}) {
    const report = { dryRun, created: [], existing: [], warnings: [], errors: [] };
    const links  = {};
    const defs   = {};
    const categoryOfParent = new Map();

    for (const level of LEVELS) {
        const m = mapping?.[level];
        if (!m?.workspaceId || !m.titleField) throw new Error(`Mapping for "${level}" needs workspaceId and titleField`);
        if ((plan[level] || []).length && REC_LEVELS[level].parent && !m.parentField) throw new Error(`Mapping for "${level}" needs parentField`);
        const d = await describeWorkspace(m.workspaceId);
        defs[level]  = Object.fromEntries(d.fields.map((f) => [f.id, f]));
        links[level] = await existingByName(m.workspaceId);
    }

    for (const level of LEVELS) {
        const m = mapping[level];
        const parentKey = REC_LEVELS[level].parent;
        const parentLevel = { category: 'categories', line: 'lines' }[parentKey];

        for (const rec of plan[level] || []) {
            const key = String(rec.name || '').trim().toLowerCase();
            if (!key) { report.errors.push({ level, error: 'record without name' }); continue; }
            if (links[level].has(key)) { report.existing.push({ level, name: rec.name, link: links[level].get(key) }); continue; }

            try {
                const values = { ...(rec.fields || {}), [m.titleField]: rec.name };
                if (m.descriptionField && rec.description) values[m.descriptionField] = rec.description;
                if (parentLevel) {
                    const pName = String(rec[parentKey] || '').trim().toLowerCase();
                    const pLink = links[parentLevel].get(pName);
                    if (!pLink) throw new Error(`parent ${parentKey} "${rec[parentKey]}" not found in plan or tenant`);
                    values[m.parentField] = pLink;
                    // Some tenants derive a grand-parent field (Products.PRODUCT_CATEGORY) from the parent and
                    // reject the record unless it matches: copy it from the parent line.
                    if (m.categoryField && !dryRun) {
                        const lm = mapping[parentLevel];
                        if (!categoryOfParent.has(pLink)) {
                            const parent = await plm.get(pLink);
                            const fld = (parent.sections || []).flatMap((s) => s.fields || []).find((f) => String(f.__self__).endsWith('/fields/' + lm.parentField));
                            categoryOfParent.set(pLink, fld?.value?.link || null);
                        }
                        if (categoryOfParent.get(pLink)) values[m.categoryField] = categoryOfParent.get(pLink);
                    } else if (m.categoryField && dryRun) values[m.categoryField] = '/api/v3/dry-run';
                }

                let img = null;
                if (rec.image && m.imageField) {
                    try {
                        img = await loadImage(rec.image);
                        if (WEAK_TYPES.includes(img.type)) report.warnings.push(`${rec.name}: ${img.type} may be rejected by Fusion Manage - prefer PNG/JPEG`);
                    } catch (e) { report.warnings.push(`${rec.name}: image skipped - ${e.message}`); }
                } else if (rec.image && !m.imageField) report.warnings.push(`${rec.name}: no imageField mapped for ${level}`);

                const sections = buildSections(m.workspaceId, m, defs[level], values);   // validates fields, also in dry run
                if (dryRun) {
                    links[level].set(key, `(dry-run) new ${level}: ${rec.name}`);
                    report.created.push({ level, name: rec.name, image: Boolean(img), dryRun: true });
                    continue;
                }

                const res = await plm.request('POST', `/api/v3/workspaces/${m.workspaceId}/items`,
                    { body: { sections } });
                const loc = res.headers.get('location') || '';
                const itemPath = loc.slice(loc.indexOf('/api/v3/'));
                links[level].set(key, itemPath);
                const entry = { level, name: rec.name, link: itemPath, image: false };
                if (img) {
                    try { await uploadImage(itemPath, m.imageField, img); entry.image = true; }
                    catch (e) { report.warnings.push(`${rec.name}: created, but image upload failed - ${e.message}`); }
                }
                report.created.push(entry);
            } catch (e) {
                report.errors.push({ level, name: rec.name, error: e.message });
            }
        }
    }
    return report;
}

module.exports = { discover, describeWorkspace, apply, loadMapping, saveMapping, loadImage, uploadImage, WORK_DIR };
