const express = require('express');
const fe      = require('../lib/fillempty');
const router  = express.Router();

// body: { dryRun?, only? }   dryRun defaults to TRUE - writing requires an explicit dryRun:false
// only: optional list of rule keys (changeTemplates, products, projectTemplates)
router.post('/api/fill-empty/run', async (req, res, next) => {
    try {
        const { dryRun, only } = req.body || {};
        res.json(await fe.run({ dryRun: dryRun !== false, only }));
    } catch (e) { next(e); }
});

module.exports = router;
