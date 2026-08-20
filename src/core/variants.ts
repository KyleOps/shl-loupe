/**
 * The SHL-adjacent payload families, and how to tell them apart.
 *
 * There is no single "SMART Health Link". There is one payload format (a
 * base64url JSON object with `url` and `key`) that four ecosystems reuse over
 * three mutually incompatible retrieval protocols and two different carriers.
 * A viewer that decodes the payload and then assumes the HL7 manifest POST
 * reports a WHO or IHE link as broken, which is exactly the failure this tool
 * exists to end. So identification comes first, and it is separate from
 * retrieval.
 *
 * Three rules hold this module together:
 *
 * 1. **A different profile is never "invalid".** Every variant carries a name,
 *    what it changes relative to the HL7 baseline, whether Loupe can process it
 *    end to end, and what is missing when it cannot. Nothing here returns a
 *    verdict of "broken" for a link that is simply someone else's profile.
 * 2. **Identification keys off what is observable**, and says which observation
 *    it used. Payload members (including the underscore-prefixed names the
 *    specification reserves for downstream guides), the URI scheme, the manifest
 *    entries, FHIR profiles in `meta.profile`, and CBOR/COSE framing. Where two
 *    published specifications disagree, both are reported rather than one being
 *    silently chosen (HCERT claim 5 is the live example).
 * 3. **No network, ever, from this module.** Identification runs with the cable
 *    out. Where a verdict genuinely needs a fetch (a COSE signature against a
 *    national trust list) the variant says so as a missing capability instead of
 *    quietly fetching or quietly guessing.
 */
import { bytesToBase64url, DecodeError, utf8Decode } from './bytes';
import { inflateForgiving, type CompressionFraming } from './compress';
import { decodeShlPayload, type ShlPayload } from './shlink';
import type { Citation, Severity } from './trace';

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

export type VariantId =
  | 'shl-baseline'
  | 'shl-who-phw'
  | 'shl-ktc'
  | 'shl-extension-unknown'
  | 'vhl'
  | 'vhl-vc'
  | 'hcert-shl'
  | 'hcert-vhl'
  | 'hcert-link-ambiguous'
  | 'hcert-dcc'
  | 'hcert-ddcc'
  | 'hcert-icvp'
  | 'hcert-unknown'
  | 'shc'
  | 'smart-api-access'
  | 'fhir-ips'
  | 'fhir-au-ps'
  | 'fhir-icvp'
  | 'fhir-ddcc'
  | 'fhir-c4dic'
  | 'fhir-unprofiled'
  | 'unknown';

/** The shape of the thing, which decides which pane should render it. */
export type VariantFamily =
  | 'shl' // a link payload retrieved over the SHL manifest protocol
  | 'vhl' // a link payload retrieved over the IHE FHIR List search
  | 'hcert' // an HC1: base45 COSE carrier, whatever it turns out to hold
  | 'card' // a signed SMART Health Card, which is not a link at all
  | 'content' // the payload a link resolves to
  | 'unknown';

/**
 * How far Loupe can take this variant. Stated as a capability rather than a
 * verdict, because "Loupe cannot finish this" and "this link is broken" are
 * different sentences and conflating them is the incumbent viewer's whole bug.
 */
export type VariantSupport =
  | 'full' // recognised, retrieved, decrypted and rendered
  | 'partial' // some of the path works here, the rest is named below
  | 'decode-only' // Loupe reads it and explains it, but cannot complete retrieval
  | 'unsupported'; // recognised by name only

export type RetrievalProtocol =
  | 'shl-manifest-post' // POST the url, JSON body, {files:[…]}
  | 'shl-direct-get' // U flag: GET the url, the body is the JWE
  | 'vhl-list-search' // POST [base]/List/_search, a searchset Bundle comes back
  | 'self-contained' // everything is in the payload already
  | 'unknown';

export interface Variant {
  id: VariantId;
  /** What to call it out loud at a table. */
  name: string;
  family: VariantFamily;
  /** One plain sentence: what this is. */
  summary: string;
  /**
   * What differs from the HL7 SHL STU 1 baseline. Empty means byte identical to
   * the baseline, which is a real and common answer: several "flavours" turn out
   * to be the same payload with a different governance story around it.
   */
  differences: string[];
  support: VariantSupport;
  /** What is missing when `support` is not `full`. Empty when it is. */
  missing: string[];
  protocol: RetrievalProtocol;
  citation?: Citation;
}

/** One observation, and what it licenses us to say. */
export interface VariantSignal {
  /** What was seen, quoted where quoting is possible. */
  observation: string;
  /** What it means, in one sentence, plainly. */
  meaning: string;
  /**
   * A profile difference is `info`. `warning` and `error` are reserved for
   * something genuinely wrong with the bytes, never for being a variant.
   */
  severity: Severity;
  citation?: Citation;
}

export interface VariantIdentification {
  variant: Variant;
  /** Refined per input: the `U` flag changes the protocol, for one. */
  protocol: RetrievalProtocol;
  signals: VariantSignal[];
  /** Present when an HC1: carrier was decoded, whether or not it held a link. */
  hcert?: HcertReport;
  /** The link found inside a carrier, identified in its own right. */
  inner?: VariantIdentification;
  /** Every `meta.profile` canonical seen, for a content input. */
  profiles?: string[];
}

// ---------------------------------------------------------------------------
// Citations
// ---------------------------------------------------------------------------

const SHL_SPEC = 'https://build.fhir.org/ig/HL7/smart-health-cards-and-links/links-specification.html';

const CITE = {
  extensions: {
    spec: 'SMART Health Links',
    section: 'Extensions',
    url: SHL_SPEC,
    quote:
      'The specification reserves the name, `extension`, and will never define an element with that name. Property names beginning with an underscore (`_`) are reserved for extensions defined by downstream implementation guides or specific implementations.',
  } satisfies Citation,
  ignoreUnknown: {
    spec: 'SMART Health Links',
    section: 'Extensions',
    url: SHL_SPEC,
    quote:
      'SMART Health Link Receiving Applications SHALL ignore extension properties they do not understand.',
  } satisfies Citation,
  plainShl: {
    spec: 'SMART Health Links',
    section: 'Conformance and User-Facing Identification',
    url: SHL_SPEC,
    quote:
      'The `shlink:` URI scheme SHALL only be used for Plain SHLs. Links that are not Plain SHLs SHALL use a different URI scheme.',
  } satisfies Citation,
  contentTypes: {
    spec: 'SMART Health Links',
    section: 'Manifest Response: files',
    url: SHL_SPEC,
  } satisfies Citation,
  manifestList: {
    spec: 'SMART Health Links',
    section: 'Manifest Response: list',
    url: SHL_SPEC,
    quote: 'Clients SHALL ignore FHIR extensions they do not understand.',
  } satisfies Citation,
  whoPhw: {
    spec: 'WHO GDHCN Personal Health Wallet',
    section: 'HealthLinkPayload: type',
    url: 'https://smart.who.int/trust-phw/',
    quote:
      'Classifying type code to distinguish different types of health links. If not present then the Health Link is a SMART Health Link.',
  } satisfies Citation,
  hcertContextId: {
    spec: 'WHO SMART Trust HCERT',
    section: '4.2.2 Context identifier',
    url: 'https://smart.who.int/trust/',
    quote:
      'the base45 encoded data (as per this specification) SHALL be prefixed by the Context Identifier string "HC1:".',
  } satisfies Citation,
  hcertKid: {
    spec: 'WHO SMART Trust HCERT',
    section: '3.2.3 Key identifier',
    url: 'https://smart.who.int/trust/',
    quote:
      'kid … MAY also be placed in an unprotected header if required. Verifiers MUST accept both options. If both options are present, the Key Identifier in the protected header MUST be used.',
  } satisfies Citation,
  vhlManifest: {
    spec: 'IHE Verifiable Health Links',
    section: 'Retrieve Manifest',
    url: 'https://profiles.ihe.net/ITI/VHL/',
    quote:
      'This transaction uses a standard FHIR search on the `List` resource, following the same pattern as MHD ITI-66 Find Document Lists. The manifest URL from the VHL payload contains all necessary FHIR search parameters. No custom operation is required.',
  } satisfies Citation,
  vhlCarrier: {
    spec: 'IHE Verifiable Health Links',
    section: 'Provide VHL',
    url: 'https://profiles.ihe.net/ITI/VHL/',
    quote:
      'The VHL is transmitted as a QR code containing an HCERT-encoded payload with the `HC1:` prefix, OR … as a signed W3C Verifiable Credential (`application/vc+ld+json`).',
  } satisfies Citation,
  base45: {
    spec: 'Base45',
    section: 'The Base45 encoding',
    url: 'https://datatracker.ietf.org/doc/draft-faltstrom-base45/',
    quote:
      'two bytes [a, b] MUST be interpreted as a number n in base 256 … n = (a*256) + b. This number n is converted to base 45 [c, d, e] so that n = c + (d*45) + (e*45*45).',
  } satisfies Citation,
  cwt: {
    spec: 'RFC 8392',
    section: 'CBOR Web Token (CWT) Claims',
    url: 'https://www.rfc-editor.org/rfc/rfc8392',
  } satisfies Citation,
  ips: {
    spec: 'International Patient Summary',
    section: 'Bundle profile',
    url: 'https://hl7.org/fhir/uv/ips/',
  } satisfies Citation,
} as const;

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

