"use strict";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const money = (n) => (n == null ? "—" : "$" + Number(n).toFixed(2));
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

const CONDITIONS = ["Near Mint", "Lightly Played", "Moderately Played", "Heavily Played", "Damaged"];

// Base URL for the backend API. Empty = same origin (web). For the packaged
// iOS/Android app, set window.EXALTED_API_BASE in config.js to the deployed URL.
const API_BASE = (window.EXALTED_API_BASE || "").replace(/\/+$/, "");
const apiUrl = (path) => API_BASE + path;

const state = {
  inventory: [],
  wishlist: [],
  searchResults: [],
  detail: null,
  scanMatches: [],
  collapsedGroups: new Set(),
};

/* ---------------- Auth token ---------------- */
const TOKEN_KEY = "exalted_token";
let authToken = localStorage.getItem(TOKEN_KEY) || null;
function setToken(t) {
  authToken = t;
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}
function authHeaders(extra = {}) {
  return authToken ? { ...extra, Authorization: `Bearer ${authToken}` } : extra;
}
// Centralised fetch that attaches the token and handles expired sessions.
async function authFetch(url, opts = {}) {
  const r = await fetch(apiUrl(url), { ...opts, headers: authHeaders(opts.headers || {}) });
  if (r.status === 401) {
    setToken(null);
    showAuth();
    throw new Error("Session expired");
  }
  return r;
}

