// Generic read-only helpers for exploring the tenant (building blocks for future utilities)
const express = require('express');
const plm     = require('../lib/plm');
const ppm     = require('../lib/ppm');
const router  = express.Router();

router.get('/api/workspaces', async (req, res, next) => {
    try { res.json((await plm.listAll('/api/v3/workspaces')).map((w) => ({ id: plm.idOf(w.link), title: w.title || w.name }))); }
    catch (e) { next(e); }
});
router.get('/api/workspaces/:id', async (req, res, next) => {
    try { res.json(await ppm.describeWorkspace(req.params.id)); } catch (e) { next(e); }
});

module.exports = router;
