/* StockFlow — original UI + Supabase auth, realtime sync and offline queue */
const CFG = window.STOCKFLOW_SUPABASE || {};
const DB_NAME = "stockflow_cloud", DB_VERSION = 1;
const SIZES = ["XS", "S", "M", "L", "XL", "XXL"];
let db, sb, user = null, page = "dashboard", authMode = "login", channel = null, renderTimer = null, syncing = false;
let hideNums = localStorage.getItem("sf_hide") === "1", invTab = "in", salesQuery = "", confirmResolve = null, lock = Promise.resolve();

const $ = s => document.querySelector(s), $$ = s => document.querySelectorAll(s);
const money = n => "৳" + Number(n || 0).toLocaleString("en-BD", { maximumFractionDigits: 2 });
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const day = d => new Date(d).toLocaleDateString("en-CA");
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)));
const isUUID = s => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s));
const isRet = s => s.status === "returned";
const live = a => a.filter(s => !isRet(s));
const sumQty = a => a.reduce((n, s) => n + s.qty, 0), sumTotal = a => a.reduce((n, s) => n + s.total, 0);
const mask = v => hideNums ? '<span class="mask">••••</span>' : v;
const stock = p => (p.colours || []).reduce((a, c) => a + (c.sizes || []).reduce((b, z) => b + (z.qty || 0), 0), 0);

/* ---------- UI helpers ---------- */
function toast(x, type = "ok") {
  const t = $("#toast"); t.textContent = x; t.classList.toggle("error", type === "error"); t.classList.add("show");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), 2600);
}
function closeModal() { $("#modal").classList.remove("show"); $("#modalBox").innerHTML = ""; if (confirmResolve) { const r = confirmResolve; confirmResolve = null; r(false); } }
function confirmModal({ title, body, confirmText = "Confirm", danger = false }) {
  return new Promise(res => {
    openModal(`<h2>${esc(title)}</h2><div class="notice ${danger ? "warn" : ""}">${body}</div><div class="modal-foot"><button type="button" id="cNo" class="secondary">Cancel</button><button type="button" id="cYes" class="${danger ? "danger solid" : "primary"}">${esc(confirmText)}</button></div>`);
    confirmResolve = res;
    $("#cNo").onclick = closeModal;
    $("#cYes").onclick = () => { confirmResolve = null; closeModal(); res(true); };
  });
}
function openModal(html) { $("#modalBox").innerHTML = html; $("#modal").classList.add("show"); }
async function setStatus(kind) {
  const el = $("#syncPill"); if (!el) return;
  let q = 0; try { q = (await all("queue")).length; } catch {}
  const map = {
    busy: ["Syncing…", "busy"], off: ["Offline" + (q ? ` · ${q} pending` : ""), "off"],
    err: ["Sync issue" + (q ? ` · ${q} pending` : ""), "err"], ok: [q ? `${q} pending` : "Synced", q ? "off" : ""]
  };
  const [text, cls] = map[kind] || map.ok; el.textContent = text; el.className = "pill " + cls;
}

/* ---------- IndexedDB (local cache + offline queue) ---------- */
function openDB() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains("products")) d.createObjectStore("products", { keyPath: "id" });
      if (!d.objectStoreNames.contains("sales")) d.createObjectStore("sales", { keyPath: "id" });
      if (!d.objectStoreNames.contains("queue")) d.createObjectStore("queue", { keyPath: "qid", autoIncrement: true });
    };
    r.onsuccess = () => { db = r.result; resolve(); };
    r.onerror = () => reject(r.error);
  });
}
const req = (store, mode, method, arg) => new Promise((res, rej) => {
  const r = db.transaction(store, mode).objectStore(store)[method](arg);
  r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
});
const all = s => req(s, "readonly", "getAll");
const put = (s, o) => req(s, "readwrite", "put", o);
const del = (s, k) => req(s, "readwrite", "delete", k);
const clear = s => req(s, "readwrite", "clear");

/* ---------- cloud <-> app data shape ---------- */
const sizesToArr = s => {
  if (Array.isArray(s)) return s.map(z => ({ size: z.size, qty: Number(z.qty) || 0 }));
  const o = s || {}, keys = Object.keys(o);
  keys.sort((a, b) => (SIZES.indexOf(a) < 0 ? 99 : SIZES.indexOf(a)) - (SIZES.indexOf(b) < 0 ? 99 : SIZES.indexOf(b)));
  return keys.map(k => ({ size: k, qty: Number(o[k]) || 0 }));
};
const fromCloudP = r => ({ id: r.id, name: r.name, colours: (r.colours || []).map(c => ({ name: c.name, sizes: sizesToArr(c.sizes) })), createdAt: r.created_at, updatedAt: r.updated_at });
const toCloudP = p => ({
  id: p.id, user_id: user.id, name: p.name,
  colours: p.colours.map(c => ({ name: c.name, sizes: Object.fromEntries(sizesToArr(c.sizes).map(z => [z.size, z.qty])) })),
  created_at: p.createdAt || new Date().toISOString(), updated_at: new Date().toISOString()
});
const fromCloudS = r => ({ id: r.id, productId: r.product_id || null, name: r.product_name, colour: r.colour, size: r.size, qty: Number(r.quantity), price: Number(r.price), total: Number(r.total), date: r.date, customerName: r.customer_name || "", customerContact: r.customer_contact || "", status: r.status || "completed", returnedAt: r.returned_at || null });

