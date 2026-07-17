/* End-to-end test for multi-select bulk ops and custom groups. */
const BASE = process.env.TEST_BASE || "http://localhost:3997";

const j = (r) => r.json();
const check = (name, cond) => {
  if (!cond) {
    console.error(`FAIL  ${name}`);
    process.exitCode = 1;
  } else {
    console.log(`ok    ${name}`);
  }
};

const reg = await fetch(`${BASE}/api/auth/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: `grouptest${Date.now()}`, password: "test123" }),
}).then(j);
const H = { "content-type": "application/json", authorization: `Bearer ${reg.token}` };

// Seed three items.
const ids = [];
for (const [pid, name, price] of [[1, "Card A", 5], [2, "Card B", 10], [3, "Card C", 20]]) {
  const it = await fetch(`${BASE}/api/inventory`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ productId: pid, name, marketPrice: price }),
  }).then(j);
  ids.push(it.id);
}

// Create a group.
let g = await fetch(`${BASE}/api/groups`, {
  method: "POST",
  headers: H,
  body: JSON.stringify({ name: "Binder 1" }),
}).then(j);
check("create group", g.groups.includes("Binder 1"));

// Duplicate create is a no-op.
g = await fetch(`${BASE}/api/groups`, {
  method: "POST",
  headers: H,
  body: JSON.stringify({ name: "Binder 1" }),
}).then(j);
check("duplicate group not doubled", g.groups.filter((x) => x === "Binder 1").length === 1);

// Bulk-assign two cards to the group.
let b = await fetch(`${BASE}/api/inventory/bulk`, {
  method: "POST",
  headers: H,
  body: JSON.stringify({ ids: ids.slice(0, 2), action: "group", group: "Binder 1" }),
}).then(j);
check("bulk group affected 2", b.affected === 2);
check("items carry group", b.items.filter((i) => i.group === "Binder 1").length === 2);

// Ungroup one card.
b = await fetch(`${BASE}/api/inventory/bulk`, {
  method: "POST",
  headers: H,
  body: JSON.stringify({ ids: [ids[0]], action: "group", group: null }),
}).then(j);
check("ungroup one", b.items.find((i) => i.id === ids[0]).group === null);

// Bulk delete two cards.
b = await fetch(`${BASE}/api/inventory/bulk`, {
  method: "POST",
  headers: H,
  body: JSON.stringify({ ids: [ids[0], ids[2]], action: "delete" }),
}).then(j);
check("bulk delete affected 2", b.affected === 2);
check("one item left", b.items.length === 1);

// Delete the group — remaining member keeps its card but loses the tag.
const d = await fetch(`${BASE}/api/groups/${encodeURIComponent("Binder 1")}`, {
  method: "DELETE",
  headers: H,
}).then(j);
check("group gone", !d.groups.includes("Binder 1"));
check("card kept, tag cleared", d.items.length === 1 && d.items[0].group === null);

// Single delete still works.
const s = await fetch(`${BASE}/api/inventory/${d.items[0].id}`, {
  method: "DELETE",
  headers: H,
}).then(j);
check("single delete ok", s.ok === true);

const inv = await fetch(`${BASE}/api/inventory`, { headers: H }).then(j);
check("inventory empty at end", inv.items.length === 0);
check("groups list returned in inventory payload", Array.isArray(inv.groups));

console.log(process.exitCode ? "\nSOME TESTS FAILED" : "\nALL TESTS PASSED");