/**
 * Every family Loupe recognises, as data. A screen can enumerate this to teach
 * the family tree without a link in hand, and identification below only ever
 * selects from it, so a variant cannot exist with no explanation attached.
 */
export const VARIANTS: Record<VariantId, Variant> = {
  'shl-baseline': {
    id: 'shl-baseline',
    name: 'SMART Health Link (HL7 STU 1)',
    family: 'shl',
    summary:
      'The HL7 baseline: a base64url payload carrying a manifest URL and a decryption key, retrieved by POSTing the URL.',
    differences: [],
    support: 'full',
    missing: [],
    protocol: 'shl-manifest-post',
    citation: CITE.plainShl,
  },
  'shl-who-phw': {
    id: 'shl-who-phw',
    name: 'WHO Personal Health Wallet Health Link',
    family: 'shl',
    summary:
      'The WHO GDHCN Personal Health Wallet model, which adds one classifying member and otherwise reuses the HL7 payload exactly.',
    differences: [
      'A `type` member, absent from the HL7 payload, whose value here is `shl`. The WHO model defines only `shl` and `vhl`.',
      'Retrieval, encryption and the manifest are unchanged, so a baseline client that ignores unknown members opens this link normally.',
    ],
    support: 'full',
    missing: [],
    protocol: 'shl-manifest-post',
    citation: CITE.whoPhw,
  },
  'shl-ktc': {
    id: 'shl-ktc',
    name: 'KTC-profiled SMART Health Link',
    family: 'shl',
    summary:
      'A downstream profile of the same payload that tightens what the server must do, notably requiring a permissive CORS policy so a browser can read the payload at all.',
    differences: [
      'The payload is the HL7 payload, byte for byte. KTC constrains the server, not the link.',
      'KTC requires `Access-Control-Allow-Origin: *` on the retrieval endpoint, which the base specification never mentions.',
      'KTC states the extraction rule the base specification leaves implicit: a receiver accepts both the bare `shlink:/` form and a viewer-prefixed URL by extracting the `shlink:/` substring.',
    ],
    support: 'full',
    missing: [],
    protocol: 'shl-manifest-post',
  },
  'shl-extension-unknown': {
    id: 'shl-extension-unknown',
    name: 'SMART Health Link with an unrecognised extension',
    family: 'shl',
    summary:
      'A baseline link carrying a member no specification Loupe knows about. The specification requires receivers to ignore it, so the link still opens.',
    differences: [
      'One or more members outside the six the specification defines. That is legal: `extension` is reserved for downstream guides, and so is any name beginning with an underscore.',
    ],
    support: 'full',
    missing: [],
    protocol: 'shl-manifest-post',
    citation: CITE.extensions,
  },
  vhl: {
    id: 'vhl',
    name: 'IHE Verifiable Health Link',
    family: 'vhl',
    summary:
      'The same payload members, but the `url` is a FHIR search rather than an SHL manifest endpoint, and the request is authenticated.',
    differences: [
      'Retrieval is a FHIR `POST [base]/List/_search` with a form-encoded body, returning a searchset Bundle of `List` and `DocumentReference`, not an SHL manifest POST returning `{files:[…]}`.',
      'Documents are then fetched from `DocumentReference.content.attachment.url` and decrypted with the payload key using the same JWE `dir` and `A256GCM` convention.',
      'The request must be authenticated: an HTTP Message Signature (RFC 9421), OAuth with SSRAA, or a self-issued JSON-LD Verifiable Credential.',
      'The payload uses the `extension` slot the SHL specification reserves, and the URI scheme is `vhlink:` rather than `shlink:`.',
    ],
    support: 'decode-only',
    missing: [
      'A trust-network credential. Signing an RFC 9421 request or an SSRAA client assertion needs a private key issued by the trust network, which a static browser page does not hold and should not hold.',
      'Loupe therefore prints the `List/_search` request it would issue, and stops there.',
    ],
    protocol: 'vhl-list-search',
    citation: CITE.vhlManifest,
  },
  'vhl-vc': {
    id: 'vhl-vc',
    name: 'Verifiable Health Link as a W3C Verifiable Credential',
    family: 'vhl',
    summary:
      'The IHE VHL payload wrapped in a signed JSON-LD Verifiable Credential (`application/vc+ld+json`) instead of a QR.',
    differences: [
      'The link payload sits under `credentialSubject` rather than being base64url encoded behind a URI scheme.',
      'Integrity comes from an embedded `DataIntegrityProof`, not from a COSE signature.',
      'Retrieval, once the payload is out, is the same authenticated FHIR `List/_search` as any other VHL.',
    ],
    support: 'decode-only',
    missing: [
      'Proof verification. A `DataIntegrityProof` is computed over JSON-LD canonicalised input, which needs a canonicalisation library and context resolution Loupe does not carry.',
      'The same trust-network credential every VHL retrieval needs.',
    ],
    protocol: 'vhl-list-search',
    citation: CITE.vhlCarrier,
  },
  'hcert-shl': {
    id: 'hcert-shl',
    name: 'WHO GDHCN certificate carrying a SMART Health Link',
    family: 'hcert',
    summary:
      'An HC1: QR: base45, then zlib, then a COSE-signed CWT, whose health-link claim holds an ordinary `shlink:/` URI.',
    differences: [
      'The carrier is a signed certificate, not the link text. The link is claim 5 of the HCERT claim (CWT claim -260).',
      'The certificate is signed with COSE_Sign1 (ES256, or PS256 as the secondary algorithm) by a national document signing certificate.',
      'Once unwrapped, the inner link is an ordinary SMART Health Link and follows the baseline manifest protocol.',
    ],
    support: 'partial',
    missing: [
      'Signature verification. Checking the COSE_Sign1 needs the signing certificate for this `kid` from a trust list, which Loupe does not fetch.',
    ],
    protocol: 'shl-manifest-post',
    citation: CITE.hcertContextId,
  },
  'hcert-vhl': {
    id: 'hcert-vhl',
    name: 'IHE Verifiable Health Link in an HC1: certificate',
    family: 'hcert',
    summary:
      'An HC1: QR whose health-link claim holds a `vhlink:/` URI, so the retrieval protocol is the FHIR List search, not the SHL manifest POST.',
    differences: [
      'The carrier is a COSE-signed CWT, as for any HCERT.',
      'The inner link is an IHE VHL, so retrieval is an authenticated FHIR `List/_search`.',
    ],
    support: 'decode-only',
    missing: [
      'Signature verification, which needs the signing certificate for this `kid` from a trust list Loupe does not fetch.',
      'A trust-network credential for the retrieval itself, which a browser page cannot hold.',
    ],
    protocol: 'vhl-list-search',
    citation: CITE.vhlCarrier,
  },
  'hcert-link-ambiguous': {
    id: 'hcert-link-ambiguous',
    name: 'HC1: certificate carrying a link with no scheme',
    family: 'hcert',
    summary:
      'The health-link claim holds a bare base64url payload with neither an `shlink:` nor a `vhlink:` prefix, so the retrieval protocol is not stated in band.',
    differences: [
      'The prefix is the only in-band signal of which retrieval protocol applies, and it is absent here.',
      'The published specifications disagree about this slot: the normative HCERT text titles claim 5 "Smart Health Link", while the WHO logical model and IHE ITI VHL both call it a Verifiable Health Link.',
    ],
    support: 'partial',
    missing: [
      'A statement of which protocol to use. Loupe reads the payload and shows both candidate protocols rather than picking one, since a wrong guess spends a request against the wrong endpoint.',
      'Signature verification, which needs a trust list Loupe does not fetch.',
    ],
    protocol: 'unknown',
    citation: CITE.hcertContextId,
  },
  'hcert-dcc': {
    id: 'hcert-dcc',
    name: 'EU Digital COVID Certificate (HCERT DCC)',
    family: 'hcert',
    summary:
      'A self-contained vaccination, test or recovery certificate in the EU DCC shape, carried at HCERT subclaim 1. There is no link in it.',
    differences: [
      'Nothing is retrieved: the whole payload is inside the QR, so there is no manifest, no JWE and no decryption key.',
      'The subject data sits in CBOR under the HCERT claim rather than in FHIR.',
    ],
    support: 'partial',
    missing: [
      'A rendering of the certificate subject. Loupe reads the CWT claims (issuer, issued at, expiry, key identifier) and names the subclaim, but does not lay out the vaccination or test detail.',
      'Signature verification, which needs the issuing country’s document signing certificate. There is no single public, CORS-open source for every national list, so a browser page cannot resolve this in general.',
    ],
    protocol: 'self-contained',
    citation: CITE.cwt,
  },
  'hcert-ddcc': {
    id: 'hcert-ddcc',
    name: 'WHO DDCC vaccination status or test result',
    family: 'hcert',
    summary:
      'A WHO Digital Documentation of COVID-19 Certificates payload at HCERT subclaim 3 (vaccination status) or 4 (test result), self-contained in the QR.',
    differences: [
      'Nothing is retrieved: the payload is the certificate.',
      'The claim shape is WHO DDCC rather than the EU DCC at subclaim 1.',
    ],
    support: 'partial',
    missing: [
      'A rendering of the certificate subject. Loupe reads the CWT claims and names the subclaim.',
      'Signature verification against a GDHCN document signing certificate, which Loupe does not fetch.',
    ],
    protocol: 'self-contained',
    citation: CITE.cwt,
  },
  'hcert-icvp': {
    id: 'hcert-icvp',
    name: 'ICVP minimal vaccination certificate (DVCMin)',
    family: 'hcert',
    summary:
      'The International Certificate of Vaccination or Prophylaxis carrier: a heavily abbreviated CBOR record at HCERT subclaim -6, sized to fit a QR.',
    differences: [
      'Field names are abbreviated for QR size (`n`, `dob`, `s`, `nt`, `id`, `dt`, `gn`, `vx`, `v`), not FHIR element names.',
      'The subclaim is negative, and WHO reserves subclaims of zero and above while leaving negative ones free for development, so this carrier is still a development payload by WHO’s own rule.',
    ],
    support: 'partial',
    missing: [
      'A rendering of the abbreviated record. Loupe reads the CWT claims and names the subclaim.',
      'Signature verification against a GDHCN document signing certificate, which Loupe does not fetch.',
    ],
    protocol: 'self-contained',
    citation: CITE.cwt,
  },
  'hcert-unknown': {
    id: 'hcert-unknown',
    name: 'HC1: certificate with an unrecognised claim',
    family: 'hcert',
    summary:
      'The HC1: carrier decoded, but the HCERT claim holds a subclaim Loupe has no profile for.',
    differences: [
      'The carrier is standard: base45, zlib, COSE_Sign1 over a CWT.',
      'The content is whatever the issuing programme put in that subclaim.',
    ],
    support: 'partial',
    missing: [
      'A profile for this subclaim. Loupe reports the carrier, the CWT claims and the subclaim number, which is enough to ask the issuer what it is.',
      'Signature verification, which needs a trust list Loupe does not fetch.',
    ],
    protocol: 'unknown',
    citation: CITE.hcertContextId,
  },
  shc: {
    id: 'shc',
    name: 'SMART Health Card',
    family: 'card',
    summary:
      'A signed, self-contained credential, not a link. Nothing is retrieved and nothing is decrypted: the card carries its own FHIR content in a JWS.',
    differences: [
      'There is no manifest, no encryption key and no sharing server. A card is verified, not fetched.',
      'Integrity comes from an ES256 signature over a compressed payload, and the issuer’s key comes from a JWKS at its `iss`.',
      'The QR form is numeric (`shc:/` followed by digit pairs), where an SHL QR is just the URI text.',
    ],
    support: 'full',
    missing: [],
    protocol: 'self-contained',
  },
  'smart-api-access': {
    id: 'smart-api-access',
    name: 'SMART API access file',
    family: 'content',
    summary:
      'One of the three content types the baseline allows a manifest to serve: an access token and endpoint for a FHIR API, rather than clinical data.',
    differences: [],
    support: 'full',
    missing: [],
    protocol: 'self-contained',
    citation: CITE.contentTypes,
  },
  'fhir-ips': {
    id: 'fhir-ips',
    name: 'International Patient Summary',
    family: 'content',
    summary: 'A FHIR document Bundle claiming the IPS profile.',
    differences: [],
    support: 'full',
    missing: [],
    protocol: 'self-contained',
    citation: CITE.ips,
  },
  'fhir-au-ps': {
    id: 'fhir-au-ps',
    name: 'AU Patient Summary',
    family: 'content',
    summary:
      'The Australian patient summary: IPS-derived, over AU Core, and the payload the Sparked connectathon links carry.',
    differences: [
      'Nothing about the link changes. AU PS is a content profile, so an Australian summary travels as a plain HL7 SMART Health Link.',
      'AU PS tightens elements IPS and AU Core leave optional, so a resource can be AU Core conformant and AU PS invalid.',
    ],
    support: 'full',
    missing: [],
    protocol: 'self-contained',
  },
  'fhir-icvp': {
    id: 'fhir-icvp',
    name: 'ICVP patient summary bundle',
    family: 'content',
    summary: 'An IPS-profiled Bundle carrying an International Certificate of Vaccination or Prophylaxis.',
    differences: [],
    support: 'full',
    missing: [],
    protocol: 'self-contained',
  },
  'fhir-ddcc': {
    id: 'fhir-ddcc',
    name: 'DDCC document bundle',
    family: 'content',
    summary: 'A FHIR Bundle claiming a WHO DDCC profile.',
    differences: [],
    support: 'full',
    missing: [],
    protocol: 'self-contained',
  },
  'fhir-c4dic': {
    id: 'fhir-c4dic',
    name: 'CARIN digital insurance card',
    family: 'content',
    summary:
      'Coverage, Patient and Organization profiled by CARIN C4DIC, shared as a SMART Health Card behind a SMART Health Link.',
    differences: [
      'A C4DIC link is deliberately passcode free and long lived: the guide says a payer SHALL NOT require a passcode and SHALL NOT populate the `P` flag by default.',
      'So an insurance card link with no passcode is conformant by design, and worth labelling rather than warning about.',
    ],
    support: 'full',
    missing: [],
    protocol: 'self-contained',
  },
  'fhir-unprofiled': {
    id: 'fhir-unprofiled',
    name: 'FHIR content with no profile claimed',
    family: 'content',
    summary: 'FHIR that stamps no `meta.profile`, so what it conforms to has to be judged structurally.',
    differences: [],
    support: 'full',
    missing: [],
    protocol: 'self-contained',
  },
  unknown: {
    id: 'unknown',
    name: 'Not recognised',
    family: 'unknown',
    summary:
      'Loupe could not match this against any payload family it knows. That is a gap in Loupe, not a verdict on the content.',
    differences: [],
    support: 'unsupported',
    missing: [
      'A recognisable marker. Loupe looked for an `shlink:`, `vhlink:` or `shc:` scheme, an `HC1:` certificate, an SHL payload or manifest shape, a Verifiable Credential envelope and a FHIR resource.',
    ],
    protocol: 'unknown',
  },
};

