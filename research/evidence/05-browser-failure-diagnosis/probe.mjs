import { chromium, firefox, webkit } from 'playwright-core';

const PAGE = 'https://viewer.example/index.html';

const CASES = [
  ['cors-blocked-get',      "https://example.com/",                                    {}],
  ['cors-ok-get',           "https://cloudflare-dns.com/dns-query?name=example.com&type=A", {headers:{accept:'application/dns-json'}}],
  ['dns-nxdomain-invalid',  "https://no-such-host-9f3a2b71.invalid/x",                 {}],
  ['dns-nxdomain-real-tld', "https://zz9f3a2b71-nope.example.org/x",                   {}],
  ['conn-refused-127',      "https://127.0.0.1:5173/api/shl-manifest?bid=4836470",     {}],
  ['conn-refused-localhost',"https://localhost:5173/api/shl-manifest?bid=4836470",     {}],
  ['http-localhost-mixed',  "http://localhost:5173/api/shl-manifest",                  {}],
  ['http-127-mixed',        "http://127.0.0.1:5173/api/shl-manifest",                  {}],
  ['tls-expired',           "https://expired.badssl.com/",                             {}],
  ['tls-selfsigned',        "https://self-signed.badssl.com/",                         {}],
  ['tls-wronghost',         "https://wrong.host.badssl.com/",                          {}],
  ['mixed-content-http',    "http://example.com/",                                     {}],
  ['nocors-blocked',        "https://example.com/",                                    {mode:'no-cors'}],
  ['nocors-refused',        "https://127.0.0.1:5173/",                                 {mode:'no-cors'}],
  ['nocors-404',            "https://example.com/definitely-not-here-404",             {mode:'no-cors'}],
  ['nocors-500ish',         "https://httpbin.org/status/500",                          {mode:'no-cors'}],
  ['post-json-preflight',   "https://example.com/",              {method:'POST',headers:{'content-type':'application/json'},body:'{}'}],
  ['post-nocors-json-hdr',  "https://example.com/",              {method:'POST',mode:'no-cors',headers:{'content-type':'application/json'},body:'{}'}],
  ['head-nocors',           "https://example.com/",                                    {method:'HEAD',mode:'no-cors'}],
];

const HTML = '<!doctype html><meta charset=utf-8><title>probe</title><body>ok</body>';

async function probe(args) {
  const url = args[0], init = args[1];
  const out = { threwSynchronously: null };
  const t0 = performance.now();
  try {
    const p = fetch(url, Object.assign({ cache: 'no-store' }, init));
    out.threwSynchronously = false;
    const r = await p;
    out.outcome = 'resolved';
    out.responseType = r.type;
    out.status = r.status;
    out.statusText = r.statusText;
    out.ok = r.ok;
    out.redirected = r.redirected;
    out.url = r.url;
    out.headerNames = Array.from(r.headers.keys());
    try { out.bodyLength = (await r.clone().text()).length; }
    catch (e) { out.bodyError = e.name + ': ' + e.message; }
  } catch (e) {
    if (out.threwSynchronously === null) out.threwSynchronously = true;
    out.outcome = 'rejected';
    out.errName = e.name;
    out.errMessage = e.message;
    out.errOwnProps = Object.getOwnPropertyNames(e);
    out.errKeys = Object.keys(e);
    out.hasCauseProp = 'cause' in e;
    out.cause = e.cause === undefined ? '<undefined>' : String(e.cause);
    out.isTypeError = e instanceof TypeError;
    out.isDOMException = typeof DOMException !== 'undefined' && e instanceof DOMException;
    out.toStringVal = String(e);
  }
  out.ms = Math.round(performance.now() - t0);
  const ents = performance.getEntriesByName(url);
  out.resourceTimingEntries = ents.length;
  out.resourceTiming = ents.map(function (e) {
    return {
      initiatorType: e.initiatorType, nextHopProtocol: e.nextHopProtocol,
      transferSize: e.transferSize, encodedBodySize: e.encodedBodySize,
      decodedBodySize: e.decodedBodySize, responseStatus: e.responseStatus,
      deliveryType: e.deliveryType, contentType: e.contentType,
      startTime: Math.round(e.startTime), duration: Math.round(e.duration),
      domainLookupStart: Math.round(e.domainLookupStart), domainLookupEnd: Math.round(e.domainLookupEnd),
      connectStart: Math.round(e.connectStart), connectEnd: Math.round(e.connectEnd),
      secureConnectionStart: Math.round(e.secureConnectionStart),
      requestStart: Math.round(e.requestStart), responseStart: Math.round(e.responseStart),
      responseEnd: Math.round(e.responseEnd),
    };
  });
  return out;
}

async function run(name, launcher) {
  const browser = await launcher.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  let log = [];
  page.on('console', m => log.push(m.type() + ': ' + m.text()));
  page.on('pageerror', e => log.push('pageerror: ' + e.message));
  await page.route('https://viewer.example/**', r => r.fulfill({ status: 200, contentType: 'text/html', body: HTML }));
  await page.goto(PAGE);
  const results = {};
  for (const [id, url, init] of CASES) {
    log = [];
    let r;
    try {
      r = await Promise.race([
        page.evaluate(probe, [url, init]).then(v => v === undefined ? { note: 'evaluate returned undefined' } : v),
        new Promise(res => setTimeout(() => res({ outcome: 'HARNESS_TIMEOUT_15s' }), 15000)),
      ]);
    } catch (e) { r = { harnessError: String(e).slice(0, 400) }; }
    if (!r || typeof r !== 'object') r = { weird: String(r) };
    r.devtoolsConsole = log.slice();
    r.requestUrl = url;
    r.requestInit = init;
    results[id] = r;
  }
  results._env = await page.evaluate(() => ({
    hasReportingObserver: typeof ReportingObserver !== 'undefined',
    reportTypes: (typeof ReportingObserver !== 'undefined' && 'supportedEntryTypes' in PerformanceObserver) ? undefined : undefined,
    hasNetworkInformation: 'connection' in navigator,
    isSecureContext, crossOriginIsolated, origin: location.origin,
    ua: navigator.userAgent,
    supportedEntryTypes: PerformanceObserver.supportedEntryTypes,
  }));
  await browser.close();
  return results;
}

const engines = { chromium, firefox, webkit };
const only = process.argv[2];
const out = {};
for (const [n, l] of Object.entries(engines)) {
  if (only && only !== n) continue;
  try { out[n] = await run(n, l); } catch (e) { out[n] = { fatal: String(e).slice(0, 600) }; }
}
console.log(JSON.stringify(out, null, 1));
