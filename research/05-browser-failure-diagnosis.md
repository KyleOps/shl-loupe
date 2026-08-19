# 05: What a purely client-side page can learn about why an HTTPS fetch failed

**Scope**: SHL Loupe is a static site. No backend, no proxy of our own. This note establishes exactly
what the browser will and will not tell our JavaScript when a manifest POST fails, which probes
legitimately narrow it down, and how to turn that into an honest one-line diagnosis.

**Method**: every browser claim below was measured, not recalled. A test page was served at a synthetic
**public** HTTPS origin (`https://viewer.example`, fulfilled via Playwright route interception so the
page origin is genuinely public, not loopback) and the failure matrix run in three engines:

| Engine | Version | UA string fragment |
| --- | --- | --- |
| Chromium | 151.0.7922.34 (headless) | `HeadlessChrome/151.0.7922.34` |
| Firefox | 153.0 | `Gecko/20100101 Firefox/153.0` |
| WebKit | 26.5 (Safari 26.5) | `AppleWebKit/605.1.15 … Version/26.5 Safari/605.1.15` |

A real self-signed HTTPS dev server was run on `127.0.0.1:5173` and a plain HTTP one on `127.0.0.1:5174`,
both logging every arriving request, so "did a byte reach the server" is answered from the server's own
log rather than inferred. Harness and raw JSON: see *Appendix A*.

---

## 0. The one-line thesis

> The browser tells our JavaScript **nothing** about why a cross-origin fetch failed. Every cause
> collapses into one bare `TypeError` with a fixed per-engine string and no `cause`. Therefore the
> product's diagnostic value cannot come from reading the error. It has to come from
> **(a) static analysis of the URL before we ever fetch**, which is where the overwhelming majority of
> event failures actually live, and **(b) a small, deliberately-designed probe sequence whose
> *pattern of outcomes* is informative even though each individual outcome is opaque.**

---

## 1. The observable surface of a failed cross-origin fetch

### 1.1 It is one bare TypeError, by design

Fetch, § 2.2.6 (Responses):

> A **network error** is a response whose type is "`error`", status is 0, status message is the empty
> byte sequence, header list is « », body is null, and body info is a new response body info.

Fetch, § 5.5 (the `fetch()` method), in the `processResponse` steps:

> If *response* is a **network error**, then **reject** *p* with a `TypeError` and abort these steps.

A bare `TypeError`. No argument, no structured reason. Every distinct cause funnels through that one
step, so there is nothing to read even in principle.

The non-disclosure is explicit in Chromium's implementation. From
`third_party/blink/renderer/core/fetch/fetch_manager.cc`:

```cpp
  // Rejects the promise with the TypeError exception created at construction
  // time. Also optionally passes `devtools_request_id`, `issue_id`, and
  // `issue_summary` to DevTools if they are set; this happens via a side
  // channel that is inaccessible to the page (so additional information
  // stored in the `issue_summary` about for example CORS policy violations
  // is not leaked to the page).
  void RejectBecauseFailed(std::optional<String> devtools_request_id,
                           std::optional<base::UnguessableToken> issue_id,
                           std::optional<String> issue_summary);
```

and the message itself, constructed once at `fetch()` call time so the stack points at the caller:

```cpp
  v8::Local<v8::Value> exception =
      V8ThrowException::CreateTypeError(isolate, "Failed to fetch");
```

So: the reason exists inside the browser, it is routed to DevTools **through a side channel that is
deliberately inaccessible to the page**, and it never reaches our JS. This is the single most important
fact in this document, and it is worth quoting verbatim in the tool's own "why can't you just tell me"
help text.

### 1.2 Exact per-engine error identity (measured)

| Engine | `err.name` | `err.message` (exact) | `Object.getOwnPropertyNames(err)` | `'cause' in err` |
| --- | --- | --- | --- | --- |
| Chromium 151 | `TypeError` | `Failed to fetch` | `["stack","message"]` | `false` |
| Firefox 153 | `TypeError` | `NetworkError when attempting to fetch resource.` | `["fileName","lineNumber","columnNumber","message"]` | `false` |
| WebKit 26.5 | `TypeError` | `Load failed` | `["message"]` | `false` |

Note the trailing full stop on Firefox's string, and that WebKit's error carries **no `stack` at all**.
Source of truth for each string:

- Chromium: `third_party/blink/renderer/core/fetch/fetch_manager.cc`, `V8ThrowException::CreateTypeError(isolate, "Failed to fetch")`.
- Firefox: `dom/bindings/Errors.msg` line 62:
  `MSG_DEF(MSG_FETCH_FAILED, 1, true, JSEXN_TYPEERR, "{0}NetworkError when attempting to fetch resource.")`
  (the `{0}` prefix slot is for a worker/context label, normally empty).
- WebKit: `Source/WebCore/Modules/fetch/FetchResponse.cpp` line 532, `"Load failed"_s`.

Do **not** branch product logic on these strings. Record them for the report, and detect the engine
separately. They have changed before and will again.

### 1.3 The same string for every cause (measured, 3 engines x 11 causes)

Every one of the following produced the identical `TypeError` with the identical message in its engine:

CORS-blocked GET, CORS-blocked preflighted POST, DNS NXDOMAIN (`.invalid` and a real-TLD nonexistent
subdomain), TCP connection refused on loopback, TCP connection refused on a named host, TLS expired
certificate, TLS self-signed certificate, TLS wrong-host certificate, mixed content block,
Chromium Local Network Access denial, and a request to an unroutable RFC1918 address.

`response.status`, `response.headers`, `response.statusText` are not merely masked; **there is no
`Response` object at all**, because the promise rejects. Nothing to inspect.

### 1.4 What genuinely *does* differ

Four things differ, and only four.

**(a) Timing.** Measured, 5 samples per class, warm connections, headless, one machine and one network.
Milliseconds:

| Failure class | Chromium 151 | Firefox 153 | WebKit 26.5 |
| --- | --- | --- | --- |
| Blocked before any network (mixed content, policy) | 0, 0, 0, 0, 0 | 0, 0, 0, 1, 0 | 1, 0, 0, 0, 0 |
| Loopback connection refused | 2, 1, 1, 1, 1 | 2, 3, 2, 2, 2 | 3, 3, 3, 3, 4 |
| CORS reject (live host, warm conn) | 111, 25, 22, 26, 24 | 119, 27, 26, 35, 32 | 74, 35, 26, 24, 32 |
| DNS NXDOMAIN | 44, 42, 39, 76, 41 | 66, 40, 41, 56, 46 | 52, 45, 42, 44, 49 |
| TLS certificate invalid | 525, 436, 437, 446, 431 | 439, 442, 432, 492, 588 | 443, 442, 442, 439, 438 |

Read this honestly. Timing cleanly separates **three bands**:

- **sub-5ms**: nothing left the machine (a policy block, or a loopback RST). Strong signal.
- **20 to 80ms**: a real network round trip happened or a real DNS query happened. **CORS-reject and
  DNS-NXDOMAIN overlap here and cannot be separated by timing.**
- **400ms and up on a *first* attempt**: consistent with a completed TLS handshake that was then
  rejected, but also with any slow link. Weak signal on its own.

Absolute numbers are machine and network dependent. Use timing to place a result in a band, never to
name a cause, and never show the user a millisecond number as if it were evidence.

**(b) Whether the rejection is a `TypeError` or a `DOMException`.** This is the one *structural*
discriminator that exists, and it is worth using. With `AbortSignal.timeout(2500)` against
`203.0.113.1` (TEST-NET-3, genuinely black-holed):

| Engine | `err.name` | `err.message` | `instanceof DOMException` | ms |
| --- | --- | --- | --- | --- |
| Chromium 151 | `TimeoutError` | `signal timed out` | `true` | 2502 |
| Firefox 153 | `TimeoutError` | `The operation timed out.` | `true` | 2502 |
| WebKit 26.5 | `AbortError` | `Fetch is aborted` | `true` | 2501 |

So `err instanceof TypeError` means "the network layer refused or was blocked" and
`err instanceof DOMException` means "we gave up waiting". Those are genuinely different diagnoses and
we can tell them apart. Note WebKit still reports `AbortError` rather than `TimeoutError`, so match on
`instanceof DOMException` rather than on `name === 'TimeoutError'`.

Counter-example worth knowing: `https://10.255.255.1/` (RFC1918) failed **fast** with a `TypeError`
in all three engines (26ms, 70ms, 31ms), not with a timeout. In Chromium that is Local Network Access
refusing it; elsewhere it is the OS returning no-route immediately. A private address does not reliably
produce a hang, so do not use "it hung" as your private-address test.

