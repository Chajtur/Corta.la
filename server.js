const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const bodyParser = require('body-parser');
const { nanoid } = require('nanoid');
const db = require('./db');

const app = express();
app.use(helmet());
app.use(cors());
app.use(morgan('dev'));
app.use(bodyParser.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 3000;

// POST /api/shorten
app.post('/api/shorten', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });
    // validate
    try { new URL(url); } catch (e) { return res.status(400).json({ error: 'invalid url' }); }

    // generate unique code
    let code;
    for (let i = 0; i < 5; i++) {
      code = nanoid(7);
      const exists = await db.getUrlByCode(code);
      if (!exists) break;
      code = null;
    }
    if (!code) return res.status(500).json({ error: 'could not generate code' });

    const created = await db.createUrl(code, url);
    const host = req.get('host');
    const protocol = req.protocol;
    const shortUrl = `${protocol}://${host}/${code}`;
    res.json({ code, shortUrl, id: created });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

// Redirect handler
app.get('/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const row = await db.getUrlByCode(code);
    if (!row) return res.status(404).send('Not found');

    // record click
    const ip = req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    const ref = req.get('referer') || null;
    const ua = req.get('user-agent') || null;
    await db.recordClick(row.id, ip, ref, ua);
    await db.incrementClicks(row.id);

    res.redirect(302, row.original_url);
  } catch (err) {
    console.error(err);
    res.status(500).send('Internal error');
  }
});

// Stats endpoint
app.get('/api/stats/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const stats = await db.getStats(code);
    if (!stats) return res.status(404).json({ error: 'not found' });
    res.json(stats);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal' });
  }
});

// Start DB then server
db.init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server listening on http://localhost:${PORT}`);
    });
  })
  .catch(err => {
    console.error('DB init failed', err);
  });
