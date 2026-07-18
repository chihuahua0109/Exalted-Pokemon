// LIVE end-to-end scan test: builds a synthetic but REAL-TEXT card photo
// (name + HP + collector number), frames it loose and off-center on a wood
// background — the exact "card doesn't fill the shot" case — and posts it to
// /api/scan. Passes when the pipeline (server crop → exposure → OCR → parse →
// TCGplayer match) returns the right Pokémon.
//   node test/livescan.mjs                     → tests production
//   BASE=http://localhost:3000 node test/livescan.mjs
import sharp from "sharp";

const BASE = process.env.BASE || "https://kairos-pokemon.onrender.com";

async function makeCardPhoto() {
  const W = 1080;
  const H = 1440;
  const card = { x: 280, y: 150, w: 480, h: 670 };

  // Wood-ish background with streaks (keeps the crop step honest).
  let seed = 5;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const px = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      const streak = 16 * Math.sin(y * 0.5) + (rnd() - 0.5) * 12;
      px[i] = 118 + streak;
      px[i + 1] = 86 + streak * 0.8;
      px[i + 2] = 56 + streak * 0.6;
    }
  }
  const bg = await sharp(px, { raw: { width: W, height: H, channels: 3 } })
    .jpeg({ quality: 95 })
    .toBuffer();

  // The card itself: light face, border, and real text via SVG.
  const svg = `
  <svg width="${card.w}" height="${card.h}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" rx="18" fill="#f4f2e8" stroke="#c9c39a" stroke-width="10"/>
    <rect x="26" y="88" width="${card.w - 52}" height="330" fill="#9fc4e8" stroke="#5a789a" stroke-width="3"/>
    <text x="34" y="58" font-family="Arial, Helvetica, sans-serif" font-size="44" font-weight="bold" fill="#1c1c1c">Pikachu</text>
    <text x="${card.w - 170}" y="58" font-family="Arial, Helvetica, sans-serif" font-size="38" font-weight="bold" fill="#1c1c1c">HP 60</text>
    <text x="34" y="470" font-family="Arial, Helvetica, sans-serif" font-size="30" font-weight="bold" fill="#222">Gnaw</text>
    <text x="34" y="510" font-family="Arial, Helvetica, sans-serif" font-size="22" fill="#333">Flip a coin. If heads, discard a card.</text>
    <text x="34" y="560" font-family="Arial, Helvetica, sans-serif" font-size="30" font-weight="bold" fill="#222">Thunder Jolt</text>
    <text x="34" y="${card.h - 28}" font-family="Arial, Helvetica, sans-serif" font-size="26" font-weight="bold" fill="#1c1c1c">58/102</text>
  </svg>`;
  const cardImg = await sharp(Buffer.from(svg)).png().toBuffer();

  const shot = await sharp(bg)
    .composite([{ input: cardImg, left: card.x, top: card.y }])
    .jpeg({ quality: 92 })
    .toBuffer();
  return `data:image/jpeg;base64,${shot.toString("base64")}`;
}

const image = await makeCardPhoto();
console.log(`POST ${BASE}/api/scan (payload ${(image.length / 1024).toFixed(0)}KB base64)…`);
const t0 = Date.now();
const res = await fetch(`${BASE}/api/scan`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ image }),
});
const d = await res.json();
const ms = Date.now() - t0;

console.log(
  `→ ${res.status} in ${(ms / 1000).toFixed(1)}s | name="${d.name}" number=${d.number} hp=${d.hp} conf=${d.confidence} products=${d.products?.length ?? 0}`
);
if (d.products?.length) console.log(`   top match: ${d.products[0].name} (${d.products[0].setName ?? "?"})`);

const nameOk = /pikachu/i.test(d.name || "") || /pikachu/i.test(d.products?.[0]?.name || "");
const numOk = String(d.number || "").includes("58/102");
if (!res.ok || !nameOk) {
  console.error(`\nLIVE SCAN FAILED — full response:\n${JSON.stringify(d).slice(0, 1200)}`);
  process.exit(1);
}
console.log(`\nLIVE SCAN PASSED${numOk ? " (name + collector number)" : " (name; number not read)"}`);
