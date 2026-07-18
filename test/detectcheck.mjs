// Sanity checks for the whole-frame card-outline detector (public/app.js) and
// the fuzzy species / collector number logic (server.js). Mirrors those
// implementations — keep in sync when tuning app.js.

const DET_W = 96;
const DET_H = 128;
const CARD_WH = 63 / 88;
// Sample-region pixel scale (guide is ~0.665 w/h, det canvas is 0.75 — so a
// det-canvas pixel is wider than tall in the real world).
const kx = 0.886;
const ky = 1;

const SLOPES = [-9, -6, -3, 0, 3, 6, 9];
function scanLines(mask, nPos, len) {
  const score = new Float32Array(nPos);
  const slope = new Float32Array(nPos);
  for (let pos = 1; pos < nPos - 1; pos++) {
    let best = 0;
    let bestSl = 0;
    for (const sl of SLOPES) {
      let run = 0;
      let maxRun = 0;
      let gap = 3;
      for (let t = 0; t < len; t++) {
        const d = pos + Math.round((sl * t) / len);
        let hit = false;
        if (d >= 1 && d < nPos - 1) {
          const at = d * len + t;
          hit = !!(mask[at] || mask[at - len] || mask[at + len]);
        }
        if (hit) {
          run += 1 + (gap < 3 ? gap : 0);
          gap = 0;
          if (run > maxRun) maxRun = run;
        } else if (++gap > 2) {
          run = 0;
        }
      }
      if (maxRun > best) {
        best = maxRun;
        bestSl = sl;
      }
    }
    score[pos] = best / len;
    slope[pos] = bestSl;
  }
  return { score, slope };
}

function candidates({ score, slope }, nPos) {
  const sorted = [...score].sort((a, b) => a - b);
  const median = sorted[Math.floor(nPos / 2)];
  const need = Math.max(0.45, median * 1.35);
  const out = [];
  for (let p = 1; p < nPos - 1; p++) {
    if (score[p] >= need && score[p] >= score[p - 1] && score[p] > score[p + 1]) {
      out.push({ pos: p + slope[p] / 2, p, slope: slope[p], score: score[p] });
    }
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 10);
}

