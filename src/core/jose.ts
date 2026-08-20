/**
 * The JOSE operations an SHL viewer needs, on WebCrypto and nothing else.
 *
 * Deliberately not the `jose` npm package. Two reasons, and the first is the
 * important one:
 *
 * 1. Diagnostics. A library returns "decryption operation failed" for a wrong
 *    key, a truncated ciphertext, a tampered tag and a mis-sized IV alike.
 *    Loupe has to tell those apart, so it checks each precondition itself and
 *    reports which one broke.
 * 2. Independence. Loupe is used to judge other implementations, including one
 *    written by the same author (Platypus). Sharing a library with the thing
 *    under test hides exactly the class of bug an event is trying to surface.
 *
 * Supported, because this is what the specs actually pin:
 *   JWE  alg=dir, enc=A256GCM, optional zip=DEF   (SMART Health Links)
 *   JWS  alg=ES256, zip=DEF payload                (SMART Health Cards)
 */
import { base64urlToBytes, bytesToBase64url, toArrayBuffer, utf8Decode, utf8Encode } from './bytes';

export class JoseError extends Error {
  constructor(
    message: string,
    readonly code: JoseErrorCode,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'JoseError';
  }
}

export type JoseErrorCode =
  | 'not-compact'
  | 'header-not-json'
  | 'unsupported-alg'
  | 'unsupported-enc'
  | 'missing-key'
  | 'key-wrong-size'
  | 'iv-wrong-size'
  | 'tag-wrong-size'
  | 'auth-failed'
  | 'encrypted-key-present'
  | 'signature-invalid'
  | 'jwk-unusable';

// ---------------------------------------------------------------------------
// Compact serialisation
// ---------------------------------------------------------------------------

export interface JweParts {
  protectedHeaderB64: string;
  encryptedKeyB64: string;
  ivB64: string;
  ciphertextB64: string;
  tagB64: string;
  header: JweHeader;
}

/**
 * A JWE protected header, as it actually arrives: attacker-controlled JSON.
 *
 * Every member is `unknown` on purpose. Declaring `zip?: string` would be a
 * comfortable lie, because the value comes from `JSON.parse` on bytes a stranger
 * produced, and nothing checks it before the header reaches a caller. With the
 * honest type, the runtime guards a reader needs (`typeof x === 'string'`,
 * `String(x)` before interpolating into a message) are required by the compiler
 * rather than remembered, and a linter stops calling them redundant.
 *
 * The comparisons against literals still narrow correctly, so
 * `header.alg !== 'dir'` reads exactly as before.
 */
export interface JweHeader {
  alg?: unknown;
  enc?: unknown;
  zip?: unknown;
  cty?: unknown;
  kid?: unknown;
  epk?: unknown;
  apu?: unknown;
  apv?: unknown;
  [key: string]: unknown;
}

/** Split and decode a JWE compact serialisation, with a precise error per fault. */
export function parseJweCompact(compact: string): JweParts {
  const value = compact.trim();
  const parts = value.split('.');
  if (parts.length !== 5) {
    throw new JoseError(
      `A JWE compact serialisation has 5 dot-separated parts; this has ${parts.length}.`,
      'not-compact',
      parts.length === 3
        ? 'Three parts is a JWS (a signed token), not a JWE. An SHL manifest file must be encrypted.'
        : 'The value was probably truncated, or JSON-serialised JOSE was used instead of compact.',
    );
  }
  const [protectedHeaderB64, encryptedKeyB64, ivB64, ciphertextB64, tagB64] = parts as [
    string,
    string,
    string,
    string,
    string,
  ];
  let header: JweHeader;
  try {
    header = JSON.parse(utf8Decode(base64urlToBytes(protectedHeaderB64))) as JweHeader;
  } catch (error) {
    throw new JoseError(
      'The JWE protected header is not base64url-encoded JSON.',
      'header-not-json',
      error instanceof Error ? error.message : undefined,
    );
  }
  return { protectedHeaderB64, encryptedKeyB64, ivB64, ciphertextB64, tagB64, header };
}


/**
 * Render an untrusted header value for display.
 *
 * Every member of a JWE or JWS header is whatever JSON a stranger produced, so a
 * plain `String(value)` turns an object into "[object Object]" and shows the
 * reader nothing. In a tool whose job is to say what actually arrived, that is
 * the wrong failure: a header carrying `"zip": {"alg": "x"}` is a real defect
 * worth seeing in full.
 */
