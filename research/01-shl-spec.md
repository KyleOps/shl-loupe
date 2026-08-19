# 01. SMART Health Links: field-by-field and step-by-step reference for a browser-only viewer/debugger

Research note for `shl-loupe`. Everything below was fetched live on 2026-08-20 unless marked otherwise.
Quoted normative sentences are verbatim; section headings are given so a message in the tool can cite them.

## Sources actually read

| Source | URL | Notes |
| --- | --- | --- |
| SHL specification (CI build 1.0.0 STU 1, generated 2025-07-21) | `https://build.fhir.org/ig/HL7/smart-health-cards-and-links/links-specification.html` | primary |
| SHL specification (published STU 1) | `https://hl7.org/fhir/uv/smart-health-cards-and-links/STU1/links-specification.html` | diffed against CI build: **normative text identical** |
| Spec source markdown | `https://raw.githubusercontent.com/HL7/smart-health-cards-and-links/master/input/pagecontent/links-specification.md` | used to confirm exact wording and absences |
| SHC specification | `.../cards-specification.html` | JWS/JWKS/`shc:/` details |
| FAQ | `.../frequently-asked-questions.html` | QR capacity table, QR presentation guidance |
| Links examples | `.../links-examples.html` | two live, working `U`-flag SHLs (decrypted below) |
| Logical models | `.../StructureDefinition-ShlPayload.json`, `.../StructureDefinition-ShlManifest.json` | cardinalities and FHIR types |
| IG change log | `.../history.html` | what STU 1 added over the pre-HL7 spec |
| Pre-HL7 spec | `https://docs.smarthealthit.org/smart-health-links/spec/` | still live, older QR-logo advice differs |
| WHATWG Fetch | `https://fetch.spec.whatwg.org/` | CORS safelists, opaque responses |
| W3C Secure Contexts | `https://w3c.github.io/webappsec-secure-contexts/` | localhost is "Potentially Trustworthy" |
| WICG Local Network Access | `https://github.com/WICG/local-network-access` + `https://developer.chrome.com/blog/local-network-access` | Chrome 142 permission gate |
| `panva/jose` source + CHANGELOG | `https://raw.githubusercontent.com/panva/jose/main/src/lib/jwe_decrypt.ts`, `.../CHANGELOG.md` | `zip` support matrix, error strings |
| KTC (downstream SHL profile) | `https://ktc-spec.github.io/` | the only spec text found that requires CORS |
| Sean Nolan, "Nerdsplaining: SMART Health Links" | `https://shutdownhook.com/2023/06/22/nerdsplaining-smart-health-links/` | author of `viewer.tcpdev.org` and `SHLServer`; real-world interop notes |
| IANA URI scheme registry | `https://www.iana.org/assignments/uri-schemes/uri-schemes-1.csv` | `shc` is provisional, `shlink` is **not registered** |

---

## 0. The single most useful thing to know

**The SHL specification never mentions CORS.** `grep -ci cors links-specification.md` returns `0`. The only CORS requirement anywhere in the IG is for SHC issuer key publication (cards spec, *Determining keys associated with an issuer*):

> "Issuers SHALL publish their public keys as JSON Web Key Sets (see RFC7517), available at `<<iss value from JWS>>` + `/.well-known/jwks.json`, with Cross-Origin Resource Sharing (CORS) enabled, using TLS version 1.2 following the IETF BCP 195 recommendations or TLS version 1.3 (with any configuration)."

CORS appears in the IG index only as a *Referenced Specification*, with no obligation attached. So a browser-only SHL client is unsupported by construction: every manifest POST and every file GET depends on a header the spec does not require anyone to send. This is the root cause of most "it works for me" reports, and the tool must be able to say so in words a participant can act on.

The one spec text that closes the gap is downstream, KTC (*Retrieval Protocol / Response*):

> "Patient Apps SHOULD serve the retrieval endpoint with a permissive CORS policy (`Access-Control-Allow-Origin: *`) so that browser-based receivers can fetch payloads directly. The payload is encrypted, so CORS exposure adds no confidentiality risk."

Live evidence that the SMART reference server does the right thing (probed 2026-08-20):

```
$ curl -X OPTIONS https://api.vaxx.link/api/shl/abc \
    -H 'Origin: https://viewer.example.org' \
    -H 'Access-Control-Request-Method: POST' \
    -H 'Access-Control-Request-Headers: content-type' -D -
HTTP/2 204
access-control-allow-headers: content-type
access-control-allow-methods: GET,HEAD,PUT,PATCH,POST,DELETE
access-control-allow-origin: *
```

and that an unknown SHL yields a **404 with `content-length: 0`** (no JSON body at all), so the viewer must not require an error body.

---

## 1. The `shlink` payload

Section: *SMART Health Links Sharing Application Generates a SMART Health Link URI* → *Construct a SMART Health Link Payload*.

The payload is a JSON object, minified, base64url encoded (no padding in every published example), prefixed `shlink:/`, optionally prefixed with a viewer URL ending in `#`.

| Member | Card. | Prose type | Logical model type | Constraint / default |
| --- | --- | --- | --- | --- |
| `url` | 1..1 | `url` | `url` | Manifest URL (or, with `U`, the file URL). "SHALL include at least **256 bits of entropy**", "SHALL NOT exceed **128 characters** in length (note, this maximum applies to the `url` field of the SMART Health Link Payload, not to the entire SMART Health Link URI)." No scheme constraint is stated anywhere: `https` is only implied by examples. |
| `key` | 1..1 | "base64 url encoded string" | `string` | "Decryption key for processing files returned in the manifest. 43 characters, consisting of 32 random bytes base64urlencoded" |
| `exp` | 0..1 | `number` | `decimal` | "Number representing expiration time in Epoch **seconds**, as a hint to help the SMART Health Links Receiving Application determine if this QR is stale. (Note: epoch times should be parsed into 64-bit numeric types.)" |
| `flag` | 0..1 | `string` | `string` | "String created by concatenating single-character flags in alphabetical order". Absent means no flags. |
| `label` | 0..1 | `string` | `string` | "String no longer than **80 characters** that provides a short description of the data behind the SMART Health Link" |
| `v` | 0..1 | `number` | `integer` | "Integer representing the SMART Health Links protocol version this SMART Health Link conforms to. MAY be omitted when the default value (`1`) applies" |

Extensibility (section *Extensions*):

- "The specification reserves the name, `extension`, and will never define an element with that name."
- "property names beginning with an underscore (`_`) are reserved for extensions defined by downstream implementation guides or specific implementations."
- "Extension property names SHOULD be kept short due to payload size constraints, especially when SMART Health Links are represented as QR codes."
- "SMART Health Link Receiving Applications SHALL ignore extension properties they do not understand."
- Design note *Protocol Versioning*: "SHL Receiving Application SHALL ignore properties they don't recognize."

Real-world extension seen in the wild: `SHLServer` emits `_manifestId` in the payload (its author documents this as legal precisely because unknown properties must be ignored).

### Validation rules a debugger should run on the payload (each with a one-line verdict)

