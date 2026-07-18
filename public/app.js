"use strict";

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const money = (n) => (n == null ? "—" : "$" + Number(n).toFixed(2));
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );

const CONDITIONS = ["Near Mint", "Lightly Played", "Moderately Played", "Heavily Played", "Damaged"];

// Crisp mid-resolution card image for grid tiles. The stored 200x200 thumbnail
// looks blurry on high-DPI phone screens; 500px is sharp without being huge.
const cardImg = (id, size = 500) =>
  `https://tcgplayer-cdn.tcgplayer.com/product/${id}_in_${size}x${size}.jpg`;

// Base URL for the backend API. Empty = same origin (web). For the packaged
// iOS/Android app, set window.KAIROS_API_BASE in config.js to the deployed URL.
const API_BASE = (window.KAIROS_API_BASE || "").replace(/\/+$/, "");
const apiUrl = (path) => API_BASE + path;

const state = {
  inventory: [],
  wishlist: [],
  searchResults: [],
  detail: null,
  scanMatches: [],
  scanBatch: [], // cards captured in the current scan session
  collapsedGroups: new Set(),
  history: [], // daily collection-value snapshots for the market chart
  groups: [], // user-defined group names
  selectMode: false,
  selected: new Set(), // inventory item ids picked in select mode
};

/* ---------------- Auth token ---------------- */
// Read the old key too so existing logins survive the rebrand.
const TOKEN_KEY = "kairos_token";
const legacyToken = localStorage.getItem("exalted_token");
if (legacyToken && !localStorage.getItem(TOKEN_KEY)) {
  localStorage.setItem(TOKEN_KEY, legacyToken);
  localStorage.removeItem("exalted_token");
}
let authToken = localStorage.getItem(TOKEN_KEY) || null;
function setToken(t) {
  authToken = t;
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
}

/* ---------------- Local cache: instant boot ---------------- */
// The last synced user + collection, so reopening the app renders immediately
// even while the free-tier server is still waking up (30-60s cold start).
const CACHE_USER = "kairos_user";
const CACHE_DATA = "kairos_cache";
function readCache(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}
function writeCache(key, val) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch { /* storage full — cache is best-effort */ }
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
    const r = await authFetch(`/api/inventory/${id}`, { method: "DELETE" });
    if (!r.ok) throw new Error("Delete failed");
    return r.json();
  },
  async bulk(ids, action, group) {
    const r = await authFetch("/api/inventory/bulk", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ids, action, group }),
    });
    if (!r.ok) throw new Error("Bulk action failed");
    return r.json();
  },
  async createGroup(name) {
    const r = await authFetch("/api/groups", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Couldn't create group");
    return r.json();
  },
  async deleteGroup(name) {
    const r = await authFetch(`/api/groups/${encodeURIComponent(name)}`, { method: "DELETE" });
    if (!r.ok) throw new Error("Couldn't delete group");
    return r.json();
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
    if (!r.ok) {
      // Callers must tell "signed out" (401) apart from "server unreachable".
      const err = new Error("Not signed in");
      err.status = r.status;
      throw err;
    }
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

/* ---------------- Confirm dialog ----------------
 * window.confirm() silently returns false inside installed iOS web apps,
 * which made the delete buttons look dead. This in-app dialog works everywhere. */
let confirmResolve = null;
function appConfirm(msg, yesLabel = "Delete") {
  return new Promise((resolve) => {
    confirmResolve = resolve;
    $("#confirm-msg").textContent = msg;
    $("#confirm-yes").textContent = yesLabel;
    $("#confirm-modal").classList.remove("hidden");
  });
}
function settleConfirm(v) {
  $("#confirm-modal").classList.add("hidden");
  confirmResolve?.(v);
  confirmResolve = null;
}
$("#confirm-yes").addEventListener("click", () => settleConfirm(true));
$("#confirm-no").addEventListener("click", () => settleConfirm(false));
$("#confirm-modal .modal-backdrop").addEventListener("click", () => settleConfirm(false));

/* ---------------- View switching ---------------- */
function switchView(name) {
  $$(".tab, .bn-item").forEach((t) =>
    t.classList.toggle("active", t.dataset.view === name)
  );
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
  if (name === "add") setTimeout(() => $("#search-input").focus(), 50);
  if (name === "wishlist") renderWishlist();
  if (name === "collection") renderCollection();
  if (name === "market") renderMarket();
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
  grid.classList.toggle("selecting", state.selectMode);

  const groupBy = $("#collection-group").value;
  if (groupBy === "none") {
    grid.innerHTML = items.map(collectionCardHTML).join("");
    updateSelectBar();
    return;
  }

  let ordered;
  if (groupBy === "custom") {
    // User-defined groups, in the order they were created, then "Ungrouped".
    // Empty groups still show so a freshly created one is visible.
    const buckets = new Map(state.groups.map((g) => [g, []]));
    const loose = [];
    for (const i of items) {
      if (i.group && buckets.has(i.group)) buckets.get(i.group).push(i);
      else loose.push(i);
    }
    ordered = [...buckets.entries()];
    if (loose.length) ordered.push(["Ungrouped", loose]);
  } else {
    const keyOf = (i) =>
      groupBy === "set" ? i.set || "Unknown set" : i.rarity || "Unknown rarity";
    const groups = new Map();
    for (const i of items) {
      const k = keyOf(i);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(i);
    }
    ordered = [...groups.entries()].sort((a, b) => {
      const va = a[1].reduce((s, i) => s + (i.marketPrice || 0) * i.quantity, 0);
      const vb = b[1].reduce((s, i) => s + (i.marketPrice || 0) * i.quantity, 0);
      return vb - va;
    });
  }

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
      const cards = collapsed
        ? ""
        : list.length
          ? list.map(collectionCardHTML).join("")
          : `<p class="group-empty">No cards yet — use <b>☑ Select</b> to move cards here.</p>`;
      return header + cards;
    })
    .join("");
  updateSelectBar();
}