export function headerValueText(value: unknown): string {
  if (value === undefined) return '(absent)';
  if (typeof value === 'string') return value;
  // No fallback needed: JSON.stringify returns undefined only for undefined, a
  // function or a symbol, and undefined is handled above while the other two
  // cannot survive a JSON.parse.
  return JSON.stringify(value);
}

export interface JweDecryptResult {
  plaintext: Uint8Array;
  header: JweHeader;
  /** Sizes, for the trace. */
  sizes: { iv: number; ciphertext: number; tag: number; plaintext: number };
}

/**
 * Decrypt an `alg=dir`, `enc=A256GCM` JWE with a raw 32-byte content key.
 *
 * Every precondition is checked before the WebCrypto call so that a failure has
 * a nameable cause. The one genuinely ambiguous outcome, an authentication tag
 * mismatch, is reported as such: it means a wrong key OR modified bytes, and no
 * client can tell which.
 */
export async function decryptDirA256Gcm(
  compact: string,
  key: Uint8Array,
): Promise<JweDecryptResult> {
  const parts = parseJweCompact(compact);
  const { header } = parts;

  if (header.alg !== 'dir') {
    throw new JoseError(
      `Unsupported JWE "alg": ${JSON.stringify(header.alg)}.`,
      'unsupported-alg',
      header.alg === 'ECDH-ES'
        ? 'ECDH-ES means the file is addressed to a recipient public key, not to the link key. That is outside the SMART Health Links specification (Platypus uses it for encrypted replies).'
        : 'SMART Health Links files are encrypted with alg="dir": the key in the link IS the content encryption key.',
    );
  }
  if (header.enc !== 'A256GCM') {
    throw new JoseError(
      `Unsupported JWE "enc": ${JSON.stringify(header.enc)}.`,
      'unsupported-enc',
      'SMART Health Links require enc="A256GCM".',
    );
  }
  if (parts.encryptedKeyB64.length > 0) {
    throw new JoseError(
      'The JWE carries an encrypted key, which alg="dir" forbids.',
      'encrypted-key-present',
      'With direct encryption the second part of the compact serialisation must be empty.',
    );
  }
  if (key.byteLength !== 32) {
    throw new JoseError(
      `The link key is ${key.byteLength} bytes; A256GCM needs 32.`,
      'key-wrong-size',
      'The `key` member of an SHL payload is 32 random bytes, base64url-encoded to 43 characters.',
    );
  }

  const iv = base64urlToBytes(parts.ivB64);
  const ciphertext = base64urlToBytes(parts.ciphertextB64);
  const tag = base64urlToBytes(parts.tagB64);

  if (iv.byteLength !== 12) {
    throw new JoseError(
      `The initialisation vector is ${iv.byteLength} bytes; A256GCM uses 12.`,
      'iv-wrong-size',
    );
  }
  if (tag.byteLength !== 16) {
    throw new JoseError(
      `The authentication tag is ${tag.byteLength} bytes; A256GCM uses 16.`,
      'tag-wrong-size',
    );
  }

  const cryptoKey = await crypto.subtle.importKey('raw', toArrayBuffer(key), 'AES-GCM', false, [
    'decrypt',
  ]);
  // WebCrypto expects the tag appended to the ciphertext; JOSE keeps them apart.
  const sealed = new Uint8Array(ciphertext.byteLength + tag.byteLength);
  sealed.set(ciphertext, 0);
  sealed.set(tag, ciphertext.byteLength);

  let plaintext: Uint8Array;
  try {
    const buffer = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: toArrayBuffer(iv),
        // The protected header is the JWE AAD, as its ASCII base64url text.
        additionalData: toArrayBuffer(utf8Encode(parts.protectedHeaderB64)),
        tagLength: 128,
      },
      cryptoKey,
      toArrayBuffer(sealed),
    );
    plaintext = new Uint8Array(buffer);
  } catch {
    throw new JoseError(
      'The authentication tag did not verify.',
      'auth-failed',
      'This is one of three things and a client cannot tell which: the key does not belong to this file, the ciphertext was altered in transit or in storage, or the encrypter computed the tag over something other than the protected header.',
    );
  }

  return {
    plaintext,
    header,
    sizes: {
      iv: iv.byteLength,
      ciphertext: ciphertext.byteLength,
      tag: tag.byteLength,
      plaintext: plaintext.byteLength,
    },
  };
}

