/**
 * The glossary.
 *
 * It exists because the vocabulary is the barrier. At a table, someone says
 * "the manifest" and someone else hears "the file", and twenty minutes go
 * missing. So each entry answers one question in one sentence, names the thing
 * it is most often confused with, and only then adds detail.
 *
 * `confusedWith` is the load-bearing member: a definition that does not
 * separate a term from its neighbour has not done the job. Every value in it
 * must be another term in this list, which the test enforces.
 */
import type { Citation } from '../core/trace';

export interface GlossaryEntry {
  /** The term as a reader will look for it. */
  term: string;
  /** Other names the same thing travels under. */
  aka?: readonly string[];
  /** One sentence. Not two. */
  short: string;
  /** Two or three sentences of the part that actually catches people out. */
  detail?: string;
  /** Terms this is routinely mixed up with, each an entry in this list. */
  confusedWith?: readonly string[];
  citation?: Citation;
}

const SHL_URL =
  'https://build.fhir.org/ig/HL7/smart-health-cards-and-links/links-specification.html';
const SHC_URL =
  'https://build.fhir.org/ig/HL7/smart-health-cards-and-links/cards-specification.html';

export const GLOSSARY: readonly GlossaryEntry[] = [
  {
    term: 'SMART Health Link',
    aka: ['SHL', 'shlink'],
    short:
      'A URL carrying its own decryption key, pointing at one or more encrypted files on a server.',
    detail:
      'The link is the credential: no login, no token, no account. Anyone holding it can read the data, which is why the payload rides in the URL fragment where a server never sees it.',
    confusedWith: ['SMART Health Card'],
    citation: { spec: 'SMART Health Links', section: 'SMART Health Link URIs', url: SHL_URL },
  },
  {
    term: 'SMART Health Card',
    aka: ['SHC'],
    short:
      'A small, signed clinical credential: a compact JWS whose payload is a compressed FHIR bundle.',
    detail:
      'A card is signed by an issuer, so its authorship can be verified. A link is a delivery mechanism and says nothing about authorship. A link can carry cards, cards can be presented without a link, and the two have separate specifications in one implementation guide.',
    confusedWith: ['SMART Health Link', 'JWS'],
    citation: { spec: 'SMART Health Cards', section: 'Health Cards are Compact', url: SHC_URL },
  },
  {
    term: 'Payload',
    short:
      'The JSON object inside a link, base64url encoded: url, key, and up to four more members.',
    detail:
      'It is not encrypted and not signed. Everything in it, the decryption key included, is readable by anybody who has the link.',
    confusedWith: ['Manifest', 'JWE'],
  },
  {
    term: 'Manifest',
    short:
      'The JSON a sharing server returns listing the files currently behind a link, one entry per file.',
    detail:
      'It is fetched with a POST, and it is not the data: each entry either embeds the encrypted file or points at a short-lived URL for it. A link with the U flag has no manifest at all.',
    confusedWith: ['Payload'],
    citation: { spec: 'SMART Health Links', section: 'Manifest Response', url: SHL_URL },
  },
  {
    term: 'Recipient',
    short: 'A free-text string the client sends so the sharer’s audit log records who called.',
    detail:
      'Not authenticated, not machine-parsed, and not a form of access control. It is the only trace a patient has of who opened their link, so a viewer that hardcodes its own product name makes that log useless.',
  },
  {
    term: 'Passcode',
    short: 'A secret sent alongside a manifest request when the link carries the P flag.',
    detail:
      'It is not in the link and cannot be derived from it. Servers count wrong attempts for the life of the link and disable it permanently at the cap, so an automatic retry can destroy the data it was trying to read.',
    confusedWith: ['Key'],
    citation: { spec: 'SMART Health Links', section: 'Passcode failures', url: SHL_URL },
  },
  {
    term: 'Key',
    short:
      'The 32-byte symmetric key in the payload, used to decrypt every file the link ever serves.',
    detail:
      '43 base64url characters. It is a content key, not a credential to a server: it never travels in a request, and the server never sees it.',
    confusedWith: ['Passcode'],
    citation: {
      spec: 'SMART Health Links',
      section: 'Structure of a SMART Health Link Payload: key',
      url: SHL_URL,
    },
  },
  {
    term: 'JWE',
    aka: ['JSON Web Encryption', 'compact JWE'],
    short: 'The encrypted file format: five base64url parts separated by dots.',
    detail:
      'Header, encrypted key, initialisation vector, ciphertext, authentication tag. In a health link the second part is always empty, because the algorithm is "dir" and the link’s key is the content key directly.',
    confusedWith: ['JWS'],
  },
  {
    term: 'JWS',
    aka: ['JSON Web Signature', 'compact JWS'],
    short: 'The signed format: three base64url parts separated by dots.',
    detail:
      'Header, payload, signature. Three parts means signed, five means encrypted, and that count is the fastest way to tell what is in front of you.',
    confusedWith: ['JWE'],
  },
  {
    term: 'AAD',
    aka: ['Additional authenticated data'],
    short:
      'Bytes covered by the authentication tag but not encrypted: here, the JWE protected header.',
    detail:
      'It must be the header exactly as received. Parsing it to read it is fine; re-serialising it before use changes the bytes, fails the tag check, and looks identical to a wrong key.',
  },
  {
    term: 'kid',
    aka: ['Key id'],
    short: 'A key identifier in a JOSE header, conventionally the RFC 7638 thumbprint of the key.',
    detail:
      'Because the convention is a thumbprint, a viewer holding the link’s key can compute the expected value and say "this file was encrypted under a different key" before attempting decryption at all.',
  },
  {
    term: 'CORS',
    aka: ['Cross-Origin Resource Sharing'],
    short:
      'The browser rule that a page may only read a response from another origin if that response says it may.',
    detail:
      'Enforced by browsers and by nothing else, which is why a link that fails in every browser answers curl perfectly. The health links specification never mentions it, so a fully conformant server can be unusable from a browser.',
    confusedWith: ['Preflight'],
    citation: { spec: 'Fetch', section: 'CORS protocol', url: 'https://fetch.spec.whatwg.org/' },
  },
  {
    term: 'Preflight',
    aka: ['OPTIONS request'],
    short: 'An OPTIONS request a browser sends first, to ask whether the real request is allowed.',
    detail:
      'A manifest POST always triggers one, because a JSON content type is not on the Fetch safelist. Servers routinely route POST and leave OPTIONS to fall through to a 404, which fails the request before the POST is ever sent.',
    confusedWith: ['CORS'],
  },
  {
    term: 'Opaque response',
    short:
      'What a no-cors request returns on success: status 0, no headers, no body, but a resolved promise.',
    detail:
      'Nearly indistinguishable from a network error, and the difference is the whole trick: an error rejects, an opaque response resolves. That is how a page with no server of its own can tell "reachable but blocked" from "nothing answered".',
  },
  {
    term: 'Mixed content',
    short:
      'A browser refusing an http request made by an https page, before it reaches the network.',
    detail:
      'Loopback is the exception: http://localhost counts as potentially trustworthy and is allowed. So two visually similar links, one on localhost and one on a private address, fail for entirely different reasons.',
  },
  {
    term: 'U flag',
    short: 'The flag saying the url is a single encrypted file to GET, with no manifest exchange.',
    detail:
      'It is the only shape that works on a static host, which is why every published example uses it. It cannot be combined with a passcode: there would be nowhere to put one.',
    confusedWith: ['Manifest'],
    citation: { spec: 'SMART Health Links', section: 'Flags: U', url: SHL_URL },
  },
  {
    term: 'Raw DEFLATE',
    short: 'DEFLATE compression with no zlib and no gzip wrapper around it.',
    detail:
      'Both layers of this format that compress require it. A wrapper is the most common producer bug, it still verifies cryptographically, and the two-byte signature gives it away: 78 followed by 9c is zlib, 1f 8b is gzip.',
  },
  {
    term: 'Issuer',
    aka: ['iss'],
    short:
      'The https URL identifying who signed a health card, and where its public keys are published.',
    detail:
      'The key set path is string concatenation, iss plus /.well-known/jwks.json, never URL resolution: resolving throws away a deep path and fetches the wrong host root. A trailing slash on iss is a reportable defect.',
    citation: {
      spec: 'SMART Health Cards',
      section: 'Determining keys associated with an issuer',
      url: SHC_URL,
    },
  },
  {
    term: 'Trace',
    short: 'SHLoupe’s record of one run: every step, its evidence, its timing and its verdict.',
    detail:
      'It is plain data, so it serialises to JSON, exports without the key, and replays in a test with no network. It is also the answer to "what did this page actually request": everything, and nothing else.',
  },
];

const BY_TERM = new Map(GLOSSARY.map((entry) => [entry.term.toLowerCase(), entry]));

export function glossaryEntry(term: string): GlossaryEntry | undefined {
  return BY_TERM.get(term.toLowerCase());
}
