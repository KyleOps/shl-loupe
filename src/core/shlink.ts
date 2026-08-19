/**
 * The `shlink:` payload: recognising it, decoding it, and judging it member by
 * member against the specification.
 *
 * Judging is separate from decoding on purpose. A link can be perfectly
 * decodable and still be unopenable by anyone but its author, and the whole
 * point of this tool is to say which of those two situations you are in before
 * a single request goes out.
 */
import { base64urlToBytes, DecodeError, utf8Decode } from './bytes';
import type { KvRow } from './trace';

export interface ShlPayload {
  url?: unknown;
  key?: unknown;
  exp?: unknown;
  flag?: unknown;
  label?: unknown;
  v?: unknown;
  [member: string]: unknown;
}

/** The payload once judged, with each member narrowed to what we can rely on. */
export interface ShlLink {
  raw: ShlPayload;
  url: string;
  key: string;
  exp?: number;
  flags: ShlFlag[];
  label?: string;
  version?: string | number;
  /** Members present in the payload that the specification does not define. */
  extraMembers: string[];
}

export type ShlFlag = 'L' | 'P' | 'U';

/** How the link arrived, which matters because some forms are non-conformant. */
export type ShlinkForm =
  | 'shlink-uri' // shlink:/eyJ...
  | 'shlink-uri-double-slash' // shlink://eyJ...  (a common mistake)
  | 'viewer-fragment' // https://viewer.example.org#shlink:/eyJ...
  | 'viewer-query' // https://viewer.example.org?shlink=... (non-conformant)
  | 'bare-payload'; // eyJ... with no prefix at all

export interface ShlinkExtraction {
  form: ShlinkForm;
  encodedPayload: string;
  /** The viewer origin, when the link was wrapped for one. */
  viewerUrl?: string;
}

const ENCODED = '[A-Za-z0-9_-]{16,}';

/**
 * Pull the encoded payload out of whatever the user pasted.
 *
 * Deliberately generous: a link copied out of a chat app arrives with trailing
 * punctuation, a leading "Shovan:", a soft line break in the middle, or the
 * whole thing URL-escaped. Refusing those is refusing the actual job.
 */
export function extractShlink(input: string): ShlinkExtraction | undefined {
  // Chat clients wrap long links; a soft break inside base64url is not part of it.
  const text = input.trim().replace(/\s+/g, '');
  if (text.length === 0) return undefined;

  const decoded = safeDecodeUriComponent(text);

  const viewerFragment = decoded.match(new RegExp(`^(https?://[^#]*)#shlink:/{1,2}(${ENCODED})`, 'i'));
  if (viewerFragment) {
    return {
      form: 'viewer-fragment',
      encodedPayload: viewerFragment[2] as string,
      viewerUrl: viewerFragment[1] as string,
    };
  }

  const viewerQuery = decoded.match(
    new RegExp(`^(https?://[^?#]*)\\?(?:shlink|shl)=(?:shlink:/{1,2})?(${ENCODED})`, 'i'),
  );
  if (viewerQuery) {
    return {
      form: 'viewer-query',
      encodedPayload: viewerQuery[2] as string,
      viewerUrl: viewerQuery[1] as string,
    };
  }

  const uri = decoded.match(new RegExp(`shlink:(/{1,2})(${ENCODED})`, 'i'));
  if (uri) {
    return {
      form: (uri[1] as string) === '//' ? 'shlink-uri-double-slash' : 'shlink-uri',
      encodedPayload: uri[2] as string,
    };
  }

  // A bare payload, but only if it actually decodes to something SHL-shaped:
  // otherwise every base64url blob in the world is a candidate.
  const bare = decoded.match(new RegExp(`^(${ENCODED})$`));
  if (bare && looksLikeShlPayload(bare[1] as string)) {
    return { form: 'bare-payload', encodedPayload: bare[1] as string };
  }
  return undefined;
}

function looksLikeShlPayload(encoded: string): boolean {
  try {
    const value: unknown = JSON.parse(utf8Decode(base64urlToBytes(encoded)));
    return typeof value === 'object' && value !== null && 'url' in value && 'key' in value;
  } catch {
    return false;
  }
}

function safeDecodeUriComponent(value: string): string {
  // A link pasted out of a URL bar can be percent-escaped once or twice. Only
  // unescape while it keeps looking more like a link than it did.
  let current = value;
  for (let i = 0; i < 2; i += 1) {
    if (!current.includes('%')) break;
    try {
      const next = decodeURIComponent(current);
      if (next === current) break;
      current = next;
    } catch {
      break;
    }
  }
  return current;
}

