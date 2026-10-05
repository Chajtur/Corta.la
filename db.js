/**
 * MySQL-backed DB helper using `mysql2/promise`.
 *
 * Environment variables (provide these when deploying):
 * - DB_HOST
 * - DB_USER
 * - DB_PASSWORD
 * - DB_NAME
 * - DB_PORT (optional, default 3306)
 */
const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'corta_la',
  port: process.env.DB_PORT ? parseInt(process.env.DB_PORT, 10) : 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

async function init() {
  // create tables if they don't exist
  const createUrls = `
    CREATE TABLE IF NOT EXISTS urls (
      id INT AUTO_INCREMENT PRIMARY KEY,
      code VARCHAR(64) UNIQUE NOT NULL,
      original_url TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      clicks INT DEFAULT 0,
      owner_user_id INT NULL,
      plan ENUM('free', 'paid') NOT NULL DEFAULT 'free',
      expires_at DATETIME NULL
    ) ENGINE=InnoDB;
  `;

  const createClicks = `
    CREATE TABLE IF NOT EXISTS clicks (
      id INT AUTO_INCREMENT PRIMARY KEY,
      url_id INT NOT NULL,
      ts DATETIME DEFAULT CURRENT_TIMESTAMP,
      ip VARCHAR(100),
      referrer TEXT,
      user_agent TEXT,
      FOREIGN KEY (url_id) REFERENCES urls(id) ON DELETE CASCADE
    ) ENGINE=InnoDB;
  `;

  const createUsers = `
    CREATE TABLE IF NOT EXISTS users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(254) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB;
  `;

  const conn = await pool.getConnection();
  try {
    await conn.query(createUrls);
    await conn.query(createUsers);
    // Apply additive migrations to installations created by earlier versions.
    const [columns] = await conn.query(`SHOW COLUMNS FROM urls`);
    const existing = new Set(columns.map((column) => column.Field));
    if (!existing.has('owner_user_id')) await conn.query(`ALTER TABLE urls ADD COLUMN owner_user_id INT NULL`);
    if (!existing.has('plan')) await conn.query(`ALTER TABLE urls ADD COLUMN plan ENUM('free', 'paid') NOT NULL DEFAULT 'free'`);
    if (!existing.has('expires_at')) await conn.query(`ALTER TABLE urls ADD COLUMN expires_at DATETIME NULL`);
    const freeUrlDays = Number.parseInt(process.env.FREE_URL_TTL_DAYS || '30', 10);
    // Give legacy free links a full grace period from the migration instead of
    // silently breaking old links on their first deployment with this policy.
    await conn.execute(`UPDATE urls SET expires_at = DATE_ADD(GREATEST(created_at, CURRENT_TIMESTAMP), INTERVAL ? DAY) WHERE plan = 'free' AND expires_at IS NULL`, [Number.isInteger(freeUrlDays) && freeUrlDays > 0 ? freeUrlDays : 30]);
    await conn.query(createClicks);
    const [urlIndexes] = await conn.query(`SHOW INDEX FROM urls`);
    if (!urlIndexes.some((index) => index.Key_name === 'idx_urls_owner_created')) {
      await conn.query(`CREATE INDEX idx_urls_owner_created ON urls (owner_user_id, created_at)`);
    }
    const [clickIndexes] = await conn.query(`SHOW INDEX FROM clicks`);
    if (!clickIndexes.some((index) => index.Key_name === 'idx_clicks_url_ts')) {
      await conn.query(`CREATE INDEX idx_clicks_url_ts ON clicks (url_id, ts)`);
    }
  } finally {
    conn.release();
  }
}

async function createUrl(code, original_url, { ownerUserId = null, plan = 'free', expiresAt = null } = {}) {
  const sql = `INSERT INTO urls (code, original_url, owner_user_id, plan, expires_at) VALUES (?, ?, ?, ?, ?)`;
  const [result] = await pool.execute(sql, [code, original_url, ownerUserId, plan, expiresAt]);
  return result.insertId;
}

async function getUrlByCode(code) {
  const sql = `SELECT * FROM urls WHERE code = ? LIMIT 1`;
  const [rows] = await pool.execute(sql, [code]);
  return rows[0] || null;
}

async function recordClick(urlId, referrer) {
  const sql = `INSERT INTO clicks (url_id, referrer) VALUES (?, ?)`;
  const [result] = await pool.execute(sql, [urlId, referrer]);
  return result.insertId;
}

async function incrementClicks(urlId) {
  const sql = `UPDATE urls SET clicks = clicks + 1 WHERE id = ?`;
  await pool.execute(sql, [urlId]);
}

// Insert click and increment counter in a single transaction to reduce writes and keep consistency
async function recordClickAndIncrement(urlId, referrer) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const insertSql = `INSERT INTO clicks (url_id, referrer) VALUES (?, ?)`;
    await conn.execute(insertSql, [urlId, referrer]);
    const updateSql = `UPDATE urls SET clicks = clicks + 1 WHERE id = ?`;
    await conn.execute(updateSql, [urlId]);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function getStats(code) {
  const url = await getUrlByCode(code);
  if (!url) return null;
  const [dailyClicks] = await pool.execute(`SELECT DATE(ts) AS date, COUNT(*) AS clicks FROM clicks WHERE url_id = ? GROUP BY DATE(ts) ORDER BY date DESC LIMIT 30`, [url.id]);
  return {
    id: url.id,
    code: url.code,
    original_url: url.original_url,
    created_at: url.created_at,
    clicks_total: url.clicks,
    daily_clicks: dailyClicks
  };
}

async function createUser(email, passwordHash) {
  const [result] = await pool.execute(`INSERT INTO users (email, password_hash) VALUES (?, ?)`, [email, passwordHash]);
  return result.insertId;
}

async function getUserByEmail(email) {
  const [rows] = await pool.execute(`SELECT id, email, password_hash, created_at FROM users WHERE email = ? LIMIT 1`, [email]);
  return rows[0] || null;
}

async function getUserById(id) {
  const [rows] = await pool.execute(`SELECT id, email, created_at FROM users WHERE id = ? LIMIT 1`, [id]);
  return rows[0] || null;
}

async function getUserUrls(userId) {
  const [rows] = await pool.execute(`SELECT id, code, original_url, created_at, clicks, plan, expires_at,
    (expires_at IS NOT NULL AND expires_at <= NOW()) AS expired
    FROM urls WHERE owner_user_id = ? ORDER BY created_at DESC LIMIT 500`, [userId]);
  return rows;
}

async function setUrlPlan(urlId, plan, freeDays = 30) {
  await pool.execute(`UPDATE urls SET plan = ?, expires_at = ? WHERE id = ?`, [plan, plan === 'paid' ? null : new Date(Date.now() + freeDays * 86400000), urlId]);
}

async function deleteUserUrl(userId, urlId) {
  const [result] = await pool.execute(`DELETE FROM urls WHERE id = ? AND owner_user_id = ?`, [urlId, userId]);
  return result.affectedRows > 0;
}

async function getAllUrls() {
  const [rows] = await pool.execute(`SELECT id, code, original_url, owner_user_id, plan, expires_at, created_at, clicks FROM urls ORDER BY created_at DESC LIMIT 1000`);
  return rows;
}

module.exports = { init, createUrl, getUrlByCode, recordClick, incrementClicks, getStats, getAllUrls, getUserUrls, createUser, getUserByEmail, getUserById, setUrlPlan, deleteUserUrl, recordClickAndIncrement, pool };

