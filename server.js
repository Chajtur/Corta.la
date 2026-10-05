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
const path = require('path');
const { nanoid } = require('nanoid');
const crypto = require('crypto');
const { promisify } = require('util');
const db = require('./db');
const emailService = require('./email');
const scrypt = promisify(crypto.scrypt);

const app = express();
// behind proxies (Railway, etc.) trust first proxy so req.ip and req.protocol reflect client
app.set('trust proxy', 1);
// Apply helmet protections, then set a custom Content Security Policy
app.use(helmet());
app.use(contentSecurityPolicy({
  directives: {
    defaultSrc: ["'self'"],
    // Allow Tailwind CDN and Google reCAPTCHA resources
    scriptSrc: ["'self'", 'https://cdn.tailwindcss.com', 'https://www.google.com', 'https://www.gstatic.com', 'https://www.googletagmanager.com'],
    styleSrc: ["'self'", "'unsafe-inline'", 'https://cdn.tailwindcss.com', 'https://fonts.googleapis.com'],
    imgSrc: ["'self'", 'data:', 'https://www.google.com', 'https://www.gstatic.com'],
    connectSrc: ["'self'", 'https://www.google.com', 'https://www.google-analytics.com', 'https://region1.google-analytics.com'],
    frameSrc: ['https://www.google.com', 'https://www.gstatic.com'],
    fontSrc: ["'self'", 'https://fonts.gstatic.com'],
    objectSrc: ["'none'"],
  }
}));
app.use(cors());
app.use(morgan('dev'));
app.use(bodyParser.json());
app.use(express.static('public'));

const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const sessionCookie = 'cortala_session';
const freeUrlDays = positiveInteger(process.env.FREE_URL_TTL_DAYS, 30);
if (process.env.NODE_ENV === 'production' && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) {
  throw new Error('SESSION_SECRET must contain at least 32 characters in production');
}

