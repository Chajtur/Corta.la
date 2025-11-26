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
  host: process.env.DB_HOST || 'srv1138.hstgr.io',
  user: process.env.DB_USER || 'u238056854_cortala',
  password: process.env.DB_PASSWORD || 'aGrp1qZh#',
  database: process.env.DB_NAME || 'u238056854_cortala',
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
      clicks INT DEFAULT 0
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

  const conn = await pool.getConnection();
  try {
    await conn.query(createUrls);
    await conn.query(createClicks);
  } finally {
    conn.release();
  }
}

async function createUrl(code, original_url) {
  const sql = `INSERT INTO urls (code, original_url) VALUES (?, ?)`;
  const [result] = await pool.execute(sql, [code, original_url]);
  return result.insertId;
}

async function getUrlByCode(code) {
  const sql = `SELECT * FROM urls WHERE code = ? LIMIT 1`;
  const [rows] = await pool.execute(sql, [code]);
  return rows[0] || null;
}

async function recordClick(urlId, ip, referrer, ua) {
  const sql = `INSERT INTO clicks (url_id, ip, referrer, user_agent) VALUES (?, ?, ?, ?)`;
  const [result] = await pool.execute(sql, [urlId, ip, referrer, ua]);
  return result.insertId;
}

async function incrementClicks(urlId) {
  const sql = `UPDATE urls SET clicks = clicks + 1 WHERE id = ?`;
  await pool.execute(sql, [urlId]);
}

async function getStats(code) {
  const url = await getUrlByCode(code);
  if (!url) return null;
  const [clicks] = await pool.execute(`SELECT ts, ip, referrer, user_agent FROM clicks WHERE url_id = ? ORDER BY ts DESC LIMIT 100`, [url.id]);
  return {
    id: url.id,
    code: url.code,
    original_url: url.original_url,
    created_at: url.created_at,
    clicks_total: url.clicks,
    recent_clicks: clicks
  };
}

module.exports = { init, createUrl, getUrlByCode, recordClick, incrementClicks, getStats };
