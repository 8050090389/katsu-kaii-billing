// End-to-end API test on a throwaway database. Run: npm test
process.env.DB_PATH = require('node:path').join(require('node:os').tmpdir(), `kk-test-${Date.now()}.db`);
const assert = require('node:assert/strict');
const app = require('./server');

(async () => {
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}/api`;
  let token = '';
  const call = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    return { status: r.status, j };
  };
  const ok = (name) => console.log('  ✓', name);

  assert.equal((await call('GET', '/bootstrap')).status, 401); ok('rejects requests without login');
  assert.equal((await call('POST', '/login', { username: 'admin', password: 'wrong' })).status, 401); ok('rejects wrong password');
  token = (await call('POST', '/login', { username: 'admin', password: 'admin123' })).j.token;
  assert.ok(token); ok('admin login');

  const boot = (await call('GET', '/bootstrap')).j;
  const katsu = boot.items.find((i) => i.name === 'Chicken Katsu');   // ₹220
  const soda = boot.items.find((i) => i.name === 'Masala Soda');      // ₹60
  const tbl = boot.tables[0].id;

  // Dine-in: 2×220 + 1×60 = 500, 5% GST = 25 (12.50 + 12.50), total 525
  let o = (await call('POST', '/orders', { type: 'dinein', table_id: tbl, items: [{ item_id: katsu.id, qty: 2 }, { item_id: soda.id, qty: 1 }] })).j;
  assert.equal(o.subtotal, 500); assert.equal(o.cgst, 12.5); assert.equal(o.sgst, 12.5); assert.equal(o.total, 525); ok('dine-in GST 5% = 2.5% CGST + 2.5% SGST');

  // client-supplied price must be ignored for menu items
  o = (await call('POST', '/orders', { id: o.id, type: 'dinein', table_id: tbl, items: [{ item_id: katsu.id, qty: 2, price: 1 }, { item_id: soda.id, qty: 1 }] })).j;
  assert.equal(o.subtotal, 500); ok('server uses menu price, not client price');

  // Discount + rounding: 500-33=467 → GST 23.35 → 490.35 → rounds to 490, round_off -0.35
  o = (await call('POST', '/orders', { id: o.id, type: 'dinein', table_id: tbl, discount: 33, items: [{ item_id: katsu.id, qty: 2 }, { item_id: soda.id, qty: 1 }] })).j;
  assert.equal(o.taxable, 467); assert.equal(o.total, 490); assert.equal(o.round_off, -0.35); ok('discount and rounding to nearest rupee');

  // KOT only sends new items the second time
  let k = (await call('POST', `/orders/${o.id}/kot`)).j; assert.equal(k.items.length, 2);
  o = (await call('POST', '/orders', { id: o.id, type: 'dinein', table_id: tbl, discount: 33, items: [{ item_id: katsu.id, qty: 3 }, { item_id: soda.id, qty: 1 }] })).j;
  k = (await call('POST', `/orders/${o.id}/kot`)).j; assert.deepEqual(k.items, [{ name: 'Chicken Katsu', qty: 1 }]); ok('KOT prints only newly added items');

  // payments must match the total
  o = (await call('GET', `/orders/${o.id}`)).j;
  assert.equal((await call('POST', `/orders/${o.id}/pay`, { payments: [{ mode: 'cash', amount: 1 }] })).status, 400); ok('short payment rejected');
  const half = Math.round(o.total / 2 * 100) / 100;
  const paid = (await call('POST', `/orders/${o.id}/pay`, { payments: [{ mode: 'cash', amount: half }, { mode: 'upi', amount: Math.round((o.total - half) * 100) / 100 }] })).j;
  assert.match(paid.bill_no, /^KK\/\d{4}-\d{2}\/0001$/); assert.equal(paid.status, 'paid'); ok('split cash+UPI payment, bill no ' + paid.bill_no);
  assert.equal((await call('POST', '/orders', { id: o.id, type: 'dinein', table_id: tbl, items: [{ item_id: soda.id, qty: 1 }] })).status, 400); ok('paid bill cannot be edited');

  // Zomato order: no GST by default
  const z = (await call('POST', '/orders', { type: 'aggregator', platform: 'Zomato', platform_ref: 'Z123', items: [{ item_id: katsu.id, qty: 1 }] })).j;
  assert.equal(z.cgst + z.sgst, 0); assert.equal(z.total, 220);
  const zp = (await call('POST', `/orders/${z.id}/pay`, { payments: [{ mode: 'online', amount: 220 }] })).j;
  assert.match(zp.bill_no, /0002$/); ok('Zomato order has no GST and bill number increments');

  // Expenses + reports
  const d = new Date().toISOString().slice(0, 10);
  await call('POST', '/expenses', { date: d, category: 'Rent', amount: 100, description: 'test' });
  const rep = (await call('GET', `/reports/summary?from=${d}&to=${d}`)).j;
  assert.equal(rep.totals.bills, 2);
  assert.equal(rep.totals.total, paid.total + 220);
  assert.equal(rep.expenses, 100);
  assert.equal(rep.profit, Math.round((rep.income - 100) * 100) / 100);
  const modes = Object.fromEntries(rep.byMode.map((m) => [m.mode, m.amount]));
  assert.ok(modes.cash && modes.upi && modes.online === 220); ok('report: bills, payment modes, expenses, profit');
  assert.ok((await call('GET', `/reports/fy`)).j.fy); ok('financial-year summary');

  // Inventory
  const inv = (await call('POST', '/inventory', { name: 'Chicken', unit: 'kg', qty: 10, min_qty: 3, cost: 220 })).j;
  assert.equal((await call('POST', `/inventory/${inv.id}/move`, { delta: -4 })).j.qty, 6);
  assert.equal((await call('POST', `/inventory/${inv.id}/move`, { delta: -50 })).status, 400); ok('inventory in/out, cannot go negative');

  // Recipes: paying a bill reduces stock automatically
  const chk = (await call('POST', '/inventory', { name: 'Panko', unit: 'kg', qty: 5, min_qty: 1, cost: 100 })).j;
  assert.equal((await call('POST', '/recipes', { item_id: katsu.id, inventory_id: chk.id, qty: 0.25 })).status, 200);
  const ro = (await call('POST', '/orders', { type: 'takeaway', items: [{ item_id: katsu.id, qty: 2 }] })).j;
  await call('POST', `/orders/${ro.id}/pay`, { payments: [{ mode: 'cash', amount: ro.total }] });
  assert.equal((await call('GET', '/inventory')).j.find((i) => i.id === chk.id).qty, 4.5); ok('recipe deducts stock when bill is paid (2 x 0.25kg)');

  // Monthly planner
  const rent = (await call('POST', '/budgets', { name: 'Shop rent', category: 'Rent', amount: 30000, due_day: 5 })).j;
  await call('POST', '/budgets', { name: 'Electricity', category: 'Electricity', amount: 6000, due_day: 28 });
  let pl = (await call('GET', '/planner')).j;
  assert.equal(pl.fixed_total, 36000); assert.equal(pl.remaining, 36000); ok('planner totals fixed monthly costs');
  await call('POST', '/reserve', { amount: 10000, note: 'week 1' });
  pl = (await call('GET', '/planner')).j;
  assert.equal(pl.set_aside, 10000); assert.equal(pl.still_needed, 26000); assert.ok(pl.daily_target > 0); ok('set-aside reduces what is still needed');
  assert.equal((await call('POST', `/budgets/${rent.id}/pay`, { amount: 30000 })).status, 200);
  assert.equal((await call('POST', `/budgets/${rent.id}/pay`, { amount: 30000 })).status, 400); ok('mark paid once per month');
  pl = (await call('GET', '/planner')).j;
  assert.equal(pl.paid_total, 30000); assert.equal(pl.remaining, 6000);
  const exp = (await call('GET', `/expenses?from=${d}&to=${d}`)).j;
  assert.ok(exp.some((e) => e.category === 'Rent' && e.amount === 30000)); ok('paid bill appears in Expenses');

  // Backup
  const bk = await fetch(base + '/backup', { headers: { Authorization: 'Bearer ' + token } });
  const buf = Buffer.from(await bk.arrayBuffer());
  assert.equal(bk.status, 200); assert.equal(buf.slice(0, 15).toString(), 'SQLite format 3'); ok('backup downloads a valid database file');

  // Dashboard, day close, tax estimate, default password
  const dash = (await call('GET', '/dashboard')).j;
  assert.ok(dash.today.bills >= 2); assert.equal(dash.last7.length, 7); assert.ok(Array.isArray(dash.low_stock)); ok('dashboard: today, last 7 days, alerts');
  const dc0 = (await call('GET', `/day-close?date=${d}`)).j;
  assert.ok(dc0.modes.cash > 0 && dc0.modes.online === 220); ok('day close shows cash/UPI/platform totals');
  const dcs = (await call('POST', '/day-close', { date: d, opening_float: 1000000, counted_cash: 1000000 + dc0.modes.cash - dc0.cash_expenses - 10 })).j;
  assert.equal(dcs.difference, -10); ok('day close finds a Rs 10 shortage');
  assert.equal((await call('POST', '/day-close', { date: d, counted_cash: '' })).status, 400); ok('day close needs a counted amount');
  const tax = (await call('GET', '/tax-estimate')).j;
  assert.ok(tax.eligible); assert.equal(tax.presumptive_income, Math.round((tax.digital * 0.06 + tax.cash_part * 0.08) * 100) / 100);
  assert.ok(tax.cash_share_pct > 0 && tax.limit === 20000000); ok('44AD estimate: 6% digital + 8% cash');
  assert.equal((await call('GET', '/bootstrap')).j.default_password, true); ok('warns while admin password is still default');

  // Menu import and bulk prices
  const st0 = (await call('GET', '/menu/import-status')).j;
  assert.equal(st0.total, 43); assert.equal(st0.missing, 42); assert.equal(st0.samples, 6); ok('import-status counts the 43 menu dishes');
  const imp = (await call('POST', '/menu/import', { hide_samples: true })).j;
  assert.equal(imp.hidden, 6); assert.equal(imp.added, 43); ok(`menu imported: ${imp.added} dishes added, ${imp.hidden} samples hidden`);
  const imp2 = (await call('POST', '/menu/import', { hide_samples: true })).j;
  assert.equal(imp2.added, 0); assert.equal(imp2.hidden, 0); ok('importing twice adds nothing');
  const allItems = (await call('GET', '/items/all')).j;
  const ck = allItems.find((i) => i.name === 'Chicken Katsu' && i.price === 0);
  assert.ok(ck && ck.active === 0 && ck.veg === 0); ok('real Chicken Katsu added hidden, price 0, non-veg');
  assert.equal(allItems.find((i) => i.name === 'Sichuan Paneer').veg, 1); assert.ok(allItems.some((i) => i.name === 'Hot Pot - Mutton')); ok('chicken/paneer variants split, hot pot variants present');
  assert.equal((await call('POST', '/orders', { type: 'takeaway', items: [{ item_id: ck.id, qty: 1 }] })).status, 400); ok('a dish with no price cannot be billed');
  const sp = (await call('POST', '/items/bulk', { items: [{ id: ck.id, price: '240', veg: 0 }, { id: allItems.find((i) => i.name === 'Tiramisu').id, price: 180 }] })).j;
  assert.equal(sp.changed, 2);
  const after = (await call('GET', '/items/all')).j;
  assert.equal(after.find((i) => i.id === ck.id).active, 1); assert.equal(after.find((i) => i.id === ck.id).price, 240); ok('saving a price makes the dish live');
  const bill = (await call('POST', '/orders', { type: 'takeaway', items: [{ item_id: ck.id, qty: 1 }] })).j; assert.equal(bill.subtotal, 240); ok('newly priced dish can be billed');
  assert.ok((await call('GET', '/dashboard')).j.unpriced > 40); ok('dashboard counts dishes without a price');

  // Cashier role restrictions
  await call('POST', '/users', { name: 'Ravi', username: 'ravi', password: 'ravi123', role: 'cashier' });
  token = (await call('POST', '/login', { username: 'ravi', password: 'ravi123' })).j.token;
  assert.equal((await call('GET', `/reports/summary`)).status, 403);
  assert.equal((await call('POST', '/items', { name: 'x', price: 1 })).status, 403);
  assert.equal((await call('GET', '/planner')).status, 403);
  assert.equal((await call('GET', '/backup')).status, 403);
  assert.equal((await call('GET', '/dashboard')).status, 403); assert.equal((await call('GET', '/day-close')).status, 403); assert.equal((await call('GET', '/tax-estimate')).status, 403);
  assert.equal((await call('GET', '/expenses')).status, 403); ok('cashier cannot see reports/expenses or edit the menu');
  assert.equal((await call('POST', '/orders', { type: 'takeaway', items: [{ item_id: soda.id, qty: 1 }] })).status, 200); ok('cashier can bill');

  srv.close(); console.log('\nAll tests passed.'); process.exit(0);
})().catch((e) => { console.error('\nFAILED:', e); process.exit(1); });
