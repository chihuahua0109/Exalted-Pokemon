import { createWorker, PSM } from "tesseract.js";
import sharp from "sharp";

const file = process.argv[2] || "./test/psyduck.png";

const variants = {
  "A raw 2x norm": (img) =>
    img.resize({ width: 1600 }).grayscale().normalize().sharpen().toBuffer(),
  "B threshold": (img) =>
    img.resize({ width: 1600 }).grayscale().normalize().threshold(140).toBuffer(),
  "C trim+gray": (img) =>
    img.trim({ threshold: 30 }).resize({ width: 1600 }).grayscale().normalize().sharpen().toBuffer(),
  "D trim+thresh": (img) =>
    img.trim({ threshold: 30 }).resize({ width: 1600 }).grayscale().normalize().threshold(145).toBuffer(),
};

function topStrip(buf, frac = 0.2) {
  return sharp(buf).metadata().then((m) =>
    sharp(buf).extract({ left: 0, top: 0, width: m.width, height: Math.round(m.height * frac) }).toBuffer()
  );
}

async function run() {
  const worker = await createWorker("eng");
  for (const [name, fn] of Object.entries(variants)) {
    let buf;
    try {
      buf = await fn(sharp(file));
    } catch (e) {
      console.log(`${name}: prep error ${e.message}`);
      continue;
    }
    // dims after prep
    const meta = await sharp(buf).metadata();

    for (const psm of [PSM.AUTO, PSM.SINGLE_BLOCK, PSM.SPARSE_TEXT]) {
      await worker.setParameters({ tessedit_pageseg_mode: psm });
      const { data } = await worker.recognize(buf, {}, { text: true });
      const t = (data.text || "").replace(/\s+/g, " ").trim();
      const hasName = /psyduck/i.test(t);
      const num = (t.match(/\b\d{1,3}\s*\/\s*\d{1,3}\b/) || [null])[0];
      console.log(
        `${name.padEnd(15)} ${meta.width}x${meta.height} psm=${psm} | psyduck=${hasName} num=${num} | "${t.slice(0, 90)}"`
      );
    }
    // name strip on the trimmed variants
    if (name.startsWith("C") || name.startsWith("D")) {
      const strip = await topStrip(buf, 0.2);
      await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE });
      const { data } = await worker.recognize(strip, {}, { text: true });
      const t = (data.text || "").replace(/\s+/g, " ").trim();
      console.log(`${name.padEnd(15)} TOPSTRIP single-line | "${t.slice(0, 60)}"`);
    }
  }
  await worker.terminate();
}
run();
