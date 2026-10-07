/* StockFlow — original UI + Supabase auth, realtime sync and offline queue */
const CFG = window.STOCKFLOW_SUPABASE || {};
const DB_NAME = "stockflow_cloud", DB_VERSION = 1;
const SIZES = ["XS", "S", "M", "L", "XL", "XXL"];
let db, sb, user = null, page = "dashboard", authMode = "login", channel = null, renderTimer = null, syncing = false;

const $ = s => document.querySelector(s), $$ = s => document.querySelectorAll(s);
const money = n => "৳" + Number(n || 0).toLocaleString("en-BD", { maximumFractionDigits: 2 });
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const day = d => new Date(d).toLocaleDateString("en-CA");
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)));
const isUUID = s => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s));
const stock = p => (p.colours || []).reduce((a, c) => a + (c.sizes || []).reduce((b, z) => b + (z.qty || 0), 0), 0);

/* ---------- UI helpers ---------- */
function toast(x, type = "ok") {
  const t = $("#toast"); t.textContent = x; t.classList.toggle("error", type === "error"); t.classList.add("show");
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), 2600);
}
function closeModal() { $("#modal").classList.remove("show"); $("#modalBox").innerHTML = ""; }
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
const fromCloudS = r => ({ id: r.id, productId: r.product_id, name: r.product_name, colour: r.colour, size: r.size, qty: Number(r.quantity), price: Number(r.price), total: Number(r.total), date: r.date });

async function cloudSaveProduct(p) { const { error } = await sb.from("products").upsert(toCloudP(p)); if (error) throw error; }
async function cloudSale(s) {
  const { error } = await sb.rpc("record_stock_sale", { p_id: s.id, p_product_id: s.productId, p_colour: s.colour, p_size: s.size, p_quantity: s.qty, p_price: s.price });
  if (error && !/duplicate key|already exists/i.test(error.message || "")) throw error;
}
const enqueue = (op, payload) => put("queue", { op, payload });
const canSync = () => sb && user && navigator.onLine && !user.offlineOnly;

/* ---------- sync ---------- */
async function flushQueue() {
  const q = (await all("queue")).sort((a, b) => a.qid - b.qid);
  for (const x of q) {
    try {
      if (x.op === "product") await cloudSaveProduct(x.payload); else if (x.op === "sale") await cloudSale(x.payload);
      await del("queue", x.qid);
    } catch (e) {
      console.warn("Pending item failed:", e.message || e);
      break; // keep order; retry next time
    }
  }
}
async function sync(manual = false) {
  if (syncing) return;
  if (!canSync()) { await setStatus("off"); return; }
  syncing = true; await setStatus("busy");
  try {
    await flushQueue();
    const [{ data: p, error: a }, { data: s, error: b }] = await Promise.all([
      sb.from("products").select("*").order("created_at"),
      sb.from("sales").select("*").order("date", { ascending: false })
    ]);
    if (a) throw a; if (b) throw b;
    const pending = new Set((await all("queue")).filter(x => x.op === "product").map(x => x.payload.id));
    const keepP = new Set(); for (const x of p || []) { keepP.add(x.id); if (!pending.has(x.id)) await put("products", fromCloudP(x)); }
    const keepS = new Set(); for (const x of s || []) { keepS.add(x.id); await put("sales", fromCloudS(x)); }
    // drop local rows that no longer exist in the cloud (unless waiting to upload)
    const sentSales = new Set((await all("queue")).filter(x => x.op === "sale").map(x => x.payload.id));
    for (const x of await all("products")) if (!keepP.has(x.id) && !pending.has(x.id)) await del("products", x.id);
    for (const x of await all("sales")) if (!keepS.has(x.id) && !sentSales.has(x.id)) await del("sales", x.id);
    await setStatus("ok"); if (manual) toast("Sync completed");
  } catch (e) {
    console.warn("Sync:", e.message || e); await setStatus("err"); if (manual) toast("Cloud sync failed: " + (e.message || e), "error");
  } finally { syncing = false; }
}

