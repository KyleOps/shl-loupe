/**
 * One input box that accepts whatever a person has to hand.
 *
 * At an event nobody has the artefact the tool asked for. They have a link, or
 * the JSON their colleague pasted in chat, or a JWE with no link, or the raw
 * output of the curl command someone told them to run. A mode picker makes the
 * user classify their own paste before the tool will look at it, which is
 * exactly backwards: classifying it is the easy part, and it is the part a
 * program is good at.
 *
 * So detection is a function, it is total (every string gets an answer), and its
 * output carries a sentence written for a human rather than a type tag. The
 * sentence names what was found AND what happens next, because "we recognised
 * this" without "here is what we will do" is not an answer.
 */
import { base64urlToBytes, looksLikeJson, utf8Decode } from './bytes';
import { extractShlink, type ShlinkExtraction, type ShlinkForm } from './shlink';
import type { InputKind } from './trace';

/**
 * A narrower name than {@link InputKind}: the kind says which pipeline opens it,
 * the variant says which shape arrived, and the two differ often enough to be
 * worth separating (a health card arrives as numeric digits, as a JSON file
 * wrapper, or as a bare JWS, and all three are `shc`).
 */
export type DetectedVariant =
  | 'empty'
  | 'shlink-uri'
  | 'shlink-uri-double-slash'
  | 'viewer-fragment'
  | 'viewer-query'
  | 'bare-payload'
  | 'shc-numeric'
  | 'shc-file'
  | 'jws-compact'
  | 'jwe-compact'
  | 'manifest-json'
  | 'fhir-bundle'
  | 'fhir-resource'
  | 'hcert-base45'
  | 'base64url'
  | 'json-unrecognised'
  | 'unrecognised';

export type DetectConfidence = 'certain' | 'likely' | 'unsure';

export interface DetectedHttpResponse {
  status: number;
  statusText?: string;
  headers: Record<string, string>;
}

export interface DetectedInput {
  kind: InputKind;
  variant: DetectedVariant;
  confidence: DetectConfidence;
  /** One sentence: what this is, and what Loupe will do with it. */
  sentence: string;
  /** Facts worth showing beside the sentence, shortest first. */
  details: string[];
  /** True when Loupe cannot open this without a decryption key from the user. */
  needsKey: boolean;
  /**
   * The content to hand to the pipeline, with any wrapper peeled off: the body
   * of a pasted HTTP response, or the trimmed text otherwise.
   */
  content: string;
  /** Present when the input carried an SHL payload that decoded. */
  link?: { url?: string; key?: string; label?: string; flag?: string };
  /** Present when the paste was raw HTTP, for example the output of curl -D -. */
  httpResponse?: DetectedHttpResponse;
}

const COMPACT_PART = /^[A-Za-z0-9_-]+$/;
const BARE_BASE64URL = /^[A-Za-z0-9_-]{16,}$/;

export function detectInput(text: string): DetectedInput {
  return detect(text, false);
}

function detect(text: string, insideWrapper: boolean): DetectedInput {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return {
      kind: 'unknown',
      variant: 'empty',
      confidence: 'certain',
      sentence:
        'Nothing pasted yet. A link, a manifest, an encrypted file, a health card or a FHIR bundle all work here.',
      details: [],
      needsKey: false,
      content: '',
    };
  }

  if (!insideWrapper && /^HTTP\/\d/.test(trimmed)) return detectHttpResponse(trimmed);

  if (/^shc:\//i.test(trimmed)) return detectShcNumeric(trimmed);
  if (/^HC1:/.test(trimmed)) return detectHcert(trimmed);

  // JSON is checked before the link forms because it is the stronger signal: a
  // document that parses as JSON is JSON, whereas a link pattern can appear
  // inside one (a sandbox export, a chat log pasted whole).
  if (looksLikeJson(trimmed)) return detectJson(trimmed);

  const shlink = extractShlink(trimmed);
  if (shlink !== undefined) return describeShlink(trimmed, shlink);

  const compact = trimmed.replace(/\s+/g, '');
  const parts = compact.split('.');
  if (parts.length === 5 && parts.every((part, index) => index === 1 || COMPACT_PART.test(part))) {
    return detectJwe(compact, parts as [string, string, string, string, string]);
  }
  if (parts.length === 3 && parts.every((part) => COMPACT_PART.test(part))) {
    return detectJws(compact, parts as [string, string, string]);
  }

  if (BARE_BASE64URL.test(compact)) return detectBareBase64url(compact, insideWrapper);

  return {
    kind: 'unknown',
    variant: 'unrecognised',
    confidence: 'certain',
    sentence:
      'Loupe does not recognise this. It reads SMART Health Links, manifest JSON, encrypted JWE files, health cards, FHIR resources and the raw output of a curl command.',
    details: [`${trimmed.length} characters pasted`],
    needsKey: false,
    content: trimmed,
  };
}

