const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

process.env.REQUIRE_CAPTCHA = 'false';
const db = require('../db');
const emailService = require('../email');
const users = new Map();
const urls = new Map();
const clicks = new Map();
const authTokens = new Map();
const outgoingEmails = [];
let nextUserId = 1;
let nextUrlId = 1;
let nextTokenId = 1;

db.init = async () => {};
db.getUserByEmail = async (email) => [...users.values()].find((user) => user.email === email) || null;
db.createUser = async (email, password_hash) => {
  const id = nextUserId++;
  users.set(id, { id, email, password_hash, email_verified_at: null, auth_version: 0, created_at: new Date() });
  return id;
};
db.getUserById = async (id) => {
  const user = users.get(id);
  return user ? { ...user } : null;
};
db.getUrlByCode = async (code) => [...urls.values()].find((url) => url.code === code) || null;
db.createUrl = async (code, original_url, { ownerUserId = null, plan = 'free', expiresAt = null } = {}) => {
  const id = nextUrlId++;
  urls.set(id, { id, code, original_url, owner_user_id: ownerUserId, plan, expires_at: expiresAt, created_at: new Date(), clicks: 0 });
  clicks.set(id, []);
  return id;
};
db.getUserUrls = async (userId) => [...urls.values()].filter((url) => url.owner_user_id === userId).map((url) => ({
  id: url.id, code: url.code, original_url: url.original_url, created_at: url.created_at,
  clicks: url.clicks, plan: url.plan, expires_at: url.expires_at,
  expired: Boolean(url.expires_at && url.expires_at <= new Date()),
}));
db.getStats = async (code) => {
  const url = await db.getUrlByCode(code);
  return url ? { id: url.id, code, clicks_total: url.clicks, daily_clicks: [] } : null;
};
db.recordClickAndIncrement = async (urlId) => { urls.get(urlId).clicks += 1; clicks.get(urlId).push(new Date()); };
db.deleteUserUrl = async (userId, urlId) => {
  const url = urls.get(urlId);
  if (!url || url.owner_user_id !== userId) return false;
  urls.delete(urlId);
  clicks.delete(urlId);
  return true;
};
db.createAuthToken = async (userId, purpose, token_hash, expires_at) => {
  const id = nextTokenId++;
  for (const [key, item] of authTokens) if (item.user_id === userId && item.purpose === purpose && !item.used_at) authTokens.delete(key);
  authTokens.set(token_hash, { id, user_id: userId, purpose, expires_at, used_at: null });
};
db.verifyEmailWithToken = async (token_hash) => {
  const item = authTokens.get(token_hash);
  if (!item || item.purpose !== 'verify_email' || item.used_at || item.expires_at <= new Date()) return false;
  item.used_at = new Date();
  users.get(item.user_id).email_verified_at = new Date();
  return true;
};
db.resetPasswordWithToken = async (token_hash, password_hash) => {
  const item = authTokens.get(token_hash);
  if (!item || item.purpose !== 'reset_password' || item.used_at || item.expires_at <= new Date()) return false;
  const user = users.get(item.user_id);
  user.password_hash = password_hash;
  user.auth_version += 1;
  for (const authToken of authTokens.values()) if (authToken.user_id === item.user_id && authToken.purpose === 'reset_password') authToken.used_at = new Date();
  return true;
};
emailService.isConfigured = () => true;
emailService.sendAuthEmail = async (message) => { outgoingEmails.push(message); return { id: `email-${outgoingEmails.length}` }; };

const app = require('../server');
let server;
let baseUrl;

before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
});

async function request(path, { cookie, ...options } = {}) {
  const headers = { ...(options.headers || {}) };
  if (cookie) headers.cookie = cookie;
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers });
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  return { response, data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}

