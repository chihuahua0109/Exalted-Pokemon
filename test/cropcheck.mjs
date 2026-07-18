// Validates the server-side full-card normalization (server.js):
//   cropToCard  – re-detects the card outline in a received shot and crops to
//                 it, so the OCR name/number bands always land on the card.
//   shrinkForOcr – keeps uploads under the OCR.space ~1MB cap.
// Mirrors the server implementation — keep in sync when tuning server.js.
import sharp from "sharp";

const bufToDataUrl = (buf) => `data:image/jpeg;base64,${buf.toString("base64")}`;
const dataUrlToBuffer = (d) => Buffer.from(d.split(",")[1], "base64");

/* ---- mirrored from server.js ---- */
const CROP_W = 96;
const CROP_H = 128;
const CARD_WH = 63 / 88;

function findCardBox(gray, W, H, kx, ky) {
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
  const T = 20;
  const vM = new Uint8Array(W * H);
  const hM = new Uint8Array(W * H);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      if (Math.abs(gray[y * W + x + 1] - gray[y * W + x - 1]) > T) vM[x * H + y] = 1;
      if (Math.abs(gray[(y + 1) * W + x] - gray[(y - 1) * W + x]) > T) hM[y * W + x] = 1;
    }
  }
  const SLOPES = [-9, -6, -3, 0, 3, 6, 9];
  const scanLines = (mask, nPos, len) => {
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
  };
  const candidates = ({ score, slope }, nPos) => {
    const sorted = [...score].sort((a, b) => a - b);
    const median = sorted[Math.floor(nPos / 2)];
    const need = Math.max(0.45, median * 1.35);
    const out = [];
    for (let p = 1; p < nPos - 1; p++) {
      if (score[p] >= need && score[p] >= score[p - 1] && score[p] > score[p + 1]) {
        out.push({ pos: p + slope[p] / 2, score: score[p] });
      }
    }
    return out.sort((a, b) => b.score - a.score).slice(0, 10);
  };
  const vCands = candidates(scanLines(vM, W, H), W);
  const hCands = candidates(scanLines(hM, H, W), H);
  const detAspect = (w, h) => (w * kx) / Math.max(1, h * ky);
  const MIN_W = W * 0.42;
  const MIN_H = H * 0.42;
  const edgeFit = (runFrac, lenFull, expected) => {
    const run = runFrac * lenFull;
    return Math.min(run, expected) / Math.max(run, expected, 1);
  };
  let quad = null;
  for (const L of vCands) for (const R of vCands) {
    const w = R.pos - L.pos;
    if (w < MIN_W) continue;
    for (const Tp of hCands) for (const B of hCands) {
      const h = B.pos - Tp.pos;
      if (h < MIN_H) continue;
      const asp = detAspect(w, h);
      if (asp < 0.55 || asp > 0.95) continue;
      const aspFit = 1 - Math.min(1, Math.abs(asp - CARD_WH) / 0.14);
      const q =
        edgeFit(L.score, H, h) +
        edgeFit(R.score, H, h) +
        edgeFit(Tp.score, W, w) +
        edgeFit(B.score, W, w) +
        0.5 * aspFit +
        0.1 * (w / W + h / H);
      if (q >= 2.6 && (!quad || q > quad.q))
        quad = { q, left: L.pos, right: R.pos, top: Tp.pos, bot: B.pos };
    }
  }
  return quad;
}