/* ---------------- API ---------------- */
const api = {
  async search(q, page = 0) {
    const r = await fetch(apiUrl(`/api/search?q=${encodeURIComponent(q)}&page=${page}`));
    if (!r.ok) throw new Error("Search failed");
    return r.json();
  },
  async getInventory() {
    return (await authFetch("/api/inventory")).json();
  },
  async addItem(item) {
    const r = await authFetch("/api/inventory", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(item),
    });
    if (!r.ok) throw new Error("Add failed");
    return r.json();
  },
  async patchItem(id, patch) {
    const r = await authFetch(`/api/inventory/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    return r.json();
  },
  async deleteItem(id) {
    return authFetch(`/api/inventory/${id}`, { method: "DELETE" });
  },
  async refresh() {
    return (await authFetch("/api/inventory/refresh", { method: "POST" })).json();
  },
  async getWishlist() {
    return (await authFetch("/api/wishlist")).json();
  },
  async addWish(item) {
    const r = await authFetch("/api/wishlist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(item),
    });
    if (!r.ok) throw new Error("Wishlist add failed");
    return r.json();
  },
  async deleteWish(id) {
    return authFetch(`/api/wishlist/${id}`, { method: "DELETE" });
  },
  // --- auth ---
  async me() {
    const r = await fetch(apiUrl("/api/auth/me"), { headers: authHeaders() });
    if (!r.ok) throw new Error("Not signed in");
    return r.json();
  },
  async login(username, password) {
    const r = await fetch(apiUrl("/api/auth/login"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || "Login failed");
    return d;
  },
  async register(username, password) {
    const r = await fetch(apiUrl("/api/auth/register"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || "Sign up failed");
    return d;
  },
  async logout() {
    try {
      await fetch(apiUrl("/api/auth/logout"), { method: "POST", headers: authHeaders() });
    } catch {
      /* ignore */
    }
  },
};

/* ---------------- Toast ---------------- */
let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 2600);
}

/* ---------------- View switching ---------------- */
function switchView(name) {
  $$(".tab, .bn-item").forEach((t) =>
    t.classList.toggle("active", t.dataset.view === name)
  );
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
  if (name === "add") setTimeout(() => $("#search-input").focus(), 50);
  if (name === "wishlist") renderWishlist();
  if (name === "collection") renderCollection();
  window.scrollTo({ top: 0 });
}
$$(".tab, .bn-item").forEach((t) =>
  t.addEventListener("click", () => switchView(t.dataset.view))
);
document.addEventListener("click", (e) => {
  const goto = e.target.closest("[data-goto]");
  if (goto) switchView(goto.dataset.goto);
});

/* ---------------- Collection ---------------- */
function ownedQty(productId) {
  return state.inventory
    .filter((i) => i.productId === productId)
    .reduce((s, i) => s + i.quantity, 0);
}
function isWished(productId) {
  return state.wishlist.some((i) => i.productId === productId);
}

function renderStats() {
  const items = state.inventory;
  const total = items.reduce((s, i) => s + (i.marketPrice || 0) * i.quantity, 0);
  const count = items.reduce((s, i) => s + i.quantity, 0);
  const unique = new Set(items.map((i) => i.productId)).size;
  $("#stat-value").textContent = money(total);
  $("#stat-count").textContent = count;
  $("#stat-unique").textContent = unique;
}

function renderCollection() {
  renderStats();
  const grid = $("#collection-grid");
  const empty = $("#collection-empty");
  let items = [...state.inventory];

  const f = $("#collection-filter").value.trim().toLowerCase();
  if (f) {
    items = items.filter(
      (i) =>
        i.name.toLowerCase().includes(f) ||
        (i.set || "").toLowerCase().includes(f) ||
        (i.number || "").toLowerCase().includes(f)
    );
  }

  const sort = $("#collection-sort").value;
  items.sort((a, b) => {
    if (sort === "name") return a.name.localeCompare(b.name);
    if (sort === "qty") return b.quantity - a.quantity;
    if (sort === "recent") return new Date(b.addedAt) - new Date(a.addedAt);
    return (b.marketPrice || 0) * b.quantity - (a.marketPrice || 0) * a.quantity; // value
  });

  empty.classList.toggle("hidden", state.inventory.length > 0);
  grid.classList.toggle("hidden", state.inventory.length === 0);

  const groupBy = $("#collection-group").value;
  if (groupBy === "none") {
    grid.innerHTML = items.map(collectionCardHTML).join("");
    return;
  }

  const keyOf = (i) =>
    groupBy === "set" ? i.set || "Unknown set" : i.rarity || "Unknown rarity";
  const groups = new Map();
  for (const i of items) {
    const k = keyOf(i);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(i);
  }
  const ordered = [...groups.entries()].sort((a, b) => {
    const va = a[1].reduce((s, i) => s + (i.marketPrice || 0) * i.quantity, 0);
    const vb = b[1].reduce((s, i) => s + (i.marketPrice || 0) * i.quantity, 0);
    return vb - va;
  });

  grid.innerHTML = ordered
    .map(([name, list]) => {
      const total = list.reduce((s, i) => s + (i.marketPrice || 0) * i.quantity, 0);
      const qty = list.reduce((s, i) => s + i.quantity, 0);
      const collapsed = state.collapsedGroups.has(name);
      const header = `
        <div class="group-header ${collapsed ? "collapsed" : ""}" data-group="${esc(name)}">
          <span class="chev">▼</span>
          <h3>${esc(name)}</h3>
          <span class="g-count">${qty} card${qty === 1 ? "" : "s"}</span>
          <span class="g-total">${money(total)}</span>
        </div>`;
      const cards = collapsed ? "" : list.map(collectionCardHTML).join("");
      return header + cards;
    })
    .join("");
}

function collectionCardHTML(i) {
  const lineVal = (i.marketPrice || 0) * i.quantity;
  return `
    <div class="card" data-inv="${i.id}">
      <div class="card-img-wrap" data-detail="${i.productId}">
        <img loading="lazy" src="${esc(i.image)}" alt="${esc(i.name)}"
             onerror="this.style.opacity=.25" />
        <span class="card-qty-badge">×${i.quantity}</span>
      </div>
      <div class="card-body" data-detail="${i.productId}">
        <div class="card-name">${esc(i.name)}</div>
        <div class="card-meta">${esc(i.set || "")}${i.number ? " · #" + esc(i.number) : ""}</div>
        <div class="card-foot">
          <span class="card-price">${money(lineVal)}<small>${money(i.marketPrice)} ea</small></span>
          <span class="rarity-pill">${esc(i.condition)}</span>
        </div>
      </div>
      <div class="mini-controls">
        <button class="qty-btn" data-dec="${i.id}">−</button>
        <span class="qty-num">${i.quantity}</span>
        <button class="qty-btn" data-inc="${i.id}">+</button>
        <button class="trash" data-del="${i.id}" title="Remove">🗑</button>
      </div>
    </div>`;
}

$("#collection-filter").addEventListener("input", renderCollection);
$("#collection-sort").addEventListener("change", renderCollection);
$("#collection-group").addEventListener("change", renderCollection);

$("#collection-grid").addEventListener("click", async (e) => {
  const group = e.target.closest("[data-group]");
  if (group) {
    const name = group.dataset.group;
    if (state.collapsedGroups.has(name)) state.collapsedGroups.delete(name);
    else state.collapsedGroups.add(name);
    return renderCollection();
  }

  const inc = e.target.closest("[data-inc]");
  const dec = e.target.closest("[data-dec]");
  const del = e.target.closest("[data-del]");
  const detail = e.target.closest("[data-detail]");

  if (inc) return changeQty(inc.dataset.inc, +1);
  if (dec) return changeQty(dec.dataset.dec, -1);
  if (del) {
    const item = state.inventory.find((i) => i.id === del.dataset.del);
    if (item && confirm(`Remove ${item.name} from your collection?`)) {
      await api.deleteItem(item.id);
      state.inventory = state.inventory.filter((i) => i.id !== item.id);
      renderCollection();
      toast("Removed");
    }
    return;
  }
  if (detail) openDetailById(Number(detail.dataset.detail));
});

async function changeQty(id, delta) {
  const item = state.inventory.find((i) => i.id === id);
  if (!item) return;
  const q = item.quantity + delta;
  await api.patchItem(id, { quantity: q });
  if (q <= 0) state.inventory = state.inventory.filter((i) => i.id !== id);
  else item.quantity = q;
  renderCollection();
}

$("#refresh-prices").addEventListener("click", async (e) => {
  if (!state.inventory.length) return toast("Nothing to refresh");
  e.target.disabled = true;
  e.target.textContent = "↻ Refreshing…";
  try {
    const res = await api.refresh();
    state.inventory = res.items;
    if (res.wishlist) state.wishlist = res.wishlist;
    renderCollection();
    toast(`Updated ${res.updated} price${res.updated === 1 ? "" : "s"}`);
  } catch {
    toast("Refresh failed");
  }
  e.target.disabled = false;
  e.target.textContent = "↻ Refresh prices";
});

/* ---------------- Wishlist ---------------- */
function renderWishlist() {
  const grid = $("#wishlist-grid");
  const empty = $("#wishlist-empty");
  let items = [...state.wishlist];

  const total = state.wishlist.reduce((s, i) => s + (i.marketPrice || 0), 0);
  $("#wish-value").textContent = money(total);
  $("#wish-count").textContent = state.wishlist.length;

  const f = $("#wish-filter").value.trim().toLowerCase();
  if (f) {
    items = items.filter(
      (i) => i.name.toLowerCase().includes(f) || (i.set || "").toLowerCase().includes(f)
    );
  }
  const sort = $("#wish-sort").value;
  items.sort((a, b) => {
    if (sort === "name") return a.name.localeCompare(b.name);
    if (sort === "recent") return new Date(b.addedAt) - new Date(a.addedAt);
    return (b.marketPrice || 0) - (a.marketPrice || 0);
  });

  empty.classList.toggle("hidden", state.wishlist.length > 0);
  grid.classList.toggle("hidden", state.wishlist.length === 0);

  grid.innerHTML = items
    .map(
      (i) => `
    <div class="card">
      <div class="card-img-wrap" data-detail="${i.productId}">
        <img loading="lazy" src="${esc(i.image)}" alt="${esc(i.name)}" onerror="this.style.opacity=.25" />
        ${ownedQty(i.productId) ? `<span class="card-qty-badge">Owned ×${ownedQty(i.productId)}</span>` : ""}
      </div>
      <div class="card-body" data-detail="${i.productId}">
        <div class="card-name">${esc(i.name)}</div>
        <div class="card-meta">${esc(i.set || "")}${i.number ? " · #" + esc(i.number) : ""}</div>
        <div class="card-foot">
          <span class="card-price">${money(i.marketPrice)}<small>market</small></span>
          ${i.rarity ? `<span class="rarity-pill">${esc(i.rarity)}</span>` : ""}
        </div>
      </div>
      <div class="wish-controls">
        <button class="btn primary" data-move="${i.id}">＋ Own it</button>
        <button class="btn ghost" data-wishdel="${i.id}">Remove</button>
      </div>
    </div>`
    )
    .join("");
}

$("#wish-filter").addEventListener("input", renderWishlist);
$("#wish-sort").addEventListener("change", renderWishlist);

$("#wishlist-grid").addEventListener("click", async (e) => {
  const move = e.target.closest("[data-move]");
  const del = e.target.closest("[data-wishdel]");
  const detail = e.target.closest("[data-detail]");

  if (move) {
    const item = state.wishlist.find((i) => i.id === move.dataset.move);
    if (!item) return;
    await addToCollection(item, { condition: "Near Mint", quantity: 1 });
    await api.deleteWish(item.id);
    state.wishlist = state.wishlist.filter((i) => i.id !== item.id);
    renderWishlist();
    return;
  }
  if (del) {
    const item = state.wishlist.find((i) => i.id === del.dataset.wishdel);
    if (item) {
      await api.deleteWish(item.id);
      state.wishlist = state.wishlist.filter((i) => i.id !== item.id);
      renderWishlist();
      if (state.searchResults.length) renderSearchGrid(state.searchResults);
      toast("Removed from wishlist");
    }
    return;
  }
  if (detail) openDetailById(Number(detail.dataset.detail));
});

$("#wish-refresh").addEventListener("click", async (e) => {
  if (!state.wishlist.length && !state.inventory.length) return toast("Nothing to refresh");
  e.target.disabled = true;
  e.target.textContent = "↻ Refreshing…";
  try {
    const res = await api.refresh();
    state.inventory = res.items;
    if (res.wishlist) state.wishlist = res.wishlist;
    renderWishlist();
    toast(`Updated ${res.updated} price${res.updated === 1 ? "" : "s"}`);
  } catch {
    toast("Refresh failed");
  }
  e.target.disabled = false;
  e.target.textContent = "↻ Refresh prices";
});

/* ---------------- Search ---------------- */
let searchTimer;
const searchInput = $("#search-input");
searchInput.addEventListener("input", () => {
  clearTimeout(searchTimer);
  const q = searchInput.value.trim();
  if (q.length < 2) {
    $("#search-grid").innerHTML = "";
    $("#search-status").textContent = "";
    return;
  }
  searchTimer = setTimeout(() => runSearch(q), 300);
});

function skeletons(n = 8) {
  return Array.from({ length: n }, () => `<div class="skeleton"></div>`).join("");
}

async function runSearch(q) {
  $("#search-status").textContent = `Searching “${q}”…`;
  $("#search-grid").innerHTML = skeletons();
  try {
    const { products, total } = await api.search(q);
    state.searchResults = products;
    $("#search-status").textContent = products.length
      ? `${total.toLocaleString()} result${total === 1 ? "" : "s"} for “${q}”`
      : `No results for “${q}”`;
    renderSearchGrid(products);
  } catch {
    $("#search-status").textContent = "Search failed — is the server running?";
    $("#search-grid").innerHTML = "";
  }
}

function productCardHTML(p) {
  const owned = ownedQty(p.productId);
  return `
    <div class="card" data-detail="${p.productId}">
      <div class="card-img-wrap">
        <img loading="lazy" src="${esc(p.image)}" alt="${esc(p.name)}"
             onerror="this.style.opacity=.25" />
        ${owned ? `<span class="card-qty-badge">Owned ×${owned}</span>` : ""}
        ${isWished(p.productId) ? `<span class="heart-badge">♥</span>` : ""}
      </div>
      <div class="card-body">
        <div class="card-name">${esc(p.name)}</div>
        <div class="card-meta">${esc(p.set || "")}${p.number ? " · #" + esc(p.number) : ""}</div>
        <div class="card-foot">
          <span class="card-price">${money(p.marketPrice)}<small>market</small></span>
          ${p.rarity ? `<span class="rarity-pill">${esc(p.rarity)}</span>` : ""}
        </div>
      </div>
    </div>`;
}

function renderSearchGrid(products) {
  $("#search-grid").innerHTML = products.map(productCardHTML).join("");
}

$("#search-grid").addEventListener("click", (e) => {
  const d = e.target.closest("[data-detail]");
  if (d) openDetailById(Number(d.dataset.detail));
});

/* ---------------- Detail modal ---------------- */
function findProduct(productId) {
  return (
    state.searchResults.find((p) => p.productId === productId) ||
    state.scanMatches.find((p) => p.productId === productId) ||
    state.inventory.find((p) => p.productId === productId) ||
    state.wishlist.find((p) => p.productId === productId)
  );
}

function openDetailById(productId) {
  const p = findProduct(productId);
  if (!p) return;
  state.detail = p;
  renderDetail(p);
  $("#detail-modal").classList.remove("hidden");
}

function renderDetail(p) {
  const a = p.attributes || {};
  const owned = ownedQty(p.productId);
  const attackList = (a.attacks || []).map((x) => `<li>${esc(x)}</li>`).join("");
  const rows = [
    ["Set", p.set],
    ["Number", p.number],
    ["Rarity", p.rarity],
    ["HP", a.hp],
    ["Stage", a.stage],
    ["Type", (a.energyType || []).join(", ") || (a.cardType || []).join(", ")],
    ["Weakness", a.weakness],
    ["Resistance", a.resistance],
    ["Retreat", a.retreatCost],
    ["Listings", p.totalListings ? p.totalListings.toLocaleString() : null],
  ]
    .filter(([, v]) => v)
    .map(([k, v]) => `<tr><td>${k}</td><td>${esc(v)}</td></tr>`)
    .join("");

  $("#detail-body").innerHTML = `
    <div class="detail-img">
      <img src="${esc(p.imageLarge || p.image)}" alt="${esc(p.name)}"
           onerror="this.src='${esc(p.image)}'" />
    </div>
    <div class="detail-info">
      <h2>${esc(p.name)}</h2>
      <div class="detail-set">${esc(p.set || "")}${p.number ? " · #" + esc(p.number) : ""}</div>
      ${owned ? `<div class="owned-banner">✓ In your collection — ${owned} card${owned === 1 ? "" : "s"}</div>` : ""}
      <div class="price-row">
        <div class="price-chip market"><div class="lbl">Market</div><div class="val">${money(p.marketPrice)}</div></div>
        <div class="price-chip"><div class="lbl">Median</div><div class="val">${money(p.medianPrice)}</div></div>
        <div class="price-chip"><div class="lbl">Lowest</div><div class="val">${money(p.lowestPrice)}</div></div>
      </div>
      <table class="attr-table">${rows}</table>
      ${attackList ? `<ul class="attacks">${attackList}</ul>` : ""}
      ${a.flavorText ? `<p class="flavor">${esc(a.flavorText)}</p>` : ""}
      <div class="add-controls">
        <select id="detail-condition">
          ${CONDITIONS.map((c) => `<option>${c}</option>`).join("")}
        </select>
        <input id="detail-qty" type="number" min="1" value="1" />
        <button class="btn primary" id="detail-add">＋ Add to collection</button>
        <button class="btn heart ${isWished(p.productId) ? "active" : ""}" id="detail-wish">
          ${isWished(p.productId) ? "♥ Wishlisted" : "♡ Wishlist"}
        </button>
      </div>
      <a class="tcg-link" href="${esc(p.url)}" target="_blank" rel="noopener">View on TCGplayer ↗</a>
    </div>`;

  $("#detail-add").addEventListener("click", () => addToCollection(p));
  $("#detail-wish").addEventListener("click", () => toggleWish(p));
}

async function toggleWish(p) {
  const existing = state.wishlist.find((i) => i.productId === p.productId);
  if (existing) {
    await api.deleteWish(existing.id);
    state.wishlist = state.wishlist.filter((i) => i.id !== existing.id);
    toast(`Removed from wishlist`);
  } else {
    const saved = await api.addWish({
      productId: p.productId,
      name: p.name,
      set: p.set,
      number: p.number,
      rarity: p.rarity,
      image: p.image,
      imageLarge: p.imageLarge,
      url: p.url,
      sealed: p.sealed,
      attributes: p.attributes,
      marketPrice: p.marketPrice,
    });
    state.wishlist.unshift(saved);
    toast(`♥ Added to wishlist`);
  }
  if (state.detail && state.detail.productId === p.productId) renderDetail(p);
  if (state.searchResults.length) renderSearchGrid(state.searchResults);
  renderWishlist();
}

async function addToCollection(p, opts = {}) {
  const condition = opts.condition || $("#detail-condition")?.value || "Near Mint";
  const quantity = opts.quantity || Number($("#detail-qty")?.value) || 1;
  const item = {
    productId: p.productId,
    name: p.name,
    set: p.set,
    number: p.number,
    rarity: p.rarity,
    image: p.image,
    imageLarge: p.imageLarge,
    url: p.url,
    sealed: p.sealed,
    attributes: p.attributes,
    marketPrice: p.marketPrice,
    condition,
    quantity,
  };
  const saved = await api.addItem(item);
  const idx = state.inventory.findIndex((i) => i.id === saved.id);
  if (idx >= 0) state.inventory[idx] = saved;
  else state.inventory.unshift(saved);
  renderCollection();
  if (state.searchResults.length) renderSearchGrid(state.searchResults);
  toast(`Added ${quantity}× ${p.name}`);
  if (opts.keepScan) return saved;
  closeModals();
  return saved;
}

async function addScanMatch(productId, btn) {
  const p = findProduct(productId);
  if (!p) return;
  try {
    await addToCollection(p, { keepScan: true });
    if (btn) {
      btn.textContent = "✓ Added";
      btn.classList.add("added");
      btn.disabled = true;
    }
  } catch {
    toast("Couldn't add — try again");
  }
}

/* ---------------- Modals close ---------------- */
function closeModals() {
  $("#detail-modal").classList.add("hidden");
  $("#camera-modal").classList.add("hidden");
  stopCamera();
}
document.addEventListener("click", (e) => {
  if (e.target.closest("[data-close]")) closeModals();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeModals();
});

/* ---------------- Camera / OCR scan ---------------- */
const cam = {
  stream: null,
  video: $("#cam-video"),
  canvas: $("#cam-canvas"),
  preview: $("#scan-preview"),
};

$("#open-camera").addEventListener("click", openCamera);

/* ----- Auto-capture: time-based countdown once a card is detected ----- */
const STAGE_ASPECT = 3 / 4;
const GUIDE_INSET_X = 0.11;
const GUIDE_INSET_Y = 0.06;
const CARD_HOLD_MS = 2800; // capture after this many ms of card-in-frame

const det = document.createElement("canvas");
det.width = 160;
det.height = 160;
const dctx = det.getContext("2d", { willReadFrequently: true });
let detTimer = null;
let cardVisibleMs = 0;
let lastDetTick = 0;

// Map the guide box to source pixels in the video stream.
function guideRegion(v) {
  const va = v.videoWidth / v.videoHeight;
  let sx, sy, sw, sh;
  if (va > STAGE_ASPECT) {
    sh = v.videoHeight;
    sw = sh * STAGE_ASPECT;
    sx = (v.videoWidth - sw) / 2;
    sy = 0;
  } else {
    sw = v.videoWidth;
    sh = sw / STAGE_ASPECT;
    sx = 0;
    sy = (v.videoHeight - sh) / 2;
  }
  return {
    x: sx + GUIDE_INSET_X * sw,
    y: sy + GUIDE_INSET_Y * sh,
    w: sw * (1 - 2 * GUIDE_INSET_X),
    h: sh * (1 - 2 * GUIDE_INSET_Y),
  };
}

// The visible area on screen (the `cover`-cropped stage) — what the user sees and
// lines the card up against. Capturing exactly this makes capture WYSIWYG.
function visibleRegion(v) {
  const va = v.videoWidth / v.videoHeight;
  let sx, sy, sw, sh;
  if (va > STAGE_ASPECT) {
    sh = v.videoHeight;
    sw = sh * STAGE_ASPECT;
    sx = (v.videoWidth - sw) / 2;
    sy = 0;
  } else {
    sw = v.videoWidth;
    sh = sw / STAGE_ASPECT;
    sx = 0;
    sy = (v.videoHeight - sh) / 2;
  }
  return { x: sx, y: sy, w: sw, h: sh };
}

function captureFromGuide() {
  const v = cam.video;
  if (!v.videoWidth) return null;
  // Capture the full visible stage (no inset) so the whole card the user framed is
  // included with a little margin. Matches the on-screen preview exactly.
  const r = visibleRegion(v);
  const c = cam.canvas;
  c.width = Math.round(r.w);
  c.height = Math.round(r.h);
  c.getContext("2d").drawImage(v, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.95);
}

// Simple edge-density check — tells us if something card-like is in frame.
function edgeDensity() {
  const v = cam.video;
  if (!v.videoWidth) return 0;
  const g = guideRegion(v);
  dctx.drawImage(v, g.x, g.y, g.w, g.h, 0, 0, det.width, det.height);
  const { data } = dctx.getImageData(0, 0, det.width, det.height);
  const W = det.width;
  const H = det.height;
  let edges = 0;
  const total = (W - 2) * (H - 2);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = (y * W + x) * 4;
      const lum = (data[i] + data[i + 1] + data[i + 2]) / 3;
      const r = (data[i + 4] + data[i + 5] + data[i + 6]) / 3;
      const b = (data[i + W * 4] + data[i + W * 4 + 1] + data[i + W * 4 + 2]) / 3;
      if (Math.abs(lum - r) + Math.abs(lum - b) > 28) edges++;
    }
  }
  return edges / total;
}

function setHint(text, good) {
  const h = $("#scan-hint");
  h.classList.remove("hidden");
  h.textContent = text;
  h.classList.toggle("good", !!good);
}

function detLoop() {
  if (!cam.stream) return;

  const now = Date.now();
  const elapsed = lastDetTick ? Math.min(now - lastDetTick, 300) : 110;
  lastDetTick = now;

  const density = edgeDensity();
  // A card in frame has lots of edges (text, border, artwork). Plain table/wall = low.
  const cardPresent = density > 0.04;

  const guide = $("#scan-guide");
  const ring = $("#scan-ring");
  guide.classList.remove("detect", "locking");

  if (!cardPresent) {
    cardVisibleMs = 0;
    ring.classList.remove("show");
    setHint("Point at a card…", false);
  } else {
    cardVisibleMs += elapsed;
    const progress = Math.min(100, Math.round((cardVisibleMs / CARD_HOLD_MS) * 100));
    const secsLeft = Math.max(0, Math.ceil((CARD_HOLD_MS - cardVisibleMs) / 1000));

    guide.classList.add("locking");
    ring.classList.add("show");
    ring.style.setProperty("--p", progress);
    setHint(secsLeft > 0 ? `Hold still… ${secsLeft}s` : "Scanning…", true);

    if ($("#auto-capture").checked && cardVisibleMs >= CARD_HOLD_MS) {
      autoCapture();
      return;
    }
  }
  detTimer = setTimeout(detLoop, 110);
}

function startDetect() {
  stopDetect();
  cardVisibleMs = 0;
  lastDetTick = 0;
  $("#scan-guide").classList.remove("hidden");
  detLoop();
}
function stopDetect() {
  clearTimeout(detTimer);
  detTimer = null;
}

function autoCapture() {
  const url = captureFromGuide();
  if (!url) return;
  stopDetect();
  showCaptured(url);
  toast("Card captured");
  recognize(url);
}

function cameraUnavailable(html) {
  stopDetect();
  cam.video.classList.add("hidden");
  $("#scan-guide").classList.add("hidden");
  $("#scan-hint").classList.add("hidden");
  $("#capture-btn").classList.add("hidden");
  $("#scan-results").innerHTML = `<div class="scan-ocr">${html}</div>`;
}

async function openCamera() {
  $("#camera-modal").classList.remove("hidden");
  resetScanUI();

  // Camera APIs only exist in a secure context (https:// or localhost).
  const secure = window.isSecureContext && navigator.mediaDevices?.getUserMedia;
  if (!secure) {
    const host = location.hostname;
    const httpsUrl = `https://${host}:3443`;
    const onLan = host !== "localhost" && host !== "127.0.0.1";
    cameraUnavailable(
      onLan
        ? `📷 The camera is blocked because this page is on an unsecured <b>http://</b> address.<br><br>
           Open the secure address instead: <b><a href="${httpsUrl}" style="color:#4f8cff">${httpsUrl}</a></b><br>
           (tap <b>Advanced → Proceed</b> past the certificate warning), then try Scan again.<br><br>
           Or just use <b>Upload photo</b> below — that always works.`
        : `📷 Camera not available in this browser. Use <b>Upload photo</b> below instead.`
    );
    return;
  }

  try {
    cam.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: { ideal: 1280 } },
      audio: false,
    });
    cam.video.srcObject = cam.stream;
    cam.video.classList.remove("hidden");
    cam.video.onloadeddata = () => startDetect();
  } catch (err) {
    if (err.name === "NotAllowedError" || err.name === "SecurityError") {
      cameraUnavailable(
        `📷 Camera permission was blocked. Allow camera access for this site in your browser settings, then reopen Scan — or use <b>Upload photo</b> below.`
      );
    } else if (err.name === "NotFoundError" || err.name === "OverconstrainedError") {
      cameraUnavailable(
        `📷 No camera was found on this device. Use <b>Upload photo</b> below to scan a card image.`
      );
    } else {
      cameraUnavailable(
        `📷 Couldn't start the camera (${esc(err.name || "error")}). Use <b>Upload photo</b> below instead.`
      );
    }
  }
}

