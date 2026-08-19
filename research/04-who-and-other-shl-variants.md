# WHO, IHE and other SHL variants: what shl-loupe should recognise

Research note 04. Everything below was fetched live on 2026-08-20 (specs, IG sources, and the
GDHCN production trust list itself). Computationally verified claims are marked **[verified]**.

## Headline

There is no single "SMART Health Link". There is a **payload format** (a base64url JSON blob with
`url` + `key`) that four different ecosystems reuse over **three mutually incompatible retrieval
protocols** and **two different carriers**. A tool that decodes the payload and then assumes the
HL7 manifest protocol will mis-diagnose WHO and IHE links as broken. The single highest-value
increment is therefore **classify, then explain**: name the variant from the payload and the
carrier, say which protocol it implies, and only then attempt retrieval.

The good news for a static browser app: **the WHO GDHCN production trust list is fetchable from a
browser with no proxy** (HTTP 200, `access-control-allow-origin: *`, 1.5 MB), so signer resolution
for HCERT-carried links is genuinely feasible client-side. **[verified]**

---

## 1. The family tree

| Variant | Carrier | URI prefix | Retrieval protocol | Signed? | Trust resolution |
|---|---|---|---|---|---|
| **HL7 SHL** (baseline) | text / QR of the URI | `shlink:/` | POST manifest URL, JSON body, `{files:[…]}` | No (link itself unsigned) | none (bearer-URL) |
| **WHO GDHCN "verifiable SHL"** (IPS for Pilgrimage) | HC1: QR (base45+zlib+CWT/COSE) | `shlink:/` inside HCERT claim `5` | SHL manifest POST (JSON, and PDF in the wild) | Yes, COSE_Sign1 | GDHCN DID trust list |
| **IHE ITI VHL** | HC1: QR, or `application/vc+ld+json` | `vhlink:/` inside HCERT claim `5` | **FHIR `POST /List/_search`** returning a searchset Bundle | Yes, COSE_Sign1 or `DataIntegrityProof` | trust list + RFC 9421 / OAuth SSRAA |
| **WHO trust-phw Health Link** | either | `shlink:/` (type absent) or typed | inherits from `type` | either | GDHCN |
| **CARIN C4DIC insurance card** | text + QR | `shlink:/` | HL7 SHL manifest | inner SHC is a JWS | SHC issuer `iss` + JWKS |
| **CommonHealth / Commons Project** | text + QR | `https://viewer.commonhealth.org/#shlink:/` | HL7 SHL manifest | inner SHC JWS | JWKS at `iss` |
| **CA:SHL (Canada)** | text + QR | `shlink:/` | HL7 SHL manifest, passcode mandated | no | none |

The crucial structural point: **an `HC1:` QR can contain an SHL.** A user who scans a WHO or IHE QR
and pastes the result into a viewer gets a string starting `HC1:NCF…`, not `shlink:/`. Today's
viewers reject that outright. Recognising it is cheap and is the highest-leverage single feature in
this note.

---

## 2. Baseline: the HL7 contract we diff everything against

