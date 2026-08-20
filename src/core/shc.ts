/**
 * SMART Health Cards: decode, inspect, and verify, with a nameable failure at
 * every step.
 *
 * Three decisions shape this file, and each is a response to something the
 * incumbent tools get wrong.
 *
 * 1. **Our own error taxonomy, not a library's.** `smart-health-card-decoder`
 *    and `jose` both collapse a dozen distinct causes into one rejected promise.
 *    A viewer that can only say "verification failed" cannot tell an engineer
 *    whether the issuer rotated a key, published a JWKS without CORS, signed
 *    over a double-hashed input, or is simply absent from a directory. Every
 *    step below checks its own precondition and reports which one broke.
 *
 * 2. **The ladder is always fully reported.** A step that was never reached
 *    reports as `not-reached`, never as a pass and never as a silent omission.
 *    Saying "the signature was not checked, because the key set could not be
 *    fetched" is the whole product; saying nothing is how a reader concludes a
 *    card is fine when it was never examined.
 *
 * 3. **No request happens that the caller did not ask for.** The JWKS fetch and
 *    the CRL fetch are consequences of verifying a specific card, so they run
 *    through the injected {@link Transport} and appear in the trace. A trust
 *    directory is a third party with no relationship to the card, so it is
 *    fetched only when a caller passes one in, with its URL on screen.
 *
 * Independence from the implementations under test is deliberate: this module
 * uses WebCrypto, {@link ./jose} and {@link ./compress} only. Sharing a library
 * with the thing being judged hides exactly the class of defect an event exists
 * to surface (a doubly-hashed signing input round-trips against itself forever).
 */
import { base64urlToBytes, toArrayBuffer, utf8Decode, utf8Encode } from './bytes';
import { CITATIONS } from './citations';
import { inflateForgiving, type CompressionFraming } from './compress';
import { classifyHost, reachIsUnreachableByOthers } from './diagnose/host';
import type { RuleOutput } from './diagnose/rules';
import {
  canonicaliseP256Coordinate,
  JoseError,
  jwkThumbprint,
  parseJwsCompact,
  verifyEs256,
  type EcJwk,
  type JwsParts,
} from './jose';
import { failureToResponseRecord, toRequestRecord, toResponseRecord } from './net/browser';
import { NetworkFailure, type Transport, type TransportRequest } from './net/transport';
import type { Audience, Citation, HttpRequestRecord, HttpResponseRecord, Severity } from './trace';

// ---------------------------------------------------------------------------
// Citations this module needs that the shared registry does not carry yet
// ---------------------------------------------------------------------------

/**
 * `src/core/citations.ts` is the home for spec references and is owned
 * elsewhere; these three sections are the ones it does not name yet. They are
 * quoted here verbatim rather than paraphrased so the wording can be checked
 * once against the published spec, and they belong in that registry the next
 * time it is edited.
 */
const SHC_SPEC =
  'https://build.fhir.org/ig/HL7/smart-health-cards-and-links/cards-specification.html';

const SHC_CITATIONS = {
  qrEncoding: {
    spec: 'SMART Health Cards',
    section: 'Encoding QRs',
    url: `${SHC_SPEC}#encoding-qrs`,
    quote:
      'Each character "c" of the JWS is converted into a sequence of two digits as by taking Ord(c)-45 and treating the result as a two-digit base ten number.',
  },
  chunking: {
    spec: 'SMART Health Cards',
    section: 'Encoding QRs (chunking)',
    url: `${SHC_SPEC}#encoding-qrs`,
    quote:
      'Any JWS longer than 1195 characters SHALL be split into "chunks" of length 1191 or smaller; each chunk SHALL be encoded as a separate QR code of V22 or lower.',
  },
  issuerKeys: {
    spec: 'SMART Health Cards',
    section: 'Determining keys associated with an issuer',
    url: `${SHC_SPEC}#determining-keys-associated-with-an-issuer`,
    quote:
      'Issuers SHALL publish their public keys as JSON Web Key Sets, available at <<iss value from JWS>> + /.well-known/jwks.json, with Cross-Origin Resource Sharing (CORS) enabled.',
  },
  issuerUrl: {
    spec: 'SMART Health Cards',
    section: 'Determining keys associated with an issuer',
    url: `${SHC_SPEC}#determining-keys-associated-with-an-issuer`,
    quote:
      'The URL at <<iss value from JWS>> SHALL use the https scheme and SHALL NOT include a trailing /.',
  },
  revocation: {
    spec: 'SMART Health Cards',
    section: 'Revocation',
    url: `${SHC_SPEC}#revocation`,
    quote:
      'If the crlVersion is present in the Issuer’s JWK for key <<kid>>, Verifiers SHALL download the https://"<<Issuer URL>>"/.well-known/crl/"<<kid>>".json file or use a cached version if the counter value has not changed since the last retrieval.',
  },
  expiration: {
    spec: 'SMART Health Cards',
    section: 'Expiration of Health Cards',
    url: `${SHC_SPEC}#expiration-of-health-cards`,
    quote:
      'Verifiers SHALL check the expiration, if present, and reject SMART Health Cards with an exp value that is before the current verification date-time.',
  },
  trust: {
    spec: 'SMART Health Cards',
    section: 'Frequently asked questions: verifier security considerations',
    url: `${SHC_SPEC}#frequently-asked-questions`,
    quote:
      'The specified validation steps ensure that a presented health card was properly signed by an issuer key. How to trust that key is application/organization specific.',
  },
} as const satisfies Record<string, Citation>;

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

interface FindingExtras {
  remedy?: string;
  citation?: Citation;
}

const finding = (
  ruleId: string,
  severity: Severity,
  audience: Audience,
  title: string,
  detail: string,
  extras: FindingExtras = {},
): RuleOutput => ({ ruleId, severity, audience, title, detail, ...extras });

// ---------------------------------------------------------------------------
// The verification ladder
// ---------------------------------------------------------------------------

export type CheckId =
  | 'jws-shape'
  | 'header-alg'
  | 'header-zip'
  | 'header-kid'
  | 'signature-form'
  | 'payload-inflate'
  | 'payload-json'
  | 'iss-url'
  | 'jwks-fetch'
  | 'jwks-json'
  | 'kid-in-jwks'
  | 'key-shape'
  | 'key-usage'
  | 'key-thumbprint'
  | 'signature'
  | 'nbf'
  | 'exp'
  | 'vc-type'
  | 'fhir-bundle'
  | 'revocation'
  | 'trust-directory';

export type CheckState = 'pass' | 'warn' | 'fail' | 'not-reached' | 'skipped';

export interface VerificationCheck {
  id: CheckId;
  /** What this check asserts, phrased so a pass reads as a true sentence. */
  label: string;
  state: CheckState;
  /** Why it has the state it has. Always set for anything other than a pass. */
  detail?: string;
}

/**
 * Order is the verification order, not a display preference: the earliest
 * failure is the headline, and everything after it is honestly "not reached".
 */
const LADDER: ReadonlyArray<{ id: CheckId; label: string }> = [
  { id: 'jws-shape', label: 'The card splits into three base64url segments' },
  { id: 'header-alg', label: 'The JWS header names alg ES256' },
  { id: 'header-zip', label: 'The JWS header names zip DEF' },
  { id: 'header-kid', label: 'The JWS header carries a kid' },
  { id: 'signature-form', label: 'The signature is 64-byte r-then-s, not DER' },
  { id: 'payload-inflate', label: 'The payload inflates as raw DEFLATE' },
  { id: 'payload-json', label: 'The payload is minified UTF-8 JSON' },
  { id: 'iss-url', label: 'iss is an https URL with no trailing slash' },
  { id: 'jwks-fetch', label: "The issuer's key set is reachable from a browser" },
  { id: 'jwks-json', label: 'The key set is JSON carrying a keys array' },
  { id: 'kid-in-jwks', label: "The key set contains the card's kid" },
  { id: 'key-shape', label: 'That key is EC P-256 and carries no private parameter' },
  { id: 'key-usage', label: 'Its use, alg and key_ops permit signature verification' },
  { id: 'key-thumbprint', label: 'Its kid equals the RFC 7638 thumbprint of its own coordinates' },
  { id: 'signature', label: 'The ES256 signature verifies over header.payload' },
  { id: 'nbf', label: 'The card is valid now (nbf)' },
  { id: 'exp', label: 'The card has not expired (exp)' },
  { id: 'vc-type', label: 'vc.type contains the health-card type' },
  { id: 'fhir-bundle', label: 'vc.credentialSubject.fhirBundle is present' },
  { id: 'revocation', label: 'The card is not on the issuer revocation list' },
  { id: 'trust-directory', label: 'The issuer appears in a trust directory you accept' },
];

/**
 * Accumulates check states and always emits the whole ladder.
 *
 * The default is `not-reached`, which is the point: an implementation that
 * builds its result by pushing only the checks it happened to run reports a card
 * whose signature was never examined identically to one that verified.
 */
class Ladder {
  private readonly states = new Map<CheckId, { state: CheckState; detail?: string }>();

  set(id: CheckId, state: CheckState, detail?: string): void {
    this.states.set(id, { state, ...(detail === undefined ? {} : { detail }) });
  }

  /** Record a state only if this check has not already been decided. */
  fill(id: CheckId, state: CheckState, detail?: string): void {
    if (!this.states.has(id)) this.set(id, state, detail);
  }

  merge(checks: readonly VerificationCheck[]): void {
    for (const check of checks) this.set(check.id, check.state, check.detail);
  }

  state(id: CheckId): CheckState {
    return this.states.get(id)?.state ?? 'not-reached';
  }

  list(): VerificationCheck[] {
    return LADDER.map((entry) => {
      const held = this.states.get(entry.id);
      return {
        id: entry.id,
        label: entry.label,
        state: held?.state ?? 'not-reached',
        ...(held?.detail === undefined ? {} : { detail: held.detail }),
      };
    });
  }
}

// ---------------------------------------------------------------------------
// Posture
// ---------------------------------------------------------------------------

/**
 * The one thing a reader takes away, and it always has a value.
 *
 * `not-signed` exists because the incumbent viewer renders nothing at all for a
 * plain `application/fhir+json` SHL file, so the most important sentence about
 * that payload never gets said: nothing in it is cryptographically verified.
 */
export type VerificationPosture =
  | 'verified'
  | 'verified-with-warnings'
  | 'invalid'
  | 'unverifiable'
  | 'not-checked'
  | 'not-signed';

export const POSTURE: Record<VerificationPosture, { word: string; meaning: string }> = {
  verified: {
    word: 'Signature verified',
    meaning:
      "The signature verifies against a key the issuer publishes at its own domain, so the contents are exactly what that issuer signed. Whether you trust the issuer is a separate question this tool cannot answer for you.",
  },
  'verified-with-warnings': {
    word: 'Verified, with defects',
    meaning:
      'The signature verifies, so the contents are what the issuer signed. Something else about the card breaks a rule in the specification, which is a producer defect rather than a reason to distrust the contents.',
  },
  invalid: {
    word: 'Not valid',
    meaning:
      'A check that decides validity failed: the signature did not verify, or the card is revoked, expired or not yet valid. Nothing in the contents should be relied on.',
  },
  unverifiable: {
    word: 'Cannot be verified',
    meaning:
      "The card is signed, but the signature could not be checked, because the issuer's key set could not be fetched or does not contain the key this card names. This says nothing about whether the contents are genuine.",
  },
  'not-checked': {
    word: 'Not checked yet',
    meaning:
      "No signature check has been run. Checking one means fetching the issuer's key set, which is a request to the issuer, so Loupe waits for you to ask.",
  },
  'not-signed': {
    word: 'Not signed',
    meaning:
      'This payload carries no signature, so nothing here is cryptographically verified. It arrived encrypted, which proves whoever sent it held the link key, and it proves nothing about who authored the contents.',
  },
};

/**
 * Checks whose failure means "this card is not valid", as against a conformance
 * defect. Only these can produce an `invalid` posture, and only these are
 * refused a downgrade in permissive mode.
 */
const DECIDES_VALIDITY: ReadonlySet<CheckId> = new Set<CheckId>([
  'signature',
  'nbf',
  'exp',
  'revocation',
]);

// ---------------------------------------------------------------------------
// The .smart-health-card file wrapper
// ---------------------------------------------------------------------------

export interface HealthCardFile {
  /** The JWS strings, in order, trimmed. One entry per card. */
  cards: string[];
  /** Top-level members the specification does not define. */
  extraMembers: string[];
  findings: RuleOutput[];
}

/**
 * Parse the `{ "verifiableCredential": [...] }` wrapper.
 *
 * Every malformation recovers as far as it can and reports what it did, because
 * a debugger that refuses the file has thrown away the one thing the user came
 * for. The array is 1..* and its entries may come from different issuers, so
 * nothing here collapses them into a single verdict.
 */
