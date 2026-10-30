const { Pool } = require('pg');
const crypto = require('node:crypto');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { 
    rejectUnauthorized: false,
    checkServerIdentity: () => undefined 
  }
});

let isDbReady = false;
let dbReadyPromise = null;

function initDb() {
  if (dbReadyPromise) return dbReadyPromise;
  dbReadyPromise = (async () => {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
        CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, name TEXT, username TEXT UNIQUE, pass_hash TEXT, role TEXT, active INTEGER DEFAULT 1);
        CREATE TABLE IF NOT EXISTS categories (id SERIAL PRIMARY KEY, name TEXT, sort INTEGER DEFAULT 0);
        CREATE TABLE IF NOT EXISTS items (id SERIAL PRIMARY KEY, category_id INTEGER, name TEXT, price REAL DEFAULT 0, veg INTEGER DEFAULT 1, active INTEGER DEFAULT 1);
        CREATE TABLE IF NOT EXISTS tables_ (id SERIAL PRIMARY KEY, name TEXT);
        CREATE TABLE IF NOT EXISTS orders (id SERIAL PRIMARY KEY, type TEXT, status TEXT DEFAULT 'open', table_id INTEGER, platform TEXT, platform_ref TEXT, customer_name TEXT, customer_phone TEXT, note TEXT, subtotal REAL DEFAULT 0, discount REAL DEFAULT 0, offer_discount REAL DEFAULT 0, taxable REAL DEFAULT 0, cgst REAL DEFAULT 0, sgst REAL DEFAULT 0, round_off REAL DEFAULT 0, total REAL DEFAULT 0, gst_rate REAL DEFAULT 0, bill_no TEXT, created_by INTEGER, paid_at TIMESTAMP, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS order_items (id SERIAL PRIMARY KEY, order_id INTEGER, item_id INTEGER, name TEXT, price REAL, qty INTEGER, kot_qty INTEGER DEFAULT 0);
        CREATE TABLE IF NOT EXISTS payments (id SERIAL PRIMARY KEY, order_id INTEGER, mode TEXT, amount REAL);
        CREATE TABLE IF NOT EXISTS expenses (id SERIAL PRIMARY KEY, date TEXT, category TEXT, description TEXT, amount REAL, mode TEXT, created_by INTEGER, budget_id INTEGER);
        CREATE TABLE IF NOT EXISTS offers (id SERIAL PRIMARY KEY, name TEXT, type TEXT, category_id INTEGER, item_id INTEGER, percent REAL, flat_amount REAL, min_bill REAL, combo_item_ids TEXT, combo_price REAL, start_date TEXT, end_date TEXT, active INTEGER DEFAULT 1, created_by INTEGER);
        CREATE TABLE IF NOT EXISTS offer_applications (id SERIAL PRIMARY KEY, order_id INTEGER, offer_id INTEGER, offer_name TEXT, discount REAL);
        CREATE TABLE IF NOT EXISTS inventory (id SERIAL PRIMARY KEY, name TEXT, unit TEXT, qty REAL DEFAULT 0, min_qty REAL DEFAULT 0, cost REAL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS stock_moves (id SERIAL PRIMARY KEY, inventory_id INTEGER, delta REAL, reason TEXT, created_by INTEGER, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
        CREATE TABLE IF NOT EXISTS recipes (id SERIAL PRIMARY KEY, item_id INTEGER, inventory_id INTEGER, qty REAL);
        CREATE TABLE IF NOT EXISTS budgets (id SERIAL PRIMARY KEY, name TEXT, category TEXT, amount REAL, due_day INTEGER, active INTEGER DEFAULT 1);
        CREATE TABLE IF NOT EXISTS reserve (id SERIAL PRIMARY KEY, date TEXT, amount REAL, note TEXT, created_by INTEGER);
        CREATE TABLE IF NOT EXISTS day_close (id SERIAL PRIMARY KEY, date TEXT UNIQUE, opening_float REAL, expected_cash REAL, counted_cash REAL, difference REAL, note TEXT, closed_by INTEGER, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
      `);

      // Create default admin if no users exist
      const res = await pool.query('SELECT COUNT(*) FROM users');
      if (parseInt(res.rows[0].count) === 0) {
        const hash = hashPassword('admin123');
        await pool.query('INSERT INTO users (name, username, pass_hash, role) VALUES ($1, $2, $3, $4)', ['Admin', 'admin', hash, 'admin']);
      }
      
      const sec = await pool.query("SELECT * FROM settings WHERE key = 'secret'");
      if (sec.rowCount === 0) {
        await pool.query('INSERT INTO settings (key, value) VALUES ($1, $2)', ['secret', crypto.randomBytes(32).toString('hex')]);
        await pool.query('INSERT INTO settings (key, value) VALUES ($1, $2)', ['restaurant_name', 'Katsu Kaii']);
        await pool.query('INSERT INTO settings (key, value) VALUES ($1, $2)', ['gst_rate', '5']);
        await pool.query('INSERT INTO settings (key, value) VALUES ($1, $2)', ['offer_zone_on', '0']);
      }
      
      isDbReady = true;
    } catch (err) {
      console.error("Database init error:", err);
    }
  })();
  return dbReadyPromise;
}

const db = {
  prepare: (sql) => {
    let index = 0;
    const pgSql = sql.replace(/\?/g, () => `$${++index}`);
    return {
      get: async (...args) => {
        await initDb(); 
        const res = await pool.query(pgSql, args);
        return res.rows[0];
      },
      all: async (...args) => {
        await initDb();
        const res = await pool.query(pgSql, args);
        return res.rows;
      },
      run: async (...args) => {
        await initDb();
        const res = await pool.query(pgSql, args);
        return { lastInsertRowid: res.rows[0]?.id, changes: res.rowCount };
      }
    };
  },
  exec: async (sql) => { 
    await initDb(); 
    await pool.query(sql); 
  }
};

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored) return false;
  const [salt, key] = stored.split(':');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(key, 'hex'), Buffer.from(hash, 'hex'));
}

async function getSettings() {
  await initDb(); 
  const res = await pool.query('SELECT * FROM settings');
  return Object.fromEntries(res.rows.map(r => [r.key, r.value]));
}
function autoBackup() { }

module.exports = { db, getSettings, hashPassword, verifyPassword, autoBackup };
