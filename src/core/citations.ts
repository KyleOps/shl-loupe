/**
 * One registry for every spec reference the app shows.
 *
 * Citations live here, not inline at the point of use, for two reasons: a
 * quoted normative sentence gets checked once against the published spec rather
 * than in a dozen places, and the Learn screen can enumerate the whole set to
 * build a spec index without crawling the codebase.
 */
import type { Citation } from './trace';

const SHL = 'https://build.fhir.org/ig/HL7/smart-health-cards-and-links/links-specification.html';
const SHC = 'https://build.fhir.org/ig/HL7/smart-health-cards-and-links/cards-specification.html';
const RFC7516 = 'https://www.rfc-editor.org/rfc/rfc7516';
const RFC7638 = 'https://www.rfc-editor.org/rfc/rfc7638';
const FETCH_CORS = 'https://fetch.spec.whatwg.org/#cors-protocol';

const cite =
  (spec: string, url: string) =>
  (section: string, quote?: string): Citation => ({
    spec,
    section,
    url,
    ...(quote === undefined ? {} : { quote }),
  });

const shl = cite('SMART Health Links', SHL);
const shc = cite('SMART Health Cards', SHC);

export const CITATIONS = {
  payloadMembers: shl(
    'Structure of a SMART Health Link Payload',
    'The payload is a JSON object with the following members: `url`, `key`, `exp`, `flag`, `label`, `v`.',
  ),
  payloadUrl: shl(
    'Structure of a SMART Health Link Payload: url',
    '`url`: Manifest URL for this SMART Health Link.',
  ),
  payloadKey: shl(
    'Structure of a SMART Health Link Payload: key',
    '`key`: Decryption key for processing files returned in the manifest. 43 characters, corresponding to 32 random bytes base64urlencoded.',
  ),
  payloadExp: shl(
    'Structure of a SMART Health Link Payload: exp',
    '`exp`: Number representing expiration time in Epoch seconds.',
  ),
  payloadFlag: shl('Structure of a SMART Health Link Payload: flag'),
  payloadLabel: shl('Structure of a SMART Health Link Payload: label'),
  payloadV: shl('Structure of a SMART Health Link Payload: v'),
  flagL: shl('Flags: L', 'L: Indicates the SHL is intended for long-term use.'),
  flagP: shl('Flags: P', 'P: Indicates the SHL requires a passcode.'),
  flagU: shl(
    'Flags: U',
    'U: Indicates the SHL contains exactly one file, accessible via a direct GET.',
  ),
  linkUri: shl('SMART Health Link URIs'),
  viewerUrl: shl('SMART Health Link URIs with a viewer prefix'),
  manifestRequest: shl('Manifest Request'),
  manifestResponse: shl('Manifest Response'),
  manifestFiles: shl('Manifest Response: files'),
  passcodeFailure: shl('Passcode failures'),
  rateLimit: shl('Rate limits'),
  encryption: shl('File encryption'),
  cors: shl('CORS'),
  directFile: shl('Direct file retrieval (U flag)'),
  shcFile: shc('Health Cards are Small'),
  shcJws: shc('Signing Health Cards'),
  shcJwks: shc('Issuer Public Keys'),
  shcKid: {
    spec: 'RFC 7638',
    section: 'JSON Web Key (JWK) Thumbprint',
    url: RFC7638,
    quote:
      'The thumbprint of a JSON Web Key (JWK) is computed as the SHA-256 digest of the UTF-8 representation of the lexicographically ordered required members of the JWK.',
  } satisfies Citation,
  shcVc: shc('Verifiable Credential structure'),
  shcMinify: shc('Health Cards are Small: FHIR content minimisation'),
  jweCompact: {
    spec: 'RFC 7516',
    section: '3.1 JWE Compact Serialization Overview',
    url: RFC7516,
    quote:
      'In the JWE Compact Serialization, a JWE is represented as the concatenation: BASE64URL(UTF8(JWE Protected Header)) || "." || BASE64URL(JWE Encrypted Key) || "." || BASE64URL(JWE Initialization Vector) || "." || BASE64URL(JWE Ciphertext) || "." || BASE64URL(JWE Authentication Tag)',
  } satisfies Citation,
  corsProtocol: {
    spec: 'Fetch',
    section: 'CORS protocol',
    url: FETCH_CORS,
  } satisfies Citation,
} as const;

export type CitationKey = keyof typeof CITATIONS;
