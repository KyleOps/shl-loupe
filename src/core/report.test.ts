/**
 * The export boundary, tested as a boundary.
 *
 * Every assertion here is built from a REAL run: `openShl` against the link from
 * the motivating incident, with a transport that refuses. Handing
 * `buildDiagnosisReport` a hand-written `TraceRun` literal would test the
 * formatter and prove nothing about the guarantee, because the guarantee is that
 * a key which genuinely appears in a genuinely recorded run does not reach the
 * output.
 */
import { describe, expect, it } from 'vitest';
import { buildDiagnosisReport, buildSenderExplanation, inputFingerprint } from './report';
import { openShl } from './pipeline';
import { HTTPS_VIEWER } from './diagnose/context';
import { OfflineTransport } from './net/browser';
import { encryptDirA256Gcm } from './jose';
import { encodeShlink } from './shlink';
import { base64urlToBytes, bytesToBase64url, utf8Encode } from './bytes';
import type { Transport, TransportRequest, TransportResponse } from './net/transport';

/** Refuses everything, and records the fact that it was asked. */
class SpyTransport implements Transport {
  readonly name = 'spy';
  readonly calls: TransportRequest[] = [];
  async send(request: TransportRequest): Promise<TransportResponse> {
    this.calls.push(request);
    throw new Error('The pipeline should not have reached the network.');
  }
}

const NOW = Date.parse('2026-08-20T00:00:00Z');
const base = { viewer: HTTPS_VIEWER, recipient: 'Loupe tests', now: () => NOW };

/** The link an event participant actually sent, believing it worked. */
const REAL_LINK =
  'shlink:/eyJ1cmwiOiJodHRwczovL2xvY2FsaG9zdDo1MTczL2FwaS9zaGwtbWFuaWZlc3Q_YmlkPTQ4MzY0NzAiLCJrZXkiOiJJR1hkQ0d1Y0ZSQnctb1NWQWo4N01Qdy13eDFHVlhmeWtQQWtwTndIenNrIiwibGFiZWwiOiJQYXRpZW50IFN1bW1hcnkg4oCUIENoYXJpdGEgQWRhbXMiLCJleHAiOjE3ODczNDcyNjMsInYiOjF9';

/** The key inside REAL_LINK, written out so a test can hunt for it verbatim. */
const REAL_KEY = 'IGXdCGucFRBw-oSVAj87MPw-wx1GVXfykPAkpNwHzsk';

/**
 * A manifest path with enough entropy to satisfy the guessable-URL rule.
 *
 * Without it every minted link here also raises SHL-URL-GUESSABLE against the
 * sender, which would silently become the finding the sender explanation picks,
 * and these tests would then be asserting about the wrong rule.
 */
const HIGH_ENTROPY_PATH = 'yaKcHc9lLPMSVTt5FRr2vZ3RYE0eqAvXeCiTFCcNH9M';

const openLocalhostLink = () =>
  openShl({ ...base, input: REAL_LINK, transport: new SpyTransport() });

// ---------------------------------------------------------------------------
// The pasteable diagnosis
// ---------------------------------------------------------------------------