**(c) The DevTools console.** Rich, cause-specific, and **completely unreadable from page JavaScript**.
There is no API that exposes console output to the page. Captured verbatim for the teaching panel:

Chromium (net error codes appear in the console text):

```
net::ERR_NAME_NOT_RESOLVED
net::ERR_CONNECTION_REFUSED
net::ERR_CERT_DATE_INVALID
net::ERR_CERT_AUTHORITY_INVALID
net::ERR_CERT_COMMON_NAME_INVALID
net::ERR_FAILED
Access to fetch at 'https://example.com/' from origin 'https://viewer.example' has been blocked by
  CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource.
Access to fetch at 'http://localhost:5174/h' from origin 'https://viewer.example' has been blocked by
  CORS policy: Permission was denied for this request to access the `loopback` address space.
Mixed Content: The page at 'https://viewer.example/index.html' was loaded over HTTPS, but requested an
  insecure resource 'http://example.com/'. This request has been blocked; the content must be served
  over HTTPS.
```

Firefox:

```
Cross-Origin Request Blocked: The Same Origin Policy disallows reading the remote resource at
  https://example.com/. (Reason: CORS header ‘Access-Control-Allow-Origin’ missing). Status code: 200.
Cross-Origin Request Blocked: The Same Origin Policy disallows reading the remote resource at
  https://127.0.0.1:5173/…. (Reason: CORS request did not succeed). Status code: (null).
Blocked loading mixed active content “http://example.com/”
```

Firefox's console is the most useful of the three for a human, because `Status code: 200` versus
`Status code: (null)` is exactly the "server answered but sent no ACAO" versus "never got a response"
distinction. Our JS cannot read it, but **telling the user to look for that line, per browser, is a
real feature.**

WebKit:

```
A server with the specified hostname could not be found.
Could not connect to the server.
The certificate for this server is invalid.
Origin https://viewer.example is not allowed by Access-Control-Allow-Origin. Status code: 200
Preflight response is not successful. Status code: 405
[blocked] The page at https://viewer.example/index.html requested insecure content from
  http://localhost:5174/…. This content was blocked and must be served over HTTPS.
```

WebKit also surfaces a *second* signal: an uncaught page-level error
`… due to access control checks.` fires for access-control failures but **not** for DNS or
connection-refused failures. That is observable via `window.onerror` / `window.addEventListener('error')`
in Safari only, and it is undocumented behaviour that could vanish. Treat as a hint, never a verdict.

**(d) Resource Timing entries.** See § 2.5. Short version: nearly nothing, and inconsistent across
engines.

### 1.5 Reporting API and other navigator hooks: dead ends

`ReportingObserver` exists in all three engines (`typeof ReportingObserver !== 'undefined'` is `true`
everywhere), but the Reporting API is a framework for report types defined by *other* specs
(`deprecation`, `intervention`, `crash`, `csp-violation`, `coep`, `permissions-policy-violation`,
`integrity-violation`). **No report type covers a failed subresource fetch, a CORS block, a DNS
failure, or a TLS failure.** Network Error Logging (NEL) exists but is opt-in **by the origin being
fetched**, is delivered to *that* origin's collector, and is not readable by us.

Also confirmed unavailable or useless:

- `PerformanceObserver.supportedEntryTypes` contains no network-error entry type in any engine
  (Chromium: element, event, first-input, interaction-contentful-paint, largest-contentful-paint,
  layout-shift, long-animation-frame, longtask, mark, measure, navigation, paint, resource,
  soft-navigation, visibility-state).
- `navigator.connection` (Network Information API): Chromium only, and reports the *user's* link, which
  says nothing about the target.
- `window.onerror` / `unhandledrejection`: gives us the same `TypeError` we already have.
- `crossOriginIsolated` was `false` and `isSecureContext` `true` in all runs; neither helps.

One hook **is** worth calling: `navigator.permissions.query({name: 'local-network-access'})`.

| Engine | Result |
| --- | --- |
| Chromium 151 | resolves, `state: "prompt"` |
| WebKit 26.5 | throws `TypeError: Type error` |
| Firefox 153 | throws `TypeError: 'local-network-access' (value of 'name' member of PermissionDescriptor) is not a valid value for enumeration PermissionName.` |

That is a clean feature detection for "this browser has Local Network Access and will block loopback",
and the `state` tells us whether the user has already granted, denied, or not been asked. See § 5.3.

---

## 2. Legitimate client-side probes, with an honest verdict on each

### 2.1 `mode: 'no-cors'` opaque request

**What it does.** Fetch, § 2.2.5: no-cors mode "Restricts requests to using CORS-safelisted methods …
Upon success, fetch will return an **opaque filtered response**". Fetch § 2.2.6 defines that response
as type `"opaque"`, status 0, empty status message, header list « », body null.

**What it proves (measured).** The probe resolved with `type: "opaque"`, `status: 0`, `ok: false`,
`headers.keys()` empty, body length 0, for a target returning **404** and for a target returning **500**,
and rejected only when the exchange itself failed. So:

> A no-cors probe that **resolves** proves the DNS lookup, TCP connect, TLS handshake and HTTP exchange
> all completed. It proves nothing whatsoever about the status code or the body.

**What it does not prove.** It cannot distinguish 200 from 404 from 500, and a resolved no-cors probe on
`GET /` says nothing about whether `POST /manifest` will work.

**Three sharp caveats, all measured:**

1. **It does not bypass Chromium's Local Network Access.** `fetch('https://127.0.0.1:5173/n', {mode:'no-cors'})`
   from a public HTTPS origin was **rejected** in Chromium 151 with the LNA console message, while the
   identical call **resolved opaque** in Firefox and WebKit (and the request arrived at the server, per
   its log). So the reachability probe is silently unavailable for loopback and RFC1918 targets in
   Chrome. Any UI that says "the server did not answer" on the strength of a failed no-cors probe to a
   loopback address is **wrong in Chrome**.
2. **A no-cors GET sends no `Origin` header.** The server log recorded `origin=-` for the no-cors GET and
   `origin=https://viewer.example` for the CORS-mode GET. If the operator is grepping their log for our
   origin to confirm we reached them, tell them to grep the *path*, not the origin.
3. **A no-cors request drops non-safelisted headers rather than erroring.** Fetch defines the
   `request-no-cors` Headers guard so that only the "no-CORS-safelisted request-header names"
   (`Accept`, `Accept-Language`, `Content-Language`, `Content-Type`) survive, and `Content-Type` only
   with an essence of `application/x-www-form-urlencoded`, `multipart/form-data` or `text/plain`.
   Measured consequence: `fetch(url, {method:'POST', mode:'no-cors', headers:{'content-type':'application/json'}, body:'{}'})`
   resolved opaque, and the server saw a real POST (example.com answered 405). The
   `content-type: application/json` was **silently discarded**. A no-cors POST is therefore **not** a
   test of the real manifest request. Never present it as one.

**Verdict: use it, as a pure reachability probe, and label it exactly that. Disable it (or caveat it) for
loopback and private targets in Chromium.**

### 2.2 The preflight asymmetry: this is the good one

The real SHL manifest request is, per the spec, `POST` with `content-type: application/json`. Fetch's
CORS-safelisted request-header rule allows `content-type` only when the parsed MIME essence is
`application/x-www-form-urlencoded`, `multipart/form-data`, or `text/plain`. `application/json` is not
on that list, so the request is not CORS-safelisted, and HTTP fetch takes the preflight branch:

> **request's unsafe-request flag is set and either request's method is not a CORS-safelisted method or
> CORS-unsafe request-header names with request's header list is not empty** → … Let
> *corsWithPreflightResponse* be the result of running override fetch given "`http-fetch`", *fetchParams*,
> and true.

**Confirmed on the wire.** With the certificate trusted, the dev server's own log recorded:

```
OPTIONS /api/shl-manifest?bid=…A origin=https://viewer.example ct=- acrm=POST acrh=content-type
```

An `OPTIONS` preflight, `Access-Control-Request-Method: POST`, `Access-Control-Request-Headers: content-type`.
The server answered 200 with no CORS headers and the fetch rejected. WebKit's console names the exact
failure mode: `Preflight response is not successful. Status code: 405`.

**Therefore this probe pair is genuinely diagnostic:**

