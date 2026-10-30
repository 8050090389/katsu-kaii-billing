'use strict';
const $ = (s, el = document) => el.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = (n) => '₹' + (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const monthStart = () => today().slice(0, 8) + '01';

const S = { token: localStorage.getItem('kk_token'), user: null, settings: {}, categories: [], items: [], tables: [], offers: [], view: 'counter', cat: 0, q: '', cart: null, open: [] };
const newCart = () => ({ id: null, type: 'dinein', table_id: null, platform: '', platform_ref: '', items: [], discount: 0, customer_name: '', customer_phone: '', note: '' });

function toast(msg, err) {
  const t = $('#toast'); t.textContent = msg; t.className = 'show' + (err ? ' err' : '');
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.className = ''), 2600);
}
async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(S.token ? { Authorization: 'Bearer ' + S.token } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && path !== '/login') { logout(); throw new Error('Please log in again'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}
async function download(path, filename) {
  const res = await fetch('/api' + path, { headers: { Authorization: 'Bearer ' + S.token } });
  if (!res.ok) throw new Error('Download failed');
  const a = document.createElement('a'); a.href = URL.createObjectURL(await res.blob()); a.download = filename; a.click();
}
const guard = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };
function logout() { localStorage.removeItem('kk_token'); S.token = null; S.user = null; render(); }
const isAdmin = () => S.user?.role === 'admin';

async function boot() {
  if (!S.token) return render();
  try {
    const b = await api('/bootstrap');
    Object.assign(S, { user: b.user, settings: b.settings, categories: b.categories, items: b.items, tables: b.tables, offers: b.offers || [] });
    S.cart = newCart(); S.defaultPw = !!b.default_password;
    S.view = b.user.role === 'admin' ? 'dashboard' : 'counter';
    await refreshOpen();
  } catch { S.token = null; }
  render();
}
async function refreshOpen() { try { S.open = await api('/orders?status=open'); } catch {} }
async function reloadMenu() {
  const b = await api('/bootstrap');
  Object.assign(S, { settings: b.settings, categories: b.categories, items: b.items, tables: b.tables, offers: b.offers || [] });
}

function renderLogin() {
  $('#app').innerHTML = `<div class="login card"><h1>Masala Mafia Billing</h1><p class="muted">Sign in to continue</p>
    <label class="f">Username</label><input id="u" autocapitalize="none" autocomplete="username">
    <label class="f">Password</label><input id="p" type="password" autocomplete="current-password">
    <p></p><button class="primary" style="width:100%" id="go">Log in</button></div>`;
  const go = guard(async () => {
    const r = await api('/login', { method: 'POST', body: { username: $('#u').value.trim(), password: $('#p').value } });
    S.token = r.token; localStorage.setItem('kk_token', r.token); await boot();
  });
  $('#go').onclick = go; $('#p').onkeydown = (e) => { if (e.key === 'Enter') go(); };
}

const TABS = [
  ['dashboard', 'Dashboard', 1],
  ['counter', 'Counter'],
  ['offers', 'Offer Zone'],
  ['orders', 'Open orders'],
  ['bills', 'Bills'],
  ['inventory', 'Inventory'],
  ['menu', 'Menu', 1],
  ['offers_admin', 'Manage offers', 1],
  ['expenses', 'Expenses', 1],
  ['planner', 'Monthly planner', 1],
  ['dayclose', 'Day close', 1],
  ['reports', 'Reports', 1],
  ['settings', 'Settings', 1],
];
function visibleTabs() {
  return TABS.filter(([k, , adminOnly]) => {
    if (adminOnly && !isAdmin()) return false;
    if (k === 'offers' && isAdmin()) return false;
    return true;
  });
}
function render() {
  if (!S.token || !S.user) return renderLogin();
  const tabs = visibleTabs().map(([k, l]) => `<button data-v="${k}" class="${S.view === k ? 'on' : ''}">${l}${k === 'orders' && S.open.length ? ` (${S.open.length})` : ''}</button>`).join('');
  $('#app').innerHTML = `<div class="top"><div class="brand">Masala Mafia Billing<small>${esc(S.settings.restaurant_name)}</small></div>${tabs}<span class="sp"></span><button id="lo">Logout (${esc(S.user.name)})</button></div>${S.defaultPw && isAdmin() ? '<div class="banner">Your admin password is still the default (admin123). Anyone can guess it. <button class="small primary" id="bnb">Change it now</button></div>' : ''}<div class="main" id="main"></div>`;
  if ($('#bnb')) $('#bnb').onclick = () => { S.view = 'settings'; render(); };
  document.querySelectorAll('.top [data-v]').forEach((b) => (b.onclick = async () => { S.view = b.dataset.v; await refreshOpen(); render(); }));
  $('#lo').onclick = logout;
  ({
    dashboard: vDashboard, dayclose: vDayClose, counter: vCounter, offers: vOffersCounter,
    orders: vOrders, bills: vBills, inventory: vInventory, menu: vMenu,
    offers_admin: vOffersAdmin, expenses: vExpenses, planner: vPlanner, reports: vReports, settings: vSettings,
  })[S.view]();
}

function eligibleOffersForItem(itemId) {
  if (S.settings.offer_zone_on !== '1') return [];
  const cat = S.items.find((i) => i.id === itemId)?.category_id;
  return (S.offers || []).filter((o) => {
    if (o.type === 'item_percent' && o.item_id === itemId) return true;
    if (o.type === 'category_percent' && o.category_id === cat) return true;
    return false;
  });
}
function offerBadgeFor(itemId) {
  const match = eligibleOffersForItem(itemId)[0];
  if (!match) return '';
  if (match.type === 'item_percent' || match.type === 'category_percent') return `<span class="offer-badge">${match.percent}% OFF</span>`;
  return '';
}
function clientOfferDiscount(items, subtotal, type) {
  if (S.settings.offer_zone_on !== '1') return { discount: 0, offer: null };
  if (type === 'aggregator') return { discount: 0, offer: null };
  let best = { discount: 0, offer: null };
  for (const o of (S.offers || [])) {
    let d = 0;
    if (o.type === 'category_percent') {
      const catSub = items.filter((it) => it.item_id && S.items.find((x) => x.id === it.item_id)?.category_id === o.category_id).reduce((s, it) => s + it.price * it.qty, 0);
      d = Math.round(catSub * (o.percent || 0)) / 100;
    } else if (o.type === 'item_percent') {
      const itemSub = items.filter((it) => it.item_id === o.item_id).reduce((s, it) => s + it.price * it.qty, 0);
      d = Math.round(itemSub * (o.percent || 0)) / 100;
    } else if (o.type === 'bill_flat') {
      if (subtotal >= (o.min_bill || 0)) d = o.flat_amount || 0;
    } else if (o.type === 'combo') {
      const ids = o.combo_item_ids || [];
      if (ids.length && ids.every((id) => items.some((it) => it.item_id === id))) {
        const orig = ids.reduce((s, id) => { const line = items.find((it) => it.item_id === id); return s + (line ? line.price * line.qty : 0); }, 0);
        d = Math.max(0, orig - (o.combo_price || 0) * ids.length);
      }
    }
    if (d > best.discount) best = { discount: Math.round(d * 100) / 100, offer: o };
  }
  return best;
}

