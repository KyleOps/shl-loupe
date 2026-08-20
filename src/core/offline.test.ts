/**
 * Offline mode, over every way content can arrive.
 *
 * Two things are checked for every entry path, and they are the two promises the
 * screen makes:
 *
 *  1. **Nothing reaches the network.** `openOffline` takes no transport, so the
 *     guard here is a `fetch` that throws on sight, which is the actual boundary
 *     rather than a seam a module could route around. `networkUsed` is asserted
 *     too, because that flag is what the offline badge reads.
 *  2. **The result is a renderable run.** A path that produced content but no
 *     trace would look fine on the payload pane and leave the trace pane empty,
 *     which is the state this whole tool exists to replace. {@link expectRenderableRun}
 *     is run against every path for that reason.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeShcNumeric, openOffline } from './offline';
import { encryptDirA256Gcm } from './jose';
import { encodeShlink } from './shlink';
import { base64urlToBytes, bytesToBase64url, utf8Encode } from './bytes';
import { HTTPS_VIEWER } from './diagnose/context';
import type { PipelineResult } from './pipeline';
import type { TraceRun } from './trace';
import { IG_IPS_BUNDLE } from '../fixtures/ips-bundle';
import { IG_EXAMPLE_KEY, IG_SHC_FILE, IG_SHC_JWE } from '../fixtures/shc-card';

const NOW = Date.parse('2026-08-20T00:00:00Z');
const base = { viewer: HTTPS_VIEWER, recipient: 'SHLoupe tests', now: () => NOW };

/** The address from the motivating incident: unopenable by anyone but its author. */
const LOOPBACK_URL = 'https://localhost:5173/api/shl-manifest?bid=4836470';

const randomKey = () => bytesToBase64url(crypto.getRandomValues(new Uint8Array(32)));

/**
 * A compact JWS as `shc:/` digits: each character as its code point minus 45.
 *
 * Indexed rather than iterated because a JWS is ASCII by construction, and the
 * encoding is defined per UTF-16 code unit.
 */
function toNumeric(text: string): string {
  let out = '';
  for (let at = 0; at < text.length; at += 1) {
    out += String(text.charCodeAt(at) - 45).padStart(2, '0');
  }
  return out;
}

/**
 * A `fetch` that fails the test rather than the request.
 *
 * Returning a rejected promise would be indistinguishable from a network that
 * happens to be down, and a module could then swallow it and look offline.
 * Throwing synchronously with a named error makes the violation loud.
 */
let fetchCalls: string[];
let networkStub: (input: unknown) => never;

beforeEach(() => {
  fetchCalls = [];
  networkStub = (input: unknown): never => {
    fetchCalls.push(String(input));
    throw new Error('Offline mode issued a network request.');
  };
  vi.stubGlobal('fetch', networkStub);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * Everything the trace UI reads, checked in one place.
 *
 * A step whose status is still `running`, a finding id on a step with no finding
 * behind it, or a `parentId` pointing at nothing all render as a hole rather
 * than as an error, which is why they are asserted rather than eyeballed.
 */
function expectRenderableRun(result: PipelineResult): TraceRun {
  const { run } = result;
  expect(run.id).toMatch(/^run-/);
  expect(run.startedAt).toBe(NOW);
  expect(run.finishedAt).toBe(NOW);
  expect(run.outcome).not.toBe('running');
  expect(run.outcome).toBe(result.outcome);
  expect(run.steps.length).toBeGreaterThan(0);
  expect(run.networkUsed).toBe(false);
  expect(fetchCalls).toEqual([]);

  const stepIds = new Set(run.steps.map((step) => step.id));
  const findingIds = new Set(run.findings.map((finding) => finding.id));
  for (const step of run.steps) {
    expect(step.title.length, step.id).toBeGreaterThan(0);
    expect(step.title.endsWith('.'), step.title).toBe(false);
    expect(['ok', 'warn', 'fail', 'blocked', 'skipped']).toContain(step.status);
    expect(Array.isArray(step.evidence), step.title).toBe(true);
    if (step.parentId !== undefined) expect(stepIds).toContain(step.parentId);
    for (const id of step.findingIds) expect(findingIds).toContain(id);
  }
  for (const finding of run.findings) {
    expect(finding.ruleId).toMatch(/^[A-Z0-9-]+$/);
    expect(['fatal', 'error', 'warning', 'info', 'good']).toContain(finding.severity);
    expect(['you', 'sender', 'server', 'nobody']).toContain(finding.audience);
    expect(finding.title.length).toBeGreaterThan(0);
    expect(finding.detail.length).toBeGreaterThan(0);
    if (finding.stepId !== undefined) expect(stepIds).toContain(finding.stepId);
  }
  return run;
}

const ruleIds = (result: PipelineResult): string[] => result.run.findings.map((f) => f.ruleId);
const stepKinds = (result: PipelineResult): string[] => result.run.steps.map((s) => s.kind);

it('has the network guard armed, so the assertions above are not vacuous', () => {
  // `expect(fetchCalls).toEqual([])` proves nothing unless a request would
  // actually have been recorded. This is the test that says it would: the stub
  // is the current global, and invoking it records and throws.
  expect(globalThis.fetch).toBe(networkStub);
  expect(() => networkStub('https://sharing.example.org/m')).toThrow(
    'Offline mode issued a network request',
  );
  expect(fetchCalls).toEqual(['https://sharing.example.org/m']);
});

// ---------------------------------------------------------------------------
// A link, plus the manifest somebody fetched by hand
// ---------------------------------------------------------------------------

describe('a link whose manifest was fetched from a shell', () => {
  async function linkAndManifest() {
    const key = randomKey();
    const jwe = await encryptDirA256Gcm(
      utf8Encode(JSON.stringify({ resourceType: 'Bundle', type: 'document', entry: [] })),
      base64urlToBytes(key),
    );
    const manifest = JSON.stringify({
      status: 'finalized',
      files: [{ contentType: 'application/fhir+json', embedded: jwe }],
    });
    return openOffline({
      ...base,
      kind: 'shlink',
      text: encodeShlink({ url: LOOPBACK_URL, key, label: 'Patient Summary' }),
      manifest,
    });
  }

  it('opens the content, and still says the link is unopenable by anyone else', async () => {
    const result = await linkAndManifest();
    expectRenderableRun(result);

    // The pair that looks like a contradiction and is the exact truth of the
    // motivating incident: the link is broken, and here is what is inside it.
    expect(result.outcome).toBe('opened');
    expect(result.files[0]?.kind).toBe('fhir');
    const loopback = result.run.findings.find((f) => f.ruleId === 'SHL-URL-LOOPBACK');
    expect(loopback?.severity).toBe('fatal');
    expect(loopback?.audience).toBe('sender');

    // Online this finding stops the run. Offline the step says why it did not.
    const analysis = result.run.steps.find((step) => step.kind === 'static.analyse');
    expect(analysis?.status).toBe('warn');
    expect(JSON.stringify(analysis?.evidence)).toContain('SHLoupe would stop here on a live run');
  });

  it('records the manifest request it would have sent, and says it was not sent', async () => {
    const result = await linkAndManifest();
    const step = result.run.steps.find((s) => s.kind === 'net.manifest');
    const request = step?.evidence.find((e) => e.type === 'request');
    expect(request?.type).toBe('request');
    if (request?.type === 'request') {
      // A manifest request is a POST with a JSON body. Recording it is what
      // lets a reader compare it against the GET they ran by hand.
      expect(request.request.method).toBe('POST');
      expect(request.request.url).toBe(LOOPBACK_URL);
      expect(request.request.body).toContain('"recipient":"SHLoupe tests"');
    }
    expect(JSON.stringify(step?.evidence)).toContain('This request was not sent');
    expect(result.run.networkUsed).toBe(false);
  });

  it('walks the same step sequence the online pipeline does', async () => {
    const result = await linkAndManifest();
    expect(stepKinds(result)).toEqual([
      'input.detect',
      'shlink.decode',
      'shlink.validate',
      'static.analyse',
      'net.manifest',
      'manifest.validate',
      'jwe.header',
      'jwe.decrypt',
      'payload.classify',
    ]);
  });

  it('hands over the curl command when no manifest was pasted, instead of failing', async () => {
    const result = await openOffline({
      ...base,
      kind: 'shlink',
      text: encodeShlink({ url: LOOPBACK_URL, key: randomKey() }),
    });
    expectRenderableRun(result);

    expect(result.outcome).toBe('blocked');
    expect(ruleIds(result)).toContain('OFFLINE-NO-MANIFEST');
    const step = result.run.steps.find((s) => s.kind === 'net.manifest');
    expect(step?.status).toBe('blocked');
    const command = step?.evidence.find((e) => e.type === 'command');
    if (command?.type === 'command') {
      expect(command.shell).toBe('bash');
      expect(command.command).toContain('curl');
      expect(command.command).toContain(LOOPBACK_URL);
      // The key is not an access credential and a manifest request does not
      // need it, so a command the user may paste into a group chat omits it.
      expect(command.command).not.toContain('key');
    }
  });

  it('names the file it cannot follow, rather than reporting it as a failure to decrypt', async () => {
    const result = await openOffline({
      ...base,
      kind: 'shlink',
      text: encodeShlink({ url: LOOPBACK_URL, key: randomKey() }),
      manifest: JSON.stringify({
        files: [{ contentType: 'application/fhir+json', location: 'https://cdn.example.org/f/1' }],
      }),
    });
    expectRenderableRun(result);

    expect(result.files[0]?.source).toBe('location');
    expect(result.files[0]?.failure?.message).toContain('offline mode issues no requests');
    expect(result.files[0]?.failure?.hint).toContain('paste the file into the encrypted-file box');
    // The command to fetch it sits on the manifest step, so the reader is not
    // left to construct a URL by hand from a relative location.
    const step = result.run.steps.find((s) => s.kind === 'manifest.validate');
    expect(JSON.stringify(step?.evidence)).toContain('https://cdn.example.org/f/1');
  });

  it('rejects a pasted manifest that is not JSON, and names the likeliest cause', async () => {
    const result = await openOffline({
      ...base,
      kind: 'shlink',
      text: encodeShlink({ url: LOOPBACK_URL, key: randomKey() }),
      manifest: 'HTTP/2 200 OK\ncontent-type: application/json\n\n{"files":[]}',
    });
    expectRenderableRun(result);
    const finding = result.run.findings.find((f) => f.ruleId === 'OFFLINE-MANIFEST-NOT-JSON');
    // The cause is nearly always curl -i or -D -, so the remedy names it.
    expect(finding?.detail).toContain('response headers are still on the front of it');
  });
});

// ---------------------------------------------------------------------------
// One encrypted file, plus the key from its link
// ---------------------------------------------------------------------------

describe('a bare JWE with the key pasted beside it', () => {
  it('decrypts the implementation guide’s own file with no network at all', async () => {
    const result = await openOffline({
      ...base,
      kind: 'jwe',
      text: IG_SHC_JWE,
      key: IG_EXAMPLE_KEY,
    });
    expectRenderableRun(result);

    expect(result.outcome).toBe('opened');
    expect(stepKinds(result)).toEqual(['jwe.header', 'jwe.decrypt', 'payload.classify']);
    // Sniffed from the plaintext, not from a declared type: there is no
    // manifest here to declare one.
    expect(result.files[0]?.kind).toBe('smart-health-card');
    expect(result.files[0]?.declaredContentType).toBeUndefined();
    expect(result.files[0]?.content).toEqual(IG_SHC_FILE);
  });

  it('proves the key matches before it tries, so a failure below is about the bytes', async () => {
    const result = await openOffline({
      ...base,
      kind: 'jwe',
      text: IG_SHC_JWE,
      key: IG_EXAMPLE_KEY,
    });
    const header = result.run.steps.find((s) => s.kind === 'jwe.header');
    expect(JSON.stringify(header?.evidence)).toContain('RFC 7638 thumbprint');
    expect(JSON.stringify(header?.evidence)).toContain('the cause is the bytes and not the key');
  });

  it('proves a mismatch from the kid rather than spending an opaque decrypt failure', async () => {
    const result = await openOffline({ ...base, kind: 'jwe', text: IG_SHC_JWE, key: randomKey() });
    expectRenderableRun(result);

    const finding = result.run.findings.find((f) => f.ruleId === 'SHL-KEY-MISMATCH');
    expect(finding?.severity).toBe('fatal');
    expect(finding?.detail).toContain('proof rather than inference');
    // AES-GCM authentication failure is one indistinguishable error, so the
    // decrypt step is never reached once the thumbprints disagree.
    expect(stepKinds(result)).not.toContain('jwe.decrypt');
    expect(result.outcome).toBe('failed');
  });

  it('asks for the key instead of guessing when none was supplied', async () => {
    const result = await openOffline({ ...base, kind: 'jwe', text: IG_SHC_JWE });
    expectRenderableRun(result);

    expect(result.outcome).toBe('blocked');
    expect(result.files).toEqual([]);
    const finding = result.run.findings.find((f) => f.ruleId === 'OFFLINE-NO-KEY');
    expect(finding?.severity).toBe('info');
    expect(finding?.audience).toBe('you');
    expect(finding?.detail).toContain('43 characters of base64url');
    expect(finding?.detail).toContain('never sends it anywhere');
  });
});

// ---------------------------------------------------------------------------
// A manifest on its own
// ---------------------------------------------------------------------------

describe('a manifest pasted with no link', () => {
  it('decrypts its embedded files with a key given on its own', async () => {
    const key = randomKey();
    const jwe = await encryptDirA256Gcm(
      utf8Encode(JSON.stringify({ resourceType: 'Patient', id: 'a' })),
      base64urlToBytes(key),
    );
    const result = await openOffline({
      ...base,
      kind: 'manifest',
      text: JSON.stringify({ files: [{ contentType: 'application/fhir+json', embedded: jwe }] }),
      key,
    });
    expectRenderableRun(result);

    expect(result.outcome).toBe('opened');
    expect(result.files[0]?.content).toEqual({ resourceType: 'Patient', id: 'a' });
  });

  it('says where the key comes from, rather than reporting the files as broken', async () => {
    const result = await openOffline({
      ...base,
      kind: 'manifest',
      text: JSON.stringify({
        files: [{ contentType: 'application/fhir+json', embedded: 'eyJ.a.b.c.d' }],
      }),
    });
    expectRenderableRun(result);
    const finding = result.run.findings.find((f) => f.ruleId === 'OFFLINE-NO-KEY');
    expect(finding?.detail).toContain('lives in the SMART Health Link the manifest came from');
    expect(result.files).toEqual([]);
  });

  it('calls an empty manifest legal and empty, and stops there', async () => {
    const result = await openOffline({
      ...base,
      kind: 'manifest',
      text: '{"files":[]}',
      key: randomKey(),
    });
    expectRenderableRun(result);
    expect(result.outcome).toBe('blocked');
    expect(ruleIds(result)).toContain('SHL-MANIFEST-EMPTY');
  });

  it('names what a manifest is missing when it has no files array', async () => {
    const result = await openOffline({ ...base, kind: 'manifest', text: '{"status":"finalized"}' });
    expectRenderableRun(result);
    const finding = result.run.findings.find((f) => f.ruleId === 'SHL-MANIFEST-NO-FILES');
    expect(finding?.audience).toBe('server');
    expect(finding?.detail).toContain('only status');
  });
});

// ---------------------------------------------------------------------------
// Content that is already decrypted
// ---------------------------------------------------------------------------

describe('a decrypted bundle', () => {
  it('renders the guide’s IPS document with nothing to decode and no key', async () => {
    const result = await openOffline({
      ...base,
      kind: 'fhir',
      text: JSON.stringify(IG_IPS_BUNDLE),
    });
    expectRenderableRun(result);

    expect(result.outcome).toBe('opened');
    expect(stepKinds(result)).toEqual(['fhir.parse']);
    expect(result.files[0]?.kind).toBe('fhir');
    expect(result.files[0]?.content).toEqual(IG_IPS_BUNDLE);
    expect(result.files[0]?.compressed).toBe(false);
    expect(result.files[0]?.bytes).toBeGreaterThan(1000);
    expect(result.run.findings).toEqual([]);
  });

  it('reports JSON with no resourceType as a warning, and still shows it', async () => {
    const result = await openOffline({ ...base, kind: 'fhir', text: '{"entry":[]}' });
    expectRenderableRun(result);
    expect(result.outcome).toBe('opened');
    const finding = result.run.findings.find((f) => f.ruleId === 'OFFLINE-FHIR-NO-RESOURCE-TYPE');
    expect(finding?.severity).toBe('error');
    expect(result.run.steps[0]?.status).toBe('warn');
  });
});

// ---------------------------------------------------------------------------
// Health cards
// ---------------------------------------------------------------------------

describe('a health card', () => {
  it('opens a file wrapper and states that the signature was not checked', async () => {
    const result = await openOffline({ ...base, kind: 'shc', text: JSON.stringify(IG_SHC_FILE) });
    expectRenderableRun(result);

    expect(result.outcome).toBe('opened');
    expect(result.files[0]?.kind).toBe('smart-health-card');
    const bundle = result.files[0]?.content as { resourceType?: string } | undefined;
    expect(bundle?.resourceType).toBe('Bundle');

    // "Not checked" and "checked out" must never look the same. The card is
    // rendered, and the trace says exactly what was and was not established.
    const finding = result.run.findings.find((f) => f.ruleId === 'SHC-NOT-VERIFIED');
    expect(finding?.severity).toBe('info');
    expect(finding?.detail).toContain('not something SHLoupe has confirmed');
    expect(finding?.detail).toContain('/.well-known/jwks.json');
    expect(result.run.steps.find((s) => s.kind === 'shc.verify')?.status).toBe('warn');
  });

  it('offers the command that fetches the issuer key set', async () => {
    const result = await openOffline({ ...base, kind: 'shc', text: JSON.stringify(IG_SHC_FILE) });
    const step = result.run.steps.find((s) => s.kind === 'shc.verify');
    const command = step?.evidence.find((e) => e.type === 'command');
    if (command?.type === 'command') {
      expect(command.command).toContain(
        'https://raw.githubusercontent.com/seanno/shc-demo-data/main/.well-known/jwks.json',
      );
    } else {
      expect.unreachable('the verify step should carry a jwks command');
    }
  });

  it('opens a bare compact JWS with no wrapper around it', async () => {
    const result = await openOffline({
      ...base,
      kind: 'jws',
      text: IG_SHC_FILE.verifiableCredential[0] as string,
    });
    expectRenderableRun(result);
    expect(result.outcome).toBe('opened');
    expect(result.files[0]?.kind).toBe('smart-health-card');
  });

  it('opens the numeric form a QR code carries', async () => {
    const card = IG_SHC_FILE.verifiableCredential[0] as string;
    const result = await openOffline({ ...base, kind: 'shc', text: `shc:/${toNumeric(card)}` });
    expectRenderableRun(result);
    expect(result.outcome).toBe('opened');
    expect(result.files[0]?.kind).toBe('smart-health-card');
  });

  it('faults an empty file wrapper against the sender', async () => {
    const result = await openOffline({ ...base, kind: 'shc', text: '{"verifiableCredential":[]}' });
    expectRenderableRun(result);
    const finding = result.run.findings.find((f) => f.ruleId === 'SHC-FILE-EMPTY');
    expect(finding?.audience).toBe('sender');
    expect(result.outcome).toBe('failed');
  });

  it('keeps rendering the card when the pasted key set is not JSON', async () => {
    const result = await openOffline({
      ...base,
      kind: 'shc',
      text: JSON.stringify(IG_SHC_FILE),
      jwks: 'not json at all',
    });
    expectRenderableRun(result);
    expect(ruleIds(result)).toContain('OFFLINE-JWKS-NOT-JSON');
    // The card still opens: an unusable key set downgrades the verdict about
    // the signature, not the run.
    expect(result.outcome).toBe('opened');
  });
});

describe('decodeShcNumeric', () => {
  it('turns pairs of digits back into the signed token', () => {
    const decoded = decodeShcNumeric(`shc:/${toNumeric('eyJhbGciOiJFUzI1NiJ9.aa.bb')}`);
    expect(decoded.jws).toBe('eyJhbGciOiJFUzI1NiJ9.aa.bb');
    expect(decoded.chunks).toBe(1);
    expect(decoded.problem).toBeUndefined();
  });

  it('strips a chunk header, which is not part of the payload', () => {
    const decoded = decodeShcNumeric(`shc:/2/3/${toNumeric('abc')}`);
    expect(decoded.jws).toBe('abc');
    expect(decoded.chunks).toBe(3);
  });

  it('names a lost digit instead of returning a token that is one character short', () => {
    const decoded = decodeShcNumeric(`shc:/${toNumeric('abc')}5`);
    expect(decoded.jws).toBe('');
    expect(decoded.problem).toContain('7 digits leaves one over');
    expect(decoded.problem).toContain('partial QR scan');
  });
});

// ---------------------------------------------------------------------------
// What SHLoupe will not pretend to open
// ---------------------------------------------------------------------------

describe('content SHLoupe does not read', () => {
  it('names an HC1 certificate and stops, rather than half-decoding it', async () => {
    const result = await openOffline({ ...base, kind: 'hcert', text: 'HC1:NCFOXN%TSMAHN-H' });
    expectRenderableRun(result);

    expect(result.outcome).toBe('blocked');
    const finding = result.run.findings.find((f) => f.ruleId === 'OFFLINE-HCERT-UNSUPPORTED');
    expect(finding?.severity).toBe('error');
    expect(finding?.detail).toContain('a half-decode that showed you some bytes would be worse');
  });

  it('lists what it does read when it recognises nothing', async () => {
    const result = await openOffline({ ...base, kind: 'unknown', text: 'nothing useful' });
    expectRenderableRun(result);
    const finding = result.run.findings.find((f) => f.ruleId === 'OFFLINE-UNRECOGNISED');
    expect(finding?.detail).toContain('the raw output of a curl command');
    expect(result.outcome).toBe('blocked');
  });
});