async function cloudSaveProduct(p) { const { error } = await sb.from("products").upsert(toCloudP(p)); if (error) throw error; }
async function cloudSale(s) {
  const { error } = await sb.rpc("record_stock_sale", { p_id: s.id, p_product_id: s.productId, p_colour: s.colour, p_size: s.size, p_quantity: s.qty, p_price: s.price, p_customer_name: s.customerName || null, p_customer_contact: s.customerContact || null });
  if (error && !/duplicate key|already exists/i.test(error.message || "")) throw error;
}
async function cloudReturn(id) { const { error } = await sb.rpc("return_stock_sale", { p_sale_id: id }); if (error) throw error; }
async function cloudDeleteProduct(id) { const { error } = await sb.from("products").delete().eq("id", id); if (error) throw error; }
const enqueue = (op, payload) => put("queue", { op, payload });
const canSync = () => sb && user && navigator.onLine && !user.offlineOnly;

/* ---------- sync ---------- */
// Errors that will never succeed on retry (business rules) — drop the queued item instead of blocking the queue.
const isPermanent = e => /product not found|colour not found|sale not found|insufficient stock|invalid price|quantity must/i.test(e?.message || "") || /^23/.test(e?.code || "");
async function runFlush() {
  const q = (await all("queue")).sort((a, b) => a.qid - b.qid), failed = [];
  for (const x of q) {
    try {
      if (x.op === "product") await cloudSaveProduct(x.payload);
      else if (x.op === "sale") await cloudSale(x.payload);
      else if (x.op === "return") await cloudReturn(x.payload.id);
      else if (x.op === "delete_product") await cloudDeleteProduct(x.payload.id);
      await del("queue", x.qid);
    } catch (e) {
      console.warn("Pending item failed:", e.message || e);
      if (isPermanent(e)) { await del("queue", x.qid); if (x.op === "sale") await del("sales", x.payload.id); failed.push(e.message || "rejected"); }
      else break; // network/temporary problem: keep order and retry later
    }
  }
  return failed;
}
function flushQueue() { const p = lock.then(runFlush); lock = p.catch(() => {}); return p; }
async function pendingInfo() {
  const q = await all("queue"), products = new Set(), deletes = new Set(), returns = new Set(), sales = new Set();
  for (const x of q) {
    if (x.op === "product") products.add(x.payload.id);
    if (x.op === "sale") { sales.add(x.payload.id); if (x.payload.productId) products.add(x.payload.productId); }
    if (x.op === "return") { returns.add(x.payload.id); if (x.payload.productId) products.add(x.payload.productId); }
    if (x.op === "delete_product") deletes.add(x.payload.id);
  }
  return { products, deletes, returns, sales, count: q.length };
}
async function sync(manual = false) {
  if (syncing) return;
  if (!canSync()) { await setStatus("off"); return; }
  syncing = true; await setStatus("busy");
  try {
    const failed = await flushQueue();
    if (failed.length) toast("Some offline changes were rejected: " + failed[0], "error");
    const [{ data: p, error: a }, { data: s, error: b }] = await Promise.all([
      sb.from("products").select("*").order("created_at"),
      sb.from("sales").select("*").order("date", { ascending: false })
    ]);
    if (a) throw a; if (b) throw b;
    const pend = await pendingInfo();
    const keepP = new Set(), keepS = new Set();
    for (const x of p || []) { keepP.add(x.id); if (!pend.products.has(x.id) && !pend.deletes.has(x.id)) await put("products", fromCloudP(x)); }
    for (const x of s || []) { keepS.add(x.id); if (!pend.returns.has(x.id)) await put("sales", fromCloudS(x)); }
    // drop local rows that no longer exist in the cloud (unless they are still waiting to upload)
    for (const x of await all("products")) if (!keepP.has(x.id) && !pend.products.has(x.id)) await del("products", x.id);
    for (const x of await all("sales")) if (!keepS.has(x.id) && !pend.sales.has(x.id)) await del("sales", x.id);
    await setStatus("ok"); if (manual && !failed.length) toast("Sync completed");
  } catch (e) {
    console.warn("Sync:", e.message || e); await setStatus("err"); if (manual) toast("Cloud sync failed: " + (e.message || e), "error");
  } finally { syncing = false; }
}
// Run after any local change: upload now if online, otherwise leave queued.
async function afterChange(okMsg, queuedMsg) {
  if (!canSync()) { await setStatus("off"); return queuedMsg; }
  const failed = await flushQueue();
  if (failed.length) { toast("Could not sync: " + failed[0], "error"); await sync(); return null; }
  const left = (await all("queue")).length; await setStatus("ok");
  return left ? queuedMsg : okMsg;
}

