/**
 * The teaching content, as typed data.
 *
 * Three rules hold this file together.
 *
 * 1. **A quote is verbatim or it is not a quote.** Every `Citation` carrying a
 *    `quote` here was transcribed from the specification text (via the verified
 *    research notes in `research/01-shl-spec.md` and `research/02-shc-spec.md`),
 *    including its typos, because a teaching tool that silently tidies a
 *    normative sentence teaches something the reader cannot then find in the
 *    spec. Where only the section is known, the citation carries no quote and
 *    the prose beside it is written in Loupe's own voice.
 * 2. **Content is data, not JSX.** The screens render these structures. That
 *    keeps the wording greppable, lets the test below check every citation, and
 *    leaves a translation layer possible later.
 * 3. **Anything the app already knows, the guide generates rather than
 *    restates.** The CORS header checklist and the preflight command come from
 *    `core/net/curl.ts`, the same helpers the diagnosis uses, so the lesson and
 *    the verdict cannot drift apart.
 */
import type { Audience, Citation, Severity } from '../core/trace';
import { CITATIONS } from '../core/citations';
import type { CauseId } from '../core/diagnose/differential';

// ---------------------------------------------------------------------------
// Citation helpers
// ---------------------------------------------------------------------------

const SHL_URL =
  'https://build.fhir.org/ig/HL7/smart-health-cards-and-links/links-specification.html';
const SHC_URL =
  'https://build.fhir.org/ig/HL7/smart-health-cards-and-links/cards-specification.html';
const FETCH_URL = 'https://fetch.spec.whatwg.org/';
const RFC7638_URL = 'https://www.rfc-editor.org/rfc/rfc7638';
const KTC_URL = 'https://ktc-spec.github.io/';

/**
 * `core/citations.ts` is the registry of the citations the pipeline raises in a
 * finding. The guide needs sections the pipeline never cites, so it builds its
 * own; where a citation already exists there, it is reused rather than retyped.
 */
const cite =
  (spec: string, url: string) =>
  (section: string, quote?: string): Citation => ({
    spec,
    section,
    url,
    ...(quote === undefined ? {} : { quote }),
  });

const shl = cite('SMART Health Links', SHL_URL);
const shc = cite('SMART Health Cards', SHC_URL);
const fetchSpec = cite('Fetch', FETCH_URL);

// ---------------------------------------------------------------------------
// The worked example: the IG's own link, and what is inside it
// ---------------------------------------------------------------------------

/**
 * The link every anatomy below is built from. It is the IG's own published
 * example, it is a `U`-flag link served from a static host with
 * `access-control-allow-origin: *`, and it therefore actually opens in a
 * browser: the one example that can be demonstrated at a table rather than
 * described.
 */
export const EXAMPLE_LINK =
  'https://viewer.tcpdev.org/shlink.html#shlink:/eyJ1cmwiOiJodHRwczovL3Jhdy5naXRodWJ1c2VyY29udGVudC5jb20vc2Vhbm5vL3NoYy1kZW1vLWRhdGEvbWFpbi9pcHMvSVBTX0lHLWJ1bmRsZS0wMS1lbmMudHh0IiwiZmxhZyI6IkxVIiwia2V5IjoicnhUZ1lsT2FLSlBGdGNFZDBxY2NlTjh3RVU0cDk0U3FBd0lXUWU2dVg3USIsImxhYmVsIjoiRGVtbyBTSEwgZm9yIElQU19JRy1idW5kbGUtMDEifQ';

export const EXAMPLE_VIEWER_PREFIX = 'https://viewer.tcpdev.org/shlink.html';

export const EXAMPLE_PAYLOAD_BASE64URL =
  'eyJ1cmwiOiJodHRwczovL3Jhdy5naXRodWJ1c2VyY29udGVudC5jb20vc2Vhbm5vL3NoYy1kZW1vLWRhdGEvbWFpbi9pcHMvSVBTX0lHLWJ1bmRsZS0wMS1lbmMudHh0IiwiZmxhZyI6IkxVIiwia2V5IjoicnhUZ1lsT2FLSlBGdGNFZDBxY2NlTjh3RVU0cDk0U3FBd0lXUWU2dVg3USIsImxhYmVsIjoiRGVtbyBTSEwgZm9yIElQU19JRy1idW5kbGUtMDEifQ';

/** The payload JSON exactly as it decodes: minified, in the sender's key order. */
export const EXAMPLE_PAYLOAD_JSON =
  '{"url":"https://raw.githubusercontent.com/seanno/shc-demo-data/main/ips/IPS_IG-bundle-01-enc.txt","flag":"LU","key":"rxTgYlOaKJPFtcEd0qcceN8wEU4p94SqAwIWQe6uX7Q","label":"Demo SHL for IPS_IG-bundle-01"}';

export const EXAMPLE_MANIFEST_URL = 'https://shl.example.org/manifest/GH7f3Kq2';

/** The protected header of the file that link points at, base64url, 108 characters. */
const EXAMPLE_JWE_HEADER_B64 =
  'eyJlbmMiOiJBMjU2R0NNIiwiYWxnIjoiZGlyIiwia2lkIjoidWZZR2x1X0M4SXV6SjNIVi13UXFzSXYtcE1tMnVabS12R3kzN3IzaHd0cyJ9';

const EXAMPLE_JWE_HEADER_JSON =
  '{"enc":"A256GCM","alg":"dir","kid":"ufYGlu_C8IuzJ3HV-wQqsIv-pMm2uZm-vGy37r3hwts"}';

/** The protected header of the health card inside the IG's second example file. */
const EXAMPLE_JWS_HEADER_B64 =
  'eyJ6aXAiOiJERUYiLCJhbGciOiJFUzI1NiIsImtpZCI6ImJSd1ZpbVMteW5OQ1VGT29uSkRXUHB0LXBqR01QTkctaGdmY3NUZTY1VVUifQ';

const EXAMPLE_JWS_HEADER_JSON =
  '{"zip":"DEF","alg":"ES256","kid":"bRwVimS-ynNCUFOonJDWPpt-pjGMPNG-hgfcsTe65UU"}';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type GuideTone = 'pass' | 'warn' | 'fail' | 'info';

export type SectionId =
  | 'what'
  | 'payload'
  | 'flags'
  | 'manifest'
  | 'encryption'
  | 'cards'
  | 'errors'
  | 'cors';

export type AnatomyId = 'link' | 'payload' | 'jwe' | 'jws';

export type MemberName = 'url' | 'key' | 'exp' | 'flag' | 'label' | 'v';

/** Where a tinted segment leads when you click it. */
export type AnatomyTarget =
  | { to: 'member'; member: MemberName }
  | { to: 'section'; section: SectionId }
  | { to: 'anatomy'; anatomy: AnatomyId };

export interface AnatomySegment {
  id: string;
  /** The characters of this segment, in order. Concatenating a literal anatomy's
   *  segments reproduces the artefact exactly. */
  text: string;
  /** Short label shown under the tint. Carries the meaning, so the tint never has to. */
  label: string;
  /** One or two sentences: what these characters are. */
  explains: string;
  /** What the characters decode to, when that is short enough to show. */
  decodes?: string;
  target?: AnatomyTarget;
  /** True when `text` is a description standing in for characters we do not have. */
  elided?: boolean;
}

export interface Anatomy {
  id: AnatomyId;
  title: string;
  lede: string;
  /**
   * True when every segment carries real characters, so the segments joined are
   * byte-for-byte the real artefact. False when some part is elided (an 81 KB
   * ciphertext is not going on a teaching page, and inventing one would be a
   * lie).
   */
  literal: boolean;
  /** Present when `literal`: the artefact the segments must reproduce. */
  whole?: string;
  segments: readonly AnatomySegment[];
}

export interface PayloadMember {
  name: MemberName;
  cardinality: string;
  type: string;
  /** The constraint in Loupe's words, short enough for a table cell. */
  constraint: string;
  /** What the member is for, in one sentence. */
  purpose: string;
  /** The normative sentence, verbatim, with its section. */
  quote: Citation;
  /** A further citation for a constraint stated elsewhere in the spec. */
  alsoSee?: Citation;
  /** A worked example, taken from the example link wherever it has one. */
  example: string;
  /** Why that example reads the way it does. */
  exampleNote: string;
}

export interface WireMember {
  name: string;
  cardinality: string;
  type: string;
  purpose: string;
  note?: string;
  quote?: Citation;
}

export interface FlagDoc {
  flag: 'L' | 'P' | 'U';
  title: string;
  quote: Citation;
  /** What a receiving client must do about it. */
  obliges: string;
  /** Whether ignoring it is safe, in one sentence. */
  ignorable: string;
}

export interface FlagCombination {
  combo: string;
  legal: boolean;
  note: string;
}

export interface TableRow {
  cells: readonly string[];
  tone?: GuideTone;
}

export interface ChecklistItem {
  label: string;
  detail: string;
}

