const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');
const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, username TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'cashier', active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS categories (id INTEGER PRIMARY KEY, name TEXT NOT NULL, sort INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY, category_id INTEGER REFERENCES categories(id),
  name TEXT NOT NULL, price REAL NOT NULL, veg INTEGER DEFAULT 1, active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS tables_ (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY, bill_no TEXT, type TEXT NOT NULL DEFAULT 'dinein',
  table_id INTEGER, platform TEXT, platform_ref TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  subtotal REAL DEFAULT 0, discount REAL DEFAULT 0, offer_discount REAL DEFAULT 0,
  taxable REAL DEFAULT 0,
  cgst REAL DEFAULT 0, sgst REAL DEFAULT 0, round_off REAL DEFAULT 0, total REAL DEFAULT 0,
  gst_rate REAL DEFAULT 0, customer_name TEXT, customer_phone TEXT, note TEXT,
  created_by INTEGER, created_at TEXT DEFAULT (datetime('now','localtime')), paid_at TEXT);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  item_id INTEGER, name TEXT NOT NULL, price REAL NOT NULL, qty INTEGER NOT NULL,
  kot_qty INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY, order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  mode TEXT NOT NULL, amount REAL NOT NULL);
CREATE TABLE IF NOT EXISTS inventory (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, unit TEXT DEFAULT 'kg',
  qty REAL DEFAULT 0, min_qty REAL DEFAULT 0, cost REAL DEFAULT 0);
CREATE TABLE IF NOT EXISTS stock_moves (
  id INTEGER PRIMARY KEY, inventory_id INTEGER NOT NULL REFERENCES inventory(id) ON DELETE CASCADE,
  delta REAL NOT NULL, reason TEXT, created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS expenses (
  id INTEGER PRIMARY KEY, date TEXT NOT NULL, category TEXT NOT NULL,
  description TEXT, amount REAL NOT NULL, mode TEXT DEFAULT 'cash', created_by INTEGER);
CREATE TABLE IF NOT EXISTS budgets (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'Other',
  amount REAL NOT NULL, due_day INTEGER NOT NULL DEFAULT 1, active INTEGER DEFAULT 1);
CREATE TABLE IF NOT EXISTS reserve (
  id INTEGER PRIMARY KEY, date TEXT NOT NULL, amount REAL NOT NULL, note TEXT, created_by INTEGER);
CREATE TABLE IF NOT EXISTS recipes (
  id INTEGER PRIMARY KEY, item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  inventory_id INTEGER NOT NULL REFERENCES inventory(id) ON DELETE CASCADE, qty REAL NOT NULL,
  UNIQUE(item_id, inventory_id));
CREATE TABLE IF NOT EXISTS day_close (
  date TEXT PRIMARY KEY, opening_float REAL DEFAULT 0, expected_cash REAL DEFAULT 0, counted_cash REAL DEFAULT 0,
  difference REAL DEFAULT 0, note TEXT, closed_by INTEGER, created_at TEXT DEFAULT (datetime('now','localtime')));

CREATE TABLE IF NOT EXISTS offers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  category_id INTEGER,
  item_id INTEGER,
  percent REAL DEFAULT 0,
  flat_amount REAL DEFAULT 0,
  min_bill REAL DEFAULT 0,
  combo_item_ids TEXT,
  combo_price REAL DEFAULT 0,
  start_date TEXT,
  end_date TEXT,
  active INTEGER DEFAULT 1,
  created_by INTEGER,
  created_at TEXT DEFAULT (datetime('now','localtime')));