function cartTotals() {
  const c = S.cart; const sub = c.items.reduce((s, i) => s + i.price * i.qty, 0);
  const disc = Math.min(Math.max(Number(c.discount) || 0, 0), sub);
  const offerBest = clientOfferDiscount(c.items, sub, c.type);
  const offerDisc = Math.min(Math.max(offerBest.discount || 0, 0), sub - disc);
  const taxable = sub - disc - offerDisc;
  const rate = c.type === 'aggregator' && S.settings.aggregator_gst !== '1' ? 0 : Number(S.settings.gst_rate) || 0;
  const gst = Math.round(taxable * rate) / 100; const cgst = Math.round(gst * 50) / 100; const sgst = Math.round((gst - cgst) * 100) / 100;
  const exact = taxable + cgst + sgst; const total = Math.round(exact);
  return { sub, disc, offerDisc, offerName: offerBest.offer?.name || '', taxable, rate, cgst, sgst, round: total - exact, total };
}
function totalsHtml(t) {
  return `<div><span>Subtotal</span><span>${inr(t.sub)}</span></div>${t.disc ? `<div><span>Discount</span><span>−${inr(t.disc)}</span></div>` : ''}
       ${t.offerDisc ? `<div class="offer-line"><span>Offer: ${esc(t.offerName)}</span><span>−${inr(t.offerDisc)}</span></div>` : ''}
       ${t.rate ? `<div><span>CGST ${t.rate / 2}%</span><span>${inr(t.cgst)}</span></div><div><span>SGST ${t.rate / 2}%</span><span>${inr(t.sgst)}</span></div>` : ''}
       ${t.round ? `<div><span>Round off</span><span>${t.round.toFixed(2)}</span></div>` : ''}<div class="g"><span>Total</span><span>${inr(t.total)}</span></div>`;
}
function vCounter() {
  const c = S.cart; const busy = new Set(S.open.filter((o) => o.id !== c.id).map((o) => o.table_id));
  const visible = S.items.filter((i) => (!S.cat || i.category_id === S.cat) && (!S.q || i.name.toLowerCase().includes(S.q.toLowerCase())));
  const t = cartTotals();
  $('#main').innerHTML = `<div class="pos">
   <div class="menu"><input id="q" placeholder="Search item…" value="${esc(S.q)}" style="margin-bottom:8px">
     <div class="chips"><button class="chip ${!S.cat ? 'on' : ''}" data-c="0">All</button>${S.categories.map((x) => `<button class="chip ${S.cat === x.id ? 'on' : ''}" data-c="${x.id}">${esc(x.name)}</button>`).join('')}</div>
     <div class="items">${visible.map((i) => `<button class="item" data-i="${i.id}"><span><span class="dot ${i.veg ? '' : 'nv'}"></span>${esc(i.name)}${offerBadgeFor(i.id)}</span><small>${inr(i.price)}</small></button>`).join('') || '<p class="muted">No dishes are live yet. Admin: open Menu, load the menu and set prices.</p>'}</div></div>
   <div class="cart">
     <div class="seg"><button data-t="dinein" class="${c.type === 'dinein' ? 'on' : ''}">Dine-in</button><button data-t="takeaway" class="${c.type === 'takeaway' ? 'on' : ''}">Takeaway</button><button data-t="aggregator" class="${c.type === 'aggregator' ? 'on' : ''}">Zomato/Swiggy</button></div>
     ${c.type === 'dinein' ? `<div class="tables">${S.tables.map((x) => `<button data-tb="${x.id}" class="${c.table_id === x.id ? 'on' : busy.has(x.id) ? 'busy' : ''}">${esc(x.name)}</button>`).join('')}</div>` : ''}
     ${c.type === 'aggregator' ? `<div class="row" style="margin:8px 0"><select id="plat">${['', 'Zomato', 'Swiggy', 'Magicpin', 'Other'].map((p) => `<option value="${p}" ${c.platform === p ? 'selected' : ''}>${p || 'Choose platform'}</option>`).join('')}</select><input id="pref" placeholder="Platform order ID" value="${esc(c.platform_ref)}"></div>` : ''}
     <div class="lines">${c.items.map((i, ix) => `<div class="line"><div>${esc(i.name)}<div class="muted" style="font-size:12px">${inr(i.price)}</div></div><div class="qty"><button data-m="${ix}">−</button><b>${i.qty}</b><button data-p="${ix}">+</button></div><b>${inr(i.price * i.qty)}</b></div>`).join('') || '<p class="muted" style="text-align:center;margin-top:30px">Tap items to add</p>'}</div>
     <div class="row" style="margin-bottom:6px"><input id="disc" type="number" min="0" placeholder="Discount ₹" value="${c.discount || ''}"><input id="cn" placeholder="Customer name / phone (optional)" value="${esc(c.customer_name)}"></div>
     <div class="tot" id="tot">${totalsHtml(t)}</div>
     <div class="row" style="margin-top:8px"><button id="clr" class="fit">Clear</button><button id="kot">Save + KOT</button><button id="pay" class="primary">Pay</button></div>
   </div></div>`;
  $('#q').oninput = (e) => { S.q = e.target.value; const p = e.target.selectionStart; vCounter(); const q = $('#q'); q.focus(); q.setSelectionRange(p, p); };
  document.querySelectorAll('[data-c]').forEach((b) => (b.onclick = () => { S.cat = Number(b.dataset.c); vCounter(); }));
  document.querySelectorAll('[data-i]').forEach((b) => (b.onclick = () => {
    const it = S.items.find((x) => x.id == b.dataset.i); const ex = c.items.find((x) => x.item_id === it.id);
    ex ? ex.qty++ : c.items.push({ item_id: it.id, name: it.name, price: it.price, qty: 1 }); vCounter();
  }));
  document.querySelectorAll('[data-p]').forEach((b) => (b.onclick = () => { c.items[b.dataset.p].qty++; vCounter(); }));
  document.querySelectorAll('[data-m]').forEach((b) => (b.onclick = () => { const i = c.items[b.dataset.m]; if (--i.qty <= 0) c.items.splice(b.dataset.m, 1); vCounter(); }));
  document.querySelectorAll('[data-t]').forEach((b) => (b.onclick = () => { c.type = b.dataset.t; vCounter(); }));
  document.querySelectorAll('[data-tb]').forEach((b) => (b.onclick = guard(async () => {
    const id = Number(b.dataset.tb); const ex = S.open.find((o) => o.table_id === id);
    if (ex && c.items.length === 0 && c.id !== ex.id) {
      toast('Table ' + b.textContent + ' already has an open bill. Open it from the Open orders tab.', true);
      return;
    }
    c.table_id = id; vCounter();
  })));
  const pl = $('#plat'); if (pl) { pl.onchange = () => (c.platform = pl.value); $('#pref').oninput = (e) => (c.platform_ref = e.target.value); }
  $('#disc').oninput = (e) => { c.discount = e.target.value; $('#tot').innerHTML = totalsHtml(cartTotals()); };
  $('#cn').oninput = (e) => (c.customer_name = e.target.value);
  $('#clr').onclick = () => { S.cart = newCart(); S.cat = 0; S.q = ''; vCounter(); };
  $('#kot').onclick = guard(async () => { const o = await saveCart(); const k = await api(`/orders/${o.id}/kot`, { method: 'POST' }); await refreshOpen(); printKot(k); toast('Sent to kitchen'); S.cart = newCart(); render(); });
  $('#pay').onclick = guard(async () => { const o = await saveCart(); await refreshOpen(); payModal(o); });
}
async function saveCart() {
  const c = S.cart; const o = await api('/orders', { method: 'POST', body: c });
  c.id = o.id; return o;
}
async function loadIntoCart(id) {
  const o = await api('/orders/' + id);
  S.cart = { id: o.id, type: o.type, table_id: o.table_id, platform: o.platform || '', platform_ref: o.platform_ref || '', discount: o.discount, customer_name: o.customer_name || '', customer_phone: o.customer_phone || '', note: o.note || '', items: o.items.map((i) => ({ item_id: i.item_id, name: i.name, price: i.price, qty: i.qty })) };
  S.view = 'counter'; render();
}

function payModal(order) {
  const m = document.createElement('div'); m.className = 'modal';
  const modes = [['cash', 'Cash'], ['upi', 'UPI'], ['card', 'Card'], ['online', 'Platform / Online']];
  const isAgg = order.type === 'aggregator';
  const offerLine = order.offer_discount > 0 ? `<p class="muted" style="margin:4px 0 8px">Offer applied: −${inr(order.offer_discount)}</p>` : '';
  m.innerHTML = `<div><h3>Collect ${inr(order.total)}</h3>
    <p class="muted">${order.type === 'dinein' ? 'Table ' + esc(order.table_name || '') : order.type === 'aggregator' ? esc(order.platform) + ' order' : 'Takeaway'} · ${order.items.length} items</p>
    ${offerLine}
    <p class="muted" style="font-size:12px;margin:0 0 8px">Type the amount you got, then tap <b>Fill</b> next to the mode that should take the balance. You choose — nothing fills by itself.</p>
    <div id="pm">${modes.map(([k, l]) => `<div class="row" style="margin-bottom:6px;align-items:center"><span style="flex:0 0 120px">${l}</span><input data-m="${k}" type="number" min="0" step="0.01" placeholder="0" value="${(isAgg ? k === 'online' : k === 'cash') ? order.total : ''}"><button type="button" class="small fit fill-btn" data-fill="${k}">Fill</button></div>`).join('')}</div>
    <div id="chg" class="muted" style="margin:6px 0"></div>
    <div class="row"><button id="x" class="fit">Back</button><button id="ok" class="ok">Confirm & print bill</button></div></div>`;
  document.body.appendChild(m);
  const sum = () => [...m.querySelectorAll('[data-m]')].reduce((s, i) => s + (Number(i.value) || 0), 0);
  const upd = () => {
    const total = sum();
    const d = total - order.total;
    $('#chg').textContent = Math.abs(d) < 0.01 ? 'Amount matches ✓' : d > 0 ? `Received ${inr(total)} · return ${inr(d)} (cash)` : `Short by ${inr(-d)}`;
  };
  m.querySelectorAll('[data-m]').forEach((i) => (i.oninput = upd));
  m.querySelectorAll('[data-fill]').forEach((b) => (b.onclick = () => {
    const key = b.dataset.fill;
    const target = m.querySelector(`[data-m="${key}"]`);
    const others = [...m.querySelectorAll('[data-m]')].filter((i) => i !== target).reduce((s, i) => s + (Number(i.value) || 0), 0);
    const remaining = Math.round((order.total - others) * 100) / 100;
    target.value = remaining > 0 ? remaining : '';
    upd();
  }));
  upd();
  m.onclick = (e) => e.target === m && m.remove(); $('#x', m).onclick = () => m.remove();
  $('#ok', m).onclick = guard(async () => {
    let pays = [...m.querySelectorAll('[data-m]')].map((i) => ({ mode: i.dataset.m, amount: Number(i.value) || 0 })).filter((p) => p.amount > 0);
    const over = pays.reduce((s, p) => s + p.amount, 0) - order.total;
    const cash = pays.find((p) => p.mode === 'cash');
    if (over > 0.01 && cash && cash.amount >= over) cash.amount = Math.round((cash.amount - over) * 100) / 100;
    pays = pays.filter((p) => p.amount > 0);
    const paid = await api(`/orders/${order.id}/pay`, { method: 'POST', body: { payments: pays } });
    m.remove(); await refreshOpen(); printBill(paid); toast('Bill ' + paid.bill_no + ' paid'); S.cart = newCart(); render();
  });
}