export type GuideBlock =
  | { kind: 'prose'; paragraphs: readonly string[] }
  | { kind: 'quote'; citation: Citation }
  | { kind: 'members'; members: readonly PayloadMember[] }
  | { kind: 'wire'; caption: string; members: readonly WireMember[] }
  | { kind: 'table'; caption: string; columns: readonly string[]; rows: readonly TableRow[] }
  | { kind: 'code'; label: string; language?: string; code: string }
  | { kind: 'callout'; tone: GuideTone; title: string; body: string }
  | { kind: 'anatomy'; anatomy: AnatomyId }
  | { kind: 'flags'; flags: readonly FlagDoc[]; combinations: readonly FlagCombination[] }
  | { kind: 'checklist'; title: string; items: readonly ChecklistItem[] }
  /**
   * Rendered from a core helper rather than from content, so the page cannot
   * teach one thing while the diagnosis says another.
   */
  | { kind: 'generated'; generator: 'cors-headers' | 'preflight-curl' };

export interface GuideSection {
  id: SectionId;
  /** Nav label, two or three words. */
  nav: string;
  title: string;
  /** One sentence under the title. */
  lede: string;
  blocks: readonly GuideBlock[];
}

// ---------------------------------------------------------------------------
// Anatomies
// ---------------------------------------------------------------------------

