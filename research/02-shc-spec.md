# 02: SMART Health Cards, verifying and displaying a card found inside an SHL

Scope: everything needed to take a `contentType: "application/smart-health-card"`
file out of an SHL manifest and turn it into (a) a verified-or-explained trust
verdict and (b) a rendered clinical payload. Every claim below is either quoted
from a normative source or was reproduced against the spec's own example corpus
on 2026-08-20 (commands and outputs inline).

## 0. Which document is normative

Two documents, same content, different governance. Both are live.

| Document | URL | Version |
|---|---|---|
| HL7 IG (current normative home) | `https://build.fhir.org/ig/HL7/smart-health-cards-and-links/cards-specification.html` | `hl7.fhir.uv.smart-health-cards-and-links` v1.0.0, `status: active`, `releaseLabel: STU 1`, `fhirVersion: 4.0.1` |
| Legacy VCI-numbered spec (still cited everywhere in the wild) | `https://spec.smarthealth.cards/` | last VCI number 1.4.0 |
| Type CodeSystem | `https://terminology.smarthealth.cards/CodeSystem-health-card.html` | canonical `https://smarthealth.cards#`, version 2.0.0, `status: draft`, date 2023-07-06, `caseSensitive: false` |

Raw sources (use these, the HTML is Docusaurus-mangled):

```
https://raw.githubusercontent.com/HL7/smart-health-cards-and-links/master/input/pagecontent/cards-specification.md
https://raw.githubusercontent.com/HL7/smart-health-cards-and-links/master/input/pagecontent/cards-changelog.md
https://raw.githubusercontent.com/HL7/smart-health-cards-and-links/master/input/pagecontent/frequently-asked-questions.md
https://raw.githubusercontent.com/smart-on-fhir/health-cards/main/FAQ/qr.md
```

The spec has **no numbered sections**. Cite by anchor: `#health-cards-are-compact`,
`#determining-keys-associated-with-an-issuer`, `#encoding-qrs`, `#revocation`,
`#expiration-of-health-cards`, `#via-file-download`, `#certificates`.

## 1. How a health card arrives inside an SHL

An SHL manifest entry (`links-specification.md` line 341 onward) declares:

> `contentType`: One of the following values:
> * `"application/smart-health-card"` or
> * `"application/fhir+json"` with optional `fhirVersion` parameter

and defines the first as:

> `application/smart-health-card`: a JSON file with a `.verifiableCredential` array containing SMART Health Card JWS strings, as specified in the [via File Download] section of the SMART Health Cards specification.

So the decrypt-then-parse chain is **two independent compression layers and two
independent crypto layers**, and a debugger must not conflate them:

```
manifest .files[i].embedded  (or GET .files[i].location)
  -> JWE compact, 5 parts, protected header { alg: "dir", enc: "A256GCM", cty: "application/smart-health-card" [, zip: "DEF"] }
  -> decrypt with SHL payload .key (base64url, 32 bytes)          <-- SHL layer, symmetric
  -> [ if JWE zip: DEF, raw-inflate the plaintext ]               <-- SHL layer compression
  -> UTF-8 JSON: { "verifiableCredential": [ "<jws>", ... ] }     <-- the .smart-health-card file
  -> for each jws: split on "." into h.p.s
     -> protected header { alg: "ES256", zip: "DEF", kid }
     -> raw-inflate base64url-decode(p)                           <-- SHC layer compression
     -> JSON JWT claims { iss, nbf, [exp], vc: { type, credentialSubject, [rid] } }
     -> verify ES256 over ASCII(h + "." + p) with issuer JWKS     <-- SHC layer, asymmetric
```

The JWE `zip: "DEF"` header is **optional and separate** from the JWS `zip: "DEF"`
which is **mandatory**. Spec, *Encrypting and Decrypting Files*:

> The JWE MAY include a `zip` header with the value `DEF` to indicate that the plaintext of the JWE is compressed using the DEFLATE algorithm as specified in RFC 1951, before being encrypted. (Note, this indicates "raw" DEFLATE compression, omitting any zlib headers.)

Note `jose@4`+ in the browser does **not** ship an inflate implementation. The
spec's own decryption example passes one in:

```ts
const decrypted = await jose.compactDecrypt(
  fileEncrypted,
  jose.base64url.decode(shlinkPayload.key),
  {inflateRaw: async (bytes) => pako.inflateRaw(bytes)}
);
console.log(decrypted.protectedHeader.cty)  // application/smart-health-card
```

Forgetting `inflateRaw` fails only on the subset of SHLs whose producer set JWE
`zip`, which is exactly the kind of works-on-my-machine bug this tool exists to
name.

## 2. The `.smart-health-card` file format

*via File Download*:

> The file SHALL be served with a `.smart-health-card` file extension and SHALL be provided with a MIME type of `application/smart-health-card` (e.g., web servers SHALL include `Content-Type: application/smart-health-card` as an HTTP Response containing a Health Card), so the Health Wallet app can be configured to recognize this extension and/or MIME type. Contents SHALL be a JSON object with a verifiableCredential array containing one or more verifiable credential JWS strings:

```json
{
  "verifiableCredential": [
    "<<Verifiable Credential as JWS>>",
    "<<Verifiable Credential as JWS>>"
  ]
}
```

Facts a viewer must handle:

- The array is **1..\***. A single file legitimately carries several cards from
  possibly **different issuers**. Verify and badge each independently. Do not
  collapse to one trust verdict.
- There is **no** other top-level member defined. Extra members are not an error
  to report as fatal, but an unexpected top-level key is a good "this producer is
  improvising" hint.
- Verified against `example-00-e-file.smart-health-card`: top keys
  `['verifiableCredential']`, 1 entry, byte-identical to
  `example-00-d-jws.txt` (804 chars).
- Also the deep-link form, which a debugger should accept as paste input:
  `<<base URL>>#{"verifiableCredential":["<jws>",...]}`, spec recommends the base
  URL "SHOULD end with `/SMARTHealthCard/`" and notes the fragment is chosen
  "to ensure that no data is transmitted to the server".

## 3. The `shc:/` QR encoding, the constant 45

*Encoding QRs*, verbatim, this is the whole rule:

> A segment encoded with `numeric` mode consisting of the characters `0`-`9`. Each character "c" of the JWS is converted into a sequence of two digits as by taking `Ord(c)-45` and treating the result as a two-digit base ten number. For example, `'X'` is encoded as `43`, since `Ord('X')` is `88`, and `88-45` is `43`. (The constant "45" appears here because it is the ordinal value of `-`, the lowest-valued character that can appear in a compact JWS. Subtracting 45 from the ordinal values of valid JWS characters produces a range between 00 and 99, ensuring that each character of the JWS can be represented in exactly two base-10 numeric digits.)

The QR is **two segments**, and this matters for producing QRs and for explaining
scanner failures:

1. `bytes` mode segment: the fixed string `shc:/` (registered as an
   [IANA URI scheme](https://www.iana.org/assignments/uri-schemes/prov/shc)),
   plus, only when chunking, `C` + `/` + `N` + `/`.
2. `numeric` mode segment: the digit pairs.

Rationale quoted, worth surfacing in a teaching tool:

> (The reason for representing Health Cards using Numeric Mode QRs instead of Binary Mode (Latin-1) QRs is information density: with Numeric Mode, 20% more data can fit in a given QR, vs Binary Mode. This is because the JWS character set conveys only log_2(65) bits per character (~6 bits); binary encoding requires log_2(256) bits per character (8 bits), which means ~2 wasted bits per character.)

Decoder, exact, and the invariants a debugger should assert:

```js
// input: the full scanned string, e.g. "shc:/5676290952..."
function decodeShc(scanned) {
  if (!scanned.startsWith('shc:/')) throw new Error('not an shc:/ QR');
  let body = scanned.slice('shc:/'.length);
  let chunkIndex = 1, chunkTotal = 1;
  const m = /^(\d+)\/(\d+)\//.exec(body);          // chunked form, DEPRECATED
  if (m) { chunkIndex = +m[1]; chunkTotal = +m[2]; body = body.slice(m[0].length); }
  if (!/^\d+$/.test(body))  throw new Error('numeric segment has non-digits');
  if (body.length % 2 !== 0) throw new Error('odd digit count, QR truncated');
  let jws = '';
  for (let i = 0; i < body.length; i += 2) {
    const n = Number(body.slice(i, i + 2));
    const code = n + 45;
    if (code < 45 || code > 122) throw new Error(`digit pair ${body.slice(i,i+2)} at ${i} maps outside JWS charset`);
    jws += String.fromCharCode(code);
  }
  return { jws, chunkIndex, chunkTotal };
}
```

Invariants, all confirmed empirically:

- `digits.length === 2 * jws.length` exactly. Verified: example-00 QR digit
  segment is 1608 chars, JWS is 804 chars.
- First three digit pairs of every SHC are **`56 76 29`**, which decodes to
  `eyJ` (the start of base64url-encoded `{"`). A scanned string not starting
  `shc:/5676` is either not an SHC or not a compact JWS. Cheap, high-signal check.
- Valid digit-pair range: the compact-JWS charset is `A-Z a-z 0-9 - _ .`, so
  ordinals 45 to 122, so pairs `00` (for `-`) to `77` (for `z`). A pair of `78`
  to `99` is impossible and means corruption or a non-SHC numeric payload.
- Chunk index `C` is **1-indexed**, not 0-indexed. Verified: the three chunk
  files of example-02 carry prefixes `shc:/1/3/`, `shc:/2/3/`, `shc:/3/3/`.
  (Confusingly, the spec's own published filenames are `...-value-0.txt` to
  `...-value-2.txt`, 0-indexed. Do not take the filename as the ordinal.)

Reproduction:

```
$ python3 -c "..."   # see log below
QR prefix: shc:/5676290 ... total len 1613
digits len: 1608 even? True == 2*jwslen? True
QR decode == JWS: True
first 3 digit pairs: ['56', '76', '29'] -> 'eyJ'
```

## 4. Chunked QRs, `shc:/C/N/`, deprecated but still in the wild

Marked **DEPRECATED** in the IG with this note:

> *Deprecation note: As of December 2022, support for chunking has not been widely adopted in production SHC deployments. For SHCs that need to be presented as QRs, we recommend limiting payload size to fit in a single QR (when possible), or else considering SMART Health Links.*

Still normative when used:

> Commonly, SMART Health Cards will fit in a single V22 QR code. Any JWS longer than 1195 characters SHALL be split into "chunks" of length 1191 or smaller; each chunk SHALL be encoded as a separate QR code of V22 or lower, to ensure ease of scanning. Each chunk SHALL be numerically encoded and prefixed with an ordinal as well as the total number of chunks required to re-assemble the JWS

> * Producers of QR codes SHOULD balance the sizes of chunks. For example, if a JWS is 1200 characters long, producers should create two ~600 character chunks rather than a 1191 character chunk and a 9 character chunk.
> * Consumers of QR codes SHOULD allow for scanning the multiple QR codes in any order. Once the full set is scanned, the JWS can be assembled and validated.

Verified against example-02: JWS is 3285 chars, 3 chunks, each exactly 1095
chars (balanced, as the SHOULD asks), `N` = 3 in all three, `C` = 1,2,3,
reassembly in `C` order is byte-identical to `example-02-d-jws.txt`.

QR capacity table (from `FAQ/qr.md`, the authority for the 1195 number). The
formula: `JWS Size = (TotalDataBits - 76) * 3/20`, where 76 bits is the
`shc:/` bytes segment (20 header + 40 data) plus the numeric segment's 16-bit
header.

| Error correction | V22 total data bits | Max JWS length |
|---|---|---|
| Low | 8048 | **1195** |
| Medium | 6256 | 927 |
| Quartile | 4544 | 670 |
| High | 3536 | 519 |

40mm x 40mm at V22 (105x105 modules) is the stated physical target.

## 5. The JWS: protected header, `kid`, raw DEFLATE, signature form

*Health Cards are Compact*, verbatim:

> Issuers SHALL ensure that the following constraints apply at the time of issuance:
>
> * JWS Header
>     * header includes `alg: "ES256"`
>     * header includes `zip: "DEF"`
>     * header includes `kid` equal to the base64url-encoded (see section 5 of RFC4648) SHA-256 JWK Thumbprint of the key (see RFC7638)
>
> * JWS Payload
>     * payload is minified (i.e., all optional whitespace is stripped)
>     * payload is compressed with the DEFLATE (see RFC1951) algorithm before being signed (note, this should be "raw" DEFLATE compression, omitting any zlib or gz headers)

Observed header from example-00 (note member order is **not** canonical, `zip`
comes first here, so never compare header strings, always parse):

```json
{"zip":"DEF","alg":"ES256","kid":"3Kfdg-XwP-7gXyywtUfUADwBumDOPKMQx-iELL11W9s"}
```

### 5.1 Raw DEFLATE, the single most common producer bug

"Raw" means **no zlib wrapper (RFC 1950) and no gzip wrapper (RFC 1952)**.
Decode with a negative window-bits value.

```js
// browser: DecompressionStream has NO raw-deflate mode that is universally safe
//   'deflate-raw' exists in Chromium/Safari but not older Firefox; feature-detect.
// fflate (recommended, 8kB, sync, works everywhere):
import { inflateSync, strFromU8 } from 'fflate';
const claims = JSON.parse(strFromU8(inflateSync(b64uToBytes(p))));
// pako equivalent: pako.inflateRaw(bytes)
// node:  zlib.inflateRawSync(bytes)
// python: zlib.decompress(raw, -15)
```

Empirically, on example-00: `457` compressed bytes inflate to `1374` bytes
(3.01x). `zlib.decompress(raw)` with default wbits raises
`error -3 while decompressing data: incorrect header check`. First two bytes of
the raw stream are `dd 92`, and crucially **not** `78 9c` (zlib default) nor
`1f 8b` (gzip).

**Debugger heuristic to ship**: sniff the first two bytes of the inflate input.

| First bytes | Diagnosis |
|---|---|
| `78 01` / `78 5e` / `78 9c` / `78 da` | Producer emitted **zlib-wrapped** DEFLATE, violating the "omitting any zlib or gz headers" rule. Retry with `inflate` (wbits 15) and report the defect. Signature will still verify, because the signature is over the compressed bytes. |
| `1f 8b` | Producer emitted **gzip**. Same story, retry with wbits 31. |
| anything else | Presumed raw. If raw inflate then fails, the payload is corrupt or truncated. |

This distinction is worth a first-class message: a zlib-wrapped SHC verifies
cryptographically and is still non-conformant, so a tool that silently
auto-retries teaches the wrong lesson. Auto-recover **and** warn.

### 5.2 `kid` is RFC 7638, and it is checkable offline

RFC 7638 for an EC key: JSON with **exactly** the required members
`crv`, `kty`, `x`, `y`, lexicographically ordered, no whitespace, then SHA-256,
then base64url without padding.

```js
async function jwkThumbprint(jwk) {           // EC P-256 only
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return b64u(new Uint8Array(digest));
}
```

Verified against the live example JWKS, both keys:

```
kid in JWKS : 3Kfdg-XwP-7gXyywtUfUADwBumDOPKMQx-iELL11W9s
RFC7638 calc: 3Kfdg-XwP-7gXyywtUfUADwBumDOPKMQx-iELL11W9s   MATCH
thumbprint input: {"crv":"P-256","kty":"EC","x":"11XvRWy1I2S0EyJlyf_bWfw_TQ5CJJNLw78bHXNxcgw","y":"eZXwxvO1hvCY0KucrPfKo7yAyMT6Ajc3N7OkAB6VYy8"}

kid in JWKS : EBKOr72QQDcTBUuVzAzkfBTGew0ZA16GuWty64nS-sw
RFC7638 calc: EBKOr72QQDcTBUuVzAzkfBTGew0ZA16GuWty64nS-sw   MATCH
```

This gives the debugger a distinct, actionable finding the reference tools also
emit as `ISSUER_KID_MISMATCH`: an issuer whose JWKS entry has a `kid` that is not
the RFC 7638 thumbprint of its own `x`/`y`. That is a producer bug independent of
whether the signature verifies, and it breaks any verifier that indexes keys by
recomputed thumbprint rather than by the literal `kid` string.

### 5.3 Signature is 64-byte raw `r || s`, not DER

JWS ES256 (RFC 7515 Appendix A.3) is fixed-width concatenated `r || s`. Confirmed:
example-00's signature decodes to exactly **64 bytes**, and verification succeeds
with `dsaEncoding: "ieee-p1363"` and **fails** (returns false, no throw) with
`dsaEncoding: "der"`.

```js
// Web Crypto is already ieee-p1363 for ECDSA, so this is the correct browser path
const key = await crypto.subtle.importKey('jwk',
  { kty:'EC', crv:'P-256', x: jwk.x, y: jwk.y },
  { name:'ECDSA', namedCurve:'P-256' }, false, ['verify']);
const ok = await crypto.subtle.verify(
  { name:'ECDSA', hash:'SHA-256' }, key,
  b64uToBytes(s),
  new TextEncoder().encode(h + '.' + p));   // ASCII of the two base64url segments
```

The signing input is the **ASCII bytes of `h + "." + p`**, hashed once by the
ECDSA operation. A double-hash is a real and hard-to-see producer bug: it is
byte-stable, so it reproduces its own golden vectors forever while failing every
independent verifier. Distinguish it from a wrong-key failure by trying
verification over `SHA-256(ASCII(h.p))` as the message and, if that succeeds,
naming it as double-hashing.

A DER-encoded signature is 70 to 72 bytes typically and starts `0x30`. The
reference tool has a dedicated message for it worth copying:

> Signature appears to be in DER encoded form. Signature is expected to be 64-byte r||s concatenated form.

## 6. Issuer key resolution, exact path and JWK requirements

*Determining keys associated with an issuer*, verbatim:

> Each public key used to verify signatures is represented as a JSON Web Key (see RFC7517), with some of its properties encoded using base64url (see section 5 of RFC4648):
>
> * SHALL have `"kty": "EC"`, `"use": "sig"`, and `"alg": "ES256"`
> * SHALL have `"kid"` equal to the base64url-encoded SHA-256 JWK Thumbprint of the key (see RFC7638)
> * SHALL have `"crv": "P-256`, and `"x"`, `"y"` equal to the base64url-encoded values for the public Elliptic Curve point coordinates (see RFC7518)
> * SHALL NOT have the Elliptic Curve private key parameter `"d"`
> * If the issuer has an X.509 certificate for the public key, SHALL have `"x5c"` equal to an array of one or more base64-encoded (_not_ base64url-encoded) DER representations of the public certificate or certificate chain (see RFC7517 section 4.7). The public key listed in the first certificate in the `"x5c"` array SHALL match the public key specified by the `"crv"`, `"x"`, and `"y"` parameters of the same JWK entry. If the issuer has more than one certificate for the same public key (e.g. participation in more than one trust community), then a separate JWK entry is used for each certificate with all JWK parameter values identical except `"x5c"`.

(Note the `"crv": "P-256` typo, a missing closing quote, is in the spec source itself.)

The URL rule, verbatim, and the trailing-slash sentence is the one that bites:

> Issuers SHALL publish their public keys as JSON Web Key Sets (see RFC7517), available at `<<iss value from JWS>>` + `/.well-known/jwks.json`, with Cross-Origin Resource Sharing (CORS) enabled, using TLS version 1.2 following the IETF BCP 195 recommendations or TLS version 1.3 (with any configuration).

> The URL at `<<iss value from JWS>>` SHALL use the `https` scheme and SHALL NOT include a trailing `/`. For example, `https://smarthealth.cards/examples/issuer` is a valid `iss` value (`https://smarthealth.cards/examples/issuer/` is **not**).

Consequences for the resolver, stated precisely:

- The path is **string concatenation**, not URL resolution. `iss` +
  `"/.well-known/jwks.json"`. Never `new URL('/.well-known/jwks.json', iss)`,
  which discards the path component and would turn
  `https://ehr.example.org/fhir/r4` into `https://ehr.example.org/.well-known/jwks.json`.
  Many real issuers have deep paths (see the Epic and Cerner examples in section 9),
  so this bug is silent on the spec's example and fatal in the field.
- A trailing slash in `iss` is a **reportable producer defect** (`INVALID_ISSUER_URL`),
  and it also yields a double slash in the derived URL. Empirically,
  `https://spec.smarthealth.cards/examples/issuer//.well-known/jwks.json`
  returns 200 (GitHub Pages normalises), so many issuers will appear to work
  anyway. Report the defect, then fetch the normalised URL as a fallback and say
  you did. Two servers behaving differently here is a classic
  works-on-my-machine cause.
- `http://` `iss` is a hard defect. So is a bare hostname with no scheme.
- Key selection: filter `.keys[]` on `kty === 'EC' && use === 'sig' && alg === 'ES256'`,
  then match the header `kid` literally. Spec: "**Signing keys** in the `.keys[]`
  array can be identified by `kid` following the requirements above (i.e., by
  filtering on `kty`, `use`, and `alg`)."
- Distinguish **`kid` not in the set** from **`kid` present but signature fails**.
  The former means key rotation, wrong environment, or an issuer that never
  published; the latter means tampering or a signing bug. The reference tool
  separates them: `JWS verification failed: can't find key with 'kid' = ${kid} in issuer set`
  versus `JWS verification failed`.

Live example JWKS (`https://spec.smarthealth.cards/examples/issuer/.well-known/jwks.json`),
useful as the tool's known-good fixture. Two keys: one plain with
`"crlVersion": 1`, one with a 3-cert `x5c` chain and no `crlVersion`.

### 6.1 X.509, `x5c`, PKI trust

*Certificates*, verbatim, this is the whole algorithm:

> If the Verifier supports PKI-based trust frameworks and the Health Card issuer includes the `"x5c"` parameter in matching JWK entries from the `.keys[]` array, the Verifier establishes that the issuer is trusted as follows:
>
> 1. Verifier validates the leaf certificate's binding to the Health Card issuer by:
>     * matching the `<<iss value from JWS>>` to the value of a `uniformResourceIdentifier` entry in the certificate's Subject Alternative Name extension (see RFC5280 section 4.2.1.6), and
>     * verifying the signature in the Health Card using the public key in the certificate.
> 2. Verifier constructs a valid certificate path of unexpired and unrevoked certificates to one of its trusted anchors (see RFC5280 section 6).

A browser app can do step 1 fully (parse the leaf DER, read the SAN URI, compare
to `iss`, compare the SPKI to `x`/`y`) and **cannot** do step 2 without shipping
trust anchors and a path builder. Do step 1, display the chain's subjects and
validity windows, and say plainly that path validation to a trust anchor is not
performed. The example issuer's leaf SAN decodes to
`https://spec.smarthealth.cards/examples/issuer`, chaining
`SMART Health Card Example Issuer` to `... Example CA` to `... Example Root CA`,
with the leaf valid 2021-06-01 to 2022-06-01 (so **expired**, a good test case
for the expired-cert display path).

`x5c` is base64 **with** padding and standard alphabet, not base64url. Decoding
it with a base64url decoder is a plausible bug worth guarding.

Key management rules that explain field failures:

> Issuers SHOULD generate new signing keys at least annually.

> When an issuer generates a new key to sign Health Cards, the public key SHALL be added to the issuer's JWK set in its `jwks.json` file. Retired private keys that are no longer used to sign Health Cards SHALL be destroyed. Older public key entries that are needed to validate previously signed Health Cards SHALL remain in the JWK set for as long as the corresponding Health Cards are clinically relevant. However, if a private signing key is compromised, then the issuer SHALL immediately remove the corresponding public key from the JWK set in its `jwks.json` file and request revocation of all X.509 certificates bound to that public key; verifiers will from then on reject all Health Cards signed using that key.

So "unknown `kid`" is genuinely ambiguous between *not published yet*, *rotated
out too early in violation of the SHALL*, and *deliberately withdrawn after
compromise*. The tool should say that rather than pick one.

## 7. Verification, in order, with the failure mode at each step

The spec never gives an ordered algorithm. This ordering is assembled from the
normative SHALLs plus `smart-on-fhir/health-cards-dev-tools` (`src/jws-compact.ts`,
`src/jws-payload.ts`), which is the de facto reference and whose `ErrorCode` enum
(`src/error.ts`) is the closest thing to a canonical failure taxonomy.

Order matters for *messaging*: report the earliest failure as the headline and
keep the rest as "not reached", never as green.

| # | Step | Fails as | Reference code |
|---|---|---|---|
| 1 | Input shape: `shc:/` QR, `.smart-health-card` JSON, deep-link fragment, or bare JWS | `INVALID_QR`, `INVALID_NUMERIC_QR`, `INVALID_NUMERIC_QR_HEADER`, `UNKNOWN_FILE_DATA` | |
| 2 | Reject leading/trailing whitespace on the JWS and on the payload | "JWS has leading or trailing spaces" | `TRAILING_CHARACTERS` |
| 3 | Chunk set complete, `C` values 1..N with no gaps, all `N` agree | `MISSING_QR_CHUNK` (fatal), `UNBALANCED_QR_CHUNKS`, `QR_CHUNKING_DEPRECATED` | |
| 4 | Splits into exactly three base64url segments | "Failed to parse JWS-compact data as 'base64url.base64url.base64url' string" | `JSON_PARSE_ERROR` |
| 5 | Length warning: JWS > 1195 chars cannot be a single V22 low-EC QR | warn only | `JWS_TOO_LONG` |
| 6 | Header decodes, parses, and has `alg === "ES256"`, `zip === "DEF"`, `kid` present | per-member messages | `JWS_HEADER_ERROR` |
| 7 | Signature decodes to exactly 64 bytes, not DER | "Signature is N-bytes. Signature is expected to be 64-bytes" | `SIGNATURE_FORMAT_ERROR` |
| 8 | Raw-inflate the payload (see the wrapper sniff in 5.1) | `INFLATION_ERROR` | |
| 9 | Payload is UTF-8 JSON with no BOM | "UTF8 JWS payload starts with spurious byte order mark (BOM) characters 0xEFBBBF" | `TRAILING_CHARACTERS` |
| 10 | Payload is minified (no optional whitespace) | warn: conformance, not correctness | |
| 11 | `iss` present, a string, `https` scheme, no trailing `/` | "Issuer URL SHALL use https" / "Issuer URL SHALL NOT include a trailing /" | `INVALID_ISSUER_URL` |
| 12 | Fetch `iss + /.well-known/jwks.json` | **network, CORS, DNS, TLS, non-2xx, non-JSON, all distinct** | `ISSUER_KEY_DOWNLOAD_ERROR`, `ISSUER_KEY_WELLKNOWN_ENDPOINT_CORS` |
| 13 | JWKS entry for `kid` exists after filtering on `kty`/`use`/`alg` | "can't find key with 'kid' = X in issuer set" | `JWS_VERIFICATION_ERROR` |
| 14 | Entry is well-formed: no `d`, correct `crv`, `kid` equals recomputed RFC 7638 thumbprint | one code per member | `INVALID_KEY_PRIVATE`, `INVALID_KEY_WRONG_CRV`, `INVALID_KEY_WRONG_KID`, `INVALID_KEY_WRONG_KTY`, `INVALID_KEY_WRONG_ALG`, `INVALID_KEY_WRONG_USE`, `ISSUER_KID_MISMATCH` |
| 15 | ES256 verify over ASCII(`h.p`) | "JWS verification failed" | `JWS_VERIFICATION_ERROR` |
| 16 | `x5c`, if present: leaf SPKI matches `x`/`y`, SAN URI matches `iss`, chain displayed | `INVALID_KEY_X5C` | |
| 17 | `nbf` numeric and not in the future (see the ms trap below) | `NOT_YET_VALID` | |
| 18 | `exp`, if present, not in the past, and `exp > nbf` | `EXPIRATION_ERROR` | |
| 19 | `vc.type` contains `https://smarthealth.cards#health-card` | "JWS.payload.vc.type SHALL contain ..." | `SCHEMA_ERROR` |
| 20 | `vc.credentialSubject.fhirBundle` present | fatal | `CRITICAL_DATA_MISSING` |
| 21 | Revocation: if the JWKS entry has `crlVersion`, fetch and check the CRL | `REVOCATION_ERROR` | |
| 22 | Trust: is `iss` in a directory you accept | `ISSUER_NOT_TRUSTED`, `ISSUER_DIRECTORY_NOT_FOUND` | |
| 23 | FHIR content: schema, minimisation, profile | `FHIR_SCHEMA_ERROR`, `PROFILE_ERROR` | |

The full enum, for a one-to-one mapping of tool findings onto the ecosystem's
vocabulary:

```
// misc:  ERROR=100, DATA_FILE_NOT_FOUND, LOG_PATH_NOT_FOUND, CRITICAL_DATA_MISSING
// card:  SCHEMA_ERROR, FHIR_SCHEMA_ERROR, INFLATION_ERROR, JWS_HEADER_ERROR,
//        JWS_VERIFICATION_ERROR, SHLINK_VERIFICATION_ERROR, SHLINK_INVALID_PASSCODE,
//        SHLINK_NOT_HTTPS_URL, SIGNATURE_FORMAT_ERROR, QR_DECODE_ERROR,
//        ISSUER_KEY_DOWNLOAD_ERROR, ISSUER_KEY_WELLKNOWN_ENDPOINT_CORS,
//        ISSUER_NOT_TRUSTED, ISSUER_DIRECTORY_NOT_FOUND, ISSUER_KID_MISMATCH,
//        INVALID_ISSUER_URL, INVALID_QR, INVALID_NUMERIC_QR, INVALID_SHLINK,
//        INVALID_NUMERIC_QR_HEADER, MISSING_QR_CHUNK, QR_CHUNKING_DEPRECATED,
//        UNBALANCED_QR_CHUNKS, INVALID_QR_VERSION, UNKNOWN_FILE_DATA,
//        JSON_PARSE_ERROR, REVOCATION_ERROR, JWS_TOO_LONG, INVALID_FILE_EXTENSION,
//        TRAILING_CHARACTERS, NOT_YET_VALID, EXPIRATION_ERROR, PROFILE_ERROR
// key:   INVALID_KEY_WRONG_KTY=200, _WRONG_ALG, _WRONG_USE, _WRONG_KID, _WRONG_CRV,
//        _SCHEMA, _PRIVATE, _X5C, _UNKNOWN
```

Note `SHLINK_NOT_HTTPS_URL` / `url-not-https` already exists in that taxonomy.
The motivating localhost incident is adjacent to it but **not** covered: a
`https://localhost:5173/...` manifest URL passes an https check and passes a
scheme check. It needs its own finding (see section 11).

### 7.1 The seconds-versus-milliseconds trap, and non-integer `nbf`

Spec: `nbf` and `exp` are "encoded as the number of seconds from
1970-01-01T00:00:00Z UTC, as specified by RFC7519". RFC 7519 NumericDate permits
a non-integer, and the spec's own example uses one:

```
iss: https://spec.smarthealth.cards/examples/issuer
nbf: 1687450764.656          <-- FLOAT, not an integer
exp: None
rid: MKyCxh7p6uQ
```

So do not `parseInt` and do not reject a decimal. Do reject a **string**.

The dev-tools heuristic is worth copying verbatim in behaviour: if
`nbf > Date(2021,1,1).getTime()` (that is, the value is implausibly large as
seconds), assume the producer wrote **milliseconds** and say so, rather than
reporting a card as "not yet valid until the year 55000". Same for `exp`. Also
check `exp <= nbf`, which the reference tool reports as "Health card expires
before being valid".

## 8. The VC payload

*Health Cards are encoded as Compact Serialization JSON Web Signatures (JWS)*,
verbatim on types:

> The `type`, and `credentialSubject` properties are added to the `vc` claim of the JWT. The `type` values are defined in Credential Types; the `https://smarthealth.cards#health-card` SHALL be present; other types SHOULD be included when they apply. Verifiers and other entities processing SMART Health Cards SHALL ignore any additional `type` elements they do not understand. The `issuer` property is represented by the registered JWT `iss` claim and the `issuanceDate` property is represented by the registered JWT `nbf` ("not before") claim

Scaffold:

```json
{
  "iss": "<<Issuer URL>>",
  "nbf": 1591037940,
  "vc": {
    "type": [
      "https://smarthealth.cards#health-card",
      "<<Additional Types>>",
    ],
    "credentialSubject": {
      "fhirVersion": "<<FHIR Version, e.g. '4.0.1'>>",
      "fhirBundle":{
        "resourceType": "Bundle",
        "type": "collection",
        "entry": ["<<FHIR Resource>>", "<<FHIR Resource>>", "..."]
      }
    }
  }
}
```

`rid` is an additional optional member of `vc` (not of the top-level claims).
Observed payload keys: top level `['iss','nbf','vc']`, `vc` keys
`['type','credentialSubject','rid']`.

### 8.1 `vc.type`, exhaustively, and the deprecation

The CodeSystem `https://smarthealth.cards#` v2.0.0 has **exactly four codes**,
three of them deprecated:

| Full type URI | Status |
|---|---|
| `https://smarthealth.cards#health-card` | active, **SHALL** be present |
| `https://smarthealth.cards#covid19` | `[DEPRECATED] A Health Card designed to convey COVID-19 details` |
| `https://smarthealth.cards#immunization` | `[DEPRECATED] A Health Card designed to convey immunization details` |
| `https://smarthealth.cards#laboratory` | `[DEPRECATED] A Health Card designed to convey laboratory results` |

Changelog, VCI 1.4.0:

> Deprecate "additional" top-level types like `#covid19`, `#laboratory`, and `#immunization` in favor of classifying cards based on their contents.

**There is no `#patient-summary` type, and no `#vaccination` type.** The way SHCs
carry patient summaries was handled by relaxing `Bundle.type` instead, changelog
VCI 1.3.0:

> * Ensure that SHCs can be used for patient summary documents
>   * any FHIR `Bundle.type` is allowed

So classify a card for display **by its contents** (`entry[].resource.resourceType`,
`Immunization.vaccineCode`, `Observation.code`), not by `vc.type`. That is exactly
what the spec's own presentation-filter guidance says:

> Type-based filters evalute Health Cards based on the FHIR resource types within the Health Card payload at `.vc.credentialSubject.fhirBundle.entry[].resource`.

And note `VerifiableCredential` is **not** in the on-the-wire `type` array. It is
*prepended* only when mapping into the W3C JSON-LD form
(`cards-credential-modeling.html`): "Prepend to the `.vc.type` array:
`"VerifiableCredential"`", along with adding an `@context`. Correspondingly the
dev-tools warn "JWS.payload.vc shouldn't have a `@context` property": an
`@context` on the wire is a producer that serialised the JSON-LD view by mistake.

### 8.2 `fhirVersion` and `fhirBundle`

From `cards-credential-modeling.html`:

> * `fhirVersion`: a string representation of the semantic FHIR version the content is represented in (e.g. `1.0.*` for DSTU2, `4.0.*` for R4, where `*` is a number, not a literal asterisk)
> * `fhirBundle`: a FHIR `Bundle` resource that includes all required FHIR resources (content + identity resources). For the `Bundle.type`, implementers should choose `collection` unless a more specific type applies (e.g. `document`).

So `fhirVersion` is a **full three-part version string** (`"4.0.1"`), not `"R4"`
and not `"4.0"`. A viewer should drive its renderer off this value and warn on
anything that is not `4.0.x`, since a DSTU2 (`1.0.2`) bundle will silently
mis-render through an R4 renderer.

`Bundle.type` is `collection` in practice and **may be anything** since VCI 1.3.0,
including `document` for patient summaries. Do not hard-code `=== 'collection'`
as a validity check.

### 8.3 Content minimisation, and why it makes rendering hard

*Payload content minified for QR codes*, verbatim. Note the scope: this applies
to cards "that will be directly represented as QR codes". A card delivered only
via SHL is not strictly bound by it, which is why SHL-borne cards often carry far
more.

> For Health Cards that will be directly represented as QR codes, issuers SHALL ensure that content is minified as follows:
>
> JWS payload `.vc.credentialSubject.fhirBundle` is created...
> * without `Resource.id` elements
> * without `Resource.meta` elements (or if present, `.meta.security` is included and no other fields are included)
> * without `DomainResource.text` elements
> * without `CodeableConcept.text` elements
> * without `Coding.display` elements
> * with `Bundle.entry.fullUrl` populated with short `resource`-scheme URIs (e.g., `{"fullUrl": "resource:0"}`)
> * with `Reference.reference` populated with short `resource`-scheme URIs (e.g., `{"patient": {"reference": "resource:0"}}`)

Rendering consequences, each of which needs deliberate handling:

- **No `Coding.display` and no `CodeableConcept.text`** means a bare code is all
  you get. `{"system":"http://hl7.org/fhir/sid/cvx","code":"208"}` renders as
  "208" unless the viewer carries its own display lookup. Ship a bundled
  CVX / LOINC / SNOMED-subset display table for the codes SHCs actually use
  (the `terminology.smarthealth.cards` ValueSets are the exact scope:
  `immunization-all-cvx`, `immunization-all-snomed`, `immunization-all-icd11`,
  `immunization-covid-*`, `immunization-orthopoxvirus-*`,
  `lab-qualitative-result`, `lab-qualitative-test-covid`). A static app must
  bundle these, not fetch a terminology server.
- **No `DomainResource.text`** means there is no narrative fallback, ever. The
  viewer must render from structured data or show nothing.
- **`resource:N` references** are not resolvable by any generic FHIR reference
  resolver. Build an index from `entry[].fullUrl` to `entry[].resource` and
  resolve `Reference.reference` against it. Verified shape on example-00:
  `fullUrls: ['resource:0','resource:1','resource:2','resource:3']`,
  `resourceTypes: ['Patient','Immunization','Immunization','Immunization']`.
  A dangling `resource:N` (no matching `fullUrl`) is a good finding.
- **No `Resource.id`** means you cannot key rows on FHIR id. Key on the index.
- `meta` is all-or-nothing: present only to carry `.meta.security`. Changelog
  VCI 0.4.4: "Resource.meta is allowed in one special case". A `meta` carrying
  `profile` or `lastUpdated` is a minimisation violation worth flagging.
- Minification of the JSON itself is separately checkable: `'": '` appearing in
  the inflated payload means the producer did not strip optional whitespace.
  Confirmed absent in example-00.

## 9. Revocation, `rid` and the CRL

Verbatim, *Revocation*:

> Individual Health Cards MAY be revoked using a revocation identifier property `rid` encoded in the `vc` claim of the JWT. This should be a short identifier, meaningless to the verifiers; the only constraint is that the identifier SHALL use the base64url alphabet (but doesn't need to be base64url encoded, see section 5 of RFC4648) and be no longer than 24 characters.

> It is RECOMMENDED to use the base64url encoding of the first 64 bits of the output of HMAC-SHA-256 (as specified in RFC4868) on the user identifier using a 256-bit random secret key concatenated with the `<<kid>>`; i.e.,
> ```
> rid = base64url(hmac-sha-256(secret_key || <<kid>>, user_id)[1..64]).
> ```

CRL file, at `https://"<<Issuer URL>>"/.well-known/crl/"<<kid>>".json`:

```json
{
"kid": "<<kid>>",
"method": "rid",
"ctr": "<<ctr>>",
"rids": [...]
}
```

> * `"<<ctr>>"` is a counter indicating how many times this file has been updated; initial value is 1,
> * `rids` is an array of revoked cards' identifiers `rid` values. These values are represented as strings from the base64url alphabet, plus an optional timestamp suffix consisting of `.` followed by a numerical timestamp (e.g., `.1636977600`)

> As an example, the `rids` array `["AQPCj4wwk6Mt", "lHKzqFUMjhs.1636977600"]` marks as revoked any Health Cards with `rid` equal to `AQPCj4wwk6Mt` and Health Cards with `rid` equal to `lHKzqFUMjhs` issued before November 15, 2021 12:00:00 PM GMT.

**The gate is `crlVersion` in the JWK, and this is the part implementations miss:**

> Issuers supporting this revocation method SHALL include in their published JWK set, for each key, a `crlVersion` field encoding the update counter "<<ctr>>" for the corresponding revocation file.
>
> If the `crlVersion` is present in the Issuer's JWK for key `<<kid>>`, Verifiers SHALL
> * Download the `https://"<<Issuer URL>>"/.well-known/crl/"<<kid>>".json` file or use a cached version if the counter value has not changed since the last retrieval,
> * Reject the Health Card if the calculated `rid` is contained in the CRL's `rids` array and (if a timestamp suffix is present) the Health Card's `nbf` is value is before the timestamp.

So the check is conditional. **No `crlVersion` on the JWK means revocation
status is unknown, not "not revoked."** A tool must display that difference. The
correct three-state display is: *not revoked (CRL checked, ctr N)* /
*revoked (matched rid X)* / *revocation not published by this issuer*.

Live CRL for the example issuer's first key, fetched 2026-08-20:

```
GET https://spec.smarthealth.cards/examples/issuer/.well-known/crl/3Kfdg-XwP-7gXyywtUfUADwBumDOPKMQx-iELL11W9s.json
access-control-allow-origin: *
{
  "kid": "3Kfdg-XwP-7gXyywtUfUADwBumDOPKMQx-iELL11W9s",
  "method": "rid",
  "ctr": 1,
  "rids": [ "vwAjHdarZuc.1687450765", "FKDIxsTCGlU", "XkNHp2Iyk0Y.1687450765", "TqB_qu_6OtM" ]
}
```

Two discrepancies to code defensively around:

1. `ctr` is a **JSON number** here (`1`), while the spec snippet shows
   `"ctr": "<<ctr>>"` in string position. Accept both.
2. Compare `rid` by splitting on the **last** `.`: an `rid` may itself contain no
   `.` (base64url alphabet excludes it), so a single split is safe, but the
   suffix is optional. Match the bare `rid` first, then apply the timestamp
   condition only if a suffix is present.

The example-00 card carries `rid: MKyCxh7p6uQ`, which is not in that list, so
it is a live not-revoked case. Any of the four listed values makes a live
revoked case. Both are useful fixtures.

Also normative, the escape hatch, and the pre-1.2.0 gap:

> Revocation of Health Cards without a `rid` field (including all pre-v1.2.0 ones) can be done using external mechanisms to calculate a dynamic `rid` value based on the JWS's content.

> If revocation is desired and individual revocation of SMART Health Cards is not possible, the issuer has the option of revoking its issuing key and allowing users to obtain new Health Cards.

FAQ rationale worth surfacing in the teaching pane:

> Since SHC don't have expiry dates, public keys and revocation information must be publicly available forever. Creating a per-kid CRL allows issuers to cap the size of CRLs

Length: the recommended 64-bit truncated HMAC gives 11 characters; the 24-char
cap exists so a 128-bit value fits in base64url.

## 10. Expiration

*Expiration of Health Cards*:

> SMART Health Cards contain factual information that is assured to be correct at the point of issuance and does not change with the passage of time. Therefore, **Health Cards generally do not expire** and an expiration date is not used.

> To address use cases such as the preceding one, an optional SMART Health Card expiration date can be represented by the registered JWT `exp` claim (encoded as the number of seconds from 1970-01-01T00:00:00Z UTC, as specified by RFC7519). Verifiers SHALL check the expiration, if present, and reject SMART Health Cards with an `exp` value that is before the current verification date-time.

The motivating use case, verbatim, because it explains why `exp` is rare and why
seeing one is informative:

> One use case for issuing SMART Health Cards with an expiration date is a government entity issuing a vaccination card to foreign visitors for their use while in the destination country. ... the original document may be invalidated at some point in the future, e.g. by its signing keys being revoked.

`exp` absent is the norm, and absent must display as "does not expire", not as a
missing-field warning.

## 11. Trust directories, and whether a static browser app can reach them

The spec deliberately defines no trust framework:

> Anyone can _issue_ Health Cards, and every verifier can make its own decision about which issuers to _trust_. ... The SMART Health Cards IG is designed to operate independent of any trust framework, while allowing trust frameworks to be layered on top. ... In all cases, verifiers can discover public keys associated with an issuer via `/.well-known/jwks.json` URLs.

FAQ, *What are security considerations for the verifier?*:

> The specified validation steps ensure that a presented health card was properly signed by an issuer key. How to trust that key is application/organization specific. ... For keys that are part of a directory-based trust framework, make sure the key is part of the trusted directory. For keys that are part of a PKI-based trust framework, make sure that: 1. the JSON key matches the key in the PKI certificate, 2. the PKI certificate chain is valid (not expired at card issuance time, nor revoked), 3. the PKI certificate chain roots into a trusted identity.

### The one directory that exists and is fetchable

**VCI Directory**, maintained by The Commons Project at
`https://github.com/the-commons-project/vci-directory`. Exact URLs, all
verified `200` with `access-control-allow-origin: *` on 2026-08-20:

| File | URL | Size |
|---|---|---|
| Issuer list | `https://raw.githubusercontent.com/the-commons-project/vci-directory/main/vci-issuers.json` | 136 KB |
| Issuer metadata | `https://raw.githubusercontent.com/the-commons-project/vci-directory/main/vci-issuers-metadata.json` | 285 KB |
| Daily snapshot (keys + reachability) | `https://raw.githubusercontent.com/the-commons-project/vci-directory/main/logs/vci_snapshot.json` | 717 KB |

Shape (verified): one top-level key `participating_issuers`, **637 entries**,
each with `iss`, `name`, `website`, and optionally `canonical_iss`.

```json
{ "iss": "https://myvaccinerecord.cdph.ca.gov/creds",
  "name": "State of California",
  "website": "https://myvaccinerecord.cdph.ca.gov/" }
```

`raw.githubusercontent.com` serves `content-type: text/plain; charset=utf-8` with
`access-control-allow-origin: *`, so a static site can `fetch()` it and
`JSON.parse` the text. **A static browser app can absolutely do directory-based
trust lookup.** Bundle a snapshot at build time for offline use at a
connectathon venue, and refresh from the URL when online: bundling also removes
a runtime dependency on GitHub being reachable through venue wifi.

`canonical_iss` matters: some issuers appear under multiple `iss` values that
map to one canonical identity. Match on `iss` exactly first, then on
`canonical_iss`, and display which one hit.

Caveats to state in the UI:

- The directory is **COVID-19-era and US-centric**. Its stated scope is
  "institutions issuing SMART Health Cards for COVID-19 vaccination and
  laboratory diagnostic testing records". An Australian or connectathon issuer
  will legitimately be absent. "Not in the VCI directory" must never render as
  "untrusted" or red. Render it as *unlisted*, informational.
- CommonTrust Network (`commontrustnetwork.org/trusted-issuers`) is a
  human-facing page, not a machine-readable directory with a stable JSON URL and
  CORS. Do not build against it.
- There is no AU directory. For Sparked events, the useful affordance is a
  user-editable local allowlist (localStorage) of `iss` values plus the pinned
  `kid`s seen, so a participant can mark "this is my test issuer" and see it
  stay green across reloads.

### Real-world issuer JWKS CORS, measured

The whole trust chain hinges on whether `iss + /.well-known/jwks.json` is
fetchable from a browser origin. Sampled 18 random issuers from
`vci-issuers.json` with `Origin: https://viewer.example.org`:

```
16 of 18 returned HTTP 200, and all 16 carried an access-control-allow-origin header.
2 non-200:  404 (https://api.kroger.com/healthwellness/v1/smartcard)
            400 (https://apis.changehealthcare.com/anon/dataservices/shc/v1/pharmaca...) , no ACAO
```

So the default assumption should be **CORS works**, and a CORS failure is a
genuine, reportable issuer defect rather than an expected browser limitation.
The spec makes it a SHALL ("with Cross-Origin Resource Sharing (CORS) enabled"),
and the reference tools have a dedicated code for it
(`ISSUER_KEY_WELLKNOWN_ENDPOINT_CORS`) with two distinct messages: header absent,
and header present but not matching the requesting origin.

That sample also proves the deep-path point from section 6: real `iss` values
look like
`https://epicproxy.et0798.epichosted.com/APIProxyPRD/api/epic/2021/Security/Open/EcKeys/...`
and `https://fhir-myrecord.cerner.com/r4/d63001e8-...`. Concatenate, do not
URL-resolve.

## 12. Diagnosing the failure the existing viewer could not

A browser `fetch()` to an unreachable host produces an opaque `TypeError:
Failed to fetch` with **no** status, no headers, and no distinction between DNS
failure, connection refused, TLS failure, and a CORS preflight rejection. That
opacity is the direct cause of "type load fail". The fix is not better error
handling of the exception; it is **classifying the URL before the fetch**, and
classifying the exception after it using what the URL already told you.

Pre-flight classification of any URL the tool is about to fetch (SHL manifest
URL, `.files[].location`, `iss + /.well-known/jwks.json`, CRL URL). Run this on
the **manifest URL decoded from the SHL payload's `url`**, and equally on `iss`,
because an issuer pinned to localhost fails the same way:

```js
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0',
                                'localhost.localdomain', 'ip6-localhost']);
function classifyHost(rawUrl) {
  let u; try { u = new URL(rawUrl); } catch { return { kind: 'unparseable' }; }
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (LOOPBACK_HOSTS.has(h) || h.endsWith('.localhost') || /^127\./.test(h))
    return { kind: 'loopback', host: h, port: u.port };
  if (/^(10\.|192\.168\.|169\.254\.)/.test(h) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
      /^f[cd][0-9a-f]{2}:/.test(h) || h === '::1')
    return { kind: 'private-network', host: h };
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.home.arpa'))
    return { kind: 'mdns-or-internal', host: h };
  if (!h.includes('.')) return { kind: 'bare-hostname', host: h };  // intranet single-label
  if (u.protocol !== 'https:') return { kind: 'insecure-scheme', scheme: u.protocol };
  return { kind: 'public', host: h };
}
```

The one-line verdicts, which are the point of the whole tool:

| Class | Verdict copy |
|---|---|
| `loopback` | This link points at `localhost:5173`, which means the machine you are on, so it can only ever open on the computer that created it. The sender needs to re-issue it against a host other people can reach (a tunnel such as ngrok, or a deployed URL). |
| `private-network` | This link points at `10.x.x.x`, a private network address. It will only open for someone on the same LAN as the sender. |
| `mdns-or-internal` | This link points at a `.local` name, resolvable only by mDNS on the sender's network. |
| `bare-hostname` | This link points at a single-label hostname with no domain, resolvable only inside the sender's own network. |
| `insecure-scheme` | Served over `http:`. A page loaded over https cannot fetch it at all (mixed content), and the spec requires https. |

Report this **before** attempting the fetch, and mark it as a certainty, not a
guess: it is derived from the URL alone, so no network access is needed and no
network condition can change the answer. That is exactly the property the
existing viewer lacked.

Post-fetch classification, for the remaining `public` cases where
`fetch()` throws an opaque `TypeError`:

| Evidence | Diagnosis |
|---|---|
| `TypeError`, and the page origin is https while the target is http | mixed-content block, not a network failure |
| `TypeError` on a public host, and a no-cors `fetch(url, {mode:'no-cors'})` **succeeds** (opaque response) | the server is up and reachable; this is a **CORS** failure. Name it as the server missing `Access-Control-Allow-Origin`, and cite the SHALL. |
| `TypeError`, and the no-cors probe also fails | DNS, TLS, or connection refused. Cannot be narrowed further from a browser. Say that explicitly, and offer the `curl` command the sender can run. |
| Response arrives with a status | never opaque: report status, `content-type`, and body prefix |

The no-cors probe is the single highest-value trick here: it converts an
undiagnosable exception into a definite CORS-versus-unreachable verdict, using
only browser APIs.

Also worth pre-flighting on the `iss` value specifically: trailing `/`,
`http:` scheme, and the deep-path concatenation, since all three produce a
`jwks.json` fetch that fails for reasons that have nothing to do with the
network.

## 13. Test corpus, all fetchable with CORS

Every one of these serves `access-control-allow-origin: *`, so the static app can
load them directly as built-in fixtures.

```
https://spec.smarthealth.cards/examples/example-00-b-jws-payload-expanded.json
https://spec.smarthealth.cards/examples/example-00-c-jws-payload-minified.json
https://spec.smarthealth.cards/examples/example-00-d-jws.txt
https://spec.smarthealth.cards/examples/example-00-e-file.smart-health-card
https://spec.smarthealth.cards/examples/example-00-f-qr-code-numeric-value-0.txt
https://spec.smarthealth.cards/examples/example-00-g-qr-code-0.svg
   ... same suffix set for example-01, example-02, example-03
https://spec.smarthealth.cards/examples/issuer/.well-known/jwks.json
https://spec.smarthealth.cards/examples/issuer/.well-known/crl/3Kfdg-XwP-7gXyywtUfUADwBumDOPKMQx-iELL11W9s.json
```

What each exercises:

- **example-00**: 1 card, single QR, JWS 804 chars, 4 entries
  (`Patient`, 3x `Immunization`), `rid: MKyCxh7p6uQ` present and **not** revoked,
  `nbf` is a float, no `exp`, signed by the `crlVersion: 1` key. The happy path
  plus the float-`nbf` and CRL-checked-clean cases.
- **example-02**: **3-chunk** QR set, JWS 3285 chars, 55 entries
  (`DiagnosticReport`, 3x `Specimen`, 51x `Observation`). The chunk reassembly
  and the large-bundle rendering cases.
- The JWKS second key: `x5c` with a 3-cert chain whose **leaf is expired**
  (2021-06-01 to 2022-06-01), and no `crlVersion`. The x5c display path and the
  revocation-unknown path.
- The CRL's 4 `rids`, two with `.1687450765` timestamp suffixes, two bare. Both
  matching forms.

Negative fixtures you must construct yourself (no published corpus exists):
zlib-wrapped payload, gzip payload, DER signature, `alg: RS256`, missing `zip`,
`kid` not matching its own thumbprint, `iss` with trailing slash, `iss` on
`http:`, `iss` on `localhost`, `nbf` in milliseconds, `exp` in the past,
`exp <= nbf`, `vc.type` missing `#health-card`, `@context` present, dangling
`resource:9`, and a chunk set missing chunk 2.

## 14. Rendering the FHIR content, brief note

Beyond the scope of this file, but the constraints from section 8.3 determine it:
structured-only rendering, bundled code displays, `resource:N` index resolution,
and `fhirVersion`-driven renderer selection. The SHC presentation-filter guidance
tells you which fields carry the clinical meaning:

> For Immunizations, the `Immunization.vaccineCode` is evaluated. For Observations, the `Observation.code` is evaluated.

Privacy guidance worth putting in the UI for a verifier-facing tool:

> Verifiers should not store identity data conveyed via VC, and should delete data as soon as they are no longer needed for verification purposes

> Verifiers should not expect all elements in the VC to exactly match their own records, but can still use elements conveyed in the VC.

And, for the trust pane's framing:

> Never rely solely on the textual elements of a paper card or a wallet app, always verify the cryptographic signature protecting the health card.
