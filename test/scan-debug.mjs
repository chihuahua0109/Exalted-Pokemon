import { readFileSync } from "fs";
import sharp from "sharp";

const key = process.env.OCRSPACE_API_KEY || "helloworld";
const b64 = readFileSync("test/psyduck.png").toString("base64");
const raw = `data:image/png;base64,${b64}`;

async function ocr(dataUrl) {
  const body = new URLSearchParams();
  body.set("base64Image", dataUrl);
  body.set("OCREngine", "2");
  body.set("scale", "true");
  body.set("language", "eng");
  const r = await fetch("https://api.ocr.space/parse/image", {
    method: "POST",
    headers: { apikey: key, "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const d = await r.json();
  if (d.IsErroredOnProcessing) return "ERR: " + JSON.stringify(d.ErrorMessage);
  return d?.ParsedResults?.[0]?.ParsedText || "(empty)";
}

const baseBuf = await sharp(Buffer.from(b64, "base64")).rotate().jpeg().toBuffer();
const meta = await sharp(baseBuf).metadata();
const w = meta.width,
  h = meta.height;
const prep = await sharp(baseBuf)
  .resize(1600, 1600, { fit: "inside", withoutEnlargement: false })
  .grayscale()
  .normalize()
  .sharpen()
  .jpeg({ quality: 90 })
  .toBuffer();
const prepUrl = `data:image/jpeg;base64,${prep.toString("base64")}`;

console.log("=== RAW ===");
console.log(await ocr(raw));
console.log("\n=== PREPROCESSED ===");
console.log(await ocr(prepUrl));