export const ANATOMIES: Record<AnatomyId, Anatomy> = {
  link: {
    id: 'link',
    title: 'The link as it arrives',
    lede: 'The IG’s own example link. Click a part to follow it down.',
    literal: true,
    whole: EXAMPLE_LINK,
    segments: [
      {
        id: 'link-prefix',
        text: EXAMPLE_VIEWER_PREFIX,
        label: 'Viewer prefix',
        explains:
          'Any URL the sender likes, so long as it ends at a "#". It exists because "shlink" is not a registered URI scheme, so no phone or desktop has a handler for a bare shlink:/ link. The prefix names a viewer that does.',
      },
      {
        id: 'link-hash',
        text: '#',
        label: 'Fragment marker',
        explains:
          'Everything after this stays in the browser. A fragment is never sent to the server, which is the only reason a decryption key can travel inside a URL at all. A link that puts the payload in a query string instead hands the key to the viewer operator and to their access log.',
        target: { to: 'section', section: 'what' },
      },
      {
        id: 'link-token',
        text: 'shlink:/',
        label: 'Token',
        explains:
          'One slash, not two: this is not an authority-based URI. A receiver finds this token and ignores whatever surrounds it, which is what lets one QR carry a link plus a human-readable caption.',
      },
      {
        id: 'link-payload',
        text: EXAMPLE_PAYLOAD_BASE64URL,
        label: 'Payload, 270 characters',
        explains:
          'base64url of the minified payload JSON, no padding. Nothing here is encrypted or signed: anyone holding the link can read every member, including the key.',
        target: { to: 'anatomy', anatomy: 'payload' },
      },
    ],
  },

  payload: {
    id: 'payload',
    title: 'The payload it decodes to',
    lede: 'The same bytes, base64url-decoded. Click a member to jump to its row.',
    literal: true,
    whole: EXAMPLE_PAYLOAD_JSON,
    segments: [
      { id: 'payload-open', text: '{', label: 'JSON', explains: 'A single JSON object, minified.' },
      {
        id: 'payload-url',
        text: '"url":"https://raw.githubusercontent.com/seanno/shc-demo-data/main/ips/IPS_IG-bundle-01-enc.txt"',
        label: 'url',
        explains:
          'Where the data lives. With the U flag, as here, it is the encrypted file itself; without it, the manifest endpoint. This one is a static file on a public host, which is why the example works from a browser.',
        target: { to: 'member', member: 'url' },
      },
      { id: 'payload-c1', text: ',', label: '', explains: 'Separator.' },
      {
        id: 'payload-flag',
        text: '"flag":"LU"',
        label: 'flag',
        explains:
          'Single characters, alphabetical, concatenated. L for long-term, U for a single file fetched directly. LU is the most common form in the wild and both of the IG’s own examples use it.',
        target: { to: 'section', section: 'flags' },
      },
      { id: 'payload-c2', text: ',', label: '', explains: 'Separator.' },
      {
        id: 'payload-key',
        text: '"key":"rxTgYlOaKJPFtcEd0qcceN8wEU4p94SqAwIWQe6uX7Q"',
        label: 'key',
        explains:
          '43 base64url characters, 32 bytes: the AES-256-GCM content key for every file this link ever names. This particular key appears in the spec’s own encryption example and in every tutorial that copies it, so anything encrypted under it is public by construction.',
        target: { to: 'member', member: 'key' },
      },
      { id: 'payload-c3', text: ',', label: '', explains: 'Separator.' },
      {
        id: 'payload-label',
        text: '"label":"Demo SHL for IPS_IG-bundle-01"',
        label: 'label',
        explains:
          'Up to 80 characters of sender-written description. It is a claim, verified by nothing, so a viewer may show it but must not present it as the data’s provenance.',
        target: { to: 'member', member: 'label' },
      },
      { id: 'payload-close', text: '}', label: '', explains: 'End of the object.' },
    ],
  },

  jwe: {
    id: 'jwe',
    title: 'The encrypted file: five parts',
    lede: 'The file that link points at, part by part. Sizes are from the real file.',
    literal: false,
    segments: [
      {
        id: 'jwe-header',
        text: EXAMPLE_JWE_HEADER_B64,
        label: '1. Protected header',
        explains:
          'base64url of the header JSON, 108 characters in this file. These exact ASCII bytes are also the additional authenticated data for the decryption, so they must be used as received and never re-serialised.',
        decodes: EXAMPLE_JWE_HEADER_JSON,
        target: { to: 'section', section: 'encryption' },
      },
      { id: 'jwe-d1', text: '.', label: '', explains: 'Separator.' },
      {
        id: 'jwe-key',
        text: '',
        label: '2. Encrypted key, empty',
        explains:
          'Empty, and it has to be. alg "dir" means the link’s key IS the content encryption key, so there is nothing to wrap. Characters here mean the sender’s library did not really use "dir", and the link’s key will not open the file.',
      },
      { id: 'jwe-d2', text: '.', label: '', explains: 'Separator.' },
      {
        id: 'jwe-iv',
        text: '‹ 16 characters, 12 bytes ›',
        label: '3. Initialisation vector',
        explains:
          'Exactly 12 bytes for A256GCM. Some libraries emit 16, which appears to work at the sending end and is rejected outright by conformant receivers.',
        elided: true,
      },
      { id: 'jwe-d3', text: '.', label: '', explains: 'Separator.' },
      {
        id: 'jwe-ct',
        text: '‹ 81,298 characters ›',
        label: '4. Ciphertext',
        explains:
          'Elided here: this one file is 81,298 base64url characters and decrypts to 60,973 bytes of FHIR, a document Bundle of 20 entries. It is not compressed, because this sender set no zip header.',
        elided: true,
        target: { to: 'section', section: 'cards' },
      },
      { id: 'jwe-d4', text: '.', label: '', explains: 'Separator.' },
      {
        id: 'jwe-tag',
        text: '‹ 22 characters, 16 bytes ›',
        label: '5. Authentication tag',
        explains:
          'The 128-bit GCM tag. It is checked over the ciphertext and the header together, so a wrong key, an altered byte and a truncated download all fail identically and with no detail.',
        elided: true,
      },
    ],
  },

  jws: {
    id: 'jws',
    title: 'A health card inside: three parts',
    lede: 'When the decrypted file is a health card, each card in it is a signed JWS.',
    literal: false,
    segments: [
      {
        id: 'jws-header',
        text: EXAMPLE_JWS_HEADER_B64,
        label: '1. Protected header',
        explains:
          'Taken from the IG’s second example. All three members are required of an issuer: ES256, raw DEFLATE, and a kid that is the RFC 7638 thumbprint of the signing key. Note the member order: never compare header strings, always parse.',
        decodes: EXAMPLE_JWS_HEADER_JSON,
        target: { to: 'section', section: 'cards' },
      },
      { id: 'jws-d1', text: '.', label: '', explains: 'Separator.' },
      {
        id: 'jws-payload',
        text: '‹ raw DEFLATE of the claims, base64url ›',
        label: '2. Payload',
        explains:
          'Compressed before signing, so it inflates to the JWT claims: iss, nbf, and a vc claim carrying the FHIR Bundle. "Raw" means no zlib and no gzip wrapper, and getting that wrong is the most common producer bug in the format.',
        elided: true,
      },
      { id: 'jws-d2', text: '.', label: '', explains: 'Separator.' },
      {
        id: 'jws-sig',
        text: '‹ 64 bytes, r ‖ s, base64url ›',
        label: '3. Signature',
        explains:
          'ES256 over the ASCII bytes of the first two parts and the dot between them. Fixed-width r followed by s, never DER: a DER signature is 70 to 72 bytes and starts with 0x30, and it verifies nowhere.',
        elided: true,
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Payload members
// ---------------------------------------------------------------------------

const PAYLOAD_MEMBERS: readonly PayloadMember[] = [
  {
    name: 'url',
    cardinality: '1..1',
    type: 'url',
    constraint: 'At least 256 bits of entropy, no more than 128 characters',
    purpose:
      'The manifest endpoint, or with the U flag the encrypted file itself. It is also the entire access control on the link: whoever can guess it can request it.',
    quote: CITATIONS.payloadUrl,
    alsoSee: shl(
      'Establish a SMART Health Link Manifest URL',
      'SHALL NOT exceed 128 characters in length (note, this maximum applies to the `url` field of the SMART Health Link Payload, not to the entire SMART Health Link URI).',
    ),
    example: 'https://raw.githubusercontent.com/seanno/shc-demo-data/main/ips/IPS_IG-bundle-01-enc.txt',
    exampleNote:
      '88 characters, comfortably inside the cap. No scheme is mandated anywhere in the specification, so an http URL is technically conformant and practically unopenable from an https page.',
  },
  {
    name: 'key',
    cardinality: '1..1',
    type: 'string, base64url',
    constraint: 'Exactly 43 characters, decoding to 32 bytes',
    purpose:
      'The single symmetric key for every file this link ever serves, now and after any update.',
    quote: shl(
      'Structure of a SMART Health Link Payload: key',
      '`key`: Decryption key for processing files returned in the manifest. 43 characters, consisting of 32 random bytes base64urlencoded',
    ),
    example: 'rxTgYlOaKJPFtcEd0qcceN8wEU4p94SqAwIWQe6uX7Q',
    exampleNote:
      'The spec’s demo key, reused in both IG examples and in most tutorials. A key that is 43 characters of standard base64 (with + or /) rather than base64url will decode to the wrong bytes in a conformant client and to the right ones in a forgiving one, which is how a link comes to work in exactly one viewer.',
  },
  {
    name: 'exp',
    cardinality: '0..1',
    type: 'number',
    constraint: 'Epoch seconds, not milliseconds',
    purpose:
      'A hint to a receiver that the link is stale. The server, not the client, decides whether it still serves it.',
    quote: shl(
      'Structure of a SMART Health Link Payload: exp',
      '`exp`: Number representing expiration time in Epoch seconds, as a hint to help the SMART Health Links Receiving Application determine if this QR is stale. (Note: epoch times should be parsed into 64-bit numeric types.)',
    ),
    example: '1794787200',
    exampleNote:
      'Ten digits is seconds. Thirteen digits is milliseconds, which reads as a date thousands of years out and means the sender passed Date.now() where Date.now()/1000 was wanted. Because exp is only a hint, a viewer that refuses an expired link outright is being unhelpful: the server may still serve it.',
  },
  {
    name: 'flag',
    cardinality: '0..1',
    type: 'string',
    constraint: 'Single characters, alphabetical, concatenated',
    purpose: 'Which of the three protocol variations apply. Absent means none of them.',
    quote: shl(
      'Structure of a SMART Health Link Payload: flag',
      'String created by concatenating single-character flags in alphabetical order',
    ),
    example: 'LU',
    exampleNote:
      'A viewer must ignore flag characters it does not recognise rather than fail. Out-of-order flags such as "PL" are malformed but trivially recoverable: sort them, and say that you did.',
  },
  {
    name: 'label',
    cardinality: '0..1',
    type: 'string',
    constraint: 'No longer than 80 characters',
    purpose: 'A short human description, so a wallet holding several links can tell them apart.',
    quote: shl(
      'Structure of a SMART Health Link Payload: label',
      'String no longer than 80 characters that provides a short description of the data behind the SMART Health Link',
    ),
    example: 'Demo SHL for IPS_IG-bundle-01',
    exampleNote:
      'Written by the sender and verified by nothing. Show it as the sender’s words, never as a statement about where the data came from.',
  },
  {
    name: 'v',
    cardinality: '0..1',
    type: 'number',
    constraint: 'Integer. Omitted means 1',
    purpose: 'The protocol version the link claims to conform to.',
    quote: shl(
      'Structure of a SMART Health Link Payload: v',
      'Integer representing the SMART Health Links protocol version this SMART Health Link conforms to. MAY be omitted when the default value (`1`) applies',
    ),
    example: '(absent)',
    exampleNote:
      'A version above 1 is the one member that tells a client to stop: the design note says it should display a message and should not make the manifest request unless it has reason to believe proceeding is safe.',
  },
];

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

const FLAGS: readonly FlagDoc[] = [
  {
    flag: 'L',
    title: 'Long-term use',
    quote: shl(
      'Flags: L',
      'Indicates the SMART Health Link is intended for long-term use and manifest content can evolve over time',
    ),
    obliges:
      'Nothing. It enables polling: a client MAY periodically re-request the manifest to pick up changes.',
    ignorable:
      'Safe to ignore. A client that never polls is still conformant, it just shows an older snapshot.',
  },
  {
    flag: 'P',
    title: 'Passcode required',
    quote: shl('Flags: P', 'Indicates the SMART Health Link requires a Passcode to resolve'),
    obliges:
      'Prompt for a passcode and send it in the manifest request body. The passcode is not in the link and cannot be derived from it.',
    ignorable:
      'Cannot be ignored. The design note says so plainly: the server responds with an error if no passcode is provided. Wrong attempts are counted for the life of the link, so a client must never retry on its own.',
  },
  {
    flag: 'U',
    title: 'Direct file, no manifest',
    quote: shl(
      'Flags: U',
      "Indicates the SMART Health Links's `url` resolves to a single encrypted file accessible via `GET`, bypassing the manifest. SHALL NOT be used in combination with `P`",
    ),
    obliges:
      'Do not request a manifest. GET the url with a recipient query parameter and treat the response body as the encrypted file.',
    ignorable:
      'Cannot be ignored: there is no manifest at that URL to fall back to. It is also the only shape that works on a static host, which is why every published example uses it.',
  },
];

const FLAG_COMBINATIONS: readonly FlagCombination[] = [
  {
    combo: '(absent)',
    legal: true,
    note: 'Manifest-based, no passcode. One request, one snapshot.',
  },
  { combo: 'L', legal: true, note: 'Manifest-based, worth re-checking later.' },
  { combo: 'LP', legal: true, note: 'Long-lived and passcode-protected. Alphabetical, so L first.' },
  {
    combo: 'LU',
    legal: true,
    note: 'A single file, directly fetched, expected to change. Both of the IG’s own examples.',
  },
  { combo: 'P', legal: true, note: 'Passcode on a manifest request.' },
  { combo: 'U', legal: true, note: 'A single file, directly fetched, one snapshot.' },
  {
    combo: 'PU',
    legal: false,
    note: 'Forbidden by the U flag’s own sentence. U means a GET with no manifest exchange, and a passcode is a member of the manifest request body, so there is nowhere to put it. The sender has to drop one of the two.',
  },
  {
    combo: 'UP',
    legal: false,
    note: 'The same violation, plus the ordering one: flags are concatenated alphabetically.',
  },
];

// ---------------------------------------------------------------------------
// The manifest exchange
// ---------------------------------------------------------------------------

const MANIFEST_REQUEST_MEMBERS: readonly WireMember[] = [
  {
    name: 'recipient',
    cardinality: '1..1',
    type: 'string',
    purpose: 'Who is asking, for the sharer’s audit log.',
    note: 'Logged, not authenticated, and not machine-parsed. No length limit is given. The spec describes it two different ways in two places: "suitable for display to the Receiving User" here, and "suitable for display to the Data Sharer" on the U-flag GET. The second reading is the sensible one, since the sharer is who reads the log.',
    quote: shl(
      'Manifest Request',
      'A string describing the recipient (e.g.,the name of an organization or person) suitable for display to the Receiving User',
    ),
  },
  {
    name: 'passcode',
    cardinality: '0..1',
    type: 'string',
    purpose: 'The passcode, when the P flag is present.',
    note: 'Every failure is charged against a lifetime cap that permanently disables the link. This is the one field where a debugging tool can destroy the data it was asked to inspect.',
    quote: shl(
      'Manifest Request',
      'SHALL be populated with a user-supplied Passcode if the `P` flag was present in the SMART Health Link payload',
    ),
  },
  {
    name: 'embeddedLengthMax',
    cardinality: '0..1',
    type: 'integer',
    purpose: 'The largest file the client is willing to receive inline.',
    note: 'For a browser client this is a survival strategy, not an optimisation: an embedded file needs no second cross-origin request, whereas a location on a cloud bucket needs a second correctly configured CORS surface. Omitting it lets the server embed anything, or nothing.',
    quote: shl(
      'Manifest Request',
      'If the client has specified `embeddedLengthMax` in the manifest request, the sever SHALL NOT return embedded payload longer than the client-designated maximum.',
    ),
  },
];

const MANIFEST_RESPONSE_MEMBERS: readonly WireMember[] = [
  {
    name: 'status',
    cardinality: '0..1',
    type: 'string',
    purpose: 'finalized, can-change, or no-longer-valid.',
    note: 'Added in STU 1, so plenty of live servers omit it.',
  },
  {
    name: 'list',
    cardinality: '0..1',
    type: 'FHIR List',
    purpose: 'The designated home for extensions to the manifest or to a file entry.',
    note: 'A client must ignore FHIR extensions it does not understand. A file entry itself may not carry id, extension or modifierExtension: the logical model caps all three at zero.',
  },
  {
    name: 'files',
    cardinality: '0..* or 1..*',
    type: 'array',
    purpose: 'The files this link is currently serving.',
    note: 'The prose table says 0..* and the ShlManifest logical model says 1..*. Loupe treats an empty array as legal but suspicious, and says which document it is reading.',
    quote: CITATIONS.manifestFiles,
  },
  {
    name: 'files[].contentType',
    cardinality: '1..1',
    type: 'string',
    purpose:
      'application/smart-health-card, application/fhir+json (optionally with a fhirVersion parameter), or application/smart-api-access.',
    note: 'This is the reliable answer to "what is in the file". The JWE cty header is meant to say the same thing and is missing from every real file we have decoded, including the IG’s own.',
    quote: shl(
      'Manifest Response: files',
      'Servers SHOULD populate the `fhirVersion` parameter; for example: "application/fhir+json;fhirVersion=4.0.1". If absent, clients MAY assume the `fhirVersion` equals `4.0.1`.',
    ),
  },
  {
    name: 'files[].location',
    cardinality: '0..1',
    type: 'url',
    purpose: 'Where to GET the encrypted file.',
    note: 'Short-lived, single-use, and frequently on a different origin from the manifest, because presigned bucket URLs are the spec’s own suggested implementation. That second origin has its own CORS posture, and it is usually a bucket nobody thought about.',
    quote: shl(
      '.files.location links',
      '`location` (SHALL be present if no `embedded` content is included): URL to the file. This URL SHALL be short-lived and intended for single use.',
    ),
  },
  {
    name: 'files[].embedded',
    cardinality: '0..1',
    type: 'string, compact JWE',
    purpose: 'The encrypted file itself, inline in the manifest.',
    note: 'Both members may be present, in which case the two decrypt to identical plaintext. They will not be identical ciphertext: a fresh IV per encryption is required, so comparing the JWE strings and reporting a difference would be wrong. Compare the plaintext.',
    quote: shl(
      'Manifest Response: files',
      'If present, the `embedded` value SHALL be up-to-date as of the time the manifest is requested.',
    ),
  },
  {
    name: 'files[].lastUpdated',
    cardinality: '0..1',
    type: 'dateTime',
    purpose: 'When this file last changed.',
    note: 'Added in STU 1. Useful with the L flag, and absent from most servers.',
  },
];

// ---------------------------------------------------------------------------
// The five JWE parts
// ---------------------------------------------------------------------------

const JWE_PART_ROWS: readonly TableRow[] = [
  {
    cells: [
      '1. Protected header',
      'JSON: alg dir, enc A256GCM, sometimes kid, optionally zip DEF and cty',
      'Any other alg means key wrapping, so the link’s key is not the content key and nothing here will open.',
    ],
  },
  {
    cells: [
      '2. Encrypted key',
      'Empty',
      'Characters here mean the sender’s library did not really use alg dir, whatever the header says.',
    ],
    tone: 'warn',
  },
  {
    cells: [
      '3. Initialisation vector',
      '12 bytes, 16 base64url characters',
      '16 bytes is a real and common interop bug: it encrypts fine and conformant receivers refuse it. Loupe reports the byte count rather than the symptom.',
    ],
    tone: 'warn',
  },
  {
    cells: [
      '4. Ciphertext',
      'Any length',
      'A truncated download fails the tag check and looks exactly like a wrong key.',
    ],
  },
  {
    cells: [
      '5. Authentication tag',
      '16 bytes, 22 base64url characters',
      'Checked over the ciphertext and the header together. Wrong key, altered byte and truncation are indistinguishable from here.',
    ],
  },
];

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const ERROR_ROWS: readonly TableRow[] = [
  {
    cells: [
      '404',
      'The link is no longer active',
      'Expired, revoked, exhausted by wrong passcodes, mistyped, or never existed. All identical, deliberately.',
    ],
    tone: 'fail',
  },
  {
    cells: [
      '401',
      'Wrong passcode',
      'Body is JSON carrying remainingAttempts. That exact member name: attemptsRemaining and remaining_attempts are wrong and read as nothing.',
    ],
    tone: 'warn',
  },
  {
    cells: [
      '429',
      'Requests too frequent',
      'With a Retry-After header a client is required to respect. Cross-origin, script cannot read that header unless the server also exposes it.',
    ],
    tone: 'warn',
  },
];

// ---------------------------------------------------------------------------
// CORS console messages, measured
// ---------------------------------------------------------------------------

const CORS_FAILURE_ROWS: readonly TableRow[] = [
  {
    cells: [
      'No Access-Control-Allow-Origin on the POST response',
      "has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present on the requested resource.",
    ],
  },
  {
    cells: [
      'OPTIONS not routed at all',
      "Response to preflight request doesn't pass access control check: No 'Access-Control-Allow-Origin' header is present on the requested resource.",
    ],
  },
  {
    cells: [
      'OPTIONS answered 404 or 405',
      "Response to preflight request doesn't pass access control check: It does not have HTTP ok status.",
    ],
  },
  {
    cells: [
      'content-type not allowed',
      'Request header field content-type is not allowed by Access-Control-Allow-Headers in preflight response.',
    ],
  },
  {
    cells: [
      'POST not allowed',
      'Method POST is not allowed by Access-Control-Allow-Methods in preflight response.',
    ],
  },
];

// ---------------------------------------------------------------------------
// The sections
// ---------------------------------------------------------------------------

export const GUIDE_SECTIONS: readonly GuideSection[] = [
  {
    id: 'what',
    nav: 'What it is',
    title: 'What a SMART Health Link is',
    lede: 'Four sentences, then the link itself, part by part.',
    blocks: [
      {
        kind: 'prose',
        paragraphs: [
          'A SMART Health Link is a URL that carries its own decryption key. The sender publishes one or more encrypted files on a server and hands out a short link whose payload says where the files are and how to decrypt them.',
          'Anybody holding the link can read the data, so the link is the credential: there is no login, no token and no account. That is deliberate, because the person sharing their record often has no way to give a recipient an account, and it is why the payload rides in the URL fragment where it is never sent to a server.',
          'The link is not the data. Opening one means fetching something over the network, which is why a link can be perfectly well formed and still open for nobody but its author.',
        ],
      },
      { kind: 'anatomy', anatomy: 'link' },
      {
        kind: 'table',
        caption: 'Three carrier forms, all with an identical payload',
        columns: ['Form', 'Looks like', 'Where it turns up'],
        rows: [
          {
            cells: [
              'Bare URI',
              'shlink:/eyJ1cmwi…',
              'Inside a QR. Note the single slash. Pasted into a browser address bar it does nothing, because shlink is not an IANA-registered scheme.',
            ],
          },
          {
            cells: [
              'Viewer-prefixed',
              'https://viewer.example.org#shlink:/eyJ1cmwi…',
              'How a link is shared as a URL, and the form a phone camera can act on.',
            ],
          },
          {
            cells: [
              'Query string',
              'https://viewer.example.org?shlink=eyJ1cmwi…',
              'Nothing in the specification permits this. It sends the decryption key to the viewer’s own server and into its access log. Loupe accepts it and says so.',
            ],
            tone: 'fail',
          },
        ],
      },
      { kind: 'quote', citation: CITATIONS.viewerUrl },
      {
        kind: 'prose',
        paragraphs: [
          'A link presented in person is a QR of the URI text, byte mode. None of the numeric-mode machinery of a health card QR applies: no digit pairs, no chunking, no ordinal prefix.',
        ],
      },
      {
        kind: 'quote',
        citation: shl(
          'Sharing User Transmits a SMART Health Link',
          'Create the QR with Error Correction Level M',
        ),
      },
      {
        kind: 'callout',
        tone: 'info',
        title: 'A link is entitled to the name only if a baseline client can open it',
        body: 'The conformance section reserves the shlink URI scheme and the SMART Health Link name for links a baseline client can parse, retrieve and decrypt using the core specification alone. A link needing a bespoke header, a client certificate or an extension the receiver must understand has to use a different scheme. That is a quotable verdict at a testing event, and more useful than any error message.',
      },
      { kind: 'quote', citation: CITATIONS.linkUri },
    ],
  },

  {
    id: 'payload',
    nav: 'The payload',
    title: 'The payload, member by member',
    lede: 'Six members, two of them required. Nothing here is signed or encrypted.',
    blocks: [
      { kind: 'anatomy', anatomy: 'payload' },
      { kind: 'quote', citation: CITATIONS.payloadMembers },
      { kind: 'members', members: PAYLOAD_MEMBERS },
      {
        kind: 'checklist',
        title: 'What Loupe checks on the payload alone, before any request',
        items: [
          {
            label: 'The key decodes to 32 bytes',
            detail:
              'A key of the wrong length cannot decrypt anything, whatever the server does. A key in standard base64 rather than base64url decodes to different bytes in a strict client than in a forgiving one.',
          },
          {
            label: 'The url is inside 128 characters and looks like it has real entropy',
            detail:
              'A manifest URL is the whole access control. A short sequential identifier such as ?bid=4836470 means anybody can enumerate other people’s links, which is a privacy finding, not a connectivity one.',
          },
          {
            label: 'exp reads as seconds',
            detail: 'A 13-digit exp is milliseconds, and the link then never expires.',
          },
          {
            label: 'The flags are legal together',
            detail: 'P and U cannot both be present. Anything unrecognised is shown and ignored.',
          },
          {
            label: 'Unknown members are shown, not rejected',
            detail:
              'A receiver is required to ignore properties it does not recognise. Names beginning with an underscore, and the name "extension", are reserved for downstream guides, so Loupe labels those separately from an ordinary unexpected member.',
          },
        ],
      },
    ],
  },

  {
    id: 'flags',
    nav: 'The flags',
    title: 'The three flags',
    lede: 'L, P and U. Two of them change what request the client makes.',
    blocks: [
      { kind: 'flags', flags: FLAGS, combinations: FLAG_COMBINATIONS },
      {
        kind: 'callout',
        tone: 'warn',
        title: 'Unrecognised flags are ignored, not refused',
        body: 'A receiving application must ignore flag values it does not recognise. So a fourth character is not an error to report as fatal, but it is worth showing: it usually means the sender is implementing a downstream profile, and a link that needs that profile understood is not a plain SMART Health Link.',
      },
    ],
  },

  {
    id: 'manifest',
    nav: 'The manifest',
    title: 'The manifest exchange',
    lede: 'One POST, one JSON response, then one GET per file. Unless the U flag says otherwise.',
    blocks: [
      { kind: 'quote', citation: CITATIONS.manifestRequest },
      {
        kind: 'code',
        label: 'The request, in full',
        language: 'http',
        code: [
          `POST ${EXAMPLE_MANIFEST_URL}`,
          'content-type: application/json',
          '',
          '{',
          '  "recipient": "Loupe (SMART Health Link debugger)",',
          '  "embeddedLengthMax": 4194304',
          '}',
        ].join('\n'),
      },
      { kind: 'wire', caption: 'Request body members', members: MANIFEST_REQUEST_MEMBERS },
      {
        kind: 'prose',
        paragraphs: [
          'There is no authentication of any kind defined for this request: no Authorization header, no cookies. A client should send it with credentials omitted, because a wildcard Access-Control-Allow-Origin is rejected by the browser the moment credentials are included.',
        ],
      },
      { kind: 'quote', citation: CITATIONS.manifestResponse },
      {
        kind: 'code',
        label: 'The response, from the IG’s own example',
        language: 'json',
        code: JSON.stringify(
          {
            status: 'finalized',
            files: [
              {
                contentType: 'application/smart-health-card',
                location:
                  'https://bucket.cloud.example.org/file1?sas=MFXK6jL3oL3SI_lRfi_-cEfzIs5oHs6rRWmrsCAFzvk',
              },
              {
                contentType: 'application/smart-health-card',
                embedded: 'eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..8zH0NmUXGwMOqEya.xdGRpgyv…',
              },
              {
                contentType: 'application/fhir+json;fhirVersion=4.0.1',
                location:
                  'https://bucket.cloud.example.org/file2?sas=T34xzj1XtqTYb2lzcgj59XCY4I6vLN3AwrTUIT9GuSc',
                lastUpdated: '2025-03-09T15:29:46Z',
              },
            ],
          },
          null,
          2,
        ),
      },
      { kind: 'wire', caption: 'Response members', members: MANIFEST_RESPONSE_MEMBERS },
      {
        kind: 'callout',
        tone: 'fail',
        title: 'A location URL is single-use and expires within the hour',
        body: 'A retry button that re-fetches a location that has already been consumed will fail and look like a server bug. The only correct retry is to request the manifest again, which on a passcode-protected link means asking for the passcode again, which can cost one of a finite number of attempts. Loupe refuses a location older than sixty minutes and says why rather than showing you an opaque 403 from a bucket.',
      },
      { kind: 'quote', citation: shl('.files.location links', 'The lifetime of `.files.location` links SHALL NOT exceed one hour.') },
      {
        kind: 'table',
        caption: 'The U flag path, compared',
        columns: ['', 'Manifest path', 'U path'],
        rows: [
          { cells: ['Method', 'POST', 'GET'] },
          {
            cells: [
              'Where recipient goes',
              'The JSON body',
              'The query string, so it does land in the server’s logs',
            ],
          },
          { cells: ['Passcode', 'Possible, with the P flag', 'Forbidden'] },
          { cells: ['embeddedLengthMax', 'Available', 'No mechanism'] },
          { cells: ['Response body', 'A JSON manifest', 'The encrypted file itself'] },
          {
            cells: [
              'Response content type',
              'application/json, required',
              'Unspecified. The IG’s own example is served as text/plain, so never gate on it',
            ],
          },
          {
            cells: [
              'Browser preflight',
              'Always, because of the JSON content type',
              'None, as long as no custom headers are sent',
            ],
          },
          { cells: ['Files', '0 to many', 'Exactly one'] },
          { cells: ['Hosting', 'Needs a stateful server', 'Works on any static host'] },
        ],
      },
    ],
  },

  {
    id: 'encryption',
    nav: 'Encryption',
    title: 'How a file is encrypted',
    lede: 'One algorithm, no negotiation, five parts. So every failure has a small set of causes.',
    blocks: [
      {
        kind: 'quote',
        citation: shl(
          'Encrypting and Decrypting Files',
          'SMART Health Link files are always symmetrically encrypted with a SMART Health Links-specific key. Encryption is performed using JSON Web Encryption (JOSE JWE) compact serialization with `"alg": "dir"`, `"enc": "A256GCM"`, and a `cty` header indicating the content type of the payload (e.g., `application/smart-health-card`, `application/fhir+json`, etc).',
        ),
      },
      {
        kind: 'prose',
        paragraphs: [
          'The algorithm set is closed. alg is always dir, so the link’s key is the content key and no wrapping or derivation happens. enc is always A256GCM. There is nothing to negotiate and therefore nothing to get wrong in negotiation, which is exactly what makes the enumerable list of failures below worth learning.',
          'cty is required by that sentence and absent from every real file we have decoded, the IG’s own examples included. So resolve the content type from the manifest’s contentType first, then cty, then by sniffing the plaintext. With the U flag there is no manifest, and cty is usually missing, so sniffing is all there is.',
        ],
      },
      { kind: 'anatomy', anatomy: 'jwe' },
      { kind: 'quote', citation: CITATIONS.jweCompact },
      {
        kind: 'table',
        caption: 'What each part should be, and what it means when it is not',
        columns: ['Part', 'Expected', 'If it is wrong'],
        rows: JWE_PART_ROWS,
      },
      {
        kind: 'callout',
        tone: 'info',
        title: 'The additional authenticated data is the header exactly as received',
        body: 'GCM authenticates the ciphertext and a block of associated data together, and here that data is the ASCII of the first part, character for character, as it arrived. Parse the header to read it, never to rebuild it: reordering the members or dropping a space produces different bytes, the tag check fails, and the failure is indistinguishable from a wrong key. This is the trap behind a decryption that works in one library and fails in another.',
      },
      {
        kind: 'callout',
        tone: 'pass',
        title: 'When there is a kid, the wrong key can be named before decryption is attempted',
        body: 'By convention a sender puts the RFC 7638 thumbprint of the symmetric key, as an oct JWK, in the JWE kid. Loupe computes that thumbprint from the link’s own key and compares. A mismatch means the file was encrypted under a different key than the link carries, which is worth saying in those words instead of showing an OperationError. It is the best single diagnostic in the format, because AES-GCM otherwise reports wrong key, wrong IV, altered ciphertext and truncated download identically.',
      },
      {
        kind: 'code',
        label: 'The thumbprint, and the example file’s kid',
        language: 'text',
        code: [
          "base64url(SHA-256(JSON.stringify({ k: <link key>, kty: 'oct' })))",
          '  = ufYGlu_C8IuzJ3HV-wQqsIv-pMm2uZm-vGy37r3hwts',
          'kid in the IG example file',
          '  = ufYGlu_C8IuzJ3HV-wQqsIv-pMm2uZm-vGy37r3hwts',
        ].join('\n'),
      },
      {
        kind: 'quote',
        citation: {
          spec: 'RFC 7638',
          section: 'JSON Web Key (JWK) Thumbprint',
          url: RFC7638_URL,
        },
      },
      {
        kind: 'prose',
        paragraphs: [
          'A zip header of DEF means the plaintext was raw-DEFLATE compressed before encryption, with no zlib or gzip wrapper. It is optional, and it is a known field failure point: several widely used JOSE libraries dropped support for it, and current ones cap the decompressed size (250 KB by default in one popular library, which a real patient summary exceeds easily). Senders who want the widest reach leave payloads uncompressed.',
        ],
      },
      {
        kind: 'quote',
        citation: shl(
          'Encrypting and Decrypting Files',
          'Because the same encryption key is used for all files over time within a SMART Health Link, the SHL Sharing Application SHALL ensure a unique nonce (also known as initialization vector, or IV) for each encryption operation, including initial encryption of each file and every subsequent update.',
        ),
      },
    ],
  },

  {
    id: 'cards',
    nav: 'Inside the file',
    title: 'What comes out: a bundle, or a signed card',
    lede: 'Decryption is the SMART Health Link layer. A health card adds a second, independent one.',
    blocks: [
      {
        kind: 'prose',
        paragraphs: [
          'A decrypted file is one of three things: a FHIR resource or Bundle, a SMART Health Card file, or a set of API credentials. The manifest’s contentType says which.',
          'A FHIR bundle is not tamper-proof and does not claim to be. A SMART Health Card is signed by its issuer, so it carries a second compression layer and a second crypto layer, and the two must not be conflated: the JWE zip header is optional, while the JWS zip header is mandatory.',
        ],
      },
      { kind: 'anatomy', anatomy: 'jws' },
      {
        kind: 'quote',
        citation: shc(
          'Health Cards are Compact',
          'header includes `kid` equal to the base64url-encoded (see section 5 of RFC4648) SHA-256 JWK Thumbprint of the key (see RFC7638)',
        ),
      },
      {
        kind: 'table',
        caption: 'Where verification fails, and what each failure means',
        columns: ['Step', 'What it means when it fails'],
        rows: [
          {
            cells: [
              'The payload will not inflate',
              'Sniff the first two bytes. 78 followed by 01, 5e, 9c or da is a zlib wrapper; 1f 8b is gzip. Both violate the raw-DEFLATE rule and both still verify cryptographically, because the signature is over the compressed bytes. Recover, and report the defect.',
            ],
          },
          {
            cells: [
              'iss is not usable',
              'It must be https with no trailing slash. The key set path is string concatenation, iss plus /.well-known/jwks.json, never URL resolution: resolving would throw away a deep path and fetch the wrong host root.',
            ],
          },
          {
            cells: [
              'The key set cannot be fetched',
              'This is the one place the specification does require CORS, so a browser failing here is a genuine issuer defect rather than a browser limitation. Measured across 18 real issuers, 16 answered 200 and every one of those carried the header.',
            ],
          },
          {
            cells: [
              'No key with that kid',
              'Ambiguous between not yet published, rotated out early, and withdrawn after a compromise. Say that, rather than picking one.',
            ],
          },
          {
            cells: [
              'The signature does not verify',
              'Different from the row above, and worth separating: a key was found and it did not sign this. Check the signature is 64 bytes of r followed by s rather than DER before blaming the key.',
            ],
          },
          {
            cells: [
              'Revocation is unknown',
              'The check only applies when the issuer’s key carries crlVersion. No crlVersion means revocation status is unknown, which is not the same as not revoked, and must not be displayed as if it were.',
            ],
          },
        ],
      },
      {
        kind: 'callout',
        tone: 'warn',
        title: 'A minified card has no display text at all',
        body: 'A card meant for a QR is stripped of Coding.display, CodeableConcept.text and the narrative, and its references are rewritten as resource:0, resource:1 and so on. So a viewer either carries its own code-to-display tables or shows a bare code, and it has to resolve references against the bundle’s own fullUrl index rather than by FHIR id, because the ids are gone too.',
      },
    ],
  },

  {
    id: 'errors',
    nav: 'Errors',
    title: 'The three defined statuses',
    lede: 'Everything else a server returns is undefined by the specification.',
    blocks: [
      {
        kind: 'table',
        caption: 'Defined manifest responses',
        columns: ['Status', 'Condition', 'What a client can conclude'],
        rows: ERROR_ROWS,
      },
      {
        kind: 'quote',
        citation: shl(
          'Manifest Response',
          'If the SMART Health Link is no longer active, the Resource Server SHALL respond with a 404.',
        ),
      },
      {
        kind: 'callout',
        tone: 'info',
        title: 'A 404 is ambiguous on purpose',
        body: 'Expired, revoked, disabled by too many wrong passcodes, mistyped and never existed all return the same 404 with no body. That is not a gap: a response that distinguished them would tell an attacker which links exist. So the honest reading is "the server will not say which", and the only local evidence is the exp in the link’s own payload. The reference server returns it with content-length zero, so a client must not require an error body.',
      },
      { kind: 'quote', citation: CITATIONS.passcodeFailure },
      {
        kind: 'callout',
        tone: 'fail',
        title: 'Never retry a passcode automatically',
        body: 'A server is required to enforce a lifetime count of incorrect passcodes and to disable the link when it is reached. So a retry loop, a backoff, a connection test carrying a guess, or a React effect that fires twice, each spends part of a finite budget belonging to the patient. Loupe counts every attempt, requires an explicit press, and says how many the server says remain. remainingAttempts of zero means the link is now permanently dead.',
      },
      { kind: 'quote', citation: CITATIONS.rateLimit },
      {
        kind: 'prose',
        paragraphs: [
          'Retry-After is not on the Fetch safelist of response headers script may read. So a cross-origin 429 gives a browser client the status and nothing else, unless the server also sends Access-Control-Expose-Headers naming it. That looks to a participant like a missing Retry-After and is in fact a missing Access-Control-Expose-Headers, which is a different conversation with a different person.',
          'There is no defined status for an expired link, for a missing recipient, for a malformed body, for a P link fetched with no passcode, or for a U link fetched with POST. Servers return 400, 404, 405 or 500 for those. Loupe shows the status and the body verbatim rather than pretending to know what they mean.',
        ],
      },
    ],
  },

  {
    id: 'cors',
    nav: 'CORS',
    title: 'CORS, and why a browser client is unsupported by construction',
    lede: 'The single most useful page here. It explains most of the "it works for me" at any event.',
    blocks: [
      {
        kind: 'callout',
        tone: 'fail',
        title: 'The SMART Health Links specification never mentions CORS',
        body: 'Not once, in any section. Searching the specification source for the word returns nothing. Every manifest request and every file fetch a browser makes therefore depends on a header no part of the specification requires anybody to send, and a server can be fully conformant and unusable from a browser at the same time. That single fact is the root cause of most disagreements at a testing event, and it is not a defect in anybody’s link.',
      },
      {
        kind: 'prose',
        paragraphs: [
          'The one place CORS is required is the health card issuer key set, in the cards specification. Nothing binds the manifest endpoint or the file endpoints.',
        ],
      },
      {
        kind: 'quote',
        citation: shc(
          'Determining keys associated with an issuer',
          'Issuers SHALL publish their public keys as JSON Web Key Sets (see RFC7517), available at `<<iss value from JWS>>` + `/.well-known/jwks.json`, with Cross-Origin Resource Sharing (CORS) enabled, using TLS version 1.2 following the IETF BCP 195 recommendations or TLS version 1.3 (with any configuration).',
        ),
      },
      {
        kind: 'prose',
        paragraphs: [
          'A downstream guide does close the gap, and its reasoning is worth repeating to a server operator who is nervous about it: the payload is already encrypted, so allowing a browser to read the response adds no confidentiality risk.',
        ],
      },
      {
        kind: 'quote',
        citation: {
          spec: 'KTC',
          section: 'Retrieval Protocol: Response',
          url: KTC_URL,
          quote:
            'Patient Apps SHOULD serve the retrieval endpoint with a permissive CORS policy (`Access-Control-Allow-Origin: *`) so that browser-based receivers can fetch payloads directly. The payload is encrypted, so CORS exposure adds no confidentiality risk.',
        },
      },
      {
        kind: 'prose',
        paragraphs: [
          'On the manifest path the preflight is unavoidable. The request is a POST with content-type application/json, and Fetch only safelists a content type of application/x-www-form-urlencoded, multipart/form-data or text/plain. So the browser sends an OPTIONS request first, every time, and the server has to answer it.',
        ],
      },
      {
        kind: 'quote',
        citation: fetchSpec(
          'CORS-safelisted request-header',
          'If mimeType’s essence is not "`application/x-www-form-urlencoded`", "`multipart/form-data`", or "`text/plain`", then return false.',
        ),
      },
      { kind: 'generated', generator: 'cors-headers' },
      {
        kind: 'prose',
        paragraphs: [
          'Miss any one of those and a browser reports a bare failure with no detail. The five distinct causes each have their own console message, which is where the truth actually lives, and none of it reaches JavaScript.',
        ],
      },
      {
        kind: 'table',
        caption: 'What the console says, by cause (Chromium wording)',
        columns: ['What is missing', 'Console message'],
        rows: CORS_FAILURE_ROWS,
      },
      { kind: 'generated', generator: 'preflight-curl' },
      {
        kind: 'callout',
        tone: 'warn',
        title: 'curl succeeding proves nothing about a browser',
        body: 'CORS is enforced only by browsers. A server with no CORS headers answers curl perfectly, which is why a sender who tests with curl is genuinely, reasonably confident their link is fine. Run the OPTIONS command above and read the response headers, not the status: a 200 with no Access-Control-Allow-Origin is the failure.',
      },
      {
        kind: 'prose',
        paragraphs: [
          'Two more CORS surfaces are easy to forget. A file location may be on a different origin from the manifest, because presigned bucket URLs are the specification’s own suggestion, and a bucket sends no CORS headers until somebody configures it. So the most common shape at an event is a manifest that loads and a file that does not. And a health card’s issuer key set is a third origin again.',
          'Requesting a large embeddedLengthMax is therefore a real mitigation and not just an optimisation: an embedded file arrives inside the manifest response, over a connection that has already proved it works.',
        ],
      },
      { kind: 'quote', citation: CITATIONS.corsProtocol },
    ],
  },
];

// ---------------------------------------------------------------------------
// The checks: what each static rule is about, beyond its own one-liner
// ---------------------------------------------------------------------------

export type RuleGroupId = 'reachability' | 'transport' | 'hygiene' | 'time' | 'flags' | 'network';

export interface RuleGroup {
  id: RuleGroupId;
  title: string;
  blurb: string;
}

export const RULE_GROUPS: readonly RuleGroup[] = [
  {
    id: 'reachability',
    title: 'Can anybody else reach it',
    blurb:
      'Decided from the host name alone, with no request made and no network condition able to change the answer. This group is where the argument at a table actually ends.',
  },
  {
    id: 'transport',
    title: 'Scheme, port and certificate',
    blurb:
      'What the browser will do with the URL before the server is involved, and what the URL suggests about what is listening.',
  },
  {
    id: 'hygiene',
    title: 'The URL itself',
    blurb:
      'Characters and parts that survive a copy and paste and then break the request while the URL still looks correct on screen.',
  },
  {
    id: 'time',
    title: 'Expiry',
    blurb:
      'Read from the payload against your own clock. exp is a hint: the server decides for real, so none of these are refusals.',
  },
  {
    id: 'flags',
    title: 'Flags',
    blurb: 'What the flags oblige a client to do, and the one combination that cannot work.',
  },
  {
    id: 'network',
    title: 'What is about to happen on the network',
    blurb:
      'Stated before the request goes out, so the request is not the first time you learn what it needed.',
  },
];

export interface RuleGuideEntry {
  ruleId: string;
  group: RuleGroupId;
  severity: Severity;
  /** Set when the severity depends on context, saying when the other one applies. */
  severityVaries?: string;
  audience: Audience;
  /** What would have to be true of a link for this to fire. */
  fires: string;
  /**
   * A sandbox preset that mints a link tripping this rule. The Sandbox screen
   * reads `#/sandbox?preset=<ruleId>`, so the rule id is the preset key: one
   * name, and a rule that loses its preset loses it visibly.
   */
  tryPreset?: string;
}

export const RULE_GUIDE: readonly RuleGuideEntry[] = [
  {
    ruleId: 'SHL-URL-LOOPBACK',
    group: 'reachability',
    severity: 'fatal',
    audience: 'sender',
    fires: 'The host is localhost, a 127.x address, ::1, 0.0.0.0 or anything ending .localhost.',
    tryPreset: 'SHL-URL-LOOPBACK',
  },
  {
    ruleId: 'SHL-URL-PRIVATE-NETWORK',
    group: 'reachability',
    severity: 'fatal',
    audience: 'sender',
    fires:
      'The host is an RFC 1918 address (10.x, 172.16 to 172.31, 192.168.x), carrier NAT (100.64/10), link-local (169.254.x, fe80::) or an fc00::/7 address.',
    tryPreset: 'SHL-URL-PRIVATE-NETWORK',
  },
  {
    ruleId: 'SHL-URL-UNRESOLVABLE-NAME',
    group: 'reachability',
    severity: 'fatal',
    audience: 'sender',
    fires:
      'The host is a single label with no dot, or ends in a special-use suffix such as .local, .internal or .home.arpa.',
    tryPreset: 'SHL-URL-UNRESOLVABLE-NAME',
  },
  {
    ruleId: 'SHL-URL-OVERLAY-NETWORK',
    group: 'reachability',
    severity: 'fatal',
    audience: 'sender',
    fires:
      'The host belongs to an overlay network such as Tailscale or ZeroTier. It resolves publicly, and routes only for devices joined to that network, which is the cruellest version of this failure: the name looks ordinary and even resolves for you.',
  },
  {
    ruleId: 'SHL-URL-EPHEMERAL-TUNNEL',
    group: 'reachability',
    severity: 'warning',
    audience: 'sender',
    fires:
      'The host is a temporary tunnel (ngrok, a Cloudflare quick tunnel, localtunnel and friends). Fine for a live demo, useless as something to send and open tomorrow.',
    tryPreset: 'SHL-URL-EPHEMERAL-TUNNEL',
  },
  {
    ruleId: 'SHL-URL-PREVIEW-DEPLOYMENT',
    group: 'reachability',
    severity: 'info',
    audience: 'sender',
    fires:
      'The host carries a build identifier, so it names one deployment rather than the service. It works now and points at an old build after the next deploy.',
  },
  {
    ruleId: 'SHL-URL-NOT-HTTPS',
    group: 'transport',
    severity: 'error',
    severityVaries:
      'Fatal when this page is served over https and the link is http, because the browser refuses the request as mixed content before it reaches the network. Nothing the server does can fix that from here.',
    audience: 'sender',
    fires: 'The scheme is not https.',
    tryPreset: 'SHL-URL-NOT-HTTPS',
  },
  {
    ruleId: 'SHL-URL-DEV-PORT',
    group: 'transport',
    severity: 'info',
    audience: 'sender',
    fires:
      'The port is a well-known development server port (5173, 3000, 8080, 7071 and the rest) on a host that is not loopback. Normal at an event, and worth knowing: such a server usually runs on a laptop, restarts often, and rarely carries CORS headers.',
    tryPreset: 'SHL-URL-DEV-PORT',
  },
  {
    ruleId: 'SHL-URL-IP-LITERAL',
    group: 'transport',
    severity: 'warning',
    audience: 'sender',
    fires:
      'The host is a public IP address rather than a name. A publicly trusted certificate for a bare IP is rare, so the handshake usually fails on a name mismatch, and a browser reports that as an ordinary connection failure.',
  },
  {
    ruleId: 'SHL-URL-USERINFO',
    group: 'hygiene',
    severity: 'error',
    audience: 'sender',
    fires:
      'The URL carries user:password@. Browsers refuse to fetch it at all, so no browser-based viewer can open the link whatever the server would have done.',
    tryPreset: 'SHL-URL-USERINFO',
  },
  {
    ruleId: 'SHL-URL-FRAGMENT',
    group: 'hygiene',
    severity: 'warning',
    audience: 'sender',
    fires:
      'The manifest URL has a #fragment. It is never sent to the server, so if the sender put an identifier there the server sees a request for something else.',
    tryPreset: 'SHL-URL-FRAGMENT',
  },
  {
    ruleId: 'SHL-URL-INVISIBLE-CHARACTER',
    group: 'hygiene',
    severity: 'error',
    audience: 'sender',
    fires:
      'The raw URL contains whitespace or an invisible character: a zero-width space, a non-breaking space, a bidi mark, a stray newline. Picked up from a slide, a document or a chat client, and invisible on screen.',
    tryPreset: 'SHL-URL-INVISIBLE-CHARACTER',
  },
  {
    ruleId: 'SHL-EXP-PAST',
    group: 'time',
    severity: 'fatal',
    audience: 'sender',
    fires:
      'exp is in the past by your clock. Read from the link with no request made, so if the sender disagrees, compare clocks and timezones first.',
    tryPreset: 'SHL-EXP-PAST',
  },
  {
    ruleId: 'SHL-EXP-IMMINENT',
    group: 'time',
    severity: 'warning',
    audience: 'you',
    fires: 'exp is within the hour. Open it now, and ask for a longer-lived one to demonstrate from.',
    tryPreset: 'SHL-EXP-IMMINENT',
  },
  {
    ruleId: 'SHL-EXP-MILLISECONDS',
    group: 'time',
    severity: 'error',
    audience: 'sender',
    fires:
      'exp is 1e11 or larger, so it is milliseconds where the specification counts seconds. The link then never expires, and every receiver reads a different intent from it.',
    tryPreset: 'SHL-EXP-MILLISECONDS',
  },
  {
    ruleId: 'SHL-EXP-LONG-LIVED',
    group: 'time',
    severity: 'info',
    audience: 'sender',
    fires:
      'exp is more than a year away and the L flag is absent. A wallet may treat a year-long link as a one-off rather than something to keep and poll.',
    tryPreset: 'SHL-EXP-LONG-LIVED',
  },
  {
    ruleId: 'SHL-FLAG-P',
    group: 'flags',
    severity: 'info',
    audience: 'you',
    fires:
      'The P flag is present, so a passcode is needed and it is not in the link. Attempts are counted for the life of the link, so Loupe never sends one you did not type.',
    tryPreset: 'SHL-FLAG-P',
  },
  {
    ruleId: 'SHL-FLAG-U-AND-P',
    group: 'flags',
    severity: 'error',
    audience: 'sender',
    fires:
      'Both U and P are present, which the specification forbids: U means a direct GET with no manifest exchange, and a passcode is a member of the manifest request body.',
    tryPreset: 'SHL-FLAG-U-AND-P',
  },
  {
    ruleId: 'SHL-FLAG-U',
    group: 'flags',
    severity: 'info',
    audience: 'nobody',
    fires:
      'The U flag is present, so Loupe issues a GET rather than a POST, and sends no recipient string in a body and no embeddedLengthMax.',
    tryPreset: 'SHL-FLAG-U',
  },
  {
    ruleId: 'SHL-CORS-PREFLIGHT-EXPECTED',
    group: 'network',
    severity: 'info',
    audience: 'server',
    fires:
      'The manifest origin differs from this page’s origin, which is nearly always. Stated before the request, because a browser reports nothing useful after it.',
  },
];

// ---------------------------------------------------------------------------
// The network differential
// ---------------------------------------------------------------------------

export interface DifferentialNote {
  title: string;
  /** What this cause is, independent of any particular link. */
  what: string;
  /** The cheapest test that confirms or eliminates it. */
  discriminator: string;
  /** Who would have to fix it. */
  owner: 'sender' | 'server' | 'you' | 'network';
}

/**
 * Keyed by `CauseId`, so the compiler fails the build if a cause is added to
 * `core/diagnose/differential.ts` and not explained here. The wording in the
 * differential itself is per-link and ranked; this is the standing description
 * of each candidate.
 */
export const DIFFERENTIAL_NOTES: Record<CauseId, DifferentialNote> = {
  'cors-missing': {
    title: 'The server answered and the browser would not hand it over',
    what: 'The response arrived without an Access-Control-Allow-Origin naming this page, so the browser discarded it. By a wide margin the most common cause of a link that works in curl and fails in every browser, because the specification never asked anybody for the header.',
    discriminator:
      'Run the OPTIONS command from a shell and read the response headers. curl succeeds either way, so the status is not the answer: the presence of the header is.',
    owner: 'server',
  },
  'cors-preflight-unimplemented': {
    title: 'The POST is routed and the OPTIONS before it is not',
    what: 'A manifest POST carries a JSON content type, so a browser sends OPTIONS first. Frameworks routinely route POST and let OPTIONS fall through to a 404 or a 405, which fails the whole request before the POST is ever attempted.',
    discriminator: 'The OPTIONS command below. A 404 or 405 there is conclusive.',
    owner: 'server',
  },
  'dns-nxdomain': {
    title: 'The name does not resolve',
    what: 'There is no address behind the host name, so nothing was ever going to answer. A browser cannot tell you this directly, but a DNS-over-HTTPS lookup can, which is why that probe exists and why it is opt-in.',
    discriminator: 'dig +short on the host name, or enable the DNS check here.',
    owner: 'sender',
  },
  'connection-refused': {
    title: 'Nothing is listening on that port',
    what: 'The name resolves and the port is closed: usually a development server that is not running right now. A refused connection fails almost immediately, so a very fast failure is weak evidence for this and slow evidence against it.',
    discriminator: 'curl -v --connect-timeout 5 against the origin.',
    owner: 'sender',
  },
  'tls-untrusted': {
    title: 'The certificate is not trusted here',
    what: 'A self-signed or locally generated certificate is trusted on the machine that made it and nowhere else, which is exactly the shape of a link that opens for its author alone.',
    discriminator:
      'Open the origin in a new tab. A certificate problem shows an interstitial you can read, which fetch never does.',
    owner: 'sender',
  },
  'tls-name-mismatch': {
    title: 'The certificate does not cover that name',
    what: 'Common when the URL uses an IP address, or a tunnel host that terminates TLS for a different name. The browser refuses before any HTTP happens.',
    discriminator: 'openssl s_client -connect host:port and read the subject and SAN entries.',
    owner: 'sender',
  },
  'mixed-content': {
    title: 'The browser blocked it before it left',
    what: 'This page is https and the target is http, so no request was made at all. Nothing about the server is being tested, and nothing the server changes can help while this viewer runs over https.',
    discriminator:
      'None needed. It is decided inside the browser and it is certain. Loopback is the exception: http://localhost counts as potentially trustworthy and is not blocked.',
    owner: 'sender',
  },
  'firewall-or-captive-portal': {
    title: 'The network you are on is in the way',
    what: 'Conference and hospital networks intercept or drop traffic to unusual ports and unfamiliar hosts, and a captive portal swallows everything until you sign in.',
    discriminator: 'Retry on a phone hotspot.',
    owner: 'network',
  },
  'extension-or-tracking-protection': {
    title: 'Something in the browser cancelled it',
    what: 'Content blockers, enterprise policy extensions and strict tracking protection cancel requests in a way that is indistinguishable from a network failure to the page.',
    discriminator: 'Retry in a private window with extensions disabled.',
    owner: 'you',
  },
  'server-hung': {
    title: 'Something answered and then stopped',
    what: 'The connection was accepted and no response arrived. A long failure duration points here, and a fast one rules it out.',
    discriminator: 'curl -v with a generous timeout, and watch where it stalls.',
    owner: 'server',
  },
  'host-unreachable-from-here': {
    title: 'The address is not reachable from this machine at all',
    what: 'Loopback, a private network, an unresolvable name. When this is true the other candidates are moot: nothing was ever going to answer, and no server-side change makes any difference.',
    discriminator: 'curl -v against the origin from this machine fails in the same way.',
    owner: 'sender',
  },
};

// ---------------------------------------------------------------------------
// Enumeration helpers, for the screens and for the test
// ---------------------------------------------------------------------------

function citationsInBlock(block: GuideBlock): Citation[] {
  switch (block.kind) {
    case 'quote':
      return [block.citation];
    case 'members':
      return block.members.flatMap((member) =>
        member.alsoSee === undefined ? [member.quote] : [member.quote, member.alsoSee],
      );
    case 'wire':
      return block.members.flatMap((member) => (member.quote === undefined ? [] : [member.quote]));
    case 'flags':
      return block.flags.map((flag) => flag.quote);
    default:
      return [];
  }
}

/** Every citation the guide renders, so the test can check all of them at once. */
export function allGuideCitations(): Citation[] {
  return GUIDE_SECTIONS.flatMap((section) => section.blocks.flatMap(citationsInBlock));
}

/** Every anatomy segment, flattened, for whole-string and target checks. */
export function allAnatomySegments(): Array<{ anatomy: Anatomy; segment: AnatomySegment }> {
  return Object.values(ANATOMIES).flatMap((anatomy) =>
    anatomy.segments.map((segment) => ({ anatomy, segment })),
  );
}

export function sectionById(id: SectionId): GuideSection | undefined {
  return GUIDE_SECTIONS.find((section) => section.id === id);
}

/** The DOM id a segment target scrolls to. One rule, so nothing drifts. */
export function anchorForTarget(target: AnatomyTarget): string {
  switch (target.to) {
    case 'member':
      return `member-${target.member}`;
    case 'section':
      return `section-${target.section}`;
    case 'anatomy':
      return `anatomy-${target.anatomy}`;
  }
}

/** What the tinted segment says it will do, for the click affordance's label. */
export function labelForTarget(target: AnatomyTarget): string {
  switch (target.to) {
    case 'member':
      return `Go to the ${target.member} member`;
    case 'section': {
      const section = sectionById(target.section);
      return `Go to ${section === undefined ? target.section : section.title}`;
    }
    case 'anatomy':
      return `Go to ${ANATOMIES[target.anatomy].title}`;
  }
}