test('accounts own links, see private aggregate stats, and can only delete their own links', async (t) => {
  const registered = await request('/api/auth/register', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'first@example.com', password: 'a-very-secure-password' }),
  });
  assert.equal(registered.response.status, 201);
  assert.equal(registered.cookie, undefined);
  assert.match(outgoingEmails[0].actionUrl, /\/verify-email#verify=/);
  const firstVerifyToken = new URL(outgoingEmails[0].actionUrl).hash.slice('#verify='.length);
  const beforeVerification = await request('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'first@example.com', password: 'a-very-secure-password' }),
  });
  assert.equal(beforeVerification.response.status, 403);
  const resent = await request('/api/auth/resend-verification', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'first@example.com' }),
  });
  assert.equal(resent.response.status, 200);
  const resentVerifyToken = new URL(outgoingEmails.at(-1).actionUrl).hash.slice('#verify='.length);
  const verification = await request('/api/auth/verify-email', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: firstVerifyToken }),
  });
  assert.equal(verification.response.status, 400);
  const finalVerification = await request('/api/auth/verify-email', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: resentVerifyToken }),
  });
  assert.equal(finalVerification.response.status, 200);
  const firstLogin = await request('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'first@example.com', password: 'a-very-secure-password' }),
  });
  assert.equal(firstLogin.response.status, 200);
  const firstCookie = firstLogin.cookie;

  const created = await request('/api/shorten', {
    method: 'POST', cookie: firstCookie, headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.org/article', code: 'first-link' }),
  });
  assert.equal(created.response.status, 200);
  assert.equal(created.data.owner, true);
  assert.equal(created.data.plan, 'free');
  assert.ok(Date.parse(created.data.expiresAt) > Date.now());
  const urlId = created.data.id;

  const owned = await request('/api/my/urls', { cookie: firstCookie });
  assert.equal(owned.response.status, 200);
  assert.equal(owned.data.urls.length, 1);
  const followed = await fetch(`${baseUrl}/${created.data.code}`, { redirect: 'manual' });
  assert.equal(followed.status, 302);
  assert.equal(followed.headers.get('location'), 'https://example.org/article');
  const stats = await request(`/api/my/urls/${urlId}/stats`, { cookie: firstCookie });
  assert.equal(stats.response.status, 200);
  assert.equal(stats.data.clicks_total, 1);
  assert.deepEqual(Object.keys(stats.data).sort(), ['clicks_total', 'code', 'daily_clicks']);
  const publicStats = await request(`/api/stats/${created.data.code}`);
  assert.equal(publicStats.response.status, 401);

  const second = await request('/api/auth/register', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'second@example.com', password: 'another-secure-password' }),
  });
  assert.equal(second.response.status, 201);
  const secondToken = new URL(outgoingEmails.at(-1).actionUrl).hash.slice('#verify='.length);
  await request('/api/auth/verify-email', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: secondToken }) });
  const secondLogin = await request('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'second@example.com', password: 'another-secure-password' }) });
  const wrongOwnerDelete = await request(`/api/my/urls/${urlId}`, { cookie: secondLogin.cookie, method: 'DELETE' });
  assert.equal(wrongOwnerDelete.response.status, 404);
  const deleted = await request(`/api/my/urls/${urlId}`, { cookie: firstCookie, method: 'DELETE' });
  assert.equal(deleted.response.status, 204);
  await request('/api/auth/forgot-password', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'first@example.com' }),
  });
  const resetToken = new URL(outgoingEmails.at(-1).actionUrl).hash.slice('#reset='.length);
  const reset = await request('/api/auth/reset-password', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: resetToken, password: 'a-new-secure-password' }),
  });
  assert.equal(reset.response.status, 200);
  const revokedSession = await request('/api/my/urls', { cookie: firstCookie });
  assert.equal(revokedSession.response.status, 401);
  const login = await request('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'first@example.com', password: 'a-new-secure-password' }),
  });
  assert.equal(login.response.status, 200);
  const wrongPassword = await request('/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'first@example.com', password: 'a-very-secure-password' }),
  });
  assert.equal(wrongPassword.response.status, 401);
  t.diagnostic('Ownership, session and private-statistics paths passed.');
});

test('expired links stop redirecting and guest-created links also get an expiry', async () => {
  const guest = await request('/api/shorten', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'https://example.org/temporary', code: 'guest-link' }),
  });
  assert.equal(guest.response.status, 200);
  assert.equal(guest.data.owner, false);
  assert.ok(guest.data.expiresAt);

  const row = [...urls.values()].find((url) => url.code === guest.data.code);
  row.expires_at = new Date(Date.now() - 1000);
  const redirect = await fetch(`${baseUrl}/${guest.data.code}`, { redirect: 'manual' });
  assert.equal(redirect.status, 410);
});

test('email action links resolve to the account UI', async () => {
  for (const path of ['/verify-email', '/reset-password']) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /reset-password-form/);
  }
});