function collectionCardHTML(i) {
  const lineVal = (i.marketPrice || 0) * i.quantity;
  const selected = state.selected.has(i.id);
  return `
    <div class="card ${selected ? "selected" : ""}" data-inv="${i.id}">
      <span class="sel-check">✓</span>
      <div class="card-img-wrap" data-detail="${i.productId}">
        <img loading="lazy" decoding="async" src="${cardImg(i.productId)}" alt="${esc(i.name)}"
             onerror="this.onerror=null;this.src='${esc(i.imageLarge || i.image)}'" />
        <span class="card-qty-badge">×${i.quantity}</span>
        ${i.group ? `<span class="group-badge">🗂 ${esc(i.group)}</span>` : ""}
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
        <button class="qty-btn" data-dec="${i.id}" aria-label="One less">−</button>
        <span class="qty-num">${i.quantity}</span>
        <button class="qty-btn" data-inc="${i.id}" aria-label="One more">+</button>
        <button class="trash" data-del="${i.id}" title="Remove" aria-label="Remove">🗑</button>
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

  // In select mode any tap on a card toggles its selection.
  if (state.selectMode) {
    const card = e.target.closest("[data-inv]");
    if (!card) return;
    const id = card.dataset.inv;
    if (state.selected.has(id)) state.selected.delete(id);
    else state.selected.add(id);
    card.classList.toggle("selected", state.selected.has(id));
    updateSelectBar();
    return;
  }

  const inc = e.target.closest("[data-inc]");
  const dec = e.target.closest("[data-dec]");
  const del = e.target.closest("[data-del]");
  const detail = e.target.closest("[data-detail]");

  if (inc) return changeQty(inc.dataset.inc, +1);
  if (dec) return changeQty(dec.dataset.dec, -1);
  if (del) {
    const item = state.inventory.find((i) => i.id === del.dataset.del);
    if (!item) return;
    if (!(await appConfirm(`Remove ${item.name} from your collection?`))) return;
    try {
      await api.deleteItem(item.id);
      state.inventory = state.inventory.filter((i) => i.id !== item.id);
      writeUserSnapshot();
      renderCollection();
      toast("Removed");
    } catch {
      toast("Couldn't remove — check your connection");
    }
    return;
  }
  if (detail) openDetailById(Number(detail.dataset.detail));
});

async function changeQty(id, delta) {
  const item = state.inventory.find((i) => i.id === id);
  if (!item) return;
  const q = item.quantity + delta;
  // Going to zero removes the card — make sure that's intended.
  if (q <= 0 && !(await appConfirm(`Remove ${item.name} from your collection?`, "Remove"))) return;
  try {
    await api.patchItem(id, { quantity: q });
  } catch {
    return toast("Couldn't update — check your connection");
  }
  if (q <= 0) {
    state.inventory = state.inventory.filter((i) => i.id !== id);
    toast("Removed");
  } else {
    item.quantity = q;
  }
  writeUserSnapshot();
  renderCollection();
}

/* ---------------- Multi-select ---------------- */

function setSelectMode(on) {
  state.selectMode = on;
  if (!on) state.selected.clear();
  $("#select-toggle").classList.toggle("active", on);
  $("#select-toggle").textContent = on ? "✕ Done" : "☑ Select";
  $("#select-bar").classList.toggle("hidden", !on);
  renderCollection();
}

function updateSelectBar() {
  if (!state.selectMode) return;
  // Drop selections that no longer exist (e.g. after a delete).
  for (const id of [...state.selected]) {
    if (!state.inventory.some((i) => i.id === id)) state.selected.delete(id);
  }
  const n = state.selected.size;
  $("#sel-count").textContent = `${n} selected`;
  $("#sel-delete").disabled = !n;
  $("#sel-group").disabled = !n;
  $("#sel-all").textContent =
    n === state.inventory.length && n > 0 ? "Clear all" : "Select all";
}

$("#select-toggle").addEventListener("click", () => setSelectMode(!state.selectMode));
$("#sel-cancel").addEventListener("click", () => setSelectMode(false));

$("#sel-all").addEventListener("click", () => {
  if (state.selected.size === state.inventory.length) state.selected.clear();
  else state.inventory.forEach((i) => state.selected.add(i.id));
  renderCollection();
});

$("#sel-delete").addEventListener("click", async () => {
  const ids = [...state.selected];
  if (!ids.length) return;
  const label = ids.length === 1 ? "this card" : `these ${ids.length} cards`;
  if (!(await appConfirm(`Delete ${label} from your collection?`))) return;
  try {
    const res = await api.bulk(ids, "delete");
    state.inventory = res.items;
    writeUserSnapshot();
    toast(`Deleted ${res.affected} card${res.affected === 1 ? "" : "s"}`);
    setSelectMode(false);
  } catch {
    toast("Couldn't delete — check your connection");
  }
});

$("#sel-group").addEventListener("click", () => {
  if (state.selected.size) openGroupSheet("assign");
});

/* ---------------- Custom groups ---------------- */

function openGroupSheet(mode) {
  // mode "assign": moving the current selection; "manage": just editing groups
  const body = $("#group-sheet-body");
  const n = state.selected.size;
  const rows = state.groups
    .map(
      (g) => `
      <div class="group-row" data-pick="${esc(g)}">
        <span class="group-row-icon">🗂</span>
        <span class="group-row-name">${esc(g)}</span>
        <span class="group-row-count">${state.inventory.filter((i) => i.group === g).length}</span>
        <button class="group-row-del" data-gdel="${esc(g)}" title="Delete group">🗑</button>
      </div>`
    )
    .join("");
  body.innerHTML = `
    <div class="sheet-grip"></div>
    <h3 class="group-sheet-title">${mode === "assign" ? `Move ${n} card${n === 1 ? "" : "s"} to…` : "My groups"}</h3>
    ${rows || `<p class="sheet-none">No groups yet — create your first one below.</p>`}
    ${mode === "assign" ? `<div class="group-row ungroup" data-pick=""><span class="group-row-icon">✕</span><span class="group-row-name">Remove from group</span></div>` : ""}
    <div class="group-new">
      <input id="group-new-name" class="filter-input" placeholder="New group name…" maxlength="40" />
      <button class="btn primary" id="group-new-btn">＋ Create</button>
    </div>`;
  $("#group-sheet").classList.remove("hidden");

  $("#group-new-btn").addEventListener("click", async () => {
    const name = $("#group-new-name").value.trim();
    if (!name) return;
    try {
      const res = await api.createGroup(name);
      state.groups = res.groups;
      writeUserSnapshot();
      if (mode === "assign") return assignSelectedToGroup(name);
      openGroupSheet(mode); // re-render list
    } catch (e) {
      toast(e.message);
    }
  });
  $("#group-new-name").addEventListener("keydown", (e) => {
    if (e.key === "Enter") $("#group-new-btn").click();
  });
}

async function assignSelectedToGroup(name) {
  const ids = [...state.selected];
  try {
    const res = await api.bulk(ids, "group", name || null);
    state.inventory = res.items;
    state.groups = res.groups;
    writeUserSnapshot();
    closeGroupSheet();
    setSelectMode(false);
    if (name) $("#collection-group").value = "custom"; // show the result
    renderCollection();
    toast(name ? `Moved ${res.affected} to “${name}”` : `Removed ${res.affected} from group`);
  } catch {
    toast("Couldn't move — check your connection");
  }
}

function closeGroupSheet() {
  $("#group-sheet").classList.add("hidden");
}

$("#group-sheet").addEventListener("click", async (e) => {
  if (e.target.closest("[data-gclose]")) return closeGroupSheet();
  const gdel = e.target.closest("[data-gdel]");
  if (gdel) {
    e.stopPropagation();
    const name = gdel.dataset.gdel;
    if (!(await appConfirm(`Delete the group “${name}”? Cards in it stay in your collection.`, "Delete group"))) return;
    try {
      const res = await api.deleteGroup(name);
      state.groups = res.groups;
      state.inventory = res.items;
      writeUserSnapshot();
      renderCollection();
      openGroupSheet(state.selectMode ? "assign" : "manage");
    } catch {
      toast("Couldn't delete group");
    }
    return;
  }
  const pick = e.target.closest("[data-pick]");
  if (pick && state.selectMode) assignSelectedToGroup(pick.dataset.pick);
});

// Keep the cached snapshot in sync so groups survive an offline reopen.
function writeUserSnapshot() {
  writeCache(CACHE_DATA, {
    inventory: state.inventory,
    wishlist: state.wishlist,
    history: state.history,
    groups: state.groups,
  });
}

$("#export-csv").addEventListener("click", () => {
  if (!state.inventory.length) return toast("Nothing to export");
  const csvCell = (v) => {
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ["Name", "Set", "Number", "Rarity", "Condition", "Quantity", "Market Price", "Line Value", "Price When Added", "Added At", "TCGplayer URL"];
  const rows = state.inventory.map((i) => [
    i.name, i.set || "", i.number || "", i.rarity || "", i.condition, i.quantity,
    i.marketPrice ?? "", i.marketPrice != null ? (i.marketPrice * i.quantity).toFixed(2) : "",
    i.addedPrice ?? "", i.addedAt || "", i.url || "",
  ]);
  const totalValue = state.inventory.reduce((s, i) => s + (i.marketPrice || 0) * i.quantity, 0);
  rows.push([]);
  rows.push(["TOTAL", "", "", "", "", state.inventory.reduce((s, i) => s + i.quantity, 0), "", totalValue.toFixed(2), "", "", ""]);
  const csv = [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");
  const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `kairos-collection-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  toast("Collection exported");
});

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
        <img loading="lazy" decoding="async" src="${cardImg(i.productId)}" alt="${esc(i.name)}"
             onerror="this.onerror=null;this.src='${esc(i.imageLarge || i.image)}'" />
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

/* ---------------- Market check ----------------
 * Client-side analytics over state.inventory:
 *   - Headline portfolio value + total gain since cards were added
 *   - Top "movers" (biggest absolute gain since added)
 *   - Top holdings (largest line value)
 *   - Set and rarity breakdowns (share of total value)
 * Nothing is round-tripped to the server; everything is derived from data
 * that's already loaded after sign-in.
 */
function pctDelta(now, then) {
  if (!then) return null;
  return ((now - then) / then) * 100;
}

function marketRowHTML(item, options = {}) {
  const lineVal = (item.marketPrice || 0) * item.quantity;
  const delta = options.showDelta && item.addedPrice != null
    ? (item.marketPrice || 0) - item.addedPrice
    : null;
  const pct = delta != null ? pctDelta(item.marketPrice || 0, item.addedPrice) : null;
  const cls = delta == null ? "" : delta >= 0 ? "up" : "down";
  const arrow = delta == null ? "" : delta >= 0 ? "▲" : "▼";
  const right = options.showDelta && delta != null
    ? `<div class="mkt-right ${cls}">
         <div class="mkt-delta">${arrow} ${money(Math.abs(delta))}</div>
         <div class="mkt-pct">${pct != null ? `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%` : ""}</div>
       </div>`
    : `<div class="mkt-right">
         <div class="mkt-delta">${money(lineVal)}</div>
         <div class="mkt-pct muted">${money(item.marketPrice)} × ${item.quantity}</div>
       </div>`;
  return `
    <div class="mkt-row" data-detail="${item.productId}">
      <img loading="lazy" decoding="async" src="${cardImg(item.productId, 200)}"
           alt="${esc(item.name)}"
           onerror="this.onerror=null;this.src='${esc(item.image)}'" />
      <div class="mkt-info">
        <div class="mkt-name">${esc(item.name)}</div>
        <div class="mkt-meta">${esc(item.set || "")}${item.number ? " · #" + esc(item.number) : ""}</div>
      </div>
      ${right}
    </div>`;
}

function marketBarsHTML(buckets) {
  const max = Math.max(...buckets.map((b) => b.value), 1);
  return buckets
    .map((b) => {
      const pct = (b.value / max) * 100;
      const share = ((b.value / (buckets.reduce((s, x) => s + x.value, 0) || 1)) * 100).toFixed(1);
      return `
        <div class="mkt-bar-row">
          <div class="mkt-bar-head">
            <span class="mkt-bar-name" title="${esc(b.name)}">${esc(b.name)}</span>
            <span class="mkt-bar-val">${money(b.value)} <span class="muted">· ${share}%</span></span>
          </div>
          <div class="mkt-bar-track"><div class="mkt-bar-fill" style="width:${pct.toFixed(1)}%"></div></div>
          <div class="mkt-bar-foot muted">${b.count} card${b.count === 1 ? "" : "s"}</div>
        </div>`;
    })
    .join("");
}

/* Collection value line chart (canvas, no libraries). One point per day from
 * the server's history, with today's live value as the final point. */
