/**
 * Byte and text primitives.
 *
 * Written out rather than pulled from a library because the exact failure modes
 * matter here: a viewer that says "invalid link" when the real problem is one
 * stray `+` from a base64 (not base64url) encoder has hidden the answer. Every
 * decoder below reports what specifically was wrong.
 */

export class DecodeError extends Error {
  constructor(
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'DecodeError';
  }
}

const B64URL_ALPHABET = /^[A-Za-z0-9_-]*$/;

/**
 * Strict base64url decode.
 *
 * Rejects standard base64 characters with a specific message, because mixing
 * the two alphabets is the single most common hand rolled encoder bug, and the
 * fix ("your encoder used base64, not base64url") is not guessable from a
 * generic parse error.
 */
export function base64urlToBytes(input: string): Uint8Array {
  const value = input.trim();
  if (value.includes('+') || value.includes('/')) {
    throw new DecodeError(
      'This is standard base64, not base64url.',
      "base64url replaces '+' with '-' and '/' with '_'. Re-encode with a base64url encoder.",
    );
  }
  if (value.includes('=')) {
    // Padding is forbidden in base64url as used across JOSE and SHL, but it is
    // harmless to accept: strip it and carry on, with the deviation reported.
    return base64urlToBytes(value.replace(/=+$/, ''));
  }
  if (!B64URL_ALPHABET.test(value)) {
    const bad = [...new Set(value.split('').filter((c) => !/[A-Za-z0-9_-]/.test(c)))];
    throw new DecodeError(
      `Not base64url: unexpected character${bad.length > 1 ? 's' : ''} ${bad
        .map((c) => JSON.stringify(c))
        .join(', ')}.`,
      'Whitespace, a newline from a copy and paste, or a URL-escaped character will do this.',
    );
  }
  if (value.length % 4 === 1) {
    throw new DecodeError(
      'Truncated base64url: the length leaves one dangling character.',
      'The string was probably cut short in copying, or a QR scan lost the tail.',
    );
  }
  const padded = value + '='.repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export function bytesToBase64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function utf8Decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

export function utf8Encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function base64urlToString(input: string): string {
  return utf8Decode(base64urlToBytes(input));
}

export function stringToBase64url(input: string): string {
  return bytesToBase64url(utf8Encode(input));
}

/** Bytes as `1.2 kB` style text, for evidence rows. */
export function formatBytes(length: number): string {
  if (length < 1024) return `${length} B`;
  if (length < 1024 * 1024) return `${(length / 1024).toFixed(1)} kB`;
  return `${(length / (1024 * 1024)).toFixed(2)} MB`;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Constant-time-ish equality. Not a security boundary here, but free. */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  let diff = 0;
  for (let i = 0; i < a.byteLength; i += 1) diff |= (a[i] as number) ^ (b[i] as number);
  return diff === 0;
}

/** True when the string parses as JSON. Used by input detection. */
export function looksLikeJson(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

/**
 * WebCrypto wants an `ArrayBuffer`, and a `Uint8Array` may be a view onto a
 * slice of a larger (or shared) buffer, which the DOM types reject. Copying is
 * cheap at the sizes involved here and removes the whole class of confusion.
 */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}