function findCard(vM, hM) {
  const vCands = candidates(scanLines(vM, DET_W, DET_H), DET_W);
  const hCands = candidates(scanLines(hM, DET_H, DET_W), DET_H);
  const covLine = (mask, nPos, len, cand, a, b) => {
    const t0 = Math.max(1, Math.round(a));
    const t1 = Math.min(len - 2, Math.round(b));
    if (t1 <= t0) return 0;
    let cnt = 0;
    for (let t = t0; t <= t1; t++) {
      const d = Math.round(cand.p + (cand.slope * t) / len);
      if (d >= 1 && d < nPos - 1) {
        const at = d * len + t;
        if (mask[at] || mask[at - len] || mask[at + len]) cnt++;
      }
    }
    return cnt / (t1 - t0 + 1);
  };
  const covV = (cand, a, b) => covLine(vM, DET_W, DET_H, cand, a, b);
  const covH = (cand, a, b) => covLine(hM, DET_H, DET_W, cand, a, b);
  const detAspect = (w, h) => (w * kx) / Math.max(1, h * ky);
  const MIN_W = DET_W * 0.42;
  const MIN_H = DET_H * 0.42;

  const QUAD_MIN = 3.0;
  let quad = null;
  for (const L of vCands) for (const R of vCands) {
    const w = R.pos - L.pos;
    if (w < MIN_W) continue;
    for (const Tp of hCands) for (const B of hCands) {
      const h = B.pos - Tp.pos;
      if (h < MIN_H) continue;
      const asp = detAspect(w, h);
      if (asp < 0.58 || asp > 0.9) continue;
      const cL = covV(L, Tp.pos, B.pos);
      if (cL < 0.5) continue;
      const cR = covV(R, Tp.pos, B.pos);
      if (cR < 0.5) continue;
      const cT = covH(Tp, L.pos, R.pos);
      if (cT < 0.5) continue;
      const cB = covH(B, L.pos, R.pos);
      if (cB < 0.5) continue;
      const aspFit = 1 - Math.min(1, Math.abs(asp - CARD_WH) / 0.12);
      const q =
        cL + cR + cT + cB +
        0.5 * aspFit +
        0.2 * (w / DET_W + h / DET_H);
      if (q >= QUAD_MIN && (!quad || q > quad.q))
        quad = { q, left: L.pos, right: R.pos, top: Tp.pos, bot: B.pos };
    }
  }

  const isLattice = (box) => {
    const bl = box.left ?? 0;
    const br = box.right ?? DET_W - 1;
    const bt = box.top ?? 0;
    const bb = box.bot ?? DET_H - 1;
    let inter = 0;
    for (const c of vCands) {
      if (c.pos > bl + 3 && c.pos < br - 3 && covV(c, bt + 3, bb - 3) >= 0.55) inter++;
    }
    for (const c of hCands) {
      if (c.pos > bt + 3 && c.pos < bb - 3 && covH(c, bl + 3, br - 3) >= 0.55) inter++;
    }
    return inter >= 4;
  };
  if (quad && isLattice(quad)) quad = null;

  let tri = null;
  if (!quad) {
    const keep = (q, box) => {
      if (!tri || q > tri.q) tri = { q, ...box };
    };
    const TRI_MIN = 2.1;
    for (const L of vCands) for (const R of vCands) {
      const w = R.pos - L.pos;
      if (w < MIN_W) continue;
      const hInf = (w * kx) / CARD_WH / ky;
      for (const Tp of hCands) {
        if (Tp.pos + hInf >= DET_H - 4 && Tp.pos + hInf <= DET_H * 1.25) {
          const q = covV(L, Tp.pos, DET_H) + covV(R, Tp.pos, DET_H) + covH(Tp, L.pos, R.pos);
          if (q >= TRI_MIN) keep(q, { left: L.pos, right: R.pos, top: Tp.pos, bot: null });
        }
      }
      for (const B of hCands) {
        if (B.pos - hInf <= 4 && B.pos - hInf >= -DET_H * 0.25) {
          const q = covV(L, 0, B.pos) + covV(R, 0, B.pos) + covH(B, L.pos, R.pos);
          if (q >= TRI_MIN) keep(q, { left: L.pos, right: R.pos, top: null, bot: B.pos });
        }
      }
    }
    for (const Tp of hCands) for (const B of hCands) {
      const h = B.pos - Tp.pos;
      if (h < MIN_H) continue;
      const wInf = ((h * ky) * CARD_WH) / kx;
      for (const L of vCands) {
        if (L.pos + wInf >= DET_W - 4 && L.pos + wInf <= DET_W * 1.25) {
          const q = covH(Tp, L.pos, DET_W) + covH(B, L.pos, DET_W) + covV(L, Tp.pos, B.pos);
          if (q >= TRI_MIN) keep(q, { top: Tp.pos, bot: B.pos, left: L.pos, right: null });
        }
      }
      for (const R of vCands) {
        if (R.pos - wInf <= 4 && R.pos - wInf >= -DET_W * 0.25) {
          const q = covH(Tp, 0, R.pos) + covH(B, 0, R.pos) + covV(R, Tp.pos, B.pos);
          if (q >= TRI_MIN) keep(q, { top: Tp.pos, bot: B.pos, left: null, right: R.pos });
        }
      }
    }
  }
  if (tri && isLattice(tri)) tri = null;
  return { pick: quad || tri, sides: quad ? 4 : tri ? 3 : 0 };
}

/* ---- synthetic scenes ---- */
const mkMasks = () => ({ vM: new Uint8Array(DET_W * DET_H), hM: new Uint8Array(DET_W * DET_H) });
// Vertical line at x, drifting `drift` px over the y-range.
const addV = (m, x, y0, y1, drift = 0, gapEvery = 0) => {
  for (let y = y0; y < y1; y++) {
    if (gapEvery && y % gapEvery === 0) continue;
    const xx = Math.round(x + (drift * (y - y0)) / DET_H);
    if (xx >= 0 && xx < DET_W && y >= 0 && y < DET_H) m.vM[xx * DET_H + y] = 1;
  }
};
const addH = (m, y, x0, x1, drift = 0, gapEvery = 0) => {
  for (let x = x0; x < x1; x++) {
    if (gapEvery && x % gapEvery === 0) continue;
    const yy = Math.round(y + (drift * (x - x0)) / DET_W);
    if (yy >= 0 && yy < DET_H && x >= 0 && x < DET_W) m.hM[yy * DET_W + x] = 1;
  }
};
let seed = 7;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const addNoise = (m, p) => {
  for (let x = 0; x < DET_W; x++) for (let y = 0; y < DET_H; y++) {
    if (rnd() < p) m.vM[x * DET_H + y] = 1;
    if (rnd() < p) m.hM[y * DET_W + x] = 1;
  }
};

let fails = 0;
function scene(name, m, wantSides, wantBox) {
  const { pick, sides } = findCard(m.vM, m.hM);
  let ok = sides === wantSides;
  if (ok && wantBox && pick) {
    for (const k of ["left", "right", "top", "bot"]) {
      if (wantBox[k] === null) {
        if (pick[k] !== null) ok = false;
      } else if (pick[k] === null || Math.abs(pick[k] - wantBox[k]) > 4) ok = false;
    }
  }
  if (!ok) fails++;
  console.log(
    `${name}: sides=${sides}${pick ? ` box=[${["left", "right", "top", "bot"].map((k) => (pick[k] == null ? "·" : Math.round(pick[k]))).join(",")}]` : ""} -> ${ok ? "✓" : "✗ WRONG"}`
  );
}

