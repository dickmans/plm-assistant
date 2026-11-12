const express = require('express');
const auth    = require('../lib/auth');
const config  = require('../lib/config');
const router  = express.Router();

router.get('/login', (req, res, next) => {
    try { res.redirect(auth.loginUrl()); } catch (e) { next(e); }
});
router.get('/callback', async (req, res, next) => {
    try {
        if (req.query.error) throw new Error(`${req.query.error}: ${req.query.error_description || ''}`);
        await auth.handleCallback(String(req.query.code), String(req.query.state));
        res.type('html').send('<h3>Login successful</h3><p>You can close this window and return to Claude Code.</p>');
    } catch (e) { next(e); }
});
router.get('/api/status', (req, res) => res.json(auth.status()));
router.post('/api/config', (req, res, next) => {
    try {
        const cur = config.load();
        const { ssaClientId, ssaClientSecret, removeSsa } = req.body || {};
        const tenant = String(req.body?.tenant || cur.tenant || '');
        const clientId = String(req.body?.clientId || cur.clientId || '');
        const ssa = removeSsa ? null : (ssaClientId || ssaClientSecret) ? { clientId: String(ssaClientId || ''), clientSecret: String(ssaClientSecret || '') } : undefined;
        config.save(tenant, clientId, cur.port, ssa);
        // Only a changed tenant or login app needs a new login; adding or removing the Server-to-Server app does not.
        if (tenant !== cur.tenant || clientId !== cur.clientId) auth.logout();
        res.json({ ok: true, ...auth.status() });
    } catch (e) { e.status = 400; next(e); }
});
router.post('/api/logout', (req, res) => { auth.logout(); res.json({ ok: true }); });

module.exports = router;
