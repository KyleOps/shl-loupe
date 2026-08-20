/**
 * These tests mint a real P-256 key pair, sign a real card, and verify it
 * through the same code path the app uses, then break one thing at a time and
 * assert the SPECIFIC failure gets named.
 *
 * The mutation-per-test shape is deliberate. A single "it verifies a good card"
 * test passes identically whether the failure taxonomy works or is one generic
 * message, which is exactly the class of coverage gap this module exists to
 * close in other people's tools.
 */
import { describe, expect, it } from 'vitest';
import {
  assembleShcQrChunks,
  decodeShcQr,
  encodeShcQr,
  inspectJws,
  issuerCrlUrl,
  issuerJwksUrl,
  KNOWN_TRUST_DIRECTORIES,
  minificationFindings,
  parseHealthCardFile,
  postureFrom,
  verifyHealthCard,
  type CheckId,
  type VerificationCheck,
} from './shc';
import { bytesToBase64url, toArrayBuffer, utf8Encode } from './bytes';
import { deflateRawBytes } from './compress';
import { jwkThumbprint } from './jose';
import { OfflineTransport } from './net/browser';
import {
  NetworkFailure,
  type Transport,
  type TransportRequest,
  type TransportResponse,
} from './net/transport';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ISS = 'https://issuer.example.org/fhir/r4';
const NOW = Date.UTC(2026, 7, 20);

interface Signer {
  privateKey: CryptoKey;
  jwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string; use: string; alg: string; kid: string };
  kid: string;
}

async function makeSigner(): Promise<Signer> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const exported = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as Record<string, string>;
  const x = exported.x as string;
  const y = exported.y as string;
  const kid = await jwkThumbprint({ kty: 'EC', crv: 'P-256', x, y });
  return {
    privateKey: pair.privateKey,
    jwk: { kty: 'EC', crv: 'P-256', x, y, use: 'sig', alg: 'ES256', kid },
    kid,
  };
}

const MINIMAL_BUNDLE = {
  resourceType: 'Bundle',
  type: 'collection',
  entry: [
    { fullUrl: 'resource:0', resource: { resourceType: 'Patient', birthDate: '1980-04-01' } },
    {
      fullUrl: 'resource:1',
      resource: {
        resourceType: 'Immunization',
        status: 'completed',
        patient: { reference: 'resource:0' },
        vaccineCode: { coding: [{ system: 'http://hl7.org/fhir/sid/cvx', code: '208' }] },
        occurrenceDateTime: '2021-01-01',
      },
    },
  ],
};

function claimsFor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: ISS,
    // A float, as the specification's own example card uses. An integer-only
    // parser mishandles the real thing, so the happy path here carries one.
    nbf: 1687450764.656,
    vc: {
      type: ['https://smarthealth.cards#health-card'],
      rid: 'MKyCxh7p6uQ',
      credentialSubject: { fhirVersion: '4.0.1', fhirBundle: MINIMAL_BUNDLE },
    },
    ...overrides,
  };
}

interface CardOptions {
  claims?: Record<string, unknown>;
  header?: Record<string, unknown>;
  /** Skip compression, leaving the payload as plain JSON. */
  uncompressed?: boolean;
  /** Sign over SHA-256 of the signing input, the double-hash producer bug. */
  doubleHash?: boolean;
}

async function signCard(signer: Signer, options: CardOptions = {}): Promise<string> {
  const header = { zip: 'DEF', alg: 'ES256', kid: signer.kid, ...options.header };
  const json = utf8Encode(JSON.stringify(options.claims ?? claimsFor()));
  const payload = options.uncompressed === true ? json : deflateRawBytes(json);
  const headerB64 = bytesToBase64url(utf8Encode(JSON.stringify(header)));
  const payloadB64 = bytesToBase64url(payload);
  const signingInput = utf8Encode(`${headerB64}.${payloadB64}`);
  const message =
    options.doubleHash === true
      ? new Uint8Array(await crypto.subtle.digest('SHA-256', toArrayBuffer(signingInput)))
      : signingInput;
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      signer.privateKey,
      toArrayBuffer(message),
    ),
  );
  return `${headerB64}.${payloadB64}.${bytesToBase64url(signature)}`;
}

/** A transport that answers a fixed map of URLs and refuses everything else. */
function serving(routes: Record<string, string | TransportResponse>): Transport {
  return OfflineTransport.withBodies({}) && new OfflineTransport(new Map(Object.entries(routes)));
}

function jwks(...keys: unknown[]): string {
  return JSON.stringify({ keys });
}

const JWKS_URL = `${ISS}/.well-known/jwks.json`;

function state(checks: readonly VerificationCheck[], id: CheckId): string {
  return checks.find((check) => check.id === id)?.state ?? 'absent';
}

function ruleIds(findings: readonly { ruleId: string }[]): string[] {
  return findings.map((f) => f.ruleId);
}

// ---------------------------------------------------------------------------
// The file wrapper
// ---------------------------------------------------------------------------

