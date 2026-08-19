# Platypus as an SHL producer: exactly what its links and payloads look like

Source: `/Users/pet260/Documents/repos/Platypus` @ `767254aa` (main, 2026-08-20). Everything below is read from the code, not from memory. Paths are repo-relative.

Platypus is a React Native personal health record that both **mints** and **receives** SMART Health Links. It ships its own relay (`apps/shl-lambda`, AWS Lambda + API Gateway HTTP API + DynamoDB + S3), so a link minted by Platypus in the field will almost always point at that relay. It is a high-value interop counterpart for shl-loupe: AU Core / AU PS / IPS payloads, a non-standard reply channel, and an unusually strict receive path whose refusal messages are already close to what shl-loupe wants to say.

Two orientation facts before the detail:

- **Platypus's own receive path already produces the one-line diagnosis the motivating incident needed.** `assertSafeShlUrl` (`packages/shl-parser/src/safe-fetch.ts`) throws `This health link points to a local address and was not opened.` for a loopback host, before any fetch. shl-loupe should say the same thing and can borrow the classifier wholesale (see §7).
- **The relay is CORS-open**, so shl-loupe can open Platypus links from a static site with no proxy. `apps/shl-lambda/cdk/stack.ts:155` sets API-level `corsPreflight: { allowOrigins: ['*'], allowHeaders: ['Content-Type','Authorization'], allowMethods: [GET, POST, DELETE, OPTIONS] }`, and `handlers/manifest.ts` / `handlers/file.ts` also set `Access-Control-Allow-Origin: *` on every response. `handlers/grants.ts` and `handlers/reply-slots.ts` do **not** set the header on their own responses (they rely on the API-level config).

---

## 1. The `shlink:` payload Platypus mints, and its relay URL shapes

### 1.1 Payload members

Minted in `apps/mobile/lib/shl-generator.ts` `finalizeShl()`:

```js
const shlPayload = {
  url: retrievalUrl,                      // always present
  key: keyBase64url,                      // always present, 43 chars (32 bytes base64url, unpadded)
  ...(flags.length > 0 && { flag: flags.join('') }),
  ...(label && { label }),
  ...(expiresAt && { exp: expiresAt }),   // unix SECONDS
};
const shlink = `shlink:/${base64urlEncode(new TextEncoder().encode(JSON.stringify(shlPayload)))}`;
```

- **Member order on the wire is fixed**: `url`, `key`, `flag`, `label`, `exp`. Useful as a producer fingerprint.
- **`v` is never emitted.** The parser's type declares `v?: string` (`packages/shl-parser/src/shl-parser.ts`, `interface SHLPayload`), which is the wrong JSON type: the spec says `v` is an integer. Nothing reads it, so a numeric `v` is harmless in practice, but a strict TypeScript consumer that trusts the type would be wrong.
- **No non-standard members.** Platypus adds nothing to the shlink payload. Everything proprietary lives inside the *encrypted* payload (see §4 and §2.7), which is a deliberate security property recorded in `docs/features/shl-form-invitations.md`: "The blank form and the reply descriptor live only inside the encrypted payload, never in the `shlink:` string."
- **Prefix is `shlink:/` with exactly one slash.** No `#shlink:` viewer prefix is generated (though the parser accepts one on receive).

### 1.2 Flags

`selectTier()` and the flag block in `finalizeShl()`:

| Controls the patient chose | Tier | `flag` emitted |
|---|---|---|
| no passcode, no opens limit | Tier 1, direct `GET` | **`LU`** |
| passcode set, no opens limit | Tier 2, hosted manifest | **`PL`** |
| passcode set, opens limit set | Tier 2 | **`P`** |
| no passcode, opens limit set | Tier 2 | (no `flag` member at all) |

Two things to flag in a compatibility check:

- **`PL` is not alphabetical.** The spec says the `flag` is a "String created by concatenating single-character flags in alphabetical order", so it should be `LP`. Platypus pushes `P` then `L`. Harmless for any flag reader that does `flag.includes('P')`, wrong for one that string-compares. shl-loupe should normalise before comparing and should *say* when a producer emitted an unsorted flag.
- **Expiry does not force Tier 2.** `L` keys off the opens limit alone. The code comment records why: every share now carries an expiry (the relay bounds retention at 90 days), so the old "no expiry and no opens limit" condition could never hold again.
- `U` is only ever emitted together with `L`, never bare, and never with `P` (the spec forbids `U` with `P`; `selectTier` structurally cannot produce that combination). Platypus's *own producer script* is the exception: `scripts/shl-invite.mjs` mints `flag: 'U'` bare, which a receiver reading single-use as "absence of L" will treat as one-shot.

### 1.3 Relay endpoint URL shapes

Base URL is build-time `EXPO_PUBLIC_API_BASE_URL`. The deployed relay (`apps/shl-lambda/README.md`, `DEPLOY.md`) is:

```
https://lb4cpvsdnf.execute-api.ap-southeast-2.amazonaws.com
```

Tokens are `randomBytes(32).toString('base64url')` (43 chars, `handlers/grants.ts`).

| Purpose | Shape |
|---|---|
| Tier 2 manifest (the `url` in a `PL`/`P` link) | `POST https://{host}/shl/manifest/{token43}` |
| Tier 1 direct file (the `url` in an `LU` link) | `GET  https://{host}/shl/file/{token43}` |
| Tier 2 revoke | `DELETE /shl/manifest/{token}` + `Authorization: Bearer {manageToken}` |
| Tier 1 revoke | `DELETE /shl/file/{token}` + same |
| Creator-only open counter | `GET /shl/manifest/{token}/access` + same credential |
| Producer identity | `POST /shl/installs` -> `{ installToken }` |
| Share registration + upload grant | `POST /shl/grants` -> `{ token, manifestUrl|fileUrl, manageToken, post }` |
| Reply slot (see §4) | `POST /shl/reply-slots`, `POST /shl/reply-slots/{id}/grants`, `GET|DELETE /shl/reply-slots/{id}` |
| Liveness / deployed version | `GET /shl/health`, `GET /shl/version` |

A Tier-2 `url` is 116 characters against the spec's 128 limit; a Tier-1 `url` is 112. Nothing in the app checks that limit, so a self-hosted relay on a long domain could silently exceed it.

### 1.4 The Tier-2 manifest response (non-standard extra member)

`apps/shl-lambda/src/handlers/manifest.ts` final return:

```json
{ "files": [ { "contentType": "application/fhir+json", "embedded": "<compact JWE>" } ],
  "status": "finalized" }
```

- **Always exactly one file, always `embedded`, never `location`.** The relay stores one object per link (`manifests/{token}` in S3).
- **`status: "finalized"` is not in the SHL spec.** shl-loupe must tolerate unknown top-level members and can use this one as a Platypus-relay fingerprint.
- The relay **ignores `embeddedLengthMax`** entirely: `handleManifest` never reads the request body except to pull `passcode`. A client that sends `embeddedLengthMax: 1000` still gets a 3 MB embedded JWE. Worth surfacing as a spec-conformance finding against the relay.
- The relay **ignores `recipient`** (it is never read, never logged; the access log format in `cdk/stack.ts` deliberately excludes bodies).

### 1.5 Relay status codes on the read path