async function cropToCard(dataUrl) {
  const src = sharp(dataUrlToBuffer(dataUrl)).rotate();
  const meta = await src.metadata();
  let W0 = meta.width || 0;
  let H0 = meta.height || 0;
  if ((meta.orientation || 1) >= 5) [W0, H0] = [H0, W0];
  if (W0 < 200 || H0 < 200) return { out: dataUrl, cropped: false };

  const raw = await src
    .clone()
    .grayscale()
    .resize(CROP_W, CROP_H, { fit: "fill" })
    .raw()
    .toBuffer();
  const gray = new Float32Array(CROP_W * CROP_H);
  for (let i = 0; i < gray.length; i++) gray[i] = raw[i];

  const box = findCardBox(gray, CROP_W, CROP_H, W0 / CROP_W, H0 / CROP_H);
  if (!box) return { out: dataUrl, cropped: false };
  const bw = box.right - box.left;
  const bh = box.bot - box.top;
  if (bw >= CROP_W * 0.86 && bh >= CROP_H * 0.86) return { out: dataUrl, cropped: false };

  const kx = W0 / CROP_W;
  const ky = H0 / CROP_H;
  const m = 0.08;
  const x0 = Math.max(0, Math.round((box.left - bw * m) * kx));
  const y0 = Math.max(0, Math.round((box.top - bh * m) * ky));
  const x1 = Math.min(W0, Math.round((box.right + bw * m) * kx));
  const y1 = Math.min(H0, Math.round((box.bot + bh * m) * ky));
  if (x1 - x0 < 220 || y1 - y0 < 300) return { out: dataUrl, cropped: false };

  const out = await src
    .extract({ left: x0, top: y0, width: x1 - x0, height: y1 - y0 })
    .jpeg({ quality: 93 })
    .toBuffer();
  return { out: bufToDataUrl(out), cropped: true, box: { x0, y0, x1, y1 } };
}

const OCR_MAX_BYTES = 950 * 1024;
async function shrinkForOcr(dataUrl) {
  if (dataUrlToBuffer(dataUrl).length <= OCR_MAX_BYTES) return dataUrl;
  let q = 88;
  let buf = await sharp(dataUrlToBuffer(dataUrl))
    .rotate()
    .resize({ width: 1400, withoutEnlargement: true })
    .jpeg({ quality: q })
    .toBuffer();
  while (buf.length > OCR_MAX_BYTES && q > 55) {
    q -= 12;
    buf = await sharp(dataUrlToBuffer(dataUrl))
      .rotate()
      .resize({ width: 1400, withoutEnlargement: true })
      .jpeg({ quality: q })
      .toBuffer();
  }
  return bufToDataUrl(buf);
}

/* ---- synthetic scenes ---- */
// A "photo": card rectangle (light, with dark text bars + border line) over a
// wood-ish background (medium tone + streaks). Card placed at a given rect.
let seed = 11;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;

async function makeShot(W, H, card) {
  const px = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      // wood: warm mid-brown with horizontal streak noise
      const streak = 18 * Math.sin(y * 0.6 + Math.sin(x * 0.01) * 3) + (rnd() - 0.5) * 14;
      px[i] = 120 + streak;
      px[i + 1] = 88 + streak * 0.8;
      px[i + 2] = 58 + streak * 0.6;
    }
  }
  const { x, y, w, h } = card;
  for (let yy = y; yy < y + h; yy++) {
    for (let xx = x; xx < x + w; xx++) {
      const i = (yy * W + xx) * 3;
      const border =
        yy - y < 6 || y + h - yy <= 6 || xx - x < 6 || x + w - xx <= 6;
      const v = border ? 235 : 205 + (rnd() - 0.5) * 20;
      px[i] = v;
      px[i + 1] = v;
      px[i + 2] = v - 8;
    }
  }
  // "text" rows: name near the top, attacks mid, collector number at bottom
  const bar = (fy, fh, fx0, fx1, tone) => {
    for (let yy = y + Math.round(h * fy); yy < y + Math.round(h * (fy + fh)); yy++)
      for (let xx = x + Math.round(w * fx0); xx < x + Math.round(w * fx1); xx++) {
        const i = (yy * W + xx) * 3;
        px[i] = px[i + 1] = px[i + 2] = tone;
      }
  };
  bar(0.045, 0.05, 0.12, 0.62, 30); // name
  bar(0.55, 0.035, 0.1, 0.85, 60); // attack text
  bar(0.66, 0.035, 0.1, 0.7, 60);
  bar(0.925, 0.03, 0.06, 0.28, 40); // collector number
  return bufToDataUrl(
    await sharp(px, { raw: { width: W, height: H, channels: 3 } })
      .jpeg({ quality: 95 })
      .toBuffer()
  );
}

let fails = 0;
const check = (name, cond, detail) => {
  console.log(`${name}: ${detail} -> ${cond ? "✓" : "✗ WRONG"}`);
  if (!cond) fails++;
};

// 1. LOOSE shot — card is small and high in the frame (the "cut off reading"
//    scenario: fixed OCR bands would miss name/number). Crop must tighten to
//    the card so the name lands back inside the top 25% band.
{
  const W = 1080;
  const H = 1440;
  const card = { x: 300, y: 140, w: 480, h: 670 }; // aspect 0.716
  const shot = await makeShot(W, H, card);
  const r = await cropToCard(shot);
  let ok = r.cropped;
  let detail = "no crop";
  if (r.cropped) {
    const meta = await sharp(dataUrlToBuffer(r.out)).metadata();
    // Expected: card + 8% margins ≈ 557 x 777, positioned at card - margin
    const tol = 90; // detection is at 96px scale → ~11px/unit tolerance
    ok =
      Math.abs(r.box.x0 - (card.x - card.w * 0.08)) < tol &&
      Math.abs(r.box.y0 - (card.y - card.h * 0.08)) < tol &&
      Math.abs(r.box.x1 - (card.x + card.w * 1.08)) < tol &&
      Math.abs(r.box.y1 - (card.y + card.h * 1.08)) < tol;
    // The name bar must now be inside the top 25% OCR band.
    const nameY = card.y + 670 * 0.045 - r.box.y0;
    ok = ok && nameY / (meta.height || 1) < 0.25;
    // The collector bar must be inside the bottom 32% band.
    const numY = card.y + 670 * 0.925 - r.box.y0;
    ok = ok && numY / (meta.height || 1) > 0.68;
    detail = `box [${r.box.x0},${r.box.y0} → ${r.box.x1},${r.box.y1}], name at ${Math.round((nameY / (meta.height || 1)) * 100)}%, number at ${Math.round((numY / (meta.height || 1)) * 100)}%`;
  }
  check("loose shot tightened to card", ok, detail);
}

// 2. TIGHT shot — card already fills the frame (client cropped well).
//    Must pass through untouched: no wasted re-encode, no double-crop drift.
{
  const W = 900;
  const H = 1240;
  const card = { x: 30, y: 35, w: 840, h: 1170 };
  const shot = await makeShot(W, H, card);
  const r = await cropToCard(shot);
  check("tight shot untouched", !r.cropped, r.cropped ? "was re-cropped" : "passed through");
}

// 3. NO card — plain textured background. Must not invent a crop.
{
  const W = 1080;
  const H = 1440;
  const px = Buffer.alloc(W * H * 3);
  for (let i = 0; i < px.length; i += 3) {
    const v = 100 + (rnd() - 0.5) * 40;
    px[i] = v;
    px[i + 1] = v * 0.8;
    px[i + 2] = v * 0.6;
  }
  const shot = bufToDataUrl(
    await sharp(px, { raw: { width: W, height: H, channels: 3 } }).jpeg().toBuffer()
  );
  const r = await cropToCard(shot);
  check("cardless shot untouched", !r.cropped, r.cropped ? "invented a crop" : "passed through");
}

// 4. Oversized upload — must come back under the OCR.space cap.
{
  const noisy = Buffer.alloc(2600 * 3400 * 3);
  for (let i = 0; i < noisy.length; i++) noisy[i] = rnd() * 255;
  const big = bufToDataUrl(
    await sharp(noisy, { raw: { width: 2600, height: 3400, channels: 3 } })
      .jpeg({ quality: 100 })
      .toBuffer()
  );
  const before = dataUrlToBuffer(big).length;
  const small = await shrinkForOcr(big);
  const after = dataUrlToBuffer(small).length;
  check(
    "oversized upload shrunk under cap",
    before > OCR_MAX_BYTES && after <= OCR_MAX_BYTES,
    `${(before / 1024).toFixed(0)}KB → ${(after / 1024).toFixed(0)}KB`
  );
}

if (fails) {
  console.error(`\n${fails} CHECK(S) FAILED`);
  process.exit(1);
}
console.log("\nCROP CHECKS PASSED");
