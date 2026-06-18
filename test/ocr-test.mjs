import { createWorker } from "tesseract.js";
import sharp from "sharp";

/* ---- mirror of the app's parsing logic (kept in sync manually) ---- */
const STOP_TOKENS = new Set([
  "hp","basic","stage","gx","ex","v","vmax","vstar","vunion","tag","team",
  "pokemon","pokémon","trainer","energy","item","supporter","stadium","tool",
  "ability","ancient","future","weakness","resistance","retreat","damage",
  "evolves","evolution","rule","box","the","and","your","you","opponent","this",
  "that","into","with","when","each","all","may","for","search","deck","attack",
  "card","cards","play","any","ose","from","draw","discard","turn","active",
  "bench","prize","take","flip","coin","put","its","are","his","her","damp","ram",
]);
const cleanWord = (t) => (t || "").replace(/[^A-Za-z'’.\-]/g, "");

function collectWords(data) {
  if (Array.isArray(data.words) && data.words.length) return data.words;
  const out = [];
  const pushLines = (lines) => lines && lines.forEach((l) => l.words && out.push(...l.words));
  const walk = (blocks) =>
    blocks && blocks.forEach((b) => {
      if (b.words) out.push(...b.words);
      pushLines(b.lines);
      b.paragraphs && b.paragraphs.forEach((p) => pushLines(p.lines));
      walk(b.blocks);
    });
  walk(data.blocks);
  return out;
}

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
    (w) => /[A-Za-z]/.test(w.text) && !STOP_TOKENS.has(w.text.toLowerCase()) && w.y < imgH * 0.6
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

function parseOcr(data) {
  const text = data.text || "";
  const numberMatch = text.match(/\b(\d{1,3})\s*\/\s*(\d{1,3})\b/);
  const number = numberMatch ? `${numberMatch[1]}/${numberMatch[2]}` : null;
  const hpMatch = text.match(/\bHP\s*[:\-]?\s*(\d{2,3})\b/i) || text.match(/\b(\d{2,3})\s*HP\b/i);
  const hp = hpMatch ? hpMatch[1] : null;
  const words = collectWords(data);
  let name = nameFromWords(words);
  name = name.replace(/\b[A-Za-z]\b/g, "").replace(/\s+/g, " ").trim();
  return { name, number, hp, wordCount: words.length };
}

/* meanConfidence of all words — used to pick the best rotation */
function meanConf(data) {
  const ws = collectWords(data).filter((w) => cleanWord(w.text).length >= 2);
  if (!ws.length) return 0;
  return ws.reduce((s, w) => s + (w.confidence || 0), 0) / ws.length;
}

const file = process.argv[2] || "./test/psyduck.png";

async function run() {
  const worker = await createWorker("eng");
  for (const angle of [0, 90, 180, 270]) {
    const buf = await sharp(file)
      .rotate(angle)
      .grayscale()
      .normalize()
      .resize({ width: 1500, withoutEnlargement: false })
      .toBuffer();
    const { data } = await worker.recognize(buf, {}, { blocks: true });
    const parsed = parseOcr(data);
    console.log(
      `angle=${String(angle).padStart(3)} | conf=${meanConf(data).toFixed(1).padStart(5)} | name="${parsed.name}" | number=${parsed.number} | hp=${parsed.hp} | words=${parsed.wordCount}`
    );
  }
  await worker.terminate();
}
run();