| Route | Status | Body | When |
|---|---|---|---|
| `POST /shl/manifest/{token}` | 404 | `{"error":"Health link not found"}` | no metadata row (never created, revoked, or TTL-swept) |
| | 410 | `{"error":"Health link has expired"}` | past `expiresAt` |
| | 401 | `{"error":"Passcode required","remainingAttempts":N}` | `P` link, no passcode in body |
| | 401 | `{"error":"Incorrect passcode","remainingAttempts":N}` | wrong passcode |
| | 429 | `{"error":"Too many incorrect passcode attempts","remainingAttempts":0}` | 5 failed attempts, lifetime, cumulative |
| | 410 | `{"error":"Health link has reached its open limit"}` | conditional `ADD opensUsed` failed |
| | 404 | `{"error":"Manifest blob not found"}` | row exists, S3 object does not (grant minted, never redeemed) |
| | 200 | `{files:[...],status:"finalized"}` | success |
| `GET /shl/file/{token}` | 404 / 410 / 200 | `application/jose` body on 200 | no passcode check, **no opens counting** |
| `GET /shl/manifest/{token}/access` | 401 for every unauthorised cause; 404 `{"error":"Direct links are not counted"}` for a Tier-1 row; else 200 `{opensUsed, lastOpenedAt?, maxOpens?, expiresAt?}` (unix seconds) | | creator-only |

Notable deviations for a compatibility panel:

- **The spec says a no-longer-active link answers `404`. Platypus's relay answers `410` for expired and for open-limit-reached**, reserving 404 for "no row". Defensible and more informative, but a strict client that only handles 404 will report a Platypus expiry as an unknown failure.
- The 429 lockout carries **no `Retry-After`**, and the lockout is permanent-ish rather than a rate limit: `failedAttempts` is a lifetime counter, decremented by exactly one on a correct guess (`manifest.ts`, "release the reservation"). So a link can be permanently bricked by five wrong guesses.
- The passcode attempt is **reserved before the guess is checked** (conditional `ADD failedAttempts`), so parallel guessing cannot exceed 5. Passcode hashing is PBKDF2-SHA256, 200 000 iterations, 32-byte output, per-row 16-byte hex salt (`src/auth.ts` `hashPasscode`).
- `opensUsed` and `lastOpenedAt` are written **before** the S3 fetch, so a request that 404s on the blob still spends an open (documented deliberately in `src/types.ts`).

---

## 2. Every payload kind Platypus can put in a file

The `contentType` on every file Platypus registers is **always the literal `'application/fhir+json'`**. `ManifestUploadRequest.contentType` in `shl-generator.ts` is typed `'application/fhir+json'` and nothing else is ever passed; `generateSHLFromBundleJson` hard-codes it too. Platypus **never** emits `application/smart-health-card` or `application/smart-api-access`.

The plaintext inside is always a JSON FHIR resource, and always one of these six shapes.

### 2.1 `Bundle` / `type: "collection"` (the record share, the most common)

Built by `apps/mobile/lib/share-assembly/assemble.ts` `buildCollectionBundleJson`:

```json
{ "resourceType": "Bundle", "type": "collection",
  "timestamp": "<ISO>",
  "entry": [ { "fullUrl": "urn:uuid:<v4>", "resource": {...} }, ... ] }
```

- **No `id`, no `meta.profile`, no `identifier`** on a collection. That is deliberate: a collection "never implies a completeness the patient did not assert."
- **No `Patient` entry.** A collection carries only the selected clinical records, their `Provenance`, and any origin parties. `subject`/`patient` references therefore stay as logical `Patient/<id>` references that resolve to nothing inside the bundle. A viewer must not treat that as an error.
- Resource types come from the patient's selection, drawn from: `Observation`, `MedicationStatement`, `AllergyIntolerance`, `Condition`, `Immunization`, `DiagnosticReport`, plus whatever else the vault holds (`Procedure`, `CarePlan`, `Goal`, `CareTeam`, `DocumentReference`, `Questionnaire`, `Task`, `QuestionnaireResponse`, `ServiceRequest`).
- Patient-touched records (self-authored or locally corrected) each get a **base-R4 `Provenance`** entry with `agent[0].type.coding = provenance-participant-type|author` and `who` = the patient.
- Opted-in patient notes arrive as **patient-reported `Observation`s** each with its own `Provenance`.

### 2.2 `Bundle` / `type: "document"` with an IPS or AU PS `Composition`

Built by `apps/mobile/lib/ips-composer.ts` `composeIPS({ format: 'ips' | 'auPs' })`, shipped via `generateSHLFromBundleJson`.

Bundle level:

```json
{ "resourceType": "Bundle",
  "id": "<uuid>",
  "meta": { "profile": ["http://hl7.org.au/fhir/ps/StructureDefinition/au-ps-bundle"] },
  "identifier": { "system": "urn:ietf:rfc:3986", "value": "urn:uuid:<uuid>" },
  "type": "document",
  "timestamp": "<ISO>",
  "entry": [...] }
```

Profile canonicals (all in `share-assembly/conformance.ts` and `ips-composer.ts`):

| Format | Bundle profile | Composition profile |
|---|---|---|
| `ips` (targets `hl7.fhir.uv.ips#2.0.1`) | `http://hl7.org/fhir/uv/ips/StructureDefinition/Bundle-uv-ips` | `http://hl7.org/fhir/uv/ips/StructureDefinition/Composition-uv-ips` |
| `auPs` (targets `hl7.fhir.au.ps#1.0.0`) | `http://hl7.org.au/fhir/ps/StructureDefinition/au-ps-bundle` | `http://hl7.org.au/fhir/ps/StructureDefinition/au-ps-composition` |

Patient profile for `auPs`: `http://hl7.org.au/fhir/ps/StructureDefinition/au-ps-patient`. AU Core entry profiles are stamped on app-authored resources only, e.g. `http://hl7.org.au/fhir/core/StructureDefinition/au-core-medicationstatement`.

`Composition` fields: `id`, `meta.profile`, `text` (generated `div`, a `<ul>` of section titles), `identifier {system:'urn:ietf:rfc:3986', value:'urn:uuid:...'}` **distinct from `Bundle.identifier`**, `status:'final'`, `type` = LOINC `60591-5` "Patient summary Document", `subject` -> the Patient's `urn:uuid:`, `date`, `author` (the assembler `Organization`, plus the `Patient` when there is patient contribution), `title` ("AU Patient Summary" or "International Patient Summary"), `custodian` -> same `Organization`, `section[]`.

**The nine sections Platypus emits**, with the LOINC codes it uses:

| Title | LOINC | Source type | Emitted when empty? |
|---|---|---|---|
| Allergies and Intolerances | `48765-2` | AllergyIntolerance | yes (`emptyReason`) |
| Medication Summary | `10160-0` | MedicationStatement | yes |
| Problem List | `11450-4` | Condition | yes |
| History of Immunisations | `11369-6` | Immunization | yes |
| Vital Signs | `8716-3` | Observation, category `vital-signs` | no |
| Social History | `29762-2` | Observation, category `social-history` | no |
| Diagnostic Results | `30954-2` | Observation (catch-all for uncategorised) | yes |
| History of Procedures | `47519-4` | Procedure | yes |
| Patient Story | `81338-6` | patient notes as Observations | only when notes are included |

**Section codes carry NO `display`.** This is a hard rule in `docs/summary-conformance.md`: "A `Coding.display` the app writes SHALL be the display that code system publishes, or SHALL be absent. It is never a label." So a Platypus section is `{"coding":[{"system":"http://loinc.org","code":"10160-0"}]}` with the human wording in `section.title` (Australian spelling: "History of Immunisations"). A viewer that keys section identity off `display` will render nothing for a Platypus document. **Contrast the real WA Verify+ IPS fixture (§6), whose sections DO carry LOINC displays.**

An empty section carries `text` (a generated "No information available.") plus `emptyReason: {coding:[{system:'http://terminology.hl7.org/CodeSystem/list-empty-reason', code:'unavailable'}]}` and **no `entry`**. `emptyReason` is explicitly **not** an absence assertion (see §2.6).

Every section (populated or empty) carries `text.status: 'generated'` with an XHTML `div`, because both IPS and AU PS make `section.text` 1..1.

### 2.3 `DocumentReference` with an inline PDF

Two distinct producers:

**(a) A completed form as a document copy** (`apps/mobile/lib/form-response-document.ts` `buildFormDocumentReference`), inside the reply/export bundle:

```json
{ "resourceType": "DocumentReference", "status": "current",
  "type": { "coding": [{"system":"http://loinc.org","code":"74465-6","display":"Questionnaire response Document"}], "text": "Completed form" },
  "subject": {"reference": "Patient/<localKey>"},
  "author": [{"reference": "Patient/<localKey>"}],
  "date": "<ISO>",
  "description": "Completed form: <title>",
  "content": [{ "attachment": { "contentType": "application/pdf", "data": "<base64 PDF>", "title": "<title>.pdf", "creation": "<ISO>" } }] }
```

Note this one **does** carry a `display` on its LOINC coding (`74465-6` is verified against the terminology server, per the comment), so the no-display rule is scoped to *section* codes, not to every coding.

Strictly inline: `attachment.data` and **never** `attachment.url`, so nothing is separately fetchable. A viewer must be prepared for a multi-megabyte base64 blob in one entry, and for a bundle whose entire content is one `DocumentReference` ("Document only" export format).

**(b) A preserved received link** (`apps/mobile/lib/received-shl.ts` `buildReceivedShlDocumentReference`): a `DocumentReference` whose `content[0].attachment.url` is a `shlink:` URI, with `type.text` set and `description` = the link label. This is stored in the vault, so it can be *re-shared* inside a collection. **A Platypus collection can therefore contain a `DocumentReference` whose attachment URL is another SHL.** Recognising that (`isReceivedShlDocumentReference` tests `/shlink:/i` on the attachment URL) is a lovely feature for shl-loupe: a nested link the viewer can offer to open.

### 2.4 `QuestionnaireResponse` (form reply and form export)

`apps/mobile/lib/shl-reply.ts` `buildReplyBundle` produces:

```json
{ "resourceType": "Bundle", "type": "collection",
  "entry": [
    { "fullUrl": "urn:uuid:<a>", "resource": { "resourceType": "QuestionnaireResponse", ... } },
    { "fullUrl": "urn:uuid:<b>", "resource": { "resourceType": "DocumentReference", ... } },   // optional
    { "fullUrl": "urn:uuid:<c>", "resource": { "resourceType": "Provenance", "target":[{"reference":"urn:uuid:<a>"}], ... } }
  ] }
```

Note: **no `timestamp` on this Bundle** (unlike the record-share collection). The `QuestionnaireResponse` is rewritten for the wire (`buildReplyWireResponse`): local `id` stripped, `status: 'completed'` forced, `identifier: { system: 'https://platypushealth.app/form-response', value: '<vault surrogate id>' }` stamped, `meta.security` gains the **PATAST** patient-asserted label, any `basedOn` reference containing `Task/` dropped, and every extension whose `url` starts with `https://platypushealth.app/` stripped.

Three payload formats, chosen by the patient (`lib/shl-form-export.ts`): `both` (QR + DocumentReference + Provenance), `response` only, `document` only. In the document-only case the `Provenance.target` retargets the DocumentReference.

### 2.5 `Questionnaire` + requested `Task` (form invitations, inbound shape)

Platypus **receives** these rather than minting them, but its own producer tooling (`scripts/shl-invite.mjs`) mints exactly this and it is the shape a connectathon participant will hand shl-loupe:

```json
{ "resourceType": "Bundle", "type": "collection",
  "entry": [ { "resource": { "resourceType": "Task", "status": "requested", "intent": "order",
                             "priority": "routine", "description": "<sender label>",
                             "for": { "display": "..." },
                             "focus": { "reference": "<Questionnaire canonical|version>", "type": "Questionnaire" },
                             "authoredOn": "<ISO>",
                             "extension": [ { "url": "https://platypushealth.app/StructureDefinition/shl-reply-descriptor",
                                              "extension": [ {"url":"replyUrl","valueString":"..."},
                                                             {"url":"replyPostToken","valueString":"..."},
                                                             {"url":"publicJwk","valueString":"{\"kty\":\"EC\",...}"},
                                                             {"url":"expiresAt","valueInteger":1234567890} ] } ] } },
               { "resource": { "resourceType": "Questionnaire", ... } } ] }
```

**Entries here carry no `fullUrl` at all** (the script omits them), and the `Task.focus.reference` is a *canonical URL with an optional `|version`*, not a bundle reference. Both break a naive resolver.

Three Platypus-owned extension URLs a debugger should name rather than show raw:

- `https://platypushealth.app/StructureDefinition/shl-reply-descriptor` (complex; `replyUrl`, `replyPostToken`, `publicJwk`, `expiresAt`)
- `https://platypushealth.app/StructureDefinition/invitation-server-task-url` (`valueUrl`/`valueString`, absolute Task URL on a practice server)
- `https://platypushealth.app/StructureDefinition/invitation-sender-label` (`valueString`)

The counterpart implementation `aehrc/smart-forms-health-links` uses a **different** descriptor URL, `http://smartforms.csiro.au/StructureDefinition/shl-reply-descriptor`, with `replyToken` instead of `replyPostToken` (documented in `docs/features/shl-form-invitations.md`, "The counterpart's reply descriptor is not ours"). shl-loupe should recognise both and say which dialect it found: they are not interchangeable, and Platypus deliberately refuses the CSIRO one.

### 2.6 Absence assertions (`dataAbsentReason` is NOT how they are expressed)

`packages/ui/src/fhir-display/absenceAssertion.ts`. An absence is a **normal resource of the section's type** carrying a SNOMED negation concept, never a flag and never an empty section. Codes Platypus **writes**:

| Section | Resource type | Code written | Display |
|---|---|---|---|
| allergies | `AllergyIntolerance` | `716186003` | No known allergy |
| medicines | `MedicationStatement` | `787481004` | No known medications |
| problems | `Condition` | `160245001` | No current problems or disability |

Codes it additionally **recognises** on read: `409137002`, `429625007`, `428607008`, `428197003`, `716220001`, `1003774007`, `160244002` (allergies), and the SNOMED CT-AU `1234391000168107` "No known current medicines". There is also an anchored text fallback per section (`/^no known (drug |food |...)?allerg/i` etc.), scoped by `resourceType` so a code can never be read as an absence for the wrong section. `787480003` "No known procedures" is named in a comment as the future procedures code.

**shl-loupe should render these as a positive statement ("No known allergies"), not as a normal allergy row.** Getting this wrong is the classic viewer bug: showing "No known allergy" as if the patient were allergic to something called that.

### 2.7 `data-absent-reason` extension (a separate mechanism)

Where the claimed profile mandates an element the source did not supply, `share-assembly/conformance.ts` `stateAbsentWhereAuPsMandates` emits the **primitive extension sibling**:

```json
"_effectiveDateTime": { "extension": [ { "url": "http://hl7.org/fhir/StructureDefinition/data-absent-reason", "valueCode": "unknown" } ] }
```

Today exactly one row exists in the `AU_PS_MANDATED` table: `MedicationStatement.effective[x]` (AU PS 1.0.0 raises it to 1..1 where AU Core 2.0.0 has 0..1). Five of the demo patient's six medications hit it. The rule is keyed to the profile the payload *claims*, so an IPS document carries no such extension.

**A viewer that only walks named JSON fields will silently drop this**, because the information lives in the `_`-prefixed sibling key, not in the element. In the real AU PS fixture the string `data-absent-reason` occurs 21 times and `_effectiveDateTime` 5 times.

### 2.8 Everything else a renderer must handle in a Platypus payload

From the real emitted AU PS bundle (`docs/evidence/.../au-ps.origin-included.notes-included.json`, 71 entries):

`AllergyIntolerance` x6, `Composition` x1, `Condition` x2, `Device` x1, `Immunization` x3, `MedicationStatement` x6, `Observation` x45, `Organization` x1, `Patient` x1, `Procedure` x3, `Provenance` x2.

Code systems present, with occurrence counts:

```
90  http://snomed.info/sct
78  http://loinc.org
60  http://unitsofmeasure.org
45  http://terminology.hl7.org/CodeSystem/observation-category
27  http://terminology.hl7.org/CodeSystem/v3-ObservationInterpretation
15  http://terminology.hl7.org/CodeSystem/data-absent-reason
14  http://terminology.hl7.org/CodeSystem/v2-0074
 6  http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical
 3  http://terminology.hl7.org/CodeSystem/allergyintolerance-verification
 2  http://terminology.hl7.org/CodeSystem/v2-0203
 2  http://terminology.hl7.org/CodeSystem/condition-clinical
 2  http://terminology.hl7.org/CodeSystem/condition-ver-status
 2  http://terminology.hl7.org/CodeSystem/condition-category
 2  http://terminology.hl7.org/CodeSystem/provenance-participant-type
 1  https://healthterminologies.gov.au/fhir/CodeSystem/australian-indigenous-status-1
 1  https://healthterminologies.gov.au/fhir/CodeSystem/ihi-status-1
 1  https://healthterminologies.gov.au/fhir/CodeSystem/ihi-record-status-1
 1  http://pbs.gov.au/code/item
 1  http://terminology.hl7.org.au/CodeSystem/medication-type
```

The SNOMED codes are **SNOMED CT-AU** (e.g. `23281011000036106` "Bisoprolol fumarate 2.5 mg tablet"). Against the International edition they do not exist. `docs/summary-conformance.md` records this as a validator trap: "`-sct au` or every AU code reads as unknown." If shl-loupe ever validates or looks up codes, it must offer the AU edition, and it must not report an AU code as invalid because tx.fhir.org's default edition does not know it. `http://pbs.gov.au/code/item` code `2951H` is the **one remaining validation error** in Platypus's own evidence run, and it comes from fixture data, not from the emitter.