function renderValueChart() {
  const cv = $("#value-chart");
  if (!cv || !cv.offsetParent) return; // market view not visible
  const liveValue = state.inventory.reduce(
    (s, i) => s + (i.marketPrice || 0) * i.quantity,
    0
  );
  const today = new Date().toISOString().slice(0, 10);
  const series = (state.history || []).slice();
  const last = series[series.length - 1];
  if (!last || last.d !== today) series.push({ d: today, v: liveValue });
  else last.v = liveValue;

  const sub = $("#market-chart-sub");
  if (sub) {
    const first = series[0];
    const delta = series[series.length - 1].v - first.v;
    const pct = first.v > 0 ? ((delta / first.v) * 100).toFixed(1) : null;
    sub.textContent =
      series.length < 2
        ? "Tracking starts today — check back tomorrow"
        : `${fmtDay(first.d)} → today · ${delta >= 0 ? "+" : "−"}${money(Math.abs(delta))}${pct != null ? ` (${delta >= 0 ? "+" : ""}${pct}%)` : ""}`;
  }

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cssW = cv.parentElement.clientWidth - 2;
  const cssH = 190;
  cv.style.width = cssW + "px";
  cv.style.height = cssH + "px";
  cv.width = Math.round(cssW * dpr);
  cv.height = Math.round(cssH * dpr);
  const ctx = cv.getContext("2d");
  ctx.scale(dpr, dpr);

  const padL = 46;
  const padR = 12;
  const padT = 14;
  const padB = 24;
  const plotW = cssW - padL - padR;
  const plotH = cssH - padT - padB;

  const vals = series.map((p) => p.v);
  let vMin = Math.min(...vals);
  let vMax = Math.max(...vals);
  if (vMax - vMin < 1) {
    // flat line — give it headroom so it doesn't hug the frame
    vMax += Math.max(1, vMax * 0.1);
    vMin = Math.max(0, vMin - Math.max(1, vMin * 0.1));
  } else {
    const head = (vMax - vMin) * 0.12;
    vMax += head;
    vMin = Math.max(0, vMin - head);
  }

  const X = (i) =>
    padL + (series.length === 1 ? plotW / 2 : (i / (series.length - 1)) * plotW);
  const Y = (v) => padT + (1 - (v - vMin) / (vMax - vMin)) * plotH;

  // Grid + axis labels
  ctx.font = "10.5px system-ui, sans-serif";
  ctx.textBaseline = "middle";
  for (let g = 0; g <= 2; g++) {
    const v = vMin + ((vMax - vMin) * g) / 2;
    const y = Y(v);
    ctx.strokeStyle = "rgba(43, 53, 80, 0.6)";
    ctx.setLineDash([4, 5]);
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(cssW - padR, y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#9aa6c4";
    ctx.textAlign = "right";
    ctx.fillText(compactMoney(v), padL - 7, y);
  }
  // Date labels: first and last
  ctx.textAlign = "left";
  ctx.fillText(fmtDay(series[0].d), padL, cssH - 9);
  ctx.textAlign = "right";
  ctx.fillText("Today", cssW - padR, cssH - 9);

  // Area fill under the line
  const grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
  grad.addColorStop(0, "rgba(54, 211, 153, 0.28)");
  grad.addColorStop(1, "rgba(54, 211, 153, 0)");
  ctx.beginPath();
  series.forEach((p, i) => (i ? ctx.lineTo(X(i), Y(p.v)) : ctx.moveTo(X(i), Y(p.v))));
  ctx.lineTo(X(series.length - 1), padT + plotH);
  ctx.lineTo(X(0), padT + plotH);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // The line itself
  ctx.beginPath();
  series.forEach((p, i) => (i ? ctx.lineTo(X(i), Y(p.v)) : ctx.moveTo(X(i), Y(p.v))));
  ctx.strokeStyle = "#36d399";
  ctx.lineWidth = 2.5;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.stroke();

  // Point markers (only when sparse enough to read)
  if (series.length <= 30) {
    series.forEach((p, i) => {
      ctx.beginPath();
      ctx.arc(X(i), Y(p.v), i === series.length - 1 ? 4 : 2.5, 0, Math.PI * 2);
      ctx.fillStyle = i === series.length - 1 ? "#eef2ff" : "#36d399";
      ctx.fill();
      if (i === series.length - 1) {
        ctx.strokeStyle = "#36d399";
        ctx.lineWidth = 2;
        ctx.stroke();
      }
    });
  }
}
const fmtDay = (d) => {
  const dt = new Date(d + "T12:00:00");
  return dt.toLocaleDateString(undefined, { month: "short", day: "numeric" });
};
const compactMoney = (v) =>
  v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${v.toFixed(v < 10 ? 2 : 0)}`;

function renderMarket() {
  const items = state.inventory;
  const empty = $("#market-empty");
  const body = $("#market-body");
  empty.classList.toggle("hidden", items.length > 0);
  body.classList.toggle("hidden", items.length === 0);
  requestAnimationFrame(renderValueChart);

  const totalValue = items.reduce((s, i) => s + (i.marketPrice || 0) * i.quantity, 0);
  const totalSpent = items.reduce(
    (s, i) => s + (i.addedPrice != null ? i.addedPrice : i.marketPrice || 0) * i.quantity, 0
  );
  const totalCount = items.reduce((s, i) => s + i.quantity, 0);
  const unique = new Set(items.map((i) => i.productId)).size;
  const avg = unique ? totalValue / unique : 0;
  const gain = totalValue - totalSpent;
  const gainPct = totalSpent ? (gain / totalSpent) * 100 : null;

  $("#market-total").textContent = money(totalValue);
  $("#market-count").textContent = totalCount;
  $("#market-unique").textContent = unique;
  $("#market-avg").textContent = money(avg);
  $("#market-spent").textContent = money(totalSpent);

  const change = $("#market-change");
  if (gainPct == null || items.length === 0) {
    change.className = "market-change";
    change.textContent = items.length === 0 ? "Add cards to start tracking" : "—";
  } else {
    const up = gain >= 0;
    change.className = `market-change ${up ? "up" : "down"}`;
    change.textContent = `${up ? "▲" : "▼"} ${money(Math.abs(gain))} (${up ? "+" : ""}${gainPct.toFixed(1)}%) since added`;
  }

  if (!items.length) {
    $("#market-movers").innerHTML = "";
    $("#market-top").innerHTML = "";
    $("#market-bysets").innerHTML = "";
    $("#market-byrarity").innerHTML = "";
    $("#market-updated").textContent = "";
    return;
  }

  // Top movers — biggest absolute change since added.
  const movers = items
    .filter((i) => i.addedPrice != null && i.marketPrice != null && i.addedPrice !== i.marketPrice)
    .map((i) => ({ i, delta: Math.abs((i.marketPrice || 0) - i.addedPrice) }))
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 5)
    .map((x) => x.i);
  const moversBox = $("#market-movers");
  if (movers.length) {
    moversBox.innerHTML = movers.map((i) => marketRowHTML(i, { showDelta: true })).join("");
    $("#market-movers-sub").textContent = "Biggest price changes since you added them";
  } else {
    moversBox.innerHTML = `<div class="muted small">No price changes yet — tap <b>Refresh prices</b> to fetch the latest from TCGplayer.</div>`;
    $("#market-movers-sub").textContent = "";
  }

  // Top holdings by line value.
  const top = [...items]
    .sort((a, b) => (b.marketPrice || 0) * b.quantity - (a.marketPrice || 0) * a.quantity)
    .slice(0, 5);
  $("#market-top").innerHTML = top.map((i) => marketRowHTML(i)).join("");

  // By set.
  const sets = new Map();
  for (const i of items) {
    const key = i.set || "Unknown set";
    const cur = sets.get(key) || { name: key, value: 0, count: 0 };
    cur.value += (i.marketPrice || 0) * i.quantity;
    cur.count += i.quantity;
    sets.set(key, cur);
  }
  const setBuckets = [...sets.values()].sort((a, b) => b.value - a.value);
  $("#market-bysets").innerHTML = marketBarsHTML(setBuckets);
  $("#market-bysets-sub").textContent = `${setBuckets.length} set${setBuckets.length === 1 ? "" : "s"}`;

  // By rarity.
  const rarities = new Map();
  for (const i of items) {
    const key = i.rarity || "Unknown";
    const cur = rarities.get(key) || { name: key, value: 0, count: 0 };
    cur.value += (i.marketPrice || 0) * i.quantity;
    cur.count += i.quantity;
    rarities.set(key, cur);
  }
  const rarityBuckets = [...rarities.values()].sort((a, b) => b.value - a.value);
  $("#market-byrarity").innerHTML = marketBarsHTML(rarityBuckets);
  $("#market-byrarity-sub").textContent = `${rarityBuckets.length} rarit${rarityBuckets.length === 1 ? "y" : "ies"}`;

  const lastUpdated = items
    .map((i) => i.updatedAt)
    .filter(Boolean)
    .sort()
    .pop();
  if (lastUpdated) {
    const d = new Date(lastUpdated);
    $("#market-updated").textContent = `Prices last refreshed ${d.toLocaleString()}`;
  } else {
    $("#market-updated").textContent = "";
  }
}

$("#market-body").addEventListener("click", (e) => {
  const detail = e.target.closest("[data-detail]");
  if (detail) openDetailById(Number(detail.dataset.detail));
});

$("#market-refresh").addEventListener("click", async (e) => {
  if (!state.inventory.length) return toast("Nothing to refresh");
  e.target.disabled = true;
  e.target.textContent = "↻ Refreshing…";
  try {
    const res = await api.refresh();
    state.inventory = res.items;
    if (res.wishlist) state.wishlist = res.wishlist;
    renderMarket();
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
searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    clearTimeout(searchTimer);
    const q = searchInput.value.trim();
    if (q.length >= 2) runSearch(q);
    searchInput.blur(); // dismiss the phone keyboard so results are visible
  }
});

function skeletons(n = 8) {
  return Array.from({ length: n }, () => `<div class="skeleton"></div>`).join("");
}

let searchPage = 0;
let searchQuery = "";
let searchTotal = 0;

async function runSearch(q, page = 0) {
  const append = page > 0;
  if (!append) {
    $("#search-status").textContent = `Searching “${q}”…`;
    $("#search-grid").innerHTML = skeletons();
    $("#search-more").classList.add("hidden");
  } else {
    $("#search-more").disabled = true;
    $("#search-more").textContent = "Loading…";
  }
  try {
    const { products, total } = await api.search(q, page);
    searchQuery = q;
    searchPage = page;
    searchTotal = total;
    state.searchResults = append ? state.searchResults.concat(products) : products;
    $("#search-status").textContent = state.searchResults.length
      ? `Showing ${state.searchResults.length} of ${total.toLocaleString()} result${total === 1 ? "" : "s"} for “${q}”`
      : `No results for “${q}”`;
    renderSearchGrid(state.searchResults);
    const more = $("#search-more");
    more.classList.toggle("hidden", state.searchResults.length >= total || !products.length);
    more.disabled = false;
    more.textContent = "Load more results";
  } catch {
    if (!append) {
      $("#search-status").textContent = "Search failed — is the server running?";
      $("#search-grid").innerHTML = "";
    } else {
      $("#search-more").disabled = false;
      $("#search-more").textContent = "Load more results";
    }
  }
}

$("#search-more").addEventListener("click", () => runSearch(searchQuery, searchPage + 1));

function productCardHTML(p) {
  const owned = ownedQty(p.productId);
  return `
    <div class="card" data-detail="${p.productId}">
      <div class="card-img-wrap">
        <img loading="lazy" decoding="async" src="${cardImg(p.productId)}" alt="${esc(p.name)}"
             onerror="this.onerror=null;this.src='${esc(p.imageLarge || p.image)}'" />
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

/* ---------------- Modals close ---------------- */
function closeModals() {
  $("#detail-modal").classList.add("hidden");
  $("#camera-modal").classList.add("hidden");
  $("#chip-sheet").classList.add("hidden");
  $("#group-sheet").classList.add("hidden");
  stopCamera();
}
document.addEventListener("click", (e) => {
  if (e.target.closest("[data-close]")) closeModals();
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (!$("#confirm-modal").classList.contains("hidden")) return settleConfirm(false);
  closeModals();
});

/* ---------------- Camera / OCR scan ---------------- */
const cam = {
  stream: null,
  video: $("#cam-video"),
  canvas: $("#cam-canvas"),
};

$("#open-camera").addEventListener("click", openCamera);

/* ----- Auto-capture: fires only when an actual card outline is detected ----- */
const STAGE_ASPECT = 3 / 4;
const GUIDE_INSET_X = 0.11;
const GUIDE_INSET_Y = 0.06;
const CARD_HOLD_MS = 700; // steady card-in-frame time before the shot

// Detection canvas matches the guide's portrait shape so the card's four
// edges land in predictable border bands.
const DET_W = 96;
const DET_H = 128;
const det = document.createElement("canvas");
det.width = DET_W;
det.height = DET_H;
const dctx = det.getContext("2d", { willReadFrequently: true });
let detTimer = null;
let cardVisibleMs = 0;
let lastDetTick = 0;
let prevGray = null; // previous frame, for motion estimation
// After a capture, auto mode waits for the frame to clear (card swapped)
// before it can fire again — prevents double-scanning the same card.
let autoArmed = true;
let frameClearMs = 0;

// The TRUE rendered aspect of the stage element. CSS aims for 3:4, but if any
// rule bends it the guide overlay bends with it — detection and captures must
// use the real value or everything comes out offset from what's on screen.
function stageAspect() {
  const el = document.querySelector(".scan-stage");
  return el && el.clientWidth && el.clientHeight
    ? el.clientWidth / el.clientHeight
    : STAGE_ASPECT;
}

// The visible area on screen (the `cover`-cropped stage) — what the user sees and
// lines the card up against. Capturing exactly this makes capture WYSIWYG.
function visibleRegion(v) {
  const sa = stageAspect();
  const va = v.videoWidth / v.videoHeight;
  let sx, sy, sw, sh;
  if (va > sa) {
    sh = v.videoHeight;
    sw = sh * sa;
    sx = (v.videoWidth - sw) / 2;
    sy = 0;
  } else {
    sw = v.videoWidth;
    sh = sw / sa;
    sx = 0;
    sy = (v.videoHeight - sh) / 2;
  }
  return { x: sx, y: sy, w: sw, h: sh };
}

// Map the guide box to source pixels in the video stream.
function guideRegion(v) {
  const r = visibleRegion(v);
  return {
    x: r.x + GUIDE_INSET_X * r.w,
    y: r.y + GUIDE_INSET_Y * r.h,
    w: r.w * (1 - 2 * GUIDE_INSET_X),
    h: r.h * (1 - 2 * GUIDE_INSET_Y),
  };
}

function captureFromGuide() {
  const v = cam.video;
  if (!v.videoWidth) return null;
  const stage = visibleRegion(v);
  const g = guideRegion(v);

  // Locate the card RIGHT NOW — a detection from even a few frames ago can be
  // offset if the phone drifted, and the captured image must match the screen.
  let box = null;
  try {
    const a = analyzeFrame();
    if (a && a.sides >= 3 && a.hasPair) box = cardBoxFromAnalysis(a);
  } catch { /* fall back to the last loop detection */ }
  if (!box && lastCardBox && Date.now() - lastCardBox.time < 500) box = lastCardBox;

  // Crop tight around the card when we know where it is; otherwise take the
  // full visible stage (manual shutter with no card locked).
  let r = stage;
  if (box && box.w > g.w * 0.45 && box.h > g.h * 0.45) {
    const x = Math.max(0, box.x);
    const y = Math.max(0, box.y);
    r = {
      x,
      y,
      w: Math.min(box.w, v.videoWidth - x),
      h: Math.min(box.h, v.videoHeight - y),
    };
  }
  const c = cam.canvas;
  c.width = Math.round(r.w);
  c.height = Math.round(r.h);
  c.getContext("2d").drawImage(v, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.95);
}

// Analyze the guide region for an actual CARD:
//   sides   – 4 when a full card-proportioned rectangle is found anywhere in
//             the sampled frame, 3 when one edge hangs out of frame and is
//             inferred from card shape. Floors/tables/bedding don't make one.
//   density – edge busy-ness of the card interior (artwork/text).
//   motion  – mean frame-to-frame pixel change; low = held steady.
function analyzeFrame() {
  const v = cam.video;
  if (!v.videoWidth) return null;
  const g = guideRegion(v);
  // Sample well beyond the guide so a card sitting outside the lines still
  // has its edges inside the sampled region.
  const mx = g.w * 0.12;
  const my = g.h * 0.12;
  const sx = Math.max(0, g.x - mx);
  const sy = Math.max(0, g.y - my);
  const sw = Math.min(v.videoWidth - sx, g.w + 2 * mx);
  const sh = Math.min(v.videoHeight - sy, g.h + 2 * my);
  dctx.drawImage(v, sx, sy, sw, sh, 0, 0, DET_W, DET_H);
  const { data } = dctx.getImageData(0, 0, DET_W, DET_H);

  // Grayscale + motion vs the previous frame.
  const gray = new Float32Array(DET_W * DET_H);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    gray[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
  }

  // Shadowed / dim scenes: stretch the 2%-98% brightness range to full scale
  // so card edges still clear the fixed gradient threshold below. Well-lit
  // frames (already wide range) pass through untouched.
  {
    const hist = new Uint32Array(256);
    for (let i = 0; i < gray.length; i++) hist[gray[i] | 0]++;
    const n = gray.length;
    let lo = 0;
    let acc = 0;
    for (; lo < 255 && acc < n * 0.02; lo++) acc += hist[lo];
    let hi = 255;
    acc = 0;
    for (; hi > 1 && acc < n * 0.02; hi--) acc += hist[hi];
    const range = hi - lo;
    if (range > 8 && range < 190) {
      const k = 255 / range;
      for (let i = 0; i < gray.length; i++) {
        const v = (gray[i] - lo) * k;
        gray[i] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
  }
  let motion = 255;
  if (prevGray) {
    let sum = 0;
    let n = 0;
    for (let i = 0; i < gray.length; i += 4) {
      sum += Math.abs(gray[i] - prevGray[i]);
      n++;
    }
    motion = sum / n;
  }
  prevGray = gray;

  // ---- Whole-frame card-outline search ----
  // The old detector only looked in narrow bands at the frame border and
  // demanded each edge be an ISOLATED line. Real scenes broke both rules:
  // a card held over a stack of other cards fills the bands with edges, and
  // a card sitting deeper in the frame has edges outside the bands entirely.
  // Now: find ALL long straight lines anywhere in the frame, then pick the
  // rectangle with a real card's proportions.
  const T = 20; // gradient threshold — low enough for dim rooms and sleeves

  // Hit masks, indexed [perpendicular position][along-line position]:
  //   vM: vertical-line hits, vM[x * DET_H + y]
  //   hM: horizontal-line hits, hM[y * DET_W + x]
  const vM = new Uint8Array(DET_W * DET_H);
  const hM = new Uint8Array(DET_W * DET_H);
  for (let y = 1; y < DET_H - 1; y++) {
    for (let x = 1; x < DET_W - 1; x++) {
      if (Math.abs(gray[y * DET_W + x + 1] - gray[y * DET_W + x - 1]) > T) vM[x * DET_H + y] = 1;
      if (Math.abs(gray[(y + 1) * DET_W + x] - gray[(y - 1) * DET_W + x]) > T) hM[y * DET_W + x] = 1;
    }
  }

  // Score a straight line at every position, trying several slopes (hands
  // tilt): score = covered fraction of the line's full length.
  const SLOPES = [-9, -6, -3, 0, 3, 6, 9];
  const scanLines = (mask, nPos, len) => {
    const score = new Float32Array(nPos);
    const slope = new Float32Array(nPos);
    for (let pos = 1; pos < nPos - 1; pos++) {
      let best = 0;
      let bestSl = 0;
      for (const sl of SLOPES) {
        let cnt = 0;
        for (let t = 0; t < len; t++) {
          const d = pos + Math.round((sl * t) / len);
          if (d >= 1 && d < nPos - 1) {
            const at = d * len + t;
            if (mask[at] || mask[at - len] || mask[at + len]) cnt++;
          }
        }
        if (cnt > best) {
          best = cnt;
          bestSl = sl;
        }
      }
      score[pos] = best / len;
      slope[pos] = bestSl;
    }
    return { score, slope };
  };
  const vScan = scanLines(vM, DET_W, DET_H);
  const hScan = scanLines(hM, DET_H, DET_W);

  // Candidate edges = PROMINENT local maxima. Texture (bedding, popcorn
  // ceilings, wood grain) lights up everywhere, so its median score is high
  // and nothing stands out; a card edge is a peak well above its scene.
  const candidates = ({ score, slope }, nPos) => {
    const sorted = [...score].sort((a, b) => a - b);
    const median = sorted[Math.floor(nPos / 2)];
    const need = Math.max(0.55, median * 1.35);
    const out = [];
    for (let p = 1; p < nPos - 1; p++) {
      if (score[p] >= need && score[p] >= score[p - 1] && score[p] > score[p + 1]) {
        out.push({ pos: p + slope[p] / 2, score: score[p] }); // midline of tilted edge
      }
    }
    return out.sort((a, b) => b.score - a.score).slice(0, 8);
  };
  const vCands = candidates(vScan, DET_W);
  const hCands = candidates(hScan, DET_H);

  // Physical card proportions, translated into detection-canvas units (the
  // sample region isn't square-pixeled on this canvas).
  const kx = sw / DET_W;
  const ky = sh / DET_H;
  const detAspect = (w, h) => (w * kx) / Math.max(1, h * ky); // real-world w/h
  const MIN_W = DET_W * 0.42;
  const MIN_H = DET_H * 0.42;

  // Best 4-line rectangle with card-ish aspect (0.716 ± perspective slop).
  // Aspect closeness is the main tiebreak — a stack of cards under the one
  // being scanned throws extra lines, and the box that best matches real card
  // proportions is the actual card. A small size bonus still favors the outer
  // edges over the card's inner art-frame lines.
  let quad = null;
  for (const L of vCands) for (const R of vCands) {
    const w = R.pos - L.pos;
    if (w < MIN_W) continue;
    for (const Tp of hCands) for (const B of hCands) {
      const h = B.pos - Tp.pos;
      if (h < MIN_H) continue;
      const asp = detAspect(w, h);
      if (asp < 0.58 || asp > 0.9) continue;
      const aspFit = 1 - Math.min(1, Math.abs(asp - CARD_WH) / 0.18);
      const q =
        L.score + R.score + Tp.score + B.score +
        0.5 * aspFit +
        0.15 * (w / DET_W + h / DET_H);
      if (!quad || q > quad.q) quad = { q, left: L.pos, right: R.pos, top: Tp.pos, bot: B.pos };
    }
  }

  // 3-line fallback: one edge pair + one perpendicular edge, ONLY when the
  // missing 4th edge would land off-frame (card hanging out of the guide).
  // If the inferred edge lands mid-frame, a real card would show it — its
  // absence means this isn't a card (e.g. a square coaster).
  let tri = null;
  if (!quad) {
    const keep = (q, box) => {
      if (!tri || q > tri.q) tri = { q, ...box };
    };
    for (const L of vCands) for (const R of vCands) {
      const w = R.pos - L.pos;
      if (w < MIN_W) continue;
      const hInf = (w * kx) / CARD_WH / ky; // inferred card height, det units
      for (const Tp of hCands) {
        if (Tp.pos + hInf >= DET_H - 4 && Tp.pos + hInf <= DET_H * 1.25)
          keep(L.score + R.score + Tp.score, { left: L.pos, right: R.pos, top: Tp.pos, bot: null });
      }
      for (const B of hCands) {
        if (B.pos - hInf <= 4 && B.pos - hInf >= -DET_H * 0.25)
          keep(L.score + R.score + B.score, { left: L.pos, right: R.pos, top: null, bot: B.pos });
      }
    }
    for (const Tp of hCands) for (const B of hCands) {
      const h = B.pos - Tp.pos;
      if (h < MIN_H) continue;
      const wInf = ((h * ky) * CARD_WH) / kx;
      for (const L of vCands) {
        if (L.pos + wInf >= DET_W - 4 && L.pos + wInf <= DET_W * 1.25)
          keep(Tp.score + B.score + L.score, { top: Tp.pos, bot: B.pos, left: L.pos, right: null });
      }
      for (const R of vCands) {
        if (R.pos - wInf <= 4 && R.pos - wInf >= -DET_W * 0.25)
          keep(Tp.score + B.score + R.score, { top: Tp.pos, bot: B.pos, left: null, right: R.pos });
      }
    }
  }

  const pick = quad || tri;
  const sides = quad ? 4 : tri ? 3 : Math.min(2, vCands.length + hCands.length);
  const hasPair = !!pick;
  const edgesAt = {
    top: pick ? pick.top : null,
    bot: pick ? pick.bot : null,
    left: pick ? pick.left : null,
    right: pick ? pick.right : null,
  };

  // Interior busy-ness — card faces have artwork and text. Measured INSIDE
  // the picked rectangle when there is one, else the frame's middle 60%.
  let edges = 0;
  let total = 0;
  const ix0 = Math.max(1, Math.round(pick?.left != null ? pick.left + 4 : DET_W * 0.2));
  const ix1 = Math.min(DET_W - 1, Math.round(pick?.right != null ? pick.right - 4 : DET_W * 0.8));
  const iy0 = Math.max(1, Math.round(pick?.top != null ? pick.top + 4 : DET_H * 0.2));
  const iy1 = Math.min(DET_H - 1, Math.round(pick?.bot != null ? pick.bot - 4 : DET_H * 0.8));
  for (let y = iy0; y < iy1; y += 2) {
    for (let x = ix0; x < ix1; x += 2) {
      total++;
      const gx = Math.abs(gray[y * DET_W + x + 1] - gray[y * DET_W + x - 1]);
      const gy = Math.abs(gray[(y + 1) * DET_W + x] - gray[(y - 1) * DET_W + x]);
      if (gx + gy > T) edges++;
    }
  }
  return {
    sides,
    hasPair,
    density: edges / Math.max(1, total),
    motion,
    edgesAt,
    sample: { sx, sy, sw, sh },
  };
}

// Latest good card-edge fix, used to crop captures tightly around the card.
let lastCardBox = null;
const CARD_WH = 63 / 88; // physical Pokémon card aspect (63mm x 88mm)

// Convert detected edge positions to a crop box in video pixels. Detection
// needs only 3 edges — the missing one is INFERRED from the card's physical
// shape, so a card hanging out of the guide still gets a full-card crop
// (before, the crop stopped at the guide and cut the card off — that's why
// shots had to be aimed "a bit up" to read). A small margin keeps the whole
// border, incl. the collector number, in frame.
function cardBoxFromAnalysis(a) {
  const s = a.sample;
  const px = (x) => s.sx + (x / DET_W) * s.sw;
  const py = (y) => s.sy + (y / DET_H) * s.sh;
  let x0 = a.edgesAt.left != null ? px(a.edgesAt.left) : null;
  let x1 = a.edgesAt.right != null ? px(a.edgesAt.right) : null;
  let y0 = a.edgesAt.top != null ? py(a.edgesAt.top) : null;
  let y1 = a.edgesAt.bot != null ? py(a.edgesAt.bot) : null;
  if (x0 != null && x1 != null) {
    const h = (x1 - x0) / CARD_WH;
    if (y0 == null && y1 != null) y0 = y1 - h;
    else if (y1 == null && y0 != null) y1 = y0 + h;
  }
  if (y0 != null && y1 != null) {
    const w = (y1 - y0) * CARD_WH;
    if (x0 == null && x1 != null) x0 = x1 - w;
    else if (x1 == null && x0 != null) x1 = x0 + w;
  }
  // Anything still unknown falls back to the sampled window's edge.
  if (x0 == null) x0 = s.sx;
  if (x1 == null) x1 = s.sx + s.sw;
  if (y0 == null) y0 = s.sy;
  if (y1 == null) y1 = s.sy + s.sh;
  // Generous margin — the recenter pass on the captured still trims it back
  // to an even border, so err on including too much rather than cutting off.
  const mw = (x1 - x0) * 0.07;
  const mh = (y1 - y0) * 0.07;
  return {
    x: Math.max(0, x0 - mw),
    y: Math.max(0, y0 - mh),
    w: x1 - x0 + 2 * mw,
    h: y1 - y0 + 2 * mh,
    time: Date.now(),
  };
}

// Live outline showing exactly what the next capture will contain.
function showCardBox(box) {
  const el = document.getElementById("scan-cardbox");
  const stage = document.querySelector(".scan-stage");
  const v = cam.video;
  if (!el || !stage || !v.videoWidth) return;
  const vis = visibleRegion(v);
  const kx = stage.clientWidth / vis.w;
  const ky = stage.clientHeight / vis.h;
  el.style.transform = `translate(${(box.x - vis.x) * kx}px, ${(box.y - vis.y) * ky}px)`;
  el.style.width = `${box.w * kx}px`;
  el.style.height = `${box.h * ky}px`;
  el.classList.remove("hidden");
}
function hideCardBox() {
  document.getElementById("scan-cardbox")?.classList.add("hidden");
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

  const a = analyzeFrame();
  if (!a) {
    detTimer = setTimeout(detLoop, 110);
    return;
  }
  // A real card = a rectangle with card proportions (4 edges, or 3 with the
  // 4th hanging out of frame) plus a busy interior (artwork/text). Ceilings,
  // walls, floors and bedding don't produce that structure.
  // (density floor is low: pale watercolor-style cards have soft interiors)
  const cardDetected = a.sides >= 3 && a.hasPair && a.density > 0.028;
  const partiallyIn = a.sides >= 1 && a.density > 0.025;
  const prevBox = lastCardBox;
  if (cardDetected) {
    lastCardBox = cardBoxFromAnalysis(a);
    showCardBox(lastCardBox);
  } else {
    hideCardBox();
  }
  // "Steady" = low pixel motion, OR the detected box holding still. The second
  // test matters in dim rooms: sensor noise inflates pixel motion even on a
  // tripod-still shot, which used to leave auto capture stuck on "hold still".
  let boxStable = false;
  if (cardDetected && prevBox && now - prevBox.time < 400) {
    boxStable =
      Math.abs(lastCardBox.x - prevBox.x) < lastCardBox.w * 0.035 &&
      Math.abs(lastCardBox.y - prevBox.y) < lastCardBox.h * 0.035 &&
      Math.abs(lastCardBox.w - prevBox.w) < lastCardBox.w * 0.07;
  }
  const steady = a.motion < 9 || boxStable;

  const guide = $("#scan-guide");
  const ring = $("#scan-ring");
  guide.classList.remove("detect", "locking");

  if (!cardDetected) {
    cardVisibleMs = 0;
    ring.classList.remove("show");
    // Re-arm auto capture once the frame has been clear for a moment
    // (i.e. the previous card was taken away).
    frameClearMs += elapsed;
    if (frameClearMs > 500) autoArmed = true;
    setHint(partiallyIn ? "Fit the whole card in the frame…" : "Point at a card…", false);
  } else if (!autoArmed) {
    // Same card still sitting in frame right after a capture.
    frameClearMs = 0;
    ring.classList.remove("show");
    setHint("Captured ✓ — swap to the next card", true);
  } else if (!steady) {
    // Card found but the phone/card is moving — wait, don't reset progress hard.
    frameClearMs = 0;
    cardVisibleMs = Math.max(0, cardVisibleMs - elapsed / 2);
    guide.classList.add("detect");
    ring.classList.remove("show");
    setHint("Card detected — hold still…", true);
  } else {
    frameClearMs = 0;
    cardVisibleMs += elapsed;
    const progress = Math.min(100, Math.round((cardVisibleMs / CARD_HOLD_MS) * 100));

    guide.classList.add("locking");
    ring.classList.add("show");
    ring.style.setProperty("--p", progress);
    setHint("Card detected — capturing…", true);

    if ($("#auto-capture").checked && cardVisibleMs >= CARD_HOLD_MS) {
      captureToBatch();
      // keep the loop running — the camera stays live for the next card
    }
  }
  detTimer = setTimeout(detLoop, 110);
}

function startDetect() {
  stopDetect();
  cardVisibleMs = 0;
  lastDetTick = 0;
  autoArmed = true;
  frameClearMs = 0;
  prevGray = null;
  lastCardBox = null;
  $("#scan-guide").classList.remove("hidden");
  detLoop();
}
function stopDetect() {
  clearTimeout(detTimer);
  detTimer = null;
  hideCardBox();
}

/* Second-pass framing: find the card's outline in the CAPTURED still and
 * re-crop so the card sits centered with even margins. Fixes the systematic
 * "card sits high in the shot" offset — whatever the live detector missed,
 * this pass corrects using the actual captured pixels. */
async function recenterCapture(url) {
  try {
    const img = await loadImage(url);
    const W = 120;
    const H = Math.max(40, Math.round((W * img.naturalHeight) / img.naturalWidth));
    const c = document.createElement("canvas");
    c.width = W;
    c.height = H;
    const cx = c.getContext("2d", { willReadFrequently: true });
    cx.drawImage(img, 0, 0, W, H);
    const { data } = cx.getImageData(0, 0, W, H);
    const gray = new Float32Array(W * H);
    for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
      gray[i] = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    }
    const T = 24;
    // Long-contrast-line score for every row and column.
    const rowScore = new Float32Array(H);
    const colScore = new Float32Array(W);
    for (let y = 1; y < H - 1; y++) {
      for (let x = 1; x < W - 1; x++) {
        if (Math.abs(gray[(y + 1) * W + x] - gray[(y - 1) * W + x]) > T) rowScore[y]++;
        if (Math.abs(gray[y * W + x + 1] - gray[y * W + x - 1]) > T) colScore[x]++;
      }
    }
    // Outermost long lines, searched only near each border (30% bands) so
    // interior card artwork lines can't masquerade as edges.
    const find = (score, len, from, to, step, need) => {
      for (let i = from; step > 0 ? i < to : i > to; i += step) {
        if (score[i] > need) return i;
      }
      return -1;
    };
    const top = find(rowScore, H, 1, Math.round(H * 0.3), 1, W * 0.5);
    const bot = find(rowScore, H, H - 2, Math.round(H * 0.7), -1, W * 0.5);
    const left = find(colScore, W, 1, Math.round(W * 0.3), 1, H * 0.5);
    const right = find(colScore, W, W - 2, Math.round(W * 0.7), -1, H * 0.5);
    if (top < 0 || bot < 0 || left < 0 || right < 0) return url;
    const bw = right - left;
    const bh = bot - top;
    if (bw < W * 0.45 || bh < H * 0.45) return url;

    // Map back to the full-res image and crop with an even margin all around.
    const kx = img.naturalWidth / W;
    const ky = img.naturalHeight / H;
    const m = 0.05;
    const x0 = Math.max(0, (left - bw * m) * kx);
    const y0 = Math.max(0, (top - bh * m) * ky);
    const x1 = Math.min(img.naturalWidth, (right + bw * m) * kx);
    const y1 = Math.min(img.naturalHeight, (bot + bh * m) * ky);
    const out = document.createElement("canvas");
    out.width = Math.round(x1 - x0);
    out.height = Math.round(y1 - y0);
    out.getContext("2d").drawImage(img, x0, y0, x1 - x0, y1 - y0, 0, 0, out.width, out.height);
    return out.toDataURL("image/jpeg", 0.95);
  } catch {
    return url;
  }
}

// Capture the current frame into the batch tray. Used by both auto capture
// and the shutter button. The camera keeps running.
function captureToBatch() {
  const url = captureFromGuide();
  if (!url) return;
  cardVisibleMs = 0;
  autoArmed = false; // wait for the card to leave the frame before re-firing
  flashStage();
  navigator.vibrate?.(35);
  recenterCapture(url).then(addCapture);
}

// Brief white flash so the user knows a shot was taken.
function flashStage() {
  const f = $("#scan-flash");
  if (!f) return;
  f.classList.remove("go");
  void f.offsetWidth; // restart the animation
  f.classList.add("go");
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
      // 1080p+ makes the tight card crops noticeably sharper for OCR.
      video: { facingMode: "environment", width: { ideal: 1920 } },
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
  cam.video.classList.remove("hidden");
  $("#capture-btn").classList.remove("hidden");
  $("#scan-results").innerHTML = "";
  state.scanMatches = [];
  renderTray(); // restore the tray from any previous session
  if (cam.stream) startDetect();
}

$("#capture-btn").addEventListener("click", captureToBatch);

$("#scan-file").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => recenterCapture(reader.result).then(addCapture);
  reader.readAsDataURL(file);
  e.target.value = ""; // allow re-selecting the same file
});

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

