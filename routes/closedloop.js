const fs      = require('fs');
const path    = require('path');
const express = require('express');
const cl      = require('../lib/closedloop');
const ppm     = require('../lib/ppm');
const router  = express.Router();

// Resolve a component by dmsId or number and return everything the skill needs to write a story:
// component details, current user, users, products, suppliers and change templates (with their tasks).
router.get('/api/closedloop/context', async (req, res, next) => {
    try {
        if (!req.query.ref) return res.status(400).json({ error: 'ref (dmsId or item number) is required' });
        res.json(await cl.context(req.query.ref));
    } catch (e) { next(e); }
});

// body: { story? | storyFile?, dryRun?, reset? }
//   story      - the story JSON itself, or
//   storyFile  - name of a file inside work/ (for example "chiller-story.json")
// impersonate - optional true/false, overrides story.impersonation. When on, actions run as the user named by `as` (process, stage or task,
//   tasks default to their ASSIGNEE); needs the Server-to-Server app saved via setup.
// stopBefore - optional stage id: prepare that stage's fields and stop before its transition (live demo mode)
// dryRun defaults to TRUE: validates fields, picklists, links and transition names, writes nothing.
// A real run (dryRun:false) first repeats the validation and refuses to write when it finds errors.
router.post('/api/closedloop/run', async (req, res, next) => {
    try {
        const { storyFile, dryRun, reset, stopBefore, impersonate } = req.body || {};
        let story = req.body?.story;
        if (!story && storyFile) {
            const full = path.resolve(ppm.WORK_DIR, storyFile);
            if (!full.startsWith(ppm.WORK_DIR + path.sep)) return res.status(400).json({ error: 'storyFile must be inside work/' });
            story = JSON.parse(fs.readFileSync(full, 'utf8'));
        }
        if (!story) return res.status(400).json({ error: 'story or storyFile is required' });
        if (dryRun !== false) return res.json(await cl.run(story, { dryRun: true, stopBefore, impersonate }));
        const check = await cl.run(story, { dryRun: true, stopBefore, impersonate });
        if (!check.ok) return res.status(422).json({ error: 'Validation failed, nothing was written', ...check });
        res.json(await cl.run(story, { dryRun: false, reset: reset === true, stopBefore, impersonate }));
    } catch (e) { next(e); }
});

module.exports = router;
