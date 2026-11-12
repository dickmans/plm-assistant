const express = require('express');
const tl      = require('../lib/timelines');
const router  = express.Router();

// body: { dryRun?, only?, week? }  dryRun defaults to TRUE - writing requires an explicit dryRun:false
// only: list of group keys; week: 'this' (default) or 'previous' = where the earliest pending date lands
router.post('/api/timelines/run', async (req, res, next) => {
    try { const { dryRun, only, week, today } = req.body || {}; res.json(await tl.run({ dryRun: dryRun !== false, only, week, today })); }
    catch (e) { next(e); }
});
// Write test with unchanged values (dryRun defaults to TRUE: only lists the candidates)
router.post('/api/timelines/probe', async (req, res, next) => {
    try { const { dryRun, only } = req.body || {}; res.json(await tl.probe({ dryRun: dryRun !== false, only })); }
    catch (e) { next(e); }
});

module.exports = router;
