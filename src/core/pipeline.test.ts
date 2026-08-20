import { describe, expect, it, vi } from 'vitest';
import { openShl } from './pipeline';
import { HTTPS_VIEWER } from './diagnose/context';
import { OfflineTransport } from './net/browser';
import type { Transport, TransportRequest, TransportResponse } from './net/transport';
import { encodeShlink } from './shlink';
import { encryptDirA256Gcm } from './jose';
import { bytesToBase64url, utf8Encode } from './bytes';

/** A transport that records what it was asked to do and refuses everything. */
class SpyTransport implements Transport {
  readonly name = 'spy';
  readonly calls: TransportRequest[] = [];
  async send(request: TransportRequest): Promise<TransportResponse> {
    this.calls.push(request);
    throw new Error('The pipeline should not have reached the network.');
  }
}

const NOW = Date.parse('2026-08-20T00:00:00Z');
const base = { viewer: HTTPS_VIEWER, recipient: 'SHLoupe tests', now: () => NOW };

const key = () => bytesToBase64url(crypto.getRandomValues(new Uint8Array(32)));

describe('the motivating incident', () => {
  // The link an event participant actually sent, believing it worked, because
  // it did work on their machine.
  const REAL_LINK =
    'shlink:/eyJ1cmwiOiJodHRwczovL2xvY2FsaG9zdDo1MTczL2FwaS9zaGwtbWFuaWZlc3Q_YmlkPTQ4MzY0NzAiLCJrZXkiOiJJR1hkQ0d1Y0ZSQnctb1NWQWo4N01Qdy13eDFHVlhmeWtQQWtwTndIenNrIiwibGFiZWwiOiJQYXRpZW50IFN1bW1hcnkg4oCUIENoYXJpdGEgQWRhbXMiLCJleHAiOjE3ODczNDcyNjMsInYiOjF9';

  it('diagnoses a localhost manifest URL without issuing a single request', async () => {
    const transport = new SpyTransport();
    const result = await openShl({ ...base, input: REAL_LINK, transport });

    expect(transport.calls).toHaveLength(0);
    expect(result.run.networkUsed).toBe(false);
    expect(result.outcome).toBe('blocked');

    const loopback = result.run.findings.find((f) => f.ruleId === 'SHL-URL-LOOPBACK');
    expect(loopback).toBeDefined();
    expect(loopback?.severity).toBe('fatal');
    expect(loopback?.audience).toBe('sender');
    expect(loopback?.title).toContain('nobody else can open it');
    expect(loopback?.remedy).toContain('reachable from the internet');
    // The tool stays useful even when it declares the link unopenable, which is
    // what separates a diagnostic from an error page.
    expect(loopback?.remedy).toContain('Offline mode');
    // All three fatal mechanisms are named, not just the obvious one.
    expect(loopback?.detail).toContain('Nothing is listening');
    expect(loopback?.detail).toContain('Chrome 142');
    expect(loopback?.detail).toContain('certificate cannot be trusted');
  });

  it('still decodes and reports the whole payload, rather than stopping at the failure', async () => {
    const result = await openShl({ ...base, input: REAL_LINK, transport: new SpyTransport() });
    expect(result.link?.url).toBe('https://localhost:5173/api/shl-manifest?bid=4836470');
    expect(result.link?.label).toContain('Charita Adams');
    // The steps before the fatal one all completed, so the trace is a story and
    // not a single error line.
    const kinds = result.run.steps.map((s) => `${s.kind}:${s.status}`);
    expect(kinds).toEqual([
      'input.detect:ok',
      'shlink.decode:ok',
      'shlink.validate:ok',
      'static.analyse:fail',
      // Runs even though the link was stopped, and this is the case it matters
      // most in: a link nobody can retrieve is when somebody starts asking
      // whether it was minted to the profile they think it was.
      'profile.conform:ok',
    ]);
  });

  it('keeps the key in the live run and strips it from anything exported', async () => {
    const { redactRun } = await import('./trace');
    const result = await openShl({ ...base, input: REAL_LINK, transport: new SpyTransport() });
    const KEY = 'IGXdCGucFRBw-oSVAj87MPw-wx1GVXfykPAkpNwHzsk';

    // The live run is the truth: it is the user's own key, on their own screen,
    // and a debugger that hides it from its operator is less useful for no gain.
    expect(JSON.stringify(result.run)).toContain(KEY);

    // What leaves the tab does not carry it, wherever in the run it appeared,
    // including the echoed input and steps recorded before the key was known.
    const exported = JSON.stringify(redactRun(result.run, result.redactor));
    expect(exported).not.toContain(KEY);
    expect(exported).toContain('[link key redacted]');
    expect(exported).toContain('localhost:5173');
  });

  it('reports the expired sibling link as expired, and says how long ago', async () => {
    const expired = encodeShlink({
      url: 'https://example.org/manifest/abc',
      key: key(),
      exp: Math.floor(NOW / 1000) - 7200,
    });
    const result = await openShl({ ...base, input: expired, transport: new SpyTransport() });
    const finding = result.run.findings.find((f) => f.ruleId === 'SHL-EXP-PAST');
    expect(finding?.title).toBe('This link expired 2 hours ago.');
    expect(result.run.networkUsed).toBe(false);
  });
});

