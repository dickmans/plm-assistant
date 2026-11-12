const fs      = require('fs');
const path    = require('path');
const express = require('express');
const rq      = require('../lib/requirements');
const ppm     = require('../lib/ppm');
const router  = express.Router();

// Resolve a product (dmsId, number or name) and return what the skill needs to write a story:
// product details (project, engineering BOM, current requirements), the BOM items, users and the picklists of the requirements workspaces.
router.get('/api/requirements/context', async (req, res, next) => {
    try {
        if (!req.query.ref) return res.status(400).json({ error: 'ref (product dmsId, number or name) is required' });
        res.json(await rq.context(req.query.ref));
    } catch (e) { next(e); }
});

// body: { story? | storyFile?, dryRun?, reset? }
//   story     - the story JSON itself, or
//   storyFile - name of a file inside work/ (for example "bike-requirements.json")
// dryRun defaults to TRUE: validates fields, picklists, links, EBOM items and workflow transitions, writes nothing.
// A real run (dryRun:false) first repeats the validation and refuses to write when it finds errors.
router.post('/api/requirements/run', async (req, res, next) => {
    try {
        const { storyFile, dryRun, reset } = req.body || {};
        let story = req.body?.story;
        if (!story && storyFile) {
            const full = path.resolve(ppm.WORK_DIR, storyFile);
            if (!full.startsWith(ppm.WORK_DIR + path.sep)) return res.status(400).json({ error: 'storyFile must be inside work/' });
            story = JSON.parse(fs.readFileSync(full, 'utf8'));
        }
        if (!story) return res.status(400).json({ error: 'story or storyFile is required' });
        if (dryRun !== false) return res.json(await rq.run(story, { dryRun: true }));
        const check = await rq.run(story, { dryRun: true });
        if (!check.ok) return res.status(422).json({ error: 'Validation failed, nothing was written', ...check });
        res.json(await rq.run(story, { dryRun: false, reset: reset === true }));
    } catch (e) { next(e); }
});

module.exports = router;
