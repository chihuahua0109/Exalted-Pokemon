import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { readFile, writeFile, mkdir, rename } from "fs/promises";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { randomUUID, randomBytes, scryptSync, timingSafeEqual } from "crypto";
import { networkInterfaces } from "os";
import http from "http";
import https from "https";
import selfsigned from "selfsigned";
import sharp from "sharp";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 3000;

// CORS — the packaged mobile app calls this API from capacitor://localhost
// (a different origin). Auth uses Bearer tokens (not cookies), so allowing any
// origin is safe here.
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: "15mb" }));
app.use(express.static(join(__dirname, "public")));

/* ------------------------------------------------------------------ *
 * TCGplayer proxy
 * The public marketplace search API only allows the tcgplayer.com
 * origin, so the browser cannot call it directly. We proxy it here
 * server-side (no auth/cookies required) and normalize the response.
 * ------------------------------------------------------------------ */

const SEARCH_URL =
  "https://mp-search-api.tcgplayer.com/v1/search/request?q=%Q%&isList=false&mpfev=5258";
const IMG = (id, size = "200x200") =>
  `https://tcgplayer-cdn.tcgplayer.com/product/${id}_in_${size}.jpg`;

const TCG_HEADERS = {
  "content-type": "application/json",
  accept: "application/json, text/plain, */*",
  origin: "https://www.tcgplayer.com",
  referer: "https://www.tcgplayer.com/",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
};

function searchBody(query, { from = 0, size = 24 } = {}) {
  return JSON.stringify({
    algorithm: "sales_dismax",
    from,
    size,
    query,
    filters: {
      term: { productLineName: ["pokemon"] },
      range: {},
      match: {},
    },
    context: { cart: {}, shippingCountry: "US", userProfile: {} },
    settings: { useFuzzySearch: true, didYouMean: {} },
    sort: {},
  });
}

function normalize(p) {
  const id = Math.round(p.productId);
  const attrs = p.customAttributes || {};
  return {
    productId: id,
    name: p.productName,
    set: p.setName,
    setUrlName: p.setUrlName,
    number: attrs.number || null,
    rarity: p.rarityName || null,
    productLine: p.productLineName || "Pokemon",
    sealed: !!p.sealed,
    marketPrice: p.marketPrice ?? null,
    medianPrice: p.medianPrice ?? null,
    lowestPrice: p.lowestPrice ?? null,
    lowestPriceWithShipping: p.lowestPriceWithShipping ?? null,
    totalListings: p.totalListings ? Math.round(p.totalListings) : 0,
    image: IMG(id, "200x200"),
    imageLarge: IMG(id, "1000x1000"),
    url: `https://www.tcgplayer.com/product/${id}`,
    attributes: {
      hp: attrs.hp || null,
      stage: attrs.stage || null,
      cardType: Array.isArray(attrs.cardType) ? attrs.cardType.flat().filter(Boolean) : [],
      energyType: Array.isArray(attrs.energyType) ? attrs.energyType.flat().filter(Boolean) : [],
      weakness: attrs.weakness || null,
      resistance: attrs.resistance || null,
      retreatCost: attrs.retreatCost || null,
      releaseDate: attrs.releaseDate || null,
      attacks: [attrs.attack1, attrs.attack2, attrs.attack3, attrs.attack4].filter(Boolean),
      flavorText: attrs.flavorText || null,
    },
  };
}

async function tcgSearch(query, opts = {}) {
  const url = SEARCH_URL.replace("%Q%", encodeURIComponent(query));
  const res = await fetch(url, {
    method: "POST",
    headers: TCG_HEADERS,
    body: searchBody(query, opts),
  });
  if (!res.ok) {
    throw new Error(`TCGplayer responded ${res.status}`);
  }
  const data = await res.json();
  const block = data?.results?.[0] || {};
  const products = (block.results || []).map(normalize);
  return { total: block.totalResults ?? products.length, products };
}

