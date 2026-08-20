import { describe, expect, it } from 'vitest';
import {
  canonicaliseP256Coordinate,
  decryptDirA256Gcm,
  encryptDirA256Gcm,
  jwkThumbprint,
  parseJweCompact,
  parseJwsCompact,
  verifyEs256,
  octThumbprint,
  matchKeyToJweKid,
  describeIvLength,
  JoseError,
} from './jose';
import { base64urlToBytes, bytesToBase64url, toArrayBuffer, utf8Encode, utf8Decode } from './bytes';

const key = () => crypto.getRandomValues(new Uint8Array(32));

describe('JWE dir A256GCM', () => {
  it('round-trips', async () => {
    const k = key();
    const jwe = await encryptDirA256Gcm(utf8Encode('{"resourceType":"Bundle"}'), k);
    expect(jwe.split('.')).toHaveLength(5);
    expect(jwe.split('.')[1]).toBe('');
    const result = await decryptDirA256Gcm(jwe, k);
    expect(utf8Decode(result.plaintext)).toBe('{"resourceType":"Bundle"}');
    expect(result.sizes.iv).toBe(12);
    expect(result.sizes.tag).toBe(16);
  });

  it('names a wrong key as an authentication failure, not a parse error', async () => {
    const jwe = await encryptDirA256Gcm(utf8Encode('hi'), key());
    await expect(decryptDirA256Gcm(jwe, key())).rejects.toMatchObject({ code: 'auth-failed' });
  });

  it('detects a tampered ciphertext the same way, and says a client cannot tell them apart', async () => {
    const k = key();
    const jwe = await encryptDirA256Gcm(utf8Encode('hello there'), k);
    const parts = jwe.split('.');
    const ct = base64urlToBytes(parts[3] as string);
    ct[0] = (ct[0] as number) ^ 0xff;
    parts[3] = bytesToBase64url(ct);
    const error = await decryptDirA256Gcm(parts.join('.'), k).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JoseError);
    expect((error as JoseError).hint).toContain('cannot tell which');
  });

  it('rejects a JWS where a JWE was required, and says so in the hint', () => {
    expect(() => parseJweCompact('a.b.c')).toThrow(/5 dot-separated parts; this has 3/);
    try {
      parseJweCompact('a.b.c');
    } catch (error) {
      expect((error as JoseError).hint).toContain('Three parts is a JWS');
    }
  });

  it('flags an encrypted key under alg=dir', async () => {
    const k = key();
    const jwe = await encryptDirA256Gcm(utf8Encode('x'), k);
    const parts = jwe.split('.');
    parts[1] = 'AAAA';
    await expect(decryptDirA256Gcm(parts.join('.'), k)).rejects.toMatchObject({
      code: 'encrypted-key-present',
    });
  });

  it('explains ECDH-ES rather than failing opaquely', async () => {
    const header = bytesToBase64url(utf8Encode(JSON.stringify({ alg: 'ECDH-ES', enc: 'A256GCM' })));
    await expect(decryptDirA256Gcm(`${header}.a.b.c.d`, key())).rejects.toMatchObject({
      code: 'unsupported-alg',
    });
  });

  it('rejects a key of the wrong length with the expected size', async () => {
    const k = key();
    const jwe = await encryptDirA256Gcm(utf8Encode('x'), k);
    await expect(decryptDirA256Gcm(jwe, new Uint8Array(16))).rejects.toMatchObject({
      code: 'key-wrong-size',
    });
  });
});

describe('JWS ES256', () => {
  it('verifies a signature and computes the kid as an RFC 7638 thumbprint', async () => {
    const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ]);
    const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as Record<string, string>;
    const kid = await jwkThumbprint({
      kty: 'EC',
      crv: 'P-256',
      x: jwk.x as string,
      y: jwk.y as string,
    });
    const header = bytesToBase64url(utf8Encode(JSON.stringify({ alg: 'ES256', kid, zip: 'DEF' })));
    const payload = bytesToBase64url(utf8Encode('payload-bytes'));
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        pair.privateKey,
        toArrayBuffer(utf8Encode(`${header}.${payload}`)),
      ),
    );
    const jws = parseJwsCompact(`${header}.${payload}.${bytesToBase64url(signature)}`);
    expect(jws.header.kid).toBe(kid);
    await expect(
      verifyEs256(jws, { kty: 'EC', crv: 'P-256', x: jwk.x as string, y: jwk.y as string }),
    ).resolves.toBeUndefined();
  });

  it('names a DER-encoded signature specifically', async () => {
    const der = new Uint8Array([0x30, 0x44, 0x02, 0x20]);
    const header = bytesToBase64url(utf8Encode(JSON.stringify({ alg: 'ES256' })));
    const jws = parseJwsCompact(`${header}.cGF5.${bytesToBase64url(der)}`);
    const error = await verifyEs256(jws, {
      kty: 'EC',
      crv: 'P-256',
      x: 'AA',
      y: 'BB',
    }).catch((e: unknown) => e);
    expect((error as JoseError).hint).toContain('DER-encoded');
  });
});

describe('coordinate canonicalisation', () => {
  it('left-pads a short coordinate rather than rejecting it', () => {
    const short = bytesToBase64url(new Uint8Array(31).fill(7));
    const result = canonicaliseP256Coordinate(short);
    expect(result.padded).toBe(true);
    expect(base64urlToBytes(result.value).byteLength).toBe(32);
    expect(base64urlToBytes(result.value)[0]).toBe(0);
  });

  it('leaves a full-width coordinate alone', () => {
    const full = bytesToBase64url(new Uint8Array(32).fill(9));
    expect(canonicaliseP256Coordinate(full)).toEqual({ value: full, padded: false });
  });
});

describe('key identity before decryption', () => {
  it('matches a header kid against the link key', async () => {
    const keyBytes = crypto.getRandomValues(new Uint8Array(32));
    const keyB64 = bytesToBase64url(keyBytes);
    const kid = await octThumbprint(keyB64);
    await expect(matchKeyToJweKid({ kid }, keyB64)).resolves.toEqual({ verdict: 'match', kid });
  });

  it('proves a mismatch without attempting decryption', async () => {
    const keyB64 = bytesToBase64url(crypto.getRandomValues(new Uint8Array(32)));
    const otherB64 = bytesToBase64url(crypto.getRandomValues(new Uint8Array(32)));
    const kid = await octThumbprint(otherB64);
    const result = await matchKeyToJweKid({ kid }, keyB64);
    expect(result.verdict).toBe('mismatch');
  });

  it('reproduces the thumbprint published in the SMART Health Links examples', async () => {
    // The IG's own example file IPS_IG-bundle-01-enc.txt carries this kid, and
    // this is the key the example link publishes. If this test ever fails, the
    // convention has changed and the diagnosis built on it is no longer sound.
    const key = 'rxTgYlOaKJPFtcEd0qcceN8wEU4p94SqAwIWQe6uX7Q';
    await expect(octThumbprint(key)).resolves.toBe('ufYGlu_C8IuzJ3HV-wQqsIv-pMm2uZm-vGy37r3hwts');
  });

  it('names the python-jose IV length', () => {
    expect(describeIvLength(12)).toBeUndefined();
    expect(describeIvLength(16)).toContain('python-jose');
    expect(describeIvLength(8)).toContain('12 bytes');
  });
});