/** Encrypt for the sandbox and test-vector minting side of the tool. */
export async function encryptDirA256Gcm(
  plaintext: Uint8Array,
  key: Uint8Array,
  header: JweHeader = { alg: 'dir', enc: 'A256GCM' },
): Promise<string> {
  if (key.byteLength !== 32) throw new JoseError('Key must be 32 bytes.', 'key-wrong-size');
  const protectedHeaderB64 = bytesToBase64url(
    utf8Encode(JSON.stringify({ alg: 'dir', enc: 'A256GCM', ...header })),
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cryptoKey = await crypto.subtle.importKey('raw', toArrayBuffer(key), 'AES-GCM', false, [
    'encrypt',
  ]);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: toArrayBuffer(iv),
        additionalData: toArrayBuffer(utf8Encode(protectedHeaderB64)),
        tagLength: 128,
      },
      cryptoKey,
      toArrayBuffer(plaintext),
    ),
  );
  const ciphertext = sealed.slice(0, sealed.byteLength - 16);
  const tag = sealed.slice(sealed.byteLength - 16);
  return [
    protectedHeaderB64,
    '',
    bytesToBase64url(iv),
    bytesToBase64url(ciphertext),
    bytesToBase64url(tag),
  ].join('.');
}

// ---------------------------------------------------------------------------
// JWS, for SMART Health Cards
// ---------------------------------------------------------------------------

export interface JwsParts {
  headerB64: string;
  payloadB64: string;
  signatureB64: string;
  header: { alg?: string; kid?: string; zip?: string; [key: string]: unknown };
  signingInput: string;
}

export function parseJwsCompact(compact: string): JwsParts {
  const parts = compact.trim().split('.');
  if (parts.length !== 3) {
    throw new JoseError(
      `A JWS compact serialisation has 3 dot-separated parts; this has ${parts.length}.`,
      'not-compact',
      parts.length === 5 ? 'Five parts is a JWE (encrypted), not a JWS (signed).' : undefined,
    );
  }
  const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];
  let header: JwsParts['header'];
  try {
    header = JSON.parse(utf8Decode(base64urlToBytes(headerB64))) as JwsParts['header'];
  } catch {
    throw new JoseError('The JWS header is not base64url-encoded JSON.', 'header-not-json');
  }
  return { headerB64, payloadB64, signatureB64, header, signingInput: `${headerB64}.${payloadB64}` };
}

export interface EcJwk {
  kty: string;
  crv?: string;
  x?: string;
  y?: string;
  kid?: string;
  alg?: string;
  use?: string;
  key_ops?: string[];
  x5c?: string[];
  [key: string]: unknown;
}

/**
 * Verify an ES256 JWS against a P-256 public JWK.
 *
 * The signature is raw R||S (64 bytes), which is what WebCrypto's ECDSA wants,
 * unlike the DER encoding openssl emits. A DER-encoded signature is a real
 * issuer bug seen in the wild, so it is detected and named.
 */
export async function verifyEs256(jws: JwsParts, jwk: EcJwk): Promise<void> {
  if (jwk.kty !== 'EC' || (jwk.crv !== undefined && jwk.crv !== 'P-256')) {
    throw new JoseError(
      `The key is not a P-256 EC key (kty=${headerValueText(jwk.kty)}, crv=${headerValueText(jwk.crv)}).`,
      'jwk-unusable',
    );
  }
  const signature = base64urlToBytes(jws.signatureB64);
  if (signature.byteLength !== 64) {
    throw new JoseError(
      `An ES256 signature is 64 bytes (r‖s); this is ${signature.byteLength}.`,
      'signature-invalid',
      signature[0] === 0x30
        ? 'The first byte is 0x30, so this is a DER-encoded ECDSA signature. JOSE requires the raw fixed-width r‖s form.'
        : undefined,
    );
  }
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      'jwk',
      { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true } as JsonWebKey,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
  } catch (error) {
    throw new JoseError(
      'The issuer key could not be imported.',
      'jwk-unusable',
      error instanceof Error ? error.message : undefined,
    );
  }
  const ok = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    toArrayBuffer(signature),
    toArrayBuffer(utf8Encode(jws.signingInput)),
  );
  if (!ok) {
    throw new JoseError(
      'The signature does not verify against this key.',
      'signature-invalid',
      'Either the card was signed by a different key than the one its `kid` names, or the signing input was built differently (double-hashing the input is a common issuer bug that still round-trips against its own verifier).',
    );
  }
}