app.get("/api/search", async (req, res) => {
  const q = (req.query.q || "").toString().trim();
  if (!q) return res.json({ total: 0, products: [] });
  const page = Math.max(0, parseInt(req.query.page) || 0);
  try {
    const out = await tcgSearch(q, { from: page * 24, size: 24 });
    res.json(out);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Look up a single product (used to refresh a price by id+name)
app.get("/api/product/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  const q = (req.query.q || "").toString().trim();
  try {
    const { products } = await tcgSearch(q || String(id), { size: 50 });
    const match = products.find((p) => p.productId === id);
    if (!match) return res.status(404).json({ error: "Not found" });
    res.json(match);
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/* ------------------------------------------------------------------ *
 * Card scanning (cloud OCR via OCR.space) + matching
 * The key stays server-side. Set OCRSPACE_API_KEY for your own free key
 * (https://ocr.space/ocrapi/freekey); falls back to the shared demo key.
 * ------------------------------------------------------------------ */

// OCR.space free keys reject CONCURRENT and bursty calls — exactly what
// auto-capturing a stack of cards produces. All OCR calls flow through this
// single-file queue with a minimum gap, so a burst of scans is smoothed into
// a steady trickle the API accepts. (Scans still feel fast: the gap is small
// compared to the OCR round-trip itself.)
let ocrChain = Promise.resolve();
let lastOcrAt = 0;
const OCR_GAP_MS = 450;
function ocrThrottled(fn) {
  const run = ocrChain.then(async () => {
    const wait = lastOcrAt + OCR_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      return await fn();
    } finally {
      lastOcrAt = Date.now();
    }
  });
  ocrChain = run.catch(() => {});
  return run;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ocrSpace(dataUrl, engine = "2", retried = false) {
  const key = process.env.OCRSPACE_API_KEY || "helloworld";
  const data = await ocrThrottled(async () => {
    const body = new URLSearchParams();
    body.set("base64Image", dataUrl);
    body.set("OCREngine", engine);
    body.set("scale", "true");
    body.set("language", "eng");
    body.set("isOverlayRequired", "false");
    const res = await fetch("https://api.ocr.space/parse/image", {
      method: "POST",
      headers: { apikey: key, "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    return res.json();
  });
  // Rate-limit response has a top-level "error" string (not IsErroredOnProcessing).
  if (data.error) {
    // Per-minute burst limits clear quickly — one spaced retry usually lands.
    if (!retried) {
      await sleep(1600);
      return ocrSpace(dataUrl, engine, true);
    }
    const err = new Error(data.error);
    err.rateLimited = true;
    err.retryAfter = data.retryAfter || 3600;
    throw err;
  }
  if (data.IsErroredOnProcessing) {
    throw new Error(
      (Array.isArray(data.ErrorMessage) ? data.ErrorMessage[0] : data.ErrorMessage) ||
        "OCR failed"
    );
  }
  return data?.ParsedResults?.[0]?.ParsedText || "";
}

function dataUrlToBuffer(dataUrl) {
  const m = dataUrl.match(/^data:.*?;base64,(.*)$/s);
  if (!m) throw new Error("invalid image data");
  return Buffer.from(m[1], "base64");
}

function bufToDataUrl(buf, mime = "image/jpeg") {
  return `data:${mime};base64,${buf.toString("base64")}`;
}

async function ocrBuffer(buf, engine) {
  return ocrSpace(bufToDataUrl(buf), engine);
}

// A name is valid when it has at least one word with 4+ real letters.
// This filters garbage like "Dil", "LY We", "am nf".
function isValidName(name) {
  if (!name) return false;
  const letters = (name.match(/[A-Za-z]/g) || []).length;
  if (letters < 4) return false;
  return name.split(/\s+/).some((w) => (w.match(/[A-Za-z]/g) || []).length >= 4);
}

// Apply a mild unsharp mask to improve OCR on slightly blurry captures.
// We keep it subtle to avoid garbling foil/holo text.
async function sharpenForOcr(dataUrl) {
  try {
    const buf = await sharp(dataUrlToBuffer(dataUrl))
      .rotate()
      .sharpen({ sigma: 1.2, m1: 1.0, m2: 2.0 })
      .jpeg({ quality: 93 })
      .toBuffer();
    return bufToDataUrl(buf);
  } catch {
    return dataUrl; // fall back to original on any error
  }
}

// OCR strategy — minimal API calls to avoid rate-limit burns on the free key:
//  1. Engine-2 full image (handles most cases in 1 call).
//  2. Only if name OR number is missing: one more targeted call on the missing region.
//  Never exceeds 2 total OCR calls.
// Wrap an OCR call so genuine failures return "" but rate-limit errors propagate.
async function ocrSafe(input, engine) {
  try {
    return typeof input === "string"
      ? await ocrSpace(input, engine)
      : await ocrBuffer(input, engine);
  } catch (e) {
    if (e.rateLimited) throw e; // let the endpoint surface a friendly message
    return "";
  }
}

// Shadowed / underexposed shots: lift exposure BEFORE OCR sees the image.
// A histogram stretch fixes global darkness; CLAHE (local equalization)
// recovers text under a shadow falling across part of the card. Only applied
// when the image is actually dark or flat — clean shots pass through as-is.
async function fixExposure(dataUrl) {
  try {
    const buf = dataUrlToBuffer(dataUrl);
    const st = await sharp(buf).stats();
    const lum = st.channels.slice(0, 3).reduce((s, c) => s + c.mean, 0) / 3;
    const spread = st.channels.slice(0, 3).reduce((s, c) => s + c.stdev, 0) / 3;
    if (lum >= 95 && spread >= 40) return dataUrl; // well exposed already
    let img = sharp(buf).normalise({ lower: 1, upper: 99 });
    if (lum < 80) img = img.clahe({ width: 120, height: 168, maxSlope: 3 });
    const out = await img.jpeg({ quality: 93 }).toBuffer();
    return bufToDataUrl(out);
  } catch {
    return dataUrl;
  }
}

async function ocrCardRegions(dataUrl) {
  // Primary pass: engine 2, exposure-corrected (no-op for well-lit shots).
  dataUrl = await fixExposure(dataUrl);
  const fullText = await ocrSafe(dataUrl, "2");
  const primary = parseCardText(fullText);

  if (isValidName(primary.name) && primary.number) {
    return { fullText, nameText: "", numText: "" };
  }

  // Fallback: the primary pass came up short (often a blurry/handheld shot).
  // Sharpen now, since unsharp-mask helps recover soft text.
  const processedUrl = await sharpenForOcr(dataUrl);
  const baseBuf = await sharp(dataUrlToBuffer(processedUrl)).jpeg().toBuffer();
  const { width: w = 800, height: h = 1100 } = await sharp(baseBuf).metadata();

  let fallbackText = "";
  if (!isValidName(primary.name)) {
    // Top band: BASIC label + name + HP.  Use a conservative 25% crop so the
    // name stays in frame even when the card doesn't fill the whole image.
    const nameH = Math.max(60, Math.round(h * 0.25));
    const buf = await sharp(baseBuf)
      .extract({ left: 0, top: 0, width: w, height: nameH })
      .resize({ width: 1600, withoutEnlargement: false })
      .grayscale()
      .normalize()
      .jpeg({ quality: 95 })
      .toBuffer();
    fallbackText = await ocrSafe(buf, "2");
  } else if (!primary.number) {
    // Bottom band: collector number. Use a generous 32% crop + high res + contrast
    // boost so the small number (e.g. 039/217) is legible even with framing margin.
    const numTop = Math.max(0, Math.round(h * 0.68));
    const buf = await sharp(baseBuf)
      .extract({ left: 0, top: numTop, width: w, height: h - numTop })
      .resize({ width: 1600, withoutEnlargement: false })
      .grayscale()
      .normalize()
      .jpeg({ quality: 95 })
      .toBuffer();
    fallbackText = await ocrSafe(buf, "2");
  }

  return { fullText, nameText: fallbackText, numText: "" };
}

function mergeParsed(fullParsed, nameParsed, numParsed) {
  // Best valid name: prefer fallback crop (usually tighter / cleaner for name),
  // then full-image result.
  const nameCands = [nameParsed.name, fullParsed.name].filter(isValidName);
  nameCands.sort((a, b) => {
    // Prefer shorter (1-3 word) Pokémon-style names.
    const wa = a.split(/\s+/).length;
    const wb = b.split(/\s+/).length;
    if (wa <= 3 && wb > 3) return -1;
    if (wb <= 3 && wa > 3) return 1;
    return a.length - b.length; // shorter name wins on tie
  });
  const name = nameCands[0] || "";

  const number = numParsed.number || fullParsed.number || nameParsed.number || null;
  const hp = fullParsed.hp || nameParsed.hp || numParsed.hp || null;

  // Pool every other name guess as a fallback for weak matches.
  const altNames = [
    ...nameCands.slice(1),
    ...(nameParsed.altNames || []),
    ...(fullParsed.altNames || []),
  ].filter((n, i, arr) => n && n !== name && arr.indexOf(n) === i);

  return { name, number, hp, altNames };
}

const STAGE_RE =
  /^(basic|stage\s*\d|stage|vmax|vstar|mega|gx|ex|tag\s*team|ancient|future|item|tool|supporter|stadium|special\s*energy|basic\s*energy|trainer)$/i;
const NOISE_RE =
  /^(no\.|illus|©|ability|weakness|resistance|retreat|pok[eé]mon in play|nintendo|creatures|game\s*freak|evolves|upload|retake|capture|search|detected|photo|reading|matching)/i;

function parseCardText(text) {
  const lines = (text || "").split("\n").map((l) => l.trim()).filter(Boolean);
  // Collector number like 039/217. OCR may append the set-symbol as a stray digit
  // (e.g. "039/2170") or use a fraction slash, so don't require a trailing boundary
  // and clamp each side to 3 digits.
  const numMatch = text.match(/(\d{1,3})\s*[\/\u2044]\s*(\d{2,4})/);
  let number = null;
  if (numMatch) {
    const left = numMatch[1];
    let right = numMatch[2];
    if (right.length === 4) right = right.slice(0, 3); // drop stray trailing digit
    number = `${left}/${right}`;
  }
  const hpMatch =
    text.match(/\bHP\s*[:\-]?\s*(\d{2,3})\b/i) || text.match(/\b(\d{2,3})\s*HP\b/i);
  const hp = hpMatch ? hpMatch[1] : null;

  const cands = [];
  lines.forEach((line, idx) => {
    const l = line.replace(/\bHP\s*\d+\b/i, "").trim();
    const letters = (l.match(/[A-Za-z]/g) || []).length;
    const words = l.split(/\s+/).filter(Boolean);
    // Require at least one word with 4+ letters (filters garbage like "Dil", "am nf", "LY We").
    const hasRealWord = words.some((w) => (w.match(/[A-Za-z]/g) || []).length >= 4);
    if (letters < 3 || !hasRealWord || words.length > 5 || STAGE_RE.test(l) || NOISE_RE.test(l)) return;
    // An ability's NAME sits next to the "Ability" label (e.g. "Ability  Damp").
    // Never treat it (or the line right after the label) as the card name.
    if (/\babilit/i.test(line)) return;
    if (idx > 0 && /\babilit/i.test(lines[idx - 1])) return;
    let score = 0;
    // Position: name appears early.
    if (idx < 8) score += Math.max(0, 8 - idx);
    // Line right after a BASIC/Stage label is almost certainly the name.
    if (idx > 0 && STAGE_RE.test(lines[idx - 1].trim())) score += 10;
    // Line adjacent to an HP value.
    if (idx > 0 && /HP\s*\d+/i.test(lines[idx - 1])) score += 3;
    if (idx + 1 < lines.length && /HP\s*\d+/i.test(lines[idx + 1])) score += 5;
    // Word-count sweet spot: 1-3 words = Pokémon name.
    score += Math.max(0, 4 - Math.abs(words.length - 1));
    // Strong reward for short capitalised names (Psyduck, Charizard ex, etc.).
    if (/^[A-Z][a-z]/.test(l) && words.length <= 3) score += 6;
    // Penalise sentence-like text.
    if (/[.!?,]/.test(l)) score -= 3;
    if (/\d{1,3}\/\d{1,3}/.test(l)) score -= 6;
    if (words.length >= 4) score -= 2;
    cands.push({ text: l, score });
  });
  cands.sort((a, b) => b.score - a.score);
  const clean = (s) => {
    const n = (s || "")
      .replace(/[^A-Za-z0-9'’.\- ]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    // OCR often glues the suffix onto the name (e.g. "Pikachuex", "CharizardVMAX").
    // Re-introduce the space so the TCGplayer search matches the printed form.
    return n.replace(
      /([a-z])(ex|EX|GX|V|VMAX|VSTAR|VUNION)\b/,
      (_, base, suf) => `${base} ${suf.toLowerCase() === "ex" ? "ex" : suf.toUpperCase()}`
    );
  };
  const name = clean(cands[0]?.text);
  // Runner-up guesses, tried when the top pick produces a weak match.
  const altNames = cands
    .slice(1, 4)
    .map((c) => clean(c.text))
    .filter((n) => n && n !== name);
  return { name, number, hp, altNames };
}

/* ---- Optional AI vision (used when a key is configured) ---- */

function parseAiJson(txt) {
  if (!txt) return null;
  const m = txt.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    const norm = (v) => (v == null || v === "" || /^null$/i.test(v) ? null : String(v).trim());
    const numRaw = norm(o.number);
    const numM = numRaw && numRaw.match(/(\d{1,3})\s*\/\s*(\d{1,3})/);
    return {
      name: norm(o.name) || "",
      set: norm(o.set),
      number: numM ? `${numM[1]}/${numM[2]}` : numRaw,
      hp: norm(o.hp) ? String(o.hp).replace(/\D/g, "") || null : null,
    };
  } catch {
    return null;
  }
}

const AI_PROMPT =
  'Identify this Pokemon Trading Card Game card from the image. Respond with ONLY compact JSON ' +
  'and nothing else: {"name":string,"set":string|null,"number":string|null,"hp":string|null}. ' +
  '"name" is the card name exactly as printed including any suffix such as ex, V, VMAX, VSTAR, GX. ' +
  '"number" is the small collector number like "039/217" if visible. If unsure use null.';

async function aiVisionOpenAI(dataUrl) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: process.env.OPENAI_VISION_MODEL || "gpt-4o-mini",
      temperature: 0,
      max_tokens: 150,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: AI_PROMPT },
            { type: "image_url", image_url: { url: dataUrl } },
          ],
        },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}`);
  const d = await res.json();
  return parseAiJson(d?.choices?.[0]?.message?.content || "");
}

async function aiVisionGemini(dataUrl) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return null;
  const m = dataUrl.match(/^data:(.*?);base64,(.*)$/);
  if (!m) return null;
  const model = process.env.GEMINI_VISION_MODEL || "gemini-1.5-flash";
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [
          { parts: [{ text: AI_PROMPT }, { inline_data: { mime_type: m[1], data: m[2] } }] },
        ],
        generationConfig: { temperature: 0 },
      }),
    }
  );
  if (!res.ok) throw new Error(`Gemini ${res.status}`);
  const d = await res.json();
  const txt = d?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";
  return parseAiJson(txt);
}

async function aiVision(dataUrl) {
  if (process.env.OPENAI_API_KEY) return aiVisionOpenAI(dataUrl);
  if (process.env.GEMINI_API_KEY) return aiVisionGemini(dataUrl);
  return null;
}

/* ---- Species dictionary (all Pokémon names) ---- */
// Knowing every species name turns "which card is this" from guesswork into a
// lookup: if any OCR line contains a real species, that's the card's Pokémon.
// Fetched once from PokeAPI and cached (memory + disk).

const SPECIES_FILE = () => join(DATA_DIR, "species.json");
let speciesSet = null;
let speciesArr = null; // for fuzzy scans
const normSpecies = (s) => (s || "").toLowerCase().replace(/[^a-z]/g, "");

async function loadSpecies() {
  if (speciesSet) return speciesSet;
  try {
    const cached = JSON.parse(await readFile(SPECIES_FILE(), "utf8"));
    if (Array.isArray(cached) && cached.length > 800) {
      speciesSet = new Set(cached);
      speciesArr = [...speciesSet];
      return speciesSet;
    }
  } catch { /* no cache yet */ }
  try {
    const r = await fetch("https://pokeapi.co/api/v2/pokemon-species?limit=2000");
    const d = await r.json();
    const names = (d.results || []).map((x) => normSpecies(x.name)).filter(Boolean);
    if (names.length > 800) {
      speciesSet = new Set(names);
      speciesArr = [...speciesSet];
      mkdir(DATA_DIR, { recursive: true })
        .then(() => writeFile(SPECIES_FILE(), JSON.stringify([...speciesSet])))
        .catch(() => {});
      return speciesSet;
    }
  } catch { /* offline — feature quietly disabled */ }
  return null;
}

// Levenshtein distance <= 1 (one substitution, insertion or deletion).
// OCR's classic failure mode is a single wrong character ("Giaceon").
function editDist1(a, b) {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (la === lb) { i++; j++; }
    else if (la > lb) i++;
    else j++;
  }
  return edits + (la - i) + (lb - j) <= 1;
}

// Card keywords that must never fuzzy-match a species name.
const CARD_WORDS = new Set([
  "basic", "stage", "trainer", "energy", "weakness", "resistance", "retreat",
  "pokemon", "pokémon", "evolves", "ability", "damage", "attack", "water",
  "fire", "grass", "psychic", "fighting", "darkness", "metal", "dragon",
  "fairy", "colorless", "lightning", "illustrator", "rare", "holo",
]);

function fuzzySpecies(word) {
  if (!speciesArr || word.length < 5 || CARD_WORDS.has(word)) return null;
  for (const sp of speciesArr) {
    if (Math.abs(sp.length - word.length) <= 1 && editDist1(word, sp)) return sp;
  }
  return null;
}

const NAME_SUFFIX_RE = /^(ex|gx|v|vmax|vstar|vunion)$/i;

// Find the first real species name in the OCR text (top lines first — that's
// where the card name lives). Returns { species, name } where name includes
// any suffix printed after it (e.g. "Glaceon V").
async function detectSpecies(text) {
  const set = await loadSpecies();
  if (!set || !text) return null;
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    // "Evolves from Eevee" and ability rows name OTHER Pokémon — skip them.
    if (/evolves|abilit/i.test(line)) continue;
    const words = line.split(/[^A-Za-z'’.-]+/).filter((w) => w.length >= 2);
    for (let j = 0; j < words.length; j++) {
      const w1 = normSpecies(words[j]);
      if (!w1) continue;
      const w2 = j + 1 < words.length ? w1 + normSpecies(words[j + 1]) : null;

      // Two-word species ("Tapu Koko"), single word, or a glued suffix
      // ("GlaceonV", "CharizardEX") — OCR produces all three.
      if (w2 && set.has(w2)) {
        const next = words[j + 2];
        const base = `${words[j]} ${words[j + 1]}`;
        return {
          species: w2,
          name: next && NAME_SUFFIX_RE.test(next) ? `${base} ${fixSuffix(next)}` : base,
        };
      }
      if (w1.length >= 4 && set.has(w1)) {
        const next = words[j + 1];
        return {
          species: w1,
          name: next && NAME_SUFFIX_RE.test(next) ? `${words[j]} ${fixSuffix(next)}` : words[j],
        };
      }
      const glued = w1.match(/^([a-z'.-]+?)(ex|gx|vmax|vstar|vunion|v)$/);
      if (glued && glued[1].length >= 4 && set.has(glued[1])) {
        return { species: glued[1], name: `${cap(glued[1])} ${fixSuffix(glued[2])}` };
      }
    }
  }

  // Second pass: no exact hit anywhere, so allow a single OCR misread
  // ("Giaceon" → "glaceon"). Only the top lines, where the name lives.
  for (const line of lines.slice(0, 8)) {
    if (/evolves|abilit/i.test(line)) continue;
    for (const raw of line.split(/[^A-Za-z'’.-]+/)) {
      const w = normSpecies(raw);
      let hit = fuzzySpecies(w);
      if (!hit) {
        const glued = w.match(/^([a-z'.-]+?)(ex|gx|vmax|vstar|vunion|v)$/);
        if (glued) hit = fuzzySpecies(glued[1]);
        if (hit) return { species: hit, name: `${cap(hit)} ${fixSuffix(glued[2])}` };
      } else {
        return { species: hit, name: cap(hit) };
      }
    }
  }
  return null;
}
const fixSuffix = (s) => (s.toLowerCase() === "ex" ? "ex" : s.toUpperCase());
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/* ---- Matching / ranking ---- */

function normName(s) {
  return (s || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}
// token overlap similarity (0..1)
function nameSim(a, b) {
  const ta = new Set(normName(a).split(" ").filter(Boolean));
  const tb = new Set(normName(b).split(" ").filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / Math.max(ta.size, tb.size);
}

// "011/086", "11/86" and "11 / 86" are the same collector number.
function normCollector(n) {
  return String(n)
    .replace(/\s+/g, "")
    .split("/")
    .map((part) => part.replace(/^0+(?=.)/, ""))
    .join("/");
}

function scoreProduct(p, parsed) {
  let s = 0;
  const num = parsed.number;
  if (num && p.number) {
    const pn = p.number.replace(/\s+/g, "");
    if (pn === num || normCollector(pn) === normCollector(num)) s += 120;
    else if (normCollector(pn).split("/")[0] === normCollector(num).split("/")[0]) s += 40;
  }
  // Species is decisive: a product for a different Pokémon is simply wrong,
  // no matter how well the number or HP happen to line up.
  if (parsed.species) {
    if (normSpecies(p.name).includes(parsed.species)) s += 45;
    else s -= 70;
  }
  s += nameSim(parsed.name, p.name) * 40;
  // Substring boost — OCR often drops a trailing letter (e.g. "Charizar" instead
  // of "Charizard"); this still finds the right product.
  const np = normName(parsed.name);
  const pp = normName(p.name);
  if (np && pp && np.length >= 4 && (pp.includes(np) || np.includes(pp))) s += 25;
  if (parsed.set && p.set) s += nameSim(parsed.set, p.set) * 20;
  // HP is the strongest signal when no collector number was read.
  if (parsed.hp && p.attributes) {
    const match = String(p.attributes.hp) === String(parsed.hp);
    s += match ? (parsed.number ? 15 : 60) : (parsed.number ? 0 : -20);
  }
  return s;
}

function rankProducts(products, parsed) {
  const scored = products
    .map((p) => ({ p, s: scoreProduct(p, parsed) }))
    .sort((a, b) => b.s - a.s);
  // confidence: best score scaled (number match alone ~ high confidence)
  const best = scored[0]?.s || 0;
  const confidence = Math.max(0, Math.min(1, best / 140));
  return { products: scored.map((x) => x.p), confidence };
}

app.post("/api/scan", async (req, res) => {
  const img = req.body?.image;
  if (!img) return res.status(400).json({ error: "image required" });
  try {
    let parsed = null;
    let source = "ocr";
    let text = "";
    try {
      const ai = await aiVision(img);
      if (ai && ai.name) {
        parsed = ai;
        source = "ai";
      }
    } catch {
      /* fall back to OCR */
    }

    let rateLimited = false;
    try {
      const { fullText, nameText, numText } = await ocrCardRegions(img);
      text = [fullText, nameText, numText].filter(Boolean).join("\n---\n");
      const ocrParsed = mergeParsed(
        parseCardText(fullText),
        parseCardText(nameText),
        parseCardText(numText)
      );
      if (!parsed) parsed = ocrParsed;
      else {
        if (!parsed.number && ocrParsed.number) parsed.number = ocrParsed.number;
        if (!parsed.hp && ocrParsed.hp) parsed.hp = ocrParsed.hp;
        if (!parsed.name && ocrParsed.name) parsed.name = ocrParsed.name;
      }
    } catch (ocrErr) {
      if (ocrErr.rateLimited) {
        rateLimited = true;
        if (!parsed) parsed = { name: "", number: null, hp: null };
      } else {
        throw ocrErr;
      }
    }

    // Cross-check against the full Pokémon species list. If a real species
    // appears in the OCR text, it IS the card's Pokémon — override whatever
    // line-scoring guessed (fixes e.g. Glaceon V matching as Kyogre).
    try {
      const sp = await detectSpecies(text);
      if (sp) {
        parsed.species = sp.species;
        if (!normSpecies(parsed.name).includes(sp.species)) {
          if (parsed.name) parsed.altNames = [parsed.name, ...(parsed.altNames || [])];
          parsed.name = sp.name;
        }
      }
    } catch { /* best-effort */ }

    let products = [];
    const attempts = [];
    if (parsed.name && parsed.number) attempts.push(`${parsed.name} ${parsed.number}`);
    if (parsed.name && parsed.set) attempts.push(`${parsed.name} ${parsed.set}`);
    if (parsed.name) attempts.push(parsed.name);
    // Name was unreadable but we got a collector number — search by number alone.
    // TCGplayer indexes the printed number, so "39/217" will surface candidates.
    if (!parsed.name && parsed.number) attempts.push(parsed.number);

    for (const q of attempts) {
      // TCGplayer caps page size around 24 — larger values return HTTP 400.
      ({ products } = await tcgSearch(q, { size: 24 }));
      // For a name-only query, pull a second page so rarer printings are included.
      if (!parsed.number) {
        try {
          const page2 = await tcgSearch(q, { from: 24, size: 24 });
          if (page2.products?.length) products = products.concat(page2.products);
        } catch { /* page 2 optional */ }
      }
      if (products.length) break;
    }
    let ranked = rankProducts(products, parsed);

    // Weak match? The "name" was probably an ability/attack or OCR garbage.
    // Retry with the runner-up name guesses and keep whichever scores best.
    if (ranked.confidence < 0.35 && parsed.altNames?.length) {
      for (const alt of parsed.altNames.slice(0, 2)) {
        try {
          const { products: altProducts } = await tcgSearch(
            parsed.number ? `${alt} ${parsed.number}` : alt,
            { size: 24 }
          );
          if (!altProducts.length) continue;
          const altRanked = rankProducts(altProducts, { ...parsed, name: alt });
          if (altRanked.confidence > ranked.confidence + 0.1) {
            ranked = altRanked;
            parsed.name = alt;
          }
        } catch { /* alt guesses are best-effort */ }
        if (ranked.confidence >= 0.5) break;
      }
    }

    res.json({ ...parsed, source, text, rateLimited, products: ranked.products, confidence: ranked.confidence });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/* ------------------------------------------------------------------ *
 * Persistence — two backends behind the same functions:
 *   1. MongoDB (set MONGODB_URI) — survives restarts/redeploys; required
 *      for real persistence on cloud hosts with ephemeral filesystems
 *      (e.g. Render free tier). MongoDB Atlas free tier works great.
 *   2. Flat JSON files under DATA_DIR — local dev fallback.
 * ------------------------------------------------------------------ */

// DATA_DIR can point at a mounted persistent disk on a cloud host so user
// accounts/inventory survive restarts (e.g. DATA_DIR=/data on Render).
const DATA_DIR = process.env.DATA_DIR || join(__dirname, "data");
const LEGACY_DB_FILE = join(DATA_DIR, "inventory.json");
const USERS_FILE = join(DATA_DIR, "users.json");
const SESSIONS_FILE = join(DATA_DIR, "sessions.json");
const USER_DATA_DIR = join(DATA_DIR, "users");

let mongo = null; // { users, sessions, userdata } collections when connected
// In-memory session cache. With Mongo connected the DB is the source of truth
// (read-through on cache miss); without it, a JSON file backs the cache.
let sessions = {};

async function connectMongo() {
  const { MongoClient } = await import("mongodb");
  for (let attempt = 1; ; attempt++) {
    try {
      const client = new MongoClient(process.env.MONGODB_URI, {
        serverSelectionTimeoutMS: 10000,
      });
      await client.connect();
      const mdb = client.db(process.env.MONGODB_DB || "kairos");
      const m = {
        users: mdb.collection("users"),
        sessions: mdb.collection("sessions"),
        userdata: mdb.collection("userdata"),
      };
      await m.users.createIndex({ username: 1 }, { unique: true }).catch(() => {});
      await m.sessions.createIndex({ token: 1 }, { unique: true }).catch(() => {});
      await m.userdata.createIndex({ userId: 1 }, { unique: true }).catch(() => {});
      // Warm the session cache so existing logins survive the restart.
      for (const s of await m.sessions.find().toArray()) {
        sessions[s.token] = { userId: s.userId, createdAt: s.createdAt };
      }
      mongo = m;
      console.log("  🗄  MongoDB connected — accounts & collections persist");
      return;
    } catch (err) {
      // Never downgrade silently to wiped-on-restart file storage: keep
      // retrying in the background until Atlas answers.
      console.error(`  ⚠ MongoDB connect attempt ${attempt} failed: ${err.message} — retrying in 15s`);
      await new Promise((r) => setTimeout(r, 15000));
    }
  }
}

if (process.env.MONGODB_URI) {
  // Give Atlas a moment at boot, but don't block startup forever — the retry
  // loop keeps going in the background if it's slow.
  await Promise.race([connectMongo(), new Promise((r) => setTimeout(r, 12000))]);
}
if (!mongo) {
  try {
    sessions = JSON.parse(readFileSync(SESSIONS_FILE, "utf8"));
  } catch {
    sessions = {};
  }
}

/* ------------------------------------------------------------------ *
 * Authentication: local accounts, scrypt-hashed passwords, bearer
 * tokens. Sessions persist so users stay logged in across restarts.
 * ------------------------------------------------------------------ */

async function loadUsers() {
  if (mongo) return mongo.users.find({}, { projection: { _id: 0 } }).toArray();
  try {
    return JSON.parse(await readFile(USERS_FILE, "utf8"));
  } catch {
    return [];
  }
}
async function addUser(user) {
  if (mongo) {
    await mongo.users.insertOne({ ...user });
    return;
  }
  const users = await loadUsers();
  users.push(user);
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(USERS_FILE, JSON.stringify(users, null, 2));
}

function addSession(token, userId) {
  sessions[token] = { userId, createdAt: Date.now() };
  if (mongo) {
    mongo.sessions
      .updateOne({ token }, { $set: { token, userId, createdAt: Date.now() } }, { upsert: true })
      .catch((e) => console.error("session save failed:", e.message));
  } else {
    persistSessionsFile();
  }
}
function removeSession(token) {
  delete sessions[token];
  if (mongo) {
    mongo.sessions.deleteOne({ token }).catch(() => {});
  } else {
    persistSessionsFile();
  }
}
function persistSessionsFile() {
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(SESSIONS_FILE, JSON.stringify(sessions));
  } catch {
    /* non-fatal */
  }
}

function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  const hash = scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  const candidate = scryptSync(password, salt, 64).toString("hex");
  const a = Buffer.from(candidate, "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
const newToken = () => randomBytes(32).toString("hex");

function tokenFrom(req) {
  const h = req.headers.authorization || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}
async function authUserId(req) {
  const t = tokenFrom(req);
  if (!t) return null;
  if (sessions[t]) return sessions[t].userId;
  // Cache miss — the token may live in Mongo (issued before a restart or by
  // another instance). Read through so logins survive server restarts.
  if (mongo) {
    try {
      const s = await mongo.sessions.findOne({ token: t });
      if (s) {
        sessions[t] = { userId: s.userId, createdAt: s.createdAt };
        return s.userId;
      }
    } catch {
      /* treat as signed out on DB hiccup */
    }
  }
  return null;
}
async function requireAuth(req, res, next) {
  const uid = await authUserId(req);
  if (!uid) return res.status(401).json({ error: "Sign in required" });
  req.userId = uid;
  next();
}

/* ---------------- Per-user inventory store ---------------- */

const userDbFile = (userId) => join(USER_DATA_DIR, `${userId}.json`);

async function loadDb(userId) {
  let db;
  if (mongo) {
    db = (await mongo.userdata.findOne({ userId }, { projection: { _id: 0 } })) || {};
  } else {
    try {
      db = JSON.parse(await readFile(userDbFile(userId), "utf8"));
    } catch {
      db = {};
    }
  }
  if (!Array.isArray(db.items)) db.items = [];
  if (!Array.isArray(db.wishlist)) db.wishlist = [];
  if (!Array.isArray(db.history)) db.history = [];
  if (!Array.isArray(db.groups)) db.groups = []; // user-defined collection groups
  return db;
}

// Record today's total collection value into db.history (one point per day).
// Powers the "value over time" chart on the Market screen.
function recordHistory(db) {
  const value =
    Math.round(
      db.items.reduce((s, i) => s + (i.marketPrice || 0) * (i.quantity || 1), 0) * 100
    ) / 100;
  const today = new Date().toISOString().slice(0, 10);
  if (!Array.isArray(db.history)) db.history = [];
  const last = db.history[db.history.length - 1];
  if (last && last.d === today) last.v = value;
  else db.history.push({ d: today, v: value });
  if (db.history.length > 730) db.history = db.history.slice(-730); // ~2 years
}

async function saveDb(userId, db) {
  recordHistory(db);
  if (mongo) {
    await mongo.userdata.updateOne(
      { userId },
      {
        $set: {
          userId,
          items: db.items,
          wishlist: db.wishlist,
          history: db.history,
          groups: db.groups,
        },
      },
      { upsert: true }
    );
    return;
  }
  await mkdir(USER_DATA_DIR, { recursive: true });
  await writeFile(userDbFile(userId), JSON.stringify(db, null, 2));
}

// Carry a pre-login (single-file) collection over to the first account created.
async function migrateLegacy(userId) {
  if (!existsSync(LEGACY_DB_FILE)) return;
  try {
    const legacy = JSON.parse(readFileSync(LEGACY_DB_FILE, "utf8"));
    await saveDb(userId, {
      items: Array.isArray(legacy.items) ? legacy.items : [],
      wishlist: Array.isArray(legacy.wishlist) ? legacy.wishlist : [],
    });
    await rename(LEGACY_DB_FILE, LEGACY_DB_FILE + ".migrated");
  } catch {
    /* non-fatal */
  }
}

/* ---------------- Auth endpoints ---------------- */

// Storage diagnostics — "mongodb" means accounts/collections truly persist.
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    storage: mongo ? "mongodb" : "file",
    // false = running on the shared OCR.space demo key, which throttles after
    // a handful of scans — set OCRSPACE_API_KEY on the host if you see this.
    ocrKey: !!process.env.OCRSPACE_API_KEY,
    uptimeSec: Math.round(process.uptime()),
  });
});

app.post("/api/auth/register", async (req, res) => {
  const username = String(req.body?.username || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  if (!/^[a-z0-9._%+@-]{3,254}$/.test(username)) {
    return res.status(400).json({ error: "Use a username or email (letters, numbers, 3+ characters)." });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters" });
  }
  const users = await loadUsers();
  if (users.find((u) => u.username === username)) {
    return res.status(409).json({ error: "That username is already taken" });
  }
  const { salt, hash } = hashPassword(password);
  const user = { id: randomUUID(), username, salt, hash, createdAt: new Date().toISOString() };
  const firstUser = users.length === 0;
  await addUser(user);
  if (firstUser) await migrateLegacy(user.id);
  const token = newToken();
  addSession(token, user.id);
  res.json({ token, username: user.username });
});

app.post("/api/auth/login", async (req, res) => {
  const username = String(req.body?.username || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  const users = await loadUsers();
  const user = users.find((u) => u.username === username);
  if (!user || !verifyPassword(password, user.salt, user.hash)) {
    return res.status(401).json({ error: "Invalid username or password" });
  }
  const token = newToken();
  addSession(token, user.id);
  res.json({ token, username: user.username });
});

app.post("/api/auth/logout", (req, res) => {
  const t = tokenFrom(req);
  if (t) removeSession(t);
  res.json({ ok: true });
});

app.get("/api/auth/me", async (req, res) => {
  const uid = await authUserId(req);
  if (!uid) return res.status(401).json({ error: "Sign in required" });
  const users = await loadUsers();
  const user = users.find((u) => u.id === uid);
  if (!user) return res.status(401).json({ error: "Sign in required" });
  res.json({ username: user.username });
});

app.get("/api/inventory", requireAuth, async (req, res) => {
  const db = await loadDb(req.userId);
  // Passive daily snapshot: opening the app is enough to extend the chart.
  const today = new Date().toISOString().slice(0, 10);
  const last = db.history[db.history.length - 1];
  if (db.items.length && (!last || last.d !== today)) {
    saveDb(req.userId, db).catch(() => {});
  }
  res.json(db);
});

app.post("/api/inventory", requireAuth, async (req, res) => {
  const b = req.body || {};
  if (!b.productId || !b.name) {
    return res.status(400).json({ error: "productId and name are required" });
  }
  const db = await loadDb(req.userId);
  const condition = b.condition || "Near Mint";
  const quantity = Math.max(1, parseInt(b.quantity) || 1);

  // Merge with an existing identical (productId + condition) entry.
  const existing = db.items.find(
    (i) => i.productId === b.productId && i.condition === condition
  );
  if (existing) {
    existing.quantity += quantity;
    existing.marketPrice = b.marketPrice ?? existing.marketPrice;
    existing.updatedAt = new Date().toISOString();
    await saveDb(req.userId, db);
    return res.json(existing);
  }

  const item = {
    id: randomUUID(),
    productId: b.productId,
    name: b.name,
    set: b.set || null,
    number: b.number || null,
    rarity: b.rarity || null,
    image: b.image || IMG(b.productId),
    imageLarge: b.imageLarge || IMG(b.productId, "1000x1000"),
    url: b.url || `https://www.tcgplayer.com/product/${b.productId}`,
    sealed: !!b.sealed,
    attributes: b.attributes || null,
    condition,
    quantity,
    marketPrice: b.marketPrice ?? null,
    addedPrice: b.marketPrice ?? null,
    addedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  db.items.unshift(item);
  await saveDb(req.userId, db);
  res.json(item);
});

app.patch("/api/inventory/:id", requireAuth, async (req, res) => {
  const db = await loadDb(req.userId);
  const item = db.items.find((i) => i.id === req.params.id);
  if (!item) return res.status(404).json({ error: "Not found" });
  const b = req.body || {};
  if (b.quantity !== undefined) item.quantity = Math.max(0, parseInt(b.quantity) || 0);
  if (b.condition !== undefined) item.condition = b.condition;
  if (b.marketPrice !== undefined) item.marketPrice = b.marketPrice;
  if (b.group !== undefined) item.group = b.group || null; // custom group name
  item.updatedAt = new Date().toISOString();
  if (item.quantity === 0) {
    db.items = db.items.filter((i) => i.id !== item.id);
  }
  await saveDb(req.userId, db);
  res.json(item);
});

app.delete("/api/inventory/:id", requireAuth, async (req, res) => {
  const db = await loadDb(req.userId);
  const before = db.items.length;
  db.items = db.items.filter((i) => i.id !== req.params.id);
  if (db.items.length === before) return res.status(404).json({ error: "Not found" });
  await saveDb(req.userId, db);
  res.json({ ok: true });
});

// Bulk operations for multi-select: delete several items or move them into a
// group with ONE request (one save, one history point).
app.post("/api/inventory/bulk", requireAuth, async (req, res) => {
  const b = req.body || {};
  const ids = Array.isArray(b.ids) ? b.ids : [];
  if (!ids.length) return res.status(400).json({ error: "ids required" });
  const db = await loadDb(req.userId);
  const idSet = new Set(ids);
  let affected = 0;
  if (b.action === "delete") {
    const before = db.items.length;
    db.items = db.items.filter((i) => !idSet.has(i.id));
    affected = before - db.items.length;
  } else if (b.action === "group") {
    const group = b.group || null;
    for (const item of db.items) {
      if (idSet.has(item.id)) {
        item.group = group;
        item.updatedAt = new Date().toISOString();
        affected++;
      }
    }
    if (group && !db.groups.includes(group)) db.groups.push(group);
  } else {
    return res.status(400).json({ error: "action must be delete or group" });
  }
  await saveDb(req.userId, db);
  res.json({ ok: true, affected, items: db.items, groups: db.groups });
});

/* ---------------- Custom groups ---------------- */

app.post("/api/groups", requireAuth, async (req, res) => {
  const name = String(req.body?.name || "").trim().slice(0, 40);
  if (!name) return res.status(400).json({ error: "Group name required" });
  const db = await loadDb(req.userId);
  if (!db.groups.includes(name)) {
    db.groups.push(name);
    await saveDb(req.userId, db);
  }
  res.json({ groups: db.groups });
});

app.delete("/api/groups/:name", requireAuth, async (req, res) => {
  const name = req.params.name;
  const db = await loadDb(req.userId);
  db.groups = db.groups.filter((g) => g !== name);
  for (const item of db.items) {
    if (item.group === name) item.group = null; // cards stay, group tag clears
  }
  await saveDb(req.userId, db);
  res.json({ groups: db.groups, items: db.items });
});

/* ---------------- Wishlist ---------------- */

app.get("/api/wishlist", requireAuth, async (req, res) => {
  const db = await loadDb(req.userId);
  res.json({ wishlist: db.wishlist });
});

app.post("/api/wishlist", requireAuth, async (req, res) => {
  const b = req.body || {};
  if (!b.productId || !b.name) {
    return res.status(400).json({ error: "productId and name are required" });
  }
  const db = await loadDb(req.userId);
  const existing = db.wishlist.find((i) => i.productId === b.productId);
  if (existing) return res.json(existing);

  const item = {
    id: randomUUID(),
    productId: b.productId,
    name: b.name,
    set: b.set || null,
    number: b.number || null,
    rarity: b.rarity || null,
    image: b.image || IMG(b.productId),
    imageLarge: b.imageLarge || IMG(b.productId, "1000x1000"),
    url: b.url || `https://www.tcgplayer.com/product/${b.productId}`,
    sealed: !!b.sealed,
    attributes: b.attributes || null,
    marketPrice: b.marketPrice ?? null,
    addedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  db.wishlist.unshift(item);
  await saveDb(req.userId, db);
  res.json(item);
});

app.delete("/api/wishlist/:id", requireAuth, async (req, res) => {
  const db = await loadDb(req.userId);
  const before = db.wishlist.length;
  db.wishlist = db.wishlist.filter((i) => i.id !== req.params.id);
  if (db.wishlist.length === before) return res.status(404).json({ error: "Not found" });
  await saveDb(req.userId, db);
  res.json({ ok: true });
});

/* ---------------- Price refresh (collection + wishlist) ---------------- */

async function refreshPrices(list, cache) {
  let updated = 0;
  for (const item of list) {
    try {
      let products = cache.get(item.name);
      if (!products) {
        ({ products } = await tcgSearch(item.name, { size: 50 }));
        cache.set(item.name, products);
      }
      const match = products.find((p) => p.productId === item.productId);
      if (match && match.marketPrice != null) {
        item.marketPrice = match.marketPrice;
        item.updatedAt = new Date().toISOString();
        updated++;
      }
    } catch {
      /* keep old price on error */
    }
  }
  return updated;
}

app.post("/api/inventory/refresh", requireAuth, async (req, res) => {
  const db = await loadDb(req.userId);
  const cache = new Map();
  const updated =
    (await refreshPrices(db.items, cache)) + (await refreshPrices(db.wishlist, cache));
  await saveDb(req.userId, db);
  res.json({ updated, items: db.items, wishlist: db.wishlist });
});

const HTTPS_PORT = process.env.HTTPS_PORT || 3443;

function lanIPs() {
  const out = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === "IPv4" && !a.internal) out.push(a.address);
    }
  }
  return out;
}

// Generate (and cache) a self-signed certificate covering localhost + LAN IPs,
// so the app can be served over HTTPS — required for camera access and PWA
// install on a phone.
async function getCert() {
  const keyPath = join(DATA_DIR, "key.pem");
  const certPath = join(DATA_DIR, "cert.pem");
  const ips = lanIPs();
  const sansPath = join(DATA_DIR, "cert.sans");
  const wantSans = ["localhost", "127.0.0.1", ...ips].join(",");

  // Reuse the cached cert only if it still covers the current IPs.
  if (existsSync(keyPath) && existsSync(certPath) && existsSync(sansPath)) {
    try {
      if (readFileSync(sansPath, "utf8") === wantSans) {
        return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
      }
    } catch {
      /* regenerate below */
    }
  }

  const altNames = [
    { type: 2, value: "localhost" },
    { type: 7, ip: "127.0.0.1" },
    ...ips.map((ip) => ({ type: 7, ip })),
  ];
  // selfsigned v5 returns a Promise.
  const pems = await selfsigned.generate(
    [{ name: "commonName", value: "localhost" }],
    {
      days: 3650,
      keySize: 2048,
      algorithm: "sha256",
      extensions: [{ name: "subjectAltName", altNames }],
    }
  );
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(keyPath, pems.private);
  writeFileSync(certPath, pems.cert);
  writeFileSync(sansPath, wantSans);
  return { key: pems.private, cert: pems.cert };
}

const ips = lanIPs();

// HTTP server (localhost works for camera; LAN works for non-camera features).
http.createServer(app).listen(PORT, "0.0.0.0", () => {
  console.log(`\n  ⚡ Kairos Pokemon is running\n`);
  console.log(`  On this computer:  http://localhost:${PORT}`);
});

// HTTPS server — enables camera + installable app on phones over Wi-Fi.
// Skipped on cloud hosts (Render/Railway/Fly), which terminate TLS for us and
// expose a single port via $PORT.
const IS_CLOUD = !!(process.env.RENDER || process.env.RAILWAY_ENVIRONMENT || process.env.FLY_APP_NAME || process.env.NODE_ENV === "production");
if (!IS_CLOUD) try {
  const creds = await getCert();
  https.createServer(creds, app).listen(HTTPS_PORT, "0.0.0.0", () => {
    if (ips.length) {
      console.log(`\n  On your phone (same Wi-Fi) — use HTTPS for camera + install:`);
      ips.forEach((ip) => console.log(`     https://${ip}:${HTTPS_PORT}`));
      console.log(
        `\n  The certificate is self-signed, so your phone will show a\n` +
          `  "Not secure / privacy" warning the first time — tap Advanced →\n` +
          `  Proceed/Continue. After that the camera and "Add to Home Screen"\n` +
          `  (install) both work.`
      );
    }
    console.log("");
  });
} catch (err) {
  console.log(`\n  (HTTPS unavailable: ${err.message})\n`);
}