function printHtml(html) {
  const r = $('#receipt'); const w = S.settings.paper_width === '58' ? '58' : '80';
  r.className = 'w' + w; r.style.setProperty('--paper', w + 'mm'); r.innerHTML = html;
  setTimeout(() => window.print(), 80);
}
function printBill(o) {
  const s = S.settings; const dt = (o.paid_at || '').replace(' ', '  ');
  const pays = o.payments.map((p) => `<div class="tr"><span>${p.mode.toUpperCase()}</span><span>${Number(p.amount).toFixed(2)}</span></div>`).join('');
  printHtml(`<h2>${esc(s.restaurant_name)}</h2><div class="c">${esc(s.tagline)}</div><div class="c">${esc(s.address)}</div>
    ${s.phone ? `<div class="c">Ph: ${esc(s.phone)}</div>` : ''}${s.gstin ? `<div class="c">GSTIN: ${esc(s.gstin)}</div>` : ''}${s.fssai ? `<div class="c">FSSAI: ${esc(s.fssai)}</div>` : ''}
    <hr><div class="tr"><span>Bill: ${esc(o.bill_no)}</span><span>${o.type === 'dinein' ? 'Table ' + esc(o.table_name) : o.type === 'aggregator' ? esc(o.platform) : 'Takeaway'}</span></div>
    <div>${esc(dt)}</div>${o.platform_ref ? `<div>Order ID: ${esc(o.platform_ref)}</div>` : ''}${o.customer_name ? `<div>Cust: ${esc(o.customer_name)}</div>` : ''}<div>Cashier: ${esc(o.cashier || '')}</div><hr>
    <table><tr><th>Item</th><th class="r">Qty</th><th class="r">Rate</th><th class="r">Amt</th></tr>
    ${o.items.map((i) => `<tr><td>${esc(i.name)}</td><td class="r">${i.qty}</td><td class="r">${i.price.toFixed(2)}</td><td class="r">${(i.qty * i.price).toFixed(2)}</td></tr>`).join('')}</table><hr>
    <div class="tr"><span>Subtotal</span><span>${o.subtotal.toFixed(2)}</span></div>
    ${o.discount ? `<div class="tr"><span>Discount</span><span>-${o.discount.toFixed(2)}</span></div>` : ''}
    ${o.offer_discount ? `<div class="tr"><span>Offer${o.offer_applications && o.offer_applications[0] ? ' (' + esc(o.offer_applications[0].offer_name) + ')' : ''}</span><span>-${o.offer_discount.toFixed(2)}</span></div>` : ''}
    ${o.gst_rate ? `<div class="tr"><span>CGST ${o.gst_rate / 2}%</span><span>${o.cgst.toFixed(2)}</span></div><div class="tr"><span>SGST ${o.gst_rate / 2}%</span><span>${o.sgst.toFixed(2)}</span></div>` : ''}
    ${o.round_off ? `<div class="tr"><span>Round off</span><span>${o.round_off.toFixed(2)}</span></div>` : ''}
    <hr><div class="tr b"><span>TOTAL</span><span>₹${o.total.toFixed(2)}</span></div><hr>${pays}
    ${!o.gst_rate && o.type === 'aggregator' ? '<div class="c">GST collected & paid by platform</div>' : ''}
    <hr><div class="c">${esc(s.bill_footer)}</div>`);
}
function printKot(k) {
  if (!k.items.length) return toast('No new items for kitchen');
  const where = k.order.type === 'dinein' ? 'TABLE ' + esc(k.order.table_name) : k.order.type === 'aggregator' ? esc(k.order.platform) + ' ' + esc(k.order.platform_ref || '') : 'TAKEAWAY';
  printHtml(`<h2>KOT #${k.order.id}</h2><div class="c b">${where}</div><div class="c">${new Date().toLocaleString('en-IN')}</div><hr>
    <table>${k.items.map((i) => `<tr><td class="b">${esc(i.name)}</td><td class="r b">× ${i.qty}</td></tr>`).join('')}</table><hr>`);
}

async function vOffersCounter() {
  const data = await api('/active-offers?type=' + (S.cart?.type || 'dinein'));
  const catName = (id) => S.categories.find((c) => c.id === id)?.name || '—';
  const itemName = (id) => S.items.find((i) => i.id === id)?.name || '—';
  const describe = (o) => {
    if (o.type === 'category_percent') return `${o.percent}% off all <b>${esc(catName(o.category_id))}</b>`;
    if (o.type === 'item_percent') return `${o.percent}% off <b>${esc(itemName(o.item_id))}</b>`;
    if (o.type === 'bill_flat') return `₹${o.flat_amount} off bills above ₹${o.min_bill}`;
    if (o.type === 'combo') { const names = (o.combo_item_ids || []).map(itemName).map(esc).join(' + '); return `Combo <b>${names}</b> for ₹${o.combo_price}`; }
    return o.name;
  };
  const zoneOff = data.zone_on === false || S.settings.offer_zone_on !== '1';
  $('#main').innerHTML = `<div class="card"><h3>Offer Zone</h3>
    <p class="muted">Live offers at Katsu Kaii. Discounts are applied automatically when a bill matches.</p>
    ${zoneOff ? '<p class="banner" style="margin-top:10px">Offer Zone is currently OFF. Admin can turn it on in Settings.</p>'
    : data.offers.length ? `<div class="offer-list">${data.offers.map((o) => `<div class="offer-card"><div class="offer-title">${esc(o.name)}</div><div class="offer-desc">${describe(o)}</div></div>`).join('')}</div>`
    : '<p class="muted" style="margin-top:10px">No active offers right now.</p>'}
  </div>`;
}

async function vOffersAdmin() {
  const offers = await api('/offers');
  const cats = S.categories, items = S.items;
  const zoneOn = S.settings.offer_zone_on === '1';
  const typeLabel = { category_percent: 'Category % off', item_percent: 'Item % off', bill_flat: 'Flat ₹ off bill', combo: 'Combo price' };
  const describe = (o) => {
    if (o.type === 'category_percent') return `${o.percent}% off ${cats.find((c) => c.id === o.category_id)?.name || '?'}`;
    if (o.type === 'item_percent') return `${o.percent}% off ${items.find((i) => i.id === o.item_id)?.name || '?'}`;
    if (o.type === 'bill_flat') return `₹${o.flat_amount} off bills ≥ ₹${o.min_bill}`;
    if (o.type === 'combo') return `${(o.combo_item_ids ? JSON.parse(o.combo_item_ids) : []).map((id) => items.find((i) => i.id === id)?.name || '?').join(' + ')} = ₹${o.combo_price}`;
    return '';
  };
  $('#main').innerHTML = `<div class="card"><h3>Offer Zone control</h3>
    <div class="row"><div style="flex:1"><b>Offer Zone is ${zoneOn ? 'ON' : 'OFF'}</b><div class="muted" style="font-size:12px">When OFF, no offers apply and the counter's Offer Zone tab shows nothing.</div></div>
      <button class="${zoneOn ? 'danger' : 'ok'} fit" id="tog">${zoneOn ? 'Turn OFF' : 'Turn ON'}</button></div></div>
  <div class="card"><h3>Create an offer</h3>
    <label class="f">Offer name (shown to staff)</label><input id="on_name" placeholder="e.g. 10% off Rice Bowls">
    <label class="f">Type</label>
    <select id="on_type">
      <option value="category_percent">Category % off</option>
      <option value="item_percent">Item % off</option>
      <option value="bill_flat">Flat ₹ off whole bill</option>
      <option value="combo">Combo fixed price</option>
    </select>
    <div id="fields_category_percent" class="otype">
      <label class="f">Category</label><select id="on_cat">${cats.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select>
      <label class="f">Percent off (%)</label><input id="on_percent_cat" type="number" placeholder="10">
    </div>
    <div id="fields_item_percent" class="otype" style="display:none">
      <label class="f">Item</label><select id="on_item">${items.map((i) => `<option value="${i.id}">${esc(i.name)}</option>`).join('')}</select>
      <label class="f">Percent off (%)</label><input id="on_percent_item" type="number" placeholder="20">
    </div>
    <div id="fields_bill_flat" class="otype" style="display:none">
      <label class="f">Flat ₹ off</label><input id="on_flat" type="number" placeholder="50">
      <label class="f">Minimum bill (₹) required</label><input id="on_min" type="number" placeholder="500">
    </div>
    <div id="fields_combo" class="otype" style="display:none">
      <label class="f">Combo item IDs (comma-separated, 2 or more)</label><input id="on_ids" placeholder="e.g. 3,7">
      <label class="f">Combo price (₹ per unit)</label><input id="on_cprice" type="number" placeholder="250">
    </div>
    <label class="f">Valid until (optional)</label><input id="on_end" type="date">
    <p></p><button class="primary" id="oadd">Create offer</button></div>
  <div class="card"><h3>Active offers</h3>${offers.length ? `<table>${offers.map((o) => `<tr><td>${esc(o.name)}<div class="muted" style="font-size:12px">${typeLabel[o.type]} · ${describe(o)}${o.active ? '' : ' · INACTIVE'}</div></td><td class="r"><button class="small" data-tg="${o.id}">${o.active ? 'Disable' : 'Enable'}</button> <button class="small danger" data-rm="${o.id}">✕</button></td></tr>`).join('')}</table>` : '<p class="muted">No offers yet.</p>'}</div>`;
  const syncFields = () => {
    document.querySelectorAll('.otype').forEach((el) => (el.style.display = 'none'));
    const sel = $('#on_type').value;
    $('#fields_' + sel).style.display = '';
  };
  $('#on_type').onchange = syncFields; syncFields();
  $('#tog').onclick = guard(async () => {
    const next = zoneOn ? '0' : '1';
    S.settings = await api('/settings', { method: 'PUT', body: { offer_zone_on: next } });
    toast('Offer Zone ' + (next === '1' ? 'ON' : 'OFF')); vOffersAdmin();
  });
  $('#oadd').onclick = guard(async () => {
    const type = $('#on_type').value;
    const body = { name: $('#on_name').value, type, end_date: $('#on_end').value || null };
    if (type === 'category_percent') { body.category_id = Number($('#on_cat').value); body.percent = Number($('#on_percent_cat').value); }
    if (type === 'item_percent') { body.item_id = Number($('#on_item').value); body.percent = Number($('#on_percent_item').value); }
    if (type === 'bill_flat') { body.flat_amount = Number($('#on_flat').value); body.min_bill = Number($('#on_min').value); }
    if (type === 'combo') { body.combo_item_ids = $('#on_ids').value.split(',').map((x) => Number(x.trim())).filter((x) => x > 0); body.combo_price = Number($('#on_cprice').value); }
    await api('/offers', { method: 'POST', body });
    toast('Offer created'); await reloadMenu(); vOffersAdmin();
  });
  document.querySelectorAll('[data-tg]').forEach((b) => (b.onclick = guard(async () => {
    const o = offers.find((x) => x.id == b.dataset.tg);
    await api('/offers/' + o.id, { method: 'PUT', body: { active: o.active ? 0 : 1 } });
    await reloadMenu(); vOffersAdmin();
  })));
  document.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = guard(async () => {
    if (!confirm('Delete this offer?')) return;
    await api('/offers/' + b.dataset.rm, { method: 'DELETE' });
    await reloadMenu(); vOffersAdmin();
  })));
}