describe('buildDiagnosisReport', () => {
  it('does not carry the link key anywhere in its output, and says so in its first sentence', async () => {
    const result = await openLocalhostLink();

    // The premise: the key really is in the run, so its absence below is the
    // redaction working rather than the key never having been recorded.
    expect(JSON.stringify(result.run)).toContain(REAL_KEY);

    const report = buildDiagnosisReport(result.run, result.redactor);
    expect(report).not.toContain(REAL_KEY);
    expect(report).toContain('[link key redacted]');
    expect(report).toContain(
      'The decryption key and any passcode in this run were replaced with placeholders',
    );
    expect(report).toContain('safe to paste into a shared channel');
    // The sentence is the first line of the body, not a footnote.
    const lines = report.split('\n').filter((line) => line.trim().length > 0);
    expect(lines[0]).toBe('# SMART Health Link diagnosis');
    expect(lines[1]).toContain('replaced with placeholders');
  });

  it('names the verdict, and names it as a decision not to send a request', async () => {
    const result = await openLocalhostLink();
    const report = buildDiagnosisReport(result.run, result.redactor);
    expect(report).toContain(
      '**Verdict:** Blocked before any request. Loupe could tell from the link alone that it cannot work, so it sent nothing.',
    );
    expect(report).toContain('**Requests made:** none');
    expect(report).toContain(
      '**Manifest URL:** `https://localhost:5173/api/shl-manifest?bid=4836470`',
    );
    expect(report).toContain('**Link label:** Patient Summary');
  });

  it('lists every step with its status word, in the order the run walked them', async () => {
    const result = await openLocalhostLink();
    const report = buildDiagnosisReport(result.run, result.redactor);

    const rows = report
      .split('\n')
      .filter(
        (line) => line.startsWith('| ') && !line.startsWith('| ---') && !line.startsWith('| Step'),
      )
      .map((line) => line.split('|').map((cell) => cell.trim()));

    // Every step, in run order, none dropped and none invented.
    expect(rows).toHaveLength(result.run.steps.length);
    expect(rows.map((cells) => cells[1])).toEqual(result.run.steps.map((step) => step.title));
    expect(rows[0]?.[1]).toBe('Recognise the link');

    // Three passes and the step that stopped it: a story, not one error line.
    expect(rows.map((cells) => cells[2])).toEqual(['pass', 'pass', 'pass', 'failed']);
    // The status words are English, because the reader is a person: a raw
    // `fail` in a pasted table reads as tooling output.
    expect(report).not.toContain('| ok |');
  });

  it('quotes the rule id, the severity and who has to act, for every finding', async () => {
    const result = await openLocalhostLink();
    const report = buildDiagnosisReport(result.run, result.redactor);

    expect(report).toContain('## Findings');
    for (const finding of result.run.findings) {
      expect(report).toContain(finding.ruleId);
      expect(report).toContain(finding.title);
    }
    expect(report).toContain('SHL-URL-LOOPBACK · fatal · the person who created the link');
    // A rule id is what somebody else greps for, so it is quoted rather than
    // paraphrased into prose.
    expect(report).toMatch(/\*\*1\. SHL-URL-LOOPBACK/);
    expect(report).toContain('Spec: SMART Health Links');
  });

  it('offers a command that reproduces the finding outside a browser', async () => {
    const result = await openLocalhostLink();
    const report = buildDiagnosisReport(result.run, result.redactor);
    // A blocked run records no request of its own, and this is exactly the case
    // where the reader wants the one-line check that settles it.
    expect(report).toContain('## Reproduce this outside the browser');
    expect(report).toContain('curl');
    expect(report).toContain('https://localhost:5173/api/shl-manifest?bid=4836470');
    expect(report).not.toContain(REAL_KEY);
  });

  it('round-trips through JSON.parse when asked for the JSON format', async () => {
    const result = await openLocalhostLink();
    const json = buildDiagnosisReport(result.run, result.redactor, { format: 'json' });

    expect(json).not.toContain(REAL_KEY);
    const parsed: unknown = JSON.parse(json);
    expect(typeof parsed).toBe('object');
    const record = parsed as {
      tool?: unknown;
      reportVersion?: unknown;
      secrets?: unknown;
      run?: unknown;
    };
    expect(record.tool).toBe('Loupe');
    expect(record.reportVersion).toBe(1);
    // The machine-readable twin of the redaction sentence.
    expect(record.secrets).toBe('removed');

    const run = record.run as { outcome?: unknown; steps?: unknown[]; findings?: unknown[] };
    expect(run.outcome).toBe('blocked');
    expect(run.steps).toHaveLength(result.run.steps.length);
    expect(run.findings).toHaveLength(result.run.findings.length);
  });

  it('refuses to reassure a caller that supplied no secret registry', async () => {
    const result = await openLocalhostLink();
    const report = buildDiagnosisReport(result.run, undefined);
    // The wording is deliberately unhelpful about safety, and it has to be
    // TRUE: with no registry the key is still in there, so a report that
    // claimed otherwise would be the exact failure this module prevents.
    expect(report).toContain('read it before pasting it anywhere shared');
    expect(report).toContain(REAL_KEY);
    expect(
      JSON.parse(buildDiagnosisReport(result.run, undefined, { format: 'json' })),
    ).toMatchObject({
      secrets: 'unchecked',
    });
  });

  it('says there was nothing to remove when no secret was ever registered', async () => {
    // A run over content with no link in it registers nothing, and "nothing to
    // remove" is a different claim from "we removed it".
    const result = await openShl({
      ...base,
      input: 'not a link at all, just prose',
      transport: new SpyTransport(),
    });
    const report = buildDiagnosisReport(result.run, result.redactor);
    expect(report).toContain('there was nothing to remove');
    expect(
      JSON.parse(buildDiagnosisReport(result.run, result.redactor, { format: 'json' })),
    ).toMatchObject({
      secrets: 'none-registered',
    });
  });
});

// ---------------------------------------------------------------------------
// The echoed input, which redaction cannot save
// ---------------------------------------------------------------------------