function stopCamera() {
  stopDetect();
  if (cam.stream) {
    cam.stream.getTracks().forEach((t) => t.stop());
    cam.stream = null;
  }
}

function resetScanUI() {
  cam.preview.classList.add("hidden");
  cam.video.classList.remove("hidden");
  $("#capture-btn").classList.remove("hidden");
  $("#retake-btn").classList.add("hidden");
  $("#scan-progress").classList.add("hidden");
  $("#scan-results").innerHTML = "";
  state.scanMatches = [];
  if (cam.stream) startDetect();
}

$("#capture-btn").addEventListener("click", () => {
  const url = captureFromGuide();
  if (!url) return;
  stopDetect();
  showCaptured(url);
  recognize(url);
});

$("#scan-file").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  stopDetect();
  const reader = new FileReader();
  reader.onload = () => {
    showCaptured(reader.result);
    recognize(reader.result);
  };
  reader.readAsDataURL(file);
});

$("#retake-btn").addEventListener("click", resetScanUI);

function showCaptured(url) {
  cam.preview.src = url;
  cam.preview.classList.remove("hidden");
  cam.video.classList.add("hidden");
  $("#scan-guide").classList.add("hidden");
  $("#scan-hint").classList.add("hidden");
  $("#capture-btn").classList.add("hidden");
  $("#retake-btn").classList.remove("hidden");
}

