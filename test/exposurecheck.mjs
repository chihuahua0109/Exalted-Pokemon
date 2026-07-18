// Validates the fixExposure preprocessing (server.js) against the installed
// sharp version: dark/shadowed images must come back brighter with more
// contrast; well-lit images must pass through unchanged.
import sharp from "sharp";

const bufToDataUrl = (buf) => `data:image/jpeg;base64,${buf.toString("base64")}`;
const dataUrlToBuffer = (d) => Buffer.from(d.split(",")[1], "base64");

async function fixExposure(dataUrl) {
  const buf = dataUrlToBuffer(dataUrl);
  const st = await sharp(buf).stats();
  const lum = st.channels.slice(0, 3).reduce((s, c) => s + c.mean, 0) / 3;
  const spread = st.channels.slice(0, 3).reduce((s, c) => s + c.stdev, 0) / 3;
  if (lum >= 95 && spread >= 40) return { out: dataUrl, touched: false };
  let img = sharp(buf).normalise({ lower: 1, upper: 99 });
  if (lum < 80) img = img.clahe({ width: 120, height: 168, maxSlope: 3 });
  const out = await img.jpeg({ quality: 93 }).toBuffer();
  return { out: bufToDataUrl(out), touched: true };
}

// Card-ish test image: light rectangle with dark "text" rows on a background.
async function makeCard(bgLevel, cardLevel, textLevel) {
  const W = 480;
  const H = 640;
  const px = Buffer.alloc(W * H * 3, bgLevel);
  const set = (x, y, v) => {
    const i = (y * W + x) * 3;
    px[i] = px[i + 1] = px[i + 2] = v;
  };
  for (let y = 60; y < 580; y++)
    for (let x = 60; x < 420; x++) set(x, y, cardLevel);
  for (const row of [120, 200, 280, 360, 440, 520])
    for (let y = row; y < row + 10; y++)
      for (let x = 90; x < 390; x++) set(x, y, textLevel);
  const buf = await sharp(px, { raw: { width: W, height: H, channels: 3 } })
    .jpeg({ quality: 95 })
    .toBuffer();
  return bufToDataUrl(buf);
}

const stats = async (d) => {
  const st = await sharp(dataUrlToBuffer(d)).stats();
  return {
    lum: st.channels.slice(0, 3).reduce((s, c) => s + c.mean, 0) / 3,
    spread: st.channels.slice(0, 3).reduce((s, c) => s + c.stdev, 0) / 3,
  };
};

let fails = 0;
const check = (name, cond, detail) => {
  console.log(`${name}: ${detail} -> ${cond ? "✓" : "✗ WRONG"}`);
  if (!cond) fails++;
};

// 1. Deep-shadow shot (all tones squashed dark).
const dark = await makeCard(18, 52, 30);
const dBefore = await stats(dark);
const dRes = await fixExposure(dark);
const dAfter = await stats(dRes.out);
check(
  "dark image brightened",
  dRes.touched && dAfter.lum > dBefore.lum + 25 && dAfter.spread > dBefore.spread + 10,
  `lum ${dBefore.lum.toFixed(0)}→${dAfter.lum.toFixed(0)}, spread ${dBefore.spread.toFixed(0)}→${dAfter.spread.toFixed(0)}`
);

// 2. Flat gray shot (partial shadow, low contrast but not pitch dark).
const flat = await makeCard(95, 135, 110);
const fBefore = await stats(flat);
const fRes = await fixExposure(flat);
const fAfter = await stats(fRes.out);
check(
  "flat image contrast-stretched",
  fRes.touched && fAfter.spread > fBefore.spread + 10,
  `spread ${fBefore.spread.toFixed(0)}→${fAfter.spread.toFixed(0)}`
);

// 3. Well-exposed shot must be untouched (no quality loss, no extra work).
const good = await makeCard(70, 215, 40);
const gRes = await fixExposure(good);
check("well-lit image untouched", !gRes.touched, gRes.touched ? "was reprocessed" : "passed through");

if (fails) {
  console.error(`\n${fails} CHECK(S) FAILED`);
  process.exit(1);
}
console.log("\nEXPOSURE CHECKS PASSED");