/* ---------- realtime ---------- */
function startRealtime() {
  stopRealtime(); if (!canSync()) return;
  channel = sb.channel("stockflow-" + user.id)
    .on("postgres_changes", { event: "*", schema: "public", table: "products", filter: "user_id=eq." + user.id }, async pl => {
      try { const pend = await pendingInfo(); if (pl.eventType === "DELETE") await del("products", pl.old.id); else if (!pend.products.has(pl.new.id) && !pend.deletes.has(pl.new.id)) await put("products", fromCloudP(pl.new)); } catch (e) { console.error(e); }
      scheduleRender();
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "sales", filter: "user_id=eq." + user.id }, async pl => {
      try { const pend = await pendingInfo(); if (pl.eventType === "DELETE") await del("sales", pl.old.id); else if (!pend.returns.has(pl.new.id)) await put("sales", fromCloudS(pl.new)); } catch (e) { console.error(e); }
      scheduleRender();
    })
    .subscribe(s => console.log("Realtime:", s));
}
function stopRealtime() { if (channel && sb) { sb.removeChannel(channel); } channel = null; }
function scheduleRender() { clearTimeout(renderTimer); renderTimer = setTimeout(() => { if (!$("#modal").classList.contains("show")) render().catch(console.error); }, 200); }

/* ---------- auth ---------- */
function showAuth(msg = "", ok = false) {
  $("#authScreen").style.display = "flex"; $("#appShell").style.display = "none";
  const login = authMode === "login";
  $("#authTitle").textContent = login ? "Welcome back" : "Create your account";
  $("#authSubtitle").textContent = login ? "Sign in to access your inventory." : "Create an account to sync inventory across phones.";
  $("#authSubmit").textContent = login ? "Sign In" : "Create Account";
  $("#authConfirmWrap").style.display = login ? "none" : "flex";
  $("#authSwitch").textContent = login ? "Create an account" : "Already have an account? Sign in";
  $("#authPassword").autocomplete = login ? "current-password" : "new-password";
  const m = $("#authMessage"); m.textContent = msg; m.classList.toggle("ok", ok);
}
async function submitAuth(e) {
  e.preventDefault(); if (!sb) return showAuth("Cloud service not ready. Check your connection and refresh.");
  const email = $("#authEmail").value.trim(), password = $("#authPassword").value, btn = $("#authSubmit");
  btn.disabled = true; $("#authMessage").textContent = "";
  try {
    if (authMode === "login") {
      const { error } = await sb.auth.signInWithPassword({ email, password }); if (error) throw error;
      showAuth("Signing in…", true);
    } else {
      if (password !== $("#authConfirm").value) throw Error("Passwords do not match.");
      const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } });
      if (error) throw error;
      showAuth(data.session ? "Account created. Signing you in…" : "Account created. Check your email to confirm, then sign in.", true);
    }
  } catch (err) { console.error(err); showAuth(err.message || "Authentication failed."); }
  finally { btn.disabled = false; }
}
async function enterApp(u) {
  if (user && user.id === u.id && $("#appShell").style.display === "block") return;
  // never mix two accounts' cached data on one device
  if (localStorage.getItem("sf_uid") !== u.id) { await Promise.all([clear("products"), clear("sales"), clear("queue")]); localStorage.setItem("sf_uid", u.id); }
  localStorage.setItem("sf_email", u.email || "");
  user = u;
  $("#authScreen").style.display = "none"; $("#appShell").style.display = "block"; $("#userEmail").textContent = u.email || "";
  await render(); await sync(); startRealtime(); await render();
}
async function leaveApp() {
  stopRealtime(); user = null; $("#appShell").style.display = "none"; $("#authPassword").value = ""; showAuth();
}
async function initAuth() {
  const ready = CFG.url && CFG.publishableKey && !/YOUR_/.test(CFG.url + CFG.publishableKey);
  const offlineUid = localStorage.getItem("sf_uid");
  const offlineFallback = () => offlineUid && enterApp({ id: offlineUid, email: localStorage.getItem("sf_email") || "", offlineOnly: true });
  if (!ready) return showAuth("Supabase is not configured. Add your Project URL and Publishable key to config.js.");
  if (!window.supabase?.createClient) { if (await offlineFallback()) return; return showAuth("Could not load the cloud library. Check your internet connection and refresh."); }
  sb = window.supabase.createClient(CFG.url, CFG.publishableKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
  sb.auth.onAuthStateChange((event, session) => {
    // run outside the auth callback to avoid Supabase deadlocks
    setTimeout(async () => {
      try {
        if (event === "INITIAL_SESSION") {
          if (session) await enterApp(session.user);
          else if (!navigator.onLine && offlineUid) await offlineFallback();
          else showAuth();
        } else if (event === "SIGNED_IN" && session) { if (user?.offlineOnly) user = null; await enterApp(session.user); }
        else if (event === "SIGNED_OUT") { await leaveApp(); }
      } catch (e) { console.error(e); showAuth(e.message || "Authentication error."); }
    }, 0);
  });
}

/* ---------- views ---------- */
const EYE = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7S1 12 1 12z"/><circle cx="12" cy="12" r="3"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.9 17.9A10.9 10.9 0 0 1 12 19c-7 0-11-7-11-7a19.8 19.8 0 0 1 5.1-5.9M9.9 4.2A10.7 10.7 0 0 1 12 4c7 0 11 8 11 8a19.7 19.7 0 0 1-3.2 4.2M14.1 14.1a3 3 0 1 1-4.2-4.2"/><path d="M1 1l22 22"/></svg>';
function productHTML(p, out = false) {
  const chips = p.colours.map(c => {
    const list = (c.sizes || []).filter(z => z.qty > 0).map(z => z.size + " " + z.qty).join(" · ");
    return `<span class="chip ${list ? "" : "out"}"><b>${esc(c.name)}</b>: ${list || "out of stock"}</span>`;
  }).join("");
  const btns = out
    ? `<button class="primary" data-edit="${esc(p.id)}">Restock</button><button class="danger" data-del="${esc(p.id)}">Delete</button>`
    : `<button class="sell" data-sell="${esc(p.id)}">Sell</button><button class="secondary" data-edit="${esc(p.id)}">Edit</button><button class="danger" data-del="${esc(p.id)}">Delete</button>`;
  return `<div class="product ${out ? "is-out" : ""}"><div><h3>${esc(p.name)}${out ? ' <span class="badge out">Stock out</span>' : ""}</h3><span class="muted">${stock(p)} units · ${p.colours.length} colour(s)</span><div class="chips">${chips}</div></div><div>${btns}</div></div>`;
}
async function render() {
  const ps = (await all("products")).sort((a, b) => String(a.name).localeCompare(b.name)), ss = await all("sales");
  const meta = {
    dashboard: ["Dashboard", "Overview of your stock and sales"], inventory: ["Inventory", "Manage products, colours, sizes and stock"],
    sales: ["Sales History", "Every sale, synced to your account"], reports: ["Reports", "Sales and inventory summary"], settings: ["Settings", "Account, sync and backup"]
  }[page];
  $("#title").textContent = meta[0]; $("#sub").textContent = meta[1];
  $$(".nav").forEach(x => x.classList.toggle("active", x.dataset.page === page));
  const eye = $("#eyeBtn"); eye.style.display = page === "dashboard" ? "inline-flex" : "none";
  eye.innerHTML = hideNums ? EYE_OFF : EYE; eye.title = hideNums ? "Show details" : "Hide details"; eye.setAttribute("aria-label", eye.title);
  if (page === "dashboard") dash(ps, ss); if (page === "inventory") inventory(ps); if (page === "sales") sales(ss);
  if (page === "reports") reports(ps, ss); if (page === "settings") await settings();
  setStatus(navigator.onLine ? "ok" : "off");
}
function dash(ps, ss) {
  const ok = live(ss), today = day(new Date()), ts = ok.filter(s => day(s.date) === today);
  const recent = ss.slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 12);
  $("#content").innerHTML = `<div class="stats"><div class="stat"><small>PRODUCTS</small><strong>${mask(ps.length)}</strong></div><div class="stat"><small>AVAILABLE STOCK</small><strong>${mask(ps.reduce((a, p) => a + stock(p), 0))}</strong></div><div class="stat"><small>TODAY'S SALES</small><strong>${mask(sumQty(ts))}</strong></div><div class="stat"><small>TOTAL REVENUE</small><strong>${mask(money(sumTotal(ok)))}</strong></div></div><div class="card"><div class="card-head"><h2>Recent sales</h2><button class="secondary" id="viewAll">View all</button></div>${salesTable(recent, { mask: true })}</div>`;
  $("#viewAll").onclick = () => { page = "sales"; render(); };
}
function inventory(ps) {
  const inn = ps.filter(p => stock(p) > 0), out = ps.filter(p => stock(p) === 0);
  $("#content").innerHTML = `<div class="toolbar"><input id="search" class="search" placeholder="Search product or colour"></div><div class="seg"><button data-tab="in" class="${invTab === "in" ? "on" : ""}">In Stock <span>${inn.length}</span></button><button data-tab="out" class="${invTab === "out" ? "on" : ""}">Stock Out <span>${out.length}</span></button></div><div id="list"></div>`;
  const draw = () => {
    const q = $("#search").value.toLowerCase().trim(), base = invTab === "in" ? inn : out;
    const f = base.filter(p => !q || (p.name + " " + p.colours.map(c => c.name).join(" ")).toLowerCase().includes(q));
    $("#list").innerHTML = f.map(p => productHTML(p, invTab === "out")).join("") || `<div class="card empty">${q ? "No matches." : invTab === "in" ? "No products in stock. Click Add Product to begin." : "Nothing is out of stock. 🎉"}</div>`;
    $$("#list [data-sell]").forEach(b => b.onclick = () => sell(b.dataset.sell));
    $$("#list [data-edit]").forEach(b => b.onclick = () => openProduct(b.dataset.edit));
    $$("#list [data-del]").forEach(b => b.onclick = () => deleteProduct(b.dataset.del));
  };
  $$(".seg [data-tab]").forEach(b => b.onclick = () => { invTab = b.dataset.tab; $$(".seg [data-tab]").forEach(x => x.classList.toggle("on", x === b)); draw(); });
  $("#search").oninput = draw; draw();
}
function customerCell(s, m) {
  if (!s.customerName && !s.customerContact) return '<span class="muted">—</span>';
  const t = `${esc(s.customerName || "")}${s.customerContact ? `<small class="muted block">${esc(s.customerContact)}</small>` : ""}`;
  return m ? mask(t) : t;
}
function salesTable(a, o = {}) {
  if (!a.length) return '<div class="empty">No sales yet.</div>';
  const m = !!o.mask;
  return `<div class="table-wrap"><table class="table"><thead><tr><th>Date</th><th>Product</th><th>Colour</th><th>Size</th><th>Qty</th><th>Price</th><th>Total</th><th>Customer</th>${o.actions ? "<th></th>" : ""}</tr></thead><tbody>${a.map(s => `<tr class="${isRet(s) ? "returned" : ""}"><td>${new Date(s.date).toLocaleString()}</td><td>${esc(s.name)}${isRet(s) ? ' <span class="badge ret">Returned</span>' : ""}</td><td>${esc(s.colour)}</td><td>${esc(s.size)}</td><td>${s.qty}</td><td>${m ? mask(money(s.price)) : money(s.price)}</td><td><b class="tot">${m ? mask(money(s.total)) : money(s.total)}</b></td><td>${customerCell(s, m)}</td>${o.actions ? `<td>${isRet(s) ? "" : `<button class="secondary sm" data-return="${esc(s.id)}">Return</button>`}</td>` : ""}</tr>`).join("")}</tbody></table></div>`;
}
function sales(a) {
  a = a.slice().sort((x, y) => y.date.localeCompare(x.date));
  $("#content").innerHTML = `<div class="toolbar"><input id="salesSearch" class="search" placeholder="Search product, colour or customer" value="${esc(salesQuery)}"></div><div class="card" id="salesBox"></div>`;
  const draw = () => {
    const q = salesQuery.toLowerCase().trim();
    const f = q ? a.filter(s => [s.name, s.colour, s.customerName, s.customerContact].join(" ").toLowerCase().includes(q)) : a;
    $("#salesBox").innerHTML = f.length ? salesTable(f, { actions: true }) : `<div class="empty">${q ? "No matches." : "No sales yet."}</div>`;
    $$("[data-return]").forEach(b => b.onclick = () => returnSale(b.dataset.return));
  };
  $("#salesSearch").oninput = e => { salesQuery = e.target.value; draw(); }; draw();
}
function reports(ps, ss) {
  const ok = live(ss), ret = ss.filter(isRet), now = new Date(), yd = new Date(now); yd.setDate(yd.getDate() - 1);
  const t = day(now), y = day(yd), ts = ok.filter(s => day(s.date) === t), ys = ok.filter(s => day(s.date) === y);
  const by = {}; ok.forEach(s => by[s.name] = (by[s.name] || 0) + s.total);
  const card = (label, a) => `<div class="stat"><small>${label}</small><strong>${money(sumTotal(a))}</strong><em>${a.length} sale${a.length === 1 ? "" : "s"} · ${sumQty(a)} unit${sumQty(a) === 1 ? "" : "s"}</em></div>`;
  $("#content").innerHTML = `<div class="stats three">${card("TODAY'S REVENUE", ts)}${card("YESTERDAY'S REVENUE", ys)}${card("ALL-TIME REVENUE", ok)}</div><div class="stats"><div class="stat"><small>UNITS SOLD</small><strong>${sumQty(ok)}</strong></div><div class="stat"><small>STOCK</small><strong>${ps.reduce((a, p) => a + stock(p), 0)}</strong></div><div class="stat"><small>TRANSACTIONS</small><strong>${ok.length}</strong></div><div class="stat"><small>RETURNED</small><strong>${ret.length}</strong><em>${money(sumTotal(ret))} refunded</em></div></div><div class="card"><h2>Revenue by product</h2>${Object.entries(by).sort((a, b) => b[1] - a[1]).map(([n, v]) => `<div class="summary"><span>${esc(n)}</span><b>${money(v)}</b></div>`).join("") || '<div class="empty">No sales yet.</div>'}</div>`;
}
async function settings() {
  const q = (await all("queue")).length;
  $("#content").innerHTML = `<div class="grid"><div class="card"><h2>Account</h2><p class="muted">${esc(user?.email || "")}</p><p class="muted">${q ? q + " change(s) waiting to upload." : "Everything is synced."}</p><button id="syncNow" class="primary">Sync now</button> <button id="so" class="secondary">Sign out</button></div><div class="card"><h2>Backup</h2><p class="muted">Export your inventory and sales as a JSON file.</p><button id="backup" class="primary">Export Backup</button></div><div class="card"><h2>Import</h2><p class="muted">Import a StockFlow JSON backup (including old offline-only backups) into your cloud inventory. Existing data is kept.</p><input id="restore" type="file" accept=".json"></div></div>`;
  $("#syncNow").onclick = async () => { await sync(true); await render(); };
  $("#so").onclick = () => signOut();
  $("#backup").onclick = backup; $("#restore").onchange = e => restore(e.target.files[0]);
}