/* ---------------- Recognition (shared by every capture) ---------------- */
// Local OCR fallback is loaded only when first needed.
let tesseractLoading = null;
function ensureTesseract() {
  if (window.Tesseract) return Promise.resolve();
  if (!tesseractLoading) {
    tesseractLoading = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
      s.onload = resolve;
      s.onerror = () => {
        tesseractLoading = null;
        reject(new Error("OCR script failed to load"));
      };
      document.head.appendChild(s);
    });
  }
  return tesseractLoading;
}

// Identify one card image: server OCR/AI first, local Tesseract as fallback.
// Returns { parsed, products, confidence, source, rateLimited }.
async function scanImage(imageUrl, retried = false) {
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
        // Burst limits clear within seconds — one delayed retry usually reads
        // fine. (This is what made scans "stop working" after several cards.)
        if (!retried) {
          await new Promise((res) => setTimeout(res, 5000));
          return scanImage(imageUrl, true);
        }
        return { parsed: { name: "", number: null, hp: null }, products: [], rateLimited: true };
      }
      if (d.name || (d.products && d.products.length)) {
        return {
          parsed: { name: d.name, number: d.number, hp: d.hp },
          products: d.products || [],
          confidence: d.confidence,
          source: d.source,
        };
      }
    }
  } catch {
    /* fall through to local OCR */
  }

  // 2) Offline fallback: local Tesseract OCR (loaded on demand — it's a large
  //    script that would otherwise slow every app start for a rare fallback).
  try {
    await ensureTesseract();
    const prepped = await preprocess(imageUrl).catch(() => imageUrl);
    const { data } = await Tesseract.recognize(prepped, "eng");
    const parsed = parseOcr(data);
    let products = [];
    try {
      if (parsed.name && parsed.name.length >= 2) {
        ({ products } = await api.search(parsed.name));
      }
      if (!products.length) {
        const alt = (parsed.raw.split(" · ")[0] || "").replace(/[^A-Za-z' ]/g, "").trim();
        if (alt.length >= 3) ({ products } = await api.search(alt));
      }
    } catch {
      /* ignore */
    }
    products = rerankByCard(products, parsed);
    return { parsed, products, confidence: null, source: "ocr" };
  } catch {
    return { parsed: { name: "", number: null, hp: null }, products: [], failed: true };
  }
}

/* ---------------- Scan batch tray ---------------- */
// Small square thumb for the tray while the card is being identified.
async function makeThumb(url, size = 140) {
  const img = await loadImage(url);
  const c = document.createElement("canvas");
  const scale = size / Math.max(img.naturalWidth || 1, img.naturalHeight || 1);
  c.width = Math.max(1, Math.round((img.naturalWidth || size) * scale));
  c.height = Math.max(1, Math.round((img.naturalHeight || size) * scale));
  c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", 0.8);
}

async function addCapture(imageUrl) {
  const chip = {
    id: "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    image: imageUrl,
    thumb: imageUrl,
    status: "reading",
    parsed: null,
    products: [],
    chosen: null,
    confidence: null,
    rateLimited: false,
  };
  makeThumb(imageUrl).then((t) => {
    chip.thumb = t;
    renderTray();
  }).catch(() => {});
  state.scanBatch.push(chip);
  renderTray();

  const res = await scanImage(imageUrl);
  chip.parsed = res.parsed;
  chip.products = res.products || [];
  chip.confidence = res.confidence ?? null;
  chip.rateLimited = !!res.rateLimited;
  // Only auto-accept a match the recognizer is reasonably sure about.
  // A near-zero score means "best of a bad search" (e.g. an ability name was
  // read as the card name) — make the user confirm instead of guessing wrong.
  const sure = chip.confidence == null || chip.confidence >= 0.25;
  chip.chosen = sure ? chip.products[0] || null : null;
  chip.status = chip.chosen ? "done" : "error";
  renderTray();
  if (!chip.chosen) {
    toast(
      chip.rateLimited
        ? "Reader busy — tap the card to search by name"
        : chip.products.length
        ? "Not sure about this one — tap it to confirm"
        : "No match — tap the card to fix it"
    );
  }
}

function trayTotal() {
  return state.scanBatch.reduce((s, c) => s + (c.chosen?.marketPrice || 0), 0);
}

function chipHTML(c) {
  if (c.status === "reading") {
    return `
      <div class="tray-chip reading" data-chip="${c.id}">
        <img src="${c.thumb}" alt="" />
        <div class="chip-body">
          <div class="chip-name muted">Reading…</div>
          <div class="chip-spin"></div>
        </div>
      </div>`;
  }
  if (!c.chosen) {
    const guess = c.products?.[0];
    return `
      <div class="tray-chip nomatch" data-chip="${c.id}">
        <img src="${c.thumb}" alt="" />
        <div class="chip-body">
          <div class="chip-name">${guess ? esc(guess.name) + "?" : "No match"}</div>
          <div class="chip-meta">tap to confirm</div>
        </div>
        <button class="chip-x" data-chipdel="${c.id}" aria-label="Remove">×</button>
      </div>`;
  }
  const p = c.chosen;
  return `
    <div class="tray-chip" data-chip="${c.id}">
      <img src="${esc(p.image)}" alt="" onerror="this.src='${c.thumb}'" />
      <div class="chip-body">
        <div class="chip-name">${esc(p.name)}</div>
        <div class="chip-meta">${p.number ? "#" + esc(p.number) : esc(p.set || "")}</div>
        <div class="chip-price">${money(p.marketPrice)}</div>
      </div>
      <button class="chip-x" data-chipdel="${c.id}" aria-label="Remove">×</button>
    </div>`;
}

function renderTray() {
  const tray = $("#scan-tray");
  if (!tray) return;
  const batch = state.scanBatch;
  tray.classList.toggle("hidden", batch.length === 0);
  $("#tray-chips").innerHTML = batch.map(chipHTML).join("");
  $("#tray-total").textContent = money(trayTotal());
  const ready = batch.filter((c) => c.chosen).length;
  const btn = $("#tray-add-all");
  btn.disabled = ready === 0;
  btn.textContent = ready ? `Add all (${ready})` : "Add all";
  // Keep the newest chip in view.
  const chips = $("#tray-chips");
  requestAnimationFrame(() => (chips.scrollLeft = chips.scrollWidth));
}

$("#tray-chips").addEventListener("click", (e) => {
  const del = e.target.closest("[data-chipdel]");
  if (del) {
    state.scanBatch = state.scanBatch.filter((c) => c.id !== del.dataset.chipdel);
    renderTray();
    return;
  }
  const chip = e.target.closest("[data-chip]");
  if (chip) openChipSheet(chip.dataset.chip);
});

$("#tray-add-all").addEventListener("click", async (e) => {
  const ready = state.scanBatch.filter((c) => c.chosen);
  if (!ready.length) return;
  const btn = e.target;
  btn.disabled = true;
  btn.textContent = "Adding…";
  let added = 0;
  for (const c of ready) {
    const p = c.chosen;
    try {
      await api.addItem({
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
        condition: "Near Mint",
        quantity: 1,
      });
      added++;
      state.scanBatch = state.scanBatch.filter((x) => x.id !== c.id);
      renderTray();
    } catch {
      /* leave failed chips in the tray */
    }
  }
  await loadUserData();
  btn.textContent = "Add all";
  toast(added ? `Added ${added} card${added === 1 ? "" : "s"} to your collection` : "Couldn't add — try again");
});

/* ---------------- Quick stats sheet (tap a chip) ---------------- */
function closeChipSheet() {
  $("#chip-sheet").classList.add("hidden");
}
document.addEventListener("click", (e) => {
  if (e.target.closest("[data-sheetclose]")) closeChipSheet();
});

function openChipSheet(id) {
  const c = state.scanBatch.find((x) => x.id === id);
  if (!c || c.status === "reading") return;
  renderChipSheet(c);
  $("#chip-sheet").classList.remove("hidden");
}

function renderChipSheet(c) {
  const p = c.chosen;
  const conf = c.confidence != null ? Math.round(c.confidence * 100) : null;

  const alts = (c.products || [])
    .slice(0, 5)
    .map(
      (alt) => `
      <div class="sheet-alt ${p && alt.productId === p.productId ? "sel" : ""}" data-alt="${alt.productId}">
        <img src="${esc(alt.image)}" alt="" onerror="this.style.opacity=.2" />
        <div class="alt-body">
          <div class="alt-name">${esc(alt.name)}</div>
          <div class="alt-meta">${esc(alt.set || "")}${alt.number ? " · #" + esc(alt.number) : ""}</div>
        </div>
        <div class="alt-price">${money(alt.marketPrice)}</div>
      </div>`
    )
    .join("");

  $("#chip-sheet-body").innerHTML = `
    <div class="sheet-grip"></div>
    ${
      p
        ? `
    <div class="sheet-top">
      <img src="${esc(p.image)}" alt="" onerror="this.style.opacity=.2" />
      <div class="sheet-title">
        <h3>${esc(p.name)}</h3>
        <div class="sheet-meta">${esc(p.set || "")}${p.number ? " · #" + esc(p.number) : ""}</div>
        <div class="sheet-tags">
          ${p.rarity ? `<span class="rarity-pill">${esc(p.rarity)}</span>` : ""}
          ${conf != null ? `<span class="conf ${conf >= 80 ? "hi" : conf >= 50 ? "mid" : "lo"}">${conf}% match</span>` : ""}
        </div>
      </div>
    </div>
    <div class="price-row">
      <div class="price-chip market"><div class="lbl">Market</div><div class="val">${money(p.marketPrice)}</div></div>
      <div class="price-chip"><div class="lbl">Median</div><div class="val">${money(p.medianPrice)}</div></div>
      <div class="price-chip"><div class="lbl">Lowest</div><div class="val">${money(p.lowestPrice)}</div></div>
    </div>`
        : `
    <div class="sheet-none">
      <b>⚠ Couldn't match this card${c.rateLimited ? " — the card reader is busy" : ""}.</b>
      Search for it by name:
    </div>`
    }
    <div class="scan-edit sheet-search">
      <input id="sheet-query" class="filter-input" value="${esc(c.parsed?.name || "")}" placeholder="e.g. Psyduck, Charizard ex…" />
      <button class="btn ghost" id="sheet-search-btn">Search</button>
    </div>
    ${alts ? `<div class="sheet-alts-label muted">${p ? "Not the right printing? Tap the correct one:" : ""}</div><div class="sheet-alts">${alts}</div>` : ""}
    <div class="sheet-actions">
      <button class="btn ghost danger" id="sheet-retake">🗑 Retake</button>
      ${p ? `<button class="btn ghost" id="sheet-details">Full details</button>` : ""}
      <button class="btn primary" id="sheet-done">Done</button>
    </div>`;

  // Wire sheet events.
  $("#sheet-done").addEventListener("click", closeChipSheet);
  $("#sheet-retake").addEventListener("click", () => {
    state.scanBatch = state.scanBatch.filter((x) => x.id !== c.id);
    renderTray();
    closeChipSheet();
    toast("Removed — scan it again");
  });
  $("#sheet-details")?.addEventListener("click", () => {
    state.scanMatches = c.products;
    closeChipSheet();
    openDetailById(p.productId);
  });
  const doSearch = async () => {
    const q = $("#sheet-query").value.trim();
    if (!q) return;
    $("#sheet-search-btn").textContent = "…";
    try {
      const { products } = await api.search(q);
      c.products = products;
      c.chosen = products[0] || null;
      c.status = c.chosen ? "done" : "error";
      c.confidence = null;
      renderTray();
      renderChipSheet(c);
    } catch {
      $("#sheet-search-btn").textContent = "Search";
    }
  };
  $("#sheet-search-btn").addEventListener("click", doSearch);
  $("#sheet-query").addEventListener("keydown", (e) => {
    if (e.key === "Enter") doSearch();
  });
  $$(".sheet-alt", $("#chip-sheet-body")).forEach((el) =>
    el.addEventListener("click", () => {
      const alt = c.products.find((x) => x.productId === Number(el.dataset.alt));
      if (!alt) return;
      c.chosen = alt;
      c.status = "done";
      c.confidence = null; // user confirmed it — drop the low-match badge
      renderTray();
      renderChipSheet(c);
    })
  );
}

/* ---------------- Install (PWA) ---------------- */
const ua = navigator.userAgent;
const isStandalone =
  window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone;
// iPadOS Safari reports as "Macintosh"; detect it via touch support.
const isIOS =
  /iphone|ipad|ipod/i.test(ua) ||
  (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1);

// Suppress Chrome's mini-infobar; installing stays available from the browser menu.
window.addEventListener("beforeinstallprompt", (e) => e.preventDefault());

// One-time hint banner for iPhone/iPad Safari users (the platform with no
// native install prompt). Dismissable; never shown again once closed or installed.
if (isIOS && !isStandalone && !localStorage.getItem("iosBannerDismissed")) {
  setTimeout(() => $("#ios-install-banner")?.classList.remove("hidden"), 2500);
}
$("#ios-banner-close")?.addEventListener("click", () => {
  $("#ios-install-banner").classList.add("hidden");
  localStorage.setItem("iosBannerDismissed", "1");
});

/* ---------------- Init ---------------- */
/* ---------------- Auth flow ---------------- */
let authMode = "login";

function hideSplash() {
  const s = $("#splash");
  if (!s || s.classList.contains("gone")) return;
  s.classList.add("gone");
  setTimeout(() => s.remove(), 400);
}
function splashStatus(msg) {
  const el = $("#splash-status");
  if (el) el.textContent = msg;
}

function showAuth() {
  hideSplash();
  $("#auth-screen").classList.remove("hidden");
  $("#app-root").classList.add("hidden");
  $("#auth-error").classList.add("hidden");
  $("#auth-password").value = "";
  // Prefill the last username so returning users only type their password.
  const last = localStorage.getItem("kairos_last_user");
  const uEl = $("#auth-username");
  if (last && !uEl.value) uEl.value = last;
  setTimeout(() => (uEl.value ? $("#auth-password") : uEl).focus(), 60);
}
function hideAuth() {
  hideSplash();
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
  writeCache(CACHE_USER, { username });
}

async function loadUserData() {
  try {
    const [inv, wish] = await Promise.all([api.getInventory(), api.getWishlist()]);
    state.inventory = inv.items || [];
    state.wishlist = wish.wishlist || [];
    state.history = inv.history || [];
    state.groups = inv.groups || [];
    // Snapshot for instant rendering on the next app open.
    writeUserSnapshot();
  } catch {
    // Server unreachable (asleep/offline) — keep whatever is on screen
    // (usually the cached snapshot) instead of blanking the collection.
  }
  renderCollection();
  renderWishlist();
}

// Auth tab switching (event-delegated so dynamically-rebuilt hint works too).
document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-auth]");
  if (t) setAuthMode(t.dataset.auth);
});