| no-cors GET | real CORS POST | Verdict |
| --- | --- | --- |
| resolves opaque | rejects | **Server is reachable and answering. It is not sending CORS headers (or is failing the preflight).** High confidence. |
| rejects | rejects | Nothing reached the server, or the browser blocked it before the network. Fall through to static analysis and § 5. |
| resolves opaque | resolves | Working. Any failure is above the transport (status code, passcode, JWE). |

This is the single most valuable network probe available to a backendless viewer, and the answer it gives
("reachable but no CORS") is also the single most common real-world SHL relay defect after localhost.
It costs two requests and no third parties.

**Caveat**: in Chromium, for a loopback or private target, both halves fail for the same LNA reason and
the table's second row is unreachable as a *conclusion*. Detect LNA first (§ 5.3) and say so instead.

### 2.3 Loading an `<img>` / `<script>` / `<link>` from the origin

**Verdict: do not build this. Measured, it discriminates nothing.**

Every failure produced `onerror`, and so did success-with-the-wrong-content-type:

| Probe | Chromium | WebKit |
| --- | --- | --- |
| `<img>` at a reachable URL returning HTML/JSON (404 page) | `error` @ 70ms | `error` @ 38ms |
| `<img>` at a DNS-NXDOMAIN host | `error` @ 40ms | `error` @ 46ms |
| `<img>` at a refused loopback port | `error` @ 1ms | `error` @ 3ms |
| `<img>` at the live self-signed loopback server | `error` @ 3ms | `error` @ 5ms |
| `<img>` at a genuine SVG on a CDN | `load` @ 32ms | `load` @ 59ms |
| `<script>` at a genuine JS file on a CDN | `load` @ 37ms | `load` @ 57ms |
| `<script>` / `<link>` at the live self-signed loopback server | `error` @ 3ms | `error` @ 4ms |

`onerror` fires for "host does not exist", "port refused", "cert invalid", and "server answered 404 with
an HTML body". Those are four completely different diagnoses and the probe gives one answer. The only
information it carries is the same timing band that a `no-cors` fetch already gives us, and `no-cors`
additionally tells us success-versus-failure honestly. **Element probes are strictly dominated.**

(There is one narrow legitimate use: if a manifest `files[].location` points at something we expect to be
an image, a successful `<img>` load proves it. That is not diagnosis, that is rendering.)

### 2.4 Timing signatures

Covered in § 1.4(a). Design rule: map a measured duration to one of three **bands** and let the band
adjust confidence in a hypothesis you already formed from static analysis or from the probe pair. Never
let timing be the primary evidence, and never print raw milliseconds as a finding.

### 2.5 Performance API / `performance.getEntriesByName()`

This is a real technique and it is worth knowing precisely how little it gives us here.

**Does a failed request get an entry?** Resource Timing § 3.2:

> Resources for which the fetch was initiated, but was later aborted (e.g. due to a network error) are
> included as `PerformanceResourceTiming` objects in the Performance Timeline, with their start and end
> timing.

> If a resource fetch was aborted due to a networking error (e.g. DNS, TCP, or TLS error), then the fetch
> will be included as a `PerformanceResourceTiming` object in the Performance Timeline with only the
> `startTime`, `fetchStart`, `duration` and `responseEnd` set.

> If a resource fetch is aborted because it failed a fetch precondition (e.g. mixed content, CORS
> restriction, CSP policy, etc), then this resource will **not** be included as a
> `PerformanceResourceTiming` object in the Performance Timeline.

**Measured reality diverges from the spec and from itself, per engine:**

| Case | Chromium 151 | Firefox 153 | WebKit 26.5 |
| --- | --- | --- | --- |
| DNS NXDOMAIN | entry, all fields 0 | entry, all fields 0 | **no entry** |
| Connection refused | entry, all fields 0 | entry, all fields 0 | **no entry** |
| TLS cert invalid | entry, all fields 0 | entry, all fields 0 | **no entry** |
| CORS reject (a real response arrived) | entry, all fields 0 | entry, all fields 0 | **no entry** |
| Mixed-content block (a precondition) | **entry** (duration 0) | no entry | **no entry** |
| LNA denial (Chromium only) | entry, all fields 0 | n/a | n/a |
| Opaque (no-cors) success | entry, fields masked | entry, fields masked | entry, fields masked |

Two usable observations and one trap:

- **Trap**: Chromium creates an entry for a mixed-content block, which Resource Timing § 3.2 says it must
  not. Do not implement "no entry means a precondition blocked it"; it is false in Chrome and vacuously
  true in Safari.
- **Usable, WebKit only**: in Safari, an entry existing for the URL implies a response arrived. Combined
  with § 2.2 that is a free confirmation, but it is engine-specific and undocumented.
- **Usable, all engines**: for an *opaque* response the entry's `duration` is real and unmasked, which
  gives a slightly better timing measurement than wall-clock around the `await`.

**What Timing-Allow-Origin unlocks, and why it does not help us.** Resource Timing § 3.5.1:

> If the timing allow check algorithm fails for a cross-origin resource, the entry will be an opaque
> entry. Such entries have most of their attributes masked in order to prevent leaking cross-origin data
> that isn't otherwise exposed.

masking `redirectStart`, `redirectEnd`, `workerStart`, `domainLookupStart`, `domainLookupEnd`,
`connectStart`, `connectEnd`, `requestStart`, `firstInterimResponseStart`,
`finalResponseHeadersStart`, `responseStart`, `secureConnectionStart`, and `nextHopProtocol`; and

> Some of the properties, like `contentType`, `encodedBodySize`, and `decodedBodySize` are set to zero
> (or the empty string in the case of `contentType`) when the response is CORS-cross-origin.

Measured against `cdn.jsdelivr.net` (which does send `Timing-Allow-Origin: *`) versus `unpkg.com`
(which sends `Access-Control-Allow-Origin: *` but **no** TAO). Chromium:

| Attribute | TAO present (jsdelivr) | TAO absent (unpkg) |
| --- | --- | --- |
| `nextHopProtocol` | `"h2"` | `""` |
| `transferSize` | `596` | `0` |
| `encodedBodySize` | `296` | `0` |
| `decodedBodySize` | `578` | `0` |
| `domainLookupStart` / `End` | `4296` / `4299` | `0` / `0` |
| `connectStart` / `End` | `4299` / `4719` | `0` / `0` |
| `secureConnectionStart` | `4520` | `0` |
| `requestStart` / `responseStart` | `4719` / `4756` | `0` / `0` |
| `responseStatus` | `200` | **`200`** |
| `contentType` | `"application/json"` | **`"application/json"`** |

So `responseStatus` and `contentType` survive without TAO, because the response was CORS-readable anyway;
TAO is what unlocks the *phase* timings and the byte sizes. WebKit gave phase timings and
`nextHopProtocol: "h2"` with TAO but left all three size fields at 0 (unimplemented), and for an
**opaque** response with TAO present WebKit still populated `nextHopProtocol` while Chromium zeroed
everything.

**Verdict: Resource Timing is a dead end for diagnosis.** No SHL relay sends `Timing-Allow-Origin`; a
failed request's entry is all zeros in every engine that creates one; and the one non-zero field on a
successful cross-origin read (`responseStatus`) is only available when the fetch already succeeded, in
which case we did not need it. Build the reader (it is five lines and free) to enrich the *report* for a
target that happens to send TAO, and do not put a verdict behind it.

### 2.6 DNS-over-HTTPS against a public CORS-enabled resolver

**Confirmed CORS-accessible from the browser in all three engines** (not just from curl). Both resolvers
answered a page at `https://viewer.example` with `type: "cors"`, `status: 200`, and a readable body.

Cloudflare, exact request:

```http
GET https://cloudflare-dns.com/dns-query?name=viewer.tcpdev.org&type=A
accept: application/dns-json
```

Response headers include `access-control-allow-origin: *` and `content-type: application/dns-json`.
`accept` is a CORS-safelisted request-header name with no value restriction beyond forbidding
CORS-unsafe bytes, so **this triggers no preflight**. (For completeness, the preflight is answered anyway:
an `OPTIONS` with `Origin` and `Access-Control-Request-Method: GET` returns `access-control-allow-origin: *`,
`access-control-allow-methods: POST, GET`, `access-control-allow-headers: accept`.)

Google, exact request, no custom header needed:

```http
GET https://dns.google/resolve?name=viewer.tcpdev.org&type=A
```

also `access-control-allow-origin: *`, `content-type: application/json; charset=UTF-8`.

Response shape (both): `Status` is the DNS RCODE. `0` = NOERROR, `3` = NXDOMAIN. `Answer` is an array of
`{name, type, TTL, data}` with `type: 1` for A and `28` for AAAA.