/* ---------- realtime ---------- */
function startRealtime() {
  stopRealtime(); if (!canSync()) return;
  channel = sb.channel("stockflow-" + user.id)
    .on("postgres_changes", { event: "*", schema: "public", table: "products", filter: "user_id=eq." + user.id }, async pl => {
      try { if (pl.eventType === "DELETE") await del("products", pl.old.id); else await put("products", fromCloudP(pl.new)); } catch (e) { console.error(e); }
      scheduleRender();
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "sales", filter: "user_id=eq." + user.id }, async pl => {
      try { if (pl.eventType === "DELETE") await del("sales", pl.old.id); else await put("sales", fromCloudS(pl.new)); } catch (e) { console.error(e); }
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
function productHTML(p) {
  return `<div class="product"><div><h3>${esc(p.name)}</h3><span class="muted">${stock(p)} units · ${p.colours.length} colour(s)</span><div class="chips">${p.colours.map(c => {
    const list = (c.sizes || []).filter(z => z.qty > 0).map(z => z.size + " " + z.qty).join(" · ");
    return `<span class="chip ${list ? "" : "out"}"><b>${esc(c.name)}</b>: ${list || "out of stock"}</span>`;
  }).join("")}</div></div><div><button class="sell" data-sell="${esc(p.id)}">Sell</button> <button class="secondary" data-edit="${esc(p.id)}">Edit</button></div></div>`;
}
async function render() {
  const ps = (await all("products")).sort((a, b) => String(a.name).localeCompare(b.name)), ss = await all("sales");
  const meta = {
    dashboard: ["Dashboard", "Overview of your stock and sales"], inventory: ["Inventory", "Manage products, colours, sizes and stock"],
    sales: ["Sales History", "Every completed sale, synced to your account"], reports: ["Reports", "Sales and inventory summary"], settings: ["Settings", "Account, sync and backup"]
  }[page];
  $("#title").textContent = meta[0]; $("#sub").textContent = meta[1];
  $$(".nav").forEach(x => x.classList.toggle("active", x.dataset.page === page));
  if (page === "dashboard") dash(ps, ss); if (page === "inventory") inventory(ps); if (page === "sales") sales(ss);
  if (page === "reports") reports(ps, ss); if (page === "settings") await settings();
  setStatus(navigator.onLine ? "ok" : "off");
}
function dash(ps, ss) {
  const today = day(new Date()), ts = ss.filter(s => day(s.date) === today), rev = ss.reduce((a, s) => a + s.total, 0);
  $("#content").innerHTML = `<div class="stats"><div class="stat"><small>PRODUCTS</small><strong>${ps.length}</strong></div><div class="stat"><small>AVAILABLE STOCK</small><strong>${ps.reduce((a, p) => a + stock(p), 0)}</strong></div><div class="stat"><small>TODAY'S SALES</small><strong>${ts.reduce((a, s) => a + s.qty, 0)}</strong></div><div class="stat"><small>TOTAL REVENUE</small><strong>${money(rev)}</strong></div></div><div class="grid"><div class="card"><h2>Inventory</h2>${ps.map(productHTML).join("") || '<div class="empty">No products yet.</div>'}</div><div class="card"><h2>Recent sales</h2>${salesTable(ss.slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 8))}</div></div>`;
  bindProductButtons();
}
function inventory(ps) {
  $("#content").innerHTML = `<div class="toolbar"><input id="search" class="search" placeholder="Search product or colour"></div><div id="list">${ps.map(productHTML).join("") || '<div class="card empty">No products yet. Click Add Product to begin.</div>'}</div>`;
  bindProductButtons();
  $("#search").oninput = () => {
    const q = $("#search").value.toLowerCase();
    $("#list").innerHTML = ps.filter(p => (p.name + " " + p.colours.map(c => c.name).join(" ")).toLowerCase().includes(q)).map(productHTML).join("") || '<div class="card empty">No matches.</div>';
    bindProductButtons();
  };
}
function bindProductButtons() {
  $$("[data-sell]").forEach(b => b.onclick = () => sell(b.dataset.sell));
  $$("[data-edit]").forEach(b => b.onclick = () => openProduct(b.dataset.edit));
}
function salesTable(a) {
  return a.length ? `<div class="table-wrap"><table class="table"><thead><tr><th>Date</th><th>Product</th><th>Colour</th><th>Size</th><th>Qty</th><th>Price</th><th>Total</th></tr></thead><tbody>${a.map(s => `<tr><td>${new Date(s.date).toLocaleString()}</td><td>${esc(s.name)}</td><td>${esc(s.colour)}</td><td>${esc(s.size)}</td><td>${s.qty}</td><td>${money(s.price)}</td><td><b>${money(s.total)}</b></td></tr>`).join("")}</tbody></table></div>` : '<div class="empty">No sales yet.</div>';
}
function sales(a) { a = a.slice().sort((x, y) => y.date.localeCompare(x.date)); $("#content").innerHTML = `<div class="card">${salesTable(a)}</div>`; }
function reports(ps, ss) {
  const by = {}; ss.forEach(s => by[s.name] = (by[s.name] || 0) + s.total);
  $("#content").innerHTML = `<div class="stats"><div class="stat"><small>UNITS SOLD</small><strong>${ss.reduce((a, s) => a + s.qty, 0)}</strong></div><div class="stat"><small>REVENUE</small><strong>${money(ss.reduce((a, s) => a + s.total, 0))}</strong></div><div class="stat"><small>STOCK</small><strong>${ps.reduce((a, p) => a + stock(p), 0)}</strong></div><div class="stat"><small>TRANSACTIONS</small><strong>${ss.length}</strong></div></div><div class="card"><h2>Revenue by product</h2>${Object.entries(by).sort((a, b) => b[1] - a[1]).map(([n, v]) => `<div class="summary"><span>${esc(n)}</span><b>${money(v)}</b></div>`).join("") || '<div class="empty">No sales yet.</div>'}</div>`;
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
  openModal(`<h2>${p ? "Edit Product" : "Add Product"}</h2><form id="productForm"><div class="field"><label>PRODUCT NAME</label><input id="productName" required value="${esc(p?.name || "")}" placeholder="e.g. Dior"></div><div class="field"><label>COLOURS & STOCK</label><div id="colours"></div><button type="button" id="addColour" class="secondary">＋ Add Colour</button></div><div class="modal-foot"><button type="button" id="cancel" class="secondary">Cancel</button><button type="submit" class="primary" id="saveBtn">Save Product</button></div></form>`);
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
      if (!colours.some(c => c.sizes.some(z => z.qty > 0))) return toast("Enter at least one quantity.", "error");
      const obj = { ...(p || {}), id: p?.id || uuid(), name, colours, createdAt: p?.createdAt || new Date().toISOString(), updatedAt: new Date().toISOString() };
      await put("products", obj);
      let msg = "Product saved";
      if (canSync()) { try { await cloudSaveProduct(obj); msg = "Product saved & synced"; } catch (err) { console.warn(err); await enqueue("product", obj); msg = "Saved locally — will sync later"; } }
      else { await enqueue("product", obj); msg = "Saved offline — will sync later"; }
      closeModal(); toast(msg); await render();
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

/* ---------- sell ---------- */
async function sell(id) {
  const p = (await all("products")).find(x => x.id === id); if (!p) return;
  openModal(`<h2>Record Sale</h2><div class="notice">${esc(p.name)} — stock is reduced automatically.</div><form id="saleForm"><div class="form-grid"><div class="field"><label>COLOUR</label><select id="saleColour">${p.colours.map((c, i) => `<option value="${i}">${esc(c.name)}</option>`).join("")}</select></div><div class="field"><label>SIZE</label><select id="saleSize"></select></div><div class="field"><label>QUANTITY</label><input id="saleQty" type="number" min="1" value="1" required></div><div class="field"><label>PRICE / UNIT (৳)</label><input id="salePrice" type="number" min="0" step=".01" required></div></div><div id="available" class="muted"></div><div class="modal-foot"><button type="button" id="cancel" class="secondary">Cancel</button><button class="primary" id="saleBtn">Confirm Sale</button></div></form>`);
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
      const s = { id: uuid(), productId: p.id, name: p.name, colour: c.name, size, qty, price, total: qty * price, date: new Date().toISOString() };
      z.qty -= qty; p.updatedAt = new Date().toISOString();
      await put("products", p); await put("sales", s);
      let msg = "Sale recorded";
      if (canSync()) {
        try { await flushQueue(); await cloudSale(s); msg = "Sale recorded & synced"; }
        catch (err) { console.warn(err); await enqueue("sale", s); msg = /insufficient|not found/i.test(err.message || "") ? "Cloud stock differs — will resolve on sync" : "Saved locally — will sync later"; }
      } else { await enqueue("sale", s); msg = "Sale saved offline — will sync later"; }
      closeModal(); toast(msg); await render();
    } catch (err) { console.error(err); toast("Could not record sale.", "error"); }
    finally { btn.disabled = false; }
  };
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
      const row = { id: isUUID(s.id) ? s.id : uuid(), user_id: user.id, product_id: pid, product_name: s.name || s.productName, colour: s.colour, size: s.size, quantity: s.qty ?? s.quantity, price: s.price, total: s.total ?? (s.qty ?? s.quantity) * s.price, date: s.date };
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
$("#modal").onclick = e => { if (e.target.id === "modal") closeModal(); };
$("#authForm").onsubmit = submitAuth;
$("#authSwitch").onclick = () => { authMode = authMode === "login" ? "signup" : "login"; showAuth(); };
addEventListener("online", () => sync().then(() => render()).catch(console.error));
addEventListener("offline", () => setStatus("off"));
document.addEventListener("visibilitychange", () => { if (!document.hidden && user) sync().then(() => render()).catch(console.error); });
addEventListener("error", e => { if (!user) { const m = $("#authMessage"); if (m) m.textContent = "Error: " + (e.message || "unknown"); } });
openDB().then(initAuth).catch(e => { console.error(e); showAuth("Local database could not be opened: " + (e.message || e)); });
if ("serviceWorker" in navigator) addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(console.warn));
