import { createWorker, PSM } from "tesseract.js";
import sharp from "sharp";

const STOP = new Set(["hp","basic","stage","gx","ex","v","vmax","vstar","pokemon","pokémon","ability","weakness","resistance","retreat","damp","ram","trainer","energy","item","nintendo","creatures","game","freak"]);
const clean = (t)=>(t||"").replace(/[^A-Za-z'’.\-]/g,"");
function collectWords(d){const o=[];const pl=(ls)=>ls&&ls.forEach(l=>l.words&&o.push(...l.words));const wk=(bs)=>bs&&bs.forEach(b=>{if(b.words)o.push(...b.words);pl(b.lines);b.paragraphs&&b.paragraphs.forEach(p=>pl(p.lines));wk(b.blocks);});wk(d.blocks);return o;}
function nameFromWords(words){const ws=words.map(w=>({text:clean(w.text),h:(w.bbox?.y1??0)-(w.bbox?.y0??0),x:w.bbox?.x0??0,y:w.bbox?.y0??0,conf:w.confidence??0})).filter(w=>w.text.length>=2&&w.conf>25);if(!ws.length)return"";const H=Math.max(...ws.map(w=>w.y+w.h))||1;const named=ws.filter(w=>/[A-Za-z]/.test(w.text)&&!STOP.has(w.text.toLowerCase())&&w.y<H*0.6);if(!named.length)return"";const mh=Math.max(...named.map(w=>w.h));const big=named.filter(w=>w.h>=mh*0.62);const tall=big.reduce((a,b)=>b.h>a.h?b:a);return big.filter(w=>Math.abs(w.y-tall.y)<=tall.h*0.9).sort((a,b)=>a.x-b.x).map(w=>w.text).join(" ").trim();}

const card = { left:170, top:135, width:430, height:765 };

async function run(){
  const w=await createWorker("eng");
  // strategy 1: word-box on card-filling image
  const buf=await sharp("./test/psyduck.png").extract(card).resize({width:1500}).grayscale().normalize().sharpen().toBuffer();
  await w.setParameters({tessedit_pageseg_mode:PSM.AUTO});
  const {data}=await w.recognize(buf,{},{blocks:true,text:true});
  const words=collectWords(data);
  const name=nameFromWords(words);
  const num=(data.text.match(/\b\d{1,3}\s*\/\s*\d{1,3}\b/)||[null])[0];
  console.log("CARD word-box name=",JSON.stringify(name)," number=",num," words=",words.length);

  // strategy 2: proportional name band, single line
  const nb={left:card.left+Math.round(card.width*0.05),top:card.top+Math.round(card.height*0.02),width:Math.round(card.width*0.58),height:Math.round(card.height*0.07)};
  const nbuf=await sharp("./test/psyduck.png").extract(nb).resize({width:nb.width*6}).grayscale().normalize().sharpen().toBuffer();
  await w.setParameters({tessedit_pageseg_mode:PSM.SINGLE_LINE});
  const r2=await w.recognize(nbuf,{},{text:true});
  console.log("NAMEBAND single-line=",JSON.stringify(r2.data.text.replace(/\s+/g,' ').trim()));

  // strategy 3: number band digits
  const numb={left:card.left+Math.round(card.width*0.02),top:card.top+Math.round(card.height*0.78),width:Math.round(card.width*0.30),height:Math.round(card.height*0.05)};
  const numbuf=await sharp("./test/psyduck.png").extract(numb).resize({width:numb.width*8}).grayscale().normalize().sharpen().toBuffer();
  await w.setParameters({tessedit_pageseg_mode:PSM.SINGLE_LINE,tessedit_char_whitelist:"0123456789/"});
  const r3=await w.recognize(numbuf,{},{text:true});
  console.log("NUMBERBAND=",JSON.stringify(r3.data.text.replace(/\s+/g,' ').trim()));
  await w.terminate();
}
run();