// Card boilerplate that should never be treated as the card name.
const STOP_TOKENS = new Set([
  "hp", "basic", "stage", "gx", "ex", "v", "vmax", "vstar", "vunion", "tag",
  "team", "pokemon", "pokémon", "trainer", "energy", "item", "supporter",
  "stadium", "tool", "ability", "ancient", "future", "weakness", "resistance",
  "retreat", "damage", "evolves", "evolution", "rule", "box", "the", "and",
  "your", "you", "opponent", "this", "that", "into", "with", "when", "each",
  "all", "may", "for", "search", "deck", "attack", "card", "cards", "play",
  "any", "ose", "from", "draw", "discard", "turn", "active", "bench", "prize",
  "take", "flip", "coin", "put", "its", "are", "his", "her",
]);
const SENTENCE_WORDS =
  /\b(the|and|your|you|opponent|into|with|when|each|may|for|search|deck|play|any|this|that|from|draw|discard|are|its|put|take|flip|damage|attach|during)\b/i;

const cleanWord = (t) => (t || "").replace(/[^A-Za-z'’.\-]/g, "");

const loadImage = (src) =>
  new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = src;
  });

// Downscale to a JPEG data URL (keeps cloud-OCR upload small + fast).
async function toJpeg(url, maxDim = 1600, quality = 0.92) {
  // Skip re-encoding if it's already a reasonably-sized JPEG (camera captures).
  if (url.startsWith("data:image/jpeg") && url.length < 3_500_000) return url;
  const img = await loadImage(url);
  let w = img.naturalWidth || img.width;
  let h = img.naturalHeight || img.height;
  const scale = Math.min(1, maxDim / Math.max(w, h));
  w = Math.round(w * scale);
  h = Math.round(h * scale);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  c.getContext("2d").drawImage(img, 0, 0, w, h);
  return c.toDataURL("image/jpeg", quality);
}