function vOrders() {
  $('#main').innerHTML = `<div class="card"><h3>Open orders</h3>${S.open.length ? `<table><tr><th>#</th><th>For</th><th class="r">Total</th><th></th></tr>${S.open.map((o) => `<tr><td>${o.id}</td><td>${o.type === 'dinein' ? 'Table ' + esc(o.table_name) : o.type === 'aggregator' ? esc(o.platform) : 'Takeaway'}<div class="muted" style="font-size:12px">${esc(o.created_at)}</div></td><td class="r">${inr(o.total)}</td><td class="r"><button class="small primary" data-o="${o.id}">Open</button>${isAdmin() ? ` <button class="small danger" data-discard="${o.id}">Discard</button>` : ''}</td></tr>`).join('')}</table>` : '<p class="muted">No open orders.</p>'}</div>`;
  document.querySelectorAll('[data-o]').forEach((b) => (b.onclick = guard(() => loadIntoCart(b.dataset.o))));
  document.querySelectorAll('[data-discard]').forEach((b) => (b.onclick = guard(async () => {
    if (!confirm('Discard this open order? It will not be billed.')) return;
    await api(`/orders/${b.dataset.discard}/void`, { method: 'POST', body: { reason: 'Discarded from Open orders' } });
    toast('Order discarded'); await refreshOpen(); vOrders();
  })));
}
async function vBills() {
  $('#main').innerHTML = `<div class="card"><div class="row"><input type="date" id="bf" value="${S.bf || today()}"><button id="bg" class="fit">Show</button></div><div id="bl" style="margin-top:10px"></div></div>`;
  const load = guard(async () => {
    S.bf = $('#bf').value; const rows = await api(`/orders?status=paid&from=${S.bf}&to=${S.bf}`);
    $('#bl').innerHTML = rows.length ? `<div class="scroll-x"><table><tr><th>Bill</th><th>Type</th><th class="r">Total</th><th></th></tr>${rows.map((o) => `<tr><td>${esc(o.bill_no)}<div class="muted" style="font-size:12px">${esc((o.paid_at || '').slice(11, 16))}</div></td><td>${o.type === 'dinein' ? 'T ' + esc(o.table_name) : o.type === 'aggregator' ? esc(o.platform) : 'Takeaway'}</td><td class="r">${inr(o.total)}</td><td class="r"><button class="small" data-r="${o.id}">Reprint</button>${isAdmin() ? ` <button class="small danger" data-void="${o.id}">Void</button>` : ''}</td></tr>`).join('')}</table></div>` : '<p class="muted">No bills on this date.</p>';
    document.querySelectorAll('[data-r]').forEach((b) => (b.onclick = guard(async () => printBill(await api('/orders/' + b.dataset.r)))));
    document.querySelectorAll('[data-void]').forEach((b) => (b.onclick = guard(async () => { const reason = prompt('Reason for voiding this bill?'); if (reason === null) return; await api(`/orders/${b.dataset.void}/void`, { method: 'POST', body: { reason } }); toast('Bill voided'); load(); })));
  });
  $('#bg').onclick = load; load();
}

async function vInventory() {
  const rows = await api('/inventory').catch(() => []);
  $('#main').innerHTML = `<div class="card"><h3>Stock</h3><div class="scroll-x"><table><tr><th>Item</th><th class="r">In stock</th><th></th></tr>${rows.map((i) => `<tr><td>${esc(i.name)}${i.qty <= i.min_qty ? ' <span class="pill bad">Low</span>' : ''}<div class="muted" style="font-size:12px">Alert at ${i.min_qty} ${esc(i.unit)} · last cost ${inr(i.cost)}/${esc(i.unit)}</div></td><td class="r"><b>${i.qty}</b> ${esc(i.unit)}</td><td class="r"><button class="small ok" data-in="${i.id}">+ In</button> <button class="small" data-out="${i.id}">− Used</button></td></tr>`).join('') || '<tr><td colspan="3" class="muted">No stock items yet.</td></tr>'}</table></div></div>
  <div id="recipes"></div>
  ${isAdmin() ? `<div class="card"><h3>Add stock item</h3><div class="row"><input id="n" placeholder="Name (e.g. Chicken)"><input id="un" placeholder="Unit (kg, L, pcs)" value="kg"></div><div class="row"><input id="qy" type="number" placeholder="Opening qty"><input id="mn" type="number" placeholder="Low-stock alert at"><input id="cs" type="number" placeholder="Cost per unit ₹"></div><p></p><button class="primary" id="add">Add</button></div>` : ''}`;
  const move = (sign) => guard(async (id) => {
    const q = prompt(sign > 0 ? 'Quantity received?' : 'Quantity used / wasted?'); if (!q) return;
    let cost = 0; if (sign > 0) cost = prompt('Cost per unit ₹ (leave blank to keep old)') || 0;
    await api(`/inventory/${id}/move`, { method: 'POST', body: { delta: sign * Number(q), cost, reason: sign > 0 ? 'Purchase' : 'Used / wasted' } }); vInventory();
  });
  document.querySelectorAll('[data-in]').forEach((b) => (b.onclick = () => move(1)(b.dataset.in)));
  document.querySelectorAll('[data-out]').forEach((b) => (b.onclick = () => move(-1)(b.dataset.out)));
  if (isAdmin()) renderRecipes(rows);
  const add = $('#add'); if (add) add.onclick = guard(async () => { await api('/inventory', { method: 'POST', body: { name: $('#n').value, unit: $('#un').value, qty: $('#qy').value || 0, min_qty: $('#mn').value || 0, cost: $('#cs').value || 0 } }); vInventory(); });
}

