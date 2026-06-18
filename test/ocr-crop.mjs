import { createWorker, PSM } from "tesseract.js";
import sharp from "sharp";

const file = "./test/psyduck.png";
// original is 768x1024; card name "Psyduck" sits near the top-left of the card.
const crops = {
  "name wide": { left: 150, top: 130, width: 420, height: 70 },
  "name tight": { left: 195, top: 150, width: 220, height: 48 },
  "number": { left: 150, top: 760, width: 200, height: 50 },
  "topband": { left: 150, top: 120, width: 470, height: 90 },
};

async function run() {
  const worker = await createWorker("eng");
  for (const [name, box] of Object.entries(crops)) {
    for (const scale of [4, 6]) {
      let buf;
      try {
        buf = await sharp(file)
          .extract(box)
          .resize({ width: box.width * scale })
          .grayscale()
          .normalize()
          .sharpen()
          .toBuffer();
      } catch (e) {
        console.log(`${name} x${scale}: ${e.message}`);
        continue;
      }
      await worker.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE });
      const { data } = await worker.recognize(buf, {}, { text: true });
      const t = (data.text || "").replace(/\s+/g, " ").trim();
      // also save the crop so we can eyeball it
      await sharp(buf).toFile(`./test/crop_${name.replace(/\s/g, "")}_x${scale}.png`);
      console.log(`${name.padEnd(11)} x${scale} | "${t}"`);
    }
  }
  await worker.terminate();
}
run();
