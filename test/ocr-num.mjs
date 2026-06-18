import { createWorker, PSM } from "tesseract.js";
import sharp from "sharp";

const file = "./test/psyduck.png";
const crops = {
  n1: { left: 175, top: 785, width: 180, height: 50 },
  n2: { left: 175, top: 800, width: 170, height: 40 },
  n3: { left: 180, top: 805, width: 150, height: 38 },
  n4: { left: 165, top: 775, width: 220, height: 70 },
};

async function run() {
  const worker = await createWorker("eng");
  await worker.setParameters({
    tessedit_pageseg_mode: PSM.SINGLE_LINE,
    tessedit_char_whitelist: "0123456789/",
  });
  for (const [name, box] of Object.entries(crops)) {
    for (const scale of [5, 8]) {
      const buf = await sharp(file)
        .extract(box)
        .resize({ width: box.width * scale })
        .grayscale()
        .normalize()
        .sharpen()
        .toBuffer();
      await sharp(buf).toFile(`./test/num_${name}_x${scale}.png`);
      const { data } = await worker.recognize(buf, {}, { text: true });
      const t = (data.text || "").replace(/\s+/g, " ").trim();
      console.log(`${name} x${scale} | "${t}"`);
    }
  }
  await worker.terminate();
}
run();
