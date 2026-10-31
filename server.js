const express = require('express');
const crypto = require('node:crypto');
const path = require('node:path');
const { db, getSettings, hashPassword, verifyPassword, autoBackup } = require('./db');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(__dirname));

const SECRET = "katsu-kaii-secret-key-12345"; 
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const wrap = (fn) => (req, res) => {
  try { const r = fn(req, res); if (r !== undefined && !res.headersSent) res.json(r); }
  catch (e) { if (!e.status) console.error(e); res.status(e.status || 500).json({ error: e.status ? e.message : 'Server error' }); }
};
const fail = (status, message) => { const e = new Error(message); e.status = status; throw e; };

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return body + '.' + crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
}
function verify(token) {
  const [body, sig] = (token || '').split('.');
  if (!body || !sig) return null;
  const exp = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (sig.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp))) return null;
  const p = JSON.parse(Buffer.from(body, 'base64url').toString());
  return p.exp > Date.now() ? p : null;
}

app.post('/api/login', wrap(async (req) => {
  const { username = '', password = '' } = req.body || {};
  const u = await db.prepare('SELECT * FROM users WHERE username=? AND active=1').get(String(username).toLowerCase());
  if (!u || !verifyPassword(String(password), u.pass_hash)) {
    fail(401, 'Wrong username or password');
  }
  const user = { id: u.id, name: u.name, username: u.username, role: u.role };
  return { token: sign({ ...user, exp: Date.now() + 14 * 864e5 }), user };
}));

function auth(req, res, next) {
  const p = verify((req.headers.authorization || '').replace('Bearer ', ''));
  if (!p) return res.status(401).json({ error: 'Please log in' });
  req.user = p; next();
}
const adminOnly = (req, res, next) => req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Admin only' });
app.get('/api/health', (req, res) => res.json({ ok: true }));
app.use('/api', (req, res, next) => req.path === '/login' ? next() : auth(req, res, next));

app.get('/api/bootstrap', wrap(async (req) => {
  const settings = await getSettings();
  const u = await db.prepare('SELECT pass_hash FROM users WHERE id=?').get(req.user.id);
  const isDefault = u && verifyPassword('admin123', u.pass_hash);
  return {
    user: req.user,
    default_password: isDefault,
    settings: settings,
    categories: await db.prepare('SELECT * FROM categories ORDER BY sort,name').all(),
    items: await db.prepare('SELECT * FROM items WHERE active=1 ORDER BY name').all(),
    tables: await db.prepare('SELECT id,name FROM tables_ ORDER BY id').all(),
    offers: await db.prepare('SELECT * FROM offers WHERE active=1 ORDER BY id DESC').all(),
  };
}));

app.put('/api/settings', adminOnly, wrap(async (req) => {
  const allowed = ['restaurant_name', 'tagline', 'address', 'phone', 'gstin', 'fssai', 'pan', 'gst_rate',
    'aggregator_gst', 'bill_footer', 'paper_width', 'bill_prefix', 'offer_zone_on'];
  for (const k of allowed) if (k in req.body) {
    await db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(req.body[k]));
  }
  return await getSettings();
}));

app.post('/api/me/password', wrap(async (req) => {
  const { old_password, new_password } = req.body;
  const u = await db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!verifyPassword(String(old_password || ''), u.pass_hash)) fail(400, 'Current password is wrong');
  if (!new_password || new_password.length < 6) fail(400, 'New password must be 6+ characters');
  await db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(hashPassword(new_password), u.id);
  return { ok: true };
}));

// Dummy routes to prevent the UI from crashing while you test login
app.get('/api/dashboard', adminOnly, wrap(async () => {
  return {
    now: new Date().toLocaleTimeString('en-IN', { hour12: false }),
    today: { total: 0, bills: 0, byMode: [] },
    month: { total: 0, bills: 0, profit: 0, expenses: 0 },
    last7: [], top: [], low_stock: [], purchase_list: [], open_orders: 0, dues: [], unpriced: 0
  };
}));
app.get('/api/orders', wrap(async () => []));
app.get('/api/inventory', wrap(async () => []));
app.get('/api/expenses', adminOnly, wrap(async () => []));
app.get('/api/items/all', adminOnly, wrap(async () => []));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log(`Masala Mafia Billing running on port ${PORT}`));
