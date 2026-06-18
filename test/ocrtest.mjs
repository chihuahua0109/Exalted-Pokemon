import { readFileSync } from 'fs';
const key = 'helloworld';
const b64 = readFileSync('test/psyduck.png').toString('base64');
const body = new URLSearchParams();
body.set('base64Image', 'data:image/png;base64,' + b64);
body.set('OCREngine', '2'); body.set('scale', 'true'); body.set('language', 'eng');
body.set('isOverlayRequired', 'false');
const r = await fetch('https://api.ocr.space/parse/image', {
  method: 'POST', headers: { apikey: key, 'content-type': 'application/x-www-form-urlencoded' }, body
});
const d = await r.json();
console.log('IsErrored:', d.IsErroredOnProcessing, 'Err:', d.ErrorMessage);
console.log('TEXT:', (d?.ParsedResults?.[0]?.ParsedText || '').slice(0, 300));