export const SUPPORT_LABEL: Record<VariantSupport, string> = {
  full: 'Loupe processes this fully',
  partial: 'Loupe processes part of this',
  'decode-only': 'Loupe reads it, cannot retrieve it',
  unsupported: 'Recognised by name only',
};

export const PROTOCOL_LABEL: Record<RetrievalProtocol, string> = {
  'shl-manifest-post': 'SHL manifest POST',
  'shl-direct-get': 'Direct GET of one encrypted file (U flag)',
  'vhl-list-search': 'FHIR POST [base]/List/_search',
  'self-contained': 'Nothing to retrieve',
  unknown: 'Not stated in the payload',
};

export const FAMILY_LABEL: Record<VariantFamily, string> = {
  shl: 'SMART Health Link',
  vhl: 'Verifiable Health Link',
  hcert: 'HC1 health certificate',
  card: 'SMART Health Card',
  content: 'Payload content',
  unknown: 'Unrecognised',
};

// ---------------------------------------------------------------------------
// Base45
// ---------------------------------------------------------------------------

/** The alphabet in value order. Index is the digit value. */
const BASE45 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

/**
 * The free diagnostic: two structural facts decide whether a string can be
 * base45 at all, before any decoding is attempted. Three characters carry two
 * bytes and two carry one, so a length whose remainder modulo 3 is 1 is
 * impossible, which catches a truncated QR scan instantly.
 */
export function base45Complaint(value: string): string | undefined {
  for (const character of value) {
    if (!BASE45.includes(character)) {
      return `The character ${JSON.stringify(character)} is not in the Base45 alphabet. Base45 has no lowercase letters, so a lowercase character usually means something downcased the QR text on its way here.`;
    }
  }
  if (value.length % 3 === 1) {
    return `A Base45 string cannot be ${value.length} characters long. Three characters carry two bytes and two characters carry one, so the length divided by three leaves 0 or 2, never 1. This string lost its tail.`;
  }
  return undefined;
}

