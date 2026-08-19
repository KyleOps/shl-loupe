# Teardown: `the-commons-project/shc-web-reader` (the app behind viewer.tcpdev.org)

Read at commit **`e61c8799`** on `main` (merge of PR #147, authored 2026-07-28T18:30:38Z), which is tree-identical to `develop`@`187dfe79`. Every file under `src/` and `util/` was fetched from `raw.githubusercontent.com/the-commons-project/shc-web-reader/HEAD/...` and read in full. File enumeration via `https://api.github.com/repos/the-commons-project/shc-web-reader/git/trees/HEAD?recursive=1` (73 blobs, `truncated: false`).

Deployment identity is confirmed in the source, not inferred: `src/lib/defaults.js:58` carries a `DOMAIN_OVERRIDES` entry keyed `"tcpdev.org"`, alongside `"commonhealth.org"` at line 46. Tags `v-shl2.2-dev4` (= `187dfe79`) and `v-shl2.2-prod4` (= `e61c8799`) point at the same tree, so **viewer.tcpdev.org and the CommonHealth production viewer are currently running the code analysed here**. `.github/workflows/setup.yml` deploys `dev`-tagged builds to S3 bucket `ips-viewer-app` and `prod`-tagged builds to `ips-viewer-app-prod`.

**Bottom line up front: build fresh, port aggressively.** The FHIR rendering layer (`src/lib/fhirTables.js` + `src/lib/fhirUtil.js`, 2,014 LOC) is genuinely valuable and worth porting almost verbatim. The SHL pipeline (`src/lib/SHX.js`, 538 LOC) is worth reading once as a checklist and then discarding: it is structurally incapable of producing the diagnosis we need, because it collapses every failure in a 6-hop network pipeline into a single `err.toString()` at `src/lib/SHX.js:144`. Argument in section 6.

---

## 1. Stack, deps, size, activity, licence

### Build tool: create-react-app, not Vite

There is **no Vite config and no Vite dependency**. `package.json` names `"react-scripts": "5.0.1"` with scripts `start` / `build` / `test` / `eject`, and `public/index.html` uses the CRA `%PUBLIC_URL%` template token. This matters for a fork decision: `react-scripts@5.0.1` shipped 2022-04-12 and CRA was formally deprecated by the React team in February 2025, so a fork inherits a dead, unpatchable webpack 4/5-era toolchain with no upgrade path short of a full migration.

### Dependencies (declared range, then the version pinned in `package-lock.json`)

| Package | Range | Locked | Role |
| --- | --- | --- | --- |
| `react` / `react-dom` | `^18.2.0` | 18.2.0 | UI. Note `src/index.js:11` calls the **legacy `ReactDOM.render`**, not `createRoot`, so no concurrent features and a deprecation warning on every boot |
| `react-scripts` | `5.0.1` | 5.0.1 | Build (CRA/webpack) |
| `@mui/material`, `@mui/icons-material` | `^5.11.7`, `^5.11.11` | 5.11.7 | **Yes, MUI v5**, plus `@emotion/react` + `@emotion/styled` 11.10.5 |
| `jose` | `^4.13.1` | **4.15.9** | The only JWE primitive. `compactDecrypt` for SHL files |
| `smart-health-card-decoder` | `github:smart-on-fhir/smart-health-card-decoder` | 1.1.1 @ `f4d3ce92` | SHC JWS verification + VCI directory. Bundles `axios`, `fflate`, `@nuintun/qrcode` |
| `fhirclient` | `^2.5.2` | 2.5.2 | SMART on FHIR EHR launch (optional mode) |
| `dompurify` | `^3.0.5` | 3.3.1 | Narrative sanitisation |
| `pdfjs-dist` | `^3.3.122` | 3.11.174 | Render PDF attachments |
| `jspdf` + `html2canvas` | `^2.5.1`, `^1.4.1` | 2.5.2, 1.4.1 | "Save to PDF" (rasterised, see 4/5) |
| `rtf.js` | `^3.0.9` | 3.0.9 | Render RTF attachments |
| `qr-scanner` | `^1.4.2` | 1.4.2 | Camera scanning (also vendored as `public/qr-scanner.umd.min.js`) |
| `@fontsource/open-sans` | `^4.5.14` | - | Self-hosted font |

State management: **none**. No Redux, no Zustand, no react-query, no router. Navigation is a `useState` string enum in `src/App.js:17-24` (`TabValue`), and the whole SHL result lives in one `useState` inside `src/Data.js:22`. There is no URL routing at all: the SHL arrives as `document.location.hash` and is read exactly once (`src/lib/config.js:29-30`, consumed at `src/App.js:47`).

i18n: hand-rolled. `src/lib/LanguageContext.js` provides `t(key, fallback)` over a plain object in `src/lib/languages.js` (444 lines). **Two locales only: `en` and `fr`** (`src/lib/languages.js:2` and `:213`), toggled by a single button that cycles `getValidLanguages()` (`src/App.js:72-78`). Many French strings are marked `// NEED_REVIEW`. Missing keys `console.warn` and fall through to the key name (`LanguageContext.js:50-58`).

Two notable supply-chain facts. First, `smart-health-card-decoder` is a **git dependency**, and the lockfile resolves it as `git+ssh://git@github.com/smart-on-fhir/smart-health-card-decoder.git#f4d3ce92...`, so a clean `npm ci` wants git-over-SSH rather than the npm registry. Second, `pdfjs-dist`'s worker is loaded from a CDN at runtime: `src/DocumentModalContext.js:52` sets `pdfjs.GlobalWorkerOptions.workerSrc = "//cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjs.version}/pdf.worker.min.js"`. On a firewalled connectathon network, PDF attachment rendering silently fails.

### Repo size and shape

- 73 tracked blobs, 10.4 MB total, of which **9.0 MB is `public/`** and 6.6 MB of that is one file, `public/codes-loinc.json`. Plus `public/codes-snomed-sct.json` (1.25 MB) and `public/shc.png` (1.1 MB).
- `src/` is only **220 KB / 7,522 LOC of JS**. It is entirely readable in an afternoon.
- Largest files: `src/lib/fhirTables.js` (1,124 LOC), `src/lib/fhirUtil.js` (890), `src/lib/SHX.js` (538), `src/DocumentModalContext.js` (509), `src/lib/languages.js` (444), `src/lib/codes.js` (425).
- **Zero tests.** No `*.test.js` anywhere under `src/`, despite `react-scripts test` being wired up.
- **No `ErrorBoundary` and no `componentDidCatch` anywhere** (grep across `src/` returns nothing). Any render-time throw unmounts the whole tree to a blank white page.

### Activity

Created 2023-02-24. 7 stars, 7 forks, 32 open "issues" (11 real issues, the rest Dependabot PRs). Last push 2026-07-28. Commits by year (API page cap 100): 2023 >= 100, **2024: 14, 2025: 28, 2026: 39**. So: a burst of real work in 2023, near-dormant 2024 to 2025, a modest revival April to July 2026 (the `v-shl2.2` line, which is where DiagnosticReport and DocumentReference rendering landed). Two active committers, Sean Nolan (`surfdoc`) and Patrick Carter. This is a low-bus-factor side project, not a maintained platform.

There is a genuinely useful architecture write-up by the primary author linked from the README: <https://shutdownhook.com/2023/09/09/anatomy-of-a-smart-health-card-link-viewer/>.

### Open issues that matter to us

- **#146** (2026-07-28, still open although apparently fixed by `187dfe79`): `hashMember` typo in `addObsRecursive` threw `TypeError: Cannot read properties of undefined (reading 'length')` on any IPS document containing a lab panel, and with no `ErrorBoundary` the user got a **blank white page** with the diagnosis only in devtools. This is the single best illustration of the failure mode we are building against.
- **#57** (2023-09-14) "Option to render Provenance resources" and **#89** (2024-05-16) "Include viewing Provenance in SHL Viewer App". **Both open for over two years.** Provenance is how Platypus states the origin of every entry it shares, so this viewer renders our provenance ledger as nothing at all (see section 3).
- **#59** (2023-09-14) "make general error messages slightly more friendly". Open for nearly three years. This is precisely our product thesis, filed as a wishlist item by the tool's own author.
- **#67** "figure out ValueSets in codes.js", **#54** "fixup smart-health-card-decoder FHIRBUNDLE validation", **#6** (2023-02-24) "fix module vulnerabilities" (still open; ~21 Dependabot branches queued).

### Licence: MIT. We can fork and redeploy.

`LICENSE` is verbatim MIT, `Copyright (c) 2023 The Commons Project`. The only obligation is the standard one: "The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software." So a fork, or a fresh app that ports `fhirTables.js`, must ship that notice (a `THIRD-PARTY-NOTICES.md` or a header comment on the ported files, retaining the TCP copyright line). No share-alike, no attribution-in-UI requirement, no patent grant. `smart-health-card-decoder` is also MIT.

Two non-code licence obligations travel with the terminology snapshots if we port them, and `util/index.js` states them: the SNOMED Global Patient Set is used "under CC4 Attribution; see https://www.snomed.org/gps", and LOINC is "copyright (c) 1995 Regenstrief Institute, Inc. and the LOINC Committee, and available at no cost under the license at http://loinc.org/terms-of-use".

---

## 2. Exactly how it handles an SHL

All of it lives in one file, `src/lib/SHX.js`. The entry point is `verifySHX(shx, passcode)` at line 125, called from exactly one place: `src/Data.js:216`, inside a `useEffect` keyed on `[shx, passcode, setBundleLanguage]`.

### 2.1 The pipeline, hop by hop

| Step | Code | What it does |
| --- | --- | --- |
| Detect | `SHX.js:117-119` `looksLikeSHL` | `input.startsWith('shlink:/') \|\| input.indexOf('#shlink:/') !== -1` |
| Ingest | `lib/config.js:29-30` | `cfg["shx"] = document.location.hash.substring(1)`; `public/shlink.html` rewrites `/shlink.html#shlink:/...` to `/#shlink:/...` |
| Decode payload | `SHX.js:420-432` `decodeSHL` | Slices past `shlink:/` (or past `#shlink:/`), then `JSON.parse(b64u_to_str(body))`. **No `v` check, no key-length check, no field validation** |
| Flags | `SHX.js:310-312`, `366-368` | `P` and `U` only. `L` is read nowhere; `exp` checked at `:314-318` |
| Manifest | `SHX.js:364-403` `fetchSHLManifest` | `POST` to `shlPayload.url`, `Content-Type: application/json`, body `{recipient, passcode?}` |
| Files | `SHX.js:328-353` | Filters by `contentType`, then `fetchSHLContent`, `compactDecrypt`, `JSON.parse` |
| Decrypt | `SHX.js:340` | `await compactDecrypt(shlEncrypted, key)` with `key = b64u_to_arr(shlPayload.key)` (`:326`) |
| Verify SHC | `SHX.js:155-165` | `verify(jws, directory)` from `smart-health-card-decoder`, per `verifiableCredential` entry |
| Organise | `lib/resources.js:44` `organizeResources` | Builds `all` / `byId` / `byType`, then sniffs a bundle "meta-type" |
| Render | `Data.js:94-153` `renderBundle` | 4-way switch on `organized.typeInfo.btype` |

### 2.2 Manifest POST: what it sends and what it omits

```js
// src/lib/SHX.js:370-377
const body = { recipient: SHL_RECIPIENT };
if (passcode) body.passcode = passcode;

const response = await fetch(shlPayload.url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
});
```

`SHL_RECIPIENT` is the hardcoded string `'SMART Health Card Web Reader'` (`SHX.js:73`). It is not configurable and not surfaced to the user, so a server operator reading their access log cannot tell which of several viewers, or which engineer, hit them.

**`embeddedLengthMax` is never sent.** The SHL spec lists it as an optional manifest-request field ("Integer upper bound on the length of embedded payloads"), and it is the single knob a client has for controlling `embedded` versus `location` behaviour. Omitting it means a debugger cannot demonstrate both code paths against the same server.

**`Content-Type: application/json` on a cross-origin POST is not a CORS-simple request**, so every manifest fetch is preceded by a `OPTIONS` preflight. A manifest server that implements `POST` but not `OPTIONS` fails with an opaque `TypeError` and no HTTP status ever reaching JS. This is one of the two dominant connectathon failures (the other being section 2.7), and the SHL spec is silent on CORS: a fetch of the spec's manifest sections returns no `Access-Control-Allow-Origin` requirement at all. A browser-only viewer therefore has to diagnose this class from configuration, not from the fetch result.

### 2.3 The `P` (passcode) flag

Handled in two places, and reasonably well:

```js
// src/lib/SHX.js:310-312
if (shlPayload.flag && shlPayload.flag.indexOf('P') !== -1 && !passcode) {
  throw new PasscodeError("This SHL requires a passcode.");
}
```

Thrown before any network call, caught at `:133-135`, mapped to `SHX_STATUS_NEED_PASSCODE`, which `Data.js:247-249` renders as a password field. On resubmit the whole `verifySHX` runs again from scratch (`Data.js:36-39` sets `passcode` and clears `shxResult`), so the manifest is re-POSTed each attempt.

Wrong-passcode handling reads `remainingAttempts` off the 401 body, matching the spec:

```js
// src/lib/SHX.js:379-392
if (response.status === 401 && passcode) {
  let responseBody;
  try { responseBody = await response.json(); }
  catch (error) {
    console.error('There was an error processing the passcode.', error);
    throw new Error('There was an error processing the passcode.');
  }
  const remainingAttempts = responseBody.remainingAttempts;
  const attemptText = remainingAttempts === 1 ? "attempt" : "attempts";
  throw new PasscodeError(`Passcode incorrect. ${remainingAttempts} ${attemptText} remaining.`);
}
```

Two defects. The guard is `response.status === 401 && passcode`, so a **401 on a link with no `P` flag** (a server that requires a passcode the payload never advertised, a common producer bug) skips this branch entirely and falls to `:398-400` as the bare string `"Manifest: 401"`. And if `remainingAttempts` is absent, the message renders literally as `Passcode incorrect. undefined attempts remaining.`

### 2.4 The `U` (direct file) flag

Handled, and correctly per spec, at `SHX.js:405-418`:

```js
function singleFileManifest(shlPayload) {
  const location = shlPayload.url +
        (shlPayload.url.indexOf("?") === -1 ? "?" : "&") +
        "recipient=" + encodeURIComponent(SHL_RECIPIENT);
  return { files: [ { "contentType": INFER_CONTENTTYPE, "location": location } ] };
}
```

It synthesises a one-entry manifest and never POSTs, which is what the spec demands ("the SHL Receiving Application SHALL NOT make a request for the manifest"). Because the content type is unknown for a direct file, it invents a sentinel `INFER_CONTENTTYPE = '___INFER___'` (`SHX.js:77`) purely to pass its own content-type filter. Note it does **not** reject the spec-forbidden `U` + `P` combination ("SHALL NOT be used in combination with `P`") - a `UP` link throws the passcode error at `:310` and then never uses the passcode, so the user is prompted for a code that is discarded.

### 2.5 `files[].location`: handled, with no status check at all

```js
// src/lib/SHX.js:356-362
async function fetchSHLContent(file) {
  if (file.embedded) return(file.embedded);
  const response = await fetch(file.location);
  return(response.text());
}
```

So `embedded` is handled (returned directly) and `location` is handled (plain `GET`, no headers). But **there is no `response.ok` / `response.status` check on the file fetch**. A 403 on an expired single-use location URL, or a 404 that returns an HTML error page, is handed straight to `compactDecrypt` as if it were a JWE. The resulting user-visible message is a `jose` parse complaint (`JWEInvalid: Invalid Compact JWE`), which points the engineer at their encryption when the actual fault was an expired URL. The spec explicitly warns that this URL "SHALL be short-lived and intended for single use", making a stale-location 403/404 one of the most likely real-world failures, and this is the one hop with zero status handling.

### 2.6 `zip: DEF`: not supported, and it fails in a maximally confusing way

The SHL spec permits it: the JWE "MAY include a `zip` header with the value `DEF` to indicate that the plaintext of the JWE is compressed using the DEFLATE algorithm".

`SHX.js:340` calls `compactDecrypt(shlEncrypted, key)` with **no options object**. In `jose@4.15.9`, the browser build's default inflate is a throwing stub (`src/runtime/browser/zlib.ts`):

```ts
export const inflate: InflateFunction = async () => {
  throw new JOSENotSupported(
    'JWE "zip" (Compression Algorithm) Header Parameter is not supported by your javascript runtime. You need to use the `inflateRaw` decrypt option to provide Inflate Raw implementation.',
  )
}
```

and `src/jwe/flattened/decrypt.ts:242-243` does `if (joseHeader.zip === 'DEF') plaintext = await (options?.inflateRaw || inflate)(plaintext)`. So **any spec-legal `zip: DEF` SHL file fails to decrypt in this viewer**, and the user sees a runtime-capability message that blames their own browser. The irony worth noting for our port: the app already ships `fflate` inside `smart-health-card-decoder`'s bundle (it needs DEFLATE for SHC JWS payloads), so the fix is a two-line `{ inflateRaw }` option, never taken.

Also silently dropped: `contentType: "application/smart-api-access"`, which the spec lists as one of three legal file content types. `SHX.js:332-337` `continue`s past anything that is not `application/smart-health-card`, `application/fhir+json`, or the internal sentinel, with the comment "don't bother downloading things we KNOW we can't use". No user-visible note that a file was skipped.

### 2.7 The error handling, and the exact code that produced "type load fail"

Everything funnels through one `catch`:

```js
// src/lib/SHX.js:125-147
export async function verifySHX(shx, passcode = undefined) {
  try { return(await _verifySHX(shx, passcode)); }
  catch (err) {
    // console.error(err.stack);        <-- commented out
    if (err instanceof PasscodeError) return(status(SHX_STATUS_NEED_PASSCODE, err.message));
    if (err instanceof ExpiredError)  return(status(SHX_STATUS_EXPIRED, err.message));
    if (err instanceof DataMissingError) return status(SHX_STATUS_ERROR, err.message);
    const reasons = (err ? err.toString() : "unexpected");
    return(status(SHX_STATUS_ERROR, reasons));
  }
}
```

Note the commented-out `console.error(err.stack)` at line 131: even the stack is not logged. Three custom error classes exist (`PasscodeError`, `ExpiredError`, `DataMissingError`, defined `:83-101`); **every other cause in a 6-hop pipeline degrades to `err.toString()`**. There is no distinction between DNS failure, connection refused, TLS rejection, CORS preflight failure, HTTP 500, a non-JSON manifest body, a bad key, a `zip: DEF` file, or malformed FHIR.

That string is then rendered by:

```js
// src/Data.js:82-86
const renderError = (reasons) => {
  let displayReasons = Array.isArray(reasons) ? reasons : [reasons];
  displayReasons = displayReasons.map(reason => reason.replaceAll("Error: ", ''));
  return(<div>{displayReasons.join('; ')}</div>);
}
```

**This is the line that produced the observed "type load fail".** Reconstruction of the localhost incident, end to end:

1. Payload `url` is `https://localhost:5173/api/shl-manifest?bid=4836470`. On any machine but the sender's, `fetch` to that host fails at the transport layer (connection refused, or an untrusted self-signed dev certificate). The browser deliberately gives JS no detail, because leaking it would be a port-scanning oracle.
2. `fetch` rejects with a `TypeError`. WebKit's text for a transport-layer fetch failure is **`TypeError: Load failed`** (Chromium says `TypeError: Failed to fetch`; Firefox says `TypeError: NetworkError when attempting to fetch resource.`).
3. `SHX.js:144` stringifies it: `"TypeError: Load failed"`.
4. `Data.js:84` runs `.replaceAll("Error: ", '')` over it. The substring `"Error: "` occurs inside `"TypeError: "` at index 4, so the result is `"Type"` + `"Load failed"` = **`TypeLoad failed`**.
5. `Data.js:251-252` renders that bare string in a `<div>` with no context, no URL echo, no hop label, and no next step.

So the user's "type load fail" is not an error code from anywhere: it is a cosmetic `replaceAll` intended to strip a `"Error: "` prefix, mangling the browser's own exception name. The sender concluded the link was fine because the message contains no evidence about the link at all. Every fact needed for the correct one-liner (the URL is `localhost`, therefore it can only resolve on the machine that minted it) was present in `shlPayload.url` at `SHX.js:304`, before any network call, and was never inspected.

Other error-handling notes:

- `Data.js:230-232` is an **empty catch on the promise chain**: `.catch(error => { /* Handle the error appropriately */ })`. Any throw inside the `.then` (including `setShxResult`-adjacent work) vanishes with no log.
- There is **no abort/cancellation**. The `useEffect` at `Data.js:214` returns no cleanup and creates no `AbortController`, so a passcode retry or a re-render leaves the previous manifest POST in flight and racing.
- There is no timeout on any fetch. A manifest server that accepts the connection and never responds hangs the spinner at `Data.js:255-261` forever.
- `DataMissingError` ("The provided Smart Health Link does not contain any data.") is thrown from `SHX.js:171-175` by a loop over the bundles, so **one empty bundle in a multi-file SHL aborts the display of all of them**.
- HTTP 429 (which the spec explicitly allows: "the server MAY respond with HTTP status `429 Too Many Requests`") falls through to `"Manifest: 429"`.
- Cert status `CERT_STATUS_NONE`, the normal state for an unsigned `application/fhir+json` SHL file, renders **nothing at all**: `src/ValidationInfo.js:62-64` `renderNone` returns `<></>`. So "this payload was not signed, so nothing here is verified" is never stated.

---

## 3. FHIR renderer coverage

Two layers. First, `src/lib/resources.js:94-107` sniffs a bundle "meta-type" by trying five predicates in order, then `src/Data.js:103-133` switches on it:

| `btype` | Predicate | Component |
| --- | --- | --- |
| `BTYPE_EMPTY` | `organized.all.length === 0` (`resources.js:113`) | falls to `default` |
| `BTYPE_PS` | a `Composition` whose `type` has LOINC **`60591-5`** (`resources.js:128-137`) | `PatientSummary.js` |
| `BTYPE_COVERAGE` | any `Coverage` present (`resources.js:166`) | `Coverage.js` (CARIN digital insurance card) |
| `BTYPE_IMMUNIZATION` | exactly 2 resource types, >=1 `Immunization`, exactly 1 `Patient` (`resources.js:195-197`) | `ImmunizationHistory.js` |
| resourceType | `organized.all.length === 1` (`resources.js:213-221`) | falls to `default` |
| `BTYPE_BUNDLE` | anything else non-empty (`resources.js:228`) | `Collection.js` |
| anything else | | `default`: a `<details>` block containing `JSON.stringify(bundle.fhir, null, 2)` (`Data.js:123-132`) |

Note the practical consequence of the ordering: a bundle carrying both a `Composition` with a different LOINC type code and a `Coverage` is rendered as an insurance card. And `tryTypeInfoPatientSummary` at `resources.js:139` dereferences `organized.byType.Composition[0].subject.reference` **unguarded**, so a `Composition` with LOINC 60591-5 and no `subject` throws before anything renders, and with no `ErrorBoundary` that is a white page.

Second, the per-resource table renderers, registered in a single object literal, `renderConfig` at `src/lib/fhirTables.js:59-147`. **The complete covered set, 19 resource types:**

`Patient`, `Practitioner`, `RelatedPerson` (all three share `personHeader`/`personRow`), `Condition`, `MedicationStatement`, `MedicationAdministration` (reuses the MedicationStatement renderer), `MedicationDispense`, `MedicationRequest`, `AllergyIntolerance`, `Observation`, `Immunization`, `Procedure`, `CarePlan`, `Consent`, `DeviceUseStatement`, `ClinicalImpression`, `Goal`, `DocumentReference`, `DiagnosticReport`.

Plus `Coverage` and `Composition`, handled outside `renderConfig` by their own components (`Coverage.js`, `PatientSummary.js`), and `Medication`, which is explicitly and unconditionally dropped: `fhirTables.js:39-40`, `if (rtype === "Medication") return;` with the comment "Medication appears in CH export but isn't a valid standalone entity".

### What it does when it meets a type it cannot render

```js
// src/lib/fhirTables.js:156-166
Object.keys(tableState).forEach((rtype) => {
  if (!renderConfig[rtype]) {
    console.warn("fhirTables can't render: " + rtype);
    return;
  }
  ...
});
```

**Silent omission.** A `console.warn` and nothing on screen. No "3 resources not displayed" note, no count, no fallback JSON. The resource is simply absent from a page that looks complete. For a teaching and debugging tool this is the worst possible behaviour: it is indistinguishable from the server not having sent the resource.

### Types with no renderer that matter to us

`Provenance` (issues #57 and #89, open since 2023), `Organization`, `Location`, `Encounter`, `ServiceRequest`, `Specimen`, `Device`, `Media`, `QuestionnaireResponse`, `Questionnaire`, `Task`, `Appointment`, `Flag`, `Basic`, `List`, `Binary`, `Group`, `CareTeam`, `Coverage` when it is not the primary type, `Bundle` nested as an entry.

`Provenance` is the one that hurts. Platypus derives every origin statement in a shared payload from its provenance ledger, and relates it by `Provenance.target` rather than putting it in a `Composition.section`. In this viewer that means two compounding invisibilities: `Provenance` has no `renderConfig` entry, **and** `PatientSummary.js` only ever renders resources reachable from `comp.section[].entry` (`PatientSummary.js:72-82` -> `PatientSummarySection.js:101`). So for a Patient Summary bundle, **any resource not referenced from a Composition section is never rendered by any code path**, regardless of whether a renderer exists for it.

`Organization` likewise has no renderer, so `futil.renderGenerator` (`fhirUtil.js:17`) is the only way an organisation surfaces, as a name inside an author cell.

### On the report that it does not display `DocumentReference`: refuted at HEAD, but the report was almost certainly right in practice

`DocumentReference` **is** registered (`fhirTables.js:137-141`) with `docRefHeader` (`:879`), `docRefRow` (`:889`) and `docRefCompare` (`:915`), rendering a Date / Name / Author / Size / Status table where the name is a button opening a modal viewer. Support landed in commit `0fafb76e`, "DRs and Docs now working pretty well", dated **2026-04-22**, and first shipped in the `v-shl2.2` tag line. So any observation before late April 2026 was correct as a statement about the deployed build.

There are also three live ways it still shows nothing:

1. **Not a section entry.** Per the paragraph above, a `DocumentReference` present in an IPS/AU PS bundle but not referenced from a `Composition.section.entry` is never passed to `fhirTables`.
2. **Null-attachment crash.** `fhirDocs.js:55` returns `null` when a `DocumentReference` has no `content`, and `getBestAttachment` returns `null` for any resource type other than `DocumentReference`/`DiagnosticReport` (`:49`). `computeModalDocs` (`fhirTables.js:937-947`) then does `attachment.contentType` on it, and `docRefRow:901` does `modalDoc.attachment.data`. A `DocumentReference` with no `content` therefore throws `TypeError: Cannot read properties of null`, which with no `ErrorBoundary` blanks the entire page, not just the row. `getBestAttachmentHelper` (`:93`) also does `attachmentScores[0].attachment` on a possibly empty array.
3. **`attachment.url` is never fetched.** `getBestDocRefAttachment` scores on `contentType` and on whether `attachment.data` is present (`fhirDocs.js:62`, misleadingly named `external`). Nothing ever reads `attachment.url`. A `DocumentReference` pointing at a `Binary` (the normal shape from a real FHIR server) renders a row with size `"0 B"` and a link that opens a modal saying `unsupportedDocType`, because `DocumentModalContext.js:68` bails on `!doc.base64Data`.

Related, and the same root cause: the reference resolver is strictly string-keyed. `fhirUtil.js:754-759`:

```js
export function resolveReference(o, resources) {
  if (!o) { console.trace("!!! resolveReference"); return(undefined); }
  if (o.resourceType) return(o);
  if (o.reference && o.reference in resources) return(resources[o.reference]);
  return(undefined);
}
```

`resources` is `organized.byId`, keyed by both `fullUrl` and `"ResourceType/id"` (`resources.js:77-78`). So `urn:uuid:...` and `Patient/123` resolve; an **absolute reference** (`https://server/fhir/Patient/123`) does not, and neither does a relative reference in a bundle whose `fullUrl`s are `urn:uuid:`. The failure is a `console.log("Unable to resolve reference for: ...")` at `fhirTables.js:33` and a silently missing table row. This is exactly the class of defect Platypus's `resolveInternalReferences` exists to prevent, and it is invisible in this viewer.

---

## 4. Strengths worth stealing

1. **`fhirTables.js`'s renderer registry shape.** One `renderConfig` object mapping `resourceType` to `{hdrFn, rowFn, compFn}`, driven by a generic `renderJSX` that groups, dedupes, sorts and emits one table per type. It is flat, additive, and 19 types deep. Whatever our visual design, this registry pattern plus its 19 populated row functions is the highest-value asset in the repo.
2. **`fhirUtil.js`'s 40+ FHIR display primitives.** `renderCrazyDateTime` / `parseCrazyDateTimeBestGuess` (handling the `effectiveDateTime` vs `effectivePeriod` vs `effectiveTiming` choice-element mess), `parseDateTimePrecision` with a real precision enum (`PRECISION_NONE`/`YEAR`/`MONTH`/`DAY`/`TIME`, `:190-194`), `renderQuantity`, `renderRange`, `renderRatio`, `renderDosage`/`renderTiming`, `renderAddressSingleLine`, `getPersonDisplayName`, `seemsLikeSamePatient`. This is years of accumulated FHIR-display pain, and it is the part you do not want to rewrite.
3. **The deferring code renderer** (`codes.js:118-148`). `safeCodeDisplay(system, code)` returns a synchronous placeholder immediately and queues an async terminology load; the component `await`s `dcr.awaitDeferred()` in a `useEffect` and re-renders on a fresh `dcr` instance (`Data.js:236-245`). It is a clean answer to "render now, enrich when the code system arrives" without a query library. Ours will hit the same problem.
4. **Zero-backend terminology.** LOINC and the SNOMED Global Patient Set shipped as static `code -> display` dictionaries in `public/` (`codes.js:53-65`), cached in `localStorage` with a 30-day TTL and a size ceiling (`defaults.js:28-33`, `terminologyCacheSeconds`, `terminologyCacheItemCeiling`). `util/index.js` is the generator that builds those JSON files from the source distributions. Genuinely useful for a static site, and the licence notices are already written for us.
5. **SHC verification via a real library plus a trust directory.** `SHX.js:189-199` composes multiple issuer directories into one (`Directory.create([dirs])`) from a config list (`defaults.js:15-18`: the VCI daily snapshot plus a demo keystore), and `addVerifiableBundle` (`:478-536`) extracts `issuerISS`, `issuerName`, `issuerURL`, `issueDate` from `nbf`, and `supportsRevocation` derived from `"crlVersion" in key || "rid" in vc`. The `permissive` config flag plus `bePermissive` (`:201-216`) which upgrades a non-fatal validation failure to verified is a nice debugging affordance and exactly the sort of switch our tool should expose (loudly).
6. **The `PatientSummarySection` narrative/structured toggle** (`PatientSummarySection.js:27-56`). It picks an initial view from `section.text.status`: `additional` or `extensions` means the narrative may carry more than the structured entries, so show narrative first; otherwise prefer structured. That is a correct and subtle reading of the FHIR narrative contract, and both are always reachable via a toggle. Steal the rule.
7. **Narrative sanitisation with a defence in depth.** `DOMPurify.sanitize` before `dangerouslySetInnerHTML` (`PatientSummarySection.js:83-87`), falling back to a sandboxed iframe (`IFrameSandbox.js`, `sandbox="allow-same-origin"` with no `allow-scripts`, self-sizing on load) when DOMPurify is unsupported. The comment at `:89-92` even names the tradeoff (html2canvas cannot rasterise iframe content).
8. **The wrong-patient warning** (`WrongPatientWarning.js`). In EHR-embedded mode it reads the in-context patient and compares against `organized.typeInfo.subjects`, warning on mismatch. Not relevant to a standalone debugger, but the `seemsLikeSamePatient` heuristic behind it is.
9. **The config-override mechanism** (`config.js:22-25`): URL query parameters are applied **only if the key already exists in `DEFAULT_CONFIG`**, with the comment "Only allow URL params that match known config keys to prevent arbitrary parameter injection from malicious links". Good instinct, worth copying for our debug switches, and the per-hostname `DOMAIN_OVERRIDES` (`defaults.js:43-63`) is a neat way to run one build at several personalities.
10. **Honest privacy copy.** `languages.js`: "Personal health information is processed exclusively in the browser and is never sent to the servers hosting the viewer." Exactly the claim a client-side tool should make, in exactly that wording.

Things **not** worth stealing that might look tempting: the "Save to PDF" path (`saveDiv.js:8-28`) is `html2canvas` -> a single rasterised JPEG -> `jsPDF.addImage` on one page sized to the canvas. The output is an image with no text layer, unselectable, unsearchable, inaccessible, and one absurdly tall page. Real `@media print` CSS beats it on every axis. Accessibility overall is close to absent: grep across `src/` finds **zero `aria-*` attributes, zero `role=`, zero `tabIndex`**, six `alt=` uses total, three uses of the obsolete `<nobr>` element, and interactive `<div onClick>` handlers for the collapsible section headers (`PatientSummary.js:30-39`) that are not keyboard reachable. Do not port the presentation layer.

---

## 5. Architectural weaknesses for our purpose

### Is there a trace seam? No, but the pipeline is at least in one file

The honest assessment is mixed, and it matters for the fork decision.

**Good:** the SHL pipeline genuinely is separated from the components. `SHX.js` does all fetching and decrypting and returns a plain data structure; `Data.js` never fetches. The README states the intent ("I've tried to keep as much of the FHIR-y and SHC-y stuff as possible under the `src/lib` directory") and it mostly holds. So fetching is *not* tangled into components, which is better than the usual case.

**Fatal for us:** the seam is a **single boundary with a single return value**, not an instrumentable pipeline. The contract is documented at `SHX.js:13-35` and is `{shxStatus, reasons[], bundles[]}` where `shxStatus` is one of exactly four strings and `reasons` is an array of human strings. Concretely, what a debugger needs and cannot get:

- **No step identity.** Nothing in the result says which hop failed. `"Manifest: 500"` and a `TypeError` from a file `location` are both just strings in `reasons`.
- **No request/response record.** The `Response` objects are consumed and discarded inside `fetchSHLManifest` and `fetchSHLContent`. Status, headers, timing, and body are unrecoverable by the time anything renders. There is no place to hang "the manifest returned 200 with `Content-Type: text/html`".
- **No intermediate artefacts.** The decoded shlink payload (`decodeSHL`'s return), the raw manifest JSON, the per-file JWE protected header, the decrypted plaintext, and the JWS payload all exist as locals inside `resolveSHL` and are thrown away. Only the final FHIR bundles survive. A tool whose job is to *explain* has nothing to show.
- **First failure kills everything.** `resolveSHL` is a bare `for` loop over `shlFiles` (`:328-353`) with no per-file try/catch, so one undecryptable file discards the ones that worked. A partial-success model (5 of 6 files decrypted, here is what failed on the sixth) is not expressible in the return type.
- **The `catch` is the wrong shape.** `SHX.js:126-146` is one try/catch wrapped around the entire pipeline. Adding per-hop diagnosis means inverting that control flow: every hop needs its own error taxonomy, its own captured context, and a result type that carries a *list* of diagnoses rather than a single status. That is a rewrite of `SHX.js`, not an instrumentation pass.
- **No pre-flight inspection at all.** Nothing looks at `shlPayload.url` before fetching it. The localhost diagnosis, the `http:` versus `https:` mixed-content diagnosis, the private-IP/`.local` diagnosis, the "key is not 43 characters" diagnosis, the `U`+`P` illegal-combination diagnosis: every one of these is a pure function of the decoded payload, computable with zero network access, and none of them exists.
- **No cancellation, no timeouts, no retry semantics** (section 2.7), which a debugger needs in order to distinguish "slow" from "hung" and to re-run one hop in isolation.

Retrofitting a trace onto `SHX.js` is not architecturally impossible: it is roughly "thread a `trace` object through 8 functions, wrap each `fetch`, widen the return type, and rewrite the catch". Call it 300 to 400 lines of change against 538, in an untested JavaScript file with no types. At that point you have rewritten the module and are still carrying CRA, MUI v5, `ReactDOM.render`, zero tests, and a presentation layer you have already decided not to keep.

### Other structural problems

- **No `ErrorBoundary` anywhere**, so every renderer bug is a white page. Issue #146 is the proof. For a tool whose entire promise is "tell me what went wrong", any path to a blank screen is a product failure, and the current code has many (unguarded `Composition.subject.reference`, null attachments, `attachmentScores[0]`, `s.code.coding[0].code` at `PatientSummary.js:73`).
- **No TypeScript.** 7,522 lines of untyped JS handling FHIR choice elements, and zero tests to compensate. `resolveReference` returning `undefined` is handled at some call sites and not others.
- **`console` is the real diagnostic channel.** `console.warn("fhirTables can't render: ...")`, `console.log("Unable to resolve reference for: ...")`, `console.error` in `addVerifiableBundle:501`, `console.trace("!!! resolveReference")`. The information we want to put on screen is already being computed; it is just being written to devtools. This is a strong signal that the diagnostic layer is a UI problem more than a discovery problem, and a strong signal about where to look when porting.
- **Terminology depends on `build.fhir.org` at runtime.** `codes.js:19-104` fetches HL7 UTG and CARIN code systems from `https://build.fhir.org/ig/HL7/...`, the continuous-integration build. That URL is not a stable distribution channel, and it is unreachable on an air-gapped or restrictive event network.
- **AU codes are not covered.** The SNOMED dictionary is the Global Patient Set, so SNOMED CT-AU-only concepts miss and `safeDisplaySync` (`codes.js:161-170`) falls back to `_loadedSystems[system][code] || code`, i.e. the bare numeric code. For Sparked and AU Core work that is a visible quality gap, and a reason our tool should talk to a real terminology server (or ship an AU dictionary) rather than copy this approach wholesale.
- **One 6.6 MB LOINC JSON in `public/`** is a fine tradeoff for them and a bad one for us if we want a fast-loading tool; it is fetched whole on the first LOINC code encountered.

---

## 6. Recommendation

**Build fresh. Port `fhirTables.js` and `fhirUtil.js` almost verbatim, port three specific ideas, and use `SHX.js` as a spec-coverage checklist rather than as code.**

The argument, in the order the tradeoffs actually bite:

**Forking buys us the FHIR renderer and nothing else we want.** Everything valuable in this repo lives in two files under `src/lib/` and is portable under MIT with a copyright notice. Everything we would have to fight lives everywhere else: a deprecated CRA toolchain, MUI v5 with a bespoke design vocabulary we are replacing anyway, `ReactDOM.render`, no TypeScript, no tests, no error boundaries, no router, ~21 queued Dependabot PRs, and a `git+ssh` lockfile dependency. A fork means we own all of that on day one, in service of code we intend to delete.

**The one thing we most need is the one thing that cannot be retrofitted.** Deep diagnostics require the pipeline to be a sequence of named, individually-instrumented, individually-failable steps that retain their inputs, their raw HTTP exchanges, and their intermediate artefacts, and that can report partial success. `SHX.js` is the exact opposite shape by design: one try/catch, one four-valued status, one array of human strings, and every `Response` object consumed and dropped. Rewriting it is more work than writing it, because you have to first understand and then unpick the collapsing.

**A bespoke UI plus a ported renderer is a coherent design; a bespoke UI grafted onto MUI v5 is not.** Our second priority is a beautiful bespoke interface. The ported row functions produce `<tr>`/`<td>` JSX with a `className` threaded through, which is a clean seam: we keep the field selection, the choice-element handling, the sorting and the deduplication, and we own every element and every class. That is a better outcome than inheriting `Coverage.module.css`.

**Effort asymmetry favours fresh.** The genuinely hard, slow, unglamorous work here is FHIR display knowledge, and we take that with us. The rest of the repo is 7,500 lines of straightforward React that we would write differently anyway.

### Specifically worth porting (with the TCP MIT notice retained)

| Source | Port how | Why |
| --- | --- | --- |
| `src/lib/fhirUtil.js` (890 LOC) | Port near-verbatim, convert to TypeScript, keep function names so the ported tables keep working. Drop `renderImage`/`renderMoney` if unused | The FHIR display primitives. `parseDateTimePrecision` + `renderCrazyDateTime` + `parseCrazyDateTimeBestGuess` + `renderDosage`/`renderTiming` are the crown jewels |
| `src/lib/fhirTables.js` (1,124 LOC) | Port the `renderConfig` registry and all 19 `*Header`/`*Row`/`*Compare` triples; **replace** `renderJSX`'s emission with our own components; **replace** the `!renderConfig[rtype]` branch (`:158-161`) with a first-class "unrendered resources" surface | 19 resource types of field selection and sort order. Also port `uniquifyResources` (`:224-262`), including the "Observations already inside a DiagnosticReport" suppression, which is a real-world de-duplication insight |
| `src/lib/fhirDocs.js` (146 LOC) | Port the scoring model (`DOCINFO`, `getDocInfoFromContentType`, `getTitle`'s fallback ladder). **Fix** the three null paths at `:49`, `:55`, `:71`, `:93` and **add** `attachment.url` fetching | Attachment type detection and title fallback are fiddly and this gets them right; the null handling is the bug we already identified |
| `src/lib/codes.js:118-148` (`getDeferringCodeRenderer`) | Port the *pattern*, not the file. Back it with a real terminology server (Ontoserver `$lookup`) plus an offline dictionary fallback | Sync-placeholder-then-enrich is the right shape for code display in a synchronous render tree |
| `util/index.js` + the `public/codes-*.json` build | Port if we want an offline mode. Carry the SNOMED GPS CC-BY-4.0 and LOINC notices verbatim | Zero-backend terminology for a static site |
| `src/PatientSummarySection.js:27-56` | Port the algorithm as a pure function `chooseSectionView(section)` | The `text.status` = `additional`/`extensions` rule is a correct, non-obvious reading of the FHIR narrative contract |
| `src/lib/resources.js:44-88` (`organizeResources`) | Port the `all`/`byId`/`byType` index, keyed by **both** `fullUrl` and `ResourceType/id`. **Do not** port `findTypeInfo`'s five-predicate sniffing (`:94-107`): make bundle classification explicit and inspectable, and show the user *why* it classified as it did | The dual-keyed index is what makes reference resolution work; the sniffing is the "fight I lost" the author himself flags in the file header comment |
| `src/lib/SHX.js` | **Do not port.** Read it once as a checklist of what the wire actually requires, then write our own instrumented pipeline | See the trace-seam argument above |
| `smart-health-card-decoder` | **Use as a dependency** (MIT, 1.1.1, `verify(jws, directory)` + `Directory.create`). Also copy the `bePermissive` idea (`SHX.js:201-216`) and the multi-directory composition (`:189-199`) | SHC JWS verification and the VCI trust directory are not worth reimplementing, and `src/error.ts`'s `ErrorCode` enum is a good model for the error taxonomy our own pipeline needs |
| `src/lib/config.js:22-25` | Port the allowlist-by-known-key rule for URL query overrides | Correct instinct, cheap, and we will want debug switches in the URL |

### What our pipeline must do that theirs does not

Derived directly from the defects above, as the acceptance list for our diagnostics layer:

1. **Diagnose before fetching.** From the decoded payload alone: `localhost`/`127.0.0.1`/`::1`/`*.local`/RFC1918 host; `http:` on an `https:` page (mixed content, blocked before any request); non-43-character `key`; `U` combined with `P`; `v` other than 1; `exp` in the past; a `url` with no scheme. The localhost incident is fully solved here, with a one-line verdict, and no network at all.
2. **Name the hop.** Every failure carries which of the 6 steps failed (decode, pre-flight, manifest POST, file GET, JWE decrypt, FHIR parse), and never a stringified exception as the primary message.
3. **Keep the exchange.** Method, URL, request headers, request body, status, response headers, timing, and raw body for every hop, shown on demand. Diagnose `Content-Type: text/html` on a 200 manifest as "this is an error page, not a manifest".
4. **Say what a browser cannot know, and why.** A bare `TypeError` from `fetch` is one of DNS failure, connection refused, TLS rejection, or CORS preflight failure, and the browser deliberately will not say which. Present that as a short, ranked differential with a concrete next step per branch (including "the CORS preflight is an `OPTIONS`, and the SHL spec never mandates CORS, so your server may simply not implement it"), rather than as one opaque line.
5. **Support `zip: DEF`.** Pass `inflateRaw` to `compactDecrypt` (or handle it ourselves), and *report* when a file used it. Never blame the user's browser for a spec-legal payload.
6. **Check every status.** Including the file `location` GET, which the reference viewer does not check at all, and specifically call out an expired single-use location URL as its own diagnosis.
7. **Partial success is a first-class result.** Per-file outcomes, never one throw discarding the files that worked. Same for per-resource rendering.
8. **Never silently drop a resource.** Every resource in the payload is accounted for on screen: rendered, or listed as unrendered with its type and a raw-JSON escape hatch. `Provenance` in particular gets a real renderer, since it is how origin is stated.
9. **State the verification posture explicitly, including "none".** An unsigned `application/fhir+json` SHL must say "not signed, nothing here is cryptographically verified" rather than showing an empty space.
10. **Wrap every renderer in an error boundary** scoped to the smallest unit (section, then table, then row), so one bad resource costs one row and reports itself, never a white page.
11. **Echo the input.** Show the decoded payload, the manifest, the JWE protected headers, and the decrypted plaintext, because for a teaching tool the intermediate artefacts are the product.

## Appendix: source references used

All paths relative to the repo root at `e61c8799`.

- SHL pipeline: `src/lib/SHX.js` (`verifySHX`:125, `resolveSHX`:232, `resolveSHL`:301, `fetchSHLContent`:356, `fetchSHLManifest`:364, `singleFileManifest`:405, `decodeSHL`:420, `addVerifiableBundle`:478)
- Error rendering: `src/Data.js:82-86` (the `replaceAll("Error: ", '')`), `:214-233` (the effect and the empty catch), `:247-263`
- Renderer registry: `src/lib/fhirTables.js:59-147`, unrendered-type drop at `:158-161`
- Bundle classification: `src/lib/resources.js:94-237`
- Attachments: `src/lib/fhirDocs.js:45-94`, modal at `src/DocumentModalContext.js:52,68,135-190,349,424`
- Terminology: `src/lib/codes.js:19-106` (systems), `:118-148` (deferring renderer), `:161-170` (fallback to bare code); generator `util/index.js`
- Config: `src/lib/config.js`, `src/lib/defaults.js` (`tcpdev.org` override at `:58`)
- i18n: `src/lib/LanguageContext.js`, `src/lib/languages.js:2` (`en`), `:213` (`fr`)
- Verification display: `src/ValidationInfo.js:62-64` (the silent `none` case)
- `jose@4.15.9` zip behaviour: `src/runtime/browser/zlib.ts` (throwing `inflate` stub), `src/jwe/flattened/decrypt.ts:144-151,242-243`
- Decoder error taxonomy worth modelling: `smart-on-fhir/smart-health-card-decoder` `src/error.ts` (`ErrorCode` enum), `src/verify.ts` (the `reasons.join('|')` contract that becomes `bundle.reasons`)
- SHL spec: <https://docs.smarthealthit.org/smart-health-links/spec> (payload fields, `L`/`P`/`U` flags, manifest request fields including `embeddedLengthMax`, `files[]` `contentType`/`embedded`/`location`, JWE `alg: dir` / `enc: A256GCM` / optional `zip: DEF`, statuses 401 with `remainingAttempts` / 404 / 429, the `#`-fragment viewer URL convention, `"v":1`). The spec does **not** state CORS, TLS, or manifest size requirements.
- Author's architecture write-up: <https://shutdownhook.com/2023/09/09/anatomy-of-a-smart-health-card-link-viewer/>
- Safari's `TypeError: Load failed` for transport-layer fetch failures: <https://github.com/vercel/next.js/issues/46635>, <https://github.com/axios/axios/issues/6766>, <https://developer.apple.com/forums/thread/771127>