export function parseHealthCardFile(value: unknown): HealthCardFile {
  const findings: RuleOutput[] = [];

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    findings.push(
      finding(
        'SHC-FILE-NOT-AN-OBJECT',
        'fatal',
        'sender',
        `A health card file must be a JSON object; this is ${describeJsonType(value)}.`,
        'The file that carries SMART Health Cards is a JSON object with one member, verifiableCredential, holding an array of signed card strings. What arrived is not an object at all, so there is nothing to look for the array in.',
        { citation: CITATIONS.shcFile },
      ),
    );
    return { cards: [], extraMembers: [], findings };
  }

  const record = value as Record<string, unknown>;
  const extraMembers = Object.keys(record).filter((key) => key !== 'verifiableCredential');
  const raw = record.verifiableCredential;

  if (raw === undefined) {
    findings.push(
      finding(
        'SHC-FILE-NO-VERIFIABLE-CREDENTIAL',
        'fatal',
        'sender',
        'This object has no verifiableCredential member.',
        `The only member a health card file defines is verifiableCredential. This object carries ${
          extraMembers.length === 0 ? 'no members at all' : `${listOut(extraMembers)} instead`
        }, so there are no cards to verify.`,
        { citation: CITATIONS.shcFile },
      ),
    );
    return { cards: [], extraMembers, findings };
  }

  let entries: unknown[];
  if (Array.isArray(raw)) {
    entries = raw;
  } else if (typeof raw === 'string') {
    // Recover loudly: a bare string here is a producer that wrote the single
    // card it had rather than an array of one, and the cards inside are still
    // perfectly checkable.
    entries = [raw];
    findings.push(
      finding(
        'SHC-FILE-VC-NOT-AN-ARRAY',
        'error',
        'sender',
        'verifiableCredential is a single string, not an array.',
        'The specification defines verifiableCredential as an array holding one or more card strings, so a receiver that iterates it will read one character per pass or reject the file. Loupe treated the string as an array of one and carried on.',
        {
          remedy: 'Wrap the card string in an array: "verifiableCredential": ["<jws>"].',
          citation: CITATIONS.shcFile,
        },
      ),
    );
  } else {
    findings.push(
      finding(
        'SHC-FILE-VC-NOT-AN-ARRAY',
        'fatal',
        'sender',
        `verifiableCredential is ${describeJsonType(raw)}, not an array.`,
        'The member has to be an array of compact JWS strings. There is no way to read cards out of this value.',
        { citation: CITATIONS.shcFile },
      ),
    );
    return { cards: [], extraMembers, findings };
  }

  if (entries.length === 0) {
    findings.push(
      finding(
        'SHC-FILE-VC-EMPTY',
        'fatal',
        'sender',
        'verifiableCredential is an empty array.',
        'The array is defined as holding one or more cards. An empty array is a file that says it carries health cards and carries none, which is usually a producer serialising before it had signed anything.',
        { citation: CITATIONS.shcFile },
      ),
    );
    return { cards: [], extraMembers, findings };
  }

  const cards: string[] = [];
  entries.forEach((entry, index) => {
    if (typeof entry !== 'string') {
      findings.push(
        finding(
          'SHC-FILE-VC-ENTRY-NOT-A-STRING',
          'error',
          'sender',
          `verifiableCredential[${index}] is ${describeJsonType(entry)}, not a card string.`,
          'Each entry is a compact JWS: three base64url segments separated by dots. An object here usually means the producer emitted the decoded card instead of the signed one, which cannot be verified because the signature is gone.',
          { citation: CITATIONS.shcFile },
        ),
      );
      return;
    }
    const trimmed = entry.trim();
    if (trimmed !== entry) {
      findings.push(
        finding(
          'SHC-JWS-SURROUNDING-WHITESPACE',
          'warning',
          'sender',
          `verifiableCredential[${index}] has whitespace around the card string.`,
          'The signature covers the exact bytes of the header and payload segments, so a receiver that does not trim first will fail verification on a card that is otherwise fine. Loupe trimmed it.',
        ),
      );
    }
    if (trimmed.length > 0) cards.push(trimmed);
  });

  if (extraMembers.length > 0) {
    findings.push(
      finding(
        'SHC-FILE-EXTRA-MEMBERS',
        'info',
        'sender',
        `The file carries ${listOut(extraMembers)} alongside verifiableCredential.`,
        'No other top-level member is defined for this file type. Extra members are not an error and receivers must ignore them, but they are a reliable sign of a producer improvising its own format alongside the standard one.',
        { citation: CITATIONS.shcFile },
      ),
    );
  }

  if (cards.length > 1) {
    findings.push(
      finding(
        'SHC-FILE-MULTIPLE-CARDS',
        'info',
        'nobody',
        `This file carries ${cards.length} cards.`,
        'A file may hold several cards, and they may come from different issuers with different keys. Each one is verified independently below; there is no single verdict for the file.',
        { citation: CITATIONS.shcFile },
      ),
    );
  }

  return { cards, extraMembers, findings };
}

// ---------------------------------------------------------------------------
// The shc:/ numeric QR encoding
// ---------------------------------------------------------------------------

const SHC_PREFIX = 'shc:/';

/** `Ord(c) - 45`, where 45 is the ordinal of `-`, the lowest character a compact JWS can contain. */
const SHC_ORD_OFFSET = 45;

/** The compact JWS charset tops out at `z` (122), so `77` is the highest legal pair. */
const SHC_MAX_PAIR = 122 - SHC_ORD_OFFSET;

/** A single QR at version 22 with low error correction holds this many JWS characters. */
export const SINGLE_QR_MAX_JWS_CHARS = 1195;

export type ShcQrDecode =
  | {
      ok: true;
      /** 1-indexed, as the wire format is. A single QR reports 1 of 1. */
      chunkIndex: number;
      chunkTotal: number;
      /** The JWS characters this QR carries: the whole card when chunkTotal is 1. */
      chunk: string;
      findings: RuleOutput[];
    }
  | { ok: false; findings: RuleOutput[] };

/**
 * Decode one scanned `shc:/` string.
 *
 * The chunked `shc:/C/N/` prefix is deprecated but still in the field, so it is
 * recognised, reported, and returned as an ordinal rather than being silently
 * folded into the payload. Note the ordinal is **1-indexed** on the wire even
 * though the spec's own published example filenames are 0-indexed; taking the
 * filename as the ordinal is a real and confusing bug.
 */
export function decodeShcQr(numeric: string): ShcQrDecode {
  const findings: RuleOutput[] = [];
  const scanned = numeric.trim();

  if (!scanned.startsWith(SHC_PREFIX)) {
    const looksNumeric = /^\d+$/.test(scanned);
    findings.push(
      finding(
        'SHC-QR-NO-PREFIX',
        'fatal',
        'you',
        'This is not an shc:/ QR payload.',
        looksNumeric
          ? 'The value is all digits, which is the right shape for the numeric segment of a health card QR, but the leading "shc:/" is missing. Some scanners drop the first QR segment when a code mixes byte mode and numeric mode.'
          : `A health card QR starts with the exact characters "shc:/". This one starts with ${JSON.stringify(scanned.slice(0, 12))}.`,
        {
          ...(looksNumeric
            ? { remedy: 'Prepend "shc:/" and try again, or rescan with a different scanner.' }
            : {}),
          citation: SHC_CITATIONS.qrEncoding,
        },
      ),
    );
    return { ok: false, findings };
  }

  let body = scanned.slice(SHC_PREFIX.length);
  let chunkIndex = 1;
  let chunkTotal = 1;

  const chunked = /^(\d+)\/(\d+)\//.exec(body);
  if (chunked) {
    chunkIndex = Number(chunked[1]);
    chunkTotal = Number(chunked[2]);
    body = body.slice(chunked[0].length);
    findings.push(
      finding(
        'SHC-QR-CHUNKED',
        'info',
        'sender',
        `This is chunk ${chunkIndex} of ${chunkTotal}.`,
        'Splitting a card across several QR codes has been deprecated since December 2022 because it was never widely implemented in scanners. A card that needs more than one QR is better delivered as a SMART Health Link.',
        { citation: SHC_CITATIONS.chunking },
      ),
    );
    if (chunkTotal === 1) {
      findings.push(
        finding(
          'SHC-QR-POINTLESS-CHUNKING',
          'warning',
          'sender',
          'The card is chunked into a set of one.',
          'A single-chunk set carries the chunking prefix without needing it, and scanners that do not implement chunking will reject the whole code rather than reading the card inside it.',
          { citation: SHC_CITATIONS.chunking },
        ),
      );
    }
    if (chunkIndex < 1 || chunkIndex > chunkTotal) {
      findings.push(
        finding(
          'SHC-QR-CHUNK-ORDINAL',
          'error',
          'sender',
          `Chunk ordinal ${chunkIndex} is outside the set of ${chunkTotal}.`,
          'Ordinals are 1-indexed and run up to the total. An ordinal of 0 is the signature of a producer that numbered its chunks from zero, which makes the first and last chunks impossible to place.',
          { citation: SHC_CITATIONS.chunking },
        ),
      );
    }
  }

  if (body.length === 0) {
    findings.push(
      finding(
        'SHC-QR-EMPTY',
        'fatal',
        'you',
        'The QR carries a prefix and no digits.',
        'Everything after "shc:/" (and after the chunk prefix, if there is one) is the numeric segment. There is nothing here to decode.',
        { citation: SHC_CITATIONS.qrEncoding },
      ),
    );
    return { ok: false, findings };
  }

  const nonDigit = /\D/.exec(body);
  if (nonDigit) {
    findings.push(
      finding(
        'SHC-QR-NON-DIGIT',
        'fatal',
        'you',
        `The numeric segment contains ${JSON.stringify(nonDigit[0])} at position ${nonDigit.index}.`,
        'The segment after the prefix is numeric-mode QR data: digits only, two per character of the card. A letter here usually means the scanner returned the card as text rather than as the numeric segment, or that two QR codes were concatenated.',
        { citation: SHC_CITATIONS.qrEncoding },
      ),
    );
    return { ok: false, findings };
  }

  if (body.length % 2 !== 0) {
    findings.push(
      finding(
        'SHC-QR-ODD-DIGIT-COUNT',
        'fatal',
        'you',
        `The numeric segment has ${body.length} digits, which is an odd number.`,
        'Every character of the card is exactly two digits, so a valid segment always has an even length. An odd count means the scan lost at least one digit, which happens with a damaged or partly obscured code.',
        { remedy: 'Rescan the code.', citation: SHC_CITATIONS.qrEncoding },
      ),
    );
    return { ok: false, findings };
  }

  let chunk = '';
  for (let i = 0; i < body.length; i += 2) {
    const pair = body.slice(i, i + 2);
    const value = Number(pair);
    if (value > SHC_MAX_PAIR) {
      findings.push(
        finding(
          'SHC-QR-PAIR-OUT-OF-RANGE',
          'fatal',
          'you',
          `The digit pair "${pair}" at position ${i} cannot come from a health card.`,
          `Pairs encode Ord(c) - 45 over the compact JWS character set, so the only legal values are 00 (for "-") through ${SHC_MAX_PAIR} (for "z"). A pair above ${SHC_MAX_PAIR} means the numeric data is corrupt or belongs to something other than a health card.`,
          { citation: SHC_CITATIONS.qrEncoding },
        ),
      );
      return { ok: false, findings };
    }
    chunk += String.fromCharCode(value + SHC_ORD_OFFSET);
  }

  // A compact JWS always begins with the base64url of `{"`, so every real card
  // starts `eyJ` and every real QR starts `shc:/5676290`. Cheap, high-signal.
  if (chunkIndex === 1 && !chunk.startsWith('eyJ')) {
    findings.push(
      finding(
        'SHC-QR-NOT-A-JWS-START',
        'error',
        'you',
        'The decoded characters do not start a JSON Web Signature.',
        `Every health card starts with "eyJ", the base64url of a JSON object opening, so every first QR starts with the digits 567629. This one decodes to ${JSON.stringify(chunk.slice(0, 8))}.`,
        { citation: SHC_CITATIONS.qrEncoding },
      ),
    );
  }

  return { ok: true, chunkIndex, chunkTotal, chunk, findings };
}

export interface ShcQrAssembly {
  /** The reassembled card, present only when every chunk is in hand. */
  jws?: string;
  total?: number;
  present: number[];
  missing: number[];
  findings: RuleOutput[];
}

/**
 * Reassemble a chunked set from scans that may arrive in any order.
 *
 * Order independence is required of consumers by the spec, and it is also the
 * only humane behaviour: nobody scanning three codes off a phone screen at a
 * table can control which one the camera locks onto first.
 */
