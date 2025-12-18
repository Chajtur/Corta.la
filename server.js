// Load .env early so DB and other modules can read env vars
require('dotenv').config();
const express = require('express');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const helmet = require('helmet');
const { contentSecurityPolicy } = helmet;
const cors = require('cors');
const morgan = require('morgan');
const bodyParser = require('body-parser');
const { nanoid } = require('nanoid');
const db = require('./db');

const app = express();
// behind proxies (Railway, etc.) trust first proxy so req.ip and req.protocol reflect client
app.set('trust proxy', 1);
// Apply helmet protections, then set a custom Content Security Policy
app.use(helmet());
app.use(contentSecurityPolicy({
  directives: {
    defaultSrc: ["'self'"],
    // Allow Tailwind CDN and Google reCAPTCHA resources
    scriptSrc: ["'self'", 'https://cdn.tailwindcss.com', 'https://www.google.com', 'https://www.gstatic.com'],
    styleSrc: ["'self'", "'unsafe-inline'", 'https://cdn.tailwindcss.com', 'https://fonts.googleapis.com'],
    imgSrc: ["'self'", 'data:', 'https://www.google.com', 'https://www.gstatic.com'],
    connectSrc: ["'self'", 'https://www.google.com'],
    frameSrc: ['https://www.google.com', 'https://www.gstatic.com'],
    fontSrc: ["'self'", 'https://fonts.gstatic.com'],
    objectSrc: ["'none'"],
  }
}));
app.use(cors());
app.use(morgan('dev'));
app.use(bodyParser.json());
app.use(express.static('public'));

// Rate limiters
const shortenLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 60, // max 60 requests per IP per hour for shorten
  standardHeaders: true,
  legacyHeaders: false,
});

const checkLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});

const PORT = process.env.PORT || 3000;

// Reserved codes that must not be claimed by users
const RESERVED = new Set(['api', 'admin', 'stats', 'config', 'favicon.ico', 'robots.txt', 'public', 'assets']);

// POST /api/shorten
app.post('/api/shorten', shortenLimiter, async (req, res) => {
  try {
    const { url, code: requestedCode, recaptchaToken } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });
    // validate and restrict protocol to http/https
    let parsed;
    try { parsed = new URL(url); } catch (e) { return res.status(400).json({ error: 'invalid url' }); }
    if (!['http:', 'https:'].includes(parsed.protocol)) return res.status(400).json({ error: 'only http/https allowed' });
    // If reCAPTCHA is enabled server-side, validate token
    if (process.env.RECAPTCHA_SECRET) {
      if (!recaptchaToken) return res.status(400).json({ error: 'recaptcha token required' });
      try {
        const verifyUrl = `https://www.google.com/recaptcha/api/siteverify`;
        const resp = await axios.post(verifyUrl, null, { params: { secret: process.env.RECAPTCHA_SECRET, response: recaptchaToken } });
        const body = resp.data;
        if (!body.success || (body.score !== undefined && body.score < 0.3)) {
          return res.status(400).json({ error: 'recaptcha verification failed' });
        }
      } catch (err) {
        console.error('recaptcha verify error', err?.response?.data || err.message || err);
        return res.status(500).json({ error: 'recaptcha verification error' });
      }
    }

    // if user provided a custom code, validate and ensure uniqueness
    let code = null;
    if (requestedCode) {
      const sanitized = String(requestedCode).trim();
      // allowed: letters, numbers, - and _ ; length 4-64
      const ok = /^[A-Za-z0-9_-]{4,64}$/.test(sanitized);
      if (!ok) return res.status(400).json({ error: 'invalid code format (allowed: A-Z a-z 0-9 - _ ; length 4-64)' });
      if (RESERVED.has(sanitized.toLowerCase())) return res.status(400).json({ error: 'reserved code' });
      const exists = await db.getUrlByCode(sanitized);
      if (exists) return res.status(409).json({ error: 'code already in use' });
      code = sanitized;
    }

    // generate unique code if not provided
    if (!code) {
      for (let i = 0; i < 8; i++) {
        const candidate = nanoid(7);
        const exists = await db.getUrlByCode(candidate);
        if (!exists) { code = candidate; break; }
      }
      if (!code) return res.status(500).json({ error: 'could not generate code' });
    }

    const created = await db.createUrl(code, url);
    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    const shortUrl = `${baseUrl.replace(/\/$/, '')}/${code}`;
    res.json({ code, shortUrl, id: created });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal error' });
  }
});

// Check availability for a code
app.get('/api/check/:code', checkLimiter, async (req, res) => {
  try {
    const { code } = req.params;
    if (!code || typeof code !== 'string') return res.status(400).json({ error: 'code required' });
    if (RESERVED.has(code.toLowerCase())) return res.json({ available: false });
    const exists = await db.getUrlByCode(code);
    res.json({ available: !exists });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal' });
  }
});

// Redirect handler
app.get('/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const row = await db.getUrlByCode(code);
    if (!row) return res.status(404).send('Not found');

    // record click (single transaction to avoid double-write)
    const ip = req.ip; // trust proxy is set
    const ref = req.get('referer') || null;
    const ua = req.get('user-agent') || null;
    await db.recordClickAndIncrement(row.id, ip, ref, ua);

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

// Expose config such as recaptcha site key to the frontend (safe)
app.get('/api/config', (req, res) => {
  res.json({ recaptchaSiteKey: process.env.RECAPTCHA_SITE_KEY || null });
});

// Admin endpoints (protected by ADMIN_TOKEN env)
function adminAuth(req, res, next) {
  // Prefer header token. Avoid using query token in production to prevent leaks.
  const token = req.get('x-admin-token') || (process.env.NODE_ENV !== 'production' ? req.query.token : undefined);
  if (!process.env.ADMIN_TOKEN) return res.status(403).json({ error: 'admin disabled' });
  if (!token || token !== process.env.ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  next();
}

app.get('/api/admin/urls', adminAuth, async (req, res) => {
  try {
    // Use db helper to query all urls
    const rows = await db.getAllUrls();
    res.json({ urls: rows });
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