Identifiers: IHI at `http://ns.electronichealth.net.au/id/hi/ihi/1.0` (this is the system the receive path's cross-patient guard keys off, `lib/shl-cross-patient.ts`).

**Oddities a naive renderer breaks on, all present in real Platypus output:**

1. **Every `fullUrl` is `urn:uuid:<v4>`** in a Platypus-composed bundle, and the resource's own `id` is set to the *same* uuid for composed entries. Placed vault resources keep their **source server's** `id` (e.g. `active-bisoprolol`) while sitting under a fresh `urn:uuid:` fullUrl, so `fullUrl` and `id` disagree for most entries.
2. **References are rewritten to `urn:uuid:` where the target is in the bundle, and left exactly as they arrived where it is not.** One pass, `resolveInternalReferences` (`share-assembly/internal-references.ts`), runs once at the last point before the bundle exists. It is **positive-signal only**, and a logical key shared by two entries resolves to *neither*. Consequence: a real summary ships references to resources the app does not hold (`PractitionerRole`, `Encounter`, `Location`; 26 unresolvable against 208 resolvable in the demo patient's summary). This is a deliberate decision recorded on issue #549, not a defect. **shl-loupe must render an unresolvable reference as "not carried by this bundle", never as an error**, and it should count them.
3. **Contained resources.** `MedicationStatement.medicationReference: {"reference":"#bisoprolol"}` pointing at `contained[0]` a `Medication`. Platypus's own rule is that a medication's concept is read through one resolver that handles the inline-vs-contained choice (`docs/medications.md`). A viewer showing only `medicationCodeableConcept` renders a blank medicine name for every Platypus medication.
4. **Display-only `Provenance` agents with no `Organization`.** Where a record came from a received link that merely *asserted* a name, `origin-entries.ts` emits `agent[0].who = { display: 'Shared link labelled “WA Health Summary”' }` with **no `reference` and no minted resource**. The three wordings are fixed and are part of the wire contract:
   - basis `label`: `Shared link labelled “{name}”`
   - basis `content`: `Shared link whose contents name “{name}”`
   - basis none: `Received Health Link`
   Note the **curly quotes** U+201C/U+201D. A viewer must present the stated text verbatim and must not "dress it up" or fall back to "Unknown organisation". Platypus's own renderer resolves `agent.who.reference` first and falls back to `agent.who.display` (`summary-document.ts` `agentDisplay`).
5. **`Device` as an origin party.** A record from sample or device data yields `{"resourceType":"Device","id":"<uuid>","deviceName":[{"name":"Sample Data","type":"user-friendly-name"}]}`. No `manufacturer`, no `type`. A viewer keying device naming off `Device.type` shows nothing.
6. **Origin `Provenance` uses `occurredPeriod` for the receipt window and `recorded` for the assertion time.** `recorded` is when the payload was assembled, not when the data was created. Presenting `recorded` as "date of record" is wrong.
7. **One origin `Provenance` can `target` dozens of entries** (the demo bundle has a single Provenance with 40+ `target` references). A viewer that renders one row per target produces a wall.
8. **Adjudication `Provenance`** carries `activity: { coding: [{system:'http://terminology.hl7.org/CodeSystem/v3-DataOperation', code:'UPDATE', display:'revise'}], text: '<why this version was kept>' }` with `agent[0].type.coding.code` of `author` (patient chose) or `assembler` (the device elected). The *meaning* is in `activity.text`, not the code: FHIR has no merge-adjudication vocabulary. Wordings are fixed: `Kept as the more recently updated version`, `Kept as the version from the more authoritative source`, `Kept as the most recently received version`, `Kept because the patient chose this version`, and the degrade `Kept over another version held for this record`.
9. **The XHTML narrative in `section.text.div` and `Composition.text.div` is generated by Platypus and is trusted-by-construction on its own side.** A viewer rendering it must sanitise: Platypus's own renderer runs `stripActiveMarkup` and applies a CSP (`lib/untrusted-markup.ts`) before showing a *received* payload's narrative. Do the same.
10. **A collection carries no `Patient`,** so `subject: {"reference":"Patient/<partition-key>"}` dangles. Platypus will only put a logical `Patient/<id>` reference on the wire when the partition key is genuinely an IHI (`isIhiValue`); otherwise the reference and the whole patient party are **omitted**, because the vault key is `${connectionId}:${patientId}` and a colon is not a legal FHIR id. So a Platypus collection may have entries with no `subject` at all.
11. `Bundle.identifier.system` is `urn:ietf:rfc:3986` with a `urn:uuid:` value (Platypus). The WA fixture uses `urn:ietf:rfc:4122` with a bare uuid value. Both are in the wild.

---

## 3. JWE parameters, compression, and size caps

### 3.1 The header Platypus emits

`packages/jose/src/jwe.ts` `assembleDirJwe`, reached through `packages/shl-parser/src/shl-parser.ts` `encryptAsJWE`:

```json
{"alg":"dir","enc":"A256GCM","cty":"application/fhir+json"}
```

and with compression on:

```json
{"alg":"dir","enc":"A256GCM","cty":"application/fhir+json","zip":"DEF"}
```

- **Member order is load-bearing**, not cosmetic: `alg`, `enc`, `cty`, then extras. The protected header segment is the AAD, so reordering changes the ciphertext. `alg`/`enc` are stripped from any caller-supplied header and rewritten first so they cannot lie.
- `enc` is **only** `A256GCM`. 32-byte CEK, 12-byte IV, 16-byte tag.
- The `encrypted_key` segment is **always empty** (`header..iv.ct.tag`, five dot-separated parts with an empty second). `splitCompactJwe` refuses a non-empty one outright: `expected an empty encrypted_key (direct key management)`.
- `cty` defaults to `application/fhir+json` and in practice is always that. `EncryptJWEOptions.contentType` exists but no production caller sets it. Passing `''` emits an empty `cty`, which is wire-distinct from omitting it.
- **`kid` is never emitted. No `apu`/`apv` on the `dir` path.**

### 3.2 Compression

- **Outbound compression is OFF by default.** `encryptAsJWE` only sets `zip: 'DEF'` if the caller passes `opts.zip === 'DEF'`, and **no production caller does**. `zip` exists solely so the conformance vector `11-zip-def` can exercise the inflate branch.
- So: **a real Platypus link is uncompressed.** If shl-loupe sees `zip: 'DEF'` on a link claimed to be Platypus-minted, either the vector generator or a third party produced it.
- Inbound, `zip: 'DEF'` is inflated as **raw DEFLATE (RFC 1951), no zlib header**, via `pako`'s streaming `Inflate({raw:true})` with a hard 10 MiB output bound. `pako` is used rather than `node:zlib` because Hermes has no zlib and the two "do not agree byte for byte."

### 3.3 Size caps (all of these are relevant to a debugger's error messages)

| Cap | Value | Where |
|---|---|---|
| Single uploaded encrypted object | **10 MiB** (`10 * 1024 * 1024`) | `apps/shl-lambda/src/limits.ts` `MAX_OBJECT_BYTES`, enforced as a `413` on `POST /shl/grants` and as an S3 presigned-POST `content-length-range: [1, 10485760]` condition |
| Client mirror before anything uploads | 10 MiB | `shl-generator.ts` `MAX_SHL_OBJECT_BYTES` |
| One fetched JWE body (direct GET, or a `location` fetch) | 10 MiB | `shl-parser.ts` `MAX_FETCHED_JWE_BYTES` |
| Manifest response body | **10 MiB + 64 KiB** | `MAX_MANIFEST_BYTES` |
| Inflated `zip=DEF` output | 10 MiB | `MAX_INFLATED_BYTES` (decompression-bomb guard; streamed and abandoned as soon as the total passes) |
| Upload grant lifetime | 300 s | `GRANT_EXPIRY_SECONDS` |
| Grant mints per install per hour | 30 | `MAX_GRANT_MINTS_PER_HOUR`, fixed hourly window, 429 on exceed |
| Max share lifetime | 90 days + 300 s clock skew | `MAX_SHARE_LIFETIME_SECONDS`, `SHARE_EXPIRY_CLOCK_SKEW_SECONDS`. **An absent `expiresAt` is set to now + 90 days**, never stored unbounded, because it is the DynamoDB TTL attribute |
| Max `maxOpens` accepted | 100 (app UI offers 1 / 5 / 10 / unlimited) | `MAX_SHARE_OPENS` |
| Max `label` accepted by the relay | **200 chars** (app UI caps at 80) | `MAX_SHARE_LABEL_CHARS`. The spec limit is 80, so the relay will accept a spec-invalid label |
| API stage throttle | 20 req/s, burst 40 | `cdk/stack.ts` |
| Passcode attempts | 5 lifetime | `manifest.ts` `MAX_PASSCODE_ATTEMPTS` |

Measured reality: "an extreme full-record share is about 3.3 MB of ciphertext" after the roughly 1.37x JWE/base64 expansion (`limits.ts`). A real Platypus link is more often tens to hundreds of KB.

The bounded read is honest about what it is: a **refusal** bound, not a transfer cap, because React Native's fetch has no streaming body. Steps are declared `Content-Length` (refused first, cheapest), then `Blob.size`, then decode. shl-loupe in a browser *can* stream, so it can do better and should say so.

---

## 4. The reply channel: a non-standard ECDH-ES extension

This is the thing most likely to make another viewer choke, and the thing shl-loupe can differentiate on by *explaining* it.

### 4.1 What it is

An SHL invitation can carry a way *back*. The mechanism is entirely outside the SHL spec:

1. The producer creates a **reply slot** on the relay: `POST /shl/reply-slots` with `{ expiresAt }` (unix seconds, must be future, at most 90 days out), authenticated with an install token. Response: `{ slotId, replyPostToken, pollToken, replyUrl }`. `slotId` is `randomBytes(16).toString('base64url')` (22 chars); both tokens are `randomBytes(32).toString('base64url')` (43 chars). Only SHA-256 hashes are stored.
2. The producer generates a **P-256 keypair** and puts the *public* JWK, the `replyUrl`, and the `replyPostToken` into the `shl-reply-descriptor` extension on the invitation `Task`, **inside the encrypted payload**. The **poll token never goes into the invitation.**
3. The filler encrypts its reply to the public key as an **ECDH-ES + A256GCM compact JWE**, redeems the post token for a short-lived presigned S3 POST grant (`POST /shl/reply-slots/{id}/grants` with `{ postToken, size }`), and uploads.
4. The producer polls `GET /shl/reply-slots/{id}` with `Authorization: Bearer {pollToken}`. Pending returns **`200 {"status":"pending"}` as JSON**; a delivered reply returns the raw JWE with `Content-Type: application/jose`. `DELETE` with the poll token removes it and is allowed even after expiry.

Threat model, verbatim from `reply-crypto.ts`: "anyone holding an SHL invitation link can decrypt the invitation (that is the SHL possession model), so a symmetric reply key carried inside the invitation would let a leaked link read the patient's completed answers." Hence asymmetric. A leaked invitation can at worst *overwrite* the reply with garbage, never read it.

### 4.2 The exact reply JWE

`packages/jose/src/jwe.ts` `assembleEcdhEsJwe`. Header, in this exact member order:

```json
{"alg":"ECDH-ES","enc":"A256GCM","cty":"application/fhir+json",
 "epk":{"kty":"EC","crv":"P-256","x":"<43ch base64url>","y":"<43ch base64url>"}}
```

- `cty` sits **before** `epk` deliberately ("Header member order matters and is preserved deliberately: it is part of the AAD"). `apu`/`apv` are appended after `epk` only when non-empty; the SHL reply channel supplies neither, so **`apu` and `apv` are absent**.
- `epk` is the *uncompressed* point form re-encoded as a JWK. No `kid`, no `alg` on the epk.
- Direct key agreement: the derived key **is** the CEK. `encrypted_key` segment empty.
- **Concat KDF exactly per RFC 7518 §4.6.2 / NIST SP 800-56A**, single round because keydatalen (256) equals the SHA-256 output length:
  `SHA-256( uint32BE(1) || Z || len32(utf8("A256GCM")) || len32(apu) || len32(apv) || uint32BE(256) )`, `SuppPrivInfo` empty. `AlgorithmID` is the **`enc`** value (`A256GCM`), which is correct for direct agreement and is the single most commonly got-wrong detail. A debugger that recomputes this should say so, because the failure mode is a clean-looking round trip against a wrong implementation.
- `Z` is the X coordinate of the shared point; the code tolerates noble returning 32, 33 (compressed) or 65 (uncompressed) bytes and slices accordingly.
- On decrypt, the attacker-supplied `epk` goes through `parseP256PublicJwk` which validates the point is on the curve **before** any agreement, "the difference between a key agreement and an invalid-curve attack that recovers the private scalar."
- **JWK acceptance policy**: a short `x`/`y` (leading zeros stripped) is **left-padded and accepted**, then canonicalised, and RFC 7638 key identity is computed only from the canonical form. Rationale in `reply-crypto.ts`: Web Crypto and `jose@6` both accept the stripped encoding, so refusing would make this app "the strictest node on the wire." Measured over 20 000 exported P-256 keys, none were short.

### 4.3 What the reply payload contains

`buildReplyBundle` (see §2.4): a `collection` Bundle with the wire-projected `QuestionnaireResponse`, optionally a PDF `DocumentReference`, and a patient `Provenance`. No `Patient` reference rewriting: "the practice correlates the reply by the slot it arrived in."

### 4.4 The pinning rule that will bite an interop test

`replyUrl` arrives from link content and is therefore untrusted, and redeeming its grant presents the device's install token. So `parseReplyDescriptor` calls `isOwnRelayUrl(replyUrl)` and **drops the whole descriptor** if the origin is not the app's build-time `EXPO_PUBLIC_API_BASE_URL` origin (parsed origin comparison, never a string prefix). `sendReply` asserts it again at the request. Consequence: **an invitation minted against relay A can be filled but not answered by an app built against relay B**, and the failure presents as "no send-back offered", not as an error. `scripts/shl-invite.mjs` documents this in its own env notes.

A partial descriptor (any of `replyUrl`, `replyPostToken`, `publicJwk` missing or malformed, or a `publicJwk` that is not `{kty:'EC', crv:'P-256', x, y}`) also degrades silently to fill-only. shl-loupe should **enumerate which of the four fields were present** rather than reporting "no reply channel."

### 4.5 A byte-compatible pure-Node reference implementation exists in the repo

`scripts/shl-invite.mjs` implements both the `dir` JWE and the ECDH-ES reply on `node:crypto` alone, "deliberately kept byte-compatible with `@platypus/shl-parser`", and does **not** import the package. It is about 80 lines of directly liftable reference code for shl-loupe (`encryptDirJWE`, `concatKdf`, `jwkToPoint`, `decryptReplyJWE`, `generateP256KeyPair`). The independence is enforced by `packages/jose/src/counterpart-independence.test.ts`, which fails if anyone "tidies up" the duplication, because the agreement between two code-sharing-free implementations is the evidence the wire contract is real.

---

## 5. Where Platypus is stricter or looser than the spec (the compatibility check)

### 5.1 Stricter than the spec (Platypus refuses what another viewer accepts)

| Behaviour | Location | Consequence for interop |
|---|---|---|
| **`shlink://` with two slashes fails to parse.** The regex is `/shlink:\/?([A-Za-z0-9\-_]+)/`, at most one slash. Verified: `shlink://AAA` -> no match. | `parseSHLUrl` | Every doc comment in the repo says "shlink:// URL", and the parser rejects it. Anyone hand-typing the doubled form gets `Not a valid shlink:// URL`. shl-loupe should accept both and *say* that Platypus will not. |
| **The URL scheme match is case-sensitive** in the parser, but the receive screen gates on `/shlink:/i`. | `app/shl/index.tsx:88` vs `parseSHLUrl` | `SHLINK:/...` passes the screen's validation and then throws in the parser. |
| **`https:` required, loopback and link-local refused** (`localhost`, `*.local`, `0.0.0.0`, `::1`, `::`, `127.0.0.0/8`, `169.254.0.0/16`, `fe80::/10`), with **IPv4 obfuscation canonicalised first**: decimal (`2130706433`), hex (`0x7f000001`), mixed-base octets (`0x7f.0.0.1`, `0177.0.0.1`), and IPv4-mapped IPv6 (`::ffff:169.254.169.254`, `::ffff:a9fe:a9fe`). Private LAN ranges (10/8, 172.16/12, 192.168/16) are **deliberately allowed**. | `packages/shl-parser/src/url-safety.ts` `classifyHttpsUrlSafety` | This is exactly the motivating incident. Four verdicts: `ok`, `invalid`, `insecure-scheme`, `local-address`. Copy this classifier verbatim. |
| **Every redirect hop is re-checked**, `redirect: 'manual'`, max 5 hops, and a response whose final origin differs from the requested origin is **refused** as evidence the implementation followed a redirect behind our back. A redirected POST is rewritten per the Fetch standard (303 always to GET; 301/302 to GET when POST) with `content-type`/`content-length` stripped, so the passcode is never replayed to a host the link did not name. | `safe-fetch.ts` | A link whose manifest 302s to a different host **will not open in Platypus** but opens in most browsers-based viewers. That divergence is worth a named compatibility check. |
| **A JWE with a non-empty `encrypted_key` segment is refused before anything is attempted**, as is any `enc` other than `A256GCM` and any `alg` other than the one the called function expects. | `packages/jose/src/jwe.ts` `splitCompactJwe` | Platypus supports **only** `dir` + `A256GCM` (payload) and `ECDH-ES` + `A256GCM` (reply). `A128GCM` is refused (this is conformance vector 13). |
| **Bounded reads refuse over-cap bodies before decode** (10 MiB / 10 MiB + 64 KiB). A hostile relay embedding several near-cap files in one manifest is refused by design. | `readBodyBounded` | A legitimate multi-file manifest totalling over ~10 MiB is unopenable in Platypus. |
| **Decompression bomb guard** at 10 MiB inflated. | `inflateRawBounded` | |
| **Reply slot URL pinned to the app's own relay origin.** | `isOwnRelayUrl` | See §4.4. |
| **`Task.status` preference**: `detectInvitation` prefers a Task with `status === 'requested'` that references the Questionnaire, then falls back to any Task referencing it. | `shl-invitation.ts` | |

### 5.2 Looser than the spec (Platypus accepts what a strict viewer rejects)

| Behaviour | Location | Note |
|---|---|---|
| **`shlink:AAA` with no slash at all parses.** | `parseSHLUrl` regex | |
| **The regex matches anywhere in the input**, so `shlink:/...` embedded in arbitrary text, or after any viewer prefix (`#shlink:/`, `?shlink=`), works. Leading/trailing whitespace is fine. | | |
| **base64url padding is tolerated** because `=` is simply outside the character class and stops the match (conformance vector 15 covers a body of length 2 mod 4). | | |
| **`contentType` on a manifest file is completely ignored on receive.** `decryptSHLFile` decrypts and `JSON.parse`s regardless. A `application/smart-health-card` file works only because `extractEntries` happens to understand `verifiableCredential`. An `application/smart-api-access` file would parse and yield zero resources with no complaint. | `shl-parser.ts` | |
| **Three payload shapes are accepted**, not just a Bundle: a `Bundle` (unwrap `entry[]`), an object with `verifiableCredential[]` (each entry either a compact JWS whose payload is raw-DEFLATE, or an already-decoded VC object; `credentialSubject.fhirBundle` is pulled and recursed), or **a single bare resource** with a `resourceType`. | `extractEntries` | Platypus reads SMART Health Cards but **never signs or issues one**. It does not verify the JWS signature at all (`decodeShcJws` splits, inflates, parses, and returns null on any failure). shl-loupe should verify SHC signatures and should say plainly that Platypus does not. |
| **An empty `collection` Bundle yields zero resources and is accepted, not an error** (conformance vector 20). | | |
| **`manifest.files[].location` is fetched and decrypted if present**, even though the relay never produces one. No check on the spec's "one hour lifetime". | `decryptSHLFile` | |
| **Direct-retrieval `400` retry**: `fetchDirectFile` appends `?recipient=Platypus%20Health`, and on a `400` retries **once** against the bare URL with no parameter. This is documented permanent tolerance for FHIR servers (HAPI) that refuse unknown query parameters on a read. **`404` and `410` are never retried** and map to `SHLExpiredError`. | `shl-parser.ts`, `docs/shl-u-flag-hosting.md` | Fully evidenced: `GET proxy.smartforms.io/fhir/Binary/4343` returns 200 `application/jose` 149 545 bytes, and the same GET with `?recipient=...` returns **400** with an `OperationOutcome` reading "Invalid request: The FHIR endpoint on this server does not know how to handle GET operation[Binary/4343] with parameters [[recipient]]". A survey of five public FHIR servers found none that both returns raw JWE bytes on a bare GET and tolerates the parameter. **This is the single best diagnostic shl-loupe can ship for U-flag links: "this host rejects the spec-required `recipient` parameter; retrying without it."** |
| **The dev relay origin is exempted from every URL rule** via `configureTrustedRelayOrigin(EXPO_PUBLIC_API_BASE_URL)`, whose dev default is `http://localhost:3000`. So a dev build of Platypus **will** open a cleartext loopback link, if and only if it is on its own build-time relay origin, compared as a parsed origin. | `safe-fetch.ts` | Directly relevant to the motivating incident: this is the *legitimate* version of "it worked on my machine", and the reason the exemption is origin-scoped and build-time. |
| **Manifest 404 is not distinguished on the Tier-2 path.** `fetchSHLManifest` handles 401 and 410 and lumps everything else into `Manifest fetch failed: ${status}`. Since the spec says an inactive link answers **404**, a spec-conformant expired link reads as a generic failure in Platypus. The direct-file path does handle 404. | `fetchSHLManifest` | Worth reporting in a compatibility panel as "this receiver would not recognise your 404 as expiry". |
| **Deduplication on receive**: by `resourceType/id` where an id exists; an id-less `Patient` is collapsed to the first only ("an SHL is always single-patient"); other id-less resources are all kept. | `receiveSHL` | A viewer showing raw counts will disagree with Platypus's counts. |
| **Reference resolution on the read side is three-step**: exact `fullUrl` match, then `ResourceType/id` match, then a `urn:uuid:` reference matched against a bare resource `id`. It does **not** resolve a relative reference against an absolute `fullUrl` base, which is what FHIR actually requires and what the real WA IPS fixture needs. | `summary-document.ts` `resolveReference` | shl-loupe should do it properly and can point out the gap. |

### 5.3 Relay-side deviations worth naming

- `410` where the spec says `404` (expired, open-limit).
- `429` for passcode lockout with no `Retry-After`; the spec's `429` is a rate limit.
- `status: "finalized"` added to the manifest response.
- `embeddedLengthMax` ignored.
- `label` accepted up to 200 chars against the spec's 80.
- No `location` files ever, so the one-hour location lifetime rule is untested by this relay.

---

## 6. Test fixtures in the repo, ready to lift as offline sample data

All paths relative to `/Users/pet260/Documents/repos/Platypus`.

### 6.1 The SHL conformance vector catalogue (the single best find)

**`apps/mobile/lib/__fixtures__/shl-vectors/`** plus **`index.json`**. 21 self-describing JSON files, each carrying a real `shlink:` URL, the stubbed manifest or file response, and the expected resource list. Deterministic, offline by contract, fictional URLs (`https://shl.example.org/manifest/NN`, `https://shl.example.org/file/NN`, `https://files.example.org/loc/09`). Generated by **`apps/mobile/lib/__fixtures__/shl-vectors.build.ts`** with `TEST_KEY = bytes 1..32` (base64url `AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyA`), `ALT_KEY = 0xff-i` for the wrong-key case, and a per-vector deterministic 12-byte IV. Regenerate with `UPDATE_SHL_VECTORS=1 npx vitest run lib/shl-vectors.test.ts`; the drift guard in `apps/mobile/lib/shl-vectors.test.ts` fails if the golden files and the generator disagree.

| File | What it contains |
|---|---|
| `01-bundle-plain.json` | bare `shlink:/`, no flag, embedded JWE, collection Bundle -> `Patient/p1`, `Observation/o1`, `Observation/o2` |
| `02-viewer-prefixed.json` | `https://viewer…#shlink:/…` form, same payload |
| `03-flag-L-no-exp.json` | `flag:"L"`, no `exp` |
| `04-flag-U-direct.json` | `flag:"U"`, a `file` string (the raw JWE) instead of a manifest -> `Patient/p4`, `Immunization/imm4` |
| `05-flag-P-correct-passcode.json` | `flag:"P"` with the correct passcode |
| `06-flag-P-wrong-passcode.json` | expects a `401` -> `SHLPasscodeError` |
| `07-expired-payload.json` | past `exp`, rejected before any network call |
| `08-gone-410.json` | manifest `410` -> `SHLExpiredError` |
| `09-manifest-location.json` | file served by `location` URL rather than `embedded` |
| `10-multi-file-manifest.json` | two embedded files; the repeated `Patient` is deduplicated |
| `11-zip-def.json` | `zip:"DEF"` header, raw DEFLATE payload |
| `12-tampered-ciphertext.json` | one altered ciphertext byte -> AES-GCM auth failure |
| `13-tampered-header.json` | header rewritten to `enc:"A128GCM"` -> header-as-AAD mismatch **and** unsupported-enc refusal |
| `14-wrong-key.json` | payload `key` is `ALT_KEY`, ciphertext is under `TEST_KEY` |
| `15-base64url-padding.json` | payload body length 2 mod 4 |
| `16-single-resource.json` | one top-level FHIR resource, not a Bundle |
| `17-shc-jws.json` | SMART Health Card `verifiableCredential` compact JWS, header `{"alg":"ES256","zip":"DEF"}`, DEFLATE payload |
| `18-shc-object.json` | `verifiableCredential` entry already decoded to a VC object |
| `19-patient-dedup.json` | Bundle repeats the same Patient |
| `20-empty-bundle.json` | empty collection Bundle -> zero resources, accepted |
| `21-malformed-url.json` | not a `shlink` URL at all |

Each file's schema is `{ name, describes, shlink, manifest? , file?, expect: { resources: ["Type/id", ...] } }` (plus a passcode field on 05/06 and an error expectation on the failure cases). **This is a drop-in offline test corpus for shl-loupe.**

### 6.2 Frozen JOSE wire vectors

**`packages/jose/src/__fixtures__/wire-vectors.ts`**. Byte-frozen compact serialisations for every JOSE operation, with all fixed test-only key material inline (`DIR_CEK` = bytes 1..32, `FIXED_IV` = 1..12, `FIXED_IV_2` = 12..1, `RECIPIENT_SCALAR` = 0x2a in the last byte, `EPHEMERAL_SCALAR` = 0x11+i, `SIGNING_SCALAR` = 0x80-i, `FIXED_NOW_MS = 1754000000000`, `FIXED_JTI = 'AAECAwQFBgcICQoLDA0ODw'`). The values shl-loupe cares about:

- `shlDirJwe` and `shlDirJweDeflated`: complete `dir` JWEs, uncompressed and `zip=DEF`, over a fixed `{resourceType:'Bundle',type:'collection',entry:[{resource:{resourceType:'Patient',id:'vector-patient'}}]}` plaintext.
- `shlReplyJwe`: a complete **ECDH-ES reply JWE** with a real `epk`.
- `kdfNoParties` = `XRtNzn2GGTd_hbiu_5PozxABdcr6bIWvPQ6mr5Io4cs`, `kdfWithParties` = `Wa9aIiTNb5NR-ehegARYpPdb1rx0mqEYkbsq09zWIyw`, over `KDF_Z = (i*7+3) & 0xff`, `apu = "Alice"`, `apv = "Bob"`. **These two are the Concat-KDF test vectors shl-loupe should use to prove its own ECDH-ES implementation**, because the KDF is the part a round trip cannot check.

Companion: `packages/jose/src/testing/independent-node.ts` and `independent-jose.ts` (two implementations sharing no code with the package, one on `node:crypto` and one on `jose@6`, asserted in both directions).

### 6.3 Real emitted IPS and AU PS documents, with validator output

**`docs/evidence/au-ps-structural-validation-2026-08/bundles/`**: eight real emitted document Bundles, roughly 143 to 154 KB each, covering the 2x2 of origin-included/declined by notes-included/excluded.

```
bundles/au-ps/au-ps.origin-{declined,included}.notes-{excluded,included}.json   (au-ps-bundle, 67 to 71 entries)
bundles/ips/ips.origin-{declined,included}.notes-{excluded,included}.json       (Bundle-uv-ips,  67 to 71 entries)
```

Each was validated against `hl7.fhir.au.ps#1.0.0` or `hl7.fhir.uv.ips#2.0.1` with terminology on, and reports **1 error** (the `2951H` PBS code, fixture data) and 199 to 249 warnings. Also there: `MANIFEST.md` (the full per-bundle error and warning table, resource mix, and section list), `profile-resolution-check.json` (a deliberate control file that claims `au-ps-patient` and satisfies none of it, **which must fail or the IG was not loaded**), `validate.sh`, `validate-terminology.sh`, `summarise.py`, and `validator/**` with the raw `OperationOutcome`s.

**`docs/evidence/au-ps-obligation-audit-2026-08/obligations.tsv`** (35 KB) plus `extract-obligations.py` and `check-emitted.py`: the AU PS obligation model machine-readable, which a structural validator cannot see. Useful if shl-loupe ever wants a "must-support" panel.

### 6.4 A real third-party IPS document (not Platypus-produced)

**`apps/mobile/lib/__fixtures__/wa-health-summary-ips.json`**, 67 KB. A real WA Verify+ / MyHealthSummary IPS `document` Bundle. Profile `Bundle-uv-ips`. Resource mix: `Condition` x7, `DiagnosticReport` x4, `Observation` x2, `Composition`, `Patient`, `AllergyIntolerance`, `MedicationRequest`, `Medication`, `Immunization`, `Procedure`. Its differences from Platypus output are exactly the interop surface shl-loupe should handle:

- `Bundle.identifier.system` is `urn:ietf:rfc:4122` with a **bare uuid** value (Platypus uses `urn:ietf:rfc:3986` with a `urn:uuid:` value).
- **The Composition's `fullUrl` is `urn:uuid:...` while every other entry's `fullUrl` is an absolute server URL** (`https://fhir-auth.myhealthsummary.demo.cirg.uw.edu/fhir/Condition/<uuid>`), and references are **relative** (`Condition/<uuid>`). Correct per FHIR (a relative reference resolves against the containing entry's `fullUrl` base), and it defeats any resolver that only does literal `fullUrl` string matching, including Platypus's own.
- Sections **do** carry LOINC `display` strings ("History of Medication use Narrative", "Problem list - Reported").
- The `Composition` carries **no `meta.profile`** even though the Bundle does.
- Uses `MedicationRequest` + a separate `Medication` entry, where Platypus uses `MedicationStatement` with a **contained** `Medication`.
- Zero `contained`, zero `data-absent-reason`, section titles in US spelling ("History of Immunizations").

### 6.5 Questionnaire and QuestionnaireResponse fixtures

- **`apps/mobile/lib/__fixtures__/mbs715-v040-completed-qr.json`** (4 KB): a completed MBS 715 `QuestionnaireResponse`.
- **`apps/mobile/lib/__fixtures__/mbs715-v040-extracted-bundle.json`** (14 KB) and `mbs715-v040-patch-bundle.json` (1.5 KB): the `$extract` output for the same response.
- **`packages/sdc/src/__fixtures__/flat-questionnaire.ts`**, `assemble.ts`, `extract.ts`, `fhirpath-matrix.ts`: SDC-side Questionnaire fixtures.
- The default invitation canonical used by the producer tooling is `http://www.health.gov.au/assessments/mbs/715-Phase3`, fetched from `https://smartforms.csiro.au/api/fhir`.

### 6.6 Producer tooling that will mint live sample links

- **`scripts/shl-invite.mjs`** (`invite-form` and `poll-reply` subcommands) and **`scripts/practice-sim.sh`**. `RELAY=... FORMS_SERVER=... EXPIRY_DAYS=... node scripts/shl-invite.mjs invite-form [canonical] [label]` prints a live `shlink:`, `SLOT_ID`, `POLL_TOKEN`, and `PRIV_JWK`. Pure `node:crypto`, so it runs anywhere and is also the cleanest reference implementation to port (§4.5).
- **`apps/shl-lambda/DEPLOY.md`** carries the deployed API base and `curl` smoke checks.
- **`docs/sparked-server-demos.md`** is the connectathon runbook for the whole loop.

### 6.7 Unit tests worth reading for edge-case inventories

- `packages/shl-parser/src/shl-parser.test.ts` (663 lines): URL parsing edge cases, bounded reads, manifest status mapping.
- `packages/shl-parser/src/safe-fetch.test.ts` (315) and `url-safety.test.ts` (82): the SSRF matrix, including every IPv4 obfuscation form.
- `packages/shl-parser/src/reply-crypto.test.ts` (293) and `wire-vectors.test.ts` (179): cross-implementation ECDH-ES agreement.
- `apps/mobile/lib/shl-generator.test.ts` (875): flag selection, tier selection, size caps, consent gating.
- `apps/mobile/lib/share-assembly/collection-origin.test.ts` (583) and `summary-document-origin.test.ts` (570): the exact expected origin `Provenance` shapes, including the display-only claimed-agent wordings.
- `apps/shl-lambda/src/handlers/manifest.test.ts` (375) and `reply-slots.test.ts` (324): every relay status code path.

---

## 7. What this means for shl-loupe, concretely

1. **Ship the `classifyHttpsUrlSafety` verdicts as first-class diagnoses**, with Platypus's wording as the model. Four verdicts (`ok`, `invalid`, `insecure-scheme`, `local-address`), IPv4 obfuscation canonicalised before the check, private LAN ranges allowed. The incident link (`https://localhost:5173/api/shl-manifest?bid=4836470`) lands on `local-address` and deserves the one line "this link points at localhost, so it can only ever open on the machine that made it." Note the twist: it is *https* and *has a port*, so a scheme-only check misses it entirely, and iOS ATS permits cleartext-to-LAN, which is why the host test has to be its own layer.
2. **Distinguish "the fetch failed" from "the fetch was refused before it was issued."** A bare `TypeError` from `fetch` is the failure mode the incident's viewer had. Platypus's structure (classify, then fetch, per hop) is the shape to copy: report the refusal reason, the hop that was refused, and the hop budget.
3. **Trace and label each tier explicitly.** Tier 1 (`U`) is one `GET` with `?recipient=`; Tier 2 is a `POST` with a JSON body. Show the actual request, and for a `U` link show the `recipient`-parameter retry that Platypus performs, because it is the single most common real-world U-flag failure (HAPI rejects unknown query parameters on a read; five of five surveyed public FHIR servers fail one half of the requirement or the other).
4. **Normalise flags before comparing, and report unsorted flags** (Platypus emits `PL`, the spec wants alphabetical). Also report the `U`-with-`P` prohibition and the "single use is the absence of `L`" convention, which is easy to get backwards.
5. **Tolerate a `status` member in the manifest response** and unknown members generally.
6. **Handle expiry signalled as `410`, not only `404`**, and say which the server used.
7. **Resolve references properly**: `urn:uuid:` fullUrl, `ResourceType/id`, *and* relative-against-absolute-fullUrl-base. Then count and display unresolvable references as "not carried by this bundle" rather than as errors, because a conformant Platypus summary ships about 26 of them by design.
8. **Render the four Platypus-specific FHIR shapes correctly, and explain each**: contained `Medication` behind `medicationReference: "#id"`; the `_effectiveDateTime` primitive-extension `data-absent-reason`; display-only `Provenance` agents with no `Organization` (verbatim text, curly quotes included); and SNOMED negation concepts as positive absence statements.
9. **Offer SNOMED CT-AU** wherever codes are looked up or validated, and never report an AU code as invalid just because the International edition lacks it.
10. **Recognise and name the reply descriptor**, both dialects (`platypushealth.app` with `replyPostToken`, and `smartforms.csiro.au` with `replyToken`), and explain the ECDH-ES leg rather than choking on `alg: "ECDH-ES"`. Enumerate which descriptor fields were present. Note that no viewer can decrypt a reply, by design: only the practice's private key can.
11. **Verify SHC JWS signatures**, since Platypus does not, and say so.
12. **Sanitise every narrative `div`** before rendering; Platypus itself strips active markup and applies a CSP for received payloads.
13. **State the size caps you enforce**, because Platypus's are a hard 10 MiB with a documented 3.3 MB measured worst case, and a browser viewer can be honest about streaming where React Native cannot.