/**
 * The trap the module's own comment records: the redactor matches the key's
 * plain text, and the raw link carries a base64url RE-ENCODING of it, so a
 * quoted prefix of the link leaks a prefix of the key through a redactor that
 * reports itself as active.
 */
describe('the input line', () => {
  it('never quotes the raw link, in either format', async () => {
    const result = await openLocalhostLink();
    const encoded = REAL_LINK.replace('shlink:/', '');

    for (const format of ['markdown', 'json'] as const) {
      const report = buildDiagnosisReport(result.run, result.redactor, { format });
      // Any sixteen consecutive characters of the encoded payload would be
      // enough to start reconstructing the key, so none of it may appear.
      for (let at = 0; at + 16 <= encoded.length; at += 8) {
        expect(report.includes(encoded.slice(at, at + 16)), `offset ${at}`).toBe(false);
      }
    }
  });

  it('identifies the input by kind and length instead', async () => {
    const result = await openLocalhostLink();
    const report = buildDiagnosisReport(result.run, result.redactor);
    expect(report).toContain(`**Input:** shlink, ${REAL_LINK.length} characters`);
  });

  it('answers "is this the same link?" with a fingerprint rather than a quote', async () => {
    const result = await openLocalhostLink();
    const fingerprint = await inputFingerprint(REAL_LINK);

    expect(fingerprint).toMatch(/^[0-9a-f]{8}$/);
    // Stable for the same input, different for a different one, and it
    // discloses nothing: eight hex characters of a SHA-256 prefix.
    expect(await inputFingerprint(REAL_LINK)).toBe(fingerprint);
    expect(await inputFingerprint(`${REAL_LINK}x`)).not.toBe(fingerprint);
    expect(REAL_KEY).not.toContain(fingerprint);

    const report = buildDiagnosisReport(result.run, result.redactor, { fingerprint });
    expect(report).toContain(`fingerprint \`${fingerprint}\``);
    expect(
      JSON.parse(
        buildDiagnosisReport(result.run, result.redactor, { format: 'json', fingerprint }),
      ),
    ).toMatchObject({ inputFingerprint: fingerprint });
  });
});

// ---------------------------------------------------------------------------
// Every registered secret, not only the link key
// ---------------------------------------------------------------------------

/**
 * The mutation: a second secret of a different kind, reaching the run by a
 * different route.
 *
 * The link key arrives in the input and is registered while decoding. A passcode
 * arrives from the user and is registered inside the manifest step, then written
 * into a recorded request body. A redactor that only handled the key would pass
 * every test above and leak this.
 */
describe('a run that also carries a passcode', () => {
  const PASSCODE = 'correct-horse-battery';

  async function passcodeRun() {
    const keyB64 = bytesToBase64url(crypto.getRandomValues(new Uint8Array(32)));
    const jwe = await encryptDirA256Gcm(
      utf8Encode(JSON.stringify({ resourceType: 'Bundle', type: 'document', entry: [] })),
      base64urlToBytes(keyB64),
    );
    const manifest = JSON.stringify({
      status: 'finalized',
      files: [{ contentType: 'application/fhir+json', embedded: jwe }],
    });
    const url = `https://sharing.example.org/manifest/${HIGH_ENTROPY_PATH}`;
    return {
      keyB64,
      result: await openShl({
        ...base,
        input: encodeShlink({ url, key: keyB64, flag: 'P' }),
        passcode: PASSCODE,
        transport: OfflineTransport.withBodies({ [url]: manifest }),
      }),
    };
  }

  it('records the passcode in the run, and strips it from every export format', async () => {
    const { keyB64, result } = await passcodeRun();
    expect(result.outcome).toBe('opened');

    // Both secrets really are in the live run: the key from the payload, the
    // passcode from the request body the manifest step recorded.
    const live = JSON.stringify(result.run);
    expect(live).toContain(keyB64);
    expect(live).toContain(PASSCODE);

    for (const format of ['markdown', 'json'] as const) {
      const report = buildDiagnosisReport(result.run, result.redactor, { format });
      expect(report, format).not.toContain(PASSCODE);
      expect(report, format).not.toContain(keyB64);
    }

    // The JSON format serialises the whole run, request bodies included, so the
    // placeholders are visible there. That is the format where a leak would
    // actually happen, and it is masked rather than trimmed.
    const json = buildDiagnosisReport(result.run, result.redactor, { format: 'json' });
    expect(json).toContain('[passcode redacted]');
    expect(json).toContain('[link key redacted]');
  });

  it('keeps the rest of the request body, so the report still shows what was sent', async () => {
    const { result } = await passcodeRun();
    const report = buildDiagnosisReport(result.run, result.redactor);
    // Masking is per secret, not per member: the recipient and the URL are the
    // evidence a server operator needs to find the call in their own log.
    expect(report).toContain('Loupe tests');
    expect(report).toContain('sharing.example.org');
  });
});

// ---------------------------------------------------------------------------
// The message to the sender
// ---------------------------------------------------------------------------

describe('buildSenderExplanation', () => {
  it('is addressed to the sender in second person, about their link', async () => {
    const result = await openLocalhostLink();
    const message = buildSenderExplanation(result.run);

    expect(message).toContain('the SMART Health Link you sent');
    expect(message).toContain('your own machine');
    expect(message).toMatch(/\byour\b/);
    // First person for the writer, second person for the reader. A message in
    // the third person reads as a bug report about somebody else.
    expect(message).toMatch(/^I tried/);
    expect(message).not.toMatch(/\bthe user\b/);
  });

  it('is three short paragraphs: what happens, why it worked for them, what to change', async () => {
    const result = await openLocalhostLink();
    const message = buildSenderExplanation(result.run);
    const paragraphs = message.split('\n\n');

    expect(paragraphs).toHaveLength(3);
    expect(paragraphs[0]).toContain('does not open from here');
    expect(paragraphs[1]).toContain('opens perfectly for you and for nobody else');
    expect(paragraphs[2]).toContain('Re-issue the link');
    expect(message.length).toBeLessThan(1600);
  });

  it('carries no rule id and no trace, unlike the diagnosis', async () => {
    const result = await openLocalhostLink();
    const message = buildSenderExplanation(result.run);
    const report = buildDiagnosisReport(result.run, result.redactor);

    // Not a substring search for one id: nothing SHAPED like a rule id may
    // appear, or the next rule added would slip through this test.
    expect(message).not.toMatch(/\b[A-Z]{3,}-[A-Z-]{3,}\b/);
    expect(message).not.toContain('SHL-');
    expect(message).not.toContain('NET-');

    // No trace: no step titles, no status table, no severity vocabulary.
    for (const step of result.run.steps) expect(message).not.toContain(step.title);
    expect(message).not.toContain('| pass |');
    expect(message).not.toContain('## Steps');
    expect(message).not.toContain('fatal');
    expect(message).not.toContain('Loupe');

    expect(message.length).toBeLessThan(report.length / 2);
  });

  it('does not contain the link key either, since it is a message to send', async () => {
    const result = await openLocalhostLink();
    // No redactor is passed to this function at all, so the guarantee has to
    // come from what it chooses to say rather than from masking.
    expect(buildSenderExplanation(result.run)).not.toContain(REAL_KEY);
  });

  it('tells the sender their link is fine when it opened, rather than inventing a fault', async () => {
    const keyB64 = bytesToBase64url(crypto.getRandomValues(new Uint8Array(32)));
    const jwe = await encryptDirA256Gcm(
      utf8Encode(JSON.stringify({ resourceType: 'Patient' })),
      base64urlToBytes(keyB64),
    );
    const url = `https://sharing.example.org/m/${HIGH_ENTROPY_PATH}`;
    const result = await openShl({
      ...base,
      input: encodeShlink({ url, key: keyB64 }),
      transport: OfflineTransport.withBodies({
        [url]: JSON.stringify({ files: [{ contentType: 'application/fhir+json', embedded: jwe }] }),
      }),
    });

    expect(result.outcome).toBe('opened');
    const message = buildSenderExplanation(result.run);
    expect(message).toContain('it worked from here, first go');
    expect(message).toContain('Nothing at your end needs changing');
  });

  it('names the sender before the server when both are at fault', async () => {
    // An expired link is the sender's to fix, and it is decided offline, so no
    // request is spent learning what the payload already said.
    const url = `https://sharing.example.org/m/${HIGH_ENTROPY_PATH}`;
    const result = await openShl({
      ...base,
      input: encodeShlink({
        url,
        key: bytesToBase64url(new Uint8Array(32)),
        exp: Math.floor(NOW / 1000) - 3600,
      }),
      transport: new SpyTransport(),
    });

    const audiences = result.run.findings
      .filter((f) => f.severity === 'fatal' || f.severity === 'error')
      .map((f) => f.audience);
    expect(audiences).toContain('sender');

    const message = buildSenderExplanation(result.run);
    expect(message).toContain('expired');
    expect(message).toContain('Re-issue the link with a later expiry');
  });
});
