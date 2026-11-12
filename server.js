const express = require('express');
const config  = require('./lib/config');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(require('./routes/auth'));
app.use(require('./routes/plm'));
app.use(require('./routes/ppm'));
app.use(require('./routes/closedloop'));
app.use(require('./routes/requirements'));
app.use(require('./routes/fillempty'));
app.use(require('./routes/timelines'));

app.get('/', (req, res) => res.json({ app: 'plm-assistant', ...require('./lib/auth').status() }));

app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (req.accepts(['json', 'html']) === 'html' && !req.path.startsWith('/api/')) return res.status(status).send(`<h3>Error</h3><pre>${String(err.message).replace(/</g, '&lt;')}</pre>`);
    res.status(status).json({ error: err.message, details: err.details });
});

const { port } = config.load();
app.listen(port, '127.0.0.1', () => console.log(`plm-assistant listening on http://localhost:${port}`));