| Check | Verdict wording |
| --- | --- |
| `key` length != 43, or base64url decode != 32 bytes | "The key is N bytes after decoding, not 32. AES-256-GCM needs exactly 32, so nothing in this link can be decrypted." |
| `key` contains `+` or `/` or `=` | "The key uses standard base64, not base64url. Decode with the base64url alphabet or this link will not open in a conformant client." |
| `url` longer than 128 chars | "`url` is N characters. The spec caps it at 128 (*Establish a SMART Health Link Manifest URL*)." |
| `url` path entropy visibly low (short, sequential, guessable, e.g. `?bid=4836470`) | "This manifest URL carries far less than the required 256 bits of entropy, so anyone can enumerate other people's links." (The motivating incident's `?bid=4836470` fails this too, and it is a *privacy* finding worth surfacing beside the connectivity one.) |
| `label` longer than 80 chars | "`label` is N characters, over the 80-character cap." |
| `exp` present and > 1e11 | "`exp` looks like milliseconds. The spec says Epoch **seconds**; as seconds this reads as the year N." |
| `exp` in the past | "Expired N ago, according to the link's own hint. `exp` is only a hint: the hosting server enforces expiry, so a fetch may still work or may 404." |
| `v` present and > 1 | Per design note: "it SHOULD display an appropriate message to the user and SHOULD NOT proceed with a manifest request, unless it has some reason to believe that proceeding is safe." |
| unknown member | Show it, label it "ignored (spec requires unknown properties be ignored)". Underscore-prefixed and `extension` get a distinct "reserved for downstream extensions" label. |

---

## 2. Flags

Only three are defined. Verbatim from the payload table:

| Flag | Spec text | What it obliges the client to do |
| --- | --- | --- |
| `L` | "Indicates the SMART Health Link is intended for long-term use and manifest content can evolve over time" | Nothing mandatory. Enables optional polling: "When the original QR includes the `L` flag for long-term use, the client MAY periodically poll for changes in the manifest." Explicitly safe to ignore. |
| `P` | "Indicates the SMART Health Link requires a Passcode to resolve" | Prompt for a passcode and send it: `passcode` "SHALL be populated with a user-supplied Passcode if the `P` flag was present in the SMART Health Link payload". Cannot be ignored: the design note says so ("The `P` flag however cannot be ignored because the server will respond with an error if no passcode is provided"). |
| `U` | "Indicates the SMART Health Links's `url` resolves to a single encrypted file accessible via `GET`, bypassing the manifest. SHALL NOT be used in combination with `P`" | "the SMART Health Links Receiving Application SHALL NOT make a request for the manifest" and instead does `GET url?recipient=...`. |

Legality:

- Order: flags are concatenated "in alphabetical order", so `LP`, `LU`, `LPU` would be the ordered forms. A payload with `PL` is malformed but trivially recoverable: sort and note the deviation.
- `P` + `U` is **forbidden** by the `U` row. `PU` or `UP` is a hard spec violation; the tool should say the sender must pick one, because there is no place to put a passcode on a `GET`.
- `L` combines with either. `LU` is the most common form in the wild: both examples in the IG's own *Health Links Examples* page use `"flag":"LU"`.
- Unknown flag characters: "SHL Receiver Application SHALL ignore flag values they don't recognize". Show them, ignore them, do not fail.
- No flag member at all means manifest-based, no passcode, one-shot semantics.

---

## 3. URI forms and parsing

Three carrier forms, all carrying the identical base64url payload:

1. **Bare**: `shlink:/<base64url-payload>` (note single slash, not `//`; it is not an authority-based URI). Typical inside a QR.
2. **Viewer-prefixed**: `https://viewer.example.org#shlink:/<payload>`. The design note *Viewer URL Prefixes*: "By using viewer URLs that end in `#`, we take advantage of the browser behavior where `#` fragments are not sent to a server at the time of a request. Thus the SMART Health Link payload will not appear in server-side logs or be available to server-side processing when a link like `https://viewer.example.org#shlink:/ey...` is opened in a browser."
3. **Viewer path plus fragment**: the IG's own examples use `https://viewer.tcpdev.org/shlink.html#shlink:/ey...`, so the prefix is any URL ending in `#`, not necessarily a bare origin.

Normative points:

- The fragment is the intended carrier. **A query string is never sanctioned.** There is no text permitting `?shlink=...`; a tool that accepts it should accept it and warn, because putting the payload (which contains the decryption key) in a query sends the key to the viewer's own server and into its access logs. That is the single strongest privacy statement the tool can make.
- The base spec never states the extraction rule, but KTC does (*Carrier Forms*): "A SHLink may reach a receiver as a bare `shlink:/...` URI (typical for QR codes) or as a viewer-prefixed URL of the form `https://viewer.example/#shlink:/...` (typical when the link is copied as a URL). **Receivers SHALL accept both forms by extracting the `shlink:/` substring**; the embedded payload is identical either way."
- `shlink` is **not** an IANA-registered URI scheme (checked the registry: `shc` is there as Provisional, owner Josh Mandel; `shlink` is absent). That is why the viewer-prefixed form dominates in practice, and why a bare `shlink:/` pasted into a browser address bar does nothing.

### Reference parse (what the tool should implement, permissively, reporting every deviation)

```js
export function parseShlink(input) {
  const notes = [];
  let s = input.trim();

  // Whole-URL percent-encoding survives some mail clients: "%23shlink%3A%2F..."
  if (/%23shlink%3A%2F/i.test(s)) { s = decodeURIComponent(s); notes.push('input was percent-encoded'); }

  const i = s.lastIndexOf('shlink:/');            // last, not first: viewer prefixes may contain the token
  if (i < 0) throw new Error('no "shlink:/" token found');
  if (i > 0) {
    const prefix = s.slice(0, i);
    if (!prefix.endsWith('#')) notes.push(`viewer prefix does not end with "#" (${prefix}); the payload may reach the viewer's server`);
    if (/[?&][^#]*$/.test(prefix)) notes.push('payload appears to be in the query string, not the fragment: the decryption key is being sent to the viewer server');
  }

  let b64 = s.slice(i + 'shlink:/'.length).replace(/\s+/g, '');
  if (/[+/]/.test(b64)) { notes.push('payload uses standard base64 (+ or /), not base64url'); b64 = b64.replace(/\+/g,'-').replace(/\//g,'_'); }
  if (b64.endsWith('=')) notes.push('payload carries base64 padding (harmless, non-canonical)');

  const json = new TextDecoder().decode(b64urlToBytes(b64));
  const payload = JSON.parse(json);                // report the raw JSON too: the tool must show it
  return { payload, raw: json, notes };
}
```

Practical parse failures worth naming distinctly, because each has a different human cause: trailing punctuation from prose ("...open this link: `shlink:/ey...`."), a soft-wrapped newline inserted by an email client, a Zulip/Slack autolink that truncated at a `#`, a QR scanned with the `shlink:/` token duplicated, and a payload that decodes to valid UTF-8 but not valid JSON (usually truncation).

---

## 4. Manifest request (no `U` flag)

Section: *SMART Health Link Manifest Request*.

> "When no `U` flag is present, the SMART Health Links Receiving Application SHALL retrieve a SMART Health Links's manifest by issuing a request to the `url` as follows:
> * Method: `POST`
> * Headers:
>   * `content-type: application/json`"

Body members:

| Member | Card. | Type | Spec text | Server behaviour |
| --- | --- | --- | --- | --- |
| `recipient` | 1..1 | string | "A string describing the recipient (e.g.,the name of an organization or person) suitable for display to the Receiving User" | Logged/audited only. Not machine-parsed, not authenticated, and no length limit is given. |
| `passcode` | 0..1 | string | "SHALL be populated with a user-supplied Passcode if the `P` flag was present in the SMART Health Link payload" | Verified; failures counted against a lifetime cap. |
| `embeddedLengthMax` | 0..1 | integer | "Integer upper bound on the length of embedded payloads (see `.files.embedded`)" | "If the client has specified `embeddedLengthMax` in the manifest request, the sever SHALL NOT return embedded payload longer than the client-designated maximum." (the `sever` typo, and a truncated duplicate of the sentence, are in the published spec) |

Notes that matter:

- **The spec's `recipient` description is inconsistent between the two request paths.** The manifest POST table says "suitable for display to the Receiving User"; the `U`-flag GET says "suitable for display to the **Data Sharer**". The `U` wording is the sensible one (the sharer reads the audit log). Worth flagging in a teaching tool.
- Omitting `embeddedLengthMax` means the server may embed anything, or embed nothing. Per the SHLServer author: "if `embeddedLengthMax` is not present OR if the size of a file is <= its value, the `embedded` option may be used. Otherwise, a new, short-lived, unprotected URL representing the content should be allocated and placed into `location`."
- For a browser-only client, **a large `embeddedLengthMax` is a CORS survival strategy**, not just an optimisation: an embedded file needs zero extra cross-origin hops, whereas a `location` on a cloud bucket needs a *second* correctly configured CORS surface (see section 9). Sending something like `embeddedLengthMax: 4194304` and reporting whether the server honoured it is a genuinely useful debugger behaviour.
- No authentication of any kind is defined. No `Authorization`, no cookies. The tool must use `credentials: 'omit'`, because a wildcard `Access-Control-Allow-Origin` is rejected by the browser whenever credentials are included.

---

## 5. Manifest response

> "If the SMART Health Link request is valid, the Resource Server SHALL return a SMART Health Link Manifest File with `content-type: application/json`."

| Element | Prose card. | Logical model card. | Type | Notes |
| --- | --- | --- | --- | --- |
| (root) | 1..1 | | JSON object | |
| `status` | 0..1 | 0..1 | string | Fixed values: `"finalized"` \| `"can-change"` \| `"no-longer-valid"`. Added in STU 1. |
| `list` | 0..1 | 0..1 | FHIR `List` | "the designated location for extensions related to the manifest or individual files using the standard FHIR extension mechanism"; "Clients SHALL ignore FHIR extensions they do not understand." |
| `files` | **0..\*** in the prose table, **1..\*** in `ShlManifest` | array | Discrepancy: the prose table says `0..*`, the logical model says `1..*`. Treat an empty `files` array as legal-but-suspicious and say which document you are quoting. |
| `files[].contentType` | 1..1 | 1..1 | string | `application/smart-health-card`, `application/smart-api-access`, or `application/fhir+json` with an optional `fhirVersion` parameter. "Servers SHOULD populate the `fhirVersion` parameter; for example: `"application/fhir+json;fhirVersion=4.0.1"`. If absent, clients MAY assume the `fhirVersion` equals `4.0.1`." Values come from the FHIR version ValueSet. |
| `files[].location` | 0..1 | 0..1 | url | See below. |
| `files[].embedded` | 0..1 | 0..1 | string (compact JWE) | See below. |
| `files[].lastUpdated` | 0..1 | 0..1 | ISO 8601 / `dateTime` | Added in STU 1. |

`ShlManifest.files` explicitly prohibits `id`, `extension` and `modifierExtension` (max 0 in the logical model): manifest-level extensions belong in `list`, not on a file entry.

### `location` semantics (section *.files.location links*)

> "`location` (SHALL be present if no `embedded` content is included): URL to the file. This URL SHALL be short-lived and intended for single use."

> "The SMART Health Links Sharing Application SHALL ensure that `.files.location` links can be dereferenced without additional authentication, and that they are short-lived. The lifetime of `.files.location` links SHALL NOT exceed one hour. The SMART Health Links Sharing Application MAY create one-time-use `.files.location` links that are consumed as soon as they are dereferenced."

> "the SMART Health Links Receiving Application SHALL treat any manifest file locations as short-lived and potentially limited to one-time use. The SMART Health Links Receiving Application SHALL NOT attempt to dereference a manifest's `.files.location` link more than one hour after requesting the manifest, and SHALL be capable of re-fetching the manifest to obtain fresh `location` links in the event that they have expired or been consumed."

> "The SMART Health Links Sharing Application SHALL respond to the `GET` requests for `.files.location` URLs with: Headers: `content-type: application/jose`; Body: JSON Web Encryption"

Consequences for the tool, all of them non-obvious and all of them things a naive viewer gets wrong:

- **Never fetch a `location` twice.** A retry button that re-GETs a consumed one-time URL will fail and look like a server bug. Retry must re-POST the manifest first. On a passcode-protected link that means re-prompting, which means the retry can *cost an attempt*; see section 7.
- A location URL may be on a completely different origin from the manifest (S3/Azure/GCS presigned URLs are the spec's own suggestion), with its own CORS posture, TLS chain, and DNS. Report the origin per file.
- Track the manifest fetch timestamp and refuse (with an explanation) to dereference past 60 minutes, rather than letting the user see an opaque 403 from a bucket.

### `embedded` semantics

> "If present, the `embedded` value SHALL be up-to-date as of the time the manifest is requested."

> "Note that both `location` and `embedded` MAY be present. In that case, the `embedded` content and the content referenced by `location` SHALL be identical."

"Identical" here means the same *plaintext*: two independent encryptions of the same file are byte-different because the IV must differ per operation (see section 6). A tool that diffs the JWEs and reports "not identical" would be wrong; diff the decrypted plaintext.

Exactly one of `location`/`embedded` is required, both are allowed, neither is a hard error to report.

### The IG's own manifest example (`Binary-shl-manifest-1`)

```json
{
  "status": "finalized",
  "files": [
    { "contentType": "application/smart-health-card",
      "location": "https://bucket.cloud.example.org/file1?sas=MFXK6jL3oL3SI_lRfi_-cEfzIs5oHs6rRWmrsCAFzvk" },
    { "contentType": "application/smart-health-card",
      "embedded": "eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..8zH0NmUXGwMOqEya.xdGRpgyvE9vNoKzHlr4itKKW2vo<snipped>" },
    { "contentType": "application/fhir+json;fhirVersion=4.0.1",
      "location": "https://bucket.cloud.example.org/file2?sas=T34xzj1XtqTYb2lzcgj59XCY4I6vLN3AwrTUIT9GuSc",
      "lastUpdated": "2025-03-09T15:29:46Z" }
  ]
}
```

Decode that `embedded` header: `{"alg":"dir","enc":"A256GCM"}`. **No `cty`.** The IG's own example contradicts the prose requirement for a `cty` header; see section 6.

---

## 6. Encryption and decryption

Section: *Encrypting and Decrypting Files*.

> "SMART Health Link files are always symmetrically encrypted with a SMART Health Links-specific key. Encryption is performed using JSON Web Encryption (JOSE JWE) compact serialization with `"alg": "dir"`, `"enc": "A256GCM"`, and a `cty` header indicating the content type of the payload (e.g., `application/smart-health-card`, `application/fhir+json`, etc)."

> "The JWE MAY include a `zip` header with the value `DEF` to indicate that the plaintext of the JWE is compressed using the DEFLATE algorithm as specified in RFC 1951, before being encrypted. (Note, this indicates "raw" DEFLATE compression, omitting any zlib headers.)"

> "Because the same encryption key is used for all files over time within a SMART Health Link, the SHL Sharing Application SHALL ensure a unique nonce (also known as initialization vector, or IV) for each encryption operation, including initial encryption of each file and every subsequent update."

The algorithm set is closed and fixed: `alg` is always `dir` (no key wrapping, no key derivation, no ECDH), `enc` is always `A256GCM`. There is no `alg` negotiation to get wrong, which means every decryption failure has a small, enumerable set of causes.

### Compact JWE anatomy the tool should display part by part

`BASE64URL(protected) '.' BASE64URL(encrypted_key) '.' BASE64URL(iv) '.' BASE64URL(ciphertext) '.' BASE64URL(tag)`

| Part | Expected for an SHL file | Diagnostic if wrong |
| --- | --- | --- |
| 1 protected header | JSON with `alg:"dir"`, `enc:"A256GCM"`, optionally `cty`, optionally `zip:"DEF"`, sometimes `kid` | `alg` anything else: "this file was encrypted with key wrapping (`alg: <x>`), which the SHL profile does not use, so the link's `key` is not the content key." |
| 2 encrypted key | **empty string** (`dir` has no encrypted key) | Non-empty: "the sender's library emitted an encrypted CEK, so it did not really use `alg: dir`." |
| 3 IV | exactly **12 bytes** (96 bits) after base64url decode | 16 bytes is a known real interop bug. The SHLServer author: "there are libraries (like `python-jose` at the time of this writing) that mistakenly use 16. Which might seem ok because it "works", but some compliant libraries (like javascript `jose`) error out when they see the longer IV and won't proceed." Report the byte count explicitly. |
| 4 ciphertext | any length | |
| 5 tag | exactly **16 bytes** (128 bits) | |

AAD is the ASCII bytes of part 1 **exactly as received**. Never re-serialise the header before using it as AAD; key-order or whitespace changes break the tag.

### Web Crypto decryption, no library required

```js
const key = await crypto.subtle.importKey('raw', b64u(shl.key), 'AES-GCM', false, ['decrypt']);
const [h, ek, iv, ct, tag] = jwe.split('.');
const buf = new Uint8Array([...b64u(ct), ...b64u(tag)]);      // WebCrypto wants tag appended
let plain = new Uint8Array(await crypto.subtle.decrypt(
  { name: 'AES-GCM', iv: b64u(iv), additionalData: new TextEncoder().encode(h), tagLength: 128 },
  key, buf));
const hdr = JSON.parse(new TextDecoder().decode(b64u(h)));
if (hdr.zip === 'DEF') plain = await inflateRaw(plain);        // DecompressionStream('deflate-raw')
```

`DecompressionStream('deflate-raw')` is the right primitive (no library, available in Chrome 103+, Firefox 113+, Safari 16.4+), and it is exactly what current `jose` uses internally.

### The `kid`-as-thumbprint trick (verified, and the best diagnostic in the whole tool)

The IG's own example files carry a `kid` in the JWE protected header. I verified that it is the RFC 7638 thumbprint of the symmetric key as an `oct` JWK:

```
JWE header kid                                : ufYGlu_C8IuzJ3HV-wQqsIv-pMm2uZm-vGy37r3hwts
base64url(SHA-256(JSON.stringify({k:<shl.key>,kty:'oct'})))  : ufYGlu_C8IuzJ3HV-wQqsIv-pMm2uZm-vGy37r3hwts
```

(RFC 7638 for `oct` is the two members `k` and `kty`, lexicographically ordered, no whitespace.) So when a `kid` is present, the tool can say **before** attempting decryption: "this file was encrypted with a different key than the link carries" instead of showing an `OperationError`. AES-GCM failure is otherwise completely opaque: wrong key, wrong IV, truncated ciphertext and tampered ciphertext all produce the same bare `OperationError` in Web Crypto (and `JWEDecryptionFailed: decryption operation failed` in `jose`, which deliberately reveals nothing).

### `cty` is unreliable in practice, so do not gate on it

Empirically, of the three real JWEs I decoded, **none carried `cty`**:

- IG example 1 (`IPS_IG-bundle-01-enc.txt`): `{"enc":"A256GCM","alg":"dir","kid":"ufYGlu…"}`
- IG example 2 (`carin-insurance-example/jws.txt`): same header shape
- IG manifest example `embedded`: `{"alg":"dir","enc":"A256GCM"}`

Content-type resolution order for the viewer: manifest `files[].contentType` → JWE `cty` → sniff the plaintext (`{"verifiableCredential":[…]}` means SHC; `{"resourceType":…}` means FHIR; `{"access_token":…,"aud":…}` means smart-api-access). With the `U` flag there is no manifest, so `cty` or sniffing is all you have, and `cty` is usually missing.

### `zip: DEF`: the library-support minefield

Verified from `panva/jose` source and CHANGELOG:

| `jose` version | `zip: DEF` on decrypt |
| --- | --- |
| 4.x | supported, but only if the caller passes an `inflateRaw` option (the spec's own example does exactly this) |
| 5.0.0 to 6.1.x | **removed entirely**, citing RFC 8725 and GHSA-hhhv-q57g-882q (decompression resource exhaustion) |
| 6.2.0 (2026-03-05) and later, current 6.2.9 | re-introduced, gated by `maxDecompressedLength`, **default 250000 bytes** |

Exact error strings in current `jose` (`src/lib/jwe_decrypt.ts`, `src/lib/deflate.ts`):

- `JOSENotSupported: Unsupported JWE "zip" (Compression Algorithm) Header Parameter value.` (any `zip` other than `DEF`)
- `JWEInvalid: JWE "zip" (Compression Algorithm) Header Parameter MUST be in a protected header.`
- `JOSENotSupported: JWE "zip" (Compression Algorithm) Header Parameter is not supported.` (when `maxDecompressedLength: 0`)
- `JWEInvalid: Decompressed plaintext exceeded the configured limit`
- `JWEInvalid: Failed to decompress plaintext`
- `JOSENotSupported: JWE "zip" (Compression Algorithm) Header Parameter requires the DecompressionStream API.`

The 250 KB default is a live trap: a compressed IPS bundle over 250 KB decompressed throws "Decompressed plaintext exceeded the configured limit" in a viewer that just calls `compactDecrypt`. Realistic: the IG's own IPS example decrypts to 60,973 bytes uncompressed, but real summaries with narrative easily pass 250 KB.

KTC's field observation is worth quoting to senders: "several widely used JOSE libraries no longer implement JWE `zip`, and field testing has shown it to be a common receiver failure point. Senders SHOULD prefer uncompressed payloads for maximum receiver compatibility."

---

## 7. The `U` flag direct file path

> "When the `U` flag is present, the SMART Health Links Receiving Application SHALL NOT make a request for the manifest. Instead, the application SHALL retrieve a SMART Health Link's sole encrypted file by issuing a request to the `url` with:
> * Method: `GET`
>   * Query parameters
>     * `recipient`: Required. A string describing the recipient (e.g.,the name of an organization or person) suitable for display to the Data Sharer"

Differences from the manifest path, all of which change the debugger's behaviour:

| | Manifest path | `U` path |
| --- | --- | --- |
| Method | POST | GET |
| Where `recipient` goes | JSON body | **query string** (so it does land in server logs, unlike the fragment-carried payload) |
| Passcode | possible (`P`) | forbidden (`U` "SHALL NOT be used in combination with `P`") |
| `embeddedLengthMax` | available | no mechanism |
| Response body | `application/json` manifest | the JWE itself |
| Response content type | `application/json` (SHALL) | **unspecified in the base spec.** The `.files.location` rule says `application/jose`, and KTC says `Content-Type: application/jose`, but nothing binds the `U` response. |
| Browser preflight | always (see section 9) | never, if you send no custom headers |
| File count | 0..N | exactly 1 |
| Static hosting | needs a stateful server | works on any static host |

**Verified live** against the IG's own example (this is the one path a static viewer can rely on):

```
$ curl -sD - 'https://raw.githubusercontent.com/seanno/shc-demo-data/main/ips/IPS_IG-bundle-01-enc.txt?recipient=shl-loupe%20research'
HTTP/2 200
content-type: text/plain; charset=utf-8
access-control-allow-origin: *
content-length: 81448
```

So: the IG's own `U`-flag example is served as `text/plain`, not `application/jose`. **A viewer must never gate on the response content type.** It did send `access-control-allow-origin: *`, which is the only reason a browser can read it.

Decrypted (my run, so the numbers are real): 5 JWE parts with lengths `[108, 0, 16, 81298, 22]`, header `{"enc":"A256GCM","alg":"dir","kid":"ufYGlu_C8IuzJ3HV-wQqsIv-pMm2uZm-vGy37r3hwts"}`, IV 12 bytes, tag 16 bytes, encrypted_key empty, no `zip`, plaintext 60,973 bytes, a FHIR `Bundle` of `type: "document"` with 20 entries whose first entry is a `Composition`. The second IG example decrypts to `{"verifiableCredential":[…]}` whose JWS header is `{"zip":"DEF","alg":"ES256","kid":"bRwVimS-ynNCUFOonJDWPpt-pjGMPNG-hgfcsTe65UU"}` and whose payload has `iss: "https://raw.githubusercontent.com/seanno/shc-demo-data/main"`, `nbf: 1694239879.182`, `vc.type: ["https://smarthealth.cards#health-card"]`, `fhirVersion: "4.0.1"`.

Two teaching points fall out of that: `nbf` is a **float** here, so an integer-only parser mishandles it; and the issuer's `/.well-known/jwks.json` (fetched: it exists, `access-control-allow-origin: *`, two `EC`/`P-256`/`ES256` keys, one carrying `crlVersion: 1`) is on raw.githubusercontent.com, so full SHC signature verification is possible entirely client-side.

---

## 8. Errors: exactly what is normative, and what is not

The spec defines **two** status codes for the manifest path and nothing else.

| Condition | Status | Body | Spec text |
| --- | --- | --- | --- |
| SHL no longer active (expired, revoked, disabled by passcode exhaustion, never existed) | **404** | unspecified (the reference server sends `content-length: 0`) | "If the SMART Health Link is no longer active, the Resource Server SHALL respond with a 404." |
| Invalid passcode | **401** | JSON with `remainingAttempts` | "The error response for an invalid Passcode SHALL use the `401` HTTP status code and the response body SHALL be a JSON payload with `remainingAttempts`: number of attempts remaining before the SMART Health Links is disabled" |
| Manifest requests too frequent | **429** with `Retry-After` | unspecified | "If manifest requests are issued too frequently, the server MAY respond with HTTP status 429 Too Many Requests and a `Retry-After` header indicating the minimum time that a client SHALL wait before re-issuing a manifest request." |

Everything else is undefined: there is **no** distinct status for expired, for missing `recipient`, for a malformed body, for `P` with no passcode supplied, for a `U` link fetched with POST, or for a manifest URL that exists but has zero files. In practice servers return 400, 404, 405 or 500 for those, and the tool should present the raw status and body verbatim rather than pretending to know.

Critical consequences:

- **404 is fatally ambiguous.** Expired, revoked, passcode-exhausted, typo'd and never-existed all look identical, deliberately (a distinguishing response would be an oracle for which links exist). The tool must say "the server will not say which" rather than guess, and should then point at `exp` from the payload as the only local evidence.
- **`remainingAttempts` is the exact member name.** Singular `remainingAttempt`, `attemptsRemaining` and `remaining_attempts` are all wrong; a viewer that reads the wrong one silently shows nothing.
- `remainingAttempts` may legitimately be `0`, which means the link is now dead permanently and the next request will be a 404.
- **Never auto-retry a `P` link.** Each wrong passcode is charged against a lifetime cap that permanently disables the patient's link ("SHALL enforce a total lifetime count of incorrect Passcodes for a given SMART Health Links, to prevent attackers from performing an exhaustive Passcode search"). No retry-on-failure, no exponential backoff loop, no "test the connection" probe that includes a guessed passcode, no double-submit from a React effect firing twice under StrictMode. This is the one place where a debugging tool can destroy the data it was asked to inspect. State the count to the user before each attempt.
- The design note *Monitoring remaining attempts* tells servers to serialise in-flight requests, so parallel manifest requests may be rejected or queued: another reason not to fire concurrent probes.
- On what a client may tell the user: **the spec says nothing.** There is no client-side confidentiality obligation defined anywhere in the SHL specification. The defensible position for this tool is to be maximally transparent to the person holding the link (show status, headers, body, timings, the decoded payload) and to be careful only about the two things that leak beyond the operator's own screen: do not put the payload or key in a query string, in `document.title`, in an analytics call or in a server log, and do not persist the key.

### `Retry-After` is unreadable in a browser by default

`Retry-After` is **not** a CORS-safelisted response header. WHATWG Fetch, *CORS-safelisted response-header name*, lists exactly: `Cache-Control`, `Content-Language`, `Content-Length`, `Content-Type`, `Expires`, `Last-Modified`, `Pragma`, plus anything named in the response's CORS-exposed header-name list. So a cross-origin 429 gives JavaScript the status but `response.headers.get('Retry-After')` returns `null` unless the server sends `Access-Control-Expose-Headers: Retry-After`. The tool should detect a 429 whose `Retry-After` it cannot read and say precisely that, because it looks like a missing header to the participant and is in fact a missing `Access-Control-Expose-Headers`.

---

## 9. CORS: the whole story for a static, browser-only client

### The preflight is unavoidable on the manifest path

The manifest request is `POST` with `content-type: application/json`. Per WHATWG Fetch, *CORS-safelisted request-header*, a `content-type` is safelisted only when

> "If mimeType's essence is not "`application/x-www-form-urlencoded`", "`multipart/form-data`", or "`text/plain`", then return false."

`application/json` is therefore never safelisted, so **every SHL manifest request from a browser triggers a CORS preflight `OPTIONS`**. The sharing server must:

1. Answer `OPTIONS <manifest-url>` with 200 or 204 (not 404, not 405),
2. `Access-Control-Allow-Origin: *` or the viewer's exact origin,
3. `Access-Control-Allow-Methods: POST` (must include POST),
4. `Access-Control-Allow-Headers: content-type`,
5. and repeat `Access-Control-Allow-Origin` on the actual POST response.

Miss any one and the participant sees a bare `TypeError`. The five failure shapes have distinct Chrome console messages, which the tool should teach because the console is where the truth lives:

| Missing piece | Chrome console text (observed pattern) |
| --- | --- |
| no ACAO on the POST | `Access to fetch at '<url>' from origin '<origin>' has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource.` |
| OPTIONS not handled | `… Response to preflight request doesn't pass access control check: No 'Access-Control-Allow-Origin' header is present on the requested resource.` |
| OPTIONS returns 404/405 | `… Response to preflight request doesn't pass access control check: It does not have HTTP ok status.` |
| `content-type` not allowed | `… Request header field content-type is not allowed by Access-Control-Allow-Headers in preflight response.` |
| POST not allowed | `… Method POST is not allowed by Access-Control-Allow-Methods in preflight response.` |

None of that detail reaches JavaScript. `fetch` rejects with an indistinguishable `TypeError` in all five cases (see below).

### The `U` path and `location` fetches are simpler, and still break

A `GET` with no custom request headers is a simple request: no preflight. But reading the body still requires `Access-Control-Allow-Origin` on the response. Presigned S3/Azure/GCS URLs (the spec's own suggested implementation for `location`) return no CORS headers unless the bucket has an explicit CORS configuration, so the extremely common shape is: **manifest fetch succeeds, file fetch fails.** The tool should report CORS status per origin, not per link, and should name the file origin, because it is usually a bucket nobody thought about.

### Distinguishing "CORS blocked" from "host unreachable" without a backend

Both surface to JavaScript as the same `TypeError`. Observed messages by engine:

- Chromium: `TypeError: Failed to fetch`
- Firefox: `TypeError: NetworkError when attempting to fetch resource.`
- Safari/WebKit: `TypeError: Load failed`

The `TypeError` carries no status, no headers, no reason. This is exactly why the existing viewer could only say "type load fail". The workaround is a **`mode: 'no-cors'` reachability probe**, which is sound per Fetch's own model:

> "`no-cors`: Restricts requests to using CORS-safelisted methods and CORS-safelisted request-headers. Upon success, fetch will return an opaque filtered response."

> "An opaque filtered response is a filtered response whose type is "opaque", URL list is « », status is 0, status message is the empty byte sequence, header list is « », body is null…"

> "In other words, an opaque filtered response and an opaque-redirect filtered response are nearly indistinguishable from a network error."

"Nearly", and the difference is the whole trick: an opaque response **resolves** the promise, a network error **rejects** it.

```js
// Probe, never the real request. GET only, no custom headers.
async function reachable(url) {
  try {
    const r = await fetch(url, { mode: 'no-cors', method: 'GET', credentials: 'omit', cache: 'no-store' });
    return { reached: true, type: r.type };   // "opaque": something answered. CORS is the problem.
  } catch (e) {
    return { reached: false, error: String(e) }; // DNS / TCP / TLS / blocked. Not a CORS problem.
  }
}
```

Caveats to state in the UI: an opaque resolve also happens for 404s and 500s (it proves reachability, not correctness); a `no-cors` probe cannot tell you whether the *preflight* would pass; and on Chrome 142+ a probe against a loopback or private address still triggers the Local Network Access prompt. Complement the probe with `performance.getEntriesByName(url)`, whose presence or absence, plus `responseStatus`, gives a second (browser-dependent) signal.

---

## 10. The localhost class of failure, which is the tool's reason to exist

The motivating incident: `https://localhost:5173/api/shl-manifest?bid=4836470`.

The correct one-liner is not about CORS or TLS. It is: **`localhost` names the machine doing the asking. Every recipient resolves it to their own computer, so this link can only ever open on the machine that created it.** Port 5173 is the Vite dev-server default, and `?bid=4836470` is a sequential identifier, so the tool can add two more true statements without any network access at all: this is a development server, and this manifest URL carries nowhere near the "at least 256 bits of entropy" the spec requires (so the links are enumerable by anyone).

That failure is not exotic. The most widely read SHL tutorial (the SHLServer walkthrough) tells the reader to run the demo server on `https://localhost:7071` and the generated payload in that article is literally `"url": "https://localhost:7071/manifest/XruV__8k1Zn68NK1lsLH05ZmONtaUC85jmAW4zEHoTA"`. Anyone who follows the quick-start and shares the resulting link reproduces the incident exactly.

### Purely static classifier (no network, runs at parse time)

| Host pattern | Verdict |
| --- | --- |
| `localhost`, `localhost.`, `*.localhost` | "resolves to the recipient's own machine" |
| `127.0.0.0/8`, `::1`, `0.0.0.0`, `[::]` | same |
| `10/8`, `172.16/12`, `192.168/16` (RFC 1918), `100.64/10` (RFC 6598 CGNAT), `fc00::/7` | "a private address: reachable only from inside the sender's network" |
| `169.254/16`, `fe80::/10` | "a link-local address: reachable only on the same physical link" |
| `*.local`, `*.home.arpa`, `*.internal`, single-label hostnames with no dot | "resolvable only by the sender's local DNS or mDNS" |
| scheme `http:` with a non-loopback host, on an `https:` viewer | "mixed content: the browser will block this before it reaches the network" |
| host is an IP literal with an `https:` scheme | "a certificate for an IP literal almost never validates; expect a TLS failure" |
| non-standard port on a public host (`:3000`, `:5173`, `:8080`, `:7071`, `:4200`) | "a development-server port: it is probably not exposed outside the sender's machine" |
| `user:pass@host` in `url` | "credentials in the URL; browsers strip and/or refuse these for `fetch`" |
| `url` contains a fragment | "a fragment in the manifest URL is never sent to the server; it is almost certainly a copy/paste artefact" |

Mixed content precision, from W3C Secure Contexts § *Is origin potentially trustworthy?*: a host matching `127.0.0.0/8` or `::1/128`, or equal to `localhost`/`localhost.`/`*.localhost`, is "Potentially Trustworthy". So `http://localhost:3000` from an `https:` page is **not** blocked as mixed content, while `http://192.168.1.50:3000` **is**. Two visually similar links fail for entirely different reasons, and a good message names which.

### Chrome's Local Network Access changes the story again

Chrome 142 (28 October 2025) shipped the Local Network Access permission gate: a public site fetching a loopback address, an RFC 1918 address or a `.local` name now triggers a permission prompt, and per the WICG explainer "If the user denies the permission prompt, the request fails." The Permissions-Policy token is `local-network-access`, the fetch option is `targetAddressSpace` with values `"local"` or `"loopback"`, and the earlier Private Network Access preflight headers (`Access-Control-Request-Private-Network` / `Access-Control-Allow-Private-Network`) are abandoned in this design. The proposal also skips mixed-content upgrade/block for these requests ("we skip steps 6 and 7 of main fetch").

So for a localhost SHL, a browser-only viewer on Chrome 142+ can now hit: an LNA prompt, then a connection refused, then an opaque `TypeError`. Three layers, one useless message. The tool must pre-empt all three by classifying the URL before it ever calls `fetch`.

### The worst case, worth a warning of its own

If the recipient happens to be running *their own* dev server on port 5173 (very likely at a connectathon full of Vite users), `https://localhost:5173/api/shl-manifest?bid=4836470` reaches **their** server, not the sender's. The failure then becomes an inconsistent 404 or a mismatched JSON body, or in the worst case a 200 carrying a different patient's data. "It works on my machine, it 404s on yours, and it returned something weird for that third person" is a coherent single explanation, and only a tool that inspects the host can offer it.

---

## 11. Failure taxonomy for the debugger's verdict engine

Ordered roughly by how often it will fire at an event. Each row is a distinct message, not a generic error.

| # | Stage | Detectable how | One-line verdict |
| --- | --- | --- | --- |
| 1 | parse | no `shlink:/` token | "This is not a SMART Health Link: no `shlink:/` marker." |
| 2 | parse | base64url decode fails / JSON parse fails | "The payload is truncated or mangled (likely a line break inserted by email or chat)." |
| 3 | payload | `url` host is local/private (table above) | "Points at `<host>`, which only resolves on the sender's own machine/network." |
| 4 | payload | `key` not 32 bytes | "The key cannot work: N bytes, needs 32." |
| 5 | payload | `flag` contains both `P` and `U` | "`P` and `U` together are forbidden: there is nowhere to send a passcode on a GET." |
| 6 | payload | `v` > 1 | "This link claims protocol version N. Per the spec I should not attempt the manifest." |
| 7 | payload | `exp` in the past | "The link's own hint says it expired N ago (the server decides for real)." |
| 8 | network | `no-cors` probe rejects | "Nothing answered at `<host>`: DNS, TLS or connection failure, not a CORS problem." |
| 9 | network | `no-cors` probe resolves opaque, real request `TypeError`s | "The server answered but sent no CORS headers, so a browser cannot read the response. Ask them for `Access-Control-Allow-Origin`." |
| 10 | network | preflight-shaped failure (POST fails, GET probe fine) | "The server does not answer the `OPTIONS` preflight that `content-type: application/json` forces. It needs `Access-Control-Allow-Methods: POST` and `Access-Control-Allow-Headers: content-type`." |
| 11 | manifest | 404 | "The server says this link is not active. Expired, revoked, passcode-exhausted and never-existed all look identical by design." |
| 12 | manifest | 401 with `remainingAttempts` | "Wrong passcode. N attempts left before the link is permanently disabled. I will not retry automatically." |
| 13 | manifest | 401 without a readable body | "Passcode rejected, but the server did not send `remainingAttempts` as the spec requires, so I cannot tell you how many tries remain." |
| 14 | manifest | 429 | "Rate limited." plus, if `Retry-After` is unreadable, "and I cannot read `Retry-After` because the server did not expose it via `Access-Control-Expose-Headers`." |
| 15 | manifest | 200 but not JSON | "The manifest is not `application/json`. Got `<type>`; this is usually an HTML error page or a login redirect." |
| 16 | manifest | `files` empty | "The manifest is valid but lists no files." |
| 17 | manifest | file entry has neither `embedded` nor `location` | "File N is unusable: the spec requires one of `embedded` or `location`." |
| 18 | file | `location` fetch fails while manifest succeeded | "The manifest host is fine; the file host `<other-origin>` is not CORS-enabled. Presigned bucket URLs need an explicit CORS config." |
| 19 | file | `location` fetch fails on a retry | "That location URL was single-use or has expired (the spec caps them at one hour). Re-fetching the manifest is the only fix." |
| 20 | decrypt | `encrypted_key` non-empty | "Encrypted with key wrapping, not `alg: dir`. The link's `key` is not the content key." |
| 21 | decrypt | IV length != 12 | "IV is N bytes; A256GCM needs 12. `python-jose` produces 16 and conformant clients reject it." |
| 22 | decrypt | `kid` present and != thumbprint of `key` | "This file was encrypted with a different key than the link carries." |
| 23 | decrypt | AES-GCM `OperationError` with matching or absent `kid` | "Authentication tag check failed: wrong key, or the ciphertext was altered or truncated in transit." |
| 24 | decrypt | `zip` present and not `DEF` | "Unsupported compression `<value>`; only `DEF` is defined." |
| 25 | decrypt | inflate fails or exceeds a cap | "The plaintext claims raw DEFLATE but does not inflate (a zlib or gzip header is a common sender bug)." |
| 26 | content | plaintext is not JSON | "Decryption succeeded but the plaintext is not JSON. First bytes: `<hex>`." |
| 27 | content | `contentType` disagrees with the plaintext shape | "Declared `application/smart-health-card` but the payload is a FHIR `<resourceType>`." |

Rows 20 to 25 are the reason the tool must own its own JWE parsing rather than delegating to `compactDecrypt`: a library collapses them all into one opaque failure.

---

## 12. What the decrypted content can be, and how to render/verify each

| `contentType` | Plaintext shape | Viewer behaviour |
| --- | --- | --- |
| `application/smart-health-card` | `{"verifiableCredential": ["<JWS>", …]}` per the cards spec *via File Download*: "Contents SHALL be a JSON object with a `verifiableCredential` array containing one or more verifiable credential JWS strings" | For each JWS: header must have `alg:"ES256"`, `zip:"DEF"`, `kid` = "base64url-encoded SHA-256 JWK Thumbprint of the key (see RFC7638)"; payload is raw-DEFLATE of `{iss, nbf, exp?, vc:{type:["https://smarthealth.cards#health-card", …], rid?, credentialSubject:{fhirVersion, fhirBundle}}}`. Verify by fetching `<iss>/.well-known/jwks.json` (CORS is required here, and the `iss` "SHALL use the `https` scheme and SHALL NOT include a trailing `/`"), selecting by `kid`, and checking ES256 over ASCII(`header.payload`). Check `exp` if present: "Verifiers SHALL check the expiration, if present, and reject SMART Health Cards with an `exp` value that is before the current verification date-time." If the JWK has `crlVersion`, fetch `<iss>/.well-known/crl/<kid>.json` and reject when the computed `rid` is listed. |
| `application/fhir+json` (optionally `;fhirVersion=4.0.1`) | any FHIR resource or Bundle | "Note that this format is not inherently tamper-proof". Typically an IPS/AU PS `Bundle` of `type: "document"` whose first entry is a `Composition`: render section by section from the `Composition`, resolving `entry` references inside the bundle. |
| `application/smart-api-access` | SMART Access Token Response plus two defined extras: `aud` ("Required string indicating the FHIR Server Base URL where this token can be used") and `query` ("Optional array of strings acting as hints to the client") | Render as a live-API grant, never as data. A teaching tool should show the scopes and expiry and explicitly warn that this is a bearer token in the clear. |
| a FHIR `Endpoint` inside `application/fhir+json` | `connectionType` `{"system":"https://smarthealthit.org","code":"shl-interactive-experience"}` or `{"system":"http://terminology.hl7.org/CodeSystem/restful-security-service","code":"SMART-on-FHIR"}` | Two informative patterns from *Use Case Examples*: an interactive-experience URL (with optional `period`) and an "upgrade to SMART on FHIR" pointer (`address` is a FHIR base URL; the client may fetch `{address}/.well-known/smart-configuration`). |

`fhirVersion` handling: "Servers SHOULD populate the `fhirVersion` parameter… If absent, clients MAY assume the `fhirVersion` equals `4.0.1`."

---

## 13. QR encoding of an SHL

Section *Sharing User Transmits a SMART Health Link*:

> "When presenting a SMART Health Link in person, the Sharing User can also display the link as a QR code using any standard library to create a QR image from the SMART Health Link URI."
> "Create the QR with Error Correction Level M"
> "Consider presenting the SMART Logo in close approximation with the QR."

Key differences from SHC QRs, which trip people up constantly:

- **An SHL QR is just the URI text, byte mode.** There is no `shc:/` numeric-mode encoding, no `Ord(c)-45` two-digit trick, no chunking, no `shc:/C/N/` ordinal prefix. All of that machinery belongs to SHCs only.
- Encode the full string the sender wants scanned: either the bare `shlink:/…` or the viewer-prefixed `https://viewer.example.org#shlink:/…`. The viewer-prefixed form is what makes a scan work in a phone camera app, since `shlink:` is not an IANA-registered scheme and no OS has a default handler.
- Capacity: the FAQ's *Max JWS length for a V22 QR* table gives total data bits for a Version 22 symbol as Low 8048, Medium 6256, Quartile 4544, High 3536. In **byte** mode at ECC M that is roughly 6256/8 = 782 bytes minus the mode indicator and length count, so about 780 characters, which comfortably fits a viewer-prefixed SHL (typical payload is 180 to 300 base64url characters). Long `label`s and long viewer prefixes are what push a QR up in version and down in scannability.
- **Advice changed between spec generations, and both texts are still online.** The pre-HL7 spec said "Include the SMART Logo on a white background over the center of the QR, scaled to occupy 5-6% of the image area". The current FAQ says the opposite: "avoid placing an icon within the QR code. Because SMART Health Cards and Links often hold a large amount of data compared to other QR codes, maximizing the area available for information and fault tolerance is important." Current guidance is the three-layer stack: SMART logo top or bottom, QR in the middle, issuer name or logo opposite the SMART logo.
- **"`shlink` alongside other content in one QR" has no normative definition.** Nothing in the IG defines a composite QR. The only handle is KTC's extraction rule ("Receivers SHALL accept both forms by extracting the `shlink:/` substring"), which generalises safely: scan the QR, take the text, find the last `shlink:/`, and ignore whatever surrounds it. A scanner should therefore accept a QR whose text is `Patient summary for J. Argonaut https://viewer.example/#shlink:/ey…` and report the surrounding text as unrecognised context rather than failing. It should also handle the reverse mistake: a QR containing `shc:/5676…` is an SHC, not an SHL, and deserves its own message.

---

## 14. Conformance framing worth teaching at an event

Section *Conformance and User-Facing Identification*. A "Plain SMART Health Link" is one a baseline client can parse, retrieve and decrypt using only the core spec:

> "Successful processing by a baseline client SHALL NOT depend on any protocols, algorithms, or extensions beyond those defined in this core specification. A baseline client must be able to access and decrypt the fundamental data, even if it ignores optional or unrecognized elements."

> "The `shlink:` URI scheme SHALL only be used for Plain SHLs. Links that are not Plain SHLs SHALL use a different URI scheme."

> "The terms "SMART Health Link", "SMART Health Links", or the official logo SHALL only be used in user-facing contexts to identify Plain SHLs."

Downstream IGs adding mTLS, client JWTs, signatures or new crypto "SHALL define their own unique URI scheme and declare it on the HL7 Confluence page for SMART Health Link Extensions" (`https://confluence.hl7.org/spaces/FHIRI/pages/345088124/SMART+Health+Link+Extensions+Registry`).

This gives the tool a crisp, quotable verdict: **"this link is/is not a Plain SHL, and here is the clause it fails."** A link requiring an undeclared header, a bespoke auth token, or an extension the receiver must understand is not entitled to the `shlink:` scheme or the SMART branding, and saying so with a citation is more useful at a connectathon than any error message.

Signatures on the payload are permitted only under that constraint: "if the result is a SMART Health Link that clients can process as usual while ignoring the signature (e.g., a detached signature added as a property within the existing JSON SMART Health Link structure, next to label/flag/etc.), the resulting artifact can still be called a SMART Health Link."

---

## 15. Spec gaps, typos and internal inconsistencies the tool should surface

These are the things a teaching tool can be uniquely honest about. Each was verified in the published STU 1 text, not inferred.

1. **CORS is never required for the manifest or file endpoints.** The whole browser-client story is unspecified. Only KTC (downstream) says `Access-Control-Allow-Origin: *`.
2. **No `https` requirement on `url`.** The spec constrains entropy and length but never the scheme. `http://` manifest URLs are technically conformant and practically unusable from a browser.
3. **`files` cardinality disagrees** between the prose table (`0..*`) and `ShlManifest` (`1..*`).
4. **`cty` is described as part of the encryption ("and a `cty` header indicating the content type") but every example in the IG omits it**, including the manifest example's `embedded` value and both `U`-flag example files I decrypted.
5. **The `U`-flag response content type is unspecified.** `application/jose` is mandated only for `.files.location` GETs. The IG's own examples serve `text/plain; charset=utf-8`.
6. **`recipient` is described inconsistently** ("suitable for display to the Receiving User" in the manifest POST table, "suitable for display to the Data Sharer" in the `U` GET). The latter is the sensible reading.
7. **A grammatical break in the `embeddedLengthMax` rule**: the published text reads "the sever SHALL NOT embedded payload longer than the client-designated maximum" and then repeats the sentence correctly. Typo (`sever`) included, in both the CI build and published STU 1.
8. **No status code for "expired"**, no defined body for 404 or 429, and no defined error for a `P` link fetched with no passcode.
9. **No guidance on what a client may display**, so this tool's transparency posture is a design choice, not a conformance claim.
10. **`shlink` is not an IANA-registered URI scheme** (checked the registry; `shc` is Provisional, `shlink` is absent), yet the conformance section treats "the `shlink:` URI scheme" as an owned identifier.
11. **`exp` has no enforcement duty attached to the client.** It is a hint; the host enforces. A viewer that hard-refuses an `exp`-past link is being unhelpful, since the server may still serve it.
12. **Polling is under-specified on purpose** ("More detailed guidance on polling will require real-world implementation experience"), so no default interval exists. Do not invent one; use `Retry-After` when readable and otherwise require a manual refresh.

---

## 16. Reproducible artefacts for the build (all verified 2026-08-20)

Two working `U`-flag SHLs from the IG, usable as fixtures with no server:

```
# IPS document Bundle, 20 entries, plaintext 60,973 bytes, no zip
https://viewer.tcpdev.org/shlink.html#shlink:/eyJ1cmwiOiJodHRwczovL3Jhdy5naXRodWJ1c2VyY29udGVudC5jb20vc2Vhbm5vL3NoYy1kZW1vLWRhdGEvbWFpbi9pcHMvSVBTX0lHLWJ1bmRsZS0wMS1lbmMudHh0IiwiZmxhZyI6IkxVIiwia2V5IjoicnhUZ1lsT2FLSlBGdGNFZDBxY2NlTjh3RVU0cDk0U3FBd0lXUWU2dVg3USIsImxhYmVsIjoiRGVtbyBTSEwgZm9yIElQU19JRy1idW5kbGUtMDEifQ

# decodes to
{"url":"https://raw.githubusercontent.com/seanno/shc-demo-data/main/ips/IPS_IG-bundle-01-enc.txt",
 "flag":"LU","key":"rxTgYlOaKJPFtcEd0qcceN8wEU4p94SqAwIWQe6uX7Q","label":"Demo SHL for IPS_IG-bundle-01"}
```

The second example (`.../cards/carin-insurance-example/jws.txt`, same key, `"flag":"LU"`) decrypts to a `verifiableCredential` array, giving an end-to-end SHL to SHC to JWS to JWKS chain, all CORS-enabled, all static. Note the same demo key `rxTgYlOaKJPFtcEd0qcceN8wEU4p94SqAwIWQe6uX7Q` appears in the spec's encryption example, both IG examples and countless tutorials: it is a public, well-known key and the tool should recognise and label it as such ("this is the spec's demo key, so this content is not confidential").

Synthetic fixtures worth generating locally to exercise the verdict engine: a 16-byte IV, a non-empty `encrypted_key`, a `kid` mismatching the key, a `zip: DEF` file over 250 KB decompressed, a `zip` value of `GZ`, a manifest whose `files[0]` has neither member, a manifest returning `text/html`, a 401 with and without `remainingAttempts`, a 429 with `Retry-After` unexposed, a `PU` flag, an `exp` in milliseconds, and a `localhost` URL.

---

## 17. Direct implications for shl-loupe

1. **Classify the URL before touching the network.** Every high-value diagnosis in the motivating incident (localhost, dev port, low entropy) is available at parse time, offline, instantly.
2. **Own the JWE parsing.** Split the five parts, report header, IV length, tag length, `encrypted_key` emptiness and the `kid`-versus-key-thumbprint comparison before calling Web Crypto. A library gives one opaque failure where the tool needs eight distinct ones.
3. **Use Web Crypto plus `DecompressionStream('deflate-raw')`** rather than a JOSE library for decryption, and cap decompression yourself (GHSA-hhhv-q57g-882q is a real DoS class). If a library is used anywhere, pin `jose` at the current 6.2.9 and be explicit about `maxDecompressedLength`.
4. **Run a `mode:'no-cors'` GET probe** to split "unreachable" from "CORS-blocked", and say which. Never send the real manifest POST as a probe.
5. **Never auto-retry a passcode.** Show `remainingAttempts` before each attempt, require an explicit click, guard against double-submit, and say plainly that attempts are permanent.
6. **Never fetch a `location` twice**, and refuse (with an explanation) after 60 minutes.
7. **Request a generous `embeddedLengthMax`** and report whether the server embedded or handed out locations, because the embedded path is the only one with a single CORS surface.
8. **Never gate on `Content-Type`** for file responses, and never require `cty`.
9. **Keep the payload in the fragment only.** No query strings, no `history.pushState` of the key, no analytics, no logging of the key, no persistence by default.
10. **Show the raw wire at every stage** (payload JSON, request line, response status and headers, manifest JSON, JWE header, plaintext head) beside the human explanation. That is the difference between a viewer and a teaching tool.
11. **Quote the spec in the verdict.** Every message should be able to name its section heading, because at an event the argument is with a sender who believes their link is fine.