export function assembleShcQrChunks(scans: readonly string[]): ShcQrAssembly {
  const findings: RuleOutput[] = [];
  const parts = new Map<number, string>();
  const totals = new Set<number>();
  // A conflict poisons the whole set, not just the chunk it was found on. The
  // finding raised below says reassembling two cards produces something that
  // verifies against nothing, so returning a jws anyway would contradict it, and
  // a caller that trusted the jws over the findings would then verify a card
  // nobody issued.
  let conflicted = false;

  for (const scan of scans) {
    const decoded = decodeShcQr(scan);
    findings.push(...decoded.findings.filter((f) => f.ruleId !== 'SHC-QR-CHUNKED'));
    if (!decoded.ok) continue;
    totals.add(decoded.chunkTotal);
    const held = parts.get(decoded.chunkIndex);
    if (held !== undefined && held !== decoded.chunk) {
      findings.push(
        finding(
          'SHC-QR-CHUNK-CONFLICT',
          'fatal',
          'you',
          `Two different scans both claim to be chunk ${decoded.chunkIndex}.`,
          'The two carry different data, so they come from two different cards. Reassembling them would produce a card that verifies against nothing.',
          { remedy: 'Clear the scanned set and rescan one card at a time.' },
        ),
      );
      conflicted = true;
      continue;
    }
    parts.set(decoded.chunkIndex, decoded.chunk);
  }

  if (conflicted) {
    return { present: [...parts.keys()].sort((a, b) => a - b), missing: [], findings };
  }

  if (totals.size > 1) {
    findings.push(
      finding(
        'SHC-QR-CHUNK-TOTAL-DISAGREE',
        'fatal',
        'sender',
        `The scans disagree about how many chunks there are (${[...totals].sort().join(' and ')}).`,
        'Every chunk of one card carries the same total. Two totals means two different cards have been scanned into one set.',
        { citation: SHC_CITATIONS.chunking },
      ),
    );
    return { present: [...parts.keys()].sort((a, b) => a - b), missing: [], findings };
  }

  const total = [...totals][0];
  if (total === undefined) {
    return { present: [], missing: [], findings };
  }

  const present = [...parts.keys()].sort((a, b) => a - b);
  const missing: number[] = [];
  for (let index = 1; index <= total; index += 1) if (!parts.has(index)) missing.push(index);

  if (missing.length > 0) {
    findings.push(
      finding(
        'SHC-QR-MISSING-CHUNK',
        'fatal',
        'you',
        `${missing.length} of ${total} chunks ${missing.length === 1 ? 'is' : 'are'} still missing (${missing.join(', ')}).`,
        'A chunked card cannot be verified until the whole set is in hand, because the signature covers the reassembled card. Nothing partial is checkable.',
        { remedy: `Scan the QR code${missing.length === 1 ? '' : 's'} numbered ${missing.join(', ')}.`, citation: SHC_CITATIONS.chunking },
      ),
    );
    return { total, present, missing, findings };
  }

  const ordered: string[] = [];
  for (let index = 1; index <= total; index += 1) ordered.push(parts.get(index) as string);

  const sizes = ordered.map((part) => part.length);
  const largest = Math.max(...sizes);
  const smallest = Math.min(...sizes);
  if (total > 1 && largest > smallest * 2) {
    findings.push(
      finding(
        'SHC-QR-UNBALANCED-CHUNKS',
        'warning',
        'sender',
        `The chunks are unbalanced (${sizes.join(', ')} characters).`,
        'Producers should balance chunk sizes so every code in the set scans as easily as the others. A 1191-character chunk beside a 9-character one means one code is dense and hard to read while the other is nearly empty.',
        { citation: SHC_CITATIONS.chunking },
      ),
    );
  }

  return { jws: ordered.join(''), total, present, missing: [], findings };
}

/**
 * Encode a card as the numeric segment of one or more QR payloads.
 *
 * Here because the decoder needs a counterpart to be testable end to end, and
 * because minting a deliberately broken QR is how you test a scanner.
 */
