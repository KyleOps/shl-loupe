# Fixtures: where each one came from, and what may be done with it

Everything in this directory is committed data rather than code, so it needs a
different kind of care. Two claims are made about all of it, and both are
checkable rather than asserted:

- **Nothing here is confidential.** The two implementation-guide payloads are
  published examples encrypted under the key the specification itself publishes,
  and the Platypus payloads are synthetic. That is what makes any of this safe to
  project onto a wall at a testing event.
- **Nothing here needs the network.** Every fixture carrying `content` opens with
  the cable out, which is the promise the whole tool is built on.

`index.test.ts` re-derives what it can, offline: it decrypts the committed
ciphertext with the published key and compares the result against the committed
plaintext, checks every link the catalogue ships against the same extractor and
validator the pipeline runs, and checks each sample's declared `kind` against
`classifyContent`. What it cannot check is the live links, because checking those
means a request; what it asserts about them is what their payloads SAY, which is
the part that has to be right before anybody tries them at an event. A label
nobody verifies is how a demo dies in front of a room.

## The catalogue

`index.ts` is the catalogue: an ordered list of samples, each stating what it is
(`description`) and why you would reach for it (`teaches`). The first two entries
are the live links, because they are the ones to reach for when you have ninety
seconds of somebody else's attention.

It also holds the two link strings. They are the only samples that cost a network
request, and they carry the `U` flag, so there is no manifest POST, therefore no
CORS preflight, therefore no server operator who had to think about browsers.
That, plus `raw.githubusercontent.com` sending
`Access-Control-Allow-Origin: *`, is the entire reason a static browser-only
viewer can rely on them.

## `ips-bundle.ts`: the guide's IPS example, decrypted

**What it is.** The plaintext behind the first working link on the implementation
guide's links-examples page: a FHIR `Bundle` of `type: "document"` with 20
entries, the first of which is a `Composition`.

**Provenance.** Decrypted end to end from
`https://raw.githubusercontent.com/seanno/shc-demo-data/main/ips/IPS_IG-bundle-01-enc.txt`
using the published example key, in a recorded live run (see
`research/01-shl-spec.md`, which has the observed part lengths
`[108, 0, 16, 81298, 22]` and the `kid`
`ufYGlu_C8IuzJ3HV-wQqsIv-pMm2uZm-vGy37r3hwts`).

**How it was derived.** Minified, not reformatted, and byte-checked rather than
assumed: `JSON.parse` of the 60,973 bytes of wire plaintext and
`JSON.stringify` of this constant produce the same 45,565 bytes in the same
member order. Only the whitespace the server sent is gone. The authentic bytes
stay reachable over the network, at the live link in the catalogue.

**What is odd about it.** No `meta.profile` anywhere. The guide's own IPS example
claims no IPS conformance on the wire, which makes it the right test for a viewer
that keys its layout off a profile canonical, and it is why absence of a profile
must never be read as absence of an IPS.

**Licensing.** The example content belongs to the implementation guide, whose
pages carry the standard HL7 CC0 footer (`rel="license"` pointing at
`http://hl7.org/fhir/R4/license.html`). The files themselves are served from
`seanno/shc-demo-data`, a personal repository which, checked against the GitHub
API on 20 August 2026, carries **no licence file at all**. So the guide's own
terms are permissive and the hosting repository grants nothing explicitly. The
data is synthetic demonstration content about people who do not exist, and the
whole point of an IG example is to be copied, so committing the decrypted
plaintext is reasonable. If that ever needs to be tighter, drop the constant and
keep the live link: the catalogue works with either.

## `shc-card.ts`: the guide's health-card example, both ways

**What it is.** Three constants. `IG_SHC_FILE` is the decrypted
`application/smart-health-card` file (one `verifiableCredential`, 3,777 bytes
stringified). `IG_SHC_JWE` is the same file as it is actually served: a compact
JWE with parts `[108, 0, 16, 5036, 22]`. `IG_EXAMPLE_KEY` is the published key.

**Provenance.** The guide's second working example, a CARIN insurance card, from
`https://raw.githubusercontent.com/seanno/shc-demo-data/main/cards/carin-insurance-example/jws.txt`.
Its credential's protected header is
`{"zip":"DEF","alg":"ES256","kid":"bRwVimS-ynNCUFOonJDWPpt-pjGMPNG-hgfcsTe65UU"}`,
its `iss` is `https://raw.githubusercontent.com/seanno/shc-demo-data/main`, and
its JWKS therefore sits at that URL plus `/.well-known/jwks.json`.