// Card geometry used below: 78 det-px wide → real aspect 0.716 → 97 det-px tall.
// 1. Clean card on a plain table.
let m = mkMasks();
addV(m, 9, 12, 109); addV(m, 87, 12, 109);
addH(m, 12, 9, 87); addH(m, 109, 9, 87);
scene("clean card", m, 4, { left: 9, right: 87, top: 12, bot: 109 });

// 2. Tilted card (~4° = 6px drift), slight gaps (sleeve glare).
m = mkMasks();
addV(m, 9, 12, 109, 6, 9); addV(m, 87, 12, 109, 6, 9);
addH(m, 12, 9, 87, 6, 9); addH(m, 109, 9, 87, 6, 9);
scene("tilted sleeved card", m, 4);

// 3. Card held OVER A STACK of other cards (the TestFlight failure scene):
//    full card outline + partial edges of cards underneath + speckle noise.
m = mkMasks();
addV(m, 9, 12, 109); addV(m, 87, 12, 109);
addH(m, 12, 9, 87); addH(m, 109, 9, 87);
addV(m, 20, 100, 128); addV(m, 70, 95, 128); // stack edges poking out below
addH(m, 118, 0, 60); addH(m, 122, 30, 96);
addV(m, 3, 0, 50); addH(m, 5, 40, 96); // and above/left
addNoise(m, 0.06);
scene("card over messy stack", m, 4, { left: 9, right: 87, top: 12, bot: 109 });

// 4. Card hanging out the BOTTOM of the frame (top+left+right only).
m = mkMasks();
addV(m, 9, 30, 128); addV(m, 87, 30, 128);
addH(m, 30, 9, 87);
scene("card off bottom edge", m, 3, { left: 9, right: 87, top: 30, bot: null });

// 4b. SMALLER card (~60% of frame) on a cluttered table: neighbor-card edges
//     run the full frame height at the borders, wood grain speckles everywhere.
//     The old full-frame-coverage scoring failed exactly this scene.
m = mkMasks();
addV(m, 25, 25, 82); addV(m, 71, 25, 82);   // the card (46 x 57 ≈ card aspect)
addH(m, 25, 25, 71); addH(m, 82, 25, 71);
addV(m, 2, 0, 128); addV(m, 93, 0, 128);    // neighboring cards at the borders
addH(m, 5, 0, 96);                           // table edge across the top
addNoise(m, 0.1);
scene("small card, busy table", m, 4, { left: 25, right: 71, top: 25, bot: 82 });

// 4c. Card with a LONG wood-grain line above it and a shelf edge to its left
//     (the "offset green box" bug: global lines used to bound a box whose
//     extent they never touched). Box must land on the CARD.
m = mkMasks();
addV(m, 25, 30, 87); addV(m, 71, 30, 87);   // the card (46 x 57)
addH(m, 30, 25, 71); addH(m, 87, 25, 71);
addH(m, 8, 0, 96);                           // wood-grain line above, full width
addH(m, 14, 0, 96);
addV(m, 8, 0, 128);                          // shelf edge left, full height
addNoise(m, 0.05);
scene("card near long stray lines", m, 4, { left: 25, right: 71, top: 30, bot: 87 });

// 4d. KEYBOARD / grid — key rows and columns form card-aspect sub-rectangles
//     with genuine corners, but many aligned lines CROSS the interior.
//     Must NOT detect (this fired "Card detected" at a desk full of keyboards).
m = mkMasks();
for (let y = 10; y < 128; y += 13) addH(m, y, 4, 92);   // key rows
for (let x = 6; x < 96; x += 11) addV(m, x, 6, 122);    // key columns
addNoise(m, 0.04);
scene("keyboard grid", m, 0);

// 5. Scattered texture (blanket / wood grain) — must NOT detect.
m = mkMasks();
addNoise(m, 0.3);
scene("scattered texture", m, 0);

// 6. Dense texture (popcorn ceiling in harsh light) — must NOT detect.
m = mkMasks();
addNoise(m, 0.55);
scene("dense texture", m, 0);

// 7. Square object (coaster) — wrong proportions, must NOT detect.
//    True square in REAL units: det height = width * kx (det pixels aren't square).
m = mkMasks();
addV(m, 20, 20, 70); addV(m, 76, 20, 70);
addH(m, 20, 20, 76); addH(m, 70, 20, 76);
scene("square coaster", m, 0);

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
  else { console.log(`editDist1(${a},${b}) wrong`); fails++; }
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
  else { console.log(`normCollector(${a},${b}) wrong`); fails++; }
}
console.log(`normCollector: ${np}/${nums.length} pass`);

if (fails) {
  console.error(`\n${fails} CHECK(S) FAILED`);
  process.exit(1);
}
console.log("\nALL DETECTOR CHECKS PASSED");