export function decodeShlPayload(encoded: string): ShlPayload {
  let text: string;
  try {
    text = utf8Decode(base64urlToBytes(encoded));
  } catch (error) {
    if (error instanceof DecodeError) throw error;
    throw new DecodeError('The payload is not valid base64url.');
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new DecodeError(
      'The payload decoded, but it is not JSON.',
      text.length > 0
        ? `It starts with ${JSON.stringify(text.slice(0, 40))}. A SMART Health Link payload is a JSON object.`
        : undefined,
    );
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DecodeError('The payload is JSON, but not a JSON object.');
  }
  return value as ShlPayload;
}

// ---------------------------------------------------------------------------
// Member level conformance
// ---------------------------------------------------------------------------

export const SPEC_MEMBERS = ['url', 'key', 'exp', 'flag', 'label', 'v'] as const;

export interface MemberVerdict {
  member: string;
  present: boolean;
  status: 'ok' | 'warn' | 'fail';
  /** What we will treat the value as, rendered for display. */
  display: string;
  note?: string;
}

export interface ShlValidation {
  link?: ShlLink;
  verdicts: MemberVerdict[];
  /** Fatal problems: the payload cannot be used at all. */
  fatal: string[];
}

/**
 * Judge every member, and build the usable {@link ShlLink} when `url` and `key`
 * are both present and sane. Anything else is reported, not thrown: a viewer
 * that bails on the first problem tells you one thing, when the interesting
 * output is the whole table at once.
 */