describe('payload conformance', () => {
  it('rejects a key that is not 32 bytes, and says what it decoded to', async () => {
    const link = encodeShlink({
      url: 'https://example.org/m',
      key: bytesToBase64url(new Uint8Array(16)),
    });
    const result = await openShl({ ...base, input: link, transport: new SpyTransport() });
    const finding = result.run.findings.find((f) => f.ruleId === 'SHL-PAYLOAD-INVALID');
    expect(finding?.detail).toContain('16 bytes');
    expect(finding?.detail).toContain('needs exactly 32');
  });

  it('flags an exp given in milliseconds', async () => {
    const link = encodeShlink({ url: 'https://example.org/m', key: key(), exp: NOW });
    const result = await openShl({ ...base, input: link, transport: new SpyTransport() });
    expect(result.run.findings.map((f) => f.ruleId)).toContain('SHL-EXP-MILLISECONDS');
  });

  it('flags U combined with P as a contradiction', async () => {
    const link = encodeShlink({ url: 'https://example.org/m', key: key(), flag: 'PU' });
    const result = await openShl({ ...base, input: link, transport: new SpyTransport() });
    expect(result.run.findings.map((f) => f.ruleId)).toContain('SHL-FLAG-U-AND-P');
  });

  it('treats a payload carried in a query string as a key disclosure', async () => {
    const inner = encodeShlink({ url: 'https://example.org/m', key: key() }).replace(
      'shlink:/',
      '',
    );
    const result = await openShl({
      ...base,
      input: `https://viewer.example.org?shlink=${inner}`,
      transport: new SpyTransport(),
    });
    const finding = result.run.findings.find((f) => f.ruleId === 'SHL-CARRIED-IN-QUERY');
    expect(finding?.title).toContain('decryption key reached a server');
  });

  it('does not spend a request on a passcode-protected link until a passcode is given', async () => {
    const transport = new SpyTransport();
    const link = encodeShlink({ url: 'https://example.org/m', key: key(), flag: 'P' });
    const result = await openShl({ ...base, input: link, transport });
    expect(transport.calls).toHaveLength(0);
    expect(result.run.findings.map((f) => f.ruleId)).toContain('SHL-PASSCODE-REQUIRED');
  });
});