CREATE TABLE IF NOT EXISTS offer_applications (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  offer_id INTEGER,
  offer_name TEXT NOT NULL,
  discount REAL NOT NULL,
  created_at TEXT DEFAULT (datetime('now','localtime')));

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_paid ON orders(paid_at);
CREATE INDEX IF NOT EXISTS idx_expenses_date ON expenses(date);
CREATE INDEX IF NOT EXISTS idx_offers_active ON offers(active);
`);

// upgrade older databases in place (keeps all existing data)
try { db.exec('ALTER TABLE expenses ADD COLUMN budget_id INTEGER'); } catch {}
try { db.exec('ALTER TABLE orders ADD COLUMN offer_discount REAL DEFAULT 0'); } catch {}

const DEFAULT_SETTINGS = {
  restaurant_name: 'Katsu Kaii',
  tagline: 'by Masala Mafia',
  address: 'Vidyanagar, Hubballi, Karnataka',
  phone: '',
  gstin: '',
  fssai: '',
  pan: '',
  gst_rate: '5',
  aggregator_gst: '0',
  bill_footer: 'Thank you! Visit again.',
  paper_width: '80',
  bill_prefix: 'KK',
  offer_zone_on: '1',
};
const getS = db.prepare('SELECT value FROM settings WHERE key=?');
const setS = db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) if (!getS.get(k)) setS.run(k, v);
if (!getS.get('secret')) setS.run('secret', crypto.randomBytes(32).toString('hex'));

function getSettings(includeSecret = false) {
  const out = {};
  for (const r of db.prepare('SELECT key,value FROM settings').all()) out[r.key] = r.value;
  if (!includeSecret) delete out.secret;
  return out;
}

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  return salt + ':' + crypto.scryptSync(pw, salt, 32).toString('hex');
}
function verifyPassword(pw, stored) {
  const [salt, hash] = stored.split(':');
  const h = crypto.scryptSync(pw, salt, 32);
  const b = Buffer.from(hash, 'hex');
  return b.length === h.length && crypto.timingSafeEqual(h, b);
}

if (!db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
  const pw = process.env.ADMIN_PASSWORD || 'admin123';
  db.prepare('INSERT INTO users(name,username,pass_hash,role) VALUES(?,?,?,?)')
    .run('Owner', 'admin', hashPassword(pw), 'admin');
  console.log(`First run: created admin user "admin" with password "${pw}" - CHANGE IT after login.`);
  const addCat = db.prepare('INSERT INTO categories(name,sort) VALUES(?,?)');
  const addItem = db.prepare('INSERT INTO items(category_id,name,price,veg) VALUES(?,?,?,?)');
  const c1 = Number(addCat.run('Katsu', 1).lastInsertRowid);
  const c2 = Number(addCat.run('Rice Bowls', 2).lastInsertRowid);
  const c3 = Number(addCat.run('Drinks', 3).lastInsertRowid);
  addItem.run(c1, 'Chicken Katsu', 220, 0);
  addItem.run(c1, 'Paneer Katsu', 200, 1);
  addItem.run(c2, 'Katsu Curry Rice', 260, 0);
  addItem.run(c2, 'Veg Katsu Rice Bowl', 220, 1);
  addItem.run(c3, 'Masala Soda', 60, 1);
  addItem.run(c3, 'Cold Coffee', 110, 1);
  const addTable = db.prepare('INSERT INTO tables_(name) VALUES(?)');
  for (let i = 1; i <= 8; i++) addTable.run('T' + i);
}

const BACKUP_DIR = process.env.BACKUP_DIR || path.join(path.dirname(DB_PATH), 'backups');
function autoBackup() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const d = db.prepare("SELECT date('now','localtime') d").get().d;
    const f = path.join(BACKUP_DIR, `auto-${d}.db`);
    if (!fs.existsSync(f)) db.exec(`VACUUM INTO '${f.replaceAll("'", "''")}'`);
    const files = fs.readdirSync(BACKUP_DIR).filter((x) => /^auto-.*\.db$/.test(x)).sort();
    while (files.length > 14) fs.unlinkSync(path.join(BACKUP_DIR, files.shift()));
  } catch (e) { console.error('Auto backup failed:', e.message); }
}

module.exports = { db, getSettings, hashPassword, verifyPassword, autoBackup, BACKUP_DIR };