**Why the ciphertext is committed as well.** Most of what goes wrong in a link
goes wrong in the decrypt step, so the decrypt path has to be exercisable with
the network unplugged. Its IPS counterpart is deliberately not bundled: at 81 kB
of base64url it would nearly double what Loupe ships to demonstrate the same
three steps, and the plaintext is what a renderer needs.

**What is odd about it.** `nbf` is `1694239879.182`, a fractional number of
seconds. That is legal (a NumericDate under RFC 7519 may be non-integer), and a
verifier that parses it into an integer type rejects a card the specification
permits.

**Licensing.** As for the IPS bundle above: guide content under the HL7 CC0
footer, hosted in a repository with no licence file, synthetic demo data
throughout.

## `platypus.ts`: an Australian producer's real shape, synthesised

**What it is.** Two bundles. `PLATYPUS_AU_PS_BUNDLE` is an AU Patient Summary
document: 18 entries, a `Composition` first, nine sections in the order Platypus
writes them, one of them empty with an `emptyReason`. `PLATYPUS_COLLECTION_BUNDLE`
is the same producer choosing individual records instead: 5 entries, no
`Composition`, no profile, no `Patient` entry. `NESTED_SHLINK` is a health link
preserved inside that collection, so a viewer meets a link while already inside
one.

**Provenance.** Authored for this repository, not copied from a live share.
Built from a verified Platypus evidence run (`research/06-platypus-shl-output.md`,
read from `Platypus@767254aa`) at roughly a tenth of the size of the real
payload, which runs to about 155 kB. The codes, profile
canonicals, wordings and structural quirks are taken from that run, and the
SNOMED CT-AU codes were re-checked against the Australian edition rather than
trusted from memory. Anything deliberately invented is called out at the point it
appears.

**What is odd about it.** Ten things, listed in the file's own header, each of
which has cost somebody an afternoon: `fullUrl` and `resource.id` disagreeing, a
section code with no `display`, a mandated element stated absent in its
`_`-prefixed primitive sibling, a medication concept in a contained resource, a
SNOMED negation code standing in for "no known allergy", an `emptyReason` that
asserts nothing clinical, references to records the patient does not hold, an
asserted party carried as a display-only `Provenance` agent with curly quotes
intact, one `Provenance` targeting dozens of entries, and one deliberately
hostile narrative.

**Licensing.** Written for this repository, so it carries this project's own
terms. No patient data, real or re-identifiable, is involved: the names, dates,
identifiers and narratives are invented.

## The published example key

`IG_EXAMPLE_KEY` is `rxTgYlOaKJPFtcEd0qcceN8wEU4p94SqAwIWQe6uX7Q`: 43 characters
of base64url, being 32 real random bytes rather than a placeholder.

It is the key the specification prints in its own encryption example, and it is
therefore in the links-examples page and in every tutorial that copied either.
Both live links in the catalogue carry it, and so does `NESTED_SHLINK`.
`index.test.ts` asserts all three, because a fixture re-minted under a fresh key
would quietly turn a demonstration into a real share.

Two consequences worth stating plainly. Anything encrypted under this key is not
confidential, and a producer who shipped a real share with it has published that
share. And nothing secret is committed to this repository by shipping it: there
is no key here that was ever meant to protect anything.

## Adding a fixture

1. Say where it came from, in the file, at the top. A payload with no provenance
   cannot be checked and cannot be defended.
2. Add it to `SAMPLES` in `index.ts` with a `description` and a `teaches`. A
   sample nobody knows what to do with is one nobody opens.
3. Make its `kind` a claim the test can check. `index.test.ts` runs
   `classifyContent` over every sample's content, so a mislabelled fixture fails
   there rather than in front of a room.
4. If it is a link, it has to pass `extractShlink` and `validateShlPayload` with
   no fatal finding and no failing member. A sample that is meant to be the happy
   path and is not teaches the wrong lesson.
5. If it carries a key, it has to be a published one. Never commit a key that was
   minted to protect something.
