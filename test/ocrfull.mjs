import { readFileSync } from 'fs';
const b64 = readFileSync('test/psyduck.png').toString('base64');
const body = new URLSearchParams();
body.set('base64Image', 'data:image/png;base64,' + b64);
body.set('OCREngine', '2'); body.set('scale', 'true'); body.set('language', 'eng');
body.set('isOverlayRequired', 'false');
const r = await fetch('https://api.ocr.space/parse/image', {
  method: 'POST', headers: { apikey: 'helloworld', 'content-type': 'application/x-www-form-urlencoded' }, body
});
const d = await r.json();
console.log(JSON.stringify(d).slice(0, 500));