// ---------------------------------------------------------------------------
// Wrappers
// ---------------------------------------------------------------------------

/**
 * A pasted HTTP response, headers and all.
 *
 * This exists because the tool's own answer to "the browser cannot reach it" is
 * a curl command, and the natural next move is to paste back what curl printed.
 * Asking the user to trim the headers off first would waste the most useful part
 * of the paste: the status line and the CORS headers a browser refused to show.
 *
 * `curl -D - -L` prints one header block per hop, so the LAST block is the one
 * that describes the body.
 */
function detectHttpResponse(text: string): DetectedInput {
  let rest = text;
  let response: DetectedHttpResponse | undefined;
  let hops = 0;

  while (/^HTTP\/\d/.test(rest)) {
    const separator = rest.search(/\r?\n\r?\n/);
    const blockEnd = separator === -1 ? rest.length : separator;
    const block = rest.slice(0, blockEnd);
    rest = separator === -1 ? '' : rest.slice(blockEnd).replace(/^\r?\n\r?\n/, '');
    response = parseHeaderBlock(block);
    hops += 1;
  }

  const body = rest.trim();
  const inner = body.length === 0 ? undefined : detect(body, true);
  const status = response?.status ?? 0;
  const cors = response?.headers['access-control-allow-origin'];
  const details = [
    `HTTP ${status}${response?.statusText === undefined ? '' : ` ${response.statusText}`}`,
    hops > 1 ? `${hops} response blocks, so at least ${hops - 1} redirect` : 'one response block',
    cors === undefined
      ? 'no access-control-allow-origin header, which is what a browser needs'
      : `access-control-allow-origin: ${cors}`,
    ...(inner?.details ?? []),
  ];

  if (inner === undefined) {
    return {
      kind: 'unknown',
      variant: 'unrecognised',
      confidence: 'certain',
      sentence:
        `This is an HTTP response with no body, so Loupe can report the status and the headers a browser hid from it, and nothing more. ${
          cors === undefined
            ? 'There is no access-control-allow-origin header here, which is the header a browser needs before it will hand this response to a page.'
            : ''
        }`.trim(),
      details,
      needsKey: false,
      content: '',
      ...(response === undefined ? {} : { httpResponse: response }),
    };
  }

  return {
    ...inner,
    sentence: `An HTTP ${status} response, pasted with its headers. Its body is ${lowerFirst(inner.sentence)}`,
    details,
    ...(response === undefined ? {} : { httpResponse: response }),
  };
}

function parseHeaderBlock(block: string): DetectedHttpResponse {
  const lines = block.split(/\r?\n/);
  const statusLine = lines[0] ?? '';
  const match = /^HTTP\/[\d.]+\s+(\d{3})\s*(.*)$/.exec(statusLine);
  const headers: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const index = line.indexOf(':');
    if (index <= 0) continue;
    headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }
  const statusText = match?.[2]?.trim() ?? '';
  return {
    status: match?.[1] === undefined ? 0 : Number.parseInt(match[1], 10),
    ...(statusText === '' ? {} : { statusText }),
    headers,
  };
}

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

function describeShlink(original: string, found: ShlinkExtraction): DetectedInput {
  const payload = decodePayloadQuietly(found.encodedPayload);
  const url = typeof payload?.url === 'string' ? payload.url : undefined;
  const key = typeof payload?.key === 'string' ? payload.key : undefined;
  const label = typeof payload?.label === 'string' ? payload.label : undefined;
  const flag = typeof payload?.flag === 'string' ? payload.flag : undefined;

  const where = url === undefined ? undefined : safeHost(url);
  const details = [
    `carried as ${FORM_WORDS[found.form]}`,
    `${found.encodedPayload.length} characters of payload`,
    ...(where === undefined ? [] : [`manifest host ${where}`]),
    ...(label === undefined ? [] : [`labelled "${label}"`]),
    ...(flag === undefined ? [] : [`flags ${flag}`]),
  ];

  const sentence =
    payload === undefined
      ? 'A SMART Health Link, whose payload does not decode. Loupe will open it and show exactly where the decoding stops.'
      : `A SMART Health Link${where === undefined ? '' : ` pointing at ${where}`}. Loupe will check every member of the payload, then open the manifest you paste below rather than requesting it.`;

  return {
    kind: 'shlink',
    variant: found.form,
    confidence: 'certain',
    sentence,
    details,
    needsKey: key === undefined,
    content: original.trim(),
    link: {
      ...(url === undefined ? {} : { url }),
      ...(key === undefined ? {} : { key }),
      ...(label === undefined ? {} : { label }),
      ...(flag === undefined ? {} : { flag }),
    },
  };
}

const FORM_WORDS: Record<ShlinkForm, string> = {
  'shlink-uri': 'a shlink:/ URI',
  'shlink-uri-double-slash': 'a shlink:// URI, which has one slash too many',
  'viewer-fragment': 'a viewer URL with the payload after the "#", which is the right place for it',
  'viewer-query':
    'a viewer URL with the payload in the query string, which sends the key to a server',
  'bare-payload': 'a bare base64url payload with no prefix',
};

function decodePayloadQuietly(encoded: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(utf8Decode(base64urlToBytes(encoded)));
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // A payload that does not decode is still a link, and saying so is the
    // pipeline's job rather than detection's.
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// JSON shapes
// ---------------------------------------------------------------------------

function detectJson(text: string): DetectedInput {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = undefined;
  }
  if (typeof value !== 'object' || value === null) {
    return jsonUnrecognised(text, 'This parses as JSON, but not as an object Loupe recognises.');
  }
  if (Array.isArray(value)) {
    return jsonUnrecognised(
      text,
      `This is a JSON array of ${value.length} item${value.length === 1 ? '' : 's'}. Loupe reads a manifest object, a FHIR resource or a health-card file, not a bare array.`,
    );
  }
  const record = value as Record<string, unknown>;

  if (Array.isArray(record.files)) {
    const files = record.files.filter(
      (file): file is Record<string, unknown> => typeof file === 'object' && file !== null,
    );
    const embedded = files.filter((file) => typeof file.embedded === 'string').length;
    const located = files.filter((file) => typeof file.location === 'string').length;
    return {
      kind: 'manifest',
      variant: 'manifest-json',
      confidence: 'certain',
      sentence: `A manifest response with ${files.length} file${files.length === 1 ? '' : 's'}. Loupe will decrypt everything embedded in it with the key you supply, and show a curl command for anything it can only reach by location.`,
      details: [
        ...(typeof record.status === 'string' ? [`status ${record.status}`] : []),
        `${embedded} embedded`,
        `${located} by location`,
      ],
      needsKey: true,
      content: text,
    };
  }

  if (Array.isArray(record.verifiableCredential)) {
    const count = record.verifiableCredential.length;
    return {
      kind: 'shc',
      variant: 'shc-file',
      confidence: 'certain',
      sentence: `A SMART Health Card file holding ${count} signed card${count === 1 ? '' : 's'}. Loupe will read each one, check what it can offline, and render the FHIR inside it.`,
      details: [`${count} verifiable credential${count === 1 ? '' : 's'}`],
      needsKey: false,
      content: text,
    };
  }

  if (typeof record.resourceType === 'string') {
    const isBundle = record.resourceType === 'Bundle';
    const entries = Array.isArray(record.entry) ? record.entry.length : undefined;
    return {
      kind: 'fhir',
      variant: isBundle ? 'fhir-bundle' : 'fhir-resource',
      confidence: 'certain',
      sentence: isBundle
        ? `A FHIR Bundle, already decrypted. Loupe will index it and render it, with no key and no network needed.`
        : `A FHIR ${record.resourceType}, already decrypted. Loupe will render it directly.`,
      details: [
        `resourceType ${record.resourceType}`,
        ...(typeof record.type === 'string' ? [`type ${record.type}`] : []),
        ...(entries === undefined ? [] : [`${entries} entr${entries === 1 ? 'y' : 'ies'}`]),
      ],
      needsKey: false,
      content: text,
    };
  }

  const members = Object.keys(record);
  return jsonUnrecognised(
    text,
    `This is a JSON object with ${members.length === 0 ? 'no members' : `the members ${members.slice(0, 6).join(', ')}`}. It is not a manifest (no files array), a FHIR resource (no resourceType) or a health-card file (no verifiableCredential array).`,
  );
}