describe('a link that works', () => {
  it('walks the whole pipeline and opens an embedded FHIR file', async () => {
    const keyB64 = key();
    const bundle = { resourceType: 'Bundle', type: 'document', entry: [] };
    const jwe = await encryptDirA256Gcm(utf8Encode(JSON.stringify(bundle)), keyB64Bytes(keyB64));
    const manifest = JSON.stringify({
      status: 'finalized',
      files: [{ contentType: 'application/fhir+json;fhirVersion=4.0.1', embedded: jwe }],
    });
    const link = encodeShlink({ url: 'https://example.org/manifest/xyz', key: keyB64 });

    const result = await openShl({
      ...base,
      input: link,
      transport: OfflineTransport.withBodies({ 'https://example.org/manifest/xyz': manifest }),
    });

    expect(result.outcome).toBe('opened');
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.kind).toBe('fhir');
    expect(result.files[0]?.content).toEqual(bundle);
    expect(result.run.steps.map((s) => s.kind)).toEqual([
      'input.detect',
      'shlink.decode',
      'shlink.validate',
      'static.analyse',
      'net.manifest',
      'manifest.validate',
      'jwe.header',
      'jwe.decrypt',
      'payload.classify',
      // Last, and only ever last: it is the one step that can look at the
      // payload, the response and the decrypted Bundle together.
      'profile.conform',
    ]);
  });

  it('proves a key mismatch from the JWE kid before attempting to decrypt', async () => {
    const senderKey = key();
    const linkKey = key();
    const { octThumbprint } = await import('./jose');
    const jwe = await encryptDirA256Gcm(utf8Encode('{}'), keyB64Bytes(senderKey), {
      alg: 'dir',
      enc: 'A256GCM',
      kid: await octThumbprint(senderKey),
    });
    const manifest = JSON.stringify({
      files: [{ contentType: 'application/fhir+json', embedded: jwe }],
    });
    const result = await openShl({
      ...base,
      input: encodeShlink({ url: 'https://example.org/m', key: linkKey }),
      transport: OfflineTransport.withBodies({ 'https://example.org/m': manifest }),
    });
    const finding = result.run.findings.find((f) => f.ruleId === 'SHL-KEY-MISMATCH');
    expect(finding?.title).toContain('different key than the link carries');
    // The decrypt step must never have run: the mismatch is proof, so spending
    // an opaque OperationError on top of it would only muddy the trace.
    expect(result.run.steps.map((s) => s.kind)).not.toContain('jwe.decrypt');
  });

  it('opens the files that worked when one file fails', async () => {
    const keyB64 = key();
    const good = await encryptDirA256Gcm(
      utf8Encode('{"resourceType":"Patient"}'),
      keyB64Bytes(keyB64),
    );
    const bad = await encryptDirA256Gcm(utf8Encode('{}'), keyB64Bytes(key()));
    const manifest = JSON.stringify({
      files: [
        { contentType: 'application/fhir+json', embedded: bad },
        { contentType: 'application/fhir+json', embedded: good },
      ],
    });
    const result = await openShl({
      ...base,
      input: encodeShlink({ url: 'https://example.org/m', key: keyB64 }),
      transport: OfflineTransport.withBodies({ 'https://example.org/m': manifest }),
    });
    expect(result.outcome).toBe('partial');
    expect(result.files.filter((f) => f.content !== undefined)).toHaveLength(1);
    expect(result.files[0]?.failure?.hint).toContain('cannot tell which');
  });
});

