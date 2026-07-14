// Quick end-to-end scan test: node test/scantest.mjs <image> [apiBase]
import { readFile } from "node:fs/promises";

const [img, base = "http://localhost:3999"] = process.argv.slice(2);
if (!img) {
  console.error("usage: node test/scantest.mjs <image> [apiBase]");
  process.exit(1);
}
const buf = await readFile(img);
const dataUrl = `data:image/png;base64,${buf.toString("base64")}`;
const r = await fetch(`${base}/api/scan`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ image: dataUrl }),
});
const d = await r.json();
console.log("status:", r.status);
console.log("parsed:", JSON.stringify({ name: d.name, number: d.number, hp: d.hp, species: d.species, source: d.source, confidence: d.confidence }));
console.log("top matches:\n  " + (d.products || []).slice(0, 5).map((m) => `${m.name} [${m.setName ?? m.set ?? ""} ${m.number ?? ""}] $${m.marketPrice ?? "?"}`).join("\n  "));