function jsonUnrecognised(text: string, sentence: string): DetectedInput {
  return {
    kind: 'unknown',
    variant: 'json-unrecognised',
    confidence: 'certain',
    sentence,
    details: [`${text.length} characters of JSON`],
    needsKey: false,
    content: text,
  };
}

// ---------------------------------------------------------------------------
// Compact JOSE
// ---------------------------------------------------------------------------

function detectJwe(
  compact: string,
  parts: [string, string, string, string, string],
): DetectedInput {
  const header = decodeJoseHeader(parts[0]);
  const alg = typeof header?.alg === 'string' ? header.alg : undefined;
  const enc = typeof header?.enc === 'string' ? header.enc : undefined;
  const zip = typeof header?.zip === 'string' ? header.zip : undefined;
  const encryptedKeyPresent = parts[1].length > 0;

  return {
    kind: 'jwe',
    variant: 'jwe-compact',
    confidence: 'certain',
    sentence:
      'An encrypted file in JWE compact form. Paste the key from its link and Loupe will decrypt it here, with nothing leaving the tab.',
    details: [
      'five dot-separated parts',
      ...(alg === undefined ? [] : [`alg ${alg}`]),
      ...(enc === undefined ? [] : [`enc ${enc}`]),
      ...(zip === undefined ? [] : [`zip ${zip}`]),
      ...(encryptedKeyPresent
        ? ['a non-empty encrypted key, which alg "dir" forbids']
        : ['an empty encrypted key, correct for alg "dir"']),
      `${parts[3].length} characters of ciphertext`,
    ],
    needsKey: true,
    content: compact,
  };
}

function detectJws(compact: string, parts: [string, string, string]): DetectedInput {
  const header = decodeJoseHeader(parts[0]);
  const alg = typeof header?.alg === 'string' ? header.alg : undefined;
  const zip = typeof header?.zip === 'string' ? header.zip : undefined;
  const kid = typeof header?.kid === 'string' ? header.kid : undefined;
  // A health card is the one signed thing an SHL viewer meets: ES256 over a
  // raw-DEFLATE payload is its exact signature, so say so rather than leaving
  // the reader to recognise it.
  const looksLikeCard = alg === 'ES256' && zip === 'DEF';

  return {
    kind: 'jws',
    variant: 'jws-compact',
    confidence: looksLikeCard ? 'certain' : 'likely',
    sentence: looksLikeCard
      ? 'A signed SMART Health Card, on its own rather than inside a file wrapper. Loupe will read it, check what it can offline, and render the FHIR inside it.'
      : 'A signed token in JWS compact form, which is three parts rather than the five an encrypted SHL file has. Loupe will read its header and payload and tell you what it is.',
    details: [
      'three dot-separated parts',
      ...(alg === undefined ? [] : [`alg ${alg}`]),
      ...(zip === undefined ? [] : [`zip ${zip}`]),
      ...(kid === undefined ? [] : [`kid ${kid}`]),
    ],
    needsKey: false,
    content: compact,
  };
}

function decodeJoseHeader(part: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(utf8Decode(base64urlToBytes(part)));
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // Not a decodable header. The variant still holds: the part count is what
    // distinguishes a JWE from a JWS, not whether we could read the header.
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Health cards and certificates
// ---------------------------------------------------------------------------

function detectShcNumeric(text: string): DetectedInput {
  const body = text.slice(text.indexOf('/') + 1);
  const chunked = /^\d+\/\d+\//.test(body);
  const digits = body.replace(/[^\d]/g, '');
  const odd = digits.length % 2 === 1;
  return {
    kind: 'shc',
    variant: 'shc-numeric',
    confidence: 'certain',
    sentence: odd
      ? `A numeric SMART Health Card whose digit count is odd (${digits.length}), so at least one digit is missing. Loupe will decode as far as it can and say where it stops.`
      : `A numeric SMART Health Card, the form a QR code carries. Loupe will decode it back to the signed card and render the FHIR inside it.`,
    details: [
      `${digits.length} digits`,
      ...(chunked ? ['split across chunks, so it came from a multi-part QR code'] : []),
    ],
    needsKey: false,
    content: text.trim(),
  };
}

function detectHcert(text: string): DetectedInput {
  return {
    kind: 'hcert',
    variant: 'hcert-base45',
    confidence: 'certain',
    sentence:
      'An HC1 certificate, the EU Digital COVID Certificate and WHO DDCC family. Loupe recognises it but does not decode COSE and CBOR, so it will name it and stop there rather than guess.',
    details: [`${text.length - 4} characters of base45 after the HC1: prefix`],
    needsKey: false,
    content: text.trim(),
  };
}

// ---------------------------------------------------------------------------
// A bare blob
// ---------------------------------------------------------------------------

/**
 * base64url with no prefix and no dots.
 *
 * Worth one round of unwrapping: people paste the middle of things. If it
 * decodes to text that is itself recognisable, report THAT, because "this is
 * base64url" is a fact about the encoding and never the answer the reader
 * wanted. Recursion is capped at one level so a doubly encoded blob reports
 * honestly rather than being chased.
 */
function detectBareBase64url(compact: string, insideWrapper: boolean): DetectedInput {
  let decoded: string | undefined;
  try {
    decoded = utf8Decode(base64urlToBytes(compact));
  } catch {
    decoded = undefined;
  }

  if (decoded !== undefined && !insideWrapper) {
    const inner = detect(decoded, true);
    if (inner.kind !== 'unknown') {
      return {
        ...inner,
        content: decoded,
        sentence: `base64url, which decodes to ${lowerFirst(inner.sentence)}`,
        details: [`${compact.length} characters of base64url`, ...inner.details],
      };
    }
  }

  const bytes = decoded === undefined ? undefined : base64urlToBytes(compact).byteLength;
  return {
    kind: 'unknown',
    variant: 'base64url',
    confidence: 'unsure',
    sentence:
      'This is base64url, and what it decodes to is not something Loupe recognises. If it is meant to be an SHL payload it should decode to a JSON object with a url and a key.',
    details: [
      `${compact.length} characters`,
      ...(bytes === undefined ? ['does not decode as base64url'] : [`${bytes} bytes decoded`]),
    ],
    needsKey: false,
    content: compact,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeHost(url: string): string | undefined {
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

/** Splice one sentence into another without shouting mid-sentence. */
function lowerFirst(sentence: string): string {
  const first = sentence.charAt(0);
  // An acronym or a spec token keeps its case: "HC1", "A FHIR Bundle" does not.
  if (first !== first.toUpperCase()) return sentence;
  const second = sentence.charAt(1);
  if (second !== '' && second === second.toUpperCase() && /[A-Z]/.test(second)) return sentence;
  return first.toLowerCase() + sentence.slice(1);
}
