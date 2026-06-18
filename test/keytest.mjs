import { readFileSync } from 'fs';
const key = 'K85352191488957';
const b64 = readFileSync('test/psyduck.png').toString('base64');
const body = new URLSearchParams();
body.set('base64Image','data:image/png;base64,'+b64);
body.set('OCREngine','2'); body.set('scale','true'); body.set('language','eng'); body.set('isOverlayRequired','false');
const r = await fetch('https://api.ocr.space/parse/image',{method:'POST',headers:{apikey:key,'content-type':'application/x-www-form-urlencoded'},body});
const d = await r.json();
if(d.error){ console.log('KEY ERROR:', d.error); }
else if(d.IsErroredOnProcessing){ console.log('OCR ERROR:', d.ErrorMessage); }
else { console.log('KEY VALID. Sample:', (d?.ParsedResults?.[0]?.ParsedText||'').slice(0,50).replace(/\n/g,' ')); }