async function vMenu() {
  const [all, st] = await Promise.all([api('/items/all'), api('/menu/import-status')]);
  const unpriced = all.filter((i) => !(i.price > 0)).length;
  const catName = (id) => S.categories.find((c) => c.id === id)?.name || 'Other';
  const groups = [...S.categories.map((c) => c.id), null].map((id) => ({ id, name: id === null ? 'Other' : catName(id), items: all.filter((i) => (i.category_id ?? null) === id && !/ \(sample\)$/.test(i.name)).sort((a, b) => a.id - b.id) })).filter((g) => g.items.length);
  const importCard = st.missing > 0 ? `<div class="card"><h3>Load your Katsu Kaii menu</h3><p class="muted">Adds ${st.missing} dishes in 8 sections (Dumplings, Starters, Noodles, Rice, Mains, Soups, Hot Pot, Desserts). Prices start empty, and a dish stays hidden from the counter until you give it a price, so nothing can be sold at ₹0.</p>
     ${st.samples ? `<label style="display:flex;gap:8px;align-items:center;margin:10px 0"><input type="checkbox" id="hs" checked style="width:auto;min-height:0"> Hide the ${st.samples} sample dishes (Chicken Katsu ₹220, Masala Soda ₹60 and so on)</label>` : ''}
     <button class="primary" id="imp">Load my menu</button></div>` : '';
  const priceCard = all.length ? `<div class="card"><details ${unpriced ? 'open' : ''}><summary style="cursor:pointer;font-weight:700;font-size:16px">Set prices${unpriced ? ` <span class="pill warn">${unpriced} dishes need a price</span>` : ''}</summary>
     <p class="muted" style="margin-top:8px">Type a price for each dish and press <b>Save all prices</b> once. A dish goes live on the counter as soon as it has a price. Check the Veg / Non-veg choice too.</p>
     ${groups.map((g) => `<h4 style="margin:14px 0 4px">${esc(g.name)}</h4><table>${g.items.map((i) => `<tr><td>${esc(i.name)}</td><td style="width:132px"><select data-bv="${i.id}"><option value="1" ${i.veg ? 'selected' : ''}>Veg</option><option value="0" ${i.veg ? '' : 'selected'}>Non-veg</option></select></td><td style="width:110px"><input type="number" min="0" step="1" inputmode="decimal" placeholder="₹ price" data-bp="${i.id}" value="${i.price > 0 ? i.price : ''}"></td></tr>`).join('')}</table>`).join('')}
     <p></p><button class="primary" id="sp">Save all prices</button></details></div>` : '';
  $('#main').innerHTML = `${importCard}${priceCard}<div class="card"><h3>Categories</h3><div class="row">${S.categories.map((c) => `<span class="pill">${esc(c.name)} <a href="#" data-dc="${c.id}" style="color:var(--bad);text-decoration:none">✕</a></span>`).join('')}</div>
    <div class="row" style="margin-top:8px"><input id="cname" placeholder="New category"><button class="fit primary" id="cadd">Add</button></div></div>
   <div class="card"><h3>Add item</h3><div class="row"><input id="iname" placeholder="Item name"><input id="iprice" type="number" placeholder="Price ₹"></div>
    <div class="row" style="margin-top:6px"><select id="icat">${S.categories.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select><select id="iveg"><option value="1">Veg</option><option value="0">Non-veg</option></select></div><p></p><button class="primary" id="iadd">Add item</button></div>
   <div class="card"><h3>Items</h3><div class="scroll-x"><table>${all.map((i) => `<tr><td>${esc(i.name)} ${i.active ? '' : '<span class="pill warn">Hidden</span>'}<div class="muted" style="font-size:12px">${esc(S.categories.find((c) => c.id === i.category_id)?.name || '')}</div></td><td class="r">${inr(i.price)}</td><td class="r"><button class="small" data-ep="${i.id}">Price</button> <button class="small" data-ta="${i.id}">${i.active ? 'Hide' : 'Show'}</button></td></tr>`).join('')}</table></div></div>
   <div class="card"><h3>Tables</h3><div class="row">${S.tables.map((t) => `<span class="pill">${esc(t.name)} <a href="#" data-dt="${t.id}" style="color:var(--bad);text-decoration:none">✕</a></span>`).join('')}</div><div class="row" style="margin-top:8px"><input id="tname" placeholder="New table (e.g. T9)"><button class="fit primary" id="tadd">Add</button></div></div>`;
  const rel = async () => { await reloadMenu(); vMenu(); };
  if ($('#imp')) $('#imp').onclick = guard(async () => { const r = await api('/menu/import', { method: 'POST', body: { hide_samples: $('#hs') ? $('#hs').checked : false } }); toast(`Added ${r.added} dishes. Now set their prices.`); rel(); });
  if ($('#sp')) {
    const boxes = [...document.querySelectorAll('[data-bp]')];
    boxes.forEach((b, ix) => (b.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); (boxes[ix + 1] || $('#sp')).focus(); } }));
    $('#sp').onclick = guard(async () => {
      const items = boxes.map((b) => ({ id: Number(b.dataset.bp), price: b.value, veg: Number(document.querySelector(`[data-bv="${b.dataset.bp}"]`).value) }));
      const r = await api('/items/bulk', { method: 'POST', body: { items } }); toast(r.changed ? `Saved ${r.changed} changes` : 'Nothing changed'); rel();
    });
  }
  $('#cadd').onclick = guard(async () => { await api('/categories', { method: 'POST', body: { name: $('#cname').value, sort: S.categories.length + 1 } }); rel(); });
  $('#iadd').onclick = guard(async () => { await api('/items', { method: 'POST', body: { name: $('#iname').value, price: $('#iprice').value, category_id: Number($('#icat').value), veg: Number($('#iveg').value) } }); rel(); });
  $('#tadd').onclick = guard(async () => { await api('/tables', { method: 'POST', body: { name: $('#tname').value } }); rel(); });
  document.querySelectorAll('[data-dc]').forEach((a) => (a.onclick = guard(async (e) => { e.preventDefault(); await api('/categories/' + a.dataset.dc, { method: 'DELETE' }); rel(); })));
  document.querySelectorAll('[data-dt]').forEach((a) => (a.onclick = guard(async (e) => { e.preventDefault(); await api('/tables/' + a.dataset.dt, { method: 'DELETE' }); rel(); })));
  document.querySelectorAll('[data-ep]').forEach((b) => (b.onclick = guard(async () => { const p = prompt('New price ₹'); if (p === null) return; await api('/items/' + b.dataset.ep, { method: 'PUT', body: { price: Number(p) } }); rel(); })));
  document.querySelectorAll('[data-ta]').forEach((b) => (b.onclick = guard(async () => { const it = all.find((x) => x.id == b.dataset.ta); await api('/items/' + it.id, { method: 'PUT', body: { active: it.active ? 0 : 1 } }); rel(); })));
}

async function renderRecipes(inv) {
  const box = $('#recipes'); if (!box) return;
  const recs = await api('/recipes');
  box.innerHTML = `<div class="card"><h3>Recipes · auto stock deduction</h3><p class="muted">Tell the app what one plate uses. Example: Chicken Katsu uses 0.2 kg Chicken. After that, every paid bill reduces your stock by itself.</p>
    ${recs.length ? `<div class="scroll-x"><table>${recs.map((r) => `<tr><td>${esc(r.item_name)}</td><td>${r.qty} ${esc(r.unit)} ${esc(r.ingredient)}</td><td class="r"><button class="small danger" data-rd="${r.id}">✕</button></td></tr>`).join('')}</table></div>` : '<p class="muted">No recipes yet.</p>'}
    <div class="row" style="margin-top:8px"><select id="rit">${S.items.map((i) => `<option value="${i.id}">${esc(i.name)}</option>`).join('')}</select><select id="rin">${inv.map((i) => `<option value="${i.id}">${esc(i.name)} (${esc(i.unit)})</option>`).join('')}</select><input id="rq" type="number" step="any" placeholder="Qty per plate"></div>
    <p></p><button class="primary" id="radd">Save recipe line</button></div>`;
  $('#radd').onclick = guard(async () => {
    await api('/recipes', { method: 'POST', body: { item_id: Number($('#rit').value), inventory_id: Number($('#rin').value), qty: $('#rq').value } });
    toast('Recipe saved'); renderRecipes(inv);
  });
  box.querySelectorAll('[data-rd]').forEach((b) => (b.onclick = guard(async () => { await api('/recipes/' + b.dataset.rd, { method: 'DELETE' }); renderRecipes(inv); })));
}