/* ---------- product form ---------- */
function fullSizes(arr) {
  const m = new Map(sizesToArr(arr).map(z => [z.size, z.qty]));
  const extra = [...m.keys()].filter(k => !SIZES.includes(k));
  return [...SIZES, ...extra].map(size => ({ size, qty: m.get(size) || 0 }));
}
async function openProduct(id = null) {
  let p = null; if (id) { p = (await all("products")).find(x => x.id === id); if (!p) return; }
  const initial = p?.colours?.length ? p.colours : [{ name: "", sizes: fullSizes([]) }];
  openModal(`<h2>${p ? (stock(p) === 0 ? "Restock Product" : "Edit Product") : "Add Product"}</h2><form id="productForm"><div class="field"><label>PRODUCT NAME</label><input id="productName" required value="${esc(p?.name || "")}" placeholder="e.g. Dior"></div><div class="field"><label>COLOURS & STOCK</label><div id="colours"></div><button type="button" id="addColour" class="secondary">＋ Add Colour</button></div><div class="modal-foot"><button type="button" id="cancel" class="secondary">Cancel</button><button type="submit" class="primary" id="saveBtn">Save Product</button></div></form>`);
  const box = $("#colours"); initial.forEach(c => addColourRow(box, { name: c.name, sizes: fullSizes(c.sizes) }));
  $("#addColour").onclick = () => addColourRow(box); $("#cancel").onclick = closeModal;
  $("#productForm").onsubmit = async e => {
    e.preventDefault(); const btn = $("#saveBtn"); btn.disabled = true;
    try {
      const name = $("#productName").value.trim();
      const colours = [...box.querySelectorAll(".colour")].map(c => ({
        name: c.querySelector(".colourName").value.trim(),
        sizes: [...c.querySelectorAll("[data-size]")].map(x => ({ size: x.dataset.size, qty: Math.max(0, parseInt(x.value || "0", 10) || 0) }))
      })).filter(c => c.name);
      if (!name) return toast("Enter a product name.", "error");
      if (!colours.length) return toast("Add at least one colour.", "error");
      if (!p && !colours.some(c => c.sizes.some(z => z.qty > 0))) return toast("Enter at least one quantity.", "error");
      const obj = { ...(p || {}), id: p?.id || uuid(), name, colours, createdAt: p?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
      await put("products", obj); await enqueue("product", obj);
      const msg = await afterChange("Product saved & synced", "Saved offline — will sync later");
      closeModal(); if (msg) toast(msg); await render();
    } catch (err) { console.error(err); toast("Could not save product.", "error"); }
    finally { btn.disabled = false; }
  };
}
function addColourRow(box, c = { name: "", sizes: fullSizes([]) }) {
  const d = document.createElement("div"); d.className = "colour";
  d.innerHTML = `<div style="display:flex;gap:8px"><input class="colourName" required placeholder="Colour e.g. Olive" value="${esc(c.name)}"><button type="button" class="danger removeColour">Remove</button></div><div class="sizes">${c.sizes.map(z => `<div class="size"><label>${esc(z.size)}</label><input data-size="${esc(z.size)}" type="number" min="0" step="1" value="${z.qty}"></div>`).join("")}</div>`;
  box.appendChild(d);
  d.querySelector(".removeColour").onclick = () => { if (box.children.length > 1) d.remove(); else toast("At least one colour is required.", "error"); };
}

/* ---------- delete product ---------- */
async function deleteProduct(id) {
  const p = (await all("products")).find(x => x.id === id); if (!p) return;
  const ok = await confirmModal({ title: "Delete product?", body: `<b>${esc(p.name)}</b> and its remaining stock (${stock(p)} units) will be permanently removed. Past sales stay in your Sales History and reports.`, confirmText: "Delete", danger: true });
  if (!ok) return;
  try {
    await del("products", id); await enqueue("delete_product", { id });
    const msg = await afterChange("Product deleted", "Deleted offline — will sync later");
    if (msg) toast(msg); await render();
  } catch (err) { console.error(err); toast("Could not delete product.", "error"); }
}

/* ---------- sell ---------- */
async function sell(id) {
  const p = (await all("products")).find(x => x.id === id); if (!p) return;
  openModal(`<h2>Record Sale</h2><div class="notice">${esc(p.name)} — stock is reduced automatically.</div><form id="saleForm"><div class="form-grid"><div class="field"><label>COLOUR</label><select id="saleColour">${p.colours.map((c, i) => `<option value="${i}">${esc(c.name)}</option>`).join("")}</select></div><div class="field"><label>SIZE</label><select id="saleSize"></select></div><div class="field"><label>QUANTITY</label><input id="saleQty" type="number" min="1" value="1" required></div><div class="field"><label>PRICE / UNIT (৳)</label><input id="salePrice" type="number" min="0" step=".01" required></div><div class="field"><label>CUSTOMER NAME <i>(optional)</i></label><input id="custName" maxlength="80" autocomplete="off" placeholder="e.g. Rahim"></div><div class="field"><label>CONTACT <i>(optional)</i></label><input id="custContact" maxlength="80" autocomplete="off" placeholder="Phone or email"></div></div><div id="available" class="muted"></div><div class="modal-foot"><button type="button" id="cancel" class="secondary">Cancel</button><button class="primary" id="saleBtn">Confirm Sale</button></div></form>`);
  const refresh = () => {
    const c = p.colours[+$("#saleColour").value], valid = c.sizes.filter(z => z.qty > 0), cur = $("#saleSize").value;
    $("#saleSize").innerHTML = valid.map(z => `<option value="${esc(z.size)}" ${z.size === cur ? "selected" : ""}>${esc(z.size)} — ${z.qty} available</option>`).join("");
    const a = valid.find(z => z.size === $("#saleSize").value)?.qty || 0;
    $("#available").textContent = valid.length ? `Available: ${a}` : "No stock for this colour"; $("#saleQty").max = a;
  };
  $("#saleColour").onchange = () => { $("#saleSize").value = ""; refresh(); }; $("#saleSize").onchange = refresh; $("#cancel").onclick = closeModal; refresh();
  $("#saleForm").onsubmit = async e => {
    e.preventDefault(); const btn = $("#saleBtn"); btn.disabled = true;
    try {
      const c = p.colours[+$("#saleColour").value], size = $("#saleSize").value, z = c.sizes.find(x => x.size === size), qty = parseInt($("#saleQty").value, 10), price = +$("#salePrice").value;
      if (!z || !(qty >= 1) || qty > z.qty) return toast("Not enough stock.", "error");
      if (!(price >= 0)) return toast("Enter a valid price.", "error");
      const s = { id: uuid(), productId: p.id, name: p.name, colour: c.name, size, qty, price, total: Math.round(qty * price * 100) / 100, date: new Date().toISOString(), customerName: $("#custName").value.trim(), customerContact: $("#custContact").value.trim(), status: "completed" };
      z.qty -= qty; p.updatedAt = new Date().toISOString();
      await put("products", p); await put("sales", s); await enqueue("sale", s);
      const msg = await afterChange("Sale recorded & synced", "Sale saved offline — will sync later");
      closeModal(); if (msg) toast(msg); await render();
    } catch (err) { console.error(err); toast("Could not record sale.", "error"); }
    finally { btn.disabled = false; }
  };
}

/* ---------- return / undo sale ---------- */
// Mirrors the database function return_stock_sale(): restores stock, flags the sale as returned (kept for audit, excluded from revenue).
async function applyLocalReturn(s) {
  let restored = false;
  const p = s.productId ? (await all("products")).find(x => x.id === s.productId) : null;
  if (p) {
    let c = p.colours.find(x => x.name === s.colour);
    if (!c) { c = { name: s.colour, sizes: [] }; p.colours.push(c); }
    let z = c.sizes.find(x => x.size === s.size);
    if (!z) { z = { size: s.size, qty: 0 }; c.sizes.push(z); }
    z.qty += s.qty; p.updatedAt = new Date().toISOString(); await put("products", p); restored = true;
  }
  s.status = "returned"; s.returnedAt = new Date().toISOString(); await put("sales", s);
  return restored;
}
async function returnSale(id) {
  const s = (await all("sales")).find(x => x.id === id); if (!s || isRet(s)) return;
  const hasProduct = s.productId && (await all("products")).some(x => x.id === s.productId);
  const ok = await confirmModal({
    title: "Return this sale?",
    body: `<b>${esc(s.name)}</b> · ${esc(s.colour)} · ${esc(s.size)} × ${s.qty}<br>Revenue reduces by <b>${money(s.total)}</b>.<br>${hasProduct ? `<b>${s.qty}</b> unit(s) go back into stock.` : "This product was deleted, so stock cannot be restored."}`,
    confirmText: "Confirm Return", danger: true
  });
  if (!ok) return;
  try {
    await applyLocalReturn(s); await enqueue("return", { id: s.id, productId: s.productId });
    const msg = await afterChange("Sale returned & synced", "Return saved offline — will sync later");
    if (msg) toast(msg); await render();
  } catch (err) { console.error(err); toast("Could not return sale.", "error"); }
}

/* ---------- backup / import ---------- */
async function backup() {
  const data = { version: 2, exportedAt: new Date().toISOString(), products: await all("products"), sales: await all("sales") };
  const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  a.download = "stockflow-backup-" + day(new Date()) + ".json"; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
async function restore(file) {
  if (!file) return;
  try {
    const d = JSON.parse(await file.text());
    if (!Array.isArray(d.products) || !Array.isArray(d.sales)) throw 0;
    if (!canSync()) return toast("Go online to import into your cloud inventory.", "error");
    if (!confirm(`Import ${d.products.length} product(s) and ${d.sales.length} sale(s) into your account?`)) return;
    const idMap = new Map(); let np = 0, ns = 0;
    for (const old of d.products) {
      const id = isUUID(old.id) ? old.id : (idMap.get(String(old.id)) || uuid()); idMap.set(String(old.id), id);
      const p = { id, name: old.name, colours: (old.colours || []).map(c => ({ name: c.name, sizes: fullSizes(c.sizes) })), createdAt: old.createdAt };
      await cloudSaveProduct(p); await put("products", p); np++;
    }
    for (const s of d.sales) {
      const pid = idMap.get(String(s.productId)) || (isUUID(s.productId) ? s.productId : null); if (!pid) continue;
      const row = { id: isUUID(s.id) ? s.id : uuid(), user_id: user.id, product_id: pid, product_name: s.name || s.productName, colour: s.colour, size: s.size, quantity: s.qty ?? s.quantity, price: s.price, total: s.total ?? (s.qty ?? s.quantity) * s.price, date: s.date, customer_name: s.customerName || null, customer_contact: s.customerContact || null, status: s.status === "returned" ? "returned" : "completed", returned_at: s.returnedAt || null };
      const { error } = await sb.from("sales").insert(row); if (error && error.code !== "23505") throw error; ns++;
    }
    await sync(); toast(`Imported ${np} product(s), ${ns} sale(s)`); await render();
  } catch (e) { console.error(e); toast("Import failed: " + (e.message || "invalid backup file"), "error"); }
}
async function signOut() { try { await sb?.auth.signOut(); } catch (e) { console.warn(e); } if (user) await leaveApp(); }

/* ---------- start ---------- */
$$(".nav").forEach(n => n.onclick = () => { page = n.dataset.page; render(); $("#side").classList.remove("open"); });
$("#addTop").onclick = () => openProduct();
$("#menu").onclick = () => $("#side").classList.toggle("open");
$("#signOut").onclick = signOut;
$("#eyeBtn").onclick = () => { hideNums = !hideNums; localStorage.setItem("sf_hide", hideNums ? "1" : "0"); render(); };
$("#modal").onclick = e => { if (e.target.id === "modal") closeModal(); };
$("#authForm").onsubmit = submitAuth;
$("#authSwitch").onclick = () => { authMode = authMode === "login" ? "signup" : "login"; showAuth(); };
addEventListener("online", () => sync().then(() => render()).catch(console.error));
addEventListener("offline", () => setStatus("off"));
document.addEventListener("visibilitychange", () => { if (!document.hidden && user) sync().then(() => render()).catch(console.error); });
addEventListener("error", e => { if (!user) { const m = $("#authMessage"); if (m) m.textContent = "Error: " + (e.message || "unknown"); } });
openDB().then(initAuth).catch(e => { console.error(e); showAuth("Local database could not be opened: " + (e.message || e)); });
if ("serviceWorker" in navigator) addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(console.warn));