describe('parseHealthCardFile', () => {
  it('reads the cards out of a well-formed file', () => {
    const result = parseHealthCardFile({ verifiableCredential: ['a.b.c', 'd.e.f'] });
    expect(result.cards).toEqual(['a.b.c', 'd.e.f']);
    expect(ruleIds(result.findings)).toEqual(['SHC-FILE-MULTIPLE-CARDS']);
  });

  it('names a non-object rather than throwing', () => {
    expect(ruleIds(parseHealthCardFile('shc:/5676').findings)).toEqual(['SHC-FILE-NOT-AN-OBJECT']);
    expect(ruleIds(parseHealthCardFile(null).findings)).toEqual(['SHC-FILE-NOT-AN-OBJECT']);
    expect(ruleIds(parseHealthCardFile([]).findings)).toEqual(['SHC-FILE-NOT-AN-OBJECT']);
  });

  it('distinguishes a missing member from an empty array', () => {
    expect(ruleIds(parseHealthCardFile({ fhirBundle: {} }).findings)).toEqual([
      'SHC-FILE-NO-VERIFIABLE-CREDENTIAL',
    ]);
    expect(ruleIds(parseHealthCardFile({ verifiableCredential: [] }).findings)).toEqual([
      'SHC-FILE-VC-EMPTY',
    ]);
  });

  it('recovers a single string into an array of one, and says it did', () => {
    const result = parseHealthCardFile({ verifiableCredential: 'a.b.c' });
    expect(result.cards).toEqual(['a.b.c']);
    expect(ruleIds(result.findings)).toContain('SHC-FILE-VC-NOT-AN-ARRAY');
  });

  it('refuses to guess at a number in the member position', () => {
    const result = parseHealthCardFile({ verifiableCredential: 7 });
    expect(result.cards).toEqual([]);
    expect(result.findings[0]?.severity).toBe('fatal');
  });

  it('trims a card and reports the whitespace, because the signature covers exact bytes', () => {
    const result = parseHealthCardFile({ verifiableCredential: ['  a.b.c\n'] });
    expect(result.cards).toEqual(['a.b.c']);
    expect(ruleIds(result.findings)).toContain('SHC-JWS-SURROUNDING-WHITESPACE');
  });

  it('reports an undefined top-level member as improvising, not as an error', () => {
    const result = parseHealthCardFile({ verifiableCredential: ['a.b.c'], patientName: 'Mia' });
    expect(result.extraMembers).toEqual(['patientName']);
    const extra = result.findings.find((f) => f.ruleId === 'SHC-FILE-EXTRA-MEMBERS');
    expect(extra?.severity).toBe('info');
  });

  it('names each non-string entry by index and keeps the good ones', () => {
    const result = parseHealthCardFile({ verifiableCredential: ['a.b.c', { iss: 'x' }] });
    expect(result.cards).toEqual(['a.b.c']);
    expect(result.findings.some((f) => f.title.includes('verifiableCredential[1]'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The shc:/ numeric encoding
// ---------------------------------------------------------------------------

describe('decodeShcQr', () => {
  it('decodes the spec-published vectors: 43 is X, and 567629 is eyJ', () => {
    const single = decodeShcQr('shc:/43');
    expect(single.ok && single.chunk).toBe('X');
    const start = decodeShcQr('shc:/567629');
    expect(start.ok && start.chunk).toBe('eyJ');
    expect(start.ok && start.chunkIndex).toBe(1);
    expect(start.ok && start.chunkTotal).toBe(1);
  });

  it('round-trips a whole card through the encoder', () => {
    const jws = 'eyJhbGciOiJFUzI1NiJ9.eyJpc3MiOiJodHRwczovL2EifQ.AA-_';
    const [encoded] = encodeShcQr(jws);
    const decoded = decodeShcQr(encoded as string);
    expect(decoded.ok && decoded.chunk).toBe(jws);
    // Two digits per character, exactly, with no separators.
    expect((encoded as string).length - 'shc:/'.length).toBe(jws.length * 2);
  });

  it('names a missing prefix, and recognises a bare numeric segment as one', () => {
    const bare = decodeShcQr('567629');
    expect(bare.ok).toBe(false);
    expect(ruleIds(bare.findings)).toEqual(['SHC-QR-NO-PREFIX']);
    expect(bare.findings[0]?.detail).toContain('all digits');
  });

  it('names an odd digit count as a lost digit rather than a bad card', () => {
    const result = decodeShcQr('shc:/5676290');
    expect(result.ok).toBe(false);
    expect(ruleIds(result.findings)).toEqual(['SHC-QR-ODD-DIGIT-COUNT']);
  });

  it('names a non-digit and where it is', () => {
    const result = decodeShcQr('shc:/56X629');
    expect(ruleIds(result.findings)).toEqual(['SHC-QR-NON-DIGIT']);
    expect(result.findings[0]?.title).toContain('position 2');
  });

  it('rejects a digit pair above 77, which no JWS character can produce', () => {
    const result = decodeShcQr('shc:/5676298912');
    expect(result.ok).toBe(false);
    expect(ruleIds(result.findings)).toEqual(['SHC-QR-PAIR-OUT-OF-RANGE']);
  });

  it('warns when the first chunk does not start a JWS', () => {
    const result = decodeShcQr('shc:/565656');
    expect(result.ok).toBe(true);
    expect(ruleIds(result.findings)).toContain('SHC-QR-NOT-A-JWS-START');
  });

  it('reads the chunk prefix as 1-indexed and reports the deprecation', () => {
    const result = decodeShcQr('shc:/2/3/567629');
    expect(result.ok && result.chunkIndex).toBe(2);
    expect(result.ok && result.chunkTotal).toBe(3);
    expect(ruleIds(result.findings)).toContain('SHC-QR-CHUNKED');
  });

  it('names a zero ordinal, the sign of a producer numbering from zero', () => {
    const result = decodeShcQr('shc:/0/3/567629');
    expect(ruleIds(result.findings)).toContain('SHC-QR-CHUNK-ORDINAL');
  });

  it('flags a chunk set of one as pointless', () => {
    expect(ruleIds(decodeShcQr('shc:/1/1/567629').findings)).toContain('SHC-QR-POINTLESS-CHUNKING');
  });
});

describe('assembleShcQrChunks', () => {
  const jws = 'eyJhbGciOiJFUzI1NiJ9.eyJpc3MiOiJodHRwczovL2EifQ.AAAA';

  it('reassembles a set scanned out of order', () => {
    const [one, two, three] = encodeShcQr(jws, { chunks: 3 });
    const result = assembleShcQrChunks([three as string, one as string, two as string]);
    expect(result.jws).toBe(jws);
    expect(result.missing).toEqual([]);
    expect(result.present).toEqual([1, 2, 3]);
  });

  it('names which chunk is missing and refuses to assemble a partial card', () => {
    const [one, , three] = encodeShcQr(jws, { chunks: 3 });
    const result = assembleShcQrChunks([one as string, three as string]);
    expect(result.jws).toBeUndefined();
    expect(result.missing).toEqual([2]);
    const missing = result.findings.find((f) => f.ruleId === 'SHC-QR-MISSING-CHUNK');
    expect(missing?.severity).toBe('fatal');
    expect(missing?.remedy).toContain('2');
  });

  it('tolerates the same chunk scanned twice', () => {
    const [one, two] = encodeShcQr(jws, { chunks: 2 });
    const result = assembleShcQrChunks([one as string, one as string, two as string]);
    expect(result.jws).toBe(jws);
  });

  it('refuses two cards scanned into one set', () => {
    const [oneA, twoA] = encodeShcQr(jws, { chunks: 2 });
    const [, twoB] = encodeShcQr(`${jws}zz`, { chunks: 2 });
    const result = assembleShcQrChunks([oneA as string, twoA as string, twoB as string]);
    expect(ruleIds(result.findings)).toContain('SHC-QR-CHUNK-CONFLICT');
    expect(result.jws).toBeUndefined();
  });

  it('notices when two scans disagree about the total', () => {
    const [one] = encodeShcQr(jws, { chunks: 2 });
    const [, two] = encodeShcQr(jws, { chunks: 3 });
    const result = assembleShcQrChunks([one as string, two as string]);
    expect(ruleIds(result.findings)).toContain('SHC-QR-CHUNK-TOTAL-DISAGREE');
  });

  it('warns about unbalanced chunks', () => {
    const digits = (text: string): string =>
      [...text].map((c) => String(c.charCodeAt(0) - 45).padStart(2, '0')).join('');
    const head = jws.slice(0, 4);
    const tail = jws.slice(4);
    const result = assembleShcQrChunks([`shc:/1/2/${digits(head)}`, `shc:/2/2/${digits(tail)}`]);
    expect(result.jws).toBe(jws);
    expect(ruleIds(result.findings)).toContain('SHC-QR-UNBALANCED-CHUNKS');
  });
});

// ---------------------------------------------------------------------------
// The issuer URL rule
// ---------------------------------------------------------------------------

describe('issuerJwksUrl', () => {
  it('concatenates, so a deep path survives', () => {
    // URL resolution would produce https://ehr.example.org/.well-known/jwks.json
    // here, which is silent on the spec's shallow example and fatal in the field.
    expect(issuerJwksUrl('https://ehr.example.org/fhir/r4').jwksUrl).toBe(
      'https://ehr.example.org/fhir/r4/.well-known/jwks.json',
    );
  });

  it('reports a trailing slash and offers the collapsed URL', () => {
    const result = issuerJwksUrl('https://issuer.example.org/');
    expect(result.jwksUrl).toBe('https://issuer.example.org//.well-known/jwks.json');
    expect(result.normalisedJwksUrl).toBe('https://issuer.example.org/.well-known/jwks.json');
    expect(ruleIds(result.findings)).toContain('SHC-ISS-TRAILING-SLASH');
  });

  it('names http and a non-URL separately', () => {
    expect(ruleIds(issuerJwksUrl('http://issuer.example.org').findings)).toContain(
      'SHC-ISS-NOT-HTTPS',
    );
    expect(ruleIds(issuerJwksUrl('issuer.example.org').findings)).toContain('SHC-ISS-NOT-A-URL');
  });

  it('says a localhost issuer can only be verified by its author, before any request', () => {
    const result = issuerJwksUrl('https://localhost:5173/issuer');
    const found = result.findings.find((f) => f.ruleId === 'SHC-ISS-UNREACHABLE-HOST');
    expect(found?.severity).toBe('fatal');
    expect(found?.detail).toContain('no request was made');
  });

  it('builds the per-key revocation URL, dropping a trailing slash', () => {
    expect(issuerCrlUrl('https://issuer.example.org/', 'abc')).toBe(
      'https://issuer.example.org/.well-known/crl/abc.json',
    );
  });
});

// ---------------------------------------------------------------------------
// Static inspection
// ---------------------------------------------------------------------------

describe('inspectJws', () => {
  it('reads a float nbf without truncating it', async () => {
    const signer = await makeSigner();
    const inspection = inspectJws(await signCard(signer));
    expect(inspection.ok).toBe(true);
    if (!inspection.ok) return;
    expect(inspection.card.nbf?.raw).toBe(1687450764.656);
    expect(inspection.card.nbf?.isInteger).toBe(false);
    expect(inspection.card.nbf?.unit).toBe('seconds');
    expect(inspection.card.nbf?.epochMs).toBeCloseTo(1687450764656, 0);
    expect(inspection.card.rid).toBe('MKyCxh7p6uQ');
    expect(inspection.framing).toBe('raw-deflate');
  });

  it('recognises milliseconds instead of reporting a card from the year 55000', async () => {
    const signer = await makeSigner();
    const inspection = inspectJws(
      await signCard(signer, { claims: claimsFor({ nbf: 1687450764656 }) }),
    );
    expect(inspection.ok && inspection.card.nbf?.unit).toBe('milliseconds');
    expect(ruleIds(inspection.findings)).toContain('SHC-CLAIM-NBF-MILLISECONDS');
  });

  it('names a non-ES256 alg as unverifiable, not as a bad signature', async () => {
    const signer = await makeSigner();
    const inspection = inspectJws(await signCard(signer, { header: { alg: 'RS256' } }));
    expect(state(inspection.checks, 'header-alg')).toBe('fail');
    expect(ruleIds(inspection.findings)).toContain('SHC-JWS-ALG-NOT-ES256');
  });

  it('names a missing kid and says why guessing is refused', async () => {
    const signer = await makeSigner();
    const inspection = inspectJws(await signCard(signer, { header: { kid: undefined } }));
    expect(state(inspection.checks, 'header-kid')).toBe('fail');
    expect(ruleIds(inspection.findings)).toContain('SHC-JWS-KID-MISSING');
  });

  it('reads an uncompressed payload and reports the missing zip header', async () => {
    const signer = await makeSigner();
    const inspection = inspectJws(
      await signCard(signer, { uncompressed: true, header: { zip: undefined } }),
    );
    expect(inspection.ok).toBe(true);
    expect(ruleIds(inspection.findings)).toContain('SHC-JWS-ZIP-MISSING');
  });

  it('names zlib framing, and still reads the card', async () => {
    const signer = await makeSigner();
    const card = await signCard(signer);
    const [header, , signature] = card.split('.') as [string, string, string];
    // fflate's zlibSync output, built here rather than imported so the test
    // does not depend on which framing helper compress.ts happens to export.
    const { zlibSync } = await import('fflate');
    const wrapped = bytesToBase64url(
      zlibSync(utf8Encode(JSON.stringify(claimsFor())), { level: 9 }),
    );
    const inspection = inspectJws(`${header}.${wrapped}.${signature}`);
    expect(inspection.ok && inspection.framing).toBe('zlib');
    const found = inspection.findings.find((f) => f.ruleId === 'SHC-JWS-PAYLOAD-FRAMING');
    expect(found?.detail).toContain('cryptographically sound and non-conformant');
  });

  it('names a DER signature specifically', async () => {
    const signer = await makeSigner();
    const card = await signCard(signer);
    const [header, payload] = card.split('.') as [string, string];
    const der = bytesToBase64url(new Uint8Array([0x30, 0x44, 0x02, 0x20, 0x01]));
    const inspection = inspectJws(`${header}.${payload}.${der}`);
    expect(ruleIds(inspection.findings)).toContain('SHC-SIGNATURE-DER-ENCODED');
  });

  it('reports an unminified payload as conformance, not corruption', async () => {
    const signer = await makeSigner();
    const spaced = `{"iss":"${ISS}", "nbf":1, "vc":{"type":["https://smarthealth.cards#health-card"],"credentialSubject":{"fhirVersion":"4.0.1","fhirBundle":{"resourceType":"Bundle","entry":[]}}}}`;
    const header = bytesToBase64url(
      utf8Encode(JSON.stringify({ zip: 'DEF', alg: 'ES256', kid: signer.kid })),
    );
    const payload = bytesToBase64url(deflateRawBytes(utf8Encode(spaced)));
    const inspection = inspectJws(`${header}.${payload}.AAAA`);
    const found = inspection.findings.find((f) => f.ruleId === 'SHC-JWS-PAYLOAD-NOT-MINIFIED');
    expect(found?.severity).toBe('warning');
  });

  it('names a missing health-card type and a deprecated one separately', async () => {
    const signer = await makeSigner();
    const inspection = inspectJws(
      await signCard(signer, {
        claims: claimsFor({
          vc: {
            type: ['https://smarthealth.cards#covid19'],
            credentialSubject: { fhirVersion: '4.0.1', fhirBundle: MINIMAL_BUNDLE },
          },
        }),
      }),
    );
    expect(ruleIds(inspection.findings)).toContain('SHC-CLAIM-TYPE-MISSING-HEALTH-CARD');
    expect(ruleIds(inspection.findings)).toContain('SHC-CLAIM-TYPE-DEPRECATED');
  });

  it('names an @context on the wire as a mis-serialised JSON-LD view', async () => {
    const signer = await makeSigner();
    const inspection = inspectJws(
      await signCard(signer, {
        claims: claimsFor({
          vc: {
            '@context': ['https://www.w3.org/2018/credentials/v1'],
            type: ['https://smarthealth.cards#health-card'],
            credentialSubject: { fhirVersion: '4.0.1', fhirBundle: MINIMAL_BUNDLE },
          },
        }),
      }),
    );
    expect(ruleIds(inspection.findings)).toContain('SHC-CLAIM-VC-CONTEXT-PRESENT');
  });

  it('stops at a two-part token and says three parts are needed', () => {
    const inspection = inspectJws('eyJhbGciOiJFUzI1NiJ9.eyJ9');
    expect(inspection.ok).toBe(false);
    expect(state(inspection.checks, 'jws-shape')).toBe('fail');
    // Everything after the first failure is honestly not reached.
    expect(state(inspection.checks, 'signature')).toBe('not-reached');
  });
});

// ---------------------------------------------------------------------------
// Verification, and one mutation per failure mode
// ---------------------------------------------------------------------------

describe('verifyHealthCard', () => {
  it('verifies a card against the key set its issuer publishes', async () => {
    const signer = await makeSigner();
    const card = await signCard(signer);
    const result = await verifyHealthCard(card, {
      transport: serving({ [JWKS_URL]: jwks(signer.jwk) }),
      now: () => NOW,
    });
    expect(result.posture).toBe('verified');
    expect(state(result.checks, 'signature')).toBe('pass');
    expect(result.thumbprint).toBe(signer.kid);
    expect(result.kid).toBe(signer.kid);
    expect(result.issuer?.iss).toBe(ISS);
    expect(result.issuer?.jwksUrl).toBe(JWKS_URL);
    // No exp is the norm and must read as "does not expire", not as a defect.
    expect(state(result.checks, 'exp')).toBe('pass');
    // The JWKS fetch is recorded, so a caller can put it in the trace.
    expect(result.exchanges).toHaveLength(1);
    expect(result.exchanges[0]?.request.url).toBe(JWKS_URL);
  });

  it('names an issuer whose key set cannot be fetched, and does not call it invalid', async () => {
    const signer = await makeSigner();
    const card = await signCard(signer);
    const refusing: Transport = {
      name: 'refusing',
      send: (request: TransportRequest) =>
        Promise.reject(
          new NetworkFailure(
            `nothing answered ${request.url}`,
            'blocked-by-browser',
            12,
            'Failed to fetch',
          ),
        ),
    };
    const result = await verifyHealthCard(card, { transport: refusing, now: () => NOW });
    expect(result.posture).toBe('unverifiable');
    expect(state(result.checks, 'jwks-fetch')).toBe('fail');
    expect(state(result.checks, 'signature')).toBe('not-reached');
    expect(ruleIds(result.findings)).toContain('SHC-JWKS-UNREACHABLE');
    expect(result.exchanges[0]?.response.status).toBe(0);
  });

  it('separates a non-200 key set from an unreachable one', async () => {
    const signer = await makeSigner();
    const card = await signCard(signer);
    const result = await verifyHealthCard(card, {
      transport: serving({
        [JWKS_URL]: {
          ok: false,
          status: 404,
          statusText: 'Not Found',
          headers: {},
          body: 'not here',
          bodyBytes: 8,
          responseType: 'basic',
          redirected: false,
          finalUrl: JWKS_URL,
          durationMs: 3,
        },
      }),
      now: () => NOW,
    });
    expect(ruleIds(result.findings)).toContain('SHC-JWKS-BAD-STATUS');
    expect(result.posture).toBe('unverifiable');
  });

  it('names a key set that is HTML rather than JSON', async () => {
    const signer = await makeSigner();
    const card = await signCard(signer);
    const result = await verifyHealthCard(card, {
      transport: serving({ [JWKS_URL]: '<!DOCTYPE html><html><body>404</body></html>' }),
      now: () => NOW,
    });
    expect(state(result.checks, 'jwks-json')).toBe('fail');
    const found = result.findings.find((f) => f.ruleId === 'SHC-JWKS-NOT-A-KEY-SET');
    expect(found?.detail).toContain('HTML');
  });

  it('distinguishes a rotated-out kid from a bad signature, and lists what was published', async () => {
    const signer = await makeSigner();
    const other = await makeSigner();
    const card = await signCard(signer);
    const result = await verifyHealthCard(card, {
      transport: serving({ [JWKS_URL]: jwks(other.jwk) }),
      now: () => NOW,
    });
    expect(state(result.checks, 'kid-in-jwks')).toBe('fail');
    expect(state(result.checks, 'signature')).toBe('not-reached');
    expect(result.posture).toBe('unverifiable');
    expect(result.keySetKids).toEqual([other.kid]);
    expect(ruleIds(result.findings)).toContain('SHC-KID-NOT-IN-KEY-SET');
  });

  it('refuses to try every key when the card names none', async () => {
    const signer = await makeSigner();
    const card = await signCard(signer, { header: { kid: undefined } });
    const result = await verifyHealthCard(card, {
      transport: serving({ [JWKS_URL]: jwks(signer.jwk) }),
      now: () => NOW,
    });
    expect(ruleIds(result.findings)).toContain('SHC-KID-CANNOT-SELECT-KEY');
    expect(state(result.checks, 'signature')).toBe('not-reached');
  });

  it('names a key that is not EC P-256', async () => {
    const signer = await makeSigner();
    const card = await signCard(signer);
    const result = await verifyHealthCard(card, {
      transport: serving({
        [JWKS_URL]: jwks({ ...signer.jwk, kty: 'RSA', crv: undefined }),
      }),
      now: () => NOW,
    });
    expect(state(result.checks, 'key-shape')).toBe('fail');
    expect(ruleIds(result.findings)).toContain('SHC-KEY-NOT-EC-P256');
  });

  it('treats a published private key as a fatal issuer incident', async () => {
    const signer = await makeSigner();
    const card = await signCard(signer);
    const result = await verifyHealthCard(card, {
      transport: serving({ [JWKS_URL]: jwks({ ...signer.jwk, d: 'not-really-a-key' }) }),
      now: () => NOW,
    });
    const found = result.findings.find((f) => f.ruleId === 'SHC-KEY-CARRIES-PRIVATE-PARAMETER');
    expect(found?.severity).toBe('fatal');
  });

  it('reports use, alg and key_ops disagreeing with signing, while still checking the bytes', async () => {
    const signer = await makeSigner();
    const card = await signCard(signer);
    const result = await verifyHealthCard(card, {
      transport: serving({
        [JWKS_URL]: jwks({ ...signer.jwk, use: 'enc', alg: 'ES384', key_ops: ['encrypt'] }),
      }),
      now: () => NOW,
    });
    const found = result.findings.find((f) => f.ruleId === 'SHC-KEY-USAGE-DISAGREES');
    expect(found?.detail).toContain('use is "enc"');
    expect(found?.detail).toContain('key_ops');
    expect(state(result.checks, 'key-usage')).toBe('fail');
    // The signature is still checked, so the reader learns this is metadata.
    expect(state(result.checks, 'signature')).toBe('pass');
    expect(result.posture).toBe('verified-with-warnings');
  });

  it('warns when a key omits use and alg entirely', async () => {
    const signer = await makeSigner();
    const card = await signCard(signer);
    const result = await verifyHealthCard(card, {
      transport: serving({
        [JWKS_URL]: jwks({
          kty: 'EC',
          crv: 'P-256',
          x: signer.jwk.x,
          y: signer.jwk.y,
          kid: signer.kid,
        }),
      }),
      now: () => NOW,
    });
    expect(state(result.checks, 'key-usage')).toBe('warn');
    expect(ruleIds(result.findings)).toContain('SHC-KEY-USAGE-MISSING');
  });

  it('names a kid that is not the thumbprint of its own key', async () => {
    const signer = await makeSigner();
    const card = await signCard(signer, { header: { kid: 'made-up-key-id' } });
    const result = await verifyHealthCard(card, {
      transport: serving({ [JWKS_URL]: jwks({ ...signer.jwk, kid: 'made-up-key-id' }) }),
      now: () => NOW,
    });
    expect(state(result.checks, 'key-thumbprint')).toBe('fail');
    expect(state(result.checks, 'signature')).toBe('pass');
    const found = result.findings.find((f) => f.ruleId === 'SHC-KEY-KID-NOT-ITS-THUMBPRINT');
    expect(found?.detail).toContain(signer.kid);
  });

  it('names an invalid signature as invalid, and does not go on to add up dates', async () => {
    const signer = await makeSigner();
    const card = await signCard(signer);
    const parts = card.split('.') as [string, string, string];
    const flipped = new Uint8Array(
      await crypto.subtle.digest('SHA-256', toArrayBuffer(utf8Encode('unrelated'))),
    );
    const bogus = new Uint8Array(64);
    bogus.set(flipped, 0);
    const result = await verifyHealthCard(`${parts[0]}.${parts[1]}.${bytesToBase64url(bogus)}`, {
      transport: serving({ [JWKS_URL]: jwks(signer.jwk) }),
      now: () => NOW,
    });
    expect(result.posture).toBe('invalid');
    expect(ruleIds(result.findings)).toContain('SHC-SIGNATURE-INVALID');
    expect(state(result.checks, 'nbf')).toBe('not-reached');
    expect(state(result.checks, 'revocation')).toBe('not-reached');
  });

  it('names a double-hashed signing input instead of reporting a wrong key', async () => {
    const signer = await makeSigner();
    const card = await signCard(signer, { doubleHash: true });
    const result = await verifyHealthCard(card, {
      transport: serving({ [JWKS_URL]: jwks(signer.jwk) }),
      now: () => NOW,
    });
    expect(ruleIds(result.findings)).toContain('SHC-SIGNATURE-DOUBLE-HASHED');
    expect(result.posture).toBe('invalid');
  });

  it('names a card that is not yet valid', async () => {
    const signer = await makeSigner();
    const future = NOW / 1000 + 86_400 * 30;
    const card = await signCard(signer, { claims: claimsFor({ nbf: future }) });
    const result = await verifyHealthCard(card, {
      transport: serving({ [JWKS_URL]: jwks(signer.jwk) }),
      now: () => NOW,
    });
    expect(state(result.checks, 'nbf')).toBe('fail');
    expect(ruleIds(result.findings)).toContain('SHC-CARD-NOT-YET-VALID');
    expect(result.posture).toBe('invalid');
  });

  it('names an expired card, and an exp before nbf', async () => {
    const signer = await makeSigner();
    const card = await signCard(signer, {
      claims: claimsFor({ nbf: NOW / 1000 - 86_400, exp: NOW / 1000 - 3600 }),
    });
    const result = await verifyHealthCard(card, {
      transport: serving({ [JWKS_URL]: jwks(signer.jwk) }),
      now: () => NOW,
    });
    expect(state(result.checks, 'exp')).toBe('fail');
    expect(ruleIds(result.findings)).toContain('SHC-CARD-EXPIRED');

    const inverted = inspectJws(
      await signCard(signer, { claims: claimsFor({ nbf: NOW / 1000, exp: NOW / 1000 - 10 }) }),
    );
    expect(ruleIds(inverted.findings)).toContain('SHC-CLAIM-EXP-BEFORE-NBF');
  });

  it('says revocation status is unknown when the key advertises no list', async () => {
    const signer = await makeSigner();
    const card = await signCard(signer);
    const result = await verifyHealthCard(card, {
      transport: serving({ [JWKS_URL]: jwks(signer.jwk) }),
      now: () => NOW,
    });
    expect(result.revocation.state).toBe('not-published');
    expect(state(result.checks, 'revocation')).toBe('skipped');
    const found = result.findings.find((f) => f.ruleId === 'SHC-REVOCATION-NOT-PUBLISHED');
    expect(found?.detail).toContain('not the same as "not revoked"');
    // A card whose revocation is unknown is still verified, not degraded.
    expect(result.posture).toBe('verified');
  });

  it('checks the revocation list when the key advertises one, and passes a clean card', async () => {
    const signer = await makeSigner();
    const card = await signCard(signer);
    const crlUrl = issuerCrlUrl(ISS, signer.kid);
    const result = await verifyHealthCard(card, {
      transport: serving({
        [JWKS_URL]: jwks({ ...signer.jwk, crlVersion: 1 }),
        // ctr as a JSON number, which is what the live example serves even
        // though the spec snippet shows it in string position.
        [crlUrl]: JSON.stringify({ kid: signer.kid, method: 'rid', ctr: 1, rids: ['FKDIxsTCGlU'] }),
      }),
      now: () => NOW,
    });
    expect(result.revocation).toEqual({ state: 'clean', ctr: 1, entries: 1 });
    expect(result.posture).toBe('verified');
    expect(result.exchanges.map((e) => e.request.url)).toEqual([JWKS_URL, crlUrl]);
  });

  it('reports a revoked card as invalid on a bare rid match', async () => {
    const signer = await makeSigner();
    const card = await signCard(signer);
    const result = await verifyHealthCard(card, {
      transport: serving({
        [JWKS_URL]: jwks({ ...signer.jwk, crlVersion: 2 }),
        [issuerCrlUrl(ISS, signer.kid)]: JSON.stringify({ ctr: '2', rids: ['MKyCxh7p6uQ'] }),
      }),
      now: () => NOW,
    });
    expect(result.revocation.state).toBe('revoked');
    expect(result.posture).toBe('invalid');
    expect(ruleIds(result.findings)).toContain('SHC-CARD-REVOKED');
  });

  it('applies a timestamped revocation only to cards issued before it', async () => {
    const signer = await makeSigner();
    const nbf = 1_687_450_764.656;
    const card = await signCard(signer, { claims: claimsFor({ nbf }) });
    const before = await verifyHealthCard(card, {
      transport: serving({
        [JWKS_URL]: jwks({ ...signer.jwk, crlVersion: 1 }),
        [issuerCrlUrl(ISS, signer.kid)]: JSON.stringify({
          ctr: 1,
          rids: ['MKyCxh7p6uQ.1687450765'],
        }),
      }),
      now: () => NOW,
    });
    expect(before.revocation.state).toBe('revoked');

    const after = await verifyHealthCard(card, {
      transport: serving({
        [JWKS_URL]: jwks({ ...signer.jwk, crlVersion: 1 }),
        // The same rid, revoked only for cards issued before an earlier moment.
        [issuerCrlUrl(ISS, signer.kid)]: JSON.stringify({
          ctr: 1,
          rids: ['MKyCxh7p6uQ.1600000000'],
        }),
      }),
      now: () => NOW,
    });
    expect(after.revocation.state).toBe('clean');
    expect(after.posture).toBe('verified');
  });

  it('reports an unreachable revocation list as unknown, not as clean', async () => {
    const signer = await makeSigner();
    const card = await signCard(signer);
    const result = await verifyHealthCard(card, {
      transport: serving({ [JWKS_URL]: jwks({ ...signer.jwk, crlVersion: 1 }) }),
      now: () => NOW,
    });
    expect(result.revocation.state).toBe('unavailable');
    expect(state(result.checks, 'revocation')).toBe('fail');
    expect(result.posture).toBe('invalid');
    expect(ruleIds(result.findings)).toContain('SHC-REVOCATION-LIST-UNREACHABLE');
  });

  it('says nothing about revocation for a card with no rid', async () => {
    const signer = await makeSigner();
    const card = await signCard(signer, {
      claims: claimsFor({
        vc: {
          type: ['https://smarthealth.cards#health-card'],
          credentialSubject: { fhirVersion: '4.0.1', fhirBundle: MINIMAL_BUNDLE },
        },
      }),
    });
    const result = await verifyHealthCard(card, {
      transport: serving({ [JWKS_URL]: jwks({ ...signer.jwk, crlVersion: 1 }) }),
      now: () => NOW,
    });
    expect(result.revocation.state).toBe('no-rid');
    expect(result.exchanges).toHaveLength(1);
  });

  it('makes no directory request unless a directory is passed in', async () => {
    const signer = await makeSigner();
    const card = await signCard(signer);
    const result = await verifyHealthCard(card, {
      transport: serving({ [JWKS_URL]: jwks(signer.jwk) }),
      now: () => NOW,
    });
    expect(result.trust.state).toBe('not-checked');
    expect(state(result.checks, 'trust-directory')).toBe('skipped');
    expect(result.exchanges.map((e) => e.request.url)).toEqual([JWKS_URL]);
  });

  it('reads an issuer name only from a directory that published one', async () => {
    const signer = await makeSigner();
    const card = await signCard(signer);
    const directory = {
      ...(KNOWN_TRUST_DIRECTORIES[0] as (typeof KNOWN_TRUST_DIRECTORIES)[number]),
    };
    const result = await verifyHealthCard(card, {
      transport: serving({
        [JWKS_URL]: jwks(signer.jwk),
        [directory.url]: JSON.stringify({
          participating_issuers: [{ iss: ISS, name: 'Example Health Service' }],
        }),
      }),
      trustedDirectories: [directory],
      now: () => NOW,
    });
    expect(result.trust).toMatchObject({
      state: 'listed',
      matchedOn: 'iss',
      name: 'Example Health Service',
    });
    expect(result.issuer?.name).toBe('Example Health Service');
    expect(state(result.checks, 'trust-directory')).toBe('pass');
  });

  it('matches on canonical_iss when the exact iss is not listed', async () => {
    const signer = await makeSigner();
    const card = await signCard(signer);
    const directory = KNOWN_TRUST_DIRECTORIES[0] as (typeof KNOWN_TRUST_DIRECTORIES)[number];
    const result = await verifyHealthCard(card, {
      transport: serving({
        [JWKS_URL]: jwks(signer.jwk),
        [directory.url]: JSON.stringify({
          participating_issuers: [
            { iss: 'https://other.example.org', canonical_iss: ISS, name: 'Group' },
          ],
        }),
      }),
      trustedDirectories: [directory],
      now: () => NOW,
    });
    expect(result.trust).toMatchObject({ state: 'listed', matchedOn: 'canonical_iss' });
  });

  it('renders an unlisted issuer as informational, never as untrusted', async () => {
    const signer = await makeSigner();
    const card = await signCard(signer);
    const directory = KNOWN_TRUST_DIRECTORIES[0] as (typeof KNOWN_TRUST_DIRECTORIES)[number];
    const result = await verifyHealthCard(card, {
      transport: serving({
        [JWKS_URL]: jwks(signer.jwk),
        [directory.url]: JSON.stringify({
          participating_issuers: [{ iss: 'https://elsewhere.example' }],
        }),
      }),
      trustedDirectories: [directory],
      now: () => NOW,
    });
    expect(result.trust.state).toBe('unlisted');
    const found = result.findings.find((f) => f.ruleId === 'SHC-ISSUER-NOT-IN-DIRECTORY');
    expect(found?.severity).toBe('info');
    // An absence must not drag the card's posture down.
    expect(result.posture).toBe('verified-with-warnings');
  });

  it('falls back to the collapsed URL for a trailing-slash issuer, and says which URL worked', async () => {
    const signer = await makeSigner();
    const card = await signCard(signer, { claims: claimsFor({ iss: `${ISS}/` }) });
    const result = await verifyHealthCard(card, {
      transport: serving({ [JWKS_URL]: jwks(signer.jwk) }),
      now: () => NOW,
    });
    expect(ruleIds(result.findings)).toContain('SHC-ISS-TRAILING-SLASH');
    expect(ruleIds(result.findings)).toContain('SHC-JWKS-FETCHED-FROM-NORMALISED-URL');
    expect(state(result.checks, 'signature')).toBe('pass');
    expect(result.exchanges.map((e) => e.request.url)).toEqual([
      `${ISS}//.well-known/jwks.json`,
      JWKS_URL,
    ]);
  });

  it('stops before any request when the issuer is on localhost', async () => {
    const signer = await makeSigner();
    const card = await signCard(signer, { claims: claimsFor({ iss: 'https://localhost:5173' }) });
    let sent = 0;
    const counting: Transport = {
      name: 'counting',
      send: () => {
        sent += 1;
        return Promise.reject(new NetworkFailure('nope', 'blocked-by-browser', 0));
      },
    };
    const result = await verifyHealthCard(card, { transport: counting, now: () => NOW });
    expect(sent).toBe(0);
    expect(ruleIds(result.findings)).toContain('SHC-ISS-UNREACHABLE-HOST');
    expect(state(result.checks, 'jwks-fetch')).toBe('not-reached');
  });

  it('downgrades a conformance failure in permissive mode, and never the signature', async () => {
    const signer = await makeSigner();
    const card = await signCard(signer, { header: { kid: 'made-up-key-id' } });
    const transport = serving({ [JWKS_URL]: jwks({ ...signer.jwk, kid: 'made-up-key-id' }) });

    const strict = await verifyHealthCard(card, { transport, now: () => NOW });
    expect(state(strict.checks, 'key-thumbprint')).toBe('fail');

    const permissive = await verifyHealthCard(card, {
      transport,
      permissive: true,
      now: () => NOW,
    });
    expect(state(permissive.checks, 'key-thumbprint')).toBe('warn');
    expect(permissive.downgraded).toContain('key-thumbprint');
    expect(ruleIds(permissive.findings)).toContain('SHC-PERMISSIVE-MODE');

    // The same switch must not launder a broken signature.
    const parts = card.split('.') as [string, string, string];
    const broken = await verifyHealthCard(
      `${parts[0]}.${parts[1]}.${bytesToBase64url(new Uint8Array(64))}`,
      {
        transport,
        permissive: true,
        now: () => NOW,
      },
    );
    expect(state(broken.checks, 'signature')).toBe('fail');
    expect(broken.downgraded).not.toContain('signature');
    expect(broken.posture).toBe('invalid');
  });

  it('reports the whole ladder every time, including what was not reached', async () => {
    const signer = await makeSigner();
    const card = await signCard(signer);
    const result = await verifyHealthCard(card, {
      transport: serving({ [JWKS_URL]: jwks(signer.jwk) }),
      now: () => NOW,
    });
    expect(result.checks).toHaveLength(21);
    expect(new Set(result.checks.map((c) => c.id)).size).toBe(21);
  });
});

describe('postureFrom', () => {
  const check = (id: CheckId, state: VerificationCheck['state']): VerificationCheck => ({
    id,
    label: id,
    state,
  });

  it('never reads an absence of failures as verified', () => {
    // The trap this exists to stop: a run that never checked anything has no
    // failures either, and calling that verified is the incumbent's mistake.
    expect(postureFrom([])).toBe('not-checked');
    expect(postureFrom([check('jws-shape', 'pass')])).toBe('unverifiable');
  });

  it('reports invalid the moment a validity check fails, whatever else passed', () => {
    expect(postureFrom([check('signature', 'pass'), check('exp', 'fail')])).toBe('invalid');
    expect(postureFrom([check('signature', 'pass'), check('revocation', 'fail')])).toBe('invalid');
  });

  it('separates a clean pass from a pass with defects', () => {
    expect(postureFrom([check('signature', 'pass')])).toBe('verified');
    expect(postureFrom([check('signature', 'pass'), check('key-usage', 'warn')])).toBe(
      'verified-with-warnings',
    );
  });
});

// ---------------------------------------------------------------------------
// Content minimisation
// ---------------------------------------------------------------------------

describe('minificationFindings', () => {
  it('passes a properly minimised bundle', () => {
    expect(minificationFindings(MINIMAL_BUNDLE)).toEqual([]);
  });

  it('names each rule that a fat bundle breaks', () => {
    const fat = {
      resourceType: 'Bundle',
      type: 'collection',
      entry: [
        {
          fullUrl: 'https://ehr.example.org/fhir/Patient/123',
          resource: {
            resourceType: 'Patient',
            id: '123',
            meta: { lastUpdated: '2026-01-01', profile: ['http://example.org/p'] },
            text: { status: 'generated', div: '<div>Mia</div>' },
          },
        },
        {
          resource: {
            resourceType: 'Immunization',
            patient: { reference: 'Patient/123' },
            vaccineCode: {
              text: 'Comirnaty',
              coding: [{ system: 'http://hl7.org/fhir/sid/cvx', code: '208', display: 'COVID-19' }],
            },
          },
        },
      ],
    };
    const ids = ruleIds(minificationFindings(fat));
    expect(ids).toContain('SHC-MIN-RESOURCE-ID');
    expect(ids).toContain('SHC-MIN-META');
    expect(ids).toContain('SHC-MIN-NARRATIVE');
    expect(ids).toContain('SHC-MIN-CODEABLE-TEXT');
    expect(ids).toContain('SHC-MIN-CODING-DISPLAY');
    expect(ids).toContain('SHC-MIN-FULLURL-NOT-SHORT');
    expect(ids).toContain('SHC-MIN-FULLURL-MISSING');
    expect(ids).toContain('SHC-MIN-REFERENCE-NOT-SHORT');
  });

  it('allows meta when it carries only security labels', () => {
    const bundle = {
      resourceType: 'Bundle',
      entry: [
        {
          fullUrl: 'resource:0',
          resource: {
            resourceType: 'Patient',
            meta: {
              security: [{ system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'R' }],
            },
          },
        },
      ],
    };
    expect(minificationFindings(bundle)).toEqual([]);
  });

  it('finds a dangling resource reference, and rates it above a size rule', () => {
    const bundle = {
      resourceType: 'Bundle',
      entry: [
        {
          fullUrl: 'resource:0',
          resource: { resourceType: 'Immunization', patient: { reference: 'resource:9' } },
        },
      ],
    };
    const found = minificationFindings(bundle).find((f) => f.ruleId === 'SHC-REFERENCE-DANGLING');
    expect(found?.severity).toBe('error');
    expect(found?.detail).toContain('resource:9');
  });

  it('aggregates rather than emitting one finding per resource', () => {
    const entry = (index: number) => ({
      fullUrl: `resource:${index}`,
      resource: { resourceType: 'Observation', id: `obs-${index}` },
    });
    const bundle = {
      resourceType: 'Bundle',
      entry: Array.from({ length: 51 }, (_, index) => entry(index)),
    };
    const found = minificationFindings(bundle);
    expect(found).toHaveLength(1);
    expect(found[0]?.title).toContain('51');
    expect(found[0]?.detail).toContain('48 more');
  });

  it('raises severity when the card is delivered as a QR, where the rule is a SHALL', () => {
    const bundle = {
      resourceType: 'Bundle',
      entry: [{ fullUrl: 'resource:0', resource: { resourceType: 'Patient', id: 'x' } }],
    };
    expect(minificationFindings(bundle)[0]?.severity).toBe('warning');
    expect(minificationFindings(bundle, { deliveredAsQr: true })[0]?.severity).toBe('error');
  });

  it('says nothing about a bundle with no entries', () => {
    expect(minificationFindings({ resourceType: 'Bundle', type: 'collection' })).toEqual([]);
    expect(minificationFindings('not a bundle')).toEqual([]);
  });
});
