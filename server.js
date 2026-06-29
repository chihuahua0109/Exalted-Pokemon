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

async function ocrSpace(dataUrl, engine = "2") {
  const key = process.env.OCRSPACE_API_KEY || "helloworld";
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
  const data = await res.json();
  // Rate-limit response has a top-level "error" string (not IsErroredOnProcessing).
  if (data.error) {
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

async function ocrCardRegions(dataUrl) {
  // Primary pass: engine 2 on the ORIGINAL image (best for clean/sharp shots).
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

  return { name, number, hp };
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
  let name = (cands[0]?.text || "")
    .replace(/[^A-Za-z0-9'’.\- ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  // OCR often glues the suffix onto the name (e.g. "Pikachuex", "CharizardVMAX").
  // Re-introduce the space so the TCGplayer search matches the printed form.
  name = name.replace(
    /([a-z])(ex|EX|GX|V|VMAX|VSTAR|VUNION)\b/,
    (_, base, suf) => `${base} ${suf.toLowerCase() === "ex" ? "ex" : suf.toUpperCase()}`
  );
  return { name, number, hp };
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

function scoreProduct(p, parsed) {
  let s = 0;
  const num = parsed.number;
  if (num && p.number) {
    const pn = p.number.replace(/\s+/g, "");
    if (pn === num) s += 120;
    else if (pn.split("/")[0].replace(/^0+/, "") === num.split("/")[0].replace(/^0+/, "")) s += 40;
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
    const ranked = rankProducts(products, parsed);
    res.json({ ...parsed, source, text, rateLimited, products: ranked.products, confidence: ranked.confidence });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/* ------------------------------------------------------------------ *
 * Inventory store (flat JSON file)
 * ------------------------------------------------------------------ */

// DATA_DIR can point at a mounted persistent disk on a cloud host so user
// accounts/inventory survive restarts (e.g. DATA_DIR=/data on Render).
const DATA_DIR = process.env.DATA_DIR || join(__dirname, "data");
const LEGACY_DB_FILE = join(DATA_DIR, "inventory.json");
const USERS_FILE = join(DATA_DIR, "users.json");
const SESSIONS_FILE = join(DATA_DIR, "sessions.json");
const USER_DATA_DIR = join(DATA_DIR, "users");

/* ------------------------------------------------------------------ *
 * Authentication: local accounts, scrypt-hashed passwords, bearer
 * tokens. Sessions persist to disk so users stay logged in across
 * server restarts. Each user has their own inventory/wishlist file.
 * ------------------------------------------------------------------ */

async function loadUsers() {
  try {
    return JSON.parse(await readFile(USERS_FILE, "utf8"));
  } catch {
    return [];
  }
}
async function saveUsers(users) {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(USERS_FILE, JSON.stringify(users, null, 2));
}

let sessions = {};
try {
  sessions = JSON.parse(readFileSync(SESSIONS_FILE, "utf8"));
} catch {
  sessions = {};
}
function persistSessions() {
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
function authUserId(req) {
  const t = tokenFrom(req);
  return t && sessions[t] ? sessions[t].userId : null;
}
function requireAuth(req, res, next) {
  const uid = authUserId(req);
  if (!uid) return res.status(401).json({ error: "Sign in required" });
  req.userId = uid;
  next();
}

/* ---------------- Per-user inventory store ---------------- */

const userDbFile = (userId) => join(USER_DATA_DIR, `${userId}.json`);

async function loadDb(userId) {
  let db;
  try {
    db = JSON.parse(await readFile(userDbFile(userId), "utf8"));
  } catch {
    db = {};
  }
  if (!Array.isArray(db.items)) db.items = [];
  if (!Array.isArray(db.wishlist)) db.wishlist = [];
  return db;
}
async function saveDb(userId, db) {
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
  users.push(user);
  await saveUsers(users);
  if (firstUser) await migrateLegacy(user.id);
  const token = newToken();
  sessions[token] = { userId: user.id, createdAt: Date.now() };
  persistSessions();
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
  sessions[token] = { userId: user.id, createdAt: Date.now() };
  persistSessions();
  res.json({ token, username: user.username });
});

app.post("/api/auth/logout", (req, res) => {
  const t = tokenFrom(req);
  if (t) {
    delete sessions[t];
    persistSessions();
  }
  res.json({ ok: true });
});

app.get("/api/auth/me", async (req, res) => {
  const uid = authUserId(req);
  if (!uid) return res.status(401).json({ error: "Sign in required" });
  const users = await loadUsers();
  const user = users.find((u) => u.id === uid);
  if (!user) return res.status(401).json({ error: "Sign in required" });
  res.json({ username: user.username });
});

app.get("/api/inventory", requireAuth, async (req, res) => {
  res.json(await loadDb(req.userId));
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
  console.log(`\n  ⚡ Exalted Pokemon is running\n`);
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