// Show / hide password
$("#pass-eye")?.addEventListener("click", () => {
  const inp = $("#auth-password");
  inp.type = inp.type === "password" ? "text" : "password";
  $("#pass-eye").textContent = inp.type === "password" ? "👁" : "🙈";
  inp.focus();
});

$("#auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const username = $("#auth-username").value.trim();
  const password = $("#auth-password").value;
  if (!username || !password) return authError("Enter a username and password.");
  const btn = $("#auth-submit");
  btn.disabled = true;
  btn.textContent = authMode === "login" ? "Logging in…" : "Creating…";
  $("#auth-error").classList.add("hidden");
  // The free-tier server sleeps when idle; the first request of the day hangs
  // ~30s while it wakes. Explain that instead of looking frozen.
  const wakeTimer = setTimeout(() => $("#auth-wake").classList.remove("hidden"), 2500);
  try {
    const d = authMode === "login"
      ? await api.login(username, password)
      : await api.register(username, password);
    setToken(d.token);
    localStorage.setItem("kairos_last_user", d.username);
    applyUser(d.username);
    hideAuth();
    await loadUserData();
    toast(`Welcome${authMode === "register" ? "" : " back"}, ${d.username}!`);
  } catch (err) {
    authError(
      err instanceof TypeError
        ? "Can't reach the server — check your connection and try again."
        : err.message
    );
  } finally {
    clearTimeout(wakeTimer);
    $("#auth-wake").classList.add("hidden");
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
  localStorage.removeItem(CACHE_USER);
  localStorage.removeItem(CACHE_DATA);
  state.inventory = [];
  state.wishlist = [];
  state.history = [];
  state.groups = [];
  setSelectMode(false);
  $("#user-dropdown").classList.add("hidden");
  setAuthMode("login");
  showAuth();
});