export function base45Decode(value: string): Uint8Array {
  const complaint = base45Complaint(value);
  if (complaint !== undefined) throw new DecodeError('This is not valid Base45.', complaint);

  const out: number[] = [];
  for (let i = 0; i < value.length; i += 3) {
    const c = BASE45.indexOf(value[i] as string);
    const d = BASE45.indexOf(value[i + 1] as string);
    if (i + 2 < value.length) {
      const e = BASE45.indexOf(value[i + 2] as string);
      // Little-endian by digit: the leftmost character is the least significant.
      const n = c + d * 45 + e * 45 * 45;
      if (n > 0xffff) {
        throw new DecodeError(
          'This is not valid Base45.',
          `The group ${JSON.stringify(value.slice(i, i + 3))} decodes to ${n}, which does not fit in the two bytes a three-character group carries.`,
        );
      }
      out.push(n >> 8, n & 0xff);
    } else {
      const n = c + d * 45;
      if (n > 0xff) {
        throw new DecodeError(
          'This is not valid Base45.',
          `The final group ${JSON.stringify(value.slice(i))} decodes to ${n}, which does not fit in the single byte a two-character group carries.`,
        );
      }
      out.push(n);
    }
  }
  return new Uint8Array(out);
}

/** The inverse, so a fixture can be minted and a decoder tested both ways. */
export function base45Encode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 2) {
    if (i + 1 < bytes.length) {
      const n = (bytes[i] as number) * 256 + (bytes[i + 1] as number);
      out += (BASE45[n % 45] as string) + (BASE45[Math.floor(n / 45) % 45] as string) + (BASE45[Math.floor(n / 2025)] as string);
    } else {
      const n = bytes[i] as number;
      out += (BASE45[n % 45] as string) + (BASE45[Math.floor(n / 45)] as string);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// CBOR, only as much as COSE and CWT need
// ---------------------------------------------------------------------------

export interface CborTag {
  tag: number;
  value: CborValue;
}

export type CborValue =
  | number
  | bigint
  | string
  | Uint8Array
  | boolean
  | null
  | undefined
  | CborValue[]
  | Map<number | string, CborValue>
  | CborTag;

/**
 * A deliberately small reader: definite lengths only, which is what canonical
 * CBOR (and therefore every HCERT in the wild) uses. Adding a dependency for
 * this would pull a full CBOR codec into a page whose whole promise is that it
 * loads nothing, and the failure modes we need to report are exactly the ones a
 * generic codec collapses into "unexpected end of input".
 */
class CborReader {
  private offset = 0;

  constructor(private readonly bytes: Uint8Array) {}

  get consumed(): number {
    return this.offset;
  }

  read(): CborValue {
    const initial = this.byte();
    const major = initial >> 5;
    const info = initial & 0x1f;

    if (info === 31) {
      throw new DecodeError(
        'This CBOR uses an indefinite length, which Loupe does not read.',
        'HCERT payloads are canonical CBOR, where every length is definite. An indefinite length means this was produced by a non-canonical encoder.',
      );
    }
    if (info > 27) {
      throw new DecodeError(`CBOR additional information ${info} is reserved and has no meaning.`);
    }

    switch (major) {
      case 0:
        return this.argument(info);
      case 1: {
        const argument = this.argument(info);
        return typeof argument === 'bigint' ? -1n - argument : -1 - argument;
      }
      case 2:
        return this.take(this.length(info));
      case 3:
        return utf8Decode(this.take(this.length(info)));
      case 4: {
        const count = this.length(info);
        const items: CborValue[] = [];
        for (let i = 0; i < count; i += 1) items.push(this.read());
        return items;
      }
      case 5: {
        const count = this.length(info);
        const map = new Map<number | string, CborValue>();
        for (let i = 0; i < count; i += 1) {
          const key = this.read();
          if (typeof key !== 'number' && typeof key !== 'string') {
            throw new DecodeError(
              `A CBOR map key of type ${key === null ? 'null' : typeof key} is not something Loupe indexes.`,
              'COSE and CWT use integer labels and text keys only.',
            );
          }
          map.set(key, this.read());
        }
        return map;
      }
      case 6: {
        const tag = this.argument(info);
        return { tag: Number(tag), value: this.read() };
      }
      default:
        return this.simple(info);
    }
  }

  private simple(info: number): CborValue {
    switch (info) {
      case 20:
        return false;
      case 21:
        return true;
      case 22:
        return null;
      case 23:
        return undefined;
      case 25:
        return float16(Number(this.unsigned(2)));
      case 26:
        return new DataView(this.take(4).buffer).getFloat32(0, false);
      case 27:
        return new DataView(this.take(8).buffer).getFloat64(0, false);
      default:
        // A simple value with no assigned meaning. Reported rather than dropped:
        // silently returning undefined would make a malformed header look empty.
        throw new DecodeError(`CBOR simple value ${info} has no assigned meaning.`);
    }
  }

  private argument(info: number): number | bigint {
    if (info < 24) return info;
    return this.unsigned(1 << (info - 24));
  }

  private length(info: number): number {
    const value = this.argument(info);
    if (typeof value === 'bigint') {
      throw new DecodeError('This CBOR declares a length larger than anything a browser can hold.');
    }
    return value;
  }

  private unsigned(width: number): number | bigint {
    let value = 0n;
    for (let i = 0; i < width; i += 1) value = (value << 8n) | BigInt(this.byte());
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
  }

  private byte(): number {
    if (this.offset >= this.bytes.byteLength) {
      throw new DecodeError(
        'This CBOR ends in the middle of a value.',
        `It is ${this.bytes.byteLength} bytes long, and a value was still being read at the end.`,
      );
    }
    const value = this.bytes[this.offset] as number;
    this.offset += 1;
    return value;
  }

  private take(length: number): Uint8Array {
    if (this.offset + length > this.bytes.byteLength) {
      throw new DecodeError(
        'This CBOR declares more bytes than it contains.',
        `A ${length} byte string starts at offset ${this.offset}, but the data is only ${this.bytes.byteLength} bytes long.`,
      );
    }
    // Copied rather than sub-viewed: a DataView over a shared buffer offset is a
    // reliable source of off-by-one bugs, and these payloads are tiny.
    const out = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return out;
  }
}

function float16(raw: number): number {
  const sign = (raw & 0x8000) === 0 ? 1 : -1;
  const exponent = (raw >> 10) & 0x1f;
  const fraction = raw & 0x3ff;
  if (exponent === 0) return sign * Math.pow(2, -24) * fraction;
  if (exponent === 0x1f) return fraction === 0 ? sign * Infinity : Number.NaN;
  return sign * Math.pow(2, exponent - 25) * (1024 + fraction);
}

/** Decode exactly one CBOR item, and complain about anything after it. */
export function decodeCbor(bytes: Uint8Array): CborValue {
  const reader = new CborReader(bytes);
  const value = reader.read();
  if (reader.consumed !== bytes.byteLength) {
    throw new DecodeError(
      'This CBOR has trailing bytes after the first item.',
      `${bytes.byteLength - reader.consumed} bytes were left over. A COSE_Sign1 is a single item.`,
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// HCERT
// ---------------------------------------------------------------------------

/**
 * Every context identifier the HCERT specification reserves, not just `HC1`:
 * "the character following "HC" SHALL be taken from the character set [1-9A-Z]".
 * Matching only `HC1:` means a future version is reported as unrecognised text.
 */
const HCERT_PREFIX = /^(HC[1-9A-Z]):(.*)$/s;

/** HCERT subclaims, from the WHO HCert logical model. */
export const HCERT_SUBCLAIMS: Record<number, string> = {
  1: 'EU Digital COVID Certificate (HCertDCC)',
  3: 'DDCC vaccination status',
  4: 'DDCC test result',
  5: 'health link',
  [-6]: 'DVCMin, the minimal ICVP certificate',
  [-7]: 'MedicationTreatmentLineMin (PH4H)',
};

/** COSE algorithm labels HCERT requires an implementation to support. */
const COSE_ALGORITHMS: Record<number, string> = {
  [-7]: 'ES256 (ECDSA P-256 with SHA-256)',
  [-37]: 'PS256 (RSASSA-PSS with SHA-256)',
};

export interface HcertCose {
  /** The CBOR tag wrapping the COSE_Sign1, when one was present. 18 normally. */
  tag?: number;
  algorithmLabel?: number;
  algorithm?: string;
  /**
   * Standard base64 WITH padding, because that is how the GDHCN trust list
   * publishes it. Comparing a base64url form against the list silently never
   * matches, which is why both forms are here and labelled.
   */
  kidBase64?: string;
  kidBase64url?: string;
  kidFrom?: 'protected header' | 'unprotected header';
  signatureBytes?: number;
}

export interface HcertCwt {
  /** CWT claim 1. An ISO 3166-1 alpha-2 country code when it is populated. */
  issuer?: string;
  issuerName?: string;
  /** CWT claim 4, epoch seconds. */
  expiry?: number;
  /** CWT claim 6, epoch seconds. */
  issuedAt?: number;
}

export interface HcertLink {
  uri: string;
  /** Which scheme claim 5 actually carried. The only in-band protocol signal. */
  scheme: 'shlink' | 'vhlink' | 'none';
}

export interface HcertReport {
  /** `HC1` and so on, verbatim. */
  contextId: string;
  base45Characters: number;
  compression?: CompressionFraming;
  decodedBytes?: number;
  cose: HcertCose;
  cwt: HcertCwt;
  /** HCERT subclaim keys found under CWT claim -260, in the order seen. */
  subclaims: number[];
  link?: HcertLink;
  /**
   * What went wrong, in order. Collected rather than thrown: a certificate that
   * decodes as far as its claims and then fails is still worth showing, and a
   * half-decoded certificate is the most useful thing a debugger can print.
   */
  problems: string[];
}

/**
 * Unwrap an `HC1:` string as far as it will go, reporting rather than throwing.
 *
 * Returns undefined only when the string has no context identifier at all, so
 * the caller can tell "not an HCERT" from "an HCERT that did not decode".
 */
export function decodeHcert(input: string): HcertReport | undefined {
  // QR text arrives with whitespace from a scanner or a copy and paste. Base45
  // has a space in its alphabet, so only the ends can be trimmed safely.
  const match = HCERT_PREFIX.exec(input.trim());
  if (match === null) return undefined;
  const contextId = match[1] as string;
  const body = match[2] as string;

  const report: HcertReport = {
    contextId,
    base45Characters: body.length,
    cose: {},
    cwt: {},
    subclaims: [],
    problems: [],
  };

  let compressed: Uint8Array;
  try {
    compressed = base45Decode(body);
  } catch (error) {
    report.problems.push(describeError(error));
    return report;
  }

  let cbor: Uint8Array;
  try {
    // HCERT requires zlib (RFC 1950), which is NOT the raw DEFLATE the JOSE
    // `zip` parameter uses. The shared helper tries raw first and reports the
    // framing it found, so the framing is recorded here and judged against the
    // HCERT rule rather than against the JOSE one the helper's own wording
    // assumes.
    const inflated = inflateForgiving(compressed);
    cbor = inflated.bytes;
    report.compression = inflated.framing;
    report.decodedBytes = inflated.bytes.byteLength;
    if (inflated.framing !== 'zlib') {
      report.problems.push(
        `The certificate body is ${inflated.framing} framed. HCERT requires zlib (RFC 1950) here, so a strict verifier will reject this even though Loupe read it.`,
      );
    }
  } catch (error) {
    report.problems.push(
      `The Base45 decoded to ${compressed.byteLength} bytes, but they are not compressed in any framing Loupe recognises. ${describeError(error)}`,
    );
    return report;
  }

  let cose: CborValue;
  try {
    cose = decodeCbor(cbor);
  } catch (error) {
    report.problems.push(describeError(error));
    return report;
  }

  let signStructure = cose;
  if (isTag(cose)) {
    report.cose.tag = cose.tag;
    signStructure = cose.value;
    if (cose.tag !== 18) {
      report.problems.push(
        `The CBOR tag is ${cose.tag}, where a COSE_Sign1 is tag 18. Loupe read the contents anyway.`,
      );
    }
  }

  if (!Array.isArray(signStructure) || signStructure.length !== 4) {
    report.problems.push(
      'This is not a COSE_Sign1. That structure is an array of four items: the protected header, the unprotected header, the payload and the signature.',
    );
    return report;
  }

  const [protectedBytes, unprotected, payloadBytes, signature] = signStructure;
  if (signature instanceof Uint8Array) report.cose.signatureBytes = signature.byteLength;

  // The protected header is a byte string wrapping its own CBOR map, and its
  // bytes are part of the signed input, which is why it travels this way.
  if (protectedBytes instanceof Uint8Array && protectedBytes.byteLength > 0) {
    try {
      const header = decodeCbor(protectedBytes);
      if (isMap(header)) readCoseHeader(header, report, 'protected header');
    } catch (error) {
      report.problems.push(`The protected header did not decode. ${describeError(error)}`);
    }
  }
  // Only consult the unprotected header for what the protected one did not
  // carry: the specification says the protected `kid` wins when both are set.
  if (isMap(unprotected)) readCoseHeader(unprotected, report, 'unprotected header');

  if (!(payloadBytes instanceof Uint8Array)) {
    report.problems.push('The COSE payload is not a byte string, so there is no CWT to read.');
    return report;
  }

  let cwt: CborValue;
  try {
    cwt = decodeCbor(payloadBytes);
  } catch (error) {
    report.problems.push(`The CWT did not decode. ${describeError(error)}`);
    return report;
  }
  if (!isMap(cwt)) {
    report.problems.push('The COSE payload decoded, but it is not a CWT claims map.');
    return report;
  }

  const issuer = cwt.get(1);
  if (typeof issuer === 'string') {
    report.cwt.issuer = issuer;
    const name = regionName(issuer);
    if (name !== undefined) report.cwt.issuerName = name;
  }
  const expiry = cwt.get(4);
  if (typeof expiry === 'number') report.cwt.expiry = expiry;
  const issuedAt = cwt.get(6);
  if (typeof issuedAt === 'number') report.cwt.issuedAt = issuedAt;

  const hcert = cwt.get(-260);
  if (!isMap(hcert)) {
    report.problems.push(
      'There is no HCERT claim (CWT claim -260), so this CWT carries no health certificate content.',
    );
    return report;
  }
  for (const key of hcert.keys()) {
    if (typeof key === 'number') report.subclaims.push(key);
  }

  const five = hcert.get(5);
  if (typeof five === 'string') {
    report.link = { uri: five, scheme: linkScheme(five) };
  } else if (hcert.has(5)) {
    report.problems.push('The health-link claim is present but is not a string.');
  }

  return report;
}

function readCoseHeader(
  header: Map<number | string, CborValue>,
  report: HcertReport,
  from: 'protected header' | 'unprotected header',
): void {
  const alg = header.get(1);
  if (typeof alg === 'number' && report.cose.algorithmLabel === undefined) {
    report.cose.algorithmLabel = alg;
    report.cose.algorithm = COSE_ALGORITHMS[alg] ?? `algorithm ${alg}, which HCERT does not name`;
  }
  const kid = header.get(4);
  if (kid instanceof Uint8Array && report.cose.kidBase64 === undefined) {
    report.cose.kidBase64 = bytesToBase64(kid);
    report.cose.kidBase64url = bytesToBase64url(kid);
    report.cose.kidFrom = from;
  }
}

function linkScheme(uri: string): HcertLink['scheme'] {
  if (/^shlink:\/{1,2}/i.test(uri)) return 'shlink';
  if (/^vhlink:\/{1,2}/i.test(uri)) return 'vhlink';
  return 'none';
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function regionName(code: string): string | undefined {
  if (!/^[A-Za-z]{2}$/.test(code)) return undefined;
  try {
    // Present in every browser this tool targets and in Node's full ICU build,
    // and it is local: no list is fetched, no data is added to the bundle.
    const display = new Intl.DisplayNames(['en'], { type: 'region' }).of(code.toUpperCase());
    return display === undefined || display.toUpperCase() === code.toUpperCase() ? undefined : display;
  } catch {
    return undefined;
  }
}

function describeError(error: unknown): string {
  if (error instanceof DecodeError) {
    return error.hint === undefined ? error.message : `${error.message} ${error.hint}`;
  }
  return error instanceof Error ? error.message : String(error);
}

function isMap(value: CborValue): value is Map<number | string, CborValue> {
  return value instanceof Map;
}

function isTag(value: CborValue): value is CborTag {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && 'tag' in value;
}

// ---------------------------------------------------------------------------
// Retrieval protocol
// ---------------------------------------------------------------------------

/**
 * A payload whose `url` is a FHIR List search is an IHE VHL even with no `type`
 * member, and saying so up front is what stops an engineer debugging a manifest
 * POST that was never going to work.
 */
export function impliedProtocol(payload: ShlPayload): RetrievalProtocol {
  const type = typeof payload.type === 'string' ? payload.type.toLowerCase() : undefined;
  if (type === 'vhl') return 'vhl-list-search';
  const url = typeof payload.url === 'string' ? payload.url : '';
  if (/\/List\/_search|[?&]_id=|[?&]code=folder/.test(url)) return 'vhl-list-search';
  const flag = typeof payload.flag === 'string' ? payload.flag.toUpperCase() : '';
  if (flag.includes('U')) return 'shl-direct-get';
  return 'shl-manifest-post';
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

/**
 * Matched by canonical PREFIX, not by exact profile URL. The slug of a bundle
 * profile changes between IG releases while the canonical base does not, and a
 * family match on the base is right for every resource in the guide.
 */
const PROFILE_FAMILIES: Array<{ prefix: string; id: VariantId }> = [
  // Most specific first: AU PS and ICVP are both IPS-derived, so an IPS prefix
  // match must not win over them.
  { prefix: 'http://hl7.org.au/fhir/ps/', id: 'fhir-au-ps' },
  { prefix: 'http://smart.who.int/icvp/', id: 'fhir-icvp' },
  { prefix: 'http://smart.who.int/ddcc/', id: 'fhir-ddcc' },
  { prefix: 'http://hl7.org/fhir/us/insurance-card/', id: 'fhir-c4dic' },
  { prefix: 'http://hl7.org/fhir/uv/ips/', id: 'fhir-ips' },
];

/** Prefixes worth naming that are not themselves a payload family. */
const NOTED_PROFILES: Array<{ prefix: string; note: string }> = [
  {
    prefix: 'http://hl7.org.au/fhir/core/',
    note: 'AU Core, the Australian base profile set. AU Core profiles individual resources, so it says nothing about which summary profile the bundle claims.',
  },
  {
    prefix: 'http://smart.who.int/trust-phw/',
    note: 'The WHO GDHCN Personal Health Wallet model, which is the lineage the `type` member comes from.',
  },
  {
    prefix: 'https://profiles.ihe.net/ITI/VHL/',
    note: 'The IHE Verifiable Health Links profile, whose payload the WHO model shares.',
  },
];

function collectProfiles(value: unknown, depth = 0): string[] {
  if (typeof value !== 'object' || value === null || depth > 3) return [];
  const record = value as Record<string, unknown>;
  const found: string[] = [];
  const meta = record.meta;
  if (typeof meta === 'object' && meta !== null) {
    const profile = (meta as Record<string, unknown>).profile;
    if (Array.isArray(profile)) {
      for (const entry of profile) if (typeof entry === 'string') found.push(entry);
    }
  }
  // A document Bundle usually stamps the profile on its Composition rather than
  // on the Bundle, and the IG's own IPS example stamps neither, so both are read.
  const entries = record.entry;
  if (Array.isArray(entries)) {
    for (const entry of entries.slice(0, 5)) {
      if (typeof entry === 'object' && entry !== null) {
        found.push(...collectProfiles((entry as Record<string, unknown>).resource, depth + 1));
      }
    }
  }
  return [...new Set(found)];
}

// ---------------------------------------------------------------------------
// Identification
// ---------------------------------------------------------------------------

export type VariantInput =
  | string
  | { kind: 'raw'; text: string }
  | { kind: 'payload'; payload: ShlPayload }
  | { kind: 'manifest'; manifest: unknown }
  | { kind: 'content'; content: unknown; declaredContentType?: string };

const SPEC_MEMBERS = ['url', 'key', 'exp', 'flag', 'label', 'v'];
const ALLOWED_CONTENT_TYPES = [
  'application/smart-health-card',
  'application/smart-api-access',
  'application/fhir+json',
];

/**
 * Name the family. Never a verdict: an unrecognised payload is reported as a gap
 * in Loupe's catalogue, and a different profile is reported as a different
 * profile.
 */
export function identifyVariant(input: VariantInput): VariantIdentification {
  const request = typeof input === 'string' ? { kind: 'raw' as const, text: input } : input;
  switch (request.kind) {
    case 'raw':
      return identifyRaw(request.text);
    case 'payload':
      return identifyPayload(request.payload, []);
    case 'manifest':
      return identifyManifest(request.manifest);
    default:
      return identifyContent(request.content, request.declaredContentType);
  }
}

function identifyRaw(text: string): VariantIdentification {
  const trimmed = text.trim();
  // A viewer prefix ends at the last '#', which is where the specification puts
  // the payload. Splitting there also strips the path form the IG's own examples
  // use (https://viewer.example/shlink.html#shlink:/…).
  const hash = trimmed.lastIndexOf('#');
  const body = hash >= 0 ? trimmed.slice(hash + 1) : trimmed;

  if (/^shc:\/[\d\s/]+$/.test(body)) {
    return {
      variant: VARIANTS.shc,
      protocol: 'self-contained',
      signals: [
        {
          observation: 'The input starts with `shc:/` and continues in digits.',
          meaning:
            'This is a SMART Health Card, not a SMART Health Link. A card carries its own signed content, so there is no manifest to fetch and no key to decrypt with.',
          severity: 'info',
        },
      ],
    };
  }

  const hcert = decodeHcert(body);
  if (hcert !== undefined) return identifyHcert(hcert);

  const scheme = /^(shlink|vhlink|ktclink):\/{1,2}([A-Za-z0-9_-]+)/i.exec(body);
  if (scheme !== null) {
    const named = (scheme[1] as string).toLowerCase();
    const encoded = scheme[2] as string;
    const signals: VariantSignal[] = [];
    if (named === 'vhlink') {
      signals.push({
        observation: 'The URI scheme is `vhlink:`.',
        meaning:
          'This is an IHE Verifiable Health Link. The SHL specification requires a profile that changes the protocol to use its own scheme, so the scheme itself is the statement.',
        severity: 'info',
        citation: CITE.plainShl,
      });
    }
    if (named === 'ktclink') {
      signals.push({
        observation: 'The URI scheme is `ktclink:`.',
        meaning:
          'A downstream profile has claimed its own scheme, as the SHL specification requires of anything that is not a Plain SHL.',
        severity: 'info',
        citation: CITE.plainShl,
      });
    }
    try {
      const payload = decodeShlPayload(encoded);
      const identification = identifyPayload(payload, signals);
      if (named === 'vhlink' && identification.variant.family !== 'vhl') {
        return { ...identification, variant: VARIANTS.vhl, protocol: 'vhl-list-search' };
      }
      return identification;
    } catch (error) {
      return {
        variant: named === 'vhlink' ? VARIANTS.vhl : VARIANTS['shl-baseline'],
        protocol: named === 'vhlink' ? 'vhl-list-search' : 'unknown',
        signals: [
          ...signals,
          {
            observation: `The payload after \`${named}:/\` did not decode.`,
            meaning: describeError(error),
            severity: 'error',
          },
        ],
      };
    }
  }

  const parsed = parseJson(body === '' ? trimmed : trimmed);
  if (parsed !== undefined) {
    if (isManifestShaped(parsed)) return identifyManifest(parsed);
    if (isPayloadShaped(parsed)) return identifyPayload(parsed as ShlPayload, []);
    return identifyContent(parsed, undefined);
  }

  if (/^[A-Za-z0-9_-]{16,}$/.test(body)) {
    try {
      const payload = decodeShlPayload(body);
      if (isPayloadShaped(payload)) {
        return identifyPayload(payload, [
          {
            observation: 'A bare base64url payload with no URI scheme.',
            meaning:
              'It decodes to an SHL payload, so it is treated as one. Which retrieval protocol applies is inferred from the payload rather than stated by a scheme.',
            severity: 'info',
          },
        ]);
      }
    } catch {
      // Not a payload. Fall through to unknown rather than guessing.
    }
  }

  return { variant: VARIANTS.unknown, protocol: 'unknown', signals: [] };
}

function identifyHcert(hcert: HcertReport): VariantIdentification {
  const signals: VariantSignal[] = [
    {
      observation: `The input begins \`${hcert.contextId}:\`, followed by ${hcert.base45Characters} Base45 characters.`,
      meaning:
        'This is a health certificate QR, not a bare link. Unwrapping it means Base45, then zlib, then a COSE-signed CBOR Web Token.',
      severity: 'info',
      citation: CITE.hcertContextId,
    },
  ];
  if (hcert.contextId !== 'HC1') {
    signals.push({
      observation: `The context identifier is \`${hcert.contextId}\`, not \`HC1\`.`,
      meaning:
        'HCERT reserves the whole HC1 to HCZ range, and a new identifier means a version that broke backwards compatibility. Loupe read it as HCERT anyway, so treat the result as indicative.',
      severity: 'warning',
      citation: CITE.hcertContextId,
    });
  }
  for (const problem of hcert.problems) {
    signals.push({
      observation: problem,
      meaning:
        'This is a defect in the certificate or in its encoding, not a profile difference. Everything Loupe did decode is still shown.',
      severity: 'error',
    });
  }

  if (hcert.cose.kidBase64 !== undefined) {
    signals.push({
      observation: `The signing key identifier is \`${hcert.cose.kidBase64}\`, taken from the ${hcert.cose.kidFrom ?? 'header'}.`,
      meaning:
        'That is standard base64 with padding, which is how the WHO GDHCN trust list publishes it. A base64url form of the same eight bytes will never match an entry in that list.',
      severity: 'info',
      citation: CITE.hcertKid,
    });
  }
  if (hcert.cwt.issuer !== undefined) {
    const name = hcert.cwt.issuerName;
    signals.push({
      observation: `The CWT issuer claim is \`${hcert.cwt.issuer}\`${name === undefined ? '' : ` (${name})`}.`,
      meaning:
        'HCERT carries the issuing country as an ISO 3166-1 alpha-2 code. It says who claims to have issued this, not who signed it: the signer is only knowable by resolving the key identifier against a trust list.',
      severity: 'info',
      citation: CITE.cwt,
    });
  }
  if (hcert.cwt.expiry !== undefined) {
    const expiry = hcert.cwt.expiry;
    const past = expiry * 1000 < Date.now();
    signals.push({
      observation: `The certificate expiry claim is ${expiry} (${new Date(expiry * 1000).toISOString()}).`,
      meaning: past
        ? 'That is in the past, so a verifier following the certificate’s own hint will reject it.'
        : 'The certificate is inside its own stated validity window.',
      severity: past ? 'warning' : 'info',
      citation: CITE.cwt,
    });
  }
  signals.push({
    observation:
      hcert.cose.algorithm === undefined
        ? 'No COSE algorithm label was found in either header.'
        : `The COSE signature algorithm is ${hcert.cose.algorithm}.`,
    meaning:
      'Verifying it needs the document signing certificate for this key identifier, which lives in a national or GDHCN trust list. Loupe makes no request for one, so the signature here is unchecked, not invalid. Absence from the current list is also how this ecosystem expresses revocation, so a lookup that finds nothing is a real answer rather than an error.',
    severity: 'info',
  });

  const negative = hcert.subclaims.filter((claim) => claim < 0);
  if (negative.length > 0) {
    signals.push({
      observation: `HCERT subclaim ${negative.join(', ')} is negative.`,
      meaning:
        'WHO reserves subclaims of zero and above for itself and leaves negative ones free for development, so a negative subclaim is a development payload by WHO’s own governance rule.',
      severity: 'info',
    });
  }
  for (const claim of hcert.subclaims) {
    const label = HCERT_SUBCLAIMS[claim];
    signals.push({
      observation: `HCERT subclaim ${claim} is present.`,
      meaning: label === undefined ? 'No published profile in Loupe names this subclaim.' : `That slot carries the ${label}.`,
      severity: 'info',
    });
  }

  const base: Omit<VariantIdentification, 'variant' | 'protocol'> = { signals, hcert };

  if (hcert.link !== undefined) {
    const link = hcert.link;
    if (link.scheme === 'none') {
      signals.push({
        observation: 'The health-link claim has neither an `shlink:` nor a `vhlink:` prefix.',
        meaning:
          'The prefix is the only in-band signal of which retrieval protocol applies, so it is genuinely ambiguous here. The normative HCERT text titles this slot Smart Health Link, while the WHO logical model and IHE ITI VHL both call it a Verifiable Health Link.',
        severity: 'warning',
      });
      return {
        ...base,
        variant: VARIANTS['hcert-link-ambiguous'],
        protocol: 'unknown',
        inner: identifyRaw(link.uri),
      };
    }
    const inner = identifyRaw(link.uri);
    const isVhl = link.scheme === 'vhlink' || inner.variant.family === 'vhl';
    signals.push({
      observation: `The health-link claim holds a \`${link.scheme}:\` URI.`,
      meaning: isVhl
        ? 'So the manifest is a FHIR List search, not an SHL manifest POST, and completing it needs a trust-network credential this page does not hold.'
        : 'So once the certificate is unwrapped, the inner link is an ordinary SMART Health Link and takes the baseline path.',
      severity: 'info',
    });
    return {
      ...base,
      variant: isVhl ? VARIANTS['hcert-vhl'] : VARIANTS['hcert-shl'],
      protocol: isVhl ? 'vhl-list-search' : inner.protocol,
      inner,
    };
  }

  if (hcert.subclaims.includes(1)) {
    return { ...base, variant: VARIANTS['hcert-dcc'], protocol: 'self-contained' };
  }
  if (hcert.subclaims.includes(3) || hcert.subclaims.includes(4)) {
    return { ...base, variant: VARIANTS['hcert-ddcc'], protocol: 'self-contained' };
  }
  if (hcert.subclaims.includes(-6)) {
    return { ...base, variant: VARIANTS['hcert-icvp'], protocol: 'self-contained' };
  }
  return { ...base, variant: VARIANTS['hcert-unknown'], protocol: 'unknown' };
}

function identifyPayload(payload: ShlPayload, inherited: VariantSignal[]): VariantIdentification {
  const signals = [...inherited];
  const members = Object.keys(payload);
  const type = typeof payload.type === 'string' ? payload.type.toLowerCase() : undefined;
  const url = typeof payload.url === 'string' ? payload.url : '';
  const protocol = impliedProtocol(payload);

  const extras = members.filter((member) => !SPEC_MEMBERS.includes(member));
  const underscore = extras.filter((member) => member.startsWith('_'));
  const ktc = extras.filter((member) => /^_?ktc/i.test(member));
  const unattributed = extras.filter(
    (member) =>
      member !== 'type' &&
      member !== 'extension' &&
      member !== 'extensions' &&
      member !== '_manifestId' &&
      !ktc.includes(member),
  );

  if (type !== undefined) {
    signals.push({
      observation: `A \`type\` member with the value \`${type}\`.`,
      meaning:
        type === 'shl' || type === 'vhl'
          ? 'The HL7 payload has no `type` member, so this link comes from the WHO GDHCN Personal Health Wallet model, which adds one. It defines exactly two values: `shl` and `vhl`.'
          : 'The WHO model that defines `type` binds it to two codes, `shl` and `vhl`. This value is neither, so what it means is up to whoever minted the link.',
      severity: type === 'shl' || type === 'vhl' ? 'info' : 'warning',
      citation: CITE.whoPhw,
    });
  }
  if (protocol === 'vhl-list-search' && type !== 'vhl') {
    signals.push({
      observation: `The \`url\` is a FHIR search: ${url}`,
      meaning:
        'A payload whose url is a List search is an IHE Verifiable Health Link even with no `type` member, so an SHL manifest POST against it was never going to work.',
      severity: 'info',
      citation: CITE.vhlManifest,
    });
  }
  if (members.includes('extensions')) {
    signals.push({
      observation: 'The payload carries `extensions`, plural.',
      meaning:
        'IHE VHL defines `extension`, singular, and the base SHL specification reserves that one name and defines no other. IHE’s own worked example encodes the plural, so this is most likely inherited from that example rather than deliberate.',
      severity: 'warning',
      citation: CITE.extensions,
    });
  }
  if (members.includes('extension')) {
    signals.push({
      observation: 'The payload carries the reserved `extension` member.',
      meaning:
        'The SHL specification reserves that name for downstream guides and will never define it, and IHE VHL uses exactly that slot. A baseline receiver ignores it.',
      severity: 'info',
      citation: CITE.extensions,
    });
  }
  if (members.includes('_manifestId')) {
    signals.push({
      observation: 'An underscore member `_manifestId`.',
      meaning:
        'That is the extension SHLServer emits, and it is legal: names beginning with an underscore are reserved for downstream implementations, and receivers must ignore what they do not understand.',
      severity: 'info',
      citation: CITE.extensions,
    });
  }
  for (const member of unattributed) {
    signals.push({
      observation: `An unrecognised member \`${member}\`.`,
      meaning: member.startsWith('_')
        ? 'Underscore names are reserved for downstream implementation guides, so this is a legal extension Loupe has no profile for. The link still opens: receivers must ignore extensions they do not understand.'
        : 'The specification defines six members and reserves `extension` plus any name starting with an underscore. This name is outside that convention, but a receiver still has to ignore it rather than fail.',
      severity: 'info',
      citation: CITE.ignoreUnknown,
    });
  }
  if (underscore.length > 0 && unattributed.length === 0 && ktc.length === 0) {
    // Nothing to say beyond what was said per member above.
  }
  if (url.includes('|')) {
    signals.push({
      observation: 'The `url` contains a raw `|` character.',
      meaning:
        'A vertical bar is not legal in a URI and has to be percent-encoded as `%7C`. IHE’s own VHL example carries it unencoded in a `patient.identifier` search parameter, so a client built from that example inherits the problem.',
      severity: 'warning',
    });
  }

  const variant = ((): Variant => {
    if (type === 'vhl' || protocol === 'vhl-list-search') return VARIANTS.vhl;
    if (type === 'shl') return VARIANTS['shl-who-phw'];
    if (ktc.length > 0) return VARIANTS['shl-ktc'];
    if (members.includes('extension') || members.includes('extensions') || unattributed.length > 0) {
      return VARIANTS['shl-extension-unknown'];
    }
    return VARIANTS['shl-baseline'];
  })();

  if (variant.id === 'shl-baseline') {
    signals.push({
      observation: 'Every member is one the HL7 specification defines.',
      meaning:
        'This is the baseline. Downstream profiles such as KTC and pan-Canadian CA:SHL reuse this payload byte for byte and tighten what the server must do, so a link from one of them is indistinguishable here and shows up in the response, not in the link.',
      severity: 'good',
      citation: CITE.plainShl,
    });
  }
  if (variant.id === 'shl-ktc') {
    signals.push({
      observation: `A member naming the KTC profile: \`${ktc.join('`, `')}\`.`,
      meaning:
        'Loupe is taking the sender’s word for that. KTC constrains the server rather than the payload, so nothing in a link can prove KTC conformance: only the retrieval response can.',
      severity: 'info',
    });
  }

  return { variant, protocol, signals };
}

function identifyManifest(manifest: unknown): VariantIdentification {
  const signals: VariantSignal[] = [
    {
      observation: 'The input is an SHL manifest response.',
      meaning:
        'So this came back from a sharing server, and what it says about the variant is in its content types and its `list` extensions.',
      severity: 'info',
      citation: CITE.contentTypes,
    },
  ];
  const record = (typeof manifest === 'object' && manifest !== null ? manifest : {}) as Record<string, unknown>;
  const files = Array.isArray(record.files) ? record.files : [];
  const contentTypes = new Set<string>();
  for (const file of files) {
    if (typeof file === 'object' && file !== null) {
      const contentType = (file as Record<string, unknown>).contentType;
      if (typeof contentType === 'string') contentTypes.add(contentType);
    }
  }

  for (const contentType of contentTypes) {
    const base = (contentType.split(';')[0] ?? '').trim().toLowerCase();
    if (ALLOWED_CONTENT_TYPES.includes(base)) continue;
    if (base === 'application/pdf') {
      signals.push({
        observation: 'A file is declared as `application/pdf`.',
        meaning:
          'PDF is not one of the three content types the SHL specification allows, but Malaysia’s national GDHCN deployment emits it, so this is a real deployment rather than a broken server. Loupe renders what it can and does not reject the manifest.',
        severity: 'warning',
        citation: CITE.contentTypes,
      });
      continue;
    }
    signals.push({
      observation: `A file is declared as \`${contentType}\`.`,
      meaning:
        'The specification allows `application/smart-health-card`, `application/smart-api-access` and `application/fhir+json`. Loupe sniffs the decrypted content rather than trusting the declaration, so an unexpected type is worth reporting to the server operator but does not stop the file opening.',
      severity: 'warning',
      citation: CITE.contentTypes,
    });
  }

  const list = record.list;
  if (typeof list === 'object' && list !== null) {
    const listRecord = list as Record<string, unknown>;
    const extension = listRecord.extension;
    if (Array.isArray(extension) && extension.length > 0) {
      const urls = extension
        .map((entry) => (typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>).url : undefined))
        .filter((value): value is string => typeof value === 'string');
      signals.push({
        observation: `The manifest’s \`list\` carries ${extension.length} FHIR extension${extension.length === 1 ? '' : 's'}${urls.length === 0 ? '' : `: ${urls.join(', ')}`}.`,
        meaning:
          '`list` is the designated slot for manifest extensions, so this is the conformant place for a downstream guide to add something. Clients ignore extensions they do not understand.',
        severity: 'info',
        citation: CITE.manifestList,
      });
    }
    for (const profile of collectProfiles(list)) {
      const noted = NOTED_PROFILES.find((entry) => profile.startsWith(entry.prefix));
      if (noted !== undefined) {
        signals.push({
          observation: `The \`list\` claims the profile ${profile}.`,
          meaning: noted.note,
          severity: 'info',
        });
      }
    }
  }

  return { variant: VARIANTS['shl-baseline'], protocol: 'shl-manifest-post', signals };
}

function identifyContent(content: unknown, declaredContentType?: string): VariantIdentification {
  const signals: VariantSignal[] = [];
  if (declaredContentType !== undefined) {
    signals.push({
      observation: `The manifest declared this file as \`${declaredContentType}\`.`,
      meaning:
        'The declaration is recorded, and the family below comes from the content itself: a declared type is routinely absent, and a manifest that mislabels a file is a real condition.',
      severity: 'info',
    });
  }

  if (typeof content !== 'object' || content === null) {
    return { variant: VARIANTS.unknown, protocol: 'unknown', signals };
  }
  const record = content as Record<string, unknown>;

  if (Array.isArray(record.verifiableCredential)) {
    signals.push({
      observation: `A \`verifiableCredential\` array of ${record.verifiableCredential.length} entr${record.verifiableCredential.length === 1 ? 'y' : 'ies'}.`,
      meaning:
        'This file is a SMART Health Card: a signed JWS carrying its own FHIR content, whose issuer key comes from a JWKS at its `iss`.',
      severity: 'info',
    });
    return { variant: VARIANTS.shc, protocol: 'self-contained', signals };
  }

  const vcTypes = Array.isArray(record.type) ? record.type.filter((t): t is string => typeof t === 'string') : [];
  if (vcTypes.includes('VerifiableCredential') || record['@context'] !== undefined) {
    const subject = record.credentialSubject;
    const carriesLink =
      typeof subject === 'object' &&
      subject !== null &&
      typeof (subject as Record<string, unknown>).url === 'string' &&
      typeof (subject as Record<string, unknown>).key === 'string';
    const proof = record.proof;
    const proofType =
      typeof proof === 'object' && proof !== null ? (proof as Record<string, unknown>).type : undefined;
    signals.push({
      observation: `A W3C Verifiable Credential with type ${vcTypes.length === 0 ? 'unstated' : `\`${vcTypes.join('`, `')}\``}${typeof proofType === 'string' ? ` and a \`${proofType}\`` : ''}.`,
      meaning:
        typeof proofType === 'string'
          ? 'The proof is recorded and left unverified: a JSON-LD proof is computed over canonicalised input, which needs a canonicalisation library and context resolution this page does not carry.'
          : 'No proof is present, so nothing here is signed.',
      severity: 'info',
      citation: CITE.vhlCarrier,
    });
    if (carriesLink || vcTypes.some((entry) => entry.toUpperCase().includes('VHL'))) {
      const inner = carriesLink ? identifyPayload(subject as ShlPayload, []) : undefined;
      return {
        variant: VARIANTS['vhl-vc'],
        protocol: 'vhl-list-search',
        signals,
        ...(inner === undefined ? {} : { inner }),
      };
    }
    return { variant: VARIANTS.unknown, protocol: 'unknown', signals };
  }

  if (typeof record.access_token === 'string' || typeof record.aud === 'string') {
    signals.push({
      observation: 'An `access_token` or `aud` member.',
      meaning:
        'This is a SMART API access file: the link is handing over an API endpoint and a token rather than a document.',
      severity: 'info',
      citation: CITE.contentTypes,
    });
    return { variant: VARIANTS['smart-api-access'], protocol: 'self-contained', signals };
  }

  if (typeof record.resourceType === 'string') {
    const profiles = collectProfiles(record);
    const family = PROFILE_FAMILIES.find((entry) =>
      profiles.some((profile) => profile.startsWith(entry.prefix)),
    );
    for (const profile of profiles) {
      const noted = NOTED_PROFILES.find((entry) => profile.startsWith(entry.prefix));
      if (noted !== undefined) {
        signals.push({ observation: `Claims the profile ${profile}.`, meaning: noted.note, severity: 'info' });
      }
    }
    if (family !== undefined) {
      const matched = profiles.filter((profile) => profile.startsWith(family.prefix));
      signals.push({
        observation: `\`meta.profile\` claims ${matched.join(', ')}.`,
        meaning: `That canonical belongs to ${VARIANTS[family.id].name}, so the payload states its own family. Whether it conforms is a separate question, answered by validating against that guide.`,
        severity: 'info',
      });
      return { variant: VARIANTS[family.id], protocol: 'self-contained', signals, profiles };
    }
    signals.push({
      observation: `A FHIR \`${record.resourceType}\`${profiles.length === 0 ? ' claiming no profile' : ` claiming ${profiles.join(', ')}`}.`,
      meaning:
        profiles.length === 0
          ? 'No profile is claimed, so what this conforms to has to be judged structurally. The HL7 IG’s own IPS example also omits `meta.profile`, so absence is not evidence that this is not an IPS.'
          : 'None of those canonicals belongs to a family Loupe recognises, which is a gap in Loupe rather than a problem with the payload.',
      severity: 'info',
    });
    return { variant: VARIANTS['fhir-unprofiled'], protocol: 'self-contained', signals, profiles };
  }

  return { variant: VARIANTS.unknown, protocol: 'unknown', signals };
}

// ---------------------------------------------------------------------------
// Shape helpers
// ---------------------------------------------------------------------------

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{')) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

function isPayloadShaped(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record.url === 'string' && typeof record.key === 'string';
}

function isManifestShaped(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return Array.isArray(record.files) || (record.status !== undefined && record.list !== undefined);
}