From [links-specification.html](https://build.fhir.org/ig/HL7/smart-health-cards-and-links/links-specification.html)
(SMART Health Cards and Links IG v1.0.0):

**Payload members**: `url` (1..1), `key` (1..1, "43 characters, consisting of 32 random bytes
base64urlencoded"), `exp` (0..1, epoch seconds), `flag` (0..1), `label` (0..1, max 80 chars),
`v` (0..1, default 1).

> "The specification reserves the name, `extension`, and will never define an element with that name."

That reservation matters: IHE VHL uses exactly that slot (section 6).

**Flags**: `L` long-term use, manifest content may evolve; `P` passcode required; `U` the `url`
resolves to a single encrypted file via `GET`, bypassing the manifest, and `SHALL NOT` be combined
with `P`.

**URI construction**: minify JSON, base64url-encode, prefix `shlink:/`, optionally prefix a viewer
URL ending in `#`. Rationale quoted:

> "By using viewer URLs that end in `#`, we take advantage of the browser behavior where `#`
> fragments are not sent to a server at the time of a request."

**Manifest request**: `POST`, `content-type: application/json`, body members `recipient` (required
string), `passcode` (when `P`), `embeddedLengthMax` (integer).

**Status codes**: `404` when the link is no longer active. `401` for an invalid passcode, and the
body `SHALL` be JSON carrying `remainingAttempts`. `429` with `Retry-After` for polling too often.

**Manifest response**: `files[]` with `contentType`, and exactly one of `location` (short-lived,
single use) or `embedded` (compact JWE string), plus optional `lastUpdated`. Allowed content types:
`application/smart-health-card`, `application/smart-api-access`, `application/fhir+json`
(with optional `fhirVersion` parameter).

**Encryption**: JWE compact serialization, `"alg": "dir"`, `"enc": "A256GCM"`, `cty` header naming
the payload content type, optional `"zip": "DEF"` (raw DEFLATE).

---

## 3. WHO: the trust-phw Health Link model adds a `type` member

`GDHCN Trust Network - Personal Health Wallet` v0.1.0 (canonical `http://smart.who.int/trust-phw/…`,
published 2025-10-07) defines a **three-level logical model hierarchy**. Authoritative FSH sources:

`HealthLinkPayload` (the base) carries all six HL7 members plus one:

```
* type 0..1 code "Classifying type code to distinguish different types of health links.
                  If not present then the Health Link is a SMART Health Link."
```

- `SMARTHealthLinkPayload` (Parent: HealthLinkPayload) constrains `type 0..0`.
- `VerifiableHealthLinkPayload` (Parent: HealthLinkPayload) constrains `type 1..1`, bound to
  `HL_TYPE` (preferred), with a commented-out invariant `Expression: "type = 'vhl'"`.

`CodeSystem: HL.TYPE` has exactly two codes:

```
* #vhl "Verifiable Health Link"
* #shl "Smart Health Link"
```

The `VerifiableHealthLinkPayload` FSH carries a commented-out canonical
`https://profiles.ihe.net/ITI/VHL/StructureDefinition/VerifiableHealthLinkPayload`, which is how
this model and the IHE profile are the same lineage.

**Practical rule for the tool**: an unknown top-level member named `type` with value `shl` or `vhl`
is not corruption; it is a WHO/IHE-lineage link. Anything else unknown is worth surfacing as
"non-standard member", because the base spec reserves only `extension`.

`SmartHealthLink` (a separate one-element model) documents the URI itself:

```
* u 1..1 string "URI" "URI of the Smart Health Link.  Should look like 'shlink:/eyJ1cmwiOiJodHRwczovL2Vo....' "
```

---

## 4. WHO: the HCERT carrier, and the `shlink:` versus `vhlink:` ambiguity at claim 5

`WHO SMART Trust` v1.8.0, HCERT spec v1.1.1. Encoding chain, exactly:

```
QR (ISO/IEC 18004:2015, Alphanumeric mode 2 / symbols 0010, error correction 'Q')
  -> ASCII string, prefixed "HC1:"
  -> Base45 decode (draft-faltstrom-base45)
  -> ZLIB (RFC 1950) / DEFLATE (RFC 1951) decompress
  -> CBOR -> COSE_Sign1 -> CWT (RFC 8392)
  -> claims: 1=iss, 4=exp, 6=iat, -260=hcert
  -> hcert subclaim
```

Quoted, §4.2.2:

> "the base45 encoded data (as per this specification) SHALL be prefixed by the Context Identifier
> string "HC1:". Future versions of this specification that impact backwards-compatibility SHALL
> define a new Context Identifier, whereas the character following "HC" SHALL be taken from the
> character set [1-9A-Z]."

So the tool should match `/^HC[1-9A-Z]:/`, not just `HC1:`.

**HCERT subclaims** (`http://smart.who.int/trust/StructureDefinition/HCert`, v1.7.0, 2026-07-30):

| Subclaim | Content |
|---|---|
| `1` | HCERT EU DCC (`http://smart.who.int/ddcc/StructureDefinition/HCertDCC`) |
| `3` | DDCC Vaccination Status (DDCC:VS) |
| `4` | DDCC Test Result (DDCC:TR) |
| `5` | **the health link** |
| `-6` | `DVCMin`, minimal Digital Vaccination Certificate (the ICVP payload) |
| `-7` | `MedicationTreatmentLineMin` (PH4H) |

Governance rule, §3.2.7.1: "subclaims 0 and above are reserved by WHO to be assigned … subclaims
for negative integer values are for development purposes and are free to use". So a negative
subclaim in the wild is by definition a development payload, which is a useful thing to say out loud.

### The ambiguity, which is a real interop hazard

Three WHO/IHE sources disagree about what claim `5` holds:

1. The **normative** HCERT spec text, §3.2.7.1.5, titles it **"Smart Health Link (SHL)"** and links
   `https://docs.smarthealthit.org/smart-health-links/spec`.
2. The WHO **HCert logical model** declares
   `* 5 0..1 string "VHL" "URI of a Verifiable Health Link.  Of the form 'vhlink:/eyJ1cmwiOiJodHRwczovL2Vo....' "`
3. WHO **IPS for Pilgrimage** (v2.0.3, the live Malaysia/Hajj deployment) instructs
   `Prefixed with shlink:/ … Build HCERT containing SHL … Build CWT with header payload and signature`.
4. **IHE ITI VHL** ITI-YY3 mandates `vhlink:/` at "HCERT claim 5".

And the spec itself notes the model is subordinate: "While the logical model enlists assigned sub
claims, the ones listed in this specification are considered authoritative."

**Implication**: at claim 5, accept `shlink:/`, `vhlink:/`, and a bare base64url blob, and *report
which one was found*, because the prefix is the only in-band signal of whether to use the SHL
manifest protocol or the FHIR `List/_search` protocol. This is exactly the class of confusion the
tool exists to end.

### WHO IPS for Pilgrimage transaction codes

`CodeSystem: IPS.HAJJ.TRANSACTION` names the SHL steps explicitly, which is good evidence that a
"signed SHL" is a real deployed thing and not a paper idea:

```
* #shl-sign          "Sign Smart Health Link"
* #shl-doc-view      "Access SHL Document Viewer"
* #shl-get-manifest  "Retrieve SHL Document Manifest"
* #keys-get          "Retrieve Verification Keys"
```

The Malaysia reference implementation (MySejahtera, national app, Hajj pilgrims) states:
"VHL is created as a manifest URL based on user preferences and **supports JSON and PDF content
types**" and "POST request is sent to the VHL manifest URL to retrieve the base64 encoded VHL
manifest JSON."

**`application/pdf` is not in the HL7 allowed `contentType` list.** A conformance-strict viewer
would reject a live national deployment. Warn, do not fail.

---

## 5. The GDHCN trust network: a static browser app really can do this

`WHO SMART Trust` DID Trustlist spec 2.0.0. Trust lists are **published as `did:web` DID documents
on GitHub Pages**, in two variants (embedded, which carries key material, and reference, which
carries only DID ids).

| Environment | Embedded | Reference |
|---|---|---|
| PROD | `https://tng-cdn.who.int/v2/trustlist/did.json` | `https://tng-cdn.who.int/v2/trustlist-ref/did.json` |
| UAT | `https://tng-cdn-uat.who.int/v2/trustlist/did.json` | `…/v2/trustlist-ref/did.json` |
| DEV | `https://tng-cdn-dev.who.int/v2/trustlist/did.json` | `…/v2/trustlist-ref/did.json` |

**Hierarchical path**: `/v2/trustlist/$domain/$participant/$usage/did.json`, where the levels
"function as filters following an AND logic operation", and `-` is a wildcard at any sublevel.

### Live measurements **[verified]**

```
GET https://tng-cdn.who.int/v2/trustlist/did.json
  HTTP/2 200 | content-type: application/json | access-control-allow-origin: *
  content-length: 1505083
  verificationMethod: 501 entries, all type "JsonWebKey2020"
  entry fields: controller, domain, id, keyusage, participant, publicKeyJwk, type
  publicKeyJwk fields: kty, kid, x5c[], crv, x, y   (EC / P-256)
  domain: all {"code":"#DCC"}
  keyusage: {"#DSC":438, "#CSCA":61, "#DECA":2}
  participants: 36 -> ALB AND ARM BEL BEN BRA CYP CZE ESP EST FIN FRA FRO IDN IOM IRL ISL
                      LTU LVA MCO MLT MYS NLD NZL OMN POL PRT SGP SMR SVK SVN SWE TGO THA TUR XXH
  proof.created: 2026-08-19T23:00:03Z   (regenerated daily)

GET https://tng-cdn.who.int/v2/trustlist/DCC/NZL/DSC/did.json  -> 200, 84969 bytes
GET https://tng-cdn.who.int/v2/trustlist/-/AUS/did.json        -> 404  (wildcard path not materialised)
```

**Australia is not a GDHCN DCC participant.** **[verified]** Worth stating plainly in the tool
rather than letting an Australian engineer hunt for a missing key.

### The kid mapping is exact, and cheap **[verified]**

The HCERT `kid` is defined in HCERT spec §A.1 as "a truncated (first 8 bytes) SHA-256 fingerprint of
the DSC encoded in DER (raw) format". I confirmed this reproduces the trust list fragment exactly:

```python
import base64, hashlib
der = base64.b64decode(vm["publicKeyJwk"]["x5c"][0])
kid = base64.b64encode(hashlib.sha256(der).digest()[:8]).decode()
# "+6w2r2RfO1M="  ==  publicKeyJwk.kid  ==  the "#..." fragment of the verificationMethod id
```

Note the `kid` is **standard base64 with padding** (`+`, `/`, `=`), not base64url. Comparing it
against a base64url-encoded COSE `kid` will silently never match. That is a trap worth a test.

Two HCERT rules that shape lookup:
- §3.2.3: "`kid` … MAY also be placed in an unprotected header if required. Verifiers MUST accept
  both options. If both options are present, the Key Identifier in the protected header MUST be used."
- §3.2.3: 8 bytes means collisions are possible, so "a verifier MUST check all DSCs with that `kid`."

### Two live defects in the WHO trust infrastructure **[verified]**

1. **The production trust list's own signature cannot be verified by following its DID.** The proof
   is:
   ```json
   {"type":"JsonWebSignature2020","created":"2026-08-19T23:00:03Z",
    "proofPurpose":"assertionMethod",
    "verificationMethod":"did:web:raw.githubusercontent.com:WorldHealthOrganization:tng-participants-prod:main:WHO:signing:DID",
    "jws":"eyJiNjQiOmZhbHNlLCJjcml0IjpbImI2NCJdLCJhbGciOiJFUzI1NiJ9..MEQCID…"}
   ```
   Resolving that `did:web` per the W3C rules gives
   `https://raw.githubusercontent.com/WorldHealthOrganization/tng-participants-prod/main/WHO/signing/DID/did.json`,
   which returns **404**. The `tng-participants-prod` repo has only `WHO/signing/DCC/*.pub`, no
   `DID` directory. The **DEV** equivalent (`tng-participants-dev`) resolves fine (200). So trust
   list signature verification works in DEV and is impossible in PROD today.
   The JWS is detached (`"b64":false`, `"crit":["b64"]`, `alg` ES256), so verification also needs
   JSON-LD canonicalisation, which is heavy for a browser bundle.

2. **The published domain code `DCC` is not in the GDHCN Trust Domain value set.** That value set
   (`http://smart.who.int/trust/CodeSystem/Domains`, v1.7.0) contains only `DDCC`,
   `IPS-PILGRIMAGE`, `PH4H`, `ICVP`. The production trust list's 501 entries are all `#DCC`.

**Feasibility verdict**: fetching a DSC by `kid` and reporting the signer country and key usage is
**straightforwardly feasible** in a static browser app. **Verifying the trust list's own signature
is not worth it** (JSON-LD canonicalisation, plus the PROD signer DID is a 404). Verifying the
**COSE_Sign1 over the CWT** against a fetched DSC **is** feasible with Web Crypto
(`ECDSA` / `P-256` / `SHA-256`) and is the verification that actually matters.

### Key usages and domains, for labelling

`http://smart.who.int/trust/CodeSystem/KeyUsage`: `SCA` (Signer Certificate Authority),
`DSC` (Document Signing Certificate), `DECA` (Data Exchange Certificate Authority),
`DESC` (Data Exchange Signing Certificate), `TLS`, `UP` (Upload).

Trust domains: `DDCC`, `IPS-PILGRIMAGE`, `PH4H` ("Pan-American Highway for Digital Health"),
`ICVP`. DEV and UAT participant repos show onboarding folders for `DCC`, `DDCC` and `PH4H`;
`PH4H` DEV has 139 keys across CSCA and DSC (sample id
`did:web:tng-cdn-dev.who.int:v2:trustlist:PH4H:CHL:DSC#+kGpHsnSCAg=`). **[verified]**

---

## 6. IHE ITI VHL: same payload, different retrieval protocol

`Verifiable Health Links`, IHE ITI, v1.0.0-comment (profile published 2026-06-14).
Actors: Trust Anchor, VHL Holder, VHL Receiver, VHL Sharer. Transactions:

| Id | Name |
|---|---|
| ITI-YY1 | Submit PKI Material with DID |
| ITI-YY2 | Retrieve Trust List with DID |
| ITI-YY3 | Generate VHL |
| ITI-YY4 | Provide VHL |
| ITI-YY5 | Retrieve Manifest |

Volume 1 §1:XX.5.1: "All participants SHALL establish trust via the Trust Anchor."

Appendix A states the payload is shared: VHL adopts "the `url`, `key`, `flag`, `label`, `exp`, `v`,
and **`extension`** fields" and reuses the SHL manifest parameters `recipient`, `passcode`,
`embeddedLengthMax`.

### The divergence that will break a naive viewer

ITI-YY5 is **not** the SHL manifest protocol. Quoted:

> "This transaction uses a standard FHIR search on the `List` resource, following the same pattern
> as MHD ITI-66 Find Document Lists. The manifest URL from the VHL payload contains all necessary
> FHIR search parameters. No custom operation is required."

So the `url` member is a FHIR search URL, and the request is
`POST /List/_search` with `Content-Type: application/x-www-form-urlencoded` plus a
`Content-Digest: sha-256=…` header, returning a **searchset Bundle** of `List` +
`DocumentReference`. Binaries then come via **MHD ITI-68 Retrieve Document** from
`DocumentReference.content.attachment.url`, and are decrypted with the same JWE `dir`/`A256GCM`
convention using the payload `key`.

URL search parameters, per ITI-YY5: `_id` (the folder id, "with 256-bit entropy … primary
authorization mechanism"), `code=folder`, `status=current`, `patient.identifier=system|value`,
optional `_include=List:item`.

Authentication: implementations SHALL support at least one of **HTTP Message Signatures
(RFC 9421)** signing `@method`, `@target-uri`, `content-digest`, `date`; **OAuth with SSRAA**
(`http://hl7.org/fhir/us/udap-security/`); or a self-issued JSON-LD Verifiable Credential POSTed as
`application/vc+ld+json` with an embedded `DataIntegrityProof`.

**Feasibility note**: a browser app cannot mint an RFC 9421 signature or an SSRAA client assertion
without a trust-network private key, so **a static viewer can never complete a conformant VHL
retrieval**. It can, and should, decode the VHL fully and say precisely that: "this is an IHE VHL,
retrieval requires a trust-network credential this browser tool does not hold; here is the manifest
search it would issue."

### Carriers

ITI-YY4: "The VHL is transmitted as a QR code containing an HCERT-encoded payload with the `HC1:`
prefix, OR … as a signed W3C Verifiable Credential (`application/vc+ld+json`)." The VC carries the
payload under `credentialSubject` with `type: ["VerifiableCredential","VHLEnvelopeCredential"]`.

ITI-YY3 generation is a FHIR operation:
`GET [base]/Patient/$generate-vhl?sourceIdentifier=[token]{&exp=}{&flag=}{&label=}{&passcode=}{&purposeOfUse=}{&format=}`
with `format=qrcode` (default) or `format=vc`.

Two privacy rules worth surfacing, because they are checkable:
- "`purposeOfUse` value(s) SHALL NOT be embedded in the QR code, VC, or VHL payload".
- "The plaintext passcode SHALL NOT appear in the VHL URL, QR code, or VC".

### A defect in IHE's own worked example **[verified]**

ITI-YY3 step 4 prose and JSON name the member `extension`. Base64url-decoding the literal
`vhlink:/…` string in step 5c yields:

```
member order: ['url', 'key', 'exp', 'flag', 'label', 'v', 'extensions']
key length: 43   flag: "LP"
url: https://vhl-sharer.example.org/List/_search?_id=abc123def456&code=folder&status=current&patient.identifier=urn:oid:2.16.840.1.113883.2.4.6.3|PASSPORT123&_include=List:item
```

`extensions` (plural) in the encoded blob versus `extension` (singular) in the normative text. Also
note the raw `|` in the URL, which is not a legal URI character and needs `%7C`. Both are precisely
the sort of finding shl-loupe should print automatically, and both make good regression fixtures.

---

## 7. HCERT / EU DCC specifics worth hard-coding

Algorithms, HCERT §3.2.2: primary **ES256** (ECDSA P-256 + SHA-256); secondary **PS256**
(RSASSA-PSS, 2048-bit modulus, SHA-256). "both the primary and the secondary algorithm MUST be
implemented." COSE labels: `alg` = 1, `kid` = 4.

CWT claim keys: `iss` = 1 (ISO 3166-1 alpha-2, optional), `exp` = 4, `iat` = 6, `hcert` = **-260**.

Base45 (draft-faltstrom-base45), exact alphabet, 45 characters in value order:

```
0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:
```

Algorithm, quoted: "two bytes [a, b] MUST be interpreted as a number n in base 256 … n = (a*256) + b.
This number n is converted to base 45 [c, d, e] so that n = c + (d*45) + (e*45*45). Note the order
of c, d and e which are chosen so that the left-most [c] is the least significant." A trailing odd
byte encodes to **two** characters, `a = c + (45*d)`. So a valid base45 string has length `mod 3`
in `{0, 2}`; **length `mod 3 == 1` is always corrupt**, which is a free, instant diagnostic.

Revocation, §5.1: "countries should NOT assume that any Certificate Revocation List (CRL)
information is used … the primary validity mechanism is the presence of the certificate on the most
recent version of that certificate list." So "not on the current trust list" is the revocation
signal, and the tool should say that rather than implying a CRL check.

---

## 8. Other real-world profiles

**CommonHealth / The Commons Project.** Runs the reference SHL web reader. CommonHealth SHLinks
"are always prefixed with the viewer URL … `https://viewer.commonhealth.org/#`". `viewer.tcpdev.org`
is the dev instance, and it is also the viewer the **HL7 IG's own examples** use
(`https://viewer.tcpdev.org/shlink.html#shlink:/`). That is the viewer from the motivating incident,
so its diagnostics are the bar to beat. Payload kinds it targets: COVID vaccine cards, general
immunisations, IPS, and digital health insurance cards.

**CARIN Digital Insurance Card (C4DIC)** v2.0.0-ballot. Profiles `Coverage`, `Patient`,
`Organization`. Notable normative choices: the payer "SHALL follow the SMART Health Links
specification to create a SMART Health Link referencing the SMART Health Card", and "SHALL NOT
require … the user to set a passcode … and SHALL NOT populate the `P` flag … by default", and SHALL
provide the link "in text URI format as well as QR format". So a **passcode-free, long-lived**
insurance SHL is conformant by design, which is a privacy posture worth labelling rather than
warning about.

**Apple Wallet / Google Wallet.** These consume **SMART Health Cards** (`shc:/`), not SHLs. Apple
"transforms the QR code URL by replacing the leading `shc:/` with a redirect URL". Google Wallet
health passes are SHC-based, available in the US, Canada and **Australia**. Relevance to shl-loupe:
a user may paste an `shc:/` numeric-encoded string, or an Apple redirect URL wrapping one, and
expect it to work. Detecting `shc:/` and explaining "this is a Health *Card*, not a Health *Link*"
is a two-line win.

**pan-Canadian Shareable Health Links (CA:SHL)**, Canada Health Infoway, Reference Architecture
v0.2.0 DFT-preBallot, "in the process of being contributed to IHE". Per IHE Appendix A, Canada
**mandates passcodes** and mandates encryption plus short-lived URLs, where base SHL leaves both
optional. Infoway's own caveat: "CA:SHL is a building block that is meant to be used together with
added security measures, otherwise it is not suitable for exchange in environments where security
and provenance cannot be reliably established by other means."

**Australia (Sparked / ADHA / AU PS).** AU PS is IPS-derived over AU Core. The ADHA demonstrated
"generating an Australian Patient Summary and then sharing it with the audience via a QR Code using
a SMART Health Link generated with an SHL Generator API and Patient Summary Viewer application" at
the HL7 Australia Sparked Connectathon, where "93 links were generated using the SMART Health Link
service and 47 unique users accessed the Australian Patient Summary Viewer". So the Australian
flavour is **plain HL7 SHL carrying an AU PS Bundle**: no `type`, no HCERT, no GDHCN (Australia is
not a GDHCN participant). The value-add for shl-loupe here is not protocol variance but **payload
recognition**: read `Bundle.meta.profile` and name AU PS versus IPS versus unprofiled.

**ICVP.** `SMART ICVP` v0.3.0 does not itself define a carrier. Its content is an IPS-profiled
Bundle (`Bundle-uv-ips-ICVP`, `Composition-uv-ips-ICVP`, `Immunization-uv-ips-ICVP`). The carrier
lives in `trust-phw` as `DVCMin` at HCERT subclaim `-6`, whose fields are aggressively abbreviated
for QR size: `n` (name), `dob`, `s` (sex), `nt` (nationality), `id`, `dt`, `gn` (guardian),
`vx` (vaccine details), `v` (template version). A negative subclaim means, per WHO's own governance
rule, that ICVP-in-HCERT is still a development payload.

---

## 9. Live, verified test vectors

The HL7 IG's own examples are live, CORS-open, and decrypt cleanly. **[verified]** These make ideal
built-in fixtures.

IPS example, decoded payload:

```json
{
  "url": "https://raw.githubusercontent.com/seanno/shc-demo-data/main/ips/IPS_IG-bundle-01-enc.txt",
  "flag": "LU",
  "key": "rxTgYlOaKJPFtcEd0qcceN8wEU4p94SqAwIWQe6uX7Q",
  "label": "Demo SHL for IPS_IG-bundle-01"
}
```

Member order is `url, flag, key, label`, not the spec's documentation order, so **never parse
positionally**. `flag: "LU"` means long-term plus direct-GET, no manifest.

Fetching that URL: `HTTP/2 200`, `content-type: text/plain`, `access-control-allow-origin: *`.
The JWE compact token has 5 parts and this protected header:

```json
{"enc": "A256GCM", "alg": "dir", "kid": "ufYGlu_C8IuzJ3HV-wQqsIv-pMm2uZm-vGy37r3hwts"}
```

Decrypting with AES-256-GCM (AAD = the raw protected-header segment) gives 60973 bytes:
`Bundle`, `type: document`, 20 entries, first three resources `Composition`, `Patient`,
`Practitioner`.

**Two deviations from the spec in the IG's own example**, both worth flagging in the tool:
- there is **no `cty` header**, which the spec says should indicate the payload content type;
- `meta.profile` is **absent** on the Bundle, so the IPS IG's own IPS example does not stamp the
  IPS profile. Any "is this really an IPS?" check must be structural, not profile-based.

### The single best diagnostic in this note **[verified]**

That `kid` is the **RFC 7638 JWK thumbprint of the SHL `key` as an `oct` key**:

```python
import base64, hashlib, json
def b64u(b): return base64.urlsafe_b64encode(b).decode().rstrip("=")
k = "rxTgYlOaKJPFtcEd0qcceN8wEU4p94SqAwIWQe6uX7Q"      # payload.key, verbatim
jwk = '{"k":"%s","kty":"oct"}' % k                       # RFC 7638 lexicographic, no whitespace
assert b64u(hashlib.sha256(jwk.encode()).digest()) == "ufYGlu_C8IuzJ3HV-wQqsIv-pMm2uZm-vGy37r3hwts"
```

This means that **when the JWE carries a `kid`, the tool can prove the key is right or wrong before
attempting decryption**, and so can distinguish "you have the wrong key" from "the ciphertext is
corrupt" from "the passcode gate returned an error page instead of a JWE". Naive viewers report all
three as one opaque decryption failure. Note it is *not* `sha256(raw key bytes)`, which gives
`G4QqepBA6wbS5c4sWrhZ9W3_pOU-9g0Ojpu9XFDdrT8`.

---

## 10. Feasibility, and the smallest increment that pays

| Variant | Detect | Decode | Verify signature | Retrieve content | Smallest valuable increment |
|---|---|---|---|---|---|
| HL7 SHL | trivial | trivial | n/a | yes, when server sets CORS | already the core product |
| `HC1:` HCERT wrapper | trivial (regex) | **yes**, pure JS: base45 + inflate + CBOR | **yes**, Web Crypto ES256 + GDHCN DSC | depends on inner payload | **decode and label the wrapper**; show the CWT claims and the subclaim number |
| WHO signed SHL (claim 5, `shlink:/`) | trivial once unwrapped | yes | yes | yes, SHL manifest | after unwrapping, hand the inner `shlink:/` to the existing SHL path |
| IHE VHL (claim 5, `vhlink:/`) | trivial | yes | yes (COSE) | **no**, needs RFC 9421 or SSRAA credential | decode fully, print the `List/_search` it *would* issue, and say why a browser cannot complete it |
| VHL as `application/vc+ld+json` | trivial (JSON shape) | yes | **no**, DataIntegrityProof needs JSON-LD canonicalisation | no | read `credentialSubject` as a payload, label the proof as unverified |
| GDHCN signer lookup | n/a | n/a | **yes**, CORS-open | n/a | fetch `/v2/trustlist/-/…` narrow path by `kid`, name country + key usage |
| GDHCN trust-list self-signature | n/a | n/a | **no** (PROD signer DID 404s) | n/a | do not attempt; state that it is unverifiable and why |
| `type: shl` / `type: vhl` member | trivial | trivial | n/a | n/a | one line: label the lineage instead of calling it corrupt |
| `shc:/` pasted by mistake | trivial | trivial (numeric decode) | yes, JWKS at `iss` | n/a | say "this is a Health Card, not a Health Link" |
| DDCC / EU DCC at subclaim 1/3/4 | trivial | yes | yes | n/a (self-contained) | render the vaccination or test claim; no network needed |

**Recommended build order.**

1. **`HC1:` unwrapping.** Highest ratio of value to effort in this note. Pure client-side, no
   network, no trust needed to *decode*. Turns "this viewer rejects my QR" into a full trace.
2. **The `kid` pre-check** from section 9. One hash, converts the worst error class (opaque
   decryption failure) into a precise statement.
3. **Variant labelling** from the payload: `type`, `extension`/`extensions`, a `url` containing
   `/List/_search` or `_id=`, `flag` combinations. A `url` with `/List/_search` is an IHE VHL even
   with no `type`, and saying so up front prevents an engineer debugging a manifest POST that was
   never going to work.
4. **GDHCN DSC lookup by `kid`**, narrow path only. Never fetch the 1.5 MB root list by default.
5. Only then consider COSE_Sign1 verification.

---

## 11. Concrete detection sketch

```ts
type Variant =
  | 'shl'            // HL7 baseline
  | 'hcert'          // an HC1: wrapper; the inner subclaim decides what it really is
  | 'shl-in-hcert'   // WHO IPS-for-Pilgrimage: signed SHL at claim 5
  | 'vhl-in-hcert'   // IHE ITI VHL, QR carrier
  | 'vhl-vc'         // IHE ITI VHL, application/vc+ld+json carrier
  | 'dcc'            // EU DCC / DDCC certificate at subclaim 1/3/4, no link inside
  | 'shc'            // SMART Health Card, not a link at all
  | 'unknown';

// Order matters: check carriers before payloads.
export function classify(input: string) {
  const s = input.trim();

  // Strip any viewer prefix. The spec puts the payload after a '#'.
  const hash = s.lastIndexOf('#');
  const body = hash >= 0 ? s.slice(hash + 1) : s;

  if (/^shc:\/[0-9]+$/.test(body)) return { variant: 'shc' as const };

  // Accept the whole reserved context-identifier range, not just HC1:.
  const m = /^(HC[1-9A-Z]):(.*)$/s.exec(body);
  if (m) return { variant: 'hcert' as const, contextId: m[1], b45: m[2] };

  // A bare vhlink:/ can appear outside an HCERT too (VC carrier, or copy-pasted out of claim 5).
  const pfx = /^(shlink|vhlink):\/(.*)$/s.exec(body);
  if (pfx) return { variant: 'shl' as const, scheme: pfx[1], b64: pfx[2] };

  return { variant: 'unknown' as const };
}

// Inside an HCERT, claim -260 subclaim 5 may hold EITHER prefix. Report which.
export function readHcertLink(hcert: Map<number, unknown>) {
  const five = hcert.get(5);
  if (typeof five !== 'string') return null;
  if (five.startsWith('vhlink:/')) return { kind: 'vhl' as const, uri: five };
  if (five.startsWith('shlink:/')) return { kind: 'shl' as const, uri: five };
  return { kind: 'bare' as const, uri: five };   // no prefix: protocol is ambiguous, say so
}

// A payload whose url is a FHIR List search is an IHE VHL even with no `type` member.
export function impliedProtocol(p: { url: string; type?: string; extension?: unknown }) {
  if (p.type === 'vhl') return 'vhl-list-search';
  if (/\/List\/_search|[?&]_id=|[?&]code=folder/.test(p.url)) return 'vhl-list-search';
  return 'shl-manifest-post';
}
```

Base45 sanity check, free and instant:

```ts
const B45 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
export function base45Complaint(s: string): string | null {
  const bad = [...s].find(c => !B45.includes(c));
  if (bad) return `character ${JSON.stringify(bad)} is not in the Base45 alphabet`;
  if (s.length % 3 === 1) return `length ${s.length} is impossible for Base45 (length mod 3 must be 0 or 2)`;
  return null;
}
```

---

## 12. Diagnostics this research directly enables

Written the way the brief demands, as one plain line each.

- `HC1:` present: "This is a WHO GDHCN health certificate QR, not a bare link. Unwrapping it: base45,
  then zlib, then a COSE-signed CWT."
- claim 5 holds `vhlink:/`: "This is an IHE Verifiable Health Link. Its manifest is a FHIR
  `List/_search`, not an SHL manifest POST, and completing it requires a trust-network credential
  this browser tool does not hold."
- claim 5 holds a bare base64url blob: "Claim 5 has no `shlink:`/`vhlink:` prefix, so the retrieval
  protocol is ambiguous. WHO's HCERT spec calls this slot SHL; the WHO logical model and IHE call it
  VHL."
- `kid` present in the JWE header and does not match the RFC 7638 thumbprint of `key`: "This file
  was encrypted with a different key than the one in the link. The link and the file are mismatched,
  not corrupt."
- COSE `kid` not in the GDHCN trust list: "No GDHCN participant currently publishes this signing key.
  GDHCN treats absence from the current list as the revocation signal, so this is either an untrusted
  issuer or a withdrawn key."
- COSE `kid` found: "Signed by <participant>, key usage DSC, resolved from
  `/v2/trustlist/DCC/<participant>/DSC/did.json`."
- payload has `type: "shl"` or `type: "vhl"`: "Non-HL7 member `type` present: this link follows the
  WHO GDHCN Personal Health Wallet model."
- payload has `extensions` (plural): "Member is `extensions`; IHE VHL defines `extension`. The base
  SHL spec reserves `extension` and defines no other member, so this is probably a typo."
- `contentType: application/pdf` in a manifest: "Not one of the three content types the SHL spec
  allows, but Malaysia's national GDHCN deployment emits PDF. Rendering anyway."
- Australian context: "Australia is not a GDHCN participant, so no WHO trust list will ever resolve
  this signer."
- `flag` contains both `P` and `U`: "The spec says these SHALL NOT be combined."
- `Bundle.meta.profile` absent: "No profile claimed. The HL7 IG's own IPS example also omits it, so
  absence is not evidence this is not an IPS."

---

## 13. Open questions

1. Is HCERT claim 5 normatively SHL or VHL? Four WHO/IHE sources disagree (section 4). Worth a
   `chat.fhir.org` question, and worth designing the tool to be agnostic regardless of the answer.
2. Is the missing PROD trust anchor DID (`tng-participants-prod/main/WHO/signing/DID/did.json`, 404)
   a deliberate omission or an operational gap? It makes PROD trust-list signature verification
   impossible for any client today.
3. Why is `DCC` the only domain in the PROD trust list when the Trust Domain value set names `DDCC`,
   `ICVP`, `PH4H` and `IPS-PILGRIMAGE`? Is `DCC` a legacy alias for `DDCC`?
4. Does any deployed GDHCN participant actually publish a link at HCERT claim 5 today, or is
   Malaysia's MySejahtera implementation the only one? A real captured `HC1:` string containing a
   link would be the single most valuable test fixture we could obtain, and Brisbane 2026-08-25 is a
   plausible place to ask for one.
5. Do the WHO trust list CDN endpoints stay CORS-open, and is the `-` wildcard path ever
   materialised? `/-/AUS/did.json` 404s today, so it may be documented but not generated.
6. IHE VHL is at `v1.0.0-comment` with placeholder transaction numbers (`ITI-YY1` to `ITI-YY5`).
   Those will be renumbered, so the tool should describe transactions by name, not number.
