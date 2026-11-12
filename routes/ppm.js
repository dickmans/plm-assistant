const express = require('express');
const ppm     = require('../lib/ppm');
const router  = express.Router();

router.get('/api/ppm/discover', async (req, res, next) => {
    try { res.json(await ppm.discover()); } catch (e) { next(e); }
});
router.get('/api/ppm/mapping', (req, res) => res.json(ppm.loadMapping() || {}));
router.put('/api/ppm/mapping', (req, res) => { ppm.saveMapping(req.body); res.json({ ok: true }); });

// body: { plan, mapping?, dryRun? }   dryRun defaults to TRUE - writing requires an explicit dryRun:false
router.post('/api/ppm/apply', async (req, res, next) => {
    try {
        const { plan, mapping, dryRun } = req.body || {};
        if (!plan) return res.status(400).json({ error: 'plan is required' });
        const m = mapping || ppm.loadMapping();
        if (!m) return res.status(400).json({ error: 'no mapping - run /api/ppm/discover and save one' });
        res.json(await ppm.apply(plan, m, { dryRun: dryRun !== false }));
    } catch (e) { next(e); }
});

module.exports = router;