function signSession(userId, sessionVersion, expiresAt) {
  const payload = Buffer.from(JSON.stringify({ userId, sessionVersion, expiresAt })).toString('base64url');
  const signature = crypto.createHmac('sha256', sessionSecret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function getSession(req) {
  const cookie = (req.headers.cookie || '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${sessionCookie}=`));
  if (!cookie) return null;
  const value = cookie.slice(sessionCookie.length + 1);
  const [payload, signature] = value.split('.');
  if (!payload || !signature) return null;
  const expected = crypto.createHmac('sha256', sessionSecret).update(payload).digest();
  let received;
  try { received = Buffer.from(signature, 'base64url'); } catch { return null; }
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!Number.isInteger(session.userId) || !Number.isInteger(session.sessionVersion) || session.expiresAt <= Date.now()) return null;
    return session;
  } catch { return null; }
}

function setSessionCookie(res, user) {
  const expiresAt = Date.now() + 14 * 86400000;
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${sessionCookie}=${encodeURIComponent(signSession(user.id, user.auth_version, expiresAt))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=1209600${secure}`);
}

function clearSessionCookie(res) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${sessionCookie}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);
}

async function optionalUser(req) {
  const session = getSession(req);
  if (!session) return null;
  const user = await db.getUserById(session.userId);
  return user && user.auth_version === session.sessionVersion ? user : null;
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function actionUrl(req, route, key, token) {
  const baseUrl = (process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  return `${baseUrl}/${route}#${key}=${token}`;
}

async function sendAuthAction(req, user, purpose) {
  const token = crypto.randomBytes(32).toString('base64url');
  const isVerification = purpose === 'verify_email';
  const kind = isVerification ? 'verify' : 'reset';
  const lifetime = isVerification ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000;
  const route = isVerification ? 'verify-email' : 'reset-password';
  const key = isVerification ? 'verify' : 'reset';
  await db.createAuthToken(user.id, purpose, tokenHash(token), new Date(Date.now() + lifetime));
  await emailService.sendAuthEmail({ to: user.email, kind, actionUrl: actionUrl(req, route, key, token) });
}

async function requireUser(req, res, next) {
  try {
    const user = await optionalUser(req);
    if (!user) return res.status(401).json({ error: 'Inicia sesión para continuar.' });
    req.user = user;
    next();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal' });
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

const shortenWindowMs = positiveInteger(process.env.SHORTEN_RATE_WINDOW_MINUTES, 60) * 60 * 1000;
const shortenMax = positiveInteger(process.env.SHORTEN_RATE_LIMIT, 10);
const configuredCaptchaMinScore = Number.parseFloat(process.env.RECAPTCHA_MIN_SCORE || '0.7');
const captchaMinScore = Number.isFinite(configuredCaptchaMinScore) && configuredCaptchaMinScore >= 0 && configuredCaptchaMinScore <= 1
  ? configuredCaptchaMinScore
  : 0.7;
const captchaRequired = process.env.REQUIRE_CAPTCHA !== 'false';
const blockedHosts = new Set(
  (process.env.BLOCKED_URL_HOSTS || '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean)
);

function isBlockedHost(hostname) {
  const normalizedHost = hostname.toLowerCase();
  return [...blockedHosts].some((blockedHost) =>
    normalizedHost === blockedHost || normalizedHost.endsWith(`.${blockedHost}`)
  );
}

// Rate limiters
const shortenLimiter = rateLimit({
  windowMs: shortenWindowMs,
  max: shortenMax,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'too many URLs created from this IP; try again later' },
});

const checkLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos. Intenta de nuevo más tarde.' },
});

const PORT = process.env.PORT || 3000;

// Reserved codes that must not be claimed by users
const RESERVED = new Set(['api', 'admin', 'stats', 'config', 'favicon.ico', 'robots.txt', 'public', 'assets']);

app.post('/api/auth/register', authLimiter, async (req, res) => {
  try {
    if (!emailService.isConfigured()) return res.status(503).json({ error: 'El envío de correo no está configurado todavía.' });
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
      return res.status(400).json({ error: 'Escribe un correo válido.' });
    }
    if (password.length < 10 || Buffer.byteLength(password, 'utf8') > 128) {
      return res.status(400).json({ error: 'La contraseña debe tener entre 10 y 128 bytes.' });
    }
    if (await db.getUserByEmail(email)) return res.status(409).json({ error: 'Ya existe una cuenta con ese correo.' });
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = await scrypt(password, salt, 64);
    const userId = await db.createUser(email, `${salt}:${hash.toString('hex')}`);
    const user = { id: userId, email };
    try {
      await sendAuthAction(req, user, 'verify_email');
    } catch (emailError) {
      console.error('verification email send failed', emailError?.response?.data || emailError.message);
      return res.status(502).json({ error: 'La cuenta se creó, pero no se pudo enviar el correo. Usa Reenviar verificación.' });
    }
    res.status(201).json({ message: 'Cuenta creada. Revisa tu correo para verificar la cuenta.' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Ya existe una cuenta con ese correo.' });
    console.error(err);
    res.status(500).json({ error: 'No se pudo crear la cuenta.' });
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const user = await db.getUserByEmail(email);
    if (!user) return res.status(401).json({ error: 'Correo o contraseña incorrectos.' });
    const [salt, storedHash] = user.password_hash.split(':');
    const candidate = await scrypt(password, salt, 64);
    const stored = Buffer.from(storedHash, 'hex');
    if (candidate.length !== stored.length || !crypto.timingSafeEqual(candidate, stored)) {
      return res.status(401).json({ error: 'Correo o contraseña incorrectos.' });
    }
    if (!user.email_verified_at) return res.status(403).json({ error: 'Verifica tu correo antes de iniciar sesión.', code: 'EMAIL_NOT_VERIFIED' });
    setSessionCookie(res, user);
    res.json({ user: { id: user.id, email: user.email } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudo iniciar sesión.' });
  }
});

app.post('/api/auth/verify-email', authLimiter, async (req, res) => {
  const token = String(req.body?.token || '');
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(token)) return res.status(400).json({ error: 'El enlace de verificación no es válido o ya venció.' });
  try {
    const verified = await db.verifyEmailWithToken(tokenHash(token));
    if (!verified) return res.status(400).json({ error: 'El enlace de verificación no es válido o ya venció.' });
    res.json({ message: 'Correo verificado. Ya puedes iniciar sesión.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudo verificar el correo.' });
  }
});

app.post('/api/auth/resend-verification', authLimiter, async (req, res) => {
  if (!emailService.isConfigured()) return res.status(503).json({ error: 'El envío de correo no está configurado todavía.' });
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const user = await db.getUserByEmail(email);
    if (user && !user.email_verified_at) await sendAuthAction(req, user, 'verify_email');
    res.json({ message: 'Si la cuenta existe y requiere verificación, enviaremos un enlace nuevo.' });
  } catch (err) {
    console.error('verification email resend failed', err?.response?.data || err.message);
    res.status(502).json({ error: 'No se pudo enviar el correo ahora. Intenta de nuevo más tarde.' });
  }
});

app.post('/api/auth/forgot-password', authLimiter, async (req, res) => {
  if (!emailService.isConfigured()) return res.status(503).json({ error: 'El envío de correo no está configurado todavía.' });
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const user = await db.getUserByEmail(email);
    if (user && user.email_verified_at) await sendAuthAction(req, user, 'reset_password');
    res.json({ message: 'Si existe una cuenta verificada con ese correo, enviaremos instrucciones para cambiar la contraseña.' });
  } catch (err) {
    console.error('password reset email send failed', err?.response?.data || err.message);
    res.status(502).json({ error: 'No se pudo enviar el correo ahora. Intenta de nuevo más tarde.' });
  }
});

app.post('/api/auth/reset-password', authLimiter, async (req, res) => {
  const token = String(req.body?.token || '');
  const password = String(req.body?.password || '');
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(token)) return res.status(400).json({ error: 'El enlace no es válido o ya venció.' });
  if (password.length < 10 || Buffer.byteLength(password, 'utf8') > 128) {
    return res.status(400).json({ error: 'La contraseña debe tener entre 10 y 128 bytes.' });
  }
  try {
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = await scrypt(password, salt, 64);
    const updated = await db.resetPasswordWithToken(tokenHash(token), `${salt}:${hash.toString('hex')}`);
    if (!updated) return res.status(400).json({ error: 'El enlace no es válido o ya venció.' });
    res.json({ message: 'Contraseña actualizada. Inicia sesión con tu nueva contraseña.' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudo actualizar la contraseña.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  clearSessionCookie(res);
  res.status(204).end();
});

app.get('/api/me', async (req, res) => {
  try {
    const user = await optionalUser(req);
    if (!user) return res.json({ user: null });
    res.json({ user: { id: user.id, email: user.email, email_verified_at: user.email_verified_at } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudo cargar la sesión.' });
  }
});

app.get('/api/my/urls', requireUser, async (req, res) => {
  try {
    res.json({ urls: await db.getUserUrls(req.user.id), freeUrlDays });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudieron cargar tus enlaces.' });
  }
});

app.get('/api/my/urls/:id/stats', requireUser, async (req, res) => {
  try {
    const urls = await db.getUserUrls(req.user.id);
    const url = urls.find((item) => item.id === Number(req.params.id));
    if (!url) return res.status(404).json({ error: 'Enlace no encontrado.' });
    const stats = await db.getStats(url.code);
    res.json({ code: stats.code, clicks_total: stats.clicks_total, daily_clicks: stats.daily_clicks });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudieron cargar las estadísticas.' });
  }
});

app.delete('/api/my/urls/:id', requireUser, async (req, res) => {
  const urlId = Number(req.params.id);
  if (!Number.isInteger(urlId) || urlId < 1) return res.status(400).json({ error: 'Enlace inválido.' });
  try {
    const deleted = await db.deleteUserUrl(req.user.id, urlId);
    if (!deleted) return res.status(404).json({ error: 'Enlace no encontrado.' });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudo eliminar el enlace.' });
  }
});

// POST /api/shorten
app.post('/api/shorten', shortenLimiter, async (req, res) => {
  try {
    const { url, code: requestedCode, recaptchaToken } = req.body || {};
    if (!url) return res.status(400).json({ error: 'url is required' });
    // validate and restrict protocol to http/https
    let parsed;
    try { parsed = new URL(url); } catch (e) { return res.status(400).json({ error: 'invalid url' }); }
    if (!['http:', 'https:'].includes(parsed.protocol)) return res.status(400).json({ error: 'only http/https allowed' });
    if (isBlockedHost(parsed.hostname)) return res.status(400).json({ error: 'URLs from this domain are not allowed' });

    const captchaConfigured = Boolean(process.env.RECAPTCHA_SECRET && process.env.RECAPTCHA_SITE_KEY);
    if (captchaRequired && !captchaConfigured) {
      console.error('CAPTCHA is required but RECAPTCHA_SECRET and RECAPTCHA_SITE_KEY are not configured');
      return res.status(503).json({ error: 'URL creation is temporarily unavailable' });
    }

    if (captchaConfigured) {
      if (!recaptchaToken) return res.status(400).json({ error: 'recaptcha token required' });
      try {
        const verifyUrl = `https://www.google.com/recaptcha/api/siteverify`;
        const resp = await axios.post(verifyUrl, null, {
          params: { secret: process.env.RECAPTCHA_SECRET, response: recaptchaToken, remoteip: req.ip },
          timeout: 5000,
        });
        const body = resp.data;
        if (!body.success || body.action !== 'shorten' || typeof body.score !== 'number' || body.score < captchaMinScore) {
          return res.status(403).json({ error: 'recaptcha verification failed' });
        }
      } catch (err) {
        console.error('recaptcha verify error', err?.response?.data || err.message || err);
        return res.status(503).json({ error: 'recaptcha verification error' });
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

    const user = await optionalUser(req);
    const expiresAt = new Date(Date.now() + freeUrlDays * 86400000);
    const created = await db.createUrl(code, url, { ownerUserId: user?.id ?? null, plan: 'free', expiresAt });
    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.get('host')}`;
    const shortUrl = `${baseUrl.replace(/\/$/, '')}/${code}`;
    res.json({ code, shortUrl, id: created, plan: 'free', expiresAt: expiresAt.toISOString(), owner: Boolean(user) });
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
app.get(['/verify-email', '/reset-password'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/:code', async (req, res) => {
  try {
    const { code } = req.params;
    const row = await db.getUrlByCode(code);
    if (!row) return res.status(404).send('Not found');
    if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) {
      return res.status(410).send('Este enlace ha caducado.');
    }

    // record click (single transaction to avoid double-write)
    let referrerDomain = null;
    try {
      const referer = req.get('referer');
      if (referer) referrerDomain = new URL(referer).hostname.slice(0, 255);
    } catch { /* Ignore malformed referrers. */ }
    await db.recordClickAndIncrement(row.id, referrerDomain);

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
    const user = await optionalUser(req);
    if (!user) return res.status(401).json({ error: 'Inicia sesión para ver estadísticas.' });
    const urls = await db.getUserUrls(user.id);
    if (!urls.some((url) => url.code === code)) return res.status(404).json({ error: 'not found' });
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
  res.json({ recaptchaSiteKey: process.env.RECAPTCHA_SITE_KEY || null, gaMeasurementId: process.env.GA_MEASUREMENT_ID || null, freeUrlDays });
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

app.post('/api/admin/urls/:id/plan', adminAuth, async (req, res) => {
  const plan = req.body?.plan;
  const urlId = Number(req.params.id);
  if (!Number.isInteger(urlId) || urlId < 1 || !['free', 'paid'].includes(plan)) {
    return res.status(400).json({ error: 'id o plan inválido' });
  }
  try {
    await db.setUrlPlan(urlId, plan, freeUrlDays);
    res.json({ ok: true, plan });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal' });
  }
});

// Start DB then server when invoked directly. Keeping import side-effect free allows API tests.
if (require.main === module) {
  db.init()
    .then(() => {
      app.listen(PORT, () => {
        console.log(`Server listening on http://localhost:${PORT}`);
      });
    })
    .catch(err => {
      console.error('DB init failed', err);
      process.exitCode = 1;
    });
}

module.exports = app;
