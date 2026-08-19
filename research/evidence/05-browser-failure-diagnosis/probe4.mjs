import { chromium, firefox, webkit } from 'playwright-core';
const PAGE='https://viewer.example/index.html';
const HTML='<!doctype html><meta charset=utf-8><body>ok';
async function work(){
  const R = {};
  const t = async (label, fn) => { const t0=performance.now(); try { const v=await fn(); R[label]={ok:true,v,ms:Math.round(performance.now()-t0)}; }
    catch(e){ R[label]={ok:false,name:e.name,message:e.message,isTypeError:e instanceof TypeError,isDOMException:(typeof DOMException!=='undefined')&&e instanceof DOMException,ms:Math.round(performance.now()-t0)}; } };
  // 1. timeout identity: black-holed address, hard 2500ms budget
  await t('blackhole-10.255.255.1', ()=>fetch('https://10.255.255.1/x',{signal:AbortSignal.timeout(2500)}).then(r=>r.status));
  await t('blackhole-203.0.113.1',  ()=>fetch('https://203.0.113.1/x',{signal:AbortSignal.timeout(2500)}).then(r=>r.status));
  await t('manual-abort',           ()=>{ const c=new AbortController(); setTimeout(()=>c.abort(),300); return fetch('https://cdn.jsdelivr.net/npm/lodash@4.17.21/lodash.min.js?z='+Date.now(),{signal:c.signal}).then(r=>r.status); });
  await t('abort-with-reason',      ()=>{ const c=new AbortController(); setTimeout(()=>c.abort(new Error('my-reason')),300); return fetch('https://cdn.jsdelivr.net/npm/lodash@4.17.21/lodash.min.js?z='+Date.now(),{signal:c.signal}).then(r=>r.status); });
  // 2. no-cors vs cors on a black-holed loopback port (nothing listening) repeated for timing stability
  const samples = { corsFailWarm:[], dnsFail:[], connRefused:[], mixedBlocked:[], certInvalid:[] };
  for (let i=0;i<5;i++){
    const one = async (u,init) => { const t0=performance.now(); try{ await fetch(u,init); }catch(e){} return Math.round(performance.now()-t0); };
    samples.corsFailWarm.push(await one('https://example.com/cf'+i+Date.now(),{}));
    samples.dnsFail.push(await one('https://nx-'+i+Date.now()+'.invalid/a',{}));
    samples.connRefused.push(await one('https://127.0.0.1:5199/a'+i,{}));
    samples.mixedBlocked.push(await one('http://example.com/mc'+i+Date.now(),{}));
    samples.certInvalid.push(await one('https://self-signed.badssl.com/?z='+i+Date.now(),{}));
  }
  R._samplesMs = samples;
  // 3. certspotter CORS from the browser
  await t('certspotter-real-host', ()=>fetch('https://api.certspotter.com/v1/issuances?domain=viewer.tcpdev.org&include_subdomains=false&expand=dns_names').then(async r=>({status:r.status, len:(await r.text()).length})));
  await t('certspotter-dev-host',  ()=>fetch('https://api.certspotter.com/v1/issuances?domain=localhost&include_subdomains=false&expand=dns_names').then(async r=>({status:r.status, body:(await r.text()).slice(0,200)})));
  return R;
}
const out={};
for (const [n,l] of Object.entries({chromium,firefox,webkit})) {
  try { const b=await l.launch(); const p=await (await b.newContext()).newPage();
    await p.route('https://viewer.example/**', r=>r.fulfill({status:200,contentType:'text/html',body:HTML}));
    await p.goto(PAGE); out[n]=await p.evaluate(work); await b.close();
  } catch(e){ out[n]={fatal:String(e).slice(0,400)}; }
}
console.log(JSON.stringify(out,null,1));
