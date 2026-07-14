// Sanity checks for the straight-edge line scoring and fuzzy species logic.
// Mirrors the implementations in public/app.js (lineScore) and server.js (editDist1).

function lineScore(hits, len) {
  let best = 0;
  let bestIdx = -1;
  let totalHits = 0;
  for (let i = 0; i < hits.length; i++) totalHits += hits[i];
  for (let i = 1; i < hits.length; i++) {
    const w = hits[i] + (hits[i - 1] || 0) + (i + 1 < hits.length ? hits[i + 1] : 0);
    if (w > best) { best = w; bestIdx = i; }
  }
  return { frac: best / len, ratio: best / Math.max(1, totalHits), idx: bestIdx };
}
const isEdge = (s) => s.frac > 0.55 && s.ratio > 0.42;

const W = 94; // band length (DET_W - 2)
const rows = 25; // band depth (~20% of DET_H)

// Case 1: clean card edge — one row with hits across ~90% of the width.
const cardBand = Array(rows).fill(0);
cardBand[12] = Math.round(W * 0.9);
cardBand[13] = Math.round(W * 0.3); // sleeve double-line
console.log("card edge:", lineScore(cardBand, W), "->", isEdge(lineScore(cardBand, W)) ? "EDGE ✓" : "no edge ✗");

// Case 2: busy texture (ceiling/blanket) — hits scattered over every row.
const textureBand = Array(rows).fill(Math.round(W * 0.3));
console.log("texture:", lineScore(textureBand, W), "->", isEdge(lineScore(textureBand, W)) ? "EDGE ✗ (bad!)" : "rejected ✓");

// Case 3: dense texture — heavy gradients everywhere (popcorn ceiling in harsh light).
const denseBand = Array(rows).fill(Math.round(W * 0.55));
console.log("dense texture:", lineScore(denseBand, W), "->", isEdge(lineScore(denseBand, W)) ? "EDGE ✗ (bad!)" : "rejected ✓");

// Case 4: single ceiling/molding line but nothing else — passes as ONE edge,
// which is fine: detection needs 3 sides including an opposite pair.
const moldingBand = Array(rows).fill(0);
moldingBand[5] = Math.round(W * 0.95);
console.log("molding line:", lineScore(moldingBand, W), "->", isEdge(lineScore(moldingBand, W)) ? "EDGE (ok, needs pair+3)" : "rejected");

// ---- editDist1 (same as server.js) ----
function editDist1(a, b) {
  if (a === b) return true;
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (la === lb) { i++; j++; }
    else if (la > lb) i++;
    else j++;
  }
  return edits + (la - i) + (lb - j) <= 1;
}
const cases = [
  ["giaceon", "glaceon", true],
  ["glaceon", "glaceon", true],
  ["charizar", "charizard", true],
  ["freezing", "weezing", false],
  ["kyogre", "glaceon", false],
  ["pikchu", "pikachu", true],
  ["eeveee", "eevee", true],
  ["damage", "yamask", false],
];
let pass = 0;
for (const [a, b, want] of cases) {
  const got = editDist1(a, b);
  if (got === want) pass++;
  else console.log(`editDist1(${a},${b}) = ${got}, wanted ${want}  ✗`);
}
console.log(`editDist1: ${pass}/${cases.length} pass`);