export function encodeShcQr(jws: string, options: { chunks?: number } = {}): string[] {
  const digits = (text: string): string =>
    [...text].map((c) => String(c.charCodeAt(0) - SHC_ORD_OFFSET).padStart(2, '0')).join('');
  const chunks = options.chunks ?? 1;
  if (chunks <= 1) return [`${SHC_PREFIX}${digits(jws)}`];
  const size = Math.ceil(jws.length / chunks);
  const out: string[] = [];
  for (let index = 0; index < chunks; index += 1) {
    const slice = jws.slice(index * size, (index + 1) * size);
    out.push(`${SHC_PREFIX}${index + 1}/${chunks}/${digits(slice)}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The card itself
// ---------------------------------------------------------------------------

/**
 * A numeric date claim, read the way RFC 7519 defines it and reported with the
 * two ways producers get it wrong.
 *
 * The value is permitted to be a non-integer and the spec's own example is
 * `1687450764.656`, so an integer-only parser mishandles the reference card.
 * Separately, a producer that wrote milliseconds yields a card "not valid until
 * the year 55000", which is worth saying out loud rather than reporting as a
 * card from the future.
 */
export interface NumericDate {
  /** The number exactly as it appeared, decimals included. */
  raw: number;
  /** Milliseconds since the epoch, after any unit correction. */
  epochMs: number;
  unit: 'seconds' | 'milliseconds';
  isInteger: boolean;
}

/** Seconds for 2100-01-01. A larger value as seconds is not a real date. */
const IMPLAUSIBLE_AS_SECONDS = 4_102_444_800;
/** Seconds for 2000-01-01, the floor for a plausible reading. */
const PLAUSIBLE_FLOOR = 946_684_800;

function readNumericDate(value: number): NumericDate {
  const isInteger = Number.isInteger(value);
  if (value > IMPLAUSIBLE_AS_SECONDS && value / 1000 > PLAUSIBLE_FLOOR) {
    return { raw: value, epochMs: value, unit: 'milliseconds', isInteger };
  }
  return { raw: value, epochMs: value * 1000, unit: 'seconds', isInteger };
}

export const HEALTH_CARD_TYPE = 'https://smarthealth.cards#health-card';

/** Deprecated since VCI 1.4.0: cards are classified by their contents now. */
const DEPRECATED_TYPES = new Set([
  'https://smarthealth.cards#covid19',
  'https://smarthealth.cards#immunization',
  'https://smarthealth.cards#laboratory',
]);

export interface ShcCard {
  iss?: string;
  nbf?: NumericDate;
  exp?: NumericDate;
  types: string[];
  /** The revocation identifier, when the issuer supports per-card revocation. */
  rid?: string;
  fhirVersion?: string;
  fhirBundle?: unknown;
  /** The claims verbatim, for the raw view. */
  raw: Record<string, unknown>;
}

export type JwsInspection =
  | { ok: false; findings: RuleOutput[]; checks: VerificationCheck[] }
  | {
      ok: true;
      parts: JwsParts;
      header: JwsParts['header'];
      card: ShcCard;
      /** Bytes of the compressed payload, and of the JSON it inflated to. */
      sizes: { compressed: number; inflated: number };
      framing: CompressionFraming;
      payloadText: string;
      findings: RuleOutput[];
      checks: VerificationCheck[];
    };

/**
 * Everything about one card that needs no network: the header, the two
 * compression layers, and the claims.
 *
 * Synchronous on purpose. This is what a viewer can say before it has asked
 * anybody's permission to make a request, and separating it from verification
 * is what lets the UI show a card's contents while stating plainly that nothing
 * about them has been verified.
 */
export function inspectJws(compact: string): JwsInspection {
  const findings: RuleOutput[] = [];
  const ladder = new Ladder();

  if (compact.trim() !== compact) {
    findings.push(
      finding(
        'SHC-JWS-SURROUNDING-WHITESPACE',
        'warning',
        'sender',
        'The card string has whitespace around it.',
        'The signature covers the exact characters of the header and payload segments. A receiver that does not trim first fails verification on a card that is otherwise correct.',
      ),
    );
  }

  let parts: JwsParts;
  try {
    parts = parseJwsCompact(compact);
    ladder.set('jws-shape', 'pass');
  } catch (error) {
    const jose = error instanceof JoseError ? error : undefined;
    ladder.set('jws-shape', 'fail', jose?.message ?? 'The card is not a compact JWS.');
    findings.push(
      finding(
        'SHC-JWS-NOT-COMPACT',
        'fatal',
        'sender',
        jose?.message ?? 'This is not a compact JSON Web Signature.',
        `A card is three base64url segments separated by dots: header, payload, signature. ${
          jose?.hint ?? 'Nothing here can be decoded until that holds.'
        }`,
        { citation: CITATIONS.shcJws },
      ),
    );
    return { ok: false, findings, checks: ladder.list() };
  }

  const header = parts.header;

  if (header.alg === 'ES256') {
    ladder.set('header-alg', 'pass');
  } else {
    ladder.set('header-alg', 'fail', `alg is ${JSON.stringify(header.alg)}.`);
    findings.push(
      finding(
        'SHC-JWS-ALG-NOT-ES256',
        'fatal',
        'sender',
        `The header names alg ${JSON.stringify(header.alg)}, and a health card is always ES256.`,
        'The algorithm set for health cards is closed: ES256, a P-256 ECDSA signature. There is no negotiation, so a receiver cannot fall back to another algorithm, and a card signed with anything else cannot be verified by a conformant verifier at all.',
        { citation: CITATIONS.shcJws },
      ),
    );
  }

  if (header.zip === 'DEF') {
    ladder.set('header-zip', 'pass');
  } else if (header.zip === undefined) {
    ladder.set('header-zip', 'fail', 'The header has no zip member.');
    findings.push(
      finding(
        'SHC-JWS-ZIP-MISSING',
        'error',
        'sender',
        'The header does not declare zip DEF.',
        'A health card payload is always raw-DEFLATE compressed before signing, and the header says so. Without the header a receiver has no reason to inflate, so it will try to parse compressed bytes as JSON and report a corrupt card.',
        { citation: CITATIONS.shcJws },
      ),
    );
  } else {
    ladder.set('header-zip', 'fail', `zip is ${JSON.stringify(header.zip)}.`);
    findings.push(
      finding(
        'SHC-JWS-ZIP-NOT-DEF',
        'fatal',
        'sender',
        `The header names zip ${JSON.stringify(header.zip)}, and the only value defined is DEF.`,
        'DEF means raw DEFLATE with no zlib or gzip wrapper. No other compression is defined for a health card, so no receiver will know what to do with this.',
        { citation: CITATIONS.shcJws },
      ),
    );
  }

  if (typeof header.kid === 'string' && header.kid.length > 0) {
    ladder.set('header-kid', 'pass');
  } else {
    ladder.set('header-kid', 'fail', 'The header carries no kid.');
    findings.push(
      finding(
        'SHC-JWS-KID-MISSING',
        'error',
        'sender',
        'The header carries no kid, so there is no way to say which key signed this.',
        "An issuer publishes a set of keys and rotates them at least annually, so the kid is what picks one out. Without it a verifier has to try every key in the set, and cannot report a rotated-out key as anything other than a bad signature.",
        {
          remedy: 'Add kid as the base64url SHA-256 RFC 7638 thumbprint of the signing key.',
          citation: CITATIONS.shcKid,
        },
      ),
    );
  }

  const signature = safeBase64url(parts.signatureB64);
  if (signature === undefined) {
    ladder.set('signature-form', 'fail', 'The signature segment is not base64url.');
  } else if (signature.byteLength === 64) {
    ladder.set('signature-form', 'pass');
  } else {
    const der = signature[0] === 0x30;
    ladder.set('signature-form', 'fail', `The signature is ${signature.byteLength} bytes.`);
    findings.push(
      finding(
        der ? 'SHC-SIGNATURE-DER-ENCODED' : 'SHC-SIGNATURE-WRONG-LENGTH',
        'fatal',
        'sender',
        der
          ? 'The signature is DER-encoded, and JOSE requires the raw form.'
          : `The signature is ${signature.byteLength} bytes, and an ES256 signature is 64.`,
        der
          ? 'The first byte is 0x30, which starts a DER SEQUENCE, so this came from a library defaulting to the ASN.1 encoding OpenSSL emits. JOSE uses the fixed-width r-then-s form instead. The signature is probably over the right bytes and no conformant verifier will accept it.'
          : 'ES256 signatures are exactly two 32-byte values concatenated. Any other length means the segment was truncated in transit or produced by something that is not signing with P-256.',
        { citation: CITATIONS.shcJws },
      ),
    );
  }

  if (compact.length > SINGLE_QR_MAX_JWS_CHARS) {
    findings.push(
      finding(
        'SHC-JWS-TOO-LONG-FOR-ONE-QR',
        'info',
        'nobody',
        `This card is ${compact.length} characters, so it does not fit in a single QR code.`,
        `A version 22 QR with low error correction holds ${SINGLE_QR_MAX_JWS_CHARS} characters of a card. Anything longer needs the deprecated chunked form or, better, delivery as a SMART Health Link, which is how this one arrived.`,
        { citation: SHC_CITATIONS.chunking },
      ),
    );
  }

  const compressed = safeBase64url(parts.payloadB64);
  if (compressed === undefined) {
    ladder.set('payload-inflate', 'fail', 'The payload segment is not base64url.');
    findings.push(
      finding(
        'SHC-JWS-PAYLOAD-NOT-BASE64URL',
        'fatal',
        'sender',
        'The payload segment is not base64url.',
        'The middle segment of a compact JWS is base64url with no padding. A "+" or "/" in it means the producer used standard base64, which every JOSE library rejects.',
      ),
    );
    return { ok: false, findings, checks: ladder.list() };
  }

  let inflated: Uint8Array;
  let framing: CompressionFraming = 'none';
  if (header.zip === undefined && looksLikeJsonBytes(compressed)) {
    // An uncompressed payload is a header defect, already reported above, but
    // the claims are still readable and that is what the user came for.
    inflated = compressed;
    ladder.set('payload-inflate', 'warn', 'The payload was not compressed at all.');
  } else {
    try {
      const result = inflateForgiving(compressed);
      inflated = result.bytes;
      framing = result.framing;
      if (result.framing === 'raw-deflate') {
        ladder.set('payload-inflate', 'pass');
      } else {
        ladder.set('payload-inflate', 'warn', result.deviation ?? `Framing is ${result.framing}.`);
        findings.push(
          finding(
            'SHC-JWS-PAYLOAD-FRAMING',
            'error',
            'sender',
            `The payload is ${result.framing === 'zlib' ? 'zlib-wrapped' : 'gzip-wrapped'} DEFLATE, not raw DEFLATE.`,
            `${result.deviation ?? ''} The signature still verifies, because it is computed over the compressed bytes, so this is a card that is cryptographically sound and non-conformant at the same time. A strict receiver inflating with raw DEFLATE gets a header check error and reports a corrupt card.`.trim(),
            { citation: CITATIONS.shcJws },
          ),
        );
      }
    } catch {
      ladder.set('payload-inflate', 'fail', 'The payload is not DEFLATE data in any framing.');
      findings.push(
        finding(
          'SHC-JWS-PAYLOAD-NOT-DEFLATE',
          'fatal',
          'sender',
          'The payload does not inflate, in raw, zlib or gzip framing.',
          'Loupe tried all three framings rather than only the one the specification requires, so this is not a wrapper mistake. The bytes are either truncated or were never compressed, and the claims cannot be read.',
          { citation: CITATIONS.shcJws },
        ),
      );
      return { ok: false, findings, checks: ladder.list() };
    }
  }

  let payloadText = utf8Decode(inflated);
  if (payloadText.charCodeAt(0) === 0xfeff) {
    payloadText = payloadText.slice(1);
    findings.push(
      finding(
        'SHC-JWS-PAYLOAD-BOM',
        'error',
        'sender',
        'The payload starts with a byte order mark.',
        'The three bytes EF BB BF sit in front of the JSON. A strict parser rejects the payload outright, and the mark is inside the signed bytes so it cannot be stripped without breaking the signature.',
      ),
    );
  }

  let claims: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(payloadText);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('not an object');
    }
    claims = parsed as Record<string, unknown>;
    ladder.set('payload-json', 'pass');
  } catch {
    ladder.set('payload-json', 'fail', 'The inflated payload is not a JSON object.');
    findings.push(
      finding(
        'SHC-JWS-PAYLOAD-NOT-JSON',
        'fatal',
        'sender',
        'The payload inflated, and what came out is not a JSON object.',
        'Inflation succeeded, so the compression layer is fine and the problem is the thing that was compressed. There are no claims to read.',
      ),
    );
    return { ok: false, findings, checks: ladder.list() };
  }

  const minified = JSON.stringify(claims);
  if (minified.length < payloadText.length) {
    ladder.set('payload-json', 'warn', 'The payload carries optional whitespace.');
    findings.push(
      finding(
        'SHC-JWS-PAYLOAD-NOT-MINIFIED',
        'warning',
        'sender',
        `The payload is ${payloadText.length - minified.length} characters larger than its minified form.`,
        'Issuers are required to strip optional whitespace before compressing, because every wasted byte competes for room in a QR code. This is conformance rather than correctness: the card still verifies.',
        { citation: CITATIONS.shcJws },
      ),
    );
  }

  const card = readClaims(claims, findings, ladder);
  return {
    ok: true,
    parts,
    header,
    card,
    sizes: { compressed: compressed.byteLength, inflated: inflated.byteLength },
    framing,
    payloadText,
    findings,
    checks: ladder.list(),
  };
}

function readClaims(
  claims: Record<string, unknown>,
  findings: RuleOutput[],
  ladder: Ladder,
): ShcCard {
  const card: ShcCard = { types: [], raw: claims };

  if (typeof claims.iss === 'string' && claims.iss.length > 0) {
    card.iss = claims.iss;
  } else {
    findings.push(
      finding(
        'SHC-CLAIM-ISS-MISSING',
        'fatal',
        'sender',
        claims.iss === undefined
          ? 'The card has no iss claim, so there is no issuer to check it against.'
          : `The iss claim is ${describeJsonType(claims.iss)}, and it has to be a string.`,
        'The iss claim is the issuer URL, and it is the only thing that says where the signing keys live. Without it there is nothing to fetch and no possible verification.',
        { citation: SHC_CITATIONS.issuerUrl },
      ),
    );
  }

  for (const key of ['nbf', 'exp'] as const) {
    const value = claims[key];
    if (value === undefined) continue;
    if (typeof value === 'number' && Number.isFinite(value)) {
      card[key] = readNumericDate(value);
      continue;
    }
    findings.push(
      finding(
        key === 'nbf' ? 'SHC-CLAIM-NBF-NOT-A-NUMBER' : 'SHC-CLAIM-EXP-NOT-A-NUMBER',
        'error',
        'sender',
        `The ${key} claim is ${describeJsonType(value)}, and it has to be a number.`,
        'These claims are seconds since the epoch as a JSON number. A decimal is allowed and the specification’s own example card uses one, but a string is not: a verifier comparing a string to a timestamp gets an answer that means nothing.',
        { citation: SHC_CITATIONS.expiration },
      ),
    );
  }

  if (card.nbf === undefined) {
    findings.push(
      finding(
        'SHC-CLAIM-NBF-MISSING',
        'error',
        'sender',
        'The card has no nbf claim, so it does not say when it was issued.',
        'nbf carries the issuance date as well as the validity floor, and the revocation rules compare it against a timestamped revocation entry. Without it a revocation with a timestamp suffix cannot be evaluated at all.',
      ),
    );
  }

  if (card.nbf !== undefined && card.nbf.unit === 'milliseconds') {
    findings.push(
      finding(
        'SHC-CLAIM-NBF-MILLISECONDS',
        'error',
        'sender',
        'The nbf claim looks like milliseconds, not seconds.',
        `The value ${card.nbf.raw} read as seconds is a date tens of thousands of years away, and read as milliseconds it is ${new Date(card.nbf.epochMs).toISOString()}. Loupe assumed milliseconds. A verifier that does not will report this card as not yet valid forever.`,
        { citation: SHC_CITATIONS.expiration },
      ),
    );
  }

  if (
    card.nbf !== undefined &&
    card.exp !== undefined &&
    card.exp.epochMs <= card.nbf.epochMs
  ) {
    findings.push(
      finding(
        'SHC-CLAIM-EXP-BEFORE-NBF',
        'error',
        'sender',
        'The card expires before it becomes valid.',
        `nbf is ${new Date(card.nbf.epochMs).toISOString()} and exp is ${new Date(card.exp.epochMs).toISOString()}, so there is no moment at which this card is valid. Usually one of the two was written in the wrong unit.`,
        { citation: SHC_CITATIONS.expiration },
      ),
    );
  }

  const vc = claims.vc;
  if (typeof vc !== 'object' || vc === null || Array.isArray(vc)) {
    ladder.set('vc-type', 'fail', 'There is no vc claim to read a type from.');
    ladder.set('fhir-bundle', 'fail', 'There is no vc claim to read a bundle from.');
    findings.push(
      finding(
        'SHC-CLAIM-VC-MISSING',
        'fatal',
        'sender',
        vc === undefined
          ? 'The card has no vc claim, so it carries no clinical content.'
          : `The vc claim is ${describeJsonType(vc)}, and it has to be an object.`,
        'Everything a health card is for sits under vc: the type, the FHIR bundle, and the revocation identifier. A card without it is a signed set of timestamps.',
        { citation: CITATIONS.shcVc },
      ),
    );
    return card;
  }

  const vcRecord = vc as Record<string, unknown>;

  if (typeof vcRecord.rid === 'string') card.rid = vcRecord.rid;
  if (typeof vcRecord.rid === 'string' && vcRecord.rid.length > 24) {
    findings.push(
      finding(
        'SHC-CLAIM-RID-TOO-LONG',
        'warning',
        'sender',
        `The revocation identifier is ${vcRecord.rid.length} characters, and the limit is 24.`,
        'The identifier is meant to be short and meaningless to verifiers, so that a per-key revocation list stays small enough to publish forever. A long one still works and still costs everyone bandwidth.',
        { citation: SHC_CITATIONS.revocation },
      ),
    );
  }

  const types = vcRecord.type;
  if (Array.isArray(types)) {
    card.types = types.filter((t): t is string => typeof t === 'string');
  }
  if (card.types.includes(HEALTH_CARD_TYPE)) {
    ladder.set('vc-type', 'pass');
  } else {
    ladder.set('vc-type', 'fail', `vc.type does not contain ${HEALTH_CARD_TYPE}.`);
    findings.push(
      finding(
        'SHC-CLAIM-TYPE-MISSING-HEALTH-CARD',
        'error',
        'sender',
        `vc.type does not contain ${HEALTH_CARD_TYPE}.`,
        `That type is required on every health card and is how a wallet recognises one. This card declares ${card.types.length === 0 ? 'no types at all' : listOut(card.types)}.`,
        { citation: CITATIONS.shcVc },
      ),
    );
  }
  const deprecated = card.types.filter((t) => DEPRECATED_TYPES.has(t));
  if (deprecated.length > 0) {
    findings.push(
      finding(
        'SHC-CLAIM-TYPE-DEPRECATED',
        'info',
        'sender',
        `${listOut(deprecated)} ${deprecated.length === 1 ? 'is' : 'are'} deprecated.`,
        'The topic types were deprecated in favour of classifying a card by what is actually in its bundle. They are harmless to send and nothing should be filtered on them.',
        { citation: CITATIONS.shcVc },
      ),
    );
  }
  if (vcRecord['@context'] !== undefined) {
    findings.push(
      finding(
        'SHC-CLAIM-VC-CONTEXT-PRESENT',
        'warning',
        'sender',
        'vc carries an @context member, which does not belong on the wire.',
        'The JSON-LD view of a health card adds @context and prepends VerifiableCredential to the type array, but that mapping is for consumers who want it. Seeing it here means the producer serialised the mapped view by mistake.',
        { citation: CITATIONS.shcVc },
      ),
    );
  }

  const subject = vcRecord.credentialSubject;
  if (typeof subject !== 'object' || subject === null || Array.isArray(subject)) {
    ladder.set('fhir-bundle', 'fail', 'There is no credentialSubject.');
    findings.push(
      finding(
        'SHC-CLAIM-SUBJECT-MISSING',
        'fatal',
        'sender',
        'vc.credentialSubject is missing, so the card carries no clinical content.',
        'credentialSubject holds the FHIR version and the bundle. A card without it verifies and shows nothing.',
        { citation: CITATIONS.shcVc },
      ),
    );
    return card;
  }

  const subjectRecord = subject as Record<string, unknown>;
  if (typeof subjectRecord.fhirVersion === 'string') card.fhirVersion = subjectRecord.fhirVersion;
  if (card.fhirVersion === undefined) {
    findings.push(
      finding(
        'SHC-CLAIM-FHIRVERSION-MISSING',
        'warning',
        'sender',
        'The card does not say which FHIR version its bundle is in.',
        'fhirVersion is the three-part version string, for example 4.0.1, and a viewer needs it to pick a renderer. Without it a DSTU2 bundle renders silently and wrongly through an R4 renderer.',
        { citation: CITATIONS.shcVc },
      ),
    );
  } else if (!/^\d+\.\d+\.\d+$/.test(card.fhirVersion)) {
    findings.push(
      finding(
        'SHC-CLAIM-FHIRVERSION-SHAPE',
        'warning',
        'sender',
        `fhirVersion is ${JSON.stringify(card.fhirVersion)}, and it should be a three-part version.`,
        'The value is a semantic FHIR version such as 4.0.1, not a release name such as R4 and not a two-part 4.0. Receivers match on the numbers.',
        { citation: CITATIONS.shcVc },
      ),
    );
  }

  if (subjectRecord.fhirBundle === undefined) {
    ladder.set('fhir-bundle', 'fail', 'credentialSubject has no fhirBundle.');
    findings.push(
      finding(
        'SHC-CLAIM-BUNDLE-MISSING',
        'fatal',
        'sender',
        'There is no fhirBundle, so this card carries no clinical data.',
        'The bundle is the payload of a health card. Everything else is scaffolding around it.',
        { citation: CITATIONS.shcVc },
      ),
    );
    return card;
  }

  card.fhirBundle = subjectRecord.fhirBundle;
  ladder.set('fhir-bundle', 'pass');
  return card;
}

// ---------------------------------------------------------------------------
// Issuer key resolution
// ---------------------------------------------------------------------------

export interface IssuerUrls {
  /** `iss` with the well-known path concatenated, exactly as the spec requires. */
  jwksUrl: string;
  /**
   * The same URL with a doubled slash collapsed. Present only when `iss` had a
   * trailing slash, which is a defect that many servers silently normalise, so
   * one issuer works everywhere and another fails for a reason nobody can see.
   */
  normalisedJwksUrl?: string;
  findings: RuleOutput[];
}

/**
 * Build the JWKS URL for an issuer.
 *
 * This is **string concatenation**, never URL resolution. `new URL('/.well-known/jwks.json', iss)`
 * discards the path, which turns `https://ehr.example.org/fhir/r4` into
 * `https://ehr.example.org/.well-known/jwks.json`. It is silent on the spec's
 * own shallow example and fatal against every real issuer, whose `iss` values
 * carry deep paths.
 */
export function issuerJwksUrl(iss: string): IssuerUrls {
  const findings: RuleOutput[] = [];
  const jwksUrl = `${iss}/.well-known/jwks.json`;

  let parsed: URL | undefined;
  try {
    parsed = new URL(iss);
  } catch {
    findings.push(
      finding(
        'SHC-ISS-NOT-A-URL',
        'fatal',
        'sender',
        `The iss claim is not a URL: ${JSON.stringify(iss)}.`,
        'The issuer claim has to be an absolute https URL, because the key set is fetched from it by appending a fixed path. A bare hostname or an identifier has nowhere to fetch from.',
        { citation: SHC_CITATIONS.issuerUrl },
      ),
    );
    return { jwksUrl, findings };
  }

  if (parsed.protocol !== 'https:') {
    findings.push(
      finding(
        'SHC-ISS-NOT-HTTPS',
        'fatal',
        'sender',
        `The issuer URL uses ${parsed.protocol.replace(':', '')}, and it has to use https.`,
        'The key set is what makes a signature mean anything, so it is fetched over TLS or not at all. A page served over https cannot fetch an http URL either: the browser blocks it as mixed content before any request is made.',
        { citation: SHC_CITATIONS.issuerUrl },
      ),
    );
  }

  if (iss.endsWith('/')) {
    findings.push(
      finding(
        'SHC-ISS-TRAILING-SLASH',
        'error',
        'sender',
        'The issuer URL ends with a slash, which the specification forbids.',
        `The key set URL is built by appending "/.well-known/jwks.json" to iss, so a trailing slash produces ${jwksUrl}, with a doubled slash. Some servers normalise that and return the key set anyway, which is why this defect survives in production and then breaks against the one server that does not.`,
        {
          remedy: 'Publish iss without a trailing slash.',
          citation: SHC_CITATIONS.issuerUrl,
        },
      ),
    );
  }

  const reach = classifyHost(parsed.hostname);
  if (reachIsUnreachableByOthers(reach.reach)) {
    findings.push(
      finding(
        'SHC-ISS-UNREACHABLE-HOST',
        'fatal',
        'sender',
        `The issuer is hosted at ${parsed.hostname}, which nobody else can reach.`,
        `${reach.because} This card can only be verified on the machine or network that issued it, so its signature is unverifiable everywhere else. This is decided from the URL alone: no request was made, and no network condition changes the answer.`,
        {
          remedy:
            'Re-issue the cards against a host other people can reach, then republish the key set there.',
          citation: SHC_CITATIONS.issuerKeys,
        },
      ),
    );
  }

  return {
    jwksUrl,
    ...(iss.endsWith('/')
      ? { normalisedJwksUrl: `${iss.replace(/\/+$/, '')}/.well-known/jwks.json` }
      : {}),
    findings,
  };
}

/** The per-key revocation list URL. Keyed by `kid`, so each list stays small. */
export function issuerCrlUrl(iss: string, kid: string): string {
  return `${iss.replace(/\/+$/, '')}/.well-known/crl/${encodeURIComponent(kid)}.json`;
}

// ---------------------------------------------------------------------------
// Trust directories
// ---------------------------------------------------------------------------

export interface TrustDirectory {
  id: string;
  name: string;
  url: string;
  /** What this directory covers, so an absence can be read correctly. */
  scope: string;
}

/**
 * The directories that exist, as data.
 *
 * None of these is fetched unless a caller passes one in. A directory is a third
 * party with no relationship to the card in front of you, so reaching for one
 * tells that third party which issuers somebody is looking at, and this tool
 * makes no request its user did not ask for.
 */
export const KNOWN_TRUST_DIRECTORIES: readonly TrustDirectory[] = [
  {
    id: 'vci',
    name: 'VCI Directory (The Commons Project)',
    url: 'https://raw.githubusercontent.com/the-commons-project/vci-directory/main/vci-issuers.json',
    // The only machine-readable directory with a stable URL and CORS. Its scope
    // is COVID-19-era and US-centric, so an Australian or connectathon issuer
    // is legitimately absent: "unlisted" is never "untrusted".
    scope:
      'Institutions that issued COVID-19 vaccination and laboratory records, mostly in the United States. An Australian or test issuer is expected to be absent.',
  },
  {
    id: 'vci-snapshot',
    name: 'VCI Directory daily snapshot (keys and reachability)',
    url: 'https://raw.githubusercontent.com/the-commons-project/vci-directory/main/logs/vci_snapshot.json',
    // Same list, plus each issuer's fetched keys and whether the fetch worked.
    // Larger, and useful when you want to know an issuer was reachable
    // yesterday even though it is not reachable from this venue's wifi.
    scope:
      'The same issuer list with the keys and reachability recorded by a daily crawl. Useful for telling an unreachable issuer apart from a broken one.',
  },
];

export type TrustState =
  | { state: 'not-checked'; reason: string }
  | { state: 'listed'; directory: string; matchedOn: 'iss' | 'canonical_iss'; name?: string }
  | { state: 'unlisted'; directories: string[] }
  | { state: 'unavailable'; directory: string; reason: string };

interface DirectoryEntry {
  iss?: unknown;
  name?: unknown;
  canonical_iss?: unknown;
}

// ---------------------------------------------------------------------------
// Revocation
// ---------------------------------------------------------------------------

export type RevocationState =
  | { state: 'not-checked'; reason: string }
  /** The issuer publishes no revocation list for this key, so status is unknown. */
  | { state: 'not-published' }
  /** The card carries no rid, so there is nothing per-card to look up. */
  | { state: 'no-rid' }
  | { state: 'clean'; ctr: number; entries: number }
  | { state: 'revoked'; rid: string; matched: string; revokedFrom?: number }
  | { state: 'unavailable'; reason: string };

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export interface HttpExchange {
  request: HttpRequestRecord;
  response: HttpResponseRecord;
}

export interface VerifyOptions {
  transport: Transport;
  /**
   * Directories to consult, and nothing is fetched when this is empty. The URL
   * of each is shown to the user before it is used.
   */
  trustedDirectories?: readonly TrustDirectory[];
  /**
   * Downgrade a conformance failure to a warning so a run continues past it.
   *
   * For debugging a producer, where stopping at the first defect hides the next
   * three. It never downgrades a check that decides validity: a signature that
   * does not verify, an expired card and a revoked card stay failures, because
   * a debug switch that can make a broken signature look acceptable is a
   * security hole with a friendly name.
   */
  permissive?: boolean;
  /** Skip the revocation fetch even when the key advertises a list. */
  skipRevocation?: boolean;
  now?: () => number;
}

export interface HealthCardVerification {
  posture: VerificationPosture;
  /** The static read of the card. Present unless the JWS could not be parsed. */
  inspection: JwsInspection;
  issuer?: {
    /** The issuer's own URL, from the card. Never presented as a name. */
    iss: string;
    jwksUrl: string;
    /** A human name, only ever from a directory that published one. */
    name?: string;
  };
  /** The `kid` the card names, and the thumbprint of the key that was used. */
  kid?: string;
  thumbprint?: string;
  /** The key the signature was checked against, when one was selected. */
  key?: EcJwk;
  /** Every kid the key set offered, so a rotation is visible rather than guessed. */
  keySetKids?: string[];
  checks: VerificationCheck[];
  findings: RuleOutput[];
  exchanges: HttpExchange[];
  revocation: RevocationState;
  trust: TrustState;
  permissive: boolean;
  /** Checks whose failure permissive mode turned into a warning. */
  downgraded: CheckId[];
}

/**
 * Verify one card, end to end, and report every step.
 *
 * The JWKS fetch goes through the injected transport so it lands in the trace
 * beside every other request the tool made: a viewer that quietly reaches the
 * network to decide a trust verdict has broken the promise that the trace is
 * complete.
 */
export async function verifyHealthCard(
  jws: string,
  options: VerifyOptions,
): Promise<HealthCardVerification> {
  const now = options.now ?? (() => Date.now());
  const permissive = options.permissive === true;
  const inspection = inspectJws(jws);
  const findings: RuleOutput[] = [...inspection.findings];
  const exchanges: HttpExchange[] = [];
  const ladder = new Ladder();
  ladder.merge(inspection.checks);
  const downgraded: CheckId[] = [];

  let revocation: RevocationState = {
    state: 'not-checked',
    reason: 'Verification stopped before the revocation step.',
  };
  let trust: TrustState = {
    state: 'not-checked',
    reason:
      'No trust directory was consulted. A directory lookup is a request to a third party, so Loupe only makes it when you choose a directory.',
  };

  const settle = (
    extra: Partial<HealthCardVerification> = {},
  ): HealthCardVerification => {
    if (permissive) {
      for (const check of ladder.list()) {
        if (check.state === 'fail' && !DECIDES_VALIDITY.has(check.id)) {
          ladder.set(check.id, 'warn', check.detail);
          downgraded.push(check.id);
        }
      }
      findings.push(
        finding(
          'SHC-PERMISSIVE-MODE',
          'warning',
          'you',
          downgraded.length === 0
            ? 'Permissive mode is on, and nothing needed downgrading.'
            : `Permissive mode is on: ${downgraded.length} failed ${downgraded.length === 1 ? 'check is' : 'checks are'} shown as warnings.`,
          `${
            downgraded.length === 0
              ? 'No check failed, so this run would read the same with permissive mode off.'
              : `${listOut(downgraded)} failed and ${downgraded.length === 1 ? 'is' : 'are'} being reported as a warning so the run could continue past ${downgraded.length === 1 ? 'it' : 'them'}.`
          } Signature, validity dates and revocation are never downgraded. Turn permissive mode off before reading this as a verdict on the card.`,
        ),
      );
    }
    const checks = ladder.list();
    return {
      posture: postureFrom(checks),
      inspection,
      checks,
      findings,
      exchanges,
      revocation,
      trust,
      permissive,
      downgraded,
      ...extra,
    };
  };

  if (!inspection.ok) return settle();

  const iss = inspection.card.iss;
  if (iss === undefined) {
    ladder.set('iss-url', 'fail', 'The card has no iss claim.');
    return settle();
  }

  const urls = issuerJwksUrl(iss);
  findings.push(...urls.findings);
  const issFatal = urls.findings.some((f) => f.severity === 'fatal');
  ladder.set(
    'iss-url',
    issFatal ? 'fail' : urls.findings.length > 0 ? 'warn' : 'pass',
    urls.findings[0]?.title,
  );
  const issuer = { iss, jwksUrl: urls.jwksUrl };
  if (issFatal) return settle({ issuer });

  // ---- the key set -------------------------------------------------------
  const jwksAttempt = await fetchJson(options.transport, urls.jwksUrl, 'jwks');
  exchanges.push(jwksAttempt.exchange);
  let keySet = jwksAttempt;

  if (!jwksAttempt.ok && urls.normalisedJwksUrl !== undefined) {
    // The trailing-slash defect is already reported; try the collapsed URL so
    // the run can continue, and say that the fallback is what worked.
    const retry = await fetchJson(options.transport, urls.normalisedJwksUrl, 'jwks');
    exchanges.push(retry.exchange);
    if (retry.ok) {
      keySet = retry;
      findings.push(
        finding(
          'SHC-JWKS-FETCHED-FROM-NORMALISED-URL',
          'warning',
          'sender',
          'The key set was only reachable after collapsing the doubled slash.',
          `${urls.jwksUrl} did not return a key set, and ${urls.normalisedJwksUrl} did. Verification below used the second URL. A receiver that builds the URL by concatenation, exactly as the specification says to, will fail against this issuer.`,
          { citation: SHC_CITATIONS.issuerUrl },
        ),
      );
    }
  }

  if (!keySet.ok) {
    ladder.set('jwks-fetch', 'fail', keySet.reason);
    findings.push(
      keySet.kind === 'network'
        ? finding(
            'SHC-JWKS-UNREACHABLE',
            'error',
            'server',
            "The issuer's key set could not be fetched.",
            `${keySet.reason} The browser gives one opaque failure for a refused connection, a DNS miss, a TLS problem and a missing CORS header alike, so this cannot be narrowed further from inside a tab. What is certain is that the signature cannot be checked without it.`,
            {
              remedy: `Run: curl -sI ${keySet.url}`,
              citation: SHC_CITATIONS.issuerKeys,
            },
          )
        : finding(
            'SHC-JWKS-BAD-STATUS',
            'error',
            'server',
            `The key set URL returned HTTP ${keySet.status}.`,
            `A GET of ${keySet.url} answered ${keySet.status}${keySet.statusText === undefined ? '' : ` ${keySet.statusText}`}. The issuer is reachable and is not serving a key set at the place the specification requires, so no verifier anywhere can check this card.`,
            { citation: SHC_CITATIONS.issuerKeys },
          ),
    );
    return settle({ issuer });
  }
  ladder.set('jwks-fetch', 'pass');

  const parsedKeySet = parseKeySet(keySet.body);
  if (parsedKeySet === undefined) {
    ladder.set('jwks-json', 'fail', 'The response is not a JSON object with a keys array.');
    findings.push(
      finding(
        'SHC-JWKS-NOT-A-KEY-SET',
        'error',
        'server',
        'The key set URL answered with something that is not a key set.',
        `The response was ${keySet.status} and its body ${
          looksLikeHtml(keySet.body)
            ? 'is HTML, which usually means a single-page app or an error page is being served for every path under this host'
            : 'does not parse as a JSON object with a keys array'
        }. A key set is {"keys":[...]}.`,
        { citation: SHC_CITATIONS.issuerKeys },
      ),
    );
    return settle({ issuer });
  }
  ladder.set('jwks-json', 'pass');

  const kid = typeof inspection.header.kid === 'string' ? inspection.header.kid : undefined;
  const keySetKids = parsedKeySet.map((key) =>
    typeof key.kid === 'string' ? key.kid : '(no kid)',
  );

  if (kid === undefined) {
    ladder.set('kid-in-jwks', 'fail', 'The card names no kid, so no key can be selected.');
    findings.push(
      finding(
        'SHC-KID-CANNOT-SELECT-KEY',
        'error',
        'sender',
        `The card names no key, and the issuer publishes ${parsedKeySet.length}.`,
        `Loupe will not guess. Trying every key until one verifies would report a card signed with a withdrawn key as valid, which is the exact case a kid exists to prevent. The set offers ${listOut(keySetKids)}.`,
        { citation: CITATIONS.shcKid },
      ),
    );
    return settle({ issuer, keySetKids });
  }

  const selected = parsedKeySet.find((key) => key.kid === kid);
  if (selected === undefined) {
    ladder.set('kid-in-jwks', 'fail', `No key in the set has kid ${kid}.`);
    findings.push(
      finding(
        'SHC-KID-NOT-IN-KEY-SET',
        'error',
        'sender',
        `The issuer's key set does not contain the key this card names.`,
        `The card was signed with ${kid} and the set publishes ${
          keySetKids.length === 0 ? 'no keys at all' : listOut(keySetKids)
        }. Three different things look identical here and the specification does not let a verifier tell them apart: the key was rotated out earlier than the rules allow, the card came from a test environment whose keys were never published, or the key was deliberately withdrawn after a compromise. All three mean this card cannot be verified now.`,
        {
          remedy:
            'Ask the issuer whether this key is still published. Old public keys are meant to stay in the set for as long as the cards they signed are clinically relevant.',
          citation: SHC_CITATIONS.issuerKeys,
        },
      ),
    );
    return settle({ issuer, kid, keySetKids });
  }
  ladder.set('kid-in-jwks', 'pass');

  // ---- the key ------------------------------------------------------------
  const keyFindings: RuleOutput[] = [];
  const usable = checkKeyShape(selected, keyFindings, ladder);
  findings.push(...keyFindings);
  if (!usable) return settle({ issuer, kid, keySetKids, key: selected });

  const canonicalX = canonicaliseP256Coordinate(usable.x);
  const canonicalY = canonicaliseP256Coordinate(usable.y);
  if (canonicalX.padded || canonicalY.padded) {
    findings.push(
      finding(
        'SHC-KEY-SHORT-COORDINATE',
        'warning',
        'sender',
        'A key coordinate was published with its leading zero bytes stripped.',
        'A P-256 coordinate is 32 bytes, and this one is shorter, so a leading zero was dropped by an encoder that treated it as a number rather than a fixed-width field. Loupe left-padded it and carried on, because rejecting a key the rest of the ecosystem accepts would make this tool the node that breaks. Note the thumbprint of the padded key differs from the thumbprint of the short one, so one key can end up with two identities.',
        { citation: CITATIONS.shcKid },
      ),
    );
  }
  const key: EcJwk = { ...selected, x: canonicalX.value, y: canonicalY.value };

  const thumbprint = await jwkThumbprint({
    kty: 'EC',
    crv: 'P-256',
    x: canonicalX.value,
    y: canonicalY.value,
  });
  if (thumbprint === kid) {
    ladder.set('key-thumbprint', 'pass');
  } else {
    ladder.set('key-thumbprint', 'fail', `The key's own thumbprint is ${thumbprint}.`);
    findings.push(
      finding
        (
        'SHC-KEY-KID-NOT-ITS-THUMBPRINT',
        'error',
        'sender',
        "The key's kid is not the thumbprint of that key.",
        `The set publishes this key as ${kid}, and the RFC 7638 thumbprint of its own crv, kty, x and y is ${thumbprint}. This is a producer defect independent of whether the signature verifies: any verifier that indexes keys by recomputed thumbprint rather than by the literal kid string will fail to find this key at all.`,
        { citation: CITATIONS.shcKid },
      ),
    );
  }

  // ---- the signature ------------------------------------------------------
  try {
    await verifyEs256(inspection.parts, key);
    ladder.set('signature', 'pass');
  } catch (error) {
    const jose = error instanceof JoseError ? error : undefined;
    ladder.set('signature', 'fail', jose?.message ?? 'The signature did not verify.');
    const doubleHashed = await verifiesOverDoubleHashedInput(inspection.parts, key);
    findings.push(
      doubleHashed
        ? finding(
            'SHC-SIGNATURE-DOUBLE-HASHED',
            'error',
            'sender',
            'The signature was computed over a hash of the signing input, hashed again.',
            'The signature does not verify over the header and payload as JOSE defines it, and it does verify over the SHA-256 of those bytes. So the producer hashed the input itself and then handed the digest to a signer that hashes what it is given. This defect is byte-stable, which is why it reproduces its own test vectors forever while failing every independent verifier.',
            {
              remedy: 'Pass the raw ASCII of header.payload to the signer and let it do the hashing.',
              citation: CITATIONS.shcJws,
            },
          )
        : finding(
            'SHC-SIGNATURE-INVALID',
            'fatal',
            'sender',
            'The signature does not verify against the key this card names.',
            `${jose?.message ?? ''} The key was found in the issuer's published set and the bytes do not match it, so either the card was altered after signing or it was signed by a key other than the one its kid names. ${jose?.hint ?? ''}`.trim(),
            { citation: CITATIONS.shcJws },
          ),
    );
    // Validity dates and revocation are deliberately not evaluated past a
    // failed signature: reporting "and it is also in date" invites a reader to
    // add up green ticks on a card that is not authentic.
    return settle({ issuer, kid, keySetKids, key, thumbprint });
  }

  // ---- validity window ----------------------------------------------------
  const nowMs = now();
  const nbf = inspection.card.nbf;
  if (nbf === undefined) {
    ladder.set('nbf', 'fail', 'The card has no nbf claim.');
  } else if (nbf.epochMs <= nowMs) {
    ladder.set('nbf', 'pass');
  } else {
    ladder.set('nbf', 'fail', `Not valid until ${new Date(nbf.epochMs).toISOString()}.`);
    findings.push(
      finding(
        'SHC-CARD-NOT-YET-VALID',
        'error',
        'sender',
        `This card does not become valid until ${new Date(nbf.epochMs).toISOString()}.`,
        `nbf is ${nbf.raw}${nbf.unit === 'milliseconds' ? ' (read as milliseconds)' : ''}, which is ${describeGap(nbf.epochMs - nowMs)} from now. A signature that verifies over a future nbf usually means the issuing system's clock is wrong, since nothing else about issuance is in the future.`,
        { citation: SHC_CITATIONS.expiration },
      ),
    );
  }

  const exp = inspection.card.exp;
  if (exp === undefined) {
    // Absent is the norm: a health card states a fact that does not change, so
    // this must read as "does not expire", never as a missing field.
    ladder.set('exp', 'pass', 'The card carries no exp, so it does not expire.');
  } else if (exp.epochMs > nowMs) {
    ladder.set('exp', 'pass', `Expires ${new Date(exp.epochMs).toISOString()}.`);
  } else {
    ladder.set('exp', 'fail', `Expired ${new Date(exp.epochMs).toISOString()}.`);
    findings.push(
      finding(
        'SHC-CARD-EXPIRED',
        'error',
        'sender',
        `This card expired ${describeGap(nowMs - exp.epochMs)} ago, on ${new Date(exp.epochMs).toISOString()}.`,
        'Verifiers are required to reject a card whose exp is in the past. Most health cards carry no exp at all, because they state a fact that does not change with time, so a card that has one was issued for a purpose with a deliberate end date.',
        { citation: SHC_CITATIONS.expiration },
      ),
    );
  }

  // ---- revocation ---------------------------------------------------------
  revocation = await checkRevocation({
    transport: options.transport,
    iss,
    kid,
    key: selected,
    ...(inspection.card.rid === undefined ? {} : { rid: inspection.card.rid }),
    ...(nbf === undefined ? {} : { nbf }),
    skip: options.skipRevocation === true,
    exchanges,
    findings,
    ladder,
  });

  // ---- trust --------------------------------------------------------------
  const directories = options.trustedDirectories ?? [];
  if (directories.length > 0) {
    trust = await checkTrustDirectories(options.transport, iss, directories, exchanges, findings, ladder);
  } else {
    ladder.set(
      'trust-directory',
      'skipped',
      'No directory was consulted, so whether anyone vouches for this issuer is unknown.',
    );
  }

  const name = trust.state === 'listed' ? trust.name : undefined;
  return settle({
    issuer: { ...issuer, ...(name === undefined ? {} : { name }) },
    kid,
    keySetKids,
    key,
    thumbprint,
  });
}

/**
 * Derive the one-word posture from the ladder.
 *
 * Note what it does NOT do: it never reads "no failures" as verified. A card
 * whose signature was never checked has no failures either, and calling that
 * verified is precisely the mistake this tool exists to stop.
 */
export function postureFrom(checks: readonly VerificationCheck[]): VerificationPosture {
  const state = (id: CheckId): CheckState =>
    checks.find((check) => check.id === id)?.state ?? 'not-reached';

  const decisive = checks.filter((check) => DECIDES_VALIDITY.has(check.id));
  if (decisive.some((check) => check.state === 'fail')) return 'invalid';

  if (state('signature') === 'pass') {
    const warned = checks.some((check) => check.state === 'warn' || check.state === 'fail');
    return warned ? 'verified-with-warnings' : 'verified';
  }

  const attempted = checks.some(
    (check) => check.id !== 'trust-directory' && check.state !== 'not-reached',
  );
  return attempted ? 'unverifiable' : 'not-checked';
}

// ---------------------------------------------------------------------------
// Key shape
// ---------------------------------------------------------------------------

function checkKeyShape(
  key: EcJwk,
  findings: RuleOutput[],
  ladder: Ladder,
): { x: string; y: string } | undefined {
  const problems: string[] = [];
  if (key.kty !== 'EC') problems.push(`kty is ${JSON.stringify(key.kty)}, not "EC"`);
  if (key.crv !== 'P-256') problems.push(`crv is ${JSON.stringify(key.crv)}, not "P-256"`);
  if (typeof key.x !== 'string' || typeof key.y !== 'string') {
    problems.push('the x and y coordinates are missing or are not strings');
  }
  if (key.d !== undefined) problems.push('the key carries d, the private key parameter');

  if (problems.length > 0) {
    ladder.set('key-shape', 'fail', problems[0]);
    findings.push(
      finding(
        key.d === undefined ? 'SHC-KEY-NOT-EC-P256' : 'SHC-KEY-CARRIES-PRIVATE-PARAMETER',
        key.d === undefined ? 'error' : 'fatal',
        'sender',
        key.d === undefined
          ? 'The key this card names cannot be used for an ES256 signature.'
          : "The issuer has published its PRIVATE key.",
        key.d === undefined
          ? `Health cards are signed with a P-256 EC key and nothing else, but ${listOut(problems)}. There is no key here to verify against.`
          : `The published key set contains d, the private key parameter, so anyone who fetched ${'that URL'} can sign cards as this issuer. Every card this key ever signed should be treated as unverified until the key is replaced and the old one removed from the set.`,
        {
          ...(key.d === undefined
            ? {}
            : {
                remedy:
                  'Rotate the key immediately, publish only the public parameters, and revoke any certificates bound to it.',
              }),
          citation: SHC_CITATIONS.issuerKeys,
        },
      ),
    );
    if (typeof key.x !== 'string' || typeof key.y !== 'string' || key.crv !== 'P-256') {
      return undefined;
    }
  } else {
    ladder.set('key-shape', 'pass');
  }

  // `use`, `alg` and `key_ops` are each a SHALL, and each is a separate way for
  // a key to say it must not be used for the thing it is about to be used for.
  const usage: string[] = [];
  if (key.use !== undefined && key.use !== 'sig') {
    usage.push(`use is ${JSON.stringify(key.use)} rather than "sig"`);
  }
  if (key.alg !== undefined && key.alg !== 'ES256') {
    usage.push(`alg is ${JSON.stringify(key.alg)} rather than "ES256"`);
  }
  if (key.key_ops !== undefined && !key.key_ops.includes('verify')) {
    usage.push(`key_ops is ${JSON.stringify(key.key_ops)} and does not include "verify"`);
  }
  const missing: string[] = [];
  if (key.use === undefined) missing.push('use');
  if (key.alg === undefined) missing.push('alg');

  if (usage.length > 0) {
    ladder.set('key-usage', 'fail', usage[0]);
    findings.push(
      finding(
        'SHC-KEY-USAGE-DISAGREES',
        'error',
        'sender',
        'The key says it must not be used for verifying this signature.',
        `The set publishes it as the signing key for this card, and ${listOut(usage)}. A verifier that honours these members, as it is required to, refuses this key and reports the card as unverifiable. Loupe checked the signature anyway and says so here, because knowing the bytes match tells you this is a metadata defect rather than a forged card.`,
        { citation: SHC_CITATIONS.issuerKeys },
      ),
    );
  } else if (missing.length > 0) {
    ladder.set('key-usage', 'warn', `The key omits ${listOut(missing)}.`);
    findings.push(
      finding(
        'SHC-KEY-USAGE-MISSING',
        'warning',
        'sender',
        `The key omits ${listOut(missing)}, and both are required.`,
        'Key selection is defined as filtering the set on kty, use and alg, then matching the kid. A key missing those members is skipped by a verifier that filters before it matches, so this card fails against a conformant verifier while working against a lenient one.',
        { citation: SHC_CITATIONS.issuerKeys },
      ),
    );
  } else {
    ladder.set('key-usage', 'pass');
  }

  return { x: key.x as string, y: key.y as string };
}

/**
 * Does the signature verify over SHA-256 of the signing input?
 *
 * Only ever asked after a normal verification failed. A yes turns "the
 * signature is wrong" into "the producer hashed the input before signing it",
 * which is the difference between a forged card and a one-line bug.
 */
async function verifiesOverDoubleHashedInput(jws: JwsParts, jwk: EcJwk): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true } as JsonWebKey,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    const digest = await crypto.subtle.digest(
      'SHA-256',
      toArrayBuffer(utf8Encode(jws.signingInput)),
    );
    return await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      toArrayBuffer(base64urlToBytes(jws.signatureB64)),
      digest,
    );
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Revocation
// ---------------------------------------------------------------------------

interface RevocationInput {
  transport: Transport;
  iss: string;
  kid: string;
  key: EcJwk;
  rid?: string;
  nbf?: NumericDate;
  skip: boolean;
  exchanges: HttpExchange[];
  findings: RuleOutput[];
  ladder: Ladder;
}

/**
 * The revocation check, whose gate is `crlVersion` on the JWK.
 *
 * The three-state distinction is the part implementations skip: no `crlVersion`
 * means revocation status is UNKNOWN, not "not revoked". A tool that renders
 * those the same way tells a verifier a card is fine when nobody has said so.
 */
async function checkRevocation(input: RevocationInput): Promise<RevocationState> {
  const { ladder, findings } = input;
  const crlVersion = input.key.crlVersion;

  if (input.skip) {
    ladder.set('revocation', 'skipped', 'The revocation check was turned off for this run.');
    return { state: 'not-checked', reason: 'The revocation check was turned off for this run.' };
  }

  if (crlVersion === undefined) {
    ladder.set(
      'revocation',
      'skipped',
      'This issuer publishes no revocation list for this key, so revocation status is unknown.',
    );
    findings.push(
      finding(
        'SHC-REVOCATION-NOT-PUBLISHED',
        'info',
        'nobody',
        'Whether this card has been revoked is unknown.',
        'The check is conditional on the issuer advertising a crlVersion on the key, and this key carries none. So there is no list to consult, and "no list" is not the same as "not revoked". If the issuer needs to invalidate individual cards, this is the mechanism it has not turned on.',
        { citation: SHC_CITATIONS.revocation },
      ),
    );
    return { state: 'not-published' };
  }

  if (input.rid === undefined) {
    ladder.set('revocation', 'skipped', 'The card carries no rid to look up.');
    findings.push(
      finding(
        'SHC-REVOCATION-NO-RID',
        'info',
        'nobody',
        'This card carries no revocation identifier, so it cannot be revoked individually.',
        'The issuer publishes a revocation list for this key, and this card has no rid to match against it. Cards issued before revocation existed are all in this position: the only way to invalidate one is to revoke the whole signing key.',
        { citation: SHC_CITATIONS.revocation },
      ),
    );
    return { state: 'no-rid' };
  }

  const url = issuerCrlUrl(input.iss, input.kid);
  const attempt = await fetchJson(input.transport, url, 'jwks');
  input.exchanges.push(attempt.exchange);

  if (!attempt.ok) {
    ladder.set('revocation', 'fail', attempt.reason);
    findings.push(
      finding(
        'SHC-REVOCATION-LIST-UNREACHABLE',
        'error',
        'server',
        'The issuer advertises a revocation list and the list could not be fetched.',
        `${attempt.reason} The key carries crlVersion ${String(crlVersion)}, so a verifier is required to download ${url} and check this card against it. Because that could not be done, this card's revocation status is unknown, and an unknown status is not a pass.`,
        { citation: SHC_CITATIONS.revocation },
      ),
    );
    return { state: 'unavailable', reason: attempt.reason };
  }

  let list: { ctr?: unknown; rids?: unknown };
  try {
    const parsed: unknown = JSON.parse(attempt.body);
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
    list = parsed as { ctr?: unknown; rids?: unknown };
  } catch {
    ladder.set('revocation', 'fail', 'The revocation list is not JSON.');
    findings.push(
      finding(
        'SHC-REVOCATION-LIST-NOT-JSON',
        'error',
        'server',
        'The revocation list is not JSON.',
        `${url} answered ${attempt.status} with a body that does not parse. Revocation status is unknown, which is not the same as not revoked.`,
        { citation: SHC_CITATIONS.revocation },
      ),
    );
    return { state: 'unavailable', reason: 'The revocation list is not JSON.' };
  }

  // The spec's own snippet shows ctr in string position and the live example
  // serves it as a number, so both are accepted rather than one being right.
  const ctr = typeof list.ctr === 'number' ? list.ctr : Number(list.ctr);
  const rids = Array.isArray(list.rids) ? list.rids.filter((r): r is string => typeof r === 'string') : [];

  if (Number.isFinite(ctr) && typeof crlVersion === 'number' && ctr < crlVersion) {
    findings.push(
      finding(
        'SHC-REVOCATION-LIST-STALE',
        'warning',
        'server',
        `The revocation list is older than the key says it should be (ctr ${ctr}, crlVersion ${crlVersion}).`,
        'The counter on the key is meant to match the counter in the file, so a verifier can cache the list and know when to re-fetch. A file behind its advertised version means a revocation may have been published and not served, most often a stale CDN copy.',
        { citation: SHC_CITATIONS.revocation },
      ),
    );
  }

  for (const entry of rids) {
    const separator = entry.lastIndexOf('.');
    const bare = separator === -1 ? entry : entry.slice(0, separator);
    if (bare !== input.rid) continue;
    if (separator === -1) {
      ladder.set('revocation', 'fail', `This card's rid is on the revocation list.`);
      findings.push(
        finding(
          'SHC-CARD-REVOKED',
          'fatal',
          'sender',
          'The issuer has revoked this card.',
          `Its revocation identifier ${input.rid} appears in the list this issuer publishes for the signing key. The signature is genuine and the issuer has since withdrawn the card, so nothing in it should be relied on.`,
          { citation: SHC_CITATIONS.revocation },
        ),
      );
      return { state: 'revoked', rid: input.rid, matched: entry };
    }
    // A timestamped entry revokes only the cards issued before it, so the
    // comparison is against nbf and a card with no nbf cannot be evaluated.
    const from = Number(entry.slice(separator + 1));
    if (!Number.isFinite(from)) continue;
    const issuedAtSeconds = input.nbf === undefined ? undefined : input.nbf.epochMs / 1000;
    if (issuedAtSeconds === undefined) {
      ladder.set('revocation', 'fail', 'A timestamped revocation matches, and the card has no nbf.');
      findings.push(
        finding
          (
          'SHC-REVOCATION-NEEDS-NBF',
          'error',
          'sender',
          'A timestamped revocation matches this card, and the card has no issuance date to compare it with.',
          `The list revokes ${input.rid} for cards issued before ${new Date(from * 1000).toISOString()}. This card has no nbf claim, so whether it falls inside that window cannot be decided.`,
          { citation: SHC_CITATIONS.revocation },
        ),
      );
      return { state: 'unavailable', reason: 'A timestamped revocation matches and the card has no nbf.' };
    }
    if (issuedAtSeconds < from) {
      ladder.set('revocation', 'fail', 'This card was issued before its revocation timestamp.');
      findings.push(
        finding(
          'SHC-CARD-REVOKED',
          'fatal',
          'sender',
          'The issuer has revoked this card.',
          `The list revokes ${input.rid} for cards issued before ${new Date(from * 1000).toISOString()}, and this one was issued ${new Date(input.nbf === undefined ? 0 : input.nbf.epochMs).toISOString()}. The signature is genuine and the card has been withdrawn.`,
          { citation: SHC_CITATIONS.revocation },
        ),
      );
      return { state: 'revoked', rid: input.rid, matched: entry, revokedFrom: from };
    }
  }

  ladder.set('revocation', 'pass', `Checked against ${rids.length} entries at counter ${ctr}.`);
  return { state: 'clean', ctr, entries: rids.length };
}

// ---------------------------------------------------------------------------
// Trust directories
// ---------------------------------------------------------------------------

async function checkTrustDirectories(
  transport: Transport,
  iss: string,
  directories: readonly TrustDirectory[],
  exchanges: HttpExchange[],
  findings: RuleOutput[],
  ladder: Ladder,
): Promise<TrustState> {
  const consulted: string[] = [];
  for (const directory of directories) {
    const attempt = await fetchJson(transport, directory.url, 'jwks');
    exchanges.push(attempt.exchange);
    consulted.push(directory.name);
    if (!attempt.ok) {
      ladder.set('trust-directory', 'fail', `${directory.name} could not be fetched.`);
      findings.push(
        finding(
          'SHC-TRUST-DIRECTORY-UNREACHABLE',
          'warning',
          'you',
          `${directory.name} could not be fetched.`,
          `${attempt.reason} Nothing about the card changes: a directory says who vouches for an issuer, and not reaching one leaves that question open rather than answering it badly.`,
          { citation: SHC_CITATIONS.trust },
        ),
      );
      return { state: 'unavailable', directory: directory.name, reason: attempt.reason };
    }

    let entries: DirectoryEntry[] = [];
    try {
      const parsed: unknown = JSON.parse(attempt.body);
      const listed =
        typeof parsed === 'object' && parsed !== null
          ? (parsed as { participating_issuers?: unknown }).participating_issuers
          : undefined;
      if (Array.isArray(listed)) entries = listed as DirectoryEntry[];
    } catch {
      entries = [];
    }

    if (entries.length === 0) {
      ladder.set('trust-directory', 'fail', `${directory.name} did not parse as an issuer list.`);
      return {
        state: 'unavailable',
        directory: directory.name,
        reason: 'The directory did not parse as a list of participating issuers.',
      };
    }

    const exact = entries.find((entry) => entry.iss === iss);
    const canonical = exact ?? entries.find((entry) => entry.canonical_iss === iss);
    if (canonical !== undefined) {
      const name = typeof canonical.name === 'string' ? canonical.name : undefined;
      ladder.set('trust-directory', 'pass', `Listed in ${directory.name}.`);
      return {
        state: 'listed',
        directory: directory.name,
        matchedOn: exact === undefined ? 'canonical_iss' : 'iss',
        ...(name === undefined ? {} : { name }),
      };
    }
  }

  // Not listed is INFORMATIONAL, never a failure. The one directory that exists
  // covers US COVID-19 issuers, so an Australian or connectathon issuer is
  // expected to be absent, and rendering that as untrusted would be wrong.
  ladder.set('trust-directory', 'warn', `Not listed in ${listOut(consulted)}.`);
  findings.push(
    finding(
      'SHC-ISSUER-NOT-IN-DIRECTORY',
      'info',
      'you',
      `This issuer is not listed in ${listOut(consulted)}.`,
      `${directories.map((d) => d.scope).join(' ')} Unlisted is not untrusted: the specification defines no trust framework at all, and every verifier decides which issuers it accepts. Deciding that is your job, and this tool will not do it for you by colouring an absence red.`,
      { citation: SHC_CITATIONS.trust },
    ),
  );
  return { state: 'unlisted', directories: consulted };
}

// ---------------------------------------------------------------------------
// Content minimisation
// ---------------------------------------------------------------------------

export interface MinificationOptions {
  /**
   * True when this card is delivered as a QR code, where minimisation is a
   * SHALL. A card delivered only through a SMART Health Link is not strictly
   * bound by it, so the same violation is reported at a lower severity and the
   * copy says which case applies.
   */
  deliveredAsQr?: boolean;
  /** How many example paths to name per violation. */
  examples?: number;
}

/**
 * Check the content-minimisation rules against a card's FHIR bundle.
 *
 * A conformance check no other browser tool offers, and one that catches real
 * defects: a bundle carrying narrative and `Coding.display` for every code is
 * three times the size it should be, which is the difference between a card
 * that fits in a QR and one that does not.
 *
 * Violations are aggregated per rule with a count and a few example paths.
 * Reporting 200 separate findings for a 55-entry bundle is technically accurate
 * and useless to read.
 */
export function minificationFindings(
  bundle: unknown,
  options: MinificationOptions = {},
): RuleOutput[] {
  const limit = options.examples ?? 3;
  const severity: Severity = options.deliveredAsQr === true ? 'error' : 'warning';
  const scope =
    options.deliveredAsQr === true
      ? 'Minimisation is required of any card that will be shown as a QR code.'
      : 'Minimisation is required of cards shown as QR codes. This one arrived through a SMART Health Link, where the rule does not strictly bind, so this is a size and consistency observation rather than a violation.';

  if (typeof bundle !== 'object' || bundle === null) return [];
  const record = bundle as Record<string, unknown>;
  const entries = Array.isArray(record.entry) ? record.entry : [];
  if (entries.length === 0) return [];

  const tally = new Map<string, string[]>();
  const note = (rule: string, path: string): void => {
    const held = tally.get(rule);
    if (held === undefined) tally.set(rule, [path]);
    else held.push(path);
  };

  const fullUrls = new Set<string>();
  const references: Array<{ value: string; path: string }> = [];

  entries.forEach((entry, index) => {
    if (typeof entry !== 'object' || entry === null) return;
    const entryRecord = entry as Record<string, unknown>;
    const base = `entry[${index}]`;

    const fullUrl = entryRecord.fullUrl;
    if (typeof fullUrl === 'string') {
      fullUrls.add(fullUrl);
      if (!/^resource:\d+$/.test(fullUrl)) note('fullUrl', `${base}.fullUrl = ${fullUrl}`);
    } else {
      note('fullUrl-missing', `${base}.fullUrl`);
    }

    walk(entryRecord.resource, `${base}.resource`, note, references);
  });

  for (const reference of references) {
    if (/^resource:\d+$/.test(reference.value) && !fullUrls.has(reference.value)) {
      note('dangling-reference', `${reference.path} = ${reference.value}`);
    }
  }

  const rules: Array<{ key: string; ruleId: string; title: (n: number) => string; detail: string }> = [
    {
      key: 'resource-id',
      ruleId: 'SHC-MIN-RESOURCE-ID',
      title: (n) => `${n} ${n === 1 ? 'resource carries' : 'resources carry'} an id.`,
      detail:
        'Resource.id is stripped from a minimised bundle, because an id from the issuing system means nothing to a receiver and the bundle is addressed by entry position instead. Rows must be keyed on the index, so an id here is dead weight.',
    },
    {
      key: 'meta',
      ruleId: 'SHC-MIN-META',
      title: (n) => `${n} ${n === 1 ? 'resource carries' : 'resources carry'} meta beyond security labels.`,
      detail:
        'Resource.meta is allowed in exactly one case: to carry meta.security and nothing else. A meta with profile, lastUpdated or versionId is a minimisation violation, and lastUpdated in particular leaks when the issuing system last touched the record.',
    },
    {
      key: 'narrative',
      ruleId: 'SHC-MIN-NARRATIVE',
      title: (n) => `${n} ${n === 1 ? 'resource carries' : 'resources carry'} a text narrative.`,
      detail:
        'DomainResource.text is stripped, which is why a viewer of health cards can never fall back to narrative and has to render from structured data. Sending it costs space and no receiver will show it.',
    },
    {
      key: 'codeable-text',
      ruleId: 'SHC-MIN-CODEABLE-TEXT',
      title: (n) => `${n} CodeableConcept${n === 1 ? '' : 's'} ${n === 1 ? 'carries' : 'carry'} text.`,
      detail:
        'CodeableConcept.text is stripped from a minimised bundle. It is the most useful thing to a human reader, which is exactly why a viewer needs its own display table for the codes health cards use.',
    },
    {
      key: 'coding-display',
      ruleId: 'SHC-MIN-CODING-DISPLAY',
      title: (n) => `${n} Coding${n === 1 ? '' : 's'} ${n === 1 ? 'carries' : 'carry'} a display.`,
      detail:
        'Coding.display is stripped, so a receiver gets a bare system and code and looks the wording up itself. Sending a display also risks a display that does not match the code system, which a terminology-aware validator rejects.',
    },
    {
      key: 'fullUrl',
      ruleId: 'SHC-MIN-FULLURL-NOT-SHORT',
      title: (n) => `${n} entry ${n === 1 ? 'fullUrl is' : 'fullUrls are'} not a short resource: URI.`,
      detail:
        'Entry fullUrls are short resource-scheme URIs, resource:0, resource:1 and so on, and references point at those. A full server URL here is both larger and a leak of where the record came from.',
    },
    {
      key: 'fullUrl-missing',
      ruleId: 'SHC-MIN-FULLURL-MISSING',
      title: (n) => `${n} ${n === 1 ? 'entry has' : 'entries have'} no fullUrl.`,
      detail:
        'Without a fullUrl there is nothing for a reference to point at, so any resource:N reference into that entry dangles and a viewer cannot link a result to the patient it belongs to.',
    },
    {
      key: 'reference',
      ruleId: 'SHC-MIN-REFERENCE-NOT-SHORT',
      title: (n) => `${n} ${n === 1 ? 'reference is' : 'references are'} not a short resource: URI.`,
      detail:
        'References inside a minimised bundle use the resource: scheme so they resolve against the entry list rather than against a server. An absolute or relative FHIR reference here resolves to nothing inside the card.',
    },
    {
      key: 'dangling-reference',
      ruleId: 'SHC-REFERENCE-DANGLING',
      title: (n) => `${n} ${n === 1 ? 'reference points' : 'references point'} at an entry that is not in the bundle.`,
      detail:
        'A resource: reference resolves against the bundle’s own fullUrls and nothing else, so a reference to an entry that was not included cannot be followed by any receiver. Usually the referenced resource was dropped when the bundle was trimmed.',
    },
  ];

  const out: RuleOutput[] = [];
  for (const rule of rules) {
    const hits = tally.get(rule.key);
    if (hits === undefined || hits.length === 0) continue;
    const shown = hits.slice(0, limit);
    const dangling = rule.key === 'dangling-reference';
    out.push(
      finding(
        rule.ruleId,
        dangling ? 'error' : severity,
        'sender',
        rule.title(hits.length),
        `${rule.detail} ${dangling ? '' : scope} Examples: ${shown.join(', ')}${
          hits.length > shown.length ? `, and ${hits.length - shown.length} more` : ''
        }.`.replace('  ', ' '),
        { citation: CITATIONS.shcMinify },
      ),
    );
  }
  return out;
}

type Noter = (rule: string, path: string) => void;

function walk(
  node: unknown,
  path: string,
  note: Noter,
  references: Array<{ value: string; path: string }>,
): void {
  if (Array.isArray(node)) {
    node.forEach((child, index) => walk(child, `${path}[${index}]`, note, references));
    return;
  }
  if (typeof node !== 'object' || node === null) return;
  const record = node as Record<string, unknown>;

  if (typeof record.resourceType === 'string') {
    if (record.id !== undefined) note('resource-id', `${path}.id`);
    if (record.text !== undefined) note('narrative', `${path}.text`);
    const meta = record.meta;
    if (typeof meta === 'object' && meta !== null) {
      const keys = Object.keys(meta as Record<string, unknown>).filter((key) => key !== 'security');
      if (keys.length > 0) note('meta', `${path}.meta (${keys.join(', ')})`);
    }
  }

  // A CodeableConcept is recognised by shape rather than by the element name,
  // because the name differs per resource (code, vaccineCode, medicationCodeableConcept…).
  if (Array.isArray(record.coding)) {
    if (typeof record.text === 'string') note('codeable-text', `${path}.text`);
    record.coding.forEach((coding, index) => {
      if (typeof coding !== 'object' || coding === null) return;
      if (typeof (coding as Record<string, unknown>).display === 'string') {
        note('coding-display', `${path}.coding[${index}].display`);
      }
    });
  }

  if (typeof record.reference === 'string') {
    references.push({ value: record.reference, path: `${path}.reference` });
    if (!/^resource:\d+$/.test(record.reference)) {
      note('reference', `${path}.reference = ${record.reference}`);
    }
  }

  for (const [key, value] of Object.entries(record)) {
    if (key === 'coding' || key === 'reference' || key === 'text' || key === 'meta') continue;
    walk(value, `${path}.${key}`, note, references);
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

type JsonFetch =
  | { ok: true; url: string; status: number; body: string; exchange: HttpExchange }
  | {
      ok: false;
      url: string;
      kind: 'network' | 'status';
      status: number;
      statusText?: string;
      reason: string;
      exchange: HttpExchange;
    };

/**
 * One GET through the injected transport, recorded either way.
 *
 * `purpose` is the pipeline's own label set and it has no member for a
 * revocation list or a directory, so both travel as `jwks`: widening a shared
 * type from this file would reach outside what this area owns.
 */
async function fetchJson(
  transport: Transport,
  url: string,
  purpose: TransportRequest['purpose'],
): Promise<JsonFetch> {
  const request: TransportRequest = {
    method: 'GET',
    url,
    purpose,
    headers: { accept: 'application/json' },
  };
  try {
    const response = await transport.send(request);
    const exchange: HttpExchange = {
      request: toRequestRecord(request),
      response: toResponseRecord(response),
    };
    if (!response.ok) {
      return {
        ok: false,
        url,
        kind: 'status',
        status: response.status,
        ...(response.statusText === '' ? {} : { statusText: response.statusText }),
        reason: `A GET of ${url} returned HTTP ${response.status}.`,
        exchange,
      };
    }
    return { ok: true, url, status: response.status, body: response.body, exchange };
  } catch (error) {
    const failure =
      error instanceof NetworkFailure
        ? error
        : new NetworkFailure(
            error instanceof Error ? error.message : String(error),
            'blocked-by-browser',
            0,
          );
    return {
      ok: false,
      url,
      kind: 'network',
      status: 0,
      reason: `The request to ${url} did not complete: ${failure.message}`,
      exchange: {
        request: toRequestRecord(request),
        response: failureToResponseRecord(failure),
      },
    };
  }
}

function parseKeySet(body: string): EcJwk[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const keys = (parsed as { keys?: unknown }).keys;
  if (!Array.isArray(keys)) return undefined;
  return keys.filter((key): key is EcJwk => typeof key === 'object' && key !== null);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function describeJsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  switch (typeof value) {
    case 'string':
      return 'a string';
    case 'number':
      return 'a number';
    case 'boolean':
      return 'a boolean';
    case 'undefined':
      return 'absent';
    default:
      return 'an object';
  }
}

function listOut(values: readonly string[]): string {
  if (values.length === 0) return 'nothing';
  if (values.length === 1) return values[0] as string;
  return `${values.slice(0, -1).join(', ')} and ${values[values.length - 1] as string}`;
}

function describeGap(ms: number): string {
  const seconds = Math.abs(ms) / 1000;
  const units: Array<[number, string]> = [
    [31_536_000, 'year'],
    [2_592_000, 'month'],
    [86_400, 'day'],
    [3600, 'hour'],
    [60, 'minute'],
  ];
  for (const [size, name] of units) {
    if (seconds >= size) {
      const count = Math.round(seconds / size);
      return `${count} ${name}${count === 1 ? '' : 's'}`;
    }
  }
  return `${Math.round(seconds)} seconds`;
}

function safeBase64url(value: string): Uint8Array | undefined {
  try {
    return base64urlToBytes(value);
  } catch {
    return undefined;
  }
}

function looksLikeJsonBytes(bytes: Uint8Array): boolean {
  return bytes[0] === 0x7b || bytes[0] === 0x5b;
}

function looksLikeHtml(body: string): boolean {
  return /^\s*<(!doctype|html)/i.test(body);
}