// Upscale small captures + grayscale & boost contrast — improves OCR a lot.
async function preprocess(url) {
  const img = await loadImage(url);
  const srcW = img.naturalWidth || img.width;
  const srcH = img.naturalHeight || img.height;
  if (!srcW) return url;
  const targetW = Math.min(1700, Math.max(1100, srcW));
  const scale = targetW / srcW;
  const w = Math.round(srcW * scale);
  const h = Math.round(srcH * scale);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d");
  ctx.drawImage(img, 0, 0, w, h);
  const id = ctx.getImageData(0, 0, w, h);
  const d = id.data;
  const contrast = 1.22;
  const intercept = 128 * (1 - contrast);
  for (let i = 0; i < d.length; i += 4) {
    let g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    g = g * contrast + intercept;
    g = g < 0 ? 0 : g > 255 ? 255 : g;
    d[i] = d[i + 1] = d[i + 2] = g;
  }
  ctx.putImageData(id, 0, 0);
  return c.toDataURL("image/jpeg", 0.92);
}

// Flatten Tesseract word objects from whatever shape v5 returns.
function collectWords(data) {
  if (Array.isArray(data.words) && data.words.length) return data.words;
  const out = [];
  const pushLines = (lines) =>
    lines && lines.forEach((l) => l.words && out.push(...l.words));
  const walk = (blocks) =>
    blocks &&
    blocks.forEach((b) => {
      if (b.words) out.push(...b.words);
      pushLines(b.lines);
      b.paragraphs && b.paragraphs.forEach((p) => pushLines(p.lines));
      walk(b.blocks);
    });
  walk(data.blocks);
  return out;
}

