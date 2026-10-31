const express = require('express');
const crypto = require('node:crypto');
const path = require('node:path');
const { db, getSettings, hashPassword, verifyPassword, autoBackup } = require('./db');

const app = express();
app.use(express.json({ limit: '1mb' }));
// CHANGED: Look for website files in the current directory instead of a 'public' folder
app.use(express.static(__dirname));

const SECRET = getSettings(true).secret;
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
const loginAttempts = new Map();
app.post('/api/login', wrap((req) => {
  const { username = '', password = '' } = req.body || {};
  const key = String(username).toLowerCase();
  const a = loginAttempts.get(key) || { n: 0, t: Date.now() };
  if (Date.now() - a.t > 15 * 60e3) { a.n = 0; a.t = Date.now(); }
  if (a.n >= 99999) fail(429, 'Too many attempts. Try again in 15 minutes.');
  const u = db.prepare('SELECT * FROM users WHERE username=? AND active=1').get(key);
  if (!u || !verifyPassword(String(password), u.pass_hash)) {
    a.n++; loginAttempts.set(key, a); fail(401, 'Wrong username or password');
  }
  loginAttempts.delete(key);
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

app.get('/api/bootstrap', wrap((req) => ({
  user: req.user,
  default_password: req.user.role === 'admin' && (() => { const u = db.prepare('SELECT pass_hash FROM users WHERE id=?').get(req.user.id); return !!u && verifyPassword('admin123', u.pass_hash); })(),
  settings: getSettings(),
  categories: db.prepare('SELECT * FROM categories ORDER BY sort,name').all(),
  items: db.prepare('SELECT * FROM items WHERE active=1 ORDER BY name').all(),
  tables: db.prepare('SELECT id,name FROM tables_ ORDER BY id').all(),
  offers: db.prepare('SELECT * FROM offers WHERE active=1 ORDER BY id DESC').all(),
})));

app.put('/api/settings', adminOnly, wrap((req) => {
  const allowed = ['restaurant_name', 'tagline', 'address', 'phone', 'gstin', 'fssai', 'pan', 'gst_rate',
    'aggregator_gst', 'bill_footer', 'paper_width', 'bill_prefix', 'offer_zone_on'];
  for (const k of allowed) if (k in req.body) db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(req.body[k]));
  return getSettings();
}));

app.get('/api/users', adminOnly, wrap(() => db.prepare('SELECT id,name,username,role,active FROM users').all()));
app.post('/api/users', adminOnly, wrap((req) => {
  const { name, username, password, role } = req.body;
  if (!name || !username || !password || password.length < 6) fail(400, 'Name, username and a password of 6+ characters are required');
  if (!['admin', 'cashier'].includes(role)) fail(400, 'Role must be admin or cashier');
  try {
    db.prepare('INSERT INTO users(name,username,pass_hash,role) VALUES(?,?,?,?)').run(name, username.toLowerCase(), hashPassword(password), role);
  } catch { fail(400, 'Username already exists'); }
  return { ok: true };
}));
app.put('/api/users/:id', adminOnly, wrap((req) => {
  const { name, password, role, active } = req.body;
  const id = Number(req.params.id);
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  if (!u) fail(404, 'User not found');
  if (id === req.user.id && (active === 0 || (role && role !== 'admin'))) fail(400, 'You cannot disable or demote yourself');
  db.prepare('UPDATE users SET name=?, role=?, active=? WHERE id=?').run(name ?? u.name, role ?? u.role, active ?? u.active, id);
  if (password) {
    if (password.length < 6) fail(400, 'Password must be 6+ characters');
    db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(hashPassword(password), id);
  }
  return { ok: true };
}));
app.post('/api/me/password', wrap((req) => {
  const { old_password, new_password } = req.body;
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!verifyPassword(String(old_password || ''), u.pass_hash)) fail(400, 'Current password is wrong');
  if (!new_password || new_password.length < 6) fail(400, 'New password must be 6+ characters');
  db.prepare('UPDATE users SET pass_hash=? WHERE id=?').run(hashPassword(new_password), u.id);
  return { ok: true };
}));

app.post('/api/categories', adminOnly, wrap((req) => {
  if (!req.body.name) fail(400, 'Name required');
  return { id: Number(db.prepare('INSERT INTO categories(name,sort) VALUES(?,?)').run(req.body.name, req.body.sort || 0).lastInsertRowid) };
}));
app.put('/api/categories/:id', adminOnly, wrap((req) => {
  db.prepare('UPDATE categories SET name=?, sort=? WHERE id=?').run(req.body.name, req.body.sort || 0, req.params.id); return { ok: true };
}));
app.delete('/api/categories/:id', adminOnly, wrap((req) => {
  if (db.prepare('SELECT 1 FROM items WHERE category_id=?').get(req.params.id)) fail(400, 'This category still has dishes (including hidden ones). Move or delete them first');
  db.prepare('DELETE FROM categories WHERE id=?').run(req.params.id); return { ok: true };
}));
app.get('/api/items/all', adminOnly, wrap(() => db.prepare('SELECT * FROM items ORDER BY name').all()));
app.post('/api/items', adminOnly, wrap((req) => {
  const { category_id, name, price, veg = 1 } = req.body;
  if (!name || !(Number(price) >= 0)) fail(400, 'Name and valid price required');
  return { id: Number(db.prepare('INSERT INTO items(category_id,name,price,veg) VALUES(?,?,?,?)').run(category_id || null, name, Number(price), veg ? 1 : 0).lastInsertRowid) };
}));
app.put('/api/items/:id', adminOnly, wrap((req) => {
  const it = db.prepare('SELECT * FROM items WHERE id=?').get(req.params.id);
  if (!it) fail(404, 'Item not found');
  const b = { ...it, ...req.body };
  db.prepare('UPDATE items SET category_id=?, name=?, price=?, veg=?, active=? WHERE id=?')
    .run(b.category_id, b.name, Number(b.price), b.veg ? 1 : 0, b.active ? 1 : 0, it.id);
  return { ok: true };
}));
const SAMPLE_DISHES = [['Chicken Katsu', 220], ['Paneer Katsu', 200], ['Katsu Curry Rice', 260], ['Veg Katsu Rice Bowl', 220], ['Masala Soda', 60], ['Cold Coffee', 110]];
const SAMPLE_CATS = ['Katsu', 'Rice Bowls', 'Drinks'];
function loadSeed() { return JSON.parse(require('node:fs').readFileSync(path.join(__dirname, 'menu-seed.json'), 'utf8')); }
const isSample = (i) => SAMPLE_DISHES.some(([n, pr]) => n === i.name && pr === i.price && i.active === 1);
app.get('/api/menu/import-status', adminOnly, wrap(() => {
  const have = new Set(db.prepare('SELECT name FROM items').all().map((i) => i.name.toLowerCase()));
  const all = loadSeed().categories.flatMap((c) => c.items);
  return { total: all.length, missing: all.filter((i) => !have.has(i.name.toLowerCase())).length, samples: db.prepare('SELECT name,price,active FROM items').all().filter((i) => isSample(i)).length };
}));
app.post('/api/menu/import', adminOnly, wrap((req) => {
  const seed = loadSeed(); let added = 0, skipped = 0, hidden = 0;
  db.exec('BEGIN');
  try {
    if (req.body.hide_samples) {
      for (const it of db.prepare('SELECT id,name,price,active FROM items').all().filter(isSample)) {
        db.prepare("UPDATE items SET active=0, category_id=NULL, name=name || ' (sample)' WHERE id=?").run(it.id); hidden++;
      }
      for (const n of SAMPLE_CATS) {
        const c = db.prepare('SELECT id FROM categories WHERE name=?').get(n);
        if (c && !db.prepare('SELECT 1 FROM items WHERE category_id=?').get(c.id)) db.prepare('DELETE FROM categories WHERE id=?').run(c.id);
      }
    }
    const have = new Set(db.prepare('SELECT name FROM items').all().map((i) => i.name.toLowerCase()));
    let sort = db.prepare('SELECT COALESCE(MAX(sort),0) m FROM categories').get().m;
    for (const c of seed.categories) {
      let cat = db.prepare('SELECT id FROM categories WHERE name=?').get(c.name);
      const catId = cat ? cat.id : Number(db.prepare('INSERT INTO categories(name,sort) VALUES(?,?)').run(c.name, ++sort).lastInsertRowid);
      for (const i of c.items) {
        if (have.has(i.name.toLowerCase())) { skipped++; continue; }
        db.prepare('INSERT INTO items(category_id,name,price,veg,active) VALUES(?,?,0,?,0)').run(catId, i.name, i.veg ? 1 : 0); added++;
      }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { added, skipped, hidden };
}));
app.post('/api/items/bulk', adminOnly, wrap((req) => {
  const rows = Array.isArray(req.body.items) ? req.body.items : [];
  let changed = 0;
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      const cur = db.prepare('SELECT * FROM items WHERE id=?').get(r.id);
      if (!cur) continue;
      const price = r.price === '' || r.price == null ? cur.price : Number(r.price);
      if (!(price >= 0)) fail(400, `Invalid price for ${cur.name}`);
      const veg = r.veg == null ? cur.veg : (r.veg ? 1 : 0);
      const active = price > 0 ? (cur.price > 0 ? cur.active : 1) : 0;
      if (price !== cur.price || veg !== cur.veg || active !== cur.active) { db.prepare('UPDATE items SET price=?, veg=?, active=? WHERE id=?').run(price, veg, active, cur.id); changed++; }
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { changed };
}));
app.post('/api/tables', adminOnly, wrap((req) => {
  if (!req.body.name) fail(400, 'Name required');
  return { id: Number(db.prepare('INSERT INTO tables_(name) VALUES(?)').run(req.body.name).lastInsertRowid) };
}));
app.delete('/api/tables/:id', adminOnly, wrap((req) => {
  if (db.prepare("SELECT 1 FROM orders WHERE table_id=? AND status='open'").get(req.params.id)) fail(400, 'Table has an open order');
  db.prepare('DELETE FROM tables_ WHERE id=?').run(req.params.id); return { ok: true };
}));

app.get('/api/offers', adminOnly, wrap(() => db.prepare('SELECT * FROM offers ORDER BY active DESC, id DESC').all()));
app.post('/api/offers', adminOnly, wrap((req) => {
  const { name, type, category_id, item_id, percent, flat_amount, min_bill, combo_item_ids, combo_price, start_date, end_date } = req.body;
  if (!name) fail(400, 'Offer name required');
  if (!['category_percent', 'item_percent', 'bill_flat', 'combo'].includes(type)) fail(400, 'Invalid offer type');
  const id = Number(db.prepare(`INSERT INTO offers(name,type,category_id,item_id,percent,flat_amount,min_bill,combo_item_ids,combo_price,start_date,end_date,created_by)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    name, type,
    category_id ? Number(category_id) : null,
    item_id ? Number(item_id) : null,
    Number(percent) || 0,
    Number(flat_amount) || 0,
    Number(min_bill) || 0,
    combo_item_ids ? JSON.stringify(combo_item_ids) : null,
    Number(combo_price) || 0,
    start_date || null, end_date || null, req.user.id).lastInsertRowid);
  return { id };
}));
app.put('/api/offers/:id', adminOnly, wrap((req) => {
  const o = db.prepare('SELECT * FROM offers WHERE id=?').get(req.params.id);
  if (!o) fail(404, 'Offer not found');
  const b = { ...o, ...req.body };
  db.prepare(`UPDATE offers SET name=?, type=?, category_id=?, item_id=?, percent=?, flat_amount=?, min_bill=?, combo_item_ids=?, combo_price=?, start_date=?, end_date=?, active=? WHERE id=?`)
    .run(b.name, b.type,
      b.category_id ? Number(b.category_id) : null,
      b.item_id ? Number(b.item_id) : null,
      Number(b.percent) || 0, Number(b.flat_amount) || 0, Number(b.min_bill) || 0,
      b.combo_item_ids ? (typeof b.combo_item_ids === 'string' ? b.combo_item_ids : JSON.stringify(b.combo_item_ids)) : null,
      Number(b.combo_price) || 0,
      b.start_date || null, b.end_date || null, b.active ? 1 : 0, o.id);
  return { ok: true };
}));
app.delete('/api/offers/:id', adminOnly, wrap((req) => { db.prepare('DELETE FROM offers WHERE id=?').run(req.params.id); return { ok: true }; }));

function computeOfferDiscount(items, subtotal, type, settings) {
  if (settings.offer_zone_on !== '1') return { discount: 0, offer: null };
  if (type === 'aggregator') return { discount: 0, offer: null };
  const today = new Date().toISOString().slice(0, 10);
  const offers = db.prepare('SELECT * FROM offers WHERE active=1').all().filter((o) => {
    if (o.start_date && today < o.start_date) return false;
    if (o.end_date && today > o.end_date) return false;
    return true;
  });
  let best = { discount: 0, offer: null };
  for (const o of offers) {
    let d = 0;
    if (o.type === 'category_percent') {
      const cat = db.prepare('SELECT category_id FROM items WHERE id=?').get(o.category_id)?.category_id;
      const catSubtotal = items.filter((it) => {
        const m = it.item_id ? db.prepare('SELECT category_id FROM items WHERE id=?').get(it.item_id) : null;
        return m && m.category_id === o.category_id;
      }).reduce((s, it) => s + it.price * it.qty, 0);
      d = round2(catSubtotal * (Number(o.percent) || 0) / 100);
    } else if (o.type === 'item_percent') {
      const itemSubtotal = items.filter((it) => it.item_id === o.item_id).reduce((s, it) => s + it.price * it.qty, 0);
      d = round2(itemSubtotal * (Number(o.percent) || 0) / 100);
    } else if (o.type === 'bill_flat') {
      if (subtotal >= (Number(o.min_bill) || 0)) d = round2(Number(o.flat_amount) || 0);
    } else if (o.type === 'combo') {
      const ids = o.combo_item_ids ? JSON.parse(o.combo_item_ids) : [];
      if (ids.length) {
        const allPresent = ids.every((id) => items.some((it) => it.item_id === id));
        if (allPresent) {
          const comboOriginal = ids.reduce((s, id) => {
            const line = items.find((it) => it.item_id === id);
            return s + (line ? line.price * line.qty : 0);
          }, 0);
          d = round2(Math.max(0, comboOriginal - (Number(o.combo_price) || 0) * ids.length));
        }
      }
    }
    if (d > best.discount) best = { discount: d, offer: o };
  }
  return best;
}
function listActiveOffers(type, settings) {
  if (settings.offer_zone_on !== '1') return [];
  if (type === 'aggregator') return [];
  const today = new Date().toISOString().slice(0, 10);
  return db.prepare('SELECT * FROM offers WHERE active=1 ORDER BY id DESC').all().filter((o) => {
    if (o.start_date && today < o.start_date) return false;
    if (o.end_date && today > o.end_date) return false;
    return true;
  }).map((o) => ({
    id: o.id, name: o.name, type: o.type,
    category_id: o.category_id, item_id: o.item_id,
    percent: o.percent, flat_amount: o.flat_amount, min_bill: o.min_bill,
    combo_item_ids: o.combo_item_ids ? JSON.parse(o.combo_item_ids) : [],
    combo_price: o.combo_price,
  }));
}
app.get('/api/active-offers', wrap((req) => {
  const type = req.query.type || 'dinein';
  return { offers: listActiveOffers(type, getSettings()), zone_on: getSettings().offer_zone_on === '1' };
}));

function calcTotals(subtotal, discount, offerDiscount, type, settings) {
  discount = Math.min(Math.max(Number(discount) || 0, 0), subtotal);
  offerDiscount = Math.min(Math.max(Number(offerDiscount) || 0, 0), subtotal - discount);
  const taxable = round2(subtotal - discount - offerDiscount);
  const isAgg = type === 'aggregator';
  const rate = isAgg && settings.aggregator_gst !== '1' ? 0 : Number(settings.gst_rate) || 0;
  const gst = round2(taxable * rate / 100);
  const cgst = round2(gst / 2), sgst = round2(gst - round2(gst / 2));
  const exact = taxable + cgst + sgst;
  const total = Math.round(exact);
  return { subtotal: round2(subtotal), discount: round2(discount), offer_discount: round2(offerDiscount), taxable, cgst, sgst, gst_rate: rate, round_off: round2(total - exact), total };
}
function loadOrder(id) {
  const o = db.prepare(`SELECT o.*, t.name AS table_name, u.name AS cashier FROM orders o
    LEFT JOIN tables_ t ON t.id=o.table_id LEFT JOIN users u ON u.id=o.created_by WHERE o.id=?`).get(id);
  if (!o) return null;
  o.items = db.prepare('SELECT * FROM order_items WHERE order_id=? ORDER BY id').all(id);
  o.payments = db.prepare('SELECT mode,amount FROM payments WHERE order_id=?').all(id);
  o.offer_applications = db.prepare('SELECT offer_name, discount FROM offer_applications WHERE order_id=?').all(id);
  return o;
}
function nextBillNo(settings) {
  const now = new Date();
  const y = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  const fy = `${y}-${String(y + 1).slice(2)}`;
  const prefix = `${settings.bill_prefix || 'KK'}/${fy}/`;
  const last = db.prepare("SELECT bill_no FROM orders WHERE bill_no LIKE ? ORDER BY id DESC LIMIT 1").get(prefix + '%');
  const n = last ? parseInt(last.bill_no.split('/').pop(), 10) + 1 : 1;
  return prefix + String(n).padStart(4, '0');
}

app.post('/api/orders', wrap((req) => {
  const b = req.body;
  const settings = getSettings();
  const type = ['dinein', 'takeaway', 'aggregator'].includes(b.type) ? b.type : 'dinein';
  const items = Array.isArray(b.items) ? b.items : [];
  if (!items.length) fail(400, 'Add at least one item');
  if (type === 'dinein' && !b.table_id) fail(400, 'Choose a table');
  if (type === 'aggregator' && !b.platform) fail(400, 'Choose Zomato / Swiggy / other');

  db.exec('BEGIN');
  try {
    let id = b.id;
    if (id) {
      const ex = db.prepare('SELECT status FROM orders WHERE id=?').get(id);
      if (!ex) fail(404, 'Order not found');
      if (ex.status !== 'open') fail(400, 'This bill is already closed');
    } else {
      id = Number(db.prepare('INSERT INTO orders(type,created_by) VALUES(?,?)').run(type, req.user.id).lastInsertRowid);
    }
    const prevKot = {};
    for (const r of db.prepare('SELECT item_id,name,kot_qty FROM order_items WHERE order_id=?').all(id)) prevKot[r.item_id ?? r.name] = r.kot_qty;
    db.prepare('DELETE FROM order_items WHERE order_id=?').run(id);
    let subtotal = 0;
    const ins = db.prepare('INSERT INTO order_items(order_id,item_id,name,price,qty,kot_qty) VALUES(?,?,?,?,?,?)');
    const cleanItems = [];
    for (const it of items) {
      const qty = parseInt(it.qty, 10);
      if (!(qty > 0)) continue;
      let name = it.name, price = Number(it.price);
      if (it.item_id) {
        const m = db.prepare('SELECT name,price FROM items WHERE id=?').get(it.item_id);
        if (m) { name = m.name; price = m.price; }
        if (m && !(m.price > 0)) fail(400, `${m.name} has no price yet. Ask the admin to set it in Menu > Set prices.`);
      }
      if (!(price >= 0) || !name) fail(400, 'Invalid item');
      subtotal += price * qty;
      ins.run(id, it.item_id || null, name, price, qty, Math.min(prevKot[it.item_id ?? name] || 0, qty));
      cleanItems.push({ item_id: it.item_id || null, name, price, qty });
    }
    const best = computeOfferDiscount(cleanItems, subtotal, type, settings);
    const t = calcTotals(subtotal, b.discount, best.discount, type, settings);
    db.prepare(`UPDATE orders SET type=?, table_id=?, platform=?, platform_ref=?, customer_name=?, customer_phone=?, note=?,
      subtotal=?, discount=?, offer_discount=?, taxable=?, cgst=?, sgst=?, round_off=?, total=?, gst_rate=? WHERE id=?`)
      .run(type, type === 'dinein' ? b.table_id : null, type === 'aggregator' ? b.platform : null, b.platform_ref || null,
        b.customer_name || null, b.customer_phone || null, b.note || null,
        t.subtotal, t.discount, t.offer_discount, t.taxable, t.cgst, t.sgst, t.round_off, t.total, t.gst_rate, id);
    db.prepare('DELETE FROM offer_applications WHERE order_id=?').run(id);
    if (best.offer && best.discount > 0) {
      db.prepare('INSERT INTO offer_applications(order_id,offer_id,offer_name,discount) VALUES(?,?,?,?)')
        .run(id, best.offer.id, best.offer.name, best.discount);
    }
    db.exec('COMMIT');
    return loadOrder(id);
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}));

app.get('/api/orders', wrap((req) => {
  const { status = 'open', from, to } = req.query;
  let sql = `SELECT o.*, t.name AS table_name FROM orders o LEFT JOIN tables_ t ON t.id=o.table_id WHERE o.status=?`;
  const args = [status];
  if (from) { sql += ' AND date(COALESCE(o.paid_at,o.created_at))>=?'; args.push(from); }
  if (to) { sql += ' AND date(COALESCE(o.paid_at,o.created_at))<=?'; args.push(to); }
  return db.prepare(sql + ' ORDER BY o.id DESC LIMIT 500').all(...args);
}));
app.get('/api/orders/:id', wrap((req) => loadOrder(req.params.id) || fail(404, 'Not found')));

app.post('/api/orders/:id/kot', wrap((req) => {
  const o = loadOrder(req.params.id);
  if (!o) fail(404, 'Not found');
  const fresh = o.items.filter((i) => i.qty > i.kot_qty).map((i) => ({ name: i.name, qty: i.qty - i.kot_qty }));
  db.prepare('UPDATE order_items SET kot_qty=qty WHERE order_id=?').run(o.id);
  return { order: { id: o.id, table_name: o.table_name, type: o.type, platform: o.platform, platform_ref: o.platform_ref }, items: fresh };
}));

function deductStock(order, billNo, userId) {
  const need = new Map();
  for (const it of order.items) {
    if (!it.item_id) continue;
    for (const r of db.prepare('SELECT inventory_id, qty FROM recipes WHERE item_id=?').all(it.item_id))
      need.set(r.inventory_id, (need.get(r.inventory_id) || 0) + r.qty * it.qty);
  }
  for (const [invId, qty] of need) {
    const inv = db.prepare('SELECT qty FROM inventory WHERE id=?').get(invId);
    if (!inv) continue;
    const used = Math.min(inv.qty, qty);
    if (used <= 0) continue;
    db.prepare('UPDATE inventory SET qty=qty-? WHERE id=?').run(used, invId);
    db.prepare('INSERT INTO stock_moves(inventory_id,delta,reason,created_by) VALUES(?,?,?,?)').run(invId, -used, 'Sold - bill ' + billNo, userId);
  }
}

app.post('/api/orders/:id/pay', wrap((req) => {
  const o = loadOrder(req.params.id);
  if (!o) fail(404, 'Not found');
  if (o.status !== 'open') fail(400, 'Bill already closed');
  const pays = (req.body.payments || []).map((p) => ({ mode: p.mode, amount: round2(Number(p.amount)) })).filter((p) => p.amount > 0);
  const modes = ['cash', 'upi', 'card', 'online'];
  if (pays.some((p) => !modes.includes(p.mode))) fail(400, 'Invalid payment mode');
  const paid = round2(pays.reduce((s, p) => s + p.amount, 0));
  if (Math.abs(paid - o.total) > 0.01) fail(400, `Payments (${paid}) must equal bill total (${o.total})`);
  const settings = getSettings();
  db.exec('BEGIN');
  try {
    for (const p of pays) db.prepare('INSERT INTO payments(order_id,mode,amount) VALUES(?,?,?)').run(o.id, p.mode, p.amount);
    const billNo = nextBillNo(settings);
    db.prepare("UPDATE orders SET status='paid', bill_no=?, paid_at=datetime('now','localtime') WHERE id=?").run(billNo, o.id);
    deductStock(o, billNo, req.user.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return loadOrder(o.id);
}));

app.post('/api/orders/:id/void', adminOnly, wrap((req) => {
  const o = loadOrder(req.params.id);
  if (!o) fail(404, 'Not found');
  db.prepare("UPDATE orders SET status='void', note=COALESCE(note||' | ','')||? WHERE id=?").run('VOID: ' + (req.body.reason || 'no reason'), o.id);
  return { ok: true };
}));

app.get('/api/inventory', wrap(() => db.prepare('SELECT * FROM inventory ORDER BY name').all()));
app.post('/api/inventory', adminOnly, wrap((req) => {
  const { name, unit = 'kg', qty = 0, min_qty = 0, cost = 0 } = req.body;
  if (!name) fail(400, 'Name required');
  const id = Number(db.prepare('INSERT INTO inventory(name,unit,qty,min_qty,cost) VALUES(?,?,?,?,?)').run(name, unit, Number(qty), Number(min_qty), Number(cost)).lastInsertRowid);
  if (Number(qty)) db.prepare('INSERT INTO stock_moves(inventory_id,delta,reason,created_by) VALUES(?,?,?,?)').run(id, Number(qty), 'Opening stock', req.user.id);
  return { id };
}));
app.put('/api/inventory/:id', adminOnly, wrap((req) => {
  const i = db.prepare('SELECT * FROM inventory WHERE id=?').get(req.params.id);
  if (!i) fail(404, 'Not found');
  const b = { ...i, ...req.body };
  db.prepare('UPDATE inventory SET name=?, unit=?, min_qty=?, cost=? WHERE id=?').run(b.name, b.unit, Number(b.min_qty), Number(b.cost), i.id);
  return { ok: true };
}));
app.post('/api/inventory/:id/move', wrap((req) => {
  const delta = Number(req.body.delta);
  if (!delta) fail(400, 'Enter a quantity');
  const i = db.prepare('SELECT * FROM inventory WHERE id=?').get(req.params.id);
  if (!i) fail(404, 'Not found');
  if (i.qty + delta < 0) fail(400, `Only ${i.qty} ${i.unit} in stock`);
  db.prepare('UPDATE inventory SET qty=qty+? WHERE id=?').run(delta, i.id);
  if (delta > 0 && Number(req.body.cost) > 0) db.prepare('UPDATE inventory SET cost=? WHERE id=?').run(Number(req.body.cost), i.id);
  db.prepare('INSERT INTO stock_moves(inventory_id,delta,reason,created_by) VALUES(?,?,?,?)').run(i.id, delta, req.body.reason || (delta > 0 ? 'Purchase' : 'Used'), req.user.id);
  return db.prepare('SELECT * FROM inventory WHERE id=?').get(i.id);
}));
app.get('/api/inventory/:id/moves', wrap((req) => db.prepare('SELECT * FROM stock_moves WHERE inventory_id=? ORDER BY id DESC LIMIT 50').all(req.params.id)));

const EXPENSE_CATS = ['Rent', 'Electricity', 'Water', 'Staff salary', 'Chef salary', 'Raw material', 'Gas / Fuel', 'Maintenance', 'Marketing', 'Platform commission', 'Licence / Tax', 'Other'];
app.get('/api/expense-categories', wrap(() => EXPENSE_CATS));
app.get('/api/expenses', adminOnly, wrap((req) => {
  const { from, to } = req.query;
  return db.prepare('SELECT * FROM expenses WHERE date>=? AND date<=? ORDER BY date DESC,id DESC').all(from || '0000-01-01', to || '9999-12-31');
}));
app.post('/api/expenses', adminOnly, wrap((req) => {
  const { date, category, description, amount, mode = 'cash' } = req.body;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !category || !(Number(amount) > 0)) fail(400, 'Date, category and amount are required');
  return { id: Number(db.prepare('INSERT INTO expenses(date,category,description,amount,mode,created_by) VALUES(?,?,?,?,?,?)').run(date, category, description || '', Number(amount), mode, req.user.id).lastInsertRowid) };
}));
app.delete('/api/expenses/:id', adminOnly, wrap((req) => { db.prepare('DELETE FROM expenses WHERE id=?').run(req.params.id); return { ok: true }; }));

function summary(from, to) {
  const paid = `status='paid' AND date(paid_at)>=? AND date(paid_at)<=?`;
  const args = [from, to];
  const tot = db.prepare(`SELECT COUNT(*) bills, COALESCE(SUM(subtotal),0) gross, COALESCE(SUM(discount),0) discount,
    COALESCE(SUM(offer_discount),0) offer_discount,
    COALESCE(SUM(taxable),0) taxable, COALESCE(SUM(cgst),0) cgst, COALESCE(SUM(sgst),0) sgst,
    COALESCE(SUM(round_off),0) round_off, COALESCE(SUM(total),0) total FROM orders WHERE ${paid}`).get(...args);
  const byMode = db.prepare(`SELECT p.mode, SUM(p.amount) amount FROM payments p JOIN orders o ON o.id=p.order_id
    WHERE o.status='paid' AND date(o.paid_at)>=? AND date(o.paid_at)<=? GROUP BY p.mode`).all(...args);
  const byType = db.prepare(`SELECT type, COALESCE(platform,'') platform, COUNT(*) bills, SUM(total) total FROM orders WHERE ${paid} GROUP BY type, platform`).all(...args);
  const daily = db.prepare(`SELECT date(paid_at) day, COUNT(*) bills, SUM(total) total FROM orders WHERE ${paid} GROUP BY day ORDER BY day`).all(...args);
  const top = db.prepare(`SELECT oi.name, SUM(oi.qty) qty, SUM(oi.qty*oi.price) amount FROM order_items oi JOIN orders o ON o.id=oi.order_id
    WHERE o.status='paid' AND date(o.paid_at)>=? AND date(o.paid_at)<=? GROUP BY oi.name ORDER BY qty DESC LIMIT 10`).all(...args);
  const expByCat = db.prepare('SELECT category, SUM(amount) amount FROM expenses WHERE date>=? AND date<=? GROUP BY category ORDER BY amount DESC').all(...args);
  const expenses = round2(expByCat.reduce((s, e) => s + e.amount, 0));
  const income = round2(tot.taxable);
  return { from, to, totals: tot, byMode, byType, daily, top, expByCat, expenses, income, profit: round2(income - expenses) };
}
app.get('/api/reports/summary', adminOnly, wrap((req) => {
  const today = todayStr();
  return summary(req.query.from || today, req.query.to || today);
}));
app.get('/api/reports/export.csv', adminOnly, (req, res) => {
  const { from, to } = req.query;
  const esc = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;
  const rows = db.prepare(`SELECT bill_no, date(paid_at) date, type, platform, subtotal, discount, offer_discount, taxable, cgst, sgst, round_off, total FROM orders
    WHERE status='paid' AND date(paid_at)>=? AND date(paid_at)<=? ORDER BY id`).all(from || '0000-01-01', to || '9999-12-31');
  const head = ['Bill No', 'Date', 'Type', 'Platform', 'Subtotal', 'Discount', 'Offer Discount', 'Taxable', 'CGST', 'SGST', 'Round off', 'Total'];
  const csv = [head.map(esc).join(','), ...rows.map((r) => Object.values(r).map(esc).join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="katsu-kaii-sales-${from}-to-${to}.csv"`);
  res.send(csv);
});
app.get('/api/reports/fy', adminOnly, wrap((req) => {
  const y = Number(req.query.year) || (new Date().getMonth() >= 3 ? new Date().getFullYear() : new Date().getFullYear() - 1);
  const s = summary(`${y}-04-01`, `${y + 1}-03-31`);
  const months = db.prepare(`SELECT strftime('%Y-%m', paid_at) month, COUNT(*) bills, SUM(taxable) taxable, SUM(cgst) cgst, SUM(sgst) sgst, SUM(total) total
    FROM orders WHERE status='paid' AND date(paid_at)>=? AND date(paid_at)<=? GROUP BY month ORDER BY month`).all(`${y}-04-01`, `${y + 1}-03-31`);
  const expMonths = db.prepare(`SELECT strftime('%Y-%m', date) month, SUM(amount) amount FROM expenses WHERE date>=? AND date<=? GROUP BY month`).all(`${y}-04-01`, `${y + 1}-03-31`);
  return { fy: `${y}-${String(y + 1).slice(2)}`, summary: s, months, expMonths };
}));

app.get('/api/recipes', adminOnly, wrap(() => db.prepare(`SELECT r.id, r.item_id, r.inventory_id, r.qty, i.name AS item_name, v.name AS ingredient, v.unit
  FROM recipes r JOIN items i ON i.id=r.item_id JOIN inventory v ON v.id=r.inventory_id ORDER BY i.name, v.name`).all()));
app.post('/api/recipes', adminOnly, wrap((req) => {
  const { item_id, inventory_id, qty } = req.body;
  if (!item_id || !inventory_id || !(Number(qty) > 0)) fail(400, 'Choose a dish, an ingredient and a quantity above 0');
  db.prepare('INSERT INTO recipes(item_id,inventory_id,qty) VALUES(?,?,?) ON CONFLICT(item_id,inventory_id) DO UPDATE SET qty=excluded.qty').run(item_id, inventory_id, Number(qty));
  return { ok: true };
}));
app.delete('/api/recipes/:id', adminOnly, wrap((req) => { db.prepare('DELETE FROM recipes WHERE id=?').run(req.params.id); return { ok: true }; }));

const pad = (n) => String(n).padStart(2, '0');
const todayStr = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
app.get('/api/budgets', adminOnly, wrap(() => db.prepare('SELECT * FROM budgets ORDER BY due_day, name').all()));
app.post('/api/budgets', adminOnly, wrap((req) => {
  const { name, category = 'Other', amount, due_day = 1 } = req.body;
  if (!name || !(Number(amount) > 0)) fail(400, 'Name and amount are required');
  const dd = Math.min(Math.max(parseInt(due_day, 10) || 1, 1), 31);
  return { id: Number(db.prepare('INSERT INTO budgets(name,category,amount,due_day) VALUES(?,?,?,?)').run(name, category, Number(amount), dd).lastInsertRowid) };
}));
app.put('/api/budgets/:id', adminOnly, wrap((req) => {
  const b = db.prepare('SELECT * FROM budgets WHERE id=?').get(req.params.id);
  if (!b) fail(404, 'Not found');
  const n = { ...b, ...req.body };
  db.prepare('UPDATE budgets SET name=?, category=?, amount=?, due_day=?, active=? WHERE id=?')
    .run(n.name, n.category, Number(n.amount), Math.min(Math.max(parseInt(n.due_day, 10) || 1, 1), 31), n.active ? 1 : 0, b.id);
  return { ok: true };
}));
app.delete('/api/budgets/:id', adminOnly, wrap((req) => { db.prepare('UPDATE budgets SET active=0 WHERE id=?').run(req.params.id); return { ok: true }; }));
app.post('/api/budgets/:id/pay', adminOnly, wrap((req) => {
  const b = db.prepare('SELECT * FROM budgets WHERE id=?').get(req.params.id);
  if (!b) fail(404, 'Not found');
  const month = /^\d{4}-\d{2}$/.test(req.body.month || '') ? req.body.month : todayStr().slice(0, 7);
  const amount = Number(req.body.amount) > 0 ? Number(req.body.amount) : b.amount;
  if (db.prepare("SELECT 1 FROM expenses WHERE budget_id=? AND substr(date,1,7)=?").get(b.id, month)) fail(400, `${b.name} is already marked paid for ${month}`);
  const date = month === todayStr().slice(0, 7) ? todayStr() : `${month}-${pad(Math.min(b.due_day, 28))}`;
  db.prepare('INSERT INTO expenses(date,category,description,amount,mode,created_by,budget_id) VALUES(?,?,?,?,?,?,?)')
    .run(date, b.category, `${b.name} (${month})`, amount, req.body.mode || 'cash', req.user.id, b.id);
  return { ok: true };
}));
app.post('/api/reserve', adminOnly, wrap((req) => {
  const { date = todayStr(), amount, note = '' } = req.body;
  if (!(Number(amount) > 0)) fail(400, 'Enter the amount you are setting aside');
  return { id: Number(db.prepare('INSERT INTO reserve(date,amount,note,created_by) VALUES(?,?,?,?)').run(date, Number(amount), note, req.user.id).lastInsertRowid) };
}));
app.delete('/api/reserve/:id', adminOnly, wrap((req) => { db.prepare('DELETE FROM reserve WHERE id=?').run(req.params.id); return { ok: true }; }));
app.get('/api/planner', adminOnly, wrap((req) => {
  const now = todayStr();
  const month = /^\d{4}-\d{2}$/.test(req.query.month || '') ? req.query.month : now.slice(0, 7);
  const [y, m] = month.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const cur = month === now.slice(0, 7);
  const dayNow = cur ? Number(now.slice(8)) : month < now.slice(0, 7) ? daysInMonth : 0;
  const daysLeft = cur ? daysInMonth - dayNow + 1 : month > now.slice(0, 7) ? daysInMonth : 0;
  const items = db.prepare('SELECT * FROM budgets WHERE active=1 ORDER BY due_day, name').all().map((b) => {
    const paid = db.prepare("SELECT amount, date FROM expenses WHERE budget_id=? AND substr(date,1,7)=?").get(b.id, month);
    const due = Math.min(b.due_day, daysInMonth);
    let status = 'upcoming', days = null;
    if (paid) status = 'paid';
    else if (month < now.slice(0, 7) || (cur && due < dayNow)) status = 'overdue';
    else if (cur) { days = due - dayNow; status = days <= 3 ? 'soon' : 'upcoming'; }
    return { ...b, due, status, days_left: days, paid_amount: paid ? paid.amount : 0, paid_on: paid ? paid.date : null };
  });
  const fixed = items.reduce((s, b) => s + b.amount, 0);
  const paidTotal = items.reduce((s, b) => s + b.paid_amount, 0);
  const remaining = items.filter((b) => b.status !== 'paid').reduce((s, b) => s + b.amount, 0);
  const reserveRows = db.prepare("SELECT * FROM reserve WHERE substr(date,1,7)=? ORDER BY date DESC, id DESC").all(month);
  const setAside = reserveRows.reduce((s, r) => s + r.amount, 0);
  const stillNeeded = Math.max(remaining - setAside, 0);
  const dailyTarget = daysLeft > 0 ? stillNeeded / daysLeft : 0;
  const avg = db.prepare("SELECT COALESCE(SUM(taxable),0) t FROM orders WHERE status='paid' AND date(paid_at)>=date('now','localtime','-14 day')").get().t / 14;
  const sales = db.prepare("SELECT COALESCE(SUM(taxable),0) t FROM orders WHERE status='paid' AND substr(paid_at,1,7)=?").get(month).t;
  return {
    month, days_in_month: daysInMonth, days_left: daysLeft, items, fixed_total: round2(fixed), paid_total: round2(paidTotal),
    remaining: round2(remaining), set_aside: round2(setAside), still_needed: round2(stillNeeded), daily_target: round2(dailyTarget),
    avg_daily_sales: round2(avg), percent_of_sales: avg > 0 ? round2(dailyTarget / avg * 100) : null, sales_this_month: round2(sales),
    reserve: reserveRows,
  };
}));

app.get('/api/backup', adminOnly, (req, res) => {
  const fs = require('node:fs'), os = require('node:os');
  const tmp = path.join(os.tmpdir(), `mm-backup-${Date.now()}.db`);
  try {
    db.exec(`VACUUM INTO '${tmp.replaceAll("'", "''")}'`);
    res.download(tmp, `masala-mafia-backup-${todayStr()}.db`, () => fs.rm(tmp, () => {}));
  } catch (e) { console.error(e); res.status(500).json({ error: 'Backup failed' }); }
});
app.get('/api/expenses/export.csv', adminOnly, (req, res) => {
  const { from, to } = req.query;
  const esc = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;
  const rows = db.prepare('SELECT date, category, description, amount, mode FROM expenses WHERE date>=? AND date<=? ORDER BY date').all(from || '0000-01-01', to || '9999-12-31');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="expenses-${from}-to-${to}.csv"`);
  res.send(['Date,Category,Description,Amount,Mode', ...rows.map((r) => Object.values(r).map(esc).join(','))].join('\n'));
});

const addDays = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
function dueList() {
  const now = todayStr(), month = now.slice(0, 7), dim = new Date(Number(month.slice(0, 4)), Number(month.slice(5)), 0).getDate(), dayNow = Number(now.slice(8));
  return db.prepare('SELECT * FROM budgets WHERE active=1 ORDER BY due_day,name').all()
    .filter((b) => !db.prepare('SELECT 1 FROM expenses WHERE budget_id=? AND substr(date,1,7)=?').get(b.id, month))
    .map((b) => { const due = Math.min(b.due_day, dim); return { id: b.id, name: b.name, amount: b.amount, due, days: due - dayNow }; })
    .filter((b) => b.days <= 3);
}
app.get('/api/dashboard', adminOnly, wrap(() => {
  const today = todayStr(), mStart = today.slice(0, 8) + '01';
  const t = summary(today, today), m = summary(mStart, today);
  const days = []; for (let i = 6; i >= 0; i--) days.push(addDays(today, -i));
  const dm = Object.fromEntries(summary(days[0], today).daily.map((d) => [d.day, d]));
  const low = db.prepare('SELECT id,name,unit,qty,min_qty FROM inventory WHERE min_qty>0 AND qty<=min_qty ORDER BY name').all();
  const purchaseList = low.map((i) => {
    const used14 = db.prepare("SELECT COALESCE(SUM(-delta),0) u FROM stock_moves WHERE inventory_id=? AND delta<0 AND date(created_at)>=date('now','localtime','-14 day')").get(i.id).u;
    const dailyUse = used14 / 14;
    const target = Math.max(i.min_qty * 2, dailyUse * 7);
    const order = Math.max(0, Math.ceil((target - i.qty) * 10) / 10);
    return { id: i.id, name: i.name, unit: i.unit, qty: i.qty, min_qty: i.min_qty, daily_use: Math.round(dailyUse * 100) / 100, suggest_order: order };
  });
  return {
    now: new Date().toLocaleTimeString('en-IN', { hour12: false }),
    today: { total: t.totals.total, bills: t.totals.bills, byMode: t.byMode },
    month: { total: m.totals.total, bills: m.totals.bills, profit: m.profit, expenses: m.expenses },
    last7: days.map((day) => ({ day, total: dm[day]?.total || 0, bills: dm[day]?.bills || 0 })),
    top: summary(days[0], today).top.slice(0, 5),
    low_stock: low,
    purchase_list: purchaseList,
    open_orders: db.prepare("SELECT COUNT(*) n FROM orders WHERE status='open'").get().n,
    dues: dueList(),
    unpriced: db.prepare("SELECT COUNT(*) n FROM items WHERE price<=0 AND name NOT LIKE '% (sample)'").get().n,
  };
}));

app.get('/api/day-close', adminOnly, wrap((req) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : todayStr();
  const modes = { cash: 0, upi: 0, card: 0, online: 0 };
  for (const r of db.prepare("SELECT p.mode, SUM(p.amount) amount FROM payments p JOIN orders o ON o.id=p.order_id WHERE o.status='paid' AND date(o.paid_at)=? GROUP BY p.mode").all(date)) modes[r.mode] = r.amount;
  return {
    date, modes,
    bills: db.prepare("SELECT COUNT(*) n FROM orders WHERE status='paid' AND date(paid_at)=?").get(date).n,
    cash_expenses: db.prepare("SELECT COALESCE(SUM(amount),0) a FROM expenses WHERE date=? AND mode='cash'").get(date).a,
    open_orders: db.prepare("SELECT COUNT(*) n FROM orders WHERE status='open'").get().n,
    existing: db.prepare('SELECT * FROM day_close WHERE date=?').get(date) || null,
    recent: db.prepare('SELECT * FROM day_close ORDER BY date DESC LIMIT 10').all(),
  };
}));
app.post('/api/day-close', adminOnly, wrap((req) => {
  const { date, opening_float = 0, counted_cash, note = '' } = req.body;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !(Number(counted_cash) >= 0) || counted_cash === '' || counted_cash == null) fail(400, 'Enter the cash you counted in the drawer');
  const cashSales = db.prepare("SELECT COALESCE(SUM(p.amount),0) a FROM payments p JOIN orders o ON o.id=p.order_id WHERE o.status='paid' AND date(o.paid_at)=? AND p.mode='cash'").get(date).a;
  const cashExp = db.prepare("SELECT COALESCE(SUM(amount),0) a FROM expenses WHERE date=? AND mode='cash'").get(date).a;
  const expected = round2(Number(opening_float) + cashSales - cashExp);
  const counted = round2(Number(counted_cash));
  db.prepare(`INSERT INTO day_close(date,opening_float,expected_cash,counted_cash,difference,note,closed_by) VALUES(?,?,?,?,?,?,?)
    ON CONFLICT(date) DO UPDATE SET opening_float=excluded.opening_float, expected_cash=excluded.expected_cash, counted_cash=excluded.counted_cash,
    difference=excluded.difference, note=excluded.note, closed_by=excluded.closed_by, created_at=datetime('now','localtime')`)
    .run(date, Number(opening_float), expected, counted, round2(counted - expected), note, req.user.id);
  return db.prepare('SELECT * FROM day_close WHERE date=?').get(date);
}));

app.get('/api/tax-estimate', adminOnly, wrap((req) => {
  const n = new Date(); const y = Number(req.query.year) || (n.getMonth() >= 3 ? n.getFullYear() : n.getFullYear() - 1);
  const s = summary(`${y}-04-01`, `${y + 1}-03-31`);
  const total = s.byMode.reduce((a, m) => a + m.amount, 0);
  const cash = s.byMode.filter((m) => m.mode === 'cash').reduce((a, m) => a + m.amount, 0);
  const cashShare = total > 0 ? cash / total : 0;
  const turnover = s.income, limit = cashShare <= 0.05 ? 30000000 : 20000000;
  const digital = round2(turnover * (1 - cashShare)), cashPart = round2(turnover * cashShare);
  return { fy: `${y}-${String(y + 1).slice(2)}`, turnover, cash_share_pct: round2(cashShare * 100), limit, eligible: turnover <= limit,
    digital, cash_part: cashPart, presumptive_income: round2(digital * 0.06 + cashPart * 0.08), actual_profit: s.profit, expenses: s.expenses };
}));

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  autoBackup(); setInterval(autoBackup, 3600e3);
  app.listen(PORT, '0.0.0.0', () => console.log(`Masala Mafia Billing running on http://localhost:${PORT}`));
}
module.exports = app;