/* ---------------- Boot ----------------
 * Returning users see their collection INSTANTLY from the local snapshot;
 * the session check + fresh data sync happen in the background. Only a real
 * 401 (session revoked) sends them back to the login screen — a sleeping
 * server never does. */
async function syncInBackground(attempt = 0) {
  try {
    const me = await api.me();
    applyUser(me.username);
    await loadUserData();
  } catch (e) {
    if (e.status === 401) {
      setToken(null);
      localStorage.removeItem(CACHE_USER);
      localStorage.removeItem(CACHE_DATA);
      setAuthMode("login");
      showAuth();
      authError("Your session expired — please log in again.");
      return;
    }
    // Unreachable (cold start / offline): retry quietly, keep the cached view.
    if (attempt < 5) setTimeout(() => syncInBackground(attempt + 1), 8000 * (attempt + 1));
    else toast("Offline — showing your last synced collection");
  }
}

(async function init() {
  const cachedUser = authToken ? readCache(CACHE_USER) : null;

  // Fast path: token + snapshot → straight into the app, no network wait.
  if (authToken && cachedUser?.username) {
    applyUser(cachedUser.username);
    const snap = readCache(CACHE_DATA);
    if (snap) {
      state.inventory = snap.inventory || [];
      state.wishlist = snap.wishlist || [];
      state.history = snap.history || [];
      state.groups = snap.groups || [];
      renderCollection();
      renderWishlist();
    }
    hideAuth(); // shows the app, removes the splash
    syncInBackground();
    return;
  }

  // Token but no snapshot yet (first open on this device): verify online.
  if (authToken) {
    const slow = setTimeout(
      () => splashStatus("Waking the server — can take ~30 seconds…"),
      2500
    );
    try {
      const me = await api.me();
      clearTimeout(slow);
      applyUser(me.username);
      hideAuth();
      await loadUserData();
      return;
    } catch (e) {
      clearTimeout(slow);
      if (e.status === 401) setToken(null);
      // Network failure with a token: keep the token (the session is probably
      // fine) but we can't verify it — land on login with an explanation.
      setAuthMode("login");
      showAuth();
      if (!e.status) authError("Couldn't reach the server — try again in a moment.");
      return;
    }
  }

  setAuthMode("login");
  showAuth();
})();
