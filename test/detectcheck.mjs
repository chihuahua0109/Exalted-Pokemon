// Sanity checks for the tilt-tolerant edge fit (public/app.js) and the
// fuzzy species / collector number logic (server.js). Mirrors those implementations.

const SLOPES = [-9, -6, -3, 0, 3, 6, 9];
function lineFit(mask, depth, len) {
  let total = 0;
  for (let i = 0; i < mask.length; i++) total += mask[i];
  let best = 0;
  let bestAt = -1;
  for (const sl of SLOPES) {
    for (let base = 1; base < depth; base++) {
      let cnt = 0;
      for (let t = 0; t < len; t++) {
        const d = base + Math.round((sl * t) / len);
        if (d >= 1 && d < depth) {
          const at = d * len + t;
          if (mask[at] || (d > 1 && mask[at - len]) || (d < depth - 1 && mask[at + len])) cnt++;
        }
      }
      if (cnt > best) { best = cnt; bestAt = base + sl / 2; }
    }
  }
  return { frac: best / len, ratio: best / Math.max(1, total), idx: bestAt };
}
const isEdge = (s) => s.frac > 0.5 && s.ratio > 0.3;

const LEN = 96;
const DEPTH = 25;
const mk = () => new Uint8Array(DEPTH * LEN);
const put = (m, d, t) => { if (d >= 0 && d < DEPTH && t >= 0 && t < LEN) m[d * LEN + t] = 1; };

// 1. Straight card edge across 90% of the band.
const straight = mk();
for (let t = 4; t < LEN - 4; t++) put(straight, 12, t);
report("straight edge", straight, true);

// 2. TILTED edge: drifts 8 rows across the width (~5°) — the old 3-row window
//    failed this; the slope fit must pass it.
const tilted = mk();
for (let t = 2; t < LEN - 2; t++) put(tilted, 8 + Math.round((8 * t) / LEN), t);
report("tilted edge (8px drift)", tilted, true);

// 3. Sleeved card: card edge + sleeve edge a few rows apart (both real lines).
const sleeved = mk();
for (let t = 4; t < LEN - 4; t++) { put(sleeved, 10, t); if (t % 3) put(sleeved, 15, t); }
report("card + sleeve double line", sleeved, true);

// 4. Scattered texture (blanket/wood grain): hits everywhere, no line.
const texture = mk();
let seed = 7;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
for (let d = 0; d < DEPTH; d++) for (let t = 0; t < LEN; t++) if (rnd() < 0.3) put(texture, d, t);
report("scattered texture", texture, false);

// 5. DENSE texture (popcorn ceiling in harsh light).
const dense = mk();
for (let d = 0; d < DEPTH; d++) for (let t = 0; t < LEN; t++) if (rnd() < 0.55) put(dense, d, t);
report("dense texture", dense, false);

function report(name, mask, want) {
  const s = lineFit(mask, DEPTH, LEN);
  const got = isEdge(s);
  const verdict = got === want ? "✓" : "✗ WRONG";
  console.log(
    `${name}: frac=${s.frac.toFixed(2)} ratio=${s.ratio.toFixed(2)} -> ${got ? "EDGE" : "rejected"} ${verdict}`
  );
}

// ---- editDist1 (server.js) ----
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
const fuzz = [
  ["giaceon", "glaceon", true],
  ["freezing", "weezing", false],
  ["fennekin", "fennekin", true],
  ["fenekin", "fennekin", true],
  ["torchic", "fennekin", false],
];
let pass = 0;
for (const [a, b, want] of fuzz) {
  if (editDist1(a, b) === want) pass++;
  else console.log(`editDist1(${a},${b}) wrong`);
}
console.log(`editDist1: ${pass}/${fuzz.length} pass`);

// ---- collector number normalisation (server.js) ----
function normCollector(n) {
  return String(n).replace(/\s+/g, "").split("/").map((p) => p.replace(/^0+(?=.)/, "")).join("/");
}
const nums = [
  ["011/086", "11/86", true],
  ["040/203", "040/203", true],
  ["25/162", "025/162", true],
  ["11/86", "11/96", false],
];
let np = 0;
for (const [a, b, want] of nums) {
  if ((normCollector(a) === normCollector(b)) === want) np++;
  else console.log(`normCollector(${a},${b}) wrong`);
}
console.log(`normCollector: ${np}/${nums.length} pass`);