export function validateShlPayload(payload: ShlPayload): ShlValidation {
  const verdicts: MemberVerdict[] = [];
  const fatal: string[] = [];

  // url
  const url = payload.url;
  if (typeof url !== 'string' || url.length === 0) {
    fatal.push(
      url === undefined
        ? 'The payload has no `url` member, so there is no manifest to request.'
        : 'The `url` member is not a string.',
    );
    verdicts.push({
      member: 'url',
      present: url !== undefined,
      status: 'fail',
      display: url === undefined ? 'absent' : JSON.stringify(url),
      note: 'Required. The manifest URL for this link.',
    });
  } else {
    const scheme = url.slice(0, url.indexOf(':') + 1).toLowerCase();
    const httpsOk = scheme === 'https:';
    verdicts.push({
      member: 'url',
      present: true,
      status: httpsOk ? 'ok' : 'fail',
      display: url,
      ...(httpsOk ? {} : { note: `The URL scheme is ${scheme || 'missing'}; it must be https.` }),
    });
    if (!httpsOk) fatal.push(`The manifest URL is not https (${scheme || 'no scheme'}).`);
  }

  // key
  const key = payload.key;
  if (typeof key !== 'string' || key.length === 0) {
    fatal.push(
      key === undefined
        ? 'The payload has no `key` member, so nothing it points at can be decrypted.'
        : 'The `key` member is not a string.',
    );
    verdicts.push({
      member: 'key',
      present: key !== undefined,
      status: 'fail',
      display: key === undefined ? 'absent' : typeof key,
      note: 'Required. 43 characters of base64url, being 32 random bytes.',
    });
  } else {
    let byteLength = -1;
    let decodeNote: string | undefined;
    try {
      byteLength = base64urlToBytes(key).byteLength;
    } catch (error) {
      decodeNote = error instanceof DecodeError ? error.message : 'Not base64url.';
    }
    const ok = byteLength === 32;
    verdicts.push({
      member: 'key',
      present: true,
      status: ok ? 'ok' : 'fail',
      display: `${key.length} characters${byteLength >= 0 ? `, ${byteLength} bytes` : ''}`,
      ...(ok
        ? {}
        : {
            note:
              decodeNote ??
              `A link key is 32 bytes (43 base64url characters); this decodes to ${byteLength}.`,
          }),
    });
    if (!ok) {
      fatal.push(
        decodeNote ??
          `The key decodes to ${byteLength} bytes, but AES-256-GCM needs exactly 32. No file in this link can be decrypted.`,
      );
    }
  }

  // exp
  const exp = payload.exp;
  if (exp === undefined) {
    verdicts.push({
      member: 'exp',
      present: false,
      status: 'ok',
      display: 'absent',
      note: 'Optional. Without it the link does not expire on its own.',
    });
  } else if (typeof exp !== 'number' || !Number.isFinite(exp)) {
    verdicts.push({
      member: 'exp',
      present: true,
      status: 'fail',
      display: JSON.stringify(exp),
      note: '`exp` must be a number of seconds since the Unix epoch.',
    });
  } else {
    const looksLikeMilliseconds = exp > 1e11;
    verdicts.push({
      member: 'exp',
      present: true,
      status: looksLikeMilliseconds ? 'warn' : 'ok',
      display: `${exp} (${new Date(exp * 1000).toISOString()})`,
      ...(looksLikeMilliseconds
        ? {
            note: 'This value is too large for epoch seconds. It looks like milliseconds, which would push the expiry thousands of years out.',
          }
        : {}),
    });
  }

  // flag
  const flagValue = payload.flag;
  const flags: ShlFlag[] = [];
  if (flagValue === undefined) {
    verdicts.push({
      member: 'flag',
      present: false,
      status: 'ok',
      display: 'absent',
      note: 'Optional. No flags means a one-time-ish manifest link with no passcode.',
    });
  } else if (typeof flagValue !== 'string') {
    verdicts.push({
      member: 'flag',
      present: true,
      status: 'fail',
      display: JSON.stringify(flagValue),
      note: '`flag` must be a string of flag characters, for example "LP".',
    });
  } else {
    const unknown = flagValue
      .toUpperCase()
      .split('')
      .filter((c) => !['L', 'P', 'U'].includes(c));
    for (const c of flagValue.toUpperCase().split('')) {
      if ((c === 'L' || c === 'P' || c === 'U') && !flags.includes(c)) flags.push(c);
    }
    const lowercase = flagValue !== flagValue.toUpperCase();
    const notes: string[] = [];
    if (unknown.length > 0) notes.push(`Unrecognised flag ${unknown.map((c) => `"${c}"`).join(', ')}.`);
    if (lowercase) notes.push('Flags are uppercase characters.');
    if (flags.includes('U') && flags.includes('P')) {
      notes.push('U and P cannot be combined: a direct-GET link has no manifest request to carry a passcode.');
    }
    verdicts.push({
      member: 'flag',
      present: true,
      status: notes.length > 0 ? 'warn' : 'ok',
      display: flagValue,
      ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
    });
  }

  // label
  const label = payload.label;
  if (label === undefined) {
    verdicts.push({ member: 'label', present: false, status: 'ok', display: 'absent' });
  } else if (typeof label !== 'string') {
    verdicts.push({
      member: 'label',
      present: true,
      status: 'fail',
      display: JSON.stringify(label),
      note: '`label` must be a string.',
    });
  } else {
    const tooLong = label.length > 80;
    verdicts.push({
      member: 'label',
      present: true,
      status: tooLong ? 'warn' : 'ok',
      display: label,
      ...(tooLong
        ? { note: `The specification caps the label at 80 characters; this is ${label.length}.` }
        : {}),
    });
  }

  // v
  const version = payload.v;
  if (version === undefined) {
    verdicts.push({
      member: 'v',
      present: false,
      status: 'ok',
      display: 'absent',
      note: 'Optional. Absent means version 1.',
    });
  } else {
    const isOne = version === 1 || version === '1';
    verdicts.push({
      member: 'v',
      present: true,
      status: isOne ? 'ok' : 'warn',
      display: `${JSON.stringify(version)} (${typeof version})`,
      ...(isOne
        ? typeof version === 'string'
          ? { note: 'Sent as a string. Issuers differ here; receivers should accept either.' }
          : {}
        : { note: 'This viewer implements version 1 of the payload.' }),
    });
  }

  const extraMembers = Object.keys(payload).filter(
    (member) => !(SPEC_MEMBERS as readonly string[]).includes(member),
  );
  for (const member of extraMembers) {
    verdicts.push({
      member,
      present: true,
      status: 'warn',
      display: JSON.stringify(payload[member]),
      note: 'Not a member the specification defines. A conformant viewer ignores it.',
    });
  }

  if (fatal.length > 0) return { verdicts, fatal };

  return {
    verdicts,
    fatal,
    link: {
      raw: payload,
      url: payload.url as string,
      key: payload.key as string,
      ...(typeof payload.exp === 'number' ? { exp: payload.exp } : {}),
      flags,
      ...(typeof payload.label === 'string' ? { label: payload.label } : {}),
      ...(payload.v === undefined ? {} : { version: payload.v as string | number }),
      extraMembers,
    },
  };
}

/** The member table as trace evidence rows. */
export function verdictsToRows(verdicts: readonly MemberVerdict[]): KvRow[] {
  return verdicts.map((v) => ({
    key: v.member,
    value: v.display,
    mono: v.member !== 'label',
    status: v.status,
    ...(v.note === undefined ? {} : { note: v.note }),
  }));
}

/** Re-encode a payload, for the sandbox and for "fix this link" suggestions. */
export function encodeShlink(payload: ShlPayload): string {
  const ordered: ShlPayload = {};
  for (const member of SPEC_MEMBERS) {
    if (payload[member] !== undefined) ordered[member] = payload[member];
  }
  for (const [member, value] of Object.entries(payload)) {
    if (!(member in ordered)) ordered[member] = value;
  }
  const json = JSON.stringify(ordered);
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `shlink:/${btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}