async function vPlanner() {
  const month = S.pm || today().slice(0, 7);
  const [p, cats] = await Promise.all([api('/planner?month=' + month), api('/expense-categories')]);
  const pill = (b) => b.status === 'paid' ? '<span class="pill ok">Paid</span>' : b.status === 'overdue' ? '<span class="pill bad">Overdue</span>' : b.status === 'soon' ? `<span class="pill warn">Due in ${b.days_left} day${b.days_left === 1 ? '' : 's'}</span>` : `<span class="pill">Due on ${b.due}</span>`;
  const short = p.set_aside < p.remaining;
  $('#main').innerHTML = `<div class="card"><div class="row"><input type="month" id="pmn" value="${month}"><button class="fit" id="pmg">Show</button></div></div>
   <div class="grid2" style="margin-bottom:12px">
     <div class="stat"><span>Fixed costs this month</span><b>${inr(p.fixed_total)}</b></div>
     <div class="stat"><span>Already paid</span><b>${inr(p.paid_total)}</b></div>
     <div class="stat"><span>Still to pay</span><b>${inr(p.remaining)}</b></div>
     <div class="stat"><span>Money set aside</span><b style="color:${short ? 'var(--warn)' : 'var(--ok)'}">${inr(p.set_aside)}</b></div>
     <div class="stat"><span>Keep aside per day (${p.days_left} days left)</span><b>${inr(p.daily_target)}</b></div>
     <div class="stat"><span>That is about</span><b>${p.percent_of_sales === null ? '—' : p.percent_of_sales + '%'}</b><span>${p.percent_of_sales === null ? 'of daily sales (needs a few days of sales)' : 'of your average daily sales (' + inr(p.avg_daily_sales) + ')'}</span></div></div>
   <div class="card"><h3>Monthly bills</h3>${p.items.length ? `<div class="scroll-x"><table>${p.items.map((b) => `<tr><td>${esc(b.name)}<div class="muted" style="font-size:12px">${esc(b.category)} · due day ${b.due}${b.paid_on ? ' · paid ' + esc(b.paid_on) : ''}</div></td><td class="r">${inr(b.amount)}<div>${pill(b)}</div></td><td class="r">${b.status === 'paid' ? '' : `<button class="small ok" data-pay="${b.id}">Mark paid</button> `}<button class="small" data-ed="${b.id}">Edit</button> <button class="small danger" data-rm="${b.id}">✕</button></td></tr>`).join('')}</table></div>` : '<p class="muted">Add your fixed monthly costs below: rent, electricity, water, staff and chef salary, gas, internet.</p>'}</div>
   <div class="card"><h3>Add a monthly cost</h3><div class="row"><input id="bn" placeholder="Name (e.g. Shop rent, Chef Ramesh)"><input id="ba" type="number" placeholder="Amount ₹"></div>
     <div class="row" style="margin-top:6px"><select id="bc">${cats.map((c) => `<option>${esc(c)}</option>`).join('')}</select><input id="bd" type="number" min="1" max="31" placeholder="Due day of month (1-31)"></div><p></p><button class="primary" id="badd">Add</button></div>
   <div class="card"><h3>Set money aside</h3><p class="muted">When you keep cash or move money to a separate account for these bills, note it here. Aim to reach "Still to pay" before the due dates.</p>
     <div class="row"><input id="ra" type="number" placeholder="Amount ₹"><input id="rn" placeholder="Note (optional)"></div><p></p><button class="primary" id="radd">Add to set-aside</button>
     ${p.reserve.length ? `<table style="margin-top:8px">${p.reserve.map((r) => `<tr><td>${esc(r.date)}<div class="muted" style="font-size:12px">${esc(r.note)}</div></td><td class="r">${inr(r.amount)}</td><td class="r"><button class="small danger" data-rr="${r.id}">✕</button></td></tr>`).join('')}</table>` : ''}</div>`;
  $('#pmg').onclick = () => { S.pm = $('#pmn').value; vPlanner(); };
  $('#badd').onclick = guard(async () => { await api('/budgets', { method: 'POST', body: { name: $('#bn').value, amount: $('#ba').value, category: $('#bc').value, due_day: $('#bd').value || 1 } }); toast('Added'); vPlanner(); });
  $('#radd').onclick = guard(async () => { await api('/reserve', { method: 'POST', body: { amount: $('#ra').value, note: $('#rn').value } }); toast('Saved'); vPlanner(); });
  document.querySelectorAll('[data-pay]').forEach((b) => (b.onclick = guard(async () => {
    const it = p.items.find((x) => x.id == b.dataset.pay); const a = prompt(`Amount paid for ${it.name}?`, it.amount); if (a === null) return;
    await api(`/budgets/${it.id}/pay`, { method: 'POST', body: { amount: a, month } }); toast('Marked paid and added to expenses'); vPlanner();
  })));
  document.querySelectorAll('[data-ed]').forEach((b) => (b.onclick = guard(async () => {
    const it = p.items.find((x) => x.id == b.dataset.ed); const a = prompt('New monthly amount ₹', it.amount); if (a === null) return;
    await api('/budgets/' + it.id, { method: 'PUT', body: { amount: Number(a) } }); vPlanner();
  })));
  document.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = guard(async () => { if (!confirm('Remove this monthly cost? Past payments stay in Expenses.')) return; await api('/budgets/' + b.dataset.rm, { method: 'DELETE' }); vPlanner(); })));
  document.querySelectorAll('[data-rr]').forEach((b) => (b.onclick = guard(async () => { await api('/reserve/' + b.dataset.rr, { method: 'DELETE' }); vPlanner(); })));
}

async function vExpenses() {
  const cats = await api('/expense-categories'); const from = S.ef || monthStart(), to = S.et || today();
  const rows = await api(`/expenses?from=${from}&to=${to}`); const total = rows.reduce((s, r) => s + r.amount, 0);
  $('#main').innerHTML = `<div class="card"><h3>Add expense</h3><div class="row"><input type="date" id="ed" value="${today()}"><select id="ec">${cats.map((c) => `<option>${esc(c)}</option>`).join('')}</select></div>
    <div class="row" style="margin-top:6px"><input id="ea" type="number" placeholder="Amount ₹"><select id="em"><option value="cash">Cash</option><option value="upi">UPI</option><option value="bank">Bank</option><option value="card">Card</option></select></div>
    <input id="eds" placeholder="Note (e.g. Oct rent, Ramesh chef advance)" style="margin-top:6px"><p></p><button class="primary" id="eadd">Save expense</button></div>
   <div class="card"><div class="row"><input type="date" id="ef" value="${from}"><input type="date" id="et" value="${to}"><button class="fit" id="eg">Show</button><button class="fit" id="ecsv">Download CSV</button></div><h3 style="margin-top:12px">Expenses · ${inr(total)}</h3>
    <div class="scroll-x"><table>${rows.map((r) => `<tr><td>${esc(r.date)}</td><td>${esc(r.category)}<div class="muted" style="font-size:12px">${esc(r.description)}</div></td><td class="r">${inr(r.amount)}</td><td class="r"><button class="small danger" data-d="${r.id}">✕</button></td></tr>`).join('') || '<tr><td class="muted">Nothing in this range.</td></tr>'}</table></div></div>`;
  $('#eadd').onclick = guard(async () => { await api('/expenses', { method: 'POST', body: { date: $('#ed').value, category: $('#ec').value, amount: $('#ea').value, mode: $('#em').value, description: $('#eds').value } }); toast('Saved'); vExpenses(); });
  $('#eg').onclick = () => { S.ef = $('#ef').value; S.et = $('#et').value; vExpenses(); };
  $('#ecsv').onclick = guard(() => download(`/expenses/export.csv?from=${from}&to=${to}`, `expenses-${from}-to-${to}.csv`));
  document.querySelectorAll('[data-d]').forEach((b) => (b.onclick = guard(async () => { if (!confirm('Delete this expense?')) return; await api('/expenses/' + b.dataset.d, { method: 'DELETE' }); vExpenses(); })));
}