describe('server behaviour', () => {
  const linkFor = (url: string) => encodeShlink({ url, key: key() });

  async function withStatus(status: number, body = '', headers: Record<string, string> = {}) {
    const url = 'https://example.org/m';
    const transport: Transport = {
      name: 'status',
      async send() {
        return {
          ok: status >= 200 && status < 300,
          status,
          statusText: '',
          headers,
          body,
          bodyBytes: body.length,
          responseType: 'cors',
          redirected: false,
          finalUrl: url,
          durationMs: 5,
        };
      },
    };
    return openShl({ ...base, input: linkFor(url), transport });
  }

  it('explains that a 404 is deliberately ambiguous', async () => {
    const result = await withStatus(404);
    const finding = result.run.findings.find((f) => f.ruleId === 'SHL-MANIFEST-404');
    expect(finding?.detail).toContain('will not say which');
  });

  it('reads remainingAttempts by its exact spec name', async () => {
    const result = await withStatus(401, JSON.stringify({ remainingAttempts: 2 }));
    const finding = result.run.findings.find((f) => f.ruleId === 'SHL-PASSCODE-WRONG');
    expect(finding?.title).toContain('2 attempts remain');
  });

  it('says the link is dead when remainingAttempts is zero', async () => {
    const result = await withStatus(401, JSON.stringify({ remainingAttempts: 0 }));
    const finding = result.run.findings.find((f) => f.ruleId === 'SHL-PASSCODE-WRONG');
    expect(finding?.title).toContain('last attempt');
    expect(finding?.detail).toContain('permanently disabled');
  });

  it('faults a 401 that omits remainingAttempts', async () => {
    const result = await withStatus(401, '{}');
    expect(result.run.findings.map((f) => f.ruleId)).toContain('SHL-PASSCODE-NO-REMAINING');
  });

  it('surfaces Retry-After on a 429', async () => {
    const result = await withStatus(429, '', { 'retry-after': '30' });
    const finding = result.run.findings.find((f) => f.ruleId === 'SHL-MANIFEST-429');
    expect(finding?.remedy).toBe('Wait 30 seconds.');
  });

  it('calls a 200 that is HTML an error page, not a manifest', async () => {
    const result = await withStatus(200, '<!doctype html><title>Error</title>', {
      'content-type': 'text/html; charset=utf-8',
    });
    expect(result.run.findings.map((f) => f.ruleId)).toContain('SHL-MANIFEST-NOT-JSON');
  });

  it('names an undefined status as the server’s own choice', async () => {
    const result = await withStatus(405);
    const finding = result.run.findings.find((f) => f.ruleId === 'SHL-MANIFEST-UNEXPECTED-STATUS');
    expect(finding?.detail).toContain('405 usually means');
  });

  it('faults a server that ignores embeddedLengthMax', async () => {
    const keyB64 = key();
    const big = await encryptDirA256Gcm(
      utf8Encode(JSON.stringify({ resourceType: 'Bundle', note: 'x'.repeat(5000) })),
      keyB64Bytes(keyB64),
    );
    const manifest = JSON.stringify({
      files: [{ contentType: 'application/fhir+json', embedded: big }],
    });
    const result = await openShl({
      ...base,
      input: encodeShlink({ url: 'https://example.org/m', key: keyB64 }),
      embeddedLengthMax: 1024,
      transport: OfflineTransport.withBodies({ 'https://example.org/m': manifest }),
    });
    const finding = result.run.findings.find((f) => f.ruleId === 'SHL-EMBEDDED-LENGTH-MAX-IGNORED');
    expect(finding?.detail).toContain('1.0 kB');
    // It is a conformance note, not a failure: the file still opens.
    expect(result.outcome).toBe('opened');
  });

  it('shows the manifest list extension point rather than ignoring it', async () => {
    const keyB64 = key();
    const jwe = await encryptDirA256Gcm(
      utf8Encode('{"resourceType":"Patient"}'),
      keyB64Bytes(keyB64),
    );
    const manifest = JSON.stringify({
      list: {
        resourceType: 'List',
        extension: [{ url: 'https://example.org/x', valueString: 'y' }],
      },
      files: [{ contentType: 'application/fhir+json', embedded: jwe }],
    });
    const result = await openShl({
      ...base,
      input: encodeShlink({ url: 'https://example.org/m', key: keyB64 }),
      transport: OfflineTransport.withBodies({ 'https://example.org/m': manifest }),
    });
    const step = result.run.steps.find((s) => s.kind === 'manifest.validate');
    expect(JSON.stringify(step?.evidence)).toContain('the manifest extension point');
  });

  it('reports an empty manifest as legal and empty', async () => {
    const result = await withStatus(200, JSON.stringify({ files: [] }), {
      'content-type': 'application/json',
    });
    const finding = result.run.findings.find((f) => f.ruleId === 'SHL-MANIFEST-EMPTY');
    expect(finding?.detail).toContain('legal by one reading');
  });
});

describe('the network failure differential', () => {
  it('offers the request for a shell that has no curl', async () => {
    // There are always several Windows laptops at an event, and telling somebody
    // to "just run the curl" when their shell has no curl ends the diagnosis.
    const result = await openShl({
      ...base,
      input: encodeShlink({ url: 'https://sharing.example.org/manifest', key: key() }),
      transport: OfflineTransport.withBodies({
        'https://sharing.example.org/manifest': JSON.stringify({ files: [] }),
      }),
    });
    const step = result.run.steps.find((s) => s.kind === 'net.manifest');
    const shells = (step?.evidence ?? [])
      .filter((e) => e.type === 'command')
      .map((e) => (e.type === 'command' ? e.shell : ''));
    expect(shells).toContain('bash');
    expect(shells).toContain('powershell');
  });

  it('ranks CORS first for a public host and keeps the browser message verbatim', async () => {
    const { NetworkFailure } = await import('./net/transport');
    const transport: Transport = {
      name: 'failing',
      async send() {
        throw new NetworkFailure('opaque', 'blocked-by-browser', 40, 'Failed to fetch');
      },
    };
    const result = await openShl({
      ...base,
      input: encodeShlink({ url: 'https://sharing.example.org/manifest', key: key() }),
      transport,
    });
    const step = result.run.steps.find((s) => s.kind === 'net.manifest');
    const notes = step?.evidence.filter((e) => e.type === 'note') ?? [];
    expect(JSON.stringify(notes)).toContain('Failed to fetch');
    expect(JSON.stringify(notes)).toContain('port scanner');
    const finding = result.run.findings.find((f) => f.ruleId.startsWith('NET-'));
    expect(finding?.ruleId).toBe('NET-CORS-MISSING');
  });
});

function keyB64Bytes(keyB64: string): Uint8Array {
  const binary = atob(keyB64.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

// Keep vi imported-but-unused from tripping the linter if this file grows.
void vi;