/** RFC 7638 JWK thumbprint (SHA-256, base64url), which is what an SHC `kid` is. */
export async function jwkThumbprint(jwk: EcJwk): Promise<string> {
  if (jwk.kty !== 'EC') throw new JoseError('Thumbprint needs an EC key here.', 'jwk-unusable');
  // Lexicographic member order, no whitespace: the canonical form RFC 7638 pins.
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  const digest = await crypto.subtle.digest('SHA-256', toArrayBuffer(utf8Encode(canonical)));
  return bytesToBase64url(new Uint8Array(digest));
}

/**
 * Left-pad a base64url coordinate to 32 bytes.
 *
 * Some issuers emit a coordinate with leading zero bytes stripped. Web Crypto
 * rejects that, but the wider ecosystem accepts it, so a viewer that refuses is
 * the node that breaks. Canonicalise on the way in, and report the deviation.
 */
export function canonicaliseP256Coordinate(value: string): { value: string; padded: boolean } {
  const bytes = base64urlToBytes(value);
  if (bytes.byteLength === 32) return { value, padded: false };
  if (bytes.byteLength > 32) return { value, padded: false };
  const out = new Uint8Array(32);
  out.set(bytes, 32 - bytes.byteLength);
  return { value: bytesToBase64url(out), padded: true };
}

// ---------------------------------------------------------------------------
// The best diagnostic in the tool
// ---------------------------------------------------------------------------

/**
 * RFC 7638 thumbprint of a symmetric key as an `oct` JWK.
 *
 * This exists because of a convention the SMART Health Links examples follow
 * and the prose never mentions: the JWE protected header's `kid` is the
 * thumbprint of the link's own key. AES-GCM authentication failure is
 * completely opaque (a wrong key, a truncated ciphertext and a tampered tag are
 * one indistinguishable `OperationError`), so when a `kid` is present it is the
 * only way to say "this file was encrypted with a different key than the link
 * carries" instead of shrugging at the user.
 *
 * For `oct` the required members are `k` and `kty`, lexicographically ordered,
 * with no whitespace.
 */
export async function octThumbprint(keyBase64url: string): Promise<string> {
  const canonical = JSON.stringify({ k: keyBase64url, kty: 'oct' });
  const digest = await crypto.subtle.digest('SHA-256', toArrayBuffer(utf8Encode(canonical)));
  return bytesToBase64url(new Uint8Array(digest));
}

export type KeyMatch =
  | { verdict: 'match'; kid: string }
  | { verdict: 'mismatch'; kid: string; expected: string }
  | { verdict: 'no-kid' };

/**
 * Compare a JWE header's `kid` against the link key, before trying to decrypt.
 *
 * A mismatch is conclusive and actionable: the sender re-minted the link, or
 * rotated the key, or pasted the key from a different share. A match tells you
 * that a subsequent decryption failure is about the bytes, not the key, which is
 * the other half of the same diagnosis.
 */
export async function matchKeyToJweKid(header: JweHeader, keyBase64url: string): Promise<KeyMatch> {
  if (typeof header.kid !== 'string' || header.kid.length === 0) return { verdict: 'no-kid' };
  const expected = await octThumbprint(keyBase64url);
  return header.kid === expected
    ? { verdict: 'match', kid: header.kid }
    : { verdict: 'mismatch', kid: header.kid, expected };
}

/**
 * Known-bad initialisation vector lengths, and who emits them.
 *
 * A 16-byte IV is the classic python-jose behaviour: it "works" against itself
 * and is rejected by strict libraries, so a share encrypted that way opens in
 * the tool that made it and nowhere else. Naming the library saves an hour.
 */
export function describeIvLength(byteLength: number): string | undefined {
  if (byteLength === 12) return undefined;
  if (byteLength === 16) {
    return 'A 16-byte IV is the signature of an encrypter that used the block size instead of the 96-bit GCM nonce, python-jose being the well-known example. It round-trips against itself and is refused by strict JOSE libraries, so the file opens only in the tool that wrote it.';
  }
  return `A ${byteLength}-byte IV is not the 12 bytes AES-GCM specifies, so conformant receivers will refuse this file outright.`;
}
