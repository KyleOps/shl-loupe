import { chromium, firefox, webkit } from 'playwright-core';
const PAGE = 'https://viewer.example/index.html';
const HTML = '<!doctype html><meta charset=utf-8><title>probe2</title><body>ok</body>';
const N = Date.now();

const CASES = [
  // The real incident, reproduced against a LIVE self-signed dev server that IS listening.
  ['LIVE-https-localhost-selfsigned', `https://localhost:5173/api/shl-manifest?bid=${N}a`, {method:'POST',headers:{'content-type':'application/json'},body:'{"recipient":"probe"}'}],
  ['LIVE-https-127-selfsigned',       `https://127.0.0.1:5173/api/shl-manifest?bid=${N}b`, {method:'POST',headers:{'content-type':'application/json'},body:'{"recipient":"probe"}'}],
  ['LIVE-https-localhost-GET-nocors', `https://localhost:5173/api/shl-manifest?bid=${N}c`, {mode:'no-cors'}],
  ['LIVE-http-localhost-5174-POST',   `http://localhost:5174/api/shl-manifest?bid=${N}d`,  {method:'POST',headers:{'content-type':'application/json'},body:'{"recipient":"probe"}'}],
  ['LIVE-http-127-5174-GET-nocors',   `http://127.0.0.1:5174/x?bid=${N}e`,                 {mode:'no-cors'}],
  ['LIVE-http-localhost-5174-GET',    `http://localhost:5174/y?bid=${N}f`,                 {}],
  // opaque RT entry with a guaranteed-unique URL
  ['opaque-unique-url',               `https://example.com/opaque-${N}`,                   {mode:'no-cors'}],
  ['cors-fail-unique-url',            `https://example.com/corsfail-${N}`,                 {}],
  // TAO on vs off, both CORS-readable
  ['tao-on-jsdelivr',   `https://cdn.jsdelivr.net/npm/lodash@4.17.21/package.json?x=${N}`, {}],
  ['tao-off-unpkg',     `https://unpkg.com/lodash@4.17.21/package.json?x=${N}`,            {}],
  ['tao-on-nocors',     `https://cdn.jsdelivr.net/npm/lodash@4.17.20/package.json?x=${N}`, {mode:'no-cors'}],
];

async function probe(args) {
  const url = args[0], init = args[1];
  const out = {};
  const t0 = performance.now();
  try {
    const r = await fetch(url, Object.assign({ cache: 'no-store' }, init));
    out.outcome='resolved'; out.responseType=r.type; out.status=r.status; out.ok=r.ok;
    out.headerNames=Array.from(r.headers.keys());
    try { out.bodyLength=(await r.clone().text()).length; } catch(e){ out.bodyError=e.name+': '+e.message; }
  } catch (e) {
    out.outcome='rejected'; out.errName=e.name; out.errMessage=e.message;
    out.errOwnProps=Object.getOwnPropertyNames(e); out.cause = e.cause===undefined?'<undefined>':String(e.cause);
  }
  out.ms = Math.round(performance.now()-t0);
  await new Promise(r=>setTimeout(r,150));  // let the timeline settle
  const ents = performance.getEntriesByName(url);
  out.rtCount = ents.length;
  out.rt = ents.map(e=>({ nextHopProtocol:e.nextHopProtocol, transferSize:e.transferSize,
    encodedBodySize:e.encodedBodySize, decodedBodySize:e.decodedBodySize,
    responseStatus:e.responseStatus, contentType:e.contentType, deliveryType:e.deliveryType,
    duration:Math.round(e.duration),
    domainLookupStart:Math.round(e.domainLookupStart), domainLookupEnd:Math.round(e.domainLookupEnd),
    connectStart:Math.round(e.connectStart), connectEnd:Math.round(e.connectEnd),
    secureConnectionStart:Math.round(e.secureConnectionStart),
    requestStart:Math.round(e.requestStart), responseStart:Math.round(e.responseStart) }));
  return out;
}

// image / script / stylesheet reachability probes
async function elementProbes(_) {
  const t = (u, mk) => new Promise(res => {
    const t0 = performance.now(); const el = mk(u);
    const done = (how) => { res({ url: u, how, ms: Math.round(performance.now()-t0) }); el.remove(); };
    el.onload = () => done('load'); el.onerror = () => done('error');
    document.head.appendChild(el);
    setTimeout(()=>done('timeout-8s'), 8000);
  });
  const img = u => { const i=document.createElement('img'); i.src=u; return i; };
  const scr = u => { const s=document.createElement('script'); s.src=u; return s; };
  const lnk = u => { const l=document.createElement('link'); l.rel='stylesheet'; l.href=u; return l; };
  const n = Date.now();
  return {
    img_reachable_but_not_image: await t('https://example.com/nope-'+n, img),
    img_dns_fail:                await t('https://no-such-'+n+'.invalid/a.png', img),
    img_conn_refused:            await t('https://127.0.0.1:5199/a.png', img),
    img_selfsigned_live:         await t('https://localhost:5173/a.png?'+n, img),
    img_real_image:              await t('https://cdn.jsdelivr.net/npm/simple-icons@11/icons/github.svg?'+n, img),
    script_cors_blocked_ok:      await t('https://cdn.jsdelivr.net/npm/lodash@4.17.21/lodash.min.js?'+n, scr),
    script_selfsigned_live:      await t('https://localhost:5173/x.js?'+n, scr),
    link_selfsigned_live:        await t('https://localhost:5173/x.css?'+n, lnk),
  };
}

async function run(name, launcher) {
  const browser = await launcher.launch();
  const page = await (await browser.newContext()).newPage();
  let log = [];
  page.on('console', m => log.push(m.type()+': '+m.text()));
  page.on('pageerror', e => log.push('pageerror: '+e.message));
  await page.route('https://viewer.example/**', r => r.fulfill({status:200, contentType:'text/html', body:HTML}));
  await page.goto(PAGE);
  const results = {};
  for (const [id,url,init] of CASES) {
    log = [];
    let r;
    try { r = await Promise.race([ page.evaluate(probe,[url,init]), new Promise(res=>setTimeout(()=>res({outcome:'HARNESS_TIMEOUT'}),15000)) ]); }
    catch(e) { r = { harnessError:String(e).slice(0,300) }; }
    if (!r || typeof r!=='object') r = {weird:String(r)};
    await new Promise(res=>setTimeout(res,250));   // drain async console events
    r.console = log.slice(); r.url = url; r.init = init;
    results[id] = r;
  }
  log = [];
  try { results._elementProbes = await page.evaluate(elementProbes, null); } catch(e){ results._elementProbes={err:String(e).slice(0,300)}; }
  await new Promise(res=>setTimeout(res,400));
  results._elementProbesConsole = log.slice();
  await browser.close();
  return results;
}
const engines = { chromium, firefox, webkit };
const only = process.argv[2]; const out = {};
for (const [n,l] of Object.entries(engines)) { if (only && only!==n) continue;
  try { out[n] = await run(n,l); } catch(e){ out[n]={fatal:String(e).slice(0,600)}; } }
console.log(JSON.stringify(out,null,1));