// The card NAME is the largest alphabetic text near the top of the card.
// Using font size (word box height) is far more reliable than line position.
function nameFromWords(words) {
  const ws = words
    .map((w) => ({
      text: cleanWord(w.text),
      h: (w.bbox?.y1 ?? 0) - (w.bbox?.y0 ?? 0),
      x: w.bbox?.x0 ?? 0,
      y: w.bbox?.y0 ?? 0,
      conf: w.confidence ?? 0,
    }))
    .filter((w) => w.text.length >= 2 && w.conf > 25);
  if (!ws.length) return "";

  const imgH = Math.max(...ws.map((w) => w.y + w.h)) || 1;
  const named = ws.filter(
    (w) =>
      /[A-Za-z]/.test(w.text) &&
      !STOP_TOKENS.has(w.text.toLowerCase()) &&
      w.y < imgH * 0.6 // names sit in the upper part of the card
  );
  if (!named.length) return "";

  const maxH = Math.max(...named.map((w) => w.h));
  const big = named.filter((w) => w.h >= maxH * 0.62);
  const tallest = big.reduce((a, b) => (b.h > a.h ? b : a));
  return big
    .filter((w) => Math.abs(w.y - tallest.y) <= tallest.h * 0.9)
    .sort((a, b) => a.x - b.x)
    .map((w) => w.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

// Fallback when word boxes are unavailable: score raw text lines.
function nameFromLines(lines) {
  const scored = lines
    .map((line, idx) => {
      const clean = line.replace(/[^A-Za-z'’.\- ]/g, "").trim();
      const words = clean.split(/\s+/).filter(Boolean);
      const letters = (clean.match(/[A-Za-z]/g) || []).length;
      if (letters < 3 || words.length > 4) return null;
      let score = 0;
      if (idx < 4) score += 8 - idx * 2;
      if (/^[A-Z]/.test(clean)) score += 3;
      if (SENTENCE_WORDS.test(line)) score -= 10;
      if (/HP|©|Illus|Weakness|Resistance|Retreat|Stage|Basic/i.test(line)) score -= 6;
      score += Math.max(0, 4 - words.length);
      return { text: clean, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
  return scored[0]?.text || "";
}

function parseOcr(data) {
  const text = data.text || "";
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const numberMatch = text.match(/\b(\d{1,3})\s*\/\s*(\d{1,3})\b/);
  const number = numberMatch ? `${numberMatch[1]}/${numberMatch[2]}` : null;
  const hpMatch =
    text.match(/\bHP\s*[:\-]?\s*(\d{2,3})\b/i) || text.match(/\b(\d{2,3})\s*HP\b/i);
  const hp = hpMatch ? hpMatch[1] : null;

  let name = nameFromWords(collectWords(data));
  if (!name || name.replace(/[^A-Za-z]/g, "").length < 2) name = nameFromLines(lines);
  name = name.replace(/\b[A-Za-z]\b/g, "").replace(/\s+/g, " ").trim();

  return { name, number, hp, raw: lines.slice(0, 6).join(" · ") };
}

// Re-rank search hits using the collector number / HP we also read off the card.
function rerankByCard(products, parsed) {
  if (!parsed.number && !parsed.hp) return products;
  const num = parsed.number;
  const numLeft = num ? num.split("/")[0].replace(/^0+/, "") : null;
  const scoreOf = (p) => {
    let s = 0;
    if (num && p.number) {
      const pn = p.number.replace(/\s+/g, "");
      if (pn === num) s += 100;
      else if (pn.split("/")[0].replace(/^0+/, "") === numLeft) s += 30;
    }
    if (parsed.hp && p.attributes && String(p.attributes.hp) === String(parsed.hp)) s += 12;
    return s;
  };
  return [...products].sort((a, b) => scoreOf(b) - scoreOf(a));
}

async function recognize(imageUrl) {
  const prog = $("#scan-progress");
  const progText = $("#scan-progress-text");
  prog.classList.remove("hidden");
  $("#scan-results").innerHTML = "";
  progText.textContent = "Reading card…";

  // 1) Cloud OCR via the server — far more accurate, handles holo/foil cards.
  try {
    const jpeg = await toJpeg(imageUrl, 1600);
    const r = await fetch(apiUrl("/api/scan"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ image: jpeg }),
    });
    if (r.ok) {
      const d = await r.json();
      if (d.rateLimited) {
        prog.classList.add("hidden");
        state.scanMatches = [];
        renderScanResults(
          { name: "", number: null, hp: null },
          [],
          "",
          { rateLimited: true }
        );
        return;
      }
      if (d.name || (d.products && d.products.length)) {
        prog.classList.add("hidden");
        state.scanMatches = d.products || [];
        renderScanResults(
          { name: d.name, number: d.number, hp: d.hp },
          d.products || [],
          d.name,
          { confidence: d.confidence, source: d.source }
        );
        return;
      }
    }
  } catch {
    /* fall through to local OCR */
  }

  // 2) Offline fallback: local Tesseract OCR.
  progText.textContent = "Reading card (offline)…";
  let parsed;
  try {
    const prepped = await preprocess(imageUrl).catch(() => imageUrl);
    const { data } = await Tesseract.recognize(prepped, "eng", {
      logger: (m) => {
        if (m.status === "recognizing text")
          progText.textContent = `Reading card… ${Math.round(m.progress * 100)}%`;
      },
    });
    parsed = parseOcr(data);
  } catch {
    prog.classList.add("hidden");
    $("#scan-results").innerHTML = `<div class="scan-ocr">Couldn't read the image. Try better lighting or upload a clearer photo.</div>`;
    return;
  }

  progText.textContent = "Matching to TCGplayer…";

  let products = [];
  try {
    if (parsed.name && parsed.name.length >= 2) {
      ({ products } = await api.search(parsed.name));
    }
    // Fallback: try the first raw line if the name search came up empty.
    if (!products.length) {
      const alt = (parsed.raw.split(" · ")[0] || "").replace(/[^A-Za-z' ]/g, "").trim();
      if (alt.length >= 3) ({ products } = await api.search(alt));
    }
  } catch {
    /* ignore */
  }

  products = rerankByCard(products, parsed);
  prog.classList.add("hidden");
  state.scanMatches = products;
  renderScanResults(parsed, products, parsed.name);
}

function renderScanResults(parsed, products, query, meta = {}) {
  const box = $("#scan-results");
  const bits = [];
  if (parsed.number) bits.push(`#${esc(parsed.number)}`);
  if (parsed.hp) bits.push(`${esc(parsed.hp)} HP`);
  if (meta.rateLimited) {
    box.innerHTML = `<div class="scan-ocr rate-limit-msg">
      <b>⚠ Card reader busy</b> — the free OCR limit was hit. Type the card name below to search manually:
      <div class="scan-edit" style="margin-top:8px">
        <input id="scan-query" class="filter-input" value="" placeholder="e.g. Psyduck, Charizard ex…" />
        <button class="btn primary" id="scan-research">Search</button>
      </div>
    </div>`;
    $("#scan-research").addEventListener("click", reSearchScan);
    $("#scan-query").addEventListener("keydown", (e) => { if (e.key === "Enter") reSearchScan(); });
    setTimeout(() => $("#scan-query")?.focus(), 100);
    return;
  }
  const conf = meta.confidence != null ? Math.round(meta.confidence * 100) : null;
  const srcTag =
    meta.source === "ai"
      ? `<span class="src-tag ai">✦ AI vision</span>`
      : meta.source === "ocr"
      ? `<span class="src-tag">OCR</span>`
      : "";
  const readout = `
    <div class="scan-ocr">
      <div class="scan-detected">Detected: <b>${esc(parsed.name || "—")}</b>${bits.length ? ` &nbsp;·&nbsp; ${bits.join(" · ")}` : ""} ${srcTag}</div>
      <div class="scan-edit">
        <input id="scan-query" class="filter-input" value="${esc(query || parsed.name)}" placeholder="Edit the name and search again" />
        <button class="btn ghost" id="scan-research">Search</button>
      </div>
      ${products.length ? "" : `<div style="margin-top:6px">No match — edit the name above and tap Search.</div>`}
    </div>`;

  const matches = products.length
    ? products
        .slice(0, 6)
        .map(
          (p, i) => `
        <div class="scan-match ${i === 0 ? "best" : ""}" data-scan="${p.productId}">
          <img src="${esc(p.image)}" alt="" onerror="this.style.opacity=.2" />
          <div class="m-body">
            <div class="m-name">${esc(p.name)}${
              i === 0 && conf != null
                ? ` <span class="conf ${conf >= 80 ? "hi" : conf >= 50 ? "mid" : "lo"}">${conf}% match</span>`
                : ""
            }</div>
            <div class="m-meta">${esc(p.set || "")}${p.number ? " · #" + esc(p.number) : ""}</div>
            <div class="m-price">${money(p.marketPrice)}</div>
          </div>
          <button class="btn primary scan-add" data-add="${p.productId}">+ Add</button>
        </div>`
        )
        .join("")
    : "";

  const quickAdd =
    products.length && conf != null && conf >= 40
      ? `<div class="scan-quick-add">
          <div class="hint">Best match: <b>${esc(products[0].name)}</b>${products[0].number ? ` · #${esc(products[0].number)}` : ""}</div>
          <button class="btn primary" id="scan-add-best" data-add="${products[0].productId}">Add to collection</button>
        </div>`
      : products.length
      ? `<div class="scan-quick-add">
          <div class="hint">Tap <b>+ Add</b> on the correct printing, or tap a row for full details.</div>
        </div>`
      : "";

  box.innerHTML = readout + quickAdd + matches;

  $("#scan-research").addEventListener("click", reSearchScan);
  $("#scan-query").addEventListener("keydown", (e) => {
    if (e.key === "Enter") reSearchScan();
  });
  const bestBtn = $("#scan-add-best");
  if (bestBtn) {
    bestBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      addScanMatch(Number(bestBtn.dataset.add), bestBtn);
    });
  }
  $$("[data-add]", box).forEach((btn) => {
    if (btn.id === "scan-add-best") return;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      addScanMatch(Number(btn.dataset.add), btn);
    });
  });
  $$(".scan-match", box).forEach((el) =>
    el.addEventListener("click", (e) => {
      if (e.target.closest("[data-add]")) return;
      openDetailById(Number(el.dataset.scan));
    })
  );
}

async function reSearchScan() {
  const q = $("#scan-query").value.trim();
  if (!q) return;
  $("#scan-progress").classList.remove("hidden");
  $("#scan-progress-text").textContent = "Searching…";
  try {
    const { products } = await api.search(q);
    state.scanMatches = products;
    $("#scan-progress").classList.add("hidden");
    renderScanResults({ name: q, number: null }, products, q);
  } catch {
    $("#scan-progress").classList.add("hidden");
  }
}

/* ---------------- Install (PWA) ---------------- */
let deferredPrompt = null;
const installBtn = $("#install-btn");
const ua = navigator.userAgent;
const isStandalone =
  window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone;
// iPadOS Safari reports as "Macintosh"; detect it via touch support.
const isIOS =
  /iphone|ipad|ipod/i.test(ua) ||
  (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
const isAndroid = /android/i.test(ua);

// Always offer the button (unless already installed) so it's discoverable on
// every platform. The native prompt is used when the browser provides it;
// otherwise we show manual instructions.
if (!isStandalone) installBtn.classList.remove("hidden");

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
  if (!isStandalone) installBtn.classList.remove("hidden");
});
window.addEventListener("appinstalled", () => {
  installBtn.classList.add("hidden");
  deferredPrompt = null;
  toast("Installed! Find Exalted on your home screen.");
});

installBtn.addEventListener("click", async () => {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === "accepted") installBtn.classList.add("hidden");
    deferredPrompt = null;
    return;
  }
  if (isIOS) {
    alert(
      "Install on iPhone / iPad (Safari):\n\n" +
        "1. Tap the Share button  ⬆️  (the square with an up-arrow) in Safari's toolbar.\n" +
        "2. Scroll down and tap  “Add to Home Screen”.\n" +
        "3. Tap  Add  (top-right).\n\n" +
        "Then open Exalted from your home screen — full-screen, with camera support.\n\n" +
        "Note: this only works in Safari (not Chrome) on iPhone/iPad."
    );
  } else if (isAndroid) {
    alert(
      "Install on Android (Chrome):\n\n" +
        "1. Tap the  ⋮  menu (top-right).\n" +
        "2. Tap  “Install app”  or  “Add to Home screen”.\n" +
        "3. Confirm.\n\n" +
        "If you don't see it, reload the page once and try again — it must be the\n" +
        "secure https:// address (the tunnel link works)."
    );
  } else {
    alert(
      "Install on desktop (Chrome / Edge):\n\n" +
        "Click the install icon (a monitor with a ⬇ arrow) at the right end of the\n" +
        "address bar — or open the  ⋮  menu and choose  “Install Exalted Pokémon”.\n\n" +
        "Requires the secure https:// address."
    );
  }
});

/* ---------------- Init ---------------- */
/* ---------------- Auth flow ---------------- */
let authMode = "login";

function showAuth() {
  $("#auth-screen").classList.remove("hidden");
  $("#app-root").classList.add("hidden");
  $("#auth-error").classList.add("hidden");
  $("#auth-password").value = "";
  setTimeout(() => $("#auth-username").focus(), 60);
}
function hideAuth() {
  $("#auth-screen").classList.add("hidden");
  $("#app-root").classList.remove("hidden");
}
function setAuthMode(mode) {
  authMode = mode;
  $$(".auth-tab").forEach((t) => t.classList.toggle("active", t.dataset.auth === mode));
  const isLogin = mode === "login";
  $("#auth-submit").textContent = isLogin ? "Log in" : "Create account";
  $("#auth-password").autocomplete = isLogin ? "current-password" : "new-password";
  $("#auth-switch-hint").innerHTML = isLogin
    ? `New here? <button class="link-btn" data-auth="register" type="button">Create an account</button>`
    : `Already have an account? <button class="link-btn" data-auth="login" type="button">Log in</button>`;
  $("#auth-error").classList.add("hidden");
}
function authError(msg) {
  const el = $("#auth-error");
  el.textContent = msg;
  el.classList.remove("hidden");
}

function applyUser(username) {
  const initial = (username || "?").charAt(0).toUpperCase();
  $("#user-name").textContent = username;
  $("#user-avatar").textContent = initial;
  $("#user-avatar-lg").textContent = initial;
  $("#user-dropdown-name").textContent = username;
}

async function loadUserData() {
  try {
    const [inv, wish] = await Promise.all([api.getInventory(), api.getWishlist()]);
    state.inventory = inv.items || [];
    state.wishlist = wish.wishlist || [];
  } catch {
    state.inventory = [];
    state.wishlist = [];
  }
  renderCollection();
  renderWishlist();
}

// Auth tab switching (event-delegated so dynamically-rebuilt hint works too).
document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-auth]");
  if (t) setAuthMode(t.dataset.auth);
});

$("#auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = $("#auth-username").value.trim();
  const password = $("#auth-password").value;
  if (!username || !password) return authError("Enter a username and password.");
  const btn = $("#auth-submit");
  btn.disabled = true;
  btn.textContent = authMode === "login" ? "Logging in…" : "Creating…";
  try {
    const d = authMode === "login"
      ? await api.login(username, password)
      : await api.register(username, password);
    setToken(d.token);
    applyUser(d.username);
    hideAuth();
    await loadUserData();
    toast(`Welcome${authMode === "register" ? "" : " back"}, ${d.username}!`);
  } catch (err) {
    authError(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = authMode === "login" ? "Log in" : "Create account";
  }
});

/* ---------------- User menu ---------------- */
$("#user-pill").addEventListener("click", (e) => {
  e.stopPropagation();
  $("#user-dropdown").classList.toggle("hidden");
});
document.addEventListener("click", () => $("#user-dropdown")?.classList.add("hidden"));
$("#logout-btn").addEventListener("click", async () => {
  await api.logout();
  setToken(null);
  state.inventory = [];
  state.wishlist = [];
  $("#user-dropdown").classList.add("hidden");
  setAuthMode("login");
  showAuth();
});

(async function init() {
  if (authToken) {
    try {
      const me = await api.me();
      applyUser(me.username);
      hideAuth();
      await loadUserData();
      return;
    } catch {
      setToken(null);
    }
  }
  setAuthMode("login");
  showAuth();
})();