async function vReports() {
  const from = S.rf || today(), to = S.rt || today();
  const r = await api(`/reports/summary?from=${from}&to=${to}`); const t = r.totals;
  const tl = (x) => (x.type === 'dinein' ? 'Dine-in' : x.type === 'takeaway' ? 'Takeaway' : x.platform || 'Aggregator');
  $('#main').innerHTML = `<div class="card"><div class="row"><input type="date" id="rf" value="${from}"><input type="date" id="rt" value="${to}"><button class="fit" id="rg">Show</button></div>
   <div class="row" style="margin-top:8px"><button class="small" id="q1">Today</button><button class="small" id="q2">This month</button><button class="small" id="q3">This FY</button><a class="fit" href="#" id="csv">Download CSV</a></div></div>
   <div class="grid2" style="margin-bottom:12px"><div class="stat"><span>Bills</span><b>${t.bills}</b></div><div class="stat"><span>Total collected</span><b>${inr(t.total)}</b></div><div class="stat"><span>Sales (excl. GST)</span><b>${inr(r.income)}</b></div><div class="stat"><span>GST collected</span><b>${inr(t.cgst + t.sgst)}</b></div><div class="stat"><span>Offers given</span><b>${inr(t.offer_discount || 0)}</b></div><div class="stat"><span>Expenses</span><b>${inr(r.expenses)}</b></div><div class="stat"><span>Net profit (before income tax)</span><b style="color:${r.profit >= 0 ? 'var(--ok)' : 'var(--bad)'}">${inr(r.profit)}</b></div></div>
   <div class="card"><h3>Payments received</h3><table>${r.byMode.map((m) => `<tr><td>${esc(m.mode.toUpperCase())}</td><td class="r">${inr(m.amount)}</td></tr>`).join('') || '<tr><td class="muted">No sales</td></tr>'}</table></div>
   <div class="card"><h3>Sales by channel</h3><table>${r.byType.map((x) => `<tr><td>${esc(tl(x))}</td><td class="r">${x.bills} bills</td><td class="r">${inr(x.total)}</td></tr>`).join('') || '<tr><td class="muted">No sales</td></tr>'}</table></div>
   <div class="card"><h3>GST summary</h3><table><tr><td>Taxable value</td><td class="r">${inr(t.taxable)}</td></tr><tr><td>CGST</td><td class="r">${inr(t.cgst)}</td></tr><tr><td>SGST</td><td class="r">${inr(t.sgst)}</td></tr><tr><td>Discounts given</td><td class="r">${inr(t.discount)}</td></tr><tr><td>Offers given</td><td class="r">${inr(t.offer_discount || 0)}</td></tr></table></div>
   <div class="card"><h3>Top items</h3><table>${r.top.map((x) => `<tr><td>${esc(x.name)}</td><td class="r">${x.qty}</td><td class="r">${inr(x.amount)}</td></tr>`).join('') || '<tr><td class="muted">No sales</td></tr>'}</table></div>
   <div class="card"><h3>Expenses by type</h3><table>${r.expByCat.map((x) => `<tr><td>${esc(x.category)}</td><td class="r">${inr(x.amount)}</td></tr>`).join('') || '<tr><td class="muted">None</td></tr>'}</table></div>
   <div class="card"><h3>Income-tax / GST pack for your CA</h3><p class="muted">Shows month-wise turnover, GST and expenses for the financial year. Give this + the CSV to your CA for GST returns and ITR; this app does not file returns.</p><div class="row"><button id="fy">Show this financial year</button><button id="tx">Income-tax estimate</button></div><div id="fyo"></div><div id="txo"></div></div>`;
  const go = () => { S.rf = $('#rf').value; S.rt = $('#rt').value; vReports(); };
  $('#rg').onclick = go;
  $('#q1').onclick = () => { S.rf = S.rt = today(); vReports(); };
  $('#q2').onclick = () => { S.rf = monthStart(); S.rt = today(); vReports(); };
  $('#q3').onclick = () => { const d = new Date(); const y = d.getMonth() >= 3 ? d.getFullYear() : d.getFullYear() - 1; S.rf = `${y}-04-01`; S.rt = today(); vReports(); };
  $('#csv').onclick = guard(async (e) => {
    e.preventDefault(); const res = await fetch(`/api/reports/export.csv?from=${from}&to=${to}`, { headers: { Authorization: 'Bearer ' + S.token } });
    const a = document.createElement('a'); a.href = URL.createObjectURL(await res.blob()); a.download = `sales-${from}-to-${to}.csv`; a.click();
  });
  $('#tx').onclick = guard(async () => {
    const x = await api('/tax-estimate');
    $('#txo').innerHTML = `<h4>Income-tax estimate · FY ${x.fy}</h4><table>
      <tr><td>Sales excluding GST (turnover)</td><td class="r">${inr(x.turnover)}</td></tr>
      <tr><td>Share of receipts taken in cash</td><td class="r">${x.cash_share_pct}%</td></tr>
      <tr><td>Digital receipts × 6%</td><td class="r">${inr(x.digital * 0.06)}</td></tr>
      <tr><td>Cash receipts × 8%</td><td class="r">${inr(x.cash_part * 0.08)}</td></tr>
      <tr><th>Presumptive income (Sec 44AD)</th><th class="r">${inr(x.presumptive_income)}</th></tr>
      <tr><td>Your actual profit from these books</td><td class="r">${inr(x.actual_profit)}</td></tr></table>
      <p class="muted">Limit for this scheme: ${x.limit === 30000000 ? '₹3 crore (cash receipts are 5% or less)' : '₹2 crore'}. ${x.eligible ? 'Your turnover is within it.' : '<b style="color:var(--bad)">Your turnover is above it, so this scheme does not apply.</b>'}</p>
      <p class="muted">This is an estimate of taxable <b>income</b>, not the tax you will pay. Under this scheme you cannot claim rent, salaries or other expenses separately, and if you declare a lower profit than this you may need a tax audit. Show this screen to your CA, who will choose the right route and file the return.</p>`;
  });
  $('#fy').onclick = guard(async () => {
    const f = await api('/reports/fy'); const em = Object.fromEntries(f.expMonths.map((x) => [x.month, x.amount]));
    const months = [...new Set([...f.months.map((m) => m.month), ...f.expMonths.map((m) => m.month)])].sort();
    $('#fyo').innerHTML = `<h4>FY ${f.fy}</h4><div class="scroll-x"><table><tr><th>Month</th><th class="r">Sales</th><th class="r">GST</th><th class="r">Expenses</th></tr>${months.map((mo) => { const x = f.months.find((m) => m.month === mo) || {}; return `<tr><td>${mo}</td><td class="r">${inr(x.taxable)}</td><td class="r">${inr((x.cgst || 0) + (x.sgst || 0))}</td><td class="r">${inr(em[mo])}</td></tr>`; }).join('')}<tr><th>Total</th><th class="r">${inr(f.summary.income)}</th><th class="r">${inr(f.summary.totals.cgst + f.summary.totals.sgst)}</th><th class="r">${inr(f.summary.expenses)}</th></tr></table></div><p><b>Net profit before income tax: ${inr(f.summary.profit)}</b></p>`;
  });
}

async function vSettings() {
  const s = S.settings; const users = await api('/users');
  const f = (k, l, ph = '') => `<label class="f">${l}</label><input data-s="${k}" value="${esc(s[k])}" placeholder="${ph}">`;
  const zoneOn = s.offer_zone_on === '1';
  $('#main').innerHTML = `<div class="card"><h3>Restaurant & bill details</h3>${f('restaurant_name', 'Restaurant name')}${f('tagline', 'Tagline')}${f('address', 'Address')}${f('phone', 'Phone')}${f('gstin', 'GSTIN', '29XXXXXXXXXXXZX')}${f('fssai', 'FSSAI licence no.')}${f('pan', 'PAN')}${f('bill_prefix', 'Bill number prefix')}${f('bill_footer', 'Bill footer message')}
    <label class="f">GST rate (%)</label><input data-s="gst_rate" type="number" value="${esc(s.gst_rate)}">
    <label class="f">Zomato/Swiggy orders</label><select data-s="aggregator_gst"><option value="0" ${s.aggregator_gst !== '1' ? 'selected' : ''}>Do not add GST (platform pays it)</option><option value="1" ${s.aggregator_gst === '1' ? 'selected' : ''}>Add GST like normal bills</option></select>
    <label class="f">Printer paper</label><select data-s="paper_width"><option value="80" ${s.paper_width !== '58' ? 'selected' : ''}>80 mm</option><option value="58" ${s.paper_width === '58' ? 'selected' : ''}>58 mm</option></select><p></p><button class="primary" id="ss">Save settings</button> <button id="tp">Test print</button></div>
   <div class="card"><h3>Offer Zone control</h3>
     <div class="row"><div style="flex:1"><b>Offer Zone is ${zoneOn ? 'ON' : 'OFF'}</b><div class="muted" style="font-size:12px">Turn offers on/off for all counters. Manage individual offers in <b>Manage offers</b>.</div></div>
       <button class="${zoneOn ? 'danger' : 'ok'} fit" id="oz">${zoneOn ? 'Turn OFF' : 'Turn ON'}</button></div></div>
   <div class="card"><h3>Staff logins</h3><table>${users.map((u) => `<tr><td>${esc(u.name)}<div class="muted" style="font-size:12px">@${esc(u.username)} · ${u.role}</div></td><td class="r">${u.active ? '<span class="pill ok">Active</span>' : '<span class="pill bad">Off</span>'}</td><td class="r"><button class="small" data-pw="${u.id}">Password</button> <button class="small" data-tg="${u.id}" data-a="${u.active}">${u.active ? 'Disable' : 'Enable'}</button></td></tr>`).join('')}</table>
    <h4>Add staff</h4><div class="row"><input id="un" placeholder="Name"><input id="uu" placeholder="Username"></div><div class="row" style="margin-top:6px"><input id="up" type="password" placeholder="Password (6+ chars)"><select id="ur"><option value="cashier">Cashier</option><option value="admin">Admin</option></select></div><p></p><button class="primary" id="ua">Add staff</button></div>
   <div class="card"><h3>Backup</h3><p class="muted">Download a copy of all your bills, menu, stock and expenses. Do this every night and keep the file safe (Google Drive or a pen drive). The software also saves its own copy every day in the <b>backups</b> folder next to the data file and keeps the last 14 days.</p><button class="primary" id="bk">Download backup now</button></div>
   <div class="card"><h3>Change my password</h3><input id="op" type="password" placeholder="Current password"><input id="np" type="password" placeholder="New password" style="margin-top:6px"><p></p><button id="cp">Change</button></div>`;
  $('#ss').onclick = guard(async () => { const body = {}; document.querySelectorAll('[data-s]').forEach((i) => (body[i.dataset.s] = i.value)); S.settings = await api('/settings', { method: 'PUT', body }); toast('Saved'); });
  $('#tp').onclick = () => printHtml(`<h2>${esc(S.settings.restaurant_name)}</h2><div class="c">Printer test — ${S.settings.paper_width}mm</div><hr><div class="tr"><span>Left</span><span>Right</span></div><hr><div class="c">If you can read this fully, the printer is set up.</div>`);
  $('#oz').onclick = guard(async () => { const next = zoneOn ? '0' : '1'; S.settings = await api('/settings', { method: 'PUT', body: { offer_zone_on: next } }); toast('Offer Zone ' + (next === '1' ? 'ON' : 'OFF')); vSettings(); });
  $('#ua').onclick = guard(async () => { await api('/users', { method: 'POST', body: { name: $('#un').value, username: $('#uu').value, password: $('#up').value, role: $('#ur').value } }); toast('Added'); vSettings(); });
  document.querySelectorAll('[data-pw]').forEach((b) => (b.onclick = guard(async () => { const p = prompt('New password (6+ characters)'); if (!p) return; await api('/users/' + b.dataset.pw, { method: 'PUT', body: { password: p } }); if (Number(b.dataset.pw) === S.user.id) { S.defaultPw = false; render(); } toast('Password changed'); })));
  document.querySelectorAll('[data-tg]').forEach((b) => (b.onclick = guard(async () => { await api('/users/' + b.dataset.tg, { method: 'PUT', body: { active: b.dataset.a === '1' ? 0 : 1 } }); vSettings(); })));
  $('#bk').onclick = guard(() => download('/backup', `masala-mafia-backup-${today()}.db`));
  $('#cp').onclick = guard(async () => { await api('/me/password', { method: 'POST', body: { old_password: $('#op').value, new_password: $('#np').value } }); S.defaultPw = false; toast('Password changed'); render(); });
}

