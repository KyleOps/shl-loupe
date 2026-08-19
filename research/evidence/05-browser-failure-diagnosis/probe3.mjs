import { chromium, webkit, firefox } from 'playwright-core';
const PAGE='https://viewer.example/index.html';
const HTML='<!doctype html><meta charset=utf-8><title>p3</title><body>ok</body>';
const N=Date.now();

async function probe(args){
  const [url,init]=args; const out={}; const t0=performance.now();
  try{ const r=await fetch(url,Object.assign({cache:'no-store'},init));
    out.outcome='resolved'; out.responseType=r.type; out.status=r.status;
    out.headerNames=Array.from(r.headers.keys());
    try{ out.body=(await r.clone().text()).slice(0,200);}catch(e){out.bodyError=e.name+': '+e.message;}
  }catch(e){ out.outcome='rejected'; out.errName=e.name; out.errMessage=e.message; }
  out.ms=Math.round(performance.now()-t0);
  return out;
}
async function featureDetect(){
  let taSupported=false;
  try{ new Request('https://x.invalid/', {targetAddressSpace:'local'}); }catch(e){}
  // detect by whether the option is read: use a Request and check it does not throw
  try{ const r=new Request('https://x.invalid/'); taSupported = 'targetAddressSpace' in r; }catch(e){}
  return {
    targetAddressSpaceOnRequest: taSupported,
    hasReportingObserver: typeof ReportingObserver!=='undefined',
    permissionsQueryLNA: await (async()=>{ try{ const p=await navigator.permissions.query({name:'local-network-access'}); return p.state; }catch(e){ return 'query-threw: '+e.name+': '+e.message; } })(),
    isSecureContext, origin: location.origin,
  };
}

const CASES=[
  ['https-localhost-5173-POST-certOK', `https://localhost:5173/api/shl-manifest?bid=${N}A`, {method:'POST',headers:{'content-type':'application/json'},body:'{"recipient":"probe"}'}],
  ['https-127-5173-GET-certOK',        `https://127.0.0.1:5173/g?bid=${N}B`, {}],
  ['https-127-5173-nocors-certOK',     `https://127.0.0.1:5173/n?bid=${N}C`, {mode:'no-cors'}],
  ['http-localhost-5174-GET',          `http://localhost:5174/h?bid=${N}D`, {}],
  ['doh-cloudflare-in-browser',        `https://cloudflare-dns.com/dns-query?name=viewer.tcpdev.org&type=A&x=${N}`, {headers:{accept:'application/dns-json'}}],
  ['doh-cloudflare-localhost',         `https://cloudflare-dns.com/dns-query?name=localhost&type=A&x=${N}`, {headers:{accept:'application/dns-json'}}],
  ['doh-google-in-browser',            `https://dns.google/resolve?name=viewer.tcpdev.org&type=A&x=${N}`, {}],
  ['crtsh-cors',                       `https://crt.sh/json?q=viewer.tcpdev.org`, {}],
];

async function run(name, launcher, ignoreHTTPSErrors){
  const b=await launcher.launch();
  const page=await (await b.newContext({ignoreHTTPSErrors})).newPage();
  let log=[]; page.on('console',m=>log.push(m.type()+': '+m.text())); page.on('pageerror',e=>log.push('pageerror: '+e.message));
  await page.route('https://viewer.example/**', r=>r.fulfill({status:200,contentType:'text/html',body:HTML}));
  await page.goto(PAGE);
  const res={_features: await page.evaluate(featureDetect)};
  for(const [id,url,init] of CASES){
    log=[]; let r;
    try{ r=await Promise.race([page.evaluate(probe,[url,init]), new Promise(s=>setTimeout(()=>s({outcome:'TIMEOUT'}),15000))]); }
    catch(e){ r={harnessError:String(e).slice(0,300)}; }
    await new Promise(s=>setTimeout(s,250));
    r.console=log.slice(); res[id]=r;
  }
  await b.close(); return res;
}
const out={};
out['chromium_ignoreCertErrors']=await run('chromium',chromium,true).catch(e=>({fatal:String(e).slice(0,400)}));
out['webkit_ignoreCertErrors']=await run('webkit',webkit,true).catch(e=>({fatal:String(e).slice(0,400)}));
out['firefox_ignoreCertErrors']=await run('firefox',firefox,true).catch(e=>({fatal:String(e).slice(0,400)}));
console.log(JSON.stringify(out,null,1));