Measured results:

```
viewer.tcpdev.org  -> Status 0, Answer: 65.9.142.41, 65.9.142.20, 65.9.142.59, 65.9.142.71
localhost          -> Status 3 (NXDOMAIN), Authority: SOA from the root
my-laptop          -> Status 3
foo.local          -> Status 3
api.internal       -> Status 3
kubernetes.default.svc -> Status 3
```

**The killer caveat: wildcard DNS on tunnel and preview providers means resolution proves nothing.**
Measured against Cloudflare DoH, for hostnames that certainly do not exist:

| Hostname pattern | Resolves? |
| --- | --- |
| `random-does-not-exist-9x8y.ngrok.io` | **yes (wildcard)** |
| `random-9x8y.ngrok-free.app` | **yes (wildcard)** |
| `random-9x8y.loca.lt` | **yes (wildcard)** |
| `random-9x8y.vercel.app` | **yes (wildcard)** |
| `random-9x8y.netlify.app` | **yes (wildcard)** |
| `random-9x8y.github.dev`, `random-9x8y.app.github.dev` | **yes (wildcard)** |
| `random-9x8y.gitpod.io` | **yes (wildcard)** |
| `random-9x8y.devtunnels.ms` | **yes (wildcard)** |
| `random-9x8y.serveo.net`, `random-9x8y.localhost.run` | **yes (wildcard)** |
| `random-9x8y.trycloudflare.com` | no (NXDOMAIN) |
| `random-9x8y.ts.net` | no (NXDOMAIN) |
| `random-9x8y.bore.pub`, `random-9x8y.pinggy.link` | no (NXDOMAIN) |

So for the hosts most likely to appear in a connectathon SHL, a positive DoH answer is worthless. Use DoH
**only** for its negative and its disambiguating results:

- `Status: 3` on a public resolver plus a failed fetch ⇒ "this name does not exist in public DNS", which
  is a genuine, high-confidence, useful verdict.
- `Status: 0` plus a failed fetch ⇒ "the name resolves publicly, so this is not a DNS problem", and then
  only if the host is not on the wildcard list above.
- `Status: 0` where the answer is an RFC1918 / loopback / CGNAT address ⇒ **very** informative: the name
  is public but points somewhere only reachable from a particular network. This is a real and
  under-diagnosed failure (split-horizon DNS, a `*.local.example.org` pointing at `10.x`), and DoH is the
  only way a browser can see it.

**Privacy and disclosure.** A DoH lookup sends the manifest **hostname** to Cloudflare or Google. That is
an outbound disclosure to a third party of a fact about a health-data capability URL. It must be:

- **off by default**, behind an explicit control labelled with the provider name;
- **hostname only**, never the path or query (the manifest URL's path is the capability);
- never carrying the `key` fragment under any circumstance;
- disclosed in the UI at the point of the toggle, naming the service, saying what is sent and when.

### 2.7 Certificate Transparency and other public services to confirm a host exists

**crt.sh: dead.** Measured from all three browsers: `https://crt.sh/json?q=…` rejected with the standard
CORS error in each. The server sends **no** `Access-Control-Allow-Origin` header at all (confirmed by
curl on three endpoint spellings), and at time of writing it also answers 502 / 404 depending on the
path. Not usable, and not worth revisiting.

**api.certspotter.com: CORS-enabled but useless for this.** It does send `Access-Control-Allow-Origin: *`
and was readable from all three browsers. But measured:

```
GET https://api.certspotter.com/v1/issuances?domain=viewer.tcpdev.org&include_subdomains=false&expand=dns_names
  -> 200, body "[\n]\n"   (empty)
GET https://api.certspotter.com/v1/issuances?domain=localhost&…
  -> 200, body "[\n]\n"   (empty)
```

An empty array for a host that demonstrably exists and serves TLS (it is covered by a wildcard cert, so
there is no CT entry under that exact name) and an empty array for `localhost`. **Absence of CT records
does not mean the host does not exist**: wildcard certificates, private CAs, and internal PKI all produce
nothing. A CT lookup can only ever produce a weak positive, and a weak positive we do not need because
DoH already gives a stronger one.

**Verdict: no CT service earns a place in the product.** Note it in the docs so nobody re-litigates it.

**Generic "is this host up" checkers** (allorigins, downforeveryoneorjustme-style services, CORS proxies
we do not control): reject on principle. Sending an SHL manifest URL to an arbitrary third party
discloses the location of a health-data capability to a party the user did not choose, for a signal we
can obtain more honestly. Do not build it and do not offer it as a convenience.

### 2.8 Summary of the probe budget

| Probe | Requests | Third parties | Discriminating power |
| --- | --- | --- | --- |
| Static URL analysis (§ 3) | 0 | none | **High.** Catches most real event failures. |
| `TypeError` versus `DOMException` | 0 extra | none | Medium. Separates blocked/refused from timed out. |
| Timing band | 0 extra | none | Low to medium. Adjusts confidence only. |
| `no-cors` GET + real CORS POST pair | 2 | none | **High.** "Reachable but no CORS" is the key verdict. |
| `navigator.permissions.query('local-network-access')` | 0 | none | **High**, for the Chromium loopback case specifically. |
| Resource Timing read | 0 extra | none | Near zero. Enrich the report, never a verdict. |
| DoH lookup (opt-in) | 1 | Cloudflare or Google | Medium. Strong on NXDOMAIN and on private-IP answers. |
| Element load probes | 3+ | none | **Zero.** Do not build. |
| CT lookup | 1 | SSLMate | **Zero.** Do not build. |

---

## 3. Static reasoning: no network at all

This is where the product wins. The motivating incident needed **zero** network requests to diagnose.

Parse the `shlink:/` payload, read `url`, and run this ordered rule set. First match wins. Every verdict
below is written to be shown to the user verbatim, in one line, with the offending substring highlighted.

### 3.1 Ordered rule table

Ordering matters: a scheme problem inside a localhost URL should still be reported as localhost, because
that is the fatal fact.

| # | Test on the manifest URL | Tier | User-facing verdict (verbatim) |
| --- | --- | --- | --- |
| 1 | Not a valid absolute URL (`new URL()` throws) | Certain | **This is not a URL.** The link's `url` field is `"…"`, which does not parse as an absolute URL, so no client can fetch it. |
| 2 | Scheme is not `http:` or `https:` | Certain | **Wrong scheme.** The manifest URL uses `…:`. A SMART Health Link manifest must be fetched over HTTP(S); nothing else can be fetched by a browser or by curl. |
| 3 | Host is `localhost`, `localhost.`, or ends `.localhost` / `.localhost.` | Certain | **This link points at localhost, so it can only ever open on the machine that made it.** `localhost` means "this computer" to whoever opens the link, so every other person's device looks for the manifest on their own machine and finds nothing. Re-issue the link with a hostname or address that is reachable from outside your machine. |
| 4 | Host is an IPv4 literal in `127.0.0.0/8` | Certain | **This link points at the loopback address `127.x.x.x`, so it can only ever open on the machine that made it.** (same body as #3) |
| 5 | Host is `[::1]` or `0:0:0:0:0:0:0:1` | Certain | **This link points at the IPv6 loopback address `::1`, so it can only ever open on the machine that made it.** |
| 6 | Host is `0.0.0.0` or `[::]` | Certain | **`0.0.0.0` is a "listen on everything" address, not a destination.** A server binds to it; a client cannot connect to it. The sender needs to substitute the machine's actual reachable address or hostname. |
| 7 | Host is an IPv4 literal in `10.0.0.0/8`, `172.16.0.0/12`, or `192.168.0.0/16` (RFC 1918) | Certain | **This is a private network address (`…`).** It is only reachable from inside the sender's own network, so it will fail for anyone on a different network, including everyone on conference wifi. |
| 8 | Host is an IPv4 literal in `169.254.0.0/16` (link-local) or IPv6 `fe80::/10` | Certain | **This is a link-local address (`…`), which a device assigns itself when it has no network.** It is not routable and cannot be reached by anyone else. |
| 9 | Host is an IPv4 literal in `100.64.0.0/10` (CGNAT, and the range Tailscale hands out) | Certain | **This is a carrier-grade NAT / private overlay address (`…`).** It is reachable only from inside the same NAT or VPN mesh (for example the same Tailscale tailnet), not from the public internet. |
| 10 | Host is an IPv6 literal in `fc00::/7` (unique local) | Certain | **This is an IPv6 unique local address (`…`), the IPv6 equivalent of a private range.** It is not reachable from outside the sender's network. |
| 11 | Host is an IPv4 literal in `198.18.0.0/15` | Certain | **This is a benchmarking-only address range (`198.18.x.x`).** It is not a real destination. |
| 12 | Host is an IPv4 literal in `192.0.2.0/24`, `198.51.100.0/24`, or `203.0.113.0/24` (TEST-NET) | Certain | **This is a documentation-only example address (`…`).** It is reserved by RFC 5737 for docs and never routes anywhere. This looks like a placeholder that was never filled in. |
| 13 | Host ends in `.local` or `.local.` | Certain | **`.local` is a multicast DNS name (Bonjour / Avahi) that only resolves on the sender's own local network segment.** It cannot be resolved from anywhere else. |
| 14 | Host ends in `.internal`, `.home.arpa`, `.lan`, `.intranet`, `.corp`, `.private`, `.home`, or `.localdomain` | Certain | **`…` is a private-use domain suffix that only resolves inside a particular network.** Nobody outside that network can resolve it. |
| 15 | Host ends in `.invalid`, `.test`, or `.example` | Certain | **`…` is a reserved name that is guaranteed never to resolve** (RFC 2606 / RFC 6761). This looks like a placeholder. |
| 16 | Host is a bare hostname with no dot and is not an IP literal (for example `my-laptop`, `shl-server`) | Certain | **`…` is a single-label hostname with no domain.** It resolves only through the sender's local DNS suffix or hosts file, so it means nothing on anyone else's machine. |
| 17 | Host ends in a known ephemeral tunnel or preview suffix (`.ngrok.io`, `.ngrok-free.app`, `.ngrok.app`, `.trycloudflare.com`, `.loca.lt`, `.serveo.net`, `.localhost.run`, `.bore.pub`, `.pinggy.link`, `.devtunnels.ms`, `.github.dev`, `.gitpod.io`, `.ts.net`, `.tail****.ts.net`) | Very likely | **This is a temporary tunnel address (`…`).** Tunnel hostnames are re-issued on every restart and usually die within hours, so a link built on one stops working as soon as the sender's tunnel does. If this link needs to outlive the session, host the manifest somewhere stable. |
| 18 | Host matches a preview-deployment pattern (`*.vercel.app` with a hash-looking label, `*-git-*.vercel.app`, `*.netlify.app` deploy-preview form, `*.pages.dev` with a hash label, `*.onrender.com`) | Possible | **This looks like a preview deployment (`…`).** Preview URLs are frequently torn down or gated behind an authentication wall that a third-party viewer cannot pass. |
| 19 | Scheme is `http:` and the host is **not** loopback/localhost | Certain | **The manifest URL is plain `http://`.** A viewer served over HTTPS is not allowed to fetch it: the browser blocks it as mixed content before any request leaves the machine. Re-issue the link over `https://`. |
| 20 | Scheme is `https:` and the port is a well-known dev-server port: `3000`, `3001`, `4200`, `5000`, `5173`, `5174`, `8000`, `8080`, `8081`, `8888`, `9000` | Possible (raise to Very likely if combined with #17 or a bare host) | **Port `…` is a development-server default** (`5173` is Vite, `3000` is Next.js / Express, `4200` is Angular, `8080` is a common local proxy). That is not fatal on its own, but it is a strong hint the link was generated against a dev server rather than a deployed one. |
| 21 | URL has a fragment (`#…`) | Certain | **The manifest URL contains a `#` fragment.** Fragments are never sent to the server, so anything after the `#` is silently dropped. If it carries meaning, it is already lost. |
| 22 | Host is an IP literal (any public one) with `https:` | Possible | **The manifest URL uses a raw IP address over HTTPS.** Public certificates are almost never issued for bare IP addresses, so the TLS handshake will usually fail with a hostname-mismatch error for everyone. |
| 23 | Host has a trailing dot and scheme is `https:` (for example `relay.example.com.`) | Possible | **The hostname has a trailing dot (`…`).** It resolves, but many TLS stacks will not match it against the certificate, so this can fail for some clients and not others. |
| 24 | Userinfo present (`https://user:pass@host/…`) | Certain | **The manifest URL contains embedded credentials.** `fetch()` rejects URLs with credentials, and they should never appear in a shared link. |
| 25 | `url` is present but empty, or is a relative path | Certain | **The manifest URL is relative (`…`).** A SMART Health Link's `url` must be absolute; a relative path has no meaning to a recipient. |

### 3.2 Reference: the address blocks, and where they are defined

The classification in rules 3 to 12 is not our invention. Private Network Access, § 2.1 ("Non-public IP
address blocks") assigns:

**`local` address space** (the spec's word for "this device"):

| Block | Name |
| --- | --- |
| `127.0.0.0/8` | IPv4 loopback |
| `::1/128` | IPv6 loopback |
| `198.18.0.0/15` | Benchmarking |

**`private` address space** ("meaning only within the current network"):

| Block | Name |
| --- | --- |
| `10.0.0.0/8` | RFC 1918 private use |
| `100.64.0.0/10` | Carrier-grade NAT |
| `172.16.0.0/12` | RFC 1918 private use |
| `192.168.0.0/16` | RFC 1918 private use |
| `169.254.0.0/16` | Link local |
| `fc00::/7` | IPv6 unique local |
| `fe80::/10` | IPv6 link-local unicast |

**`public`**: "contains all other addresses. In other words, addresses whose target is the same for all
devices globally on the IP network."

That last sentence is the exact concept the tool is testing for, and it is worth quoting in the UI: an
SHL is only shareable if its manifest URL's target "is the same for all devices globally".

`localhost` itself is handled by name, per Secure Contexts § 3.1, whose "is origin potentially
trustworthy" algorithm treats as trustworthy any origin whose host "is `localhost` or `localhost.`" or
"ends with `.localhost` or `.localhost.`". Match the same set, including the trailing dots and the
`.localhost` suffix, or `foo.localhost:5173` slips through.

### 3.3 Implementation notes

- Parse with `new URL()`, then classify `url.hostname`. `URL` normalises IPv6 to bracketed lowercase and
  strips a default port, so compare against `url.port === ''` rather than looking for `:443`.
- `URL` does **not** normalise IPv4 shorthand consistently across the forms people actually type. Handle
  `127.1`, `127.0.1`, `0x7f000001`, `2130706433`, and `[::ffff:127.0.0.1]` explicitly, or a loopback URL
  written in shorthand escapes rule 4. This matters: `http://127.1:5173` is a real thing people paste.
- Do rules 3 to 16 before any fetch, and **when one of them matches, do not fetch at all.** Firing a
  request you know cannot succeed adds latency and a scary console error, and teaches the user nothing.
- Show the verdict with the offending substring marked in the URL itself. "This link points at
  localhost" lands much harder when `localhost` is highlighted in the URL directly above it.

---

## 4. The escape hatch: hand the check to the user

We cannot proxy. So when the browser is structurally unable to answer, the product's job is to hand over
a command that answers it, and an offline mode that needs no network at all.

### 4.1 curl (exercised against a real manifest endpoint before publishing)

Copyable, one line per header, with a timing and IP breakdown so the user learns *where* it failed:

```bash
curl -sS -D- -o /dev/null \
  -X POST 'https://relay.example.org/api/shl-manifest?bid=4836470' \
  -H 'content-type: application/json' \
  -H 'accept: application/json' \
  --data '{"recipient":"SHL Loupe (manual check)","embeddedLengthMax":100000}' \
  -w '\n-- http=%{http_code} ip=%{remote_ip}:%{remote_port} http_version=%{http_version} dns=%{time_namelookup}s tcp=%{time_connect}s tls=%{time_appconnect}s ttfb=%{time_starttransfer}s total=%{time_total}s bytes=%{size_download}\n'
```

Verified output shape against the test manifest endpoint:

```
HTTP/1.1 200 OK
content-type: application/json
...
-- http=200 ip=127.0.0.1:5173 http_version=1.1 dns=0.000106s tcp=0.000676s tls=0.048604s ttfb=0.052674s total=0.052817s bytes=85
```

Why this exact shape:

- `-sS` suppresses the progress meter but **keeps** errors. Plain `-s` hides the failure, which is the
  opposite of what we want here.
- `-D-` dumps response headers to stdout. This is the whole point: the user gets to see the status code
  and the (absent) `access-control-allow-origin`, which the browser refused to show us.
- `-w` with the timing set localises the failure to DNS, TCP, TLS or the application, which maps directly
  onto our own timing bands.
- `-o /dev/null` when you want headers only. Swap for `| jq .` when you want the body:

```bash
curl -sS -X POST 'https://relay.example.org/api/shl-manifest?bid=4836470' \
  -H 'content-type: application/json' \
  --data '{"recipient":"SHL Loupe (manual check)"}' | jq '{fileCount: (.files|length), files: [.files[] | {contentType, hasEmbedded: (has("embedded")), location}]}'
```

Add these as clearly-labelled variants, never as the default:

- **CORS check without the browser** (this is the command that proves "reachable but no CORS"):
  ```bash
  curl -sS -D- -o /dev/null -X OPTIONS 'https://relay.example.org/api/shl-manifest?bid=4836470' \
    -H 'Origin: https://loupe.example' \
    -H 'Access-Control-Request-Method: POST' \
    -H 'Access-Control-Request-Headers: content-type'
  ```
  Tell the user what to look for: an `access-control-allow-origin` echoing their origin or `*`, an
  `access-control-allow-methods` containing `POST`, and an `access-control-allow-headers` containing
  `content-type`. Missing any one of those is the failure.
- **Ignore certificate problems**, `-k`, labelled exactly as "this tells curl to accept an untrusted
  certificate. If the request only works with `-k`, the certificate is the problem and no browser will
  ever accept this link."
- **Passcode present** (`P` flag): add `"passcode":"…"` to the body and warn that a wrong passcode
  decrements `remainingAttempts` on the server and can permanently disable the link. Never auto-retry.

### 4.2 PowerShell (Windows users, and there are always several)

```powershell
$body = @{ recipient = 'SHL Loupe (manual check)'; embeddedLengthMax = 100000 } | ConvertTo-Json -Compress
try {
  $r = Invoke-WebRequest -Uri 'https://relay.example.org/api/shl-manifest?bid=4836470' `
        -Method POST -ContentType 'application/json' -Body $body -SkipHttpErrorCheck
  "status : $($r.StatusCode)"
  "acao   : $($r.Headers['Access-Control-Allow-Origin'])"
  $r.Content | ConvertFrom-Json | ConvertTo-Json -Depth 6
} catch {
  "FAILED : $($_.Exception.Message)"
  if ($_.Exception.InnerException) { "inner  : $($_.Exception.InnerException.Message)" }
}
```

Notes to ship alongside it:

- `-SkipHttpErrorCheck` requires PowerShell 7+. Without it, a 401 or 404 throws instead of returning, and
  the user never sees the `remainingAttempts` body. If they are on Windows PowerShell 5.1, tell them to
  drop that flag and read `$_.Exception.Response` in the catch, or to use curl (which ships in Windows 10
  and later).
- `-SkipCertificateCheck` is the `-k` equivalent, with the same warning.
- The inner-exception line is what surfaces the actual TLS or DNS reason on .NET, which is more than the
  browser gave us.

### 4.3 Offline paste mode: the full pipeline, zero network

**This is the highest-value feature in this whole document after the static rules.** A viewer that can
run its entire decrypt-and-render pipeline over pasted text works when the relay is down, when CORS is
broken, when the URL is localhost, on a locked-down conference network, and behind an air gap. It also
turns every failure into something still useful: "I cannot fetch this, but if you run the curl command
above and paste the output here, I will show you the contents."

Accept, in one textarea, with sniffing rather than a mode picker:

| Pasted text | Detection | Action |
| --- | --- | --- |
| Starts `shlink:/` or contains `#shlink:/` | prefix | Decode the payload, run § 3 static analysis, show the parsed fields |
| Parses as JSON with a `files` array | shape | Treat as a manifest response; decrypt each `embedded`; list each `location` as un-fetchable-here with a curl command |
| Five dot-separated base64url segments with an empty second segment | shape | Treat as an SHL JWE compact serialization; decrypt with the pasted or remembered key |
| Three dot-separated segments | shape | A JWS, so almost certainly a SMART Health Card (`application/smart-health-card`) rather than an SHL file; route to the card path |
| Parses as JSON with `resourceType` | shape | Already-decrypted FHIR; render directly |
| Raw curl output beginning `HTTP/` | prefix | Split headers from body, report the status and the CORS headers, then treat the body as one of the above |

**The decrypt path, verified end to end.** This is WebCrypto only, no JOSE library, and it was run against
a freshly minted spec-shaped JWE (`alg: dir`, `enc: A256GCM`, `cty: application/fhir+json`), including a
`zip: DEF` variant:

```js
const b64u = {
  dec: s => Uint8Array.from(
    atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice(0, (4 - s.length % 4) % 4)),
    c => c.charCodeAt(0)),
};
const td = new TextDecoder(), te = new TextEncoder();

async function decryptShlFile(compact, keyB64u) {
  const p = compact.split('.');
  if (p.length !== 5) throw new Error(`not a compact JWE: ${p.length} dot-separated parts, expected 5`);
  const [hdrB64, encryptedKey, ivB64, ctB64, tagB64] = p;

  // Structural pre-checks. These are what let us say something specific,
  // because the decrypt itself fails opaquely (see below).
  const hdr = JSON.parse(td.decode(b64u.dec(hdrB64)));
  if (hdr.alg !== 'dir')     throw new Error(`unsupported "alg": ${hdr.alg} (SHL requires "dir")`);
  if (hdr.enc !== 'A256GCM') throw new Error(`unsupported "enc": ${hdr.enc} (SHL requires "A256GCM")`);
  if (encryptedKey !== '')   throw new Error('"dir" requires an empty JWE Encrypted Key, got a value');

  const raw = b64u.dec(keyB64u);
  if (raw.length !== 32)
    throw new Error(`key is ${raw.length} bytes, A256GCM needs 32 (43 base64url characters)`);

  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
  const ct = b64u.dec(ctB64), tag = b64u.dec(tagB64);
  const ctTag = new Uint8Array(ct.length + tag.length);
  ctTag.set(ct, 0); ctTag.set(tag, ct.length);

  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64u.dec(ivB64), additionalData: te.encode(hdrB64), tagLength: 128 },
    key, ctTag);

  let bytes = new Uint8Array(pt);
  if (hdr.zip === 'DEF') {
    bytes = new Uint8Array(await new Response(
      new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'))
    ).arrayBuffer());
  }
  return { header: hdr, text: td.decode(bytes) };
}
```

Three details that are easy to get wrong and were checked:

1. **The AAD is the base64url-encoded protected header string, not the decoded JSON.** Pass
   `te.encode(hdrB64)`, the raw first segment exactly as it appeared. Getting this wrong produces the same
   opaque `OperationError` as a wrong key.
2. **WebCrypto's AES-GCM wants ciphertext and tag concatenated**, in that order, with `tagLength: 128`.
   JWE transmits them as separate segments. Concatenate, do not pass the tag separately.
3. **`zip: DEF` is raw DEFLATE, so `DecompressionStream('deflate-raw')`**, not `'deflate'`. Verified
   round-trip. `'deflate'` expects a zlib header and fails.

**And the reason the structural pre-checks matter so much:** the decrypt layer is exactly as opaque as
`fetch` is. Measured, a wrong key and a truncated ciphertext produce the *identical* error:

```
WRONG KEY  -> DOMException | OperationError | "The operation failed for an operation-specific reason"
TRUNCATED  -> DOMException | OperationError | "The operation failed for an operation-specific reason"
```

So the same design principle applies twice over: **check everything checkable before the opaque call, so
that when the opaque call fails you have already eliminated the alternatives.** After the pre-checks
above, an `OperationError` means precisely one of "the key does not match this ciphertext" or "the
ciphertext or tag has been altered in transit", and the tool can say exactly that, plus the most common
real cause: the `key` was copied from a different link than the file, or the compact string lost
characters to a chat client's line wrapping.

Also worth pre-checking and reporting, since it is free: the `key` field's length. Per the spec, `key` is
"43 characters, consisting of 32 random bytes base64urlencoded" (verified: a 32-byte key encodes to
exactly 43 base64url characters). A key of any other length is a certain diagnosis before any crypto runs.

### 4.4 Letting the user point at their own CORS proxy

Offer it, gated, and design it so the key cannot leak.

**The hard rule: the proxy carries the manifest POST only, and never the `key`.** The SHL payload's `key`
is the decryption key for the health data. The manifest fetch does not need it, and the JWE decryption is
local. So the architecture is:

```
  browser --(via user's proxy)--> relay        : the manifest POST, and the files[].location GETs
  browser --(never leaves the page)-->         : the shlink `key`, and every decrypt
```

Enforce it in code, not in a comment: keep the `key` in a variable that the proxy request builder has no
access to, and add a test that asserts the outgoing proxied request's URL, headers and body contain
neither the key nor the raw `shlink:/` payload (which embeds the key).

Warnings the UI must carry, in this order:

1. **"Your proxy will see the manifest URL and everything the relay sends back, including the encrypted
   files."** The ciphertext is not readable without the key, but the proxy operator learns that this link
   exists, where it lives, and how big the payload is.
2. **"The decryption key never leaves this page."** Say it, and mean it.
3. **"Only use a proxy you run yourself."** A public CORS proxy is an unknown party in the middle of a
   health-data exchange.
4. **"A working result through a proxy does not mean the link works."** This is the important one. If the
   link only loads via a proxy, the finding is "the relay does not send CORS headers", and the fix belongs
   on the relay, not in the viewer. Report it as a **defect found**, not as a success. Otherwise the tool
   quietly teaches people to ship broken relays, which is the opposite of its purpose.

For the proxy to be usable it must return `Access-Control-Allow-Origin` for our origin and allow `POST`
plus a `content-type` request header. Give a minimal known-good config in the docs (a `Caddyfile` snippet
and a `cloudflared`/Worker snippet are the two people actually have to hand), so "run your own" is a
five-minute task and not a research project.

---

## 5. The specific claim: can an HTTPS page fetch `https://localhost:5173`?

This is the incident. The answer has three independent layers, and **all three must pass**. Measured, not
reasoned.

### 5.1 Mixed content: localhost is exempt, so this layer passes for `https` and is nuanced for `http`

Secure Contexts § 3.1, "is origin potentially trustworthy", returns `Potentially Trustworthy` when:

> **Step 4**: If origin's host matches one of the CIDR notations `127.0.0.0/8` or `::1/128` …

> **Step 5**: If the user agent conforms to the name resolution rules in \[let-localhost-be-localhost\]
> and one of the following is true: origin's host is "`localhost`" or "`localhost.`"; origin's host ends
> with "`.localhost`" or "`.localhost.`" then return "`Potentially Trustworthy`".

Mixed Content § 2 defines "an *a priori* authenticated URL is equivalent to a potentially trustworthy
URL", and § 4.4's "should fetching request be blocked as mixed content?" returns **allowed** when the
URL is potentially trustworthy. So `https://localhost:5173` is trivially fine at this layer, and even
`http://localhost:5173` is *specified* to be allowed.

**Measured, and the engines disagree about `http://localhost`:**

| Request from `https://viewer.example` | Chromium 151 | Firefox 153 | WebKit 26.5 |
| --- | --- | --- | --- |
| `http://example.com/` | **blocked as mixed content** (`Mixed Content: … This request has been blocked`) | **blocked** (`Blocked loading mixed active content`) | **blocked** (`[blocked] … requested insecure content`) |
| `http://localhost:5174/` (server live) | not mixed-content blocked; goes to the LNA layer instead | **not blocked; the request arrived at the server** | **blocked as mixed content** (`[blocked] … requested insecure content from http://localhost:5174/…`) |
| `http://127.0.0.1:5174/` (server live) | not mixed-content blocked; goes to the LNA layer | **not blocked; request arrived** | **blocked as mixed content** |

So Safari does **not** implement the potentially-trustworthy exemption for mixed content and blocks
`http://localhost` outright, while Firefox permits it and Chromium routes it to Local Network Access
instead. Three engines, three behaviours, one identical `TypeError`. This is a good example for the
teaching panel and a reason the tool must never say "the browser blocked this as mixed content" unless the
scheme is `http:` and the host is public (rule 19), where all three agree.

### 5.2 The certificate: this is what actually killed the incident

With the dev server live on `https://127.0.0.1:5173` presenting a self-signed certificate (CN=localhost,
SAN `DNS:localhost, IP:127.0.0.1`):

| Engine | Result | Console |
| --- | --- | --- |
| Chromium 151 | `TypeError: Failed to fetch` @ 30ms | `net::ERR_CERT_AUTHORITY_INVALID` |
| WebKit 26.5 | `TypeError: Load failed` @ 20ms | `The certificate for this server is invalid.` |
| Firefox 153 | `TypeError: NetworkError when attempting to fetch resource.` | certificate error |

**The server's own request log recorded zero arriving requests.** Not one byte from any browser. And
`curl` without `-k` gives `curl: (60) SSL certificate problem: self signed certificate`.

The critical point: **being a potentially trustworthy origin does not exempt localhost from certificate
validation.** `https://localhost` gets the full chain check like any other host. A self-signed or
`mkcert`-rooted certificate works only where that root is in the trust store, which is the sender's
machine and nowhere else. This is the mechanism by which "it worked on my machine" is *literally true*
and useless.

There is no fix available to a viewer. The user must either trust the certificate (impossible to ask of a
connectathon audience) or the sender must re-issue the link.

### 5.3 Local Network Access: as of Chrome 142, loopback is blocked outright

This is the newest and least-known layer, and it now dominates the others in Chrome.

With the certificate error removed (`ignoreHTTPSErrors`), so that the only remaining obstacle is policy,
Chromium 151 headless refused **every** loopback request from the public HTTPS origin:

```
Access to fetch at 'https://localhost:5173/api/shl-manifest?bid=…' from origin 'https://viewer.example'
  has been blocked by CORS policy: Permission was denied for this request to access the `loopback`
  address space.
```

Measured, all four refused, server log confirming zero arrivals from Chromium:

| Request | Chromium 151 | Firefox 153 | WebKit 26.5 |
| --- | --- | --- | --- |
| `POST https://localhost:5173/…` (content-type: application/json) | **LNA denied** | preflight `OPTIONS` **arrived**, then rejected for missing ACAO | preflight arrived, then rejected for missing ACAO |
| `GET https://127.0.0.1:5173/g` (cors mode) | **LNA denied** | GET **arrived** with `Origin`, rejected for missing ACAO | GET **arrived**, rejected for missing ACAO |
| `GET https://127.0.0.1:5173/n` (`mode: 'no-cors'`) | **LNA denied** | **resolved opaque**, request arrived (no `Origin` header) | **resolved opaque**, request arrived |
| `GET http://localhost:5174/h` | **LNA denied** | **arrived** | mixed-content blocked |

Facts to carry into the product:

- Local Network Access ships enabled in **Chrome 142** (opt-in via `chrome://flags#local-network-access-check`
  from Chrome 138). It gates "requests from the public network to a local network or loopback destination",
  covering `fetch()`, subresource loads and subframe navigation (WebSockets, WebTransport and WebRTC are
  not yet covered).
- The address sets it gates are the Private Network Access ones in § 3.2 above: `127.0.0.0/8`, `::1/128`,
  RFC 1918, `100.64.0.0/10`, `169.254.0.0/16`, `fc00::/7`, `fe80::/10`, `::ffff:0:0/96`, plus `.local`.
- **`mode: 'no-cors'` does not bypass it.** Confirmed above. Our reachability probe is unavailable here.
- `navigator.permissions.query({name: 'local-network-access'})` returns `"prompt"` / `"granted"` /
  `"denied"` in Chromium and **throws a `TypeError` in Firefox and WebKit**, which is a clean feature
  detection.
- `'targetAddressSpace' in new Request(url)` is `true` in Chromium and `false` in Firefox and WebKit.
- In headless Chromium there is no user to prompt, so the state stays `"prompt"` and the request is
  denied. In a real Chrome the user may see a prompt. Either way, an SHL viewer must not depend on it: a
  link whose delivery depends on a stranger clicking "allow this site to access your local network" is
  not a shareable link.
- Chromium's message is delivered as a **CORS policy** error, so anyone grepping for "CORS" will
  misdiagnose it as a server header problem. Worth calling out explicitly in the teaching panel.

### 5.4 The precise diagnosis for the user's real case

Given `https://localhost:5173/api/shl-manifest?bid=4836470`, the tool should say this, **before issuing
any request**, with `localhost` highlighted in the URL:

> **This link points at `localhost`, so it can only ever open on the machine that made it.**
>
> `localhost` always means "the computer I am running on". When you open this link, your browser looks for
> the manifest on *your own* machine on port 5173, not on the sender's. Three separate things then stop
> it, any one of which is fatal:
>
> 1. **Nothing is listening.** On your machine, port 5173 is almost certainly closed, so the connection is
>    refused before anything else is even attempted.
> 2. **Chrome blocks it anyway.** Since Chrome 142, a page on a public site is not permitted to reach
>    loopback or private-network addresses without an explicit permission prompt. Chrome reports this as
>    a CORS error, which is misleading: no server header can fix it.
> 3. **The certificate cannot be trusted.** A local dev server's HTTPS certificate is self-signed or
>    signed by a root that exists only on the machine that created it. Even with a server listening and
>    the permission granted, the TLS handshake fails for everyone else.
>
> This is why the link worked for you and for nobody else. It is not a viewer bug and no viewer can work
> around it. **To share this link, re-issue it with a manifest URL that is reachable from the internet**,
> for example a deployed relay, or a tunnel such as `cloudflared tunnel` or `ngrok` if you only need it for
> today (a tunnel URL dies when the tunnel does).
>
> Meanwhile, you can still see what is in this link: run the manifest request yourself and paste the result
> into **Offline paste** below. \[copyable curl command\] \[Offline paste\]

That is the one-line verdict the brief asked for, plus the mechanism, plus a route to the payload anyway.
Note the last paragraph: the tool stays useful even when it declares the link unopenable, which is what
separates a diagnostic from an error page.

---

## 6. What this means for the build

1. **Static analysis is the product's diagnostic core, not a nicety.** It is deterministic, instant, needs
   no network, works offline, cannot be wrong about the cases it fires on, and it would have solved the
   motivating incident with zero requests. Build § 3's rule table first, as data, with a test per row.
2. **Run static analysis before fetching, and suppress the fetch when a Certain rule fires.**
3. **Ship the probe pair** (`no-cors` GET plus the real CORS POST) and present the three-row outcome table
   as the verdict, disabling the loopback interpretation in Chromium after an LNA feature check.
4. **Never paraphrase the browser's error as a cause.** Show the exact `err.name` and `err.message` in a
   "raw evidence" section, then show *our* verdict separately, with an explicit confidence tier
   (Certain / Very likely / Possible / Unknown) and, for anything below Certain, the alternatives we could
   not rule out.
5. **Say "unknown" when it is unknown.** The failure mode of the incumbent tool was not silence, it was a
   bare `TypeError` presented as if it were a finding, which let the sender conclude the link was fine.
   An explicit "I cannot tell from the browser, here is the command that will tell you" is a better
   product than a confident guess.
6. **Explain, do not just report.** Every verdict carries the mechanism in one sentence, because the users
   are engineers at a testing event and the mechanism is the thing that stops them re-issuing the same
   broken link. Include the per-browser console strings so they know what to look for in DevTools, which
   our JS cannot read.
7. **Offline paste is a first-class mode, not a fallback.** It is the only path that always works, and it
   makes every "cannot fetch" verdict actionable.
8. **The opacity lesson applies twice.** `crypto.subtle.decrypt` fails as opaquely as `fetch` does (wrong
   key and corrupt ciphertext are indistinguishable `OperationError`s). Structurally pre-check everything
   checkable before every opaque call, so that its failure is informative by elimination.
9. **Third-party calls are opt-in, named, minimal, and disclosed.** DoH is the only one worth having; it
   sends a hostname to Cloudflare or Google. crt.sh, certspotter and public CORS proxies are not worth
   having. No probe ever transmits the `key`.

---

## Appendix A: reproducing the measurements

Harness (Playwright `playwright-core@1.62.1`, Chromium 151 / Firefox 153 / WebKit 26.5 browsers installed
via `npx playwright install`), test server, and raw JSON results:

All of it is committed under `research/evidence/05-browser-failure-diagnosis/`:

```
probe.mjs    round 1: 19 failure cases x 3 engines              -> out-{chromium,firefox,webkit}.json
probe2.mjs   round 2: live self-signed localhost, TAO, elements -> p2-{chromium,webkit}.json
probe3.mjs   round 3: cert errors ignored, LNA isolated, DoH    -> p3.json
probe4.mjs   round 4: timeout identity, 5-sample timing, CT     -> p4.json
srv.mjs      https:5173 (self-signed) + http:5174, logging every arriving request
             -> srv-arrivals.log (the "did a byte actually arrive" evidence)
jwe.mjs      mints and decrypts a spec-shaped SHL JWE, including zip=DEF
```

To re-run:

```bash
cd research/evidence/05-browser-failure-diagnosis
npm init -y && npm install playwright-core
npx playwright install chromium firefox webkit
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 2 -nodes \
  -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
node srv.mjs &                      # the local dev server under test
node probe.mjs chromium > out-chromium.json
node probe2.mjs chromium > p2-chromium.json
node probe3.mjs > p3.json
node probe4.mjs > p4.json
node jwe.mjs                        # crypto path, no browser needed
```

Give each probe run its own invocation and a generous timeout: black-holed addresses and DNS timeouts
make a combined run exceed most default limits, which is why `probe.mjs` carries a per-case 15s race.

The technique worth reusing: serve the test page at a synthetic **public** HTTPS origin via
`page.route('https://viewer.example/**', r => r.fulfill(...))`. A page served from `https://127.0.0.1`
would itself be a potentially-trustworthy, loopback-address-space origin, which changes mixed-content and
Local Network Access semantics and would have produced entirely wrong conclusions.

The second technique worth reusing: **read the target server's own log**. "Did the request arrive" is not
inferable from the browser side, and it is the fact that separates "blocked before the network" from
"blocked on the response", which is the whole ballgame.

## Appendix B: primary sources

| Claim | Source |
| --- | --- |
| Network error carries no status, headers or body | Fetch § 2.2.6 |
| `fetch()` rejects with a bare `TypeError` on a network error | Fetch § 5.5, `processResponse` steps |
| Opaque filtered response is type `"opaque"`, status 0, empty header list | Fetch § 2.2.6 |
| The failure reason goes to DevTools via a channel inaccessible to the page | Chromium `third_party/blink/renderer/core/fetch/fetch_manager.cc`, `ResponseResolver::RejectBecauseFailed` comment |
| `"Failed to fetch"` string | Chromium `fetch_manager.cc`, `V8ThrowException::CreateTypeError(isolate, "Failed to fetch")` |
| `"NetworkError when attempting to fetch resource."` string | Gecko `dom/bindings/Errors.msg:62`, `MSG_FETCH_FAILED` |
| `"Load failed"` string | WebKit `Source/WebCore/Modules/fetch/FetchResponse.cpp:532` |
| `content-type: application/json` is not CORS-safelisted | Fetch § 2.2.2, CORS-safelisted request-header (allows only `application/x-www-form-urlencoded`, `multipart/form-data`, `text/plain`) |
| Preflight is triggered for a CORS-unsafe header | Fetch § 4 HTTP fetch, "request's unsafe-request flag is set and either request's method is not a CORS-safelisted method or CORS-unsafe request-header names … is not empty" |
| CORS check failure returns a network error | Fetch § 4, "if request's response tainting is `cors` and a CORS check for request and response returns failure, then return a network error"; algorithm at Fetch § 4.10 |
| no-cors drops non-safelisted headers rather than erroring | Fetch § 2.2.2 no-CORS-safelisted request-header name (`Accept`, `Accept-Language`, `Content-Language`, `Content-Type`) and the `request-no-cors` Headers guard steps |
| localhost and `127.0.0.0/8` are potentially trustworthy | Secure Contexts § 3.1, steps 4 and 5 |
| Potentially trustworthy URLs are exempt from mixed-content blocking | Mixed Content § 2 and § 4.4 |
| Failed fetches create Resource Timing entries with only start/end set; precondition failures create none | Resource Timing § 3.2 |
| Cross-origin masking without `Timing-Allow-Origin` | Resource Timing § 3.5.1 |
| local / private / public address space blocks | Private Network Access § 2.1, "Non-public IP address blocks" |
| `targetAddressSpace` fetch option | Private Network Access § 3.4.3 |
| Local Network Access ships in Chrome 142; covers fetch, subresources, subframes | Chrome for Developers, "New permission prompt for Local Network Access" |
| Manifest request is `POST` with `content-type: application/json`; body `recipient` / `passcode` / `embeddedLengthMax` | SMART Health Links spec, manifest request |
| 404 when the SHL is no longer active; 401 with `remainingAttempts` for a bad passcode; 429 with `Retry-After` | SMART Health Links spec, manifest response |
| `alg: dir`, `enc: A256GCM`, `cty` header, optional `zip: DEF` | SMART Health Links spec, encryption |
| `key` is 43 characters, 32 random bytes base64url | SMART Health Links spec, payload |
| `files[].location` links live at most one hour and may be single-use | SMART Health Links spec, manifest |