async function vDashboard() {
  const d = await api('/dashboard');
  const max = Math.max(1, ...d.last7.map((x) => x.total));
  const dueRows = d.dues.map((b) => `<tr><td>${esc(b.name)}</td><td class="r">${inr(b.amount)}</td><td class="r">${b.days < 0 ? '<span class="pill bad">Overdue</span>' : b.days === 0 ? '<span class="pill warn">Due today</span>' : `<span class="pill warn">Due in ${b.days} day${b.days === 1 ? '' : 's'}</span>`}</td></tr>`).join('');
  const lowRows = d.low_stock.map((i) => `<tr><td>${esc(i.name)}</td><td class="r">${i.qty} ${esc(i.unit)} left</td><td class="r"><span class="pill bad">Low</span></td></tr>`).join('');
  const priceRow = d.unpriced ? `<tr><td>${d.unpriced} dishes have no price yet</td><td></td><td class="r"><button class="small primary" id="gp">Set prices</button></td></tr>` : '';
  const purchaseText = (d.purchase_list || []).map((i) => `• ${i.name}: order ${i.suggest_order} ${i.unit} (in stock ${i.qty} ${i.unit}, using ~${i.daily_use}/day)`).join('\n');
  const purchaseCard = (d.purchase_list && d.purchase_list.length) ? `<div class="card"><h3>Purchase list (low stock)</h3>
    <p class="muted">Based on the last 14 days of usage, this is roughly what to buy.</p>
    <div class="scroll-x"><table><tr><th>Item</th><th class="r">In stock</th><th class="r">Using / day</th><th class="r">Order</th></tr>${d.purchase_list.map((i) => `<tr><td>${esc(i.name)}</td><td class="r">${i.qty} ${esc(i.unit)}</td><td class="r">${i.daily_use} ${esc(i.unit)}</td><td class="r"><b>${i.suggest_order} ${esc(i.unit)}</b></td></tr>`).join('')}</table></div>
    <p></p><button class="small" id="cp2">Copy list</button></div>` : '';
  const attention = dueRows || lowRows || d.open_orders || priceRow;
  $('#main').innerHTML = `<div class="live-bar">🔴 Live · updated ${esc(d.now)} <span class="muted" style="margin-left:8px;font-weight:400">auto-refreshes every 15s</span></div>
   <div class="grid2" style="margin-bottom:12px">
    <div class="stat"><span>Today's sales</span><b>${inr(d.today.total)}</b><span>${d.today.bills} bills</span></div>
    <div class="stat"><span>This month</span><b>${inr(d.month.total)}</b><span>${d.month.bills} bills</span></div>
    <div class="stat"><span>Month profit (excl. GST, after expenses)</span><b style="color:${d.month.profit >= 0 ? 'var(--ok)' : 'var(--bad)'}">${inr(d.month.profit)}</b></div>
    <div class="stat"><span>Open orders</span><b>${d.open_orders}</b></div></div>
   ${attention ? `<div class="card"><h3>Needs attention</h3><table>${d.open_orders ? `<tr><td>${d.open_orders} order(s) not billed yet</td><td></td><td class="r"><span class="pill warn">Open</span></td></tr>` : ''}${priceRow}${dueRows}${lowRows}</table></div>` : ''}
   ${purchaseCard}
   <div class="card"><h3>Last 7 days</h3><div class="bars">${d.last7.map((x) => `<div class="bar"><b>${x.total ? Math.round(x.total) : ''}</b><div class="bw"><i style="height:${x.total ? Math.max(3, Math.round(x.total / max * 100)) : 0}%"></i></div><span>${x.day.slice(8)}/${x.day.slice(5, 7)}</span></div>`).join('')}</div></div>
   <div class="card"><h3>Received today</h3><table>${d.today.byMode.map((m) => `<tr><td>${esc(m.mode.toUpperCase())}</td><td class="r">${inr(m.amount)}</td></tr>`).join('') || '<tr><td class="muted">No sales yet today</td></tr>'}</table></div>
   <div class="card"><h3>Best sellers (last 7 days)</h3><table>${d.top.map((x) => `<tr><td>${esc(x.name)}</td><td class="r">${x.qty}</td><td class="r">${inr(x.amount)}</td></tr>`).join('') || '<tr><td class="muted">No sales yet</td></tr>'}</table></div>`;
  const gp = $('#gp'); if (gp) gp.onclick = () => { S.view = 'menu'; render(); };
  const cp2 = $('#cp2'); if (cp2) cp2.onclick = async () => { try { await navigator.clipboard.writeText(purchaseText || 'No items to order'); toast('Purchase list copied'); } catch { toast('Copy failed — select the table manually', true); } };
}

async function vDayClose() {
  const date = S.dc || today();
  const [d, plan] = await Promise.all([api('/day-close?date=' + date), date === today() ? api('/planner') : Promise.resolve(null)]);
  const ex = d.existing;
  $('#main').innerHTML = `<div class="card"><div class="row"><input type="date" id="dcd" value="${date}"><button class="fit" id="dcg">Show</button></div></div>
   ${d.open_orders ? `<div class="banner">${d.open_orders} order(s) are still open and not billed. Bill or void them before you close the day.</div>` : ''}
   <div class="grid2" style="margin-bottom:12px"><div class="stat"><span>Bills</span><b>${d.bills}</b></div><div class="stat"><span>Cash sales</span><b>${inr(d.modes.cash)}</b></div><div class="stat"><span>UPI</span><b>${inr(d.modes.upi)}</b></div><div class="stat"><span>Card</span><b>${inr(d.modes.card)}</b></div><div class="stat"><span>Platform / online</span><b>${inr(d.modes.online)}</b></div><div class="stat"><span>Cash paid out (expenses)</span><b>${inr(d.cash_expenses)}</b></div></div>
   <div class="card"><h3>Count the cash drawer</h3>
     <label class="f">Cash kept in the drawer at the start of the day (float) ₹</label><input id="dof" type="number" min="0" placeholder="0" value="${ex ? ex.opening_float : ''}">
     <div class="tot" style="margin-top:8px"><div><span>Cash the drawer should have</span><b id="dce"></b></div></div>
     <label class="f">Cash you counted now ₹</label><input id="dcc" type="number" min="0" value="${ex ? ex.counted_cash : ''}">
     <div id="dcdiff" style="margin:8px 0;font-weight:700"></div>
     <input id="dcn" placeholder="Note (optional)" value="${esc(ex?.note || '')}"><p></p><button class="primary" id="dcs">${ex ? 'Update day close' : 'Save day close'}</button></div>
   ${plan && plan.daily_target > 0 ? `<div class="card"><h3>Set money aside for monthly bills</h3><p class="muted">To be ready for rent, salaries and electricity, keep about <b>${inr(plan.daily_target)}</b> aside today.</p><button class="ok" id="dcr">I set aside ${inr(plan.daily_target)}</button></div>` : ''}
   <div class="card"><h3>Earlier closes</h3><table>${d.recent.map((r) => `<tr><td>${esc(r.date)}</td><td class="r">${inr(r.counted_cash)}</td><td class="r">${Math.abs(r.difference) < 0.01 ? '<span class="pill ok">Matched</span>' : r.difference > 0 ? `<span class="pill warn">Extra ${inr(r.difference)}</span>` : `<span class="pill bad">Short ${inr(-r.difference)}</span>`}</td></tr>`).join('') || '<tr><td class="muted">No closes saved yet.</td></tr>'}</table></div>`;
  const calc = () => {
    const exp = (Number($('#dof').value) || 0) + d.modes.cash - d.cash_expenses; $('#dce').textContent = inr(exp);
    const el = $('#dcdiff'); if ($('#dcc').value === '') { el.textContent = ''; return; }
    const diff = Number($('#dcc').value) - exp;
    el.style.color = Math.abs(diff) < 0.01 ? 'var(--ok)' : diff > 0 ? 'var(--warn)' : 'var(--bad)';
    el.textContent = Math.abs(diff) < 0.01 ? 'Cash matches ✓' : diff > 0 ? `Extra cash: ${inr(diff)}` : `Cash short by ${inr(-diff)}`;
  };
  $('#dof').oninput = calc; $('#dcc').oninput = calc; calc();
  $('#dcg').onclick = () => { S.dc = $('#dcd').value; vDayClose(); };
  $('#dcs').onclick = guard(async () => { await api('/day-close', { method: 'POST', body: { date, opening_float: $('#dof').value || 0, counted_cash: $('#dcc').value, note: $('#dcn').value } }); toast('Day closed'); vDayClose(); });
  const r = $('#dcr'); if (r) r.onclick = guard(async () => { await api('/reserve', { method: 'POST', body: { amount: plan.daily_target, note: 'Set aside at day close' } }); toast('Saved to set-aside'); vDayClose(); });
}

setInterval(async () => {
  if (!S.token) return;
  if (S.view === 'orders') { await refreshOpen(); vOrders(); }
  else if (S.view === 'counter') refreshOpen();
}, 15000);
setInterval(async () => {
  if (!S.token || S.view !== 'dashboard' || !isAdmin()) return;
  try { await vDashboard(); } catch {}
}, 15000);
boot();