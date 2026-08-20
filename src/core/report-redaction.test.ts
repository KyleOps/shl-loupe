/**
 * The one promise a shareable report has to keep.
 *
 * `buildDiagnosisReport` opens by telling the reader the key was replaced, which
 * is the whole basis for pasting it into a group chat. This file is the check
 * that the sentence is true, and it is separate from the rest of the report's
 * tests because it is about a security claim rather than about formatting.
 *
 * The defect it was written for: the report echoed the first 120 characters of
 * the raw link. That reads as harmless, and is not. The payload is base64url over
 * JSON, so a prefix of the encoded form carries a prefix of the `key` member, and
 * how much of the key it reaches depends on how long the `url` member is. The
 * redactor could not help, because it matches the key's plain text while what
 * appeared there was a base64 re-encoding of it. Around fifteen of the key's
 * forty-three characters were reaching the report.
 *
 * So the test sweeps URL lengths rather than checking one link: any single
 * example passes or fails by accident of where the key happens to land.
 */
import { describe, expect, it } from 'vitest';
import { openShl } from './pipeline';
import { HTTPS_VIEWER } from './diagnose/context';
import { buildDiagnosisReport, buildSenderExplanation, inputFingerprint } from './report';
import { encodeShlink } from './shlink';
import { bytesToBase64url } from './bytes';
import type { Transport } from './net/transport';

const dead: Transport = {
  name: 'none',
  async send() {
    throw new Error('This test must not reach the network.');
  },
};

const randomKey = (): string => bytesToBase64url(crypto.getRandomValues(new Uint8Array(32)));

/** The longest prefix of `secret` that appears anywhere in `text`, or 0. */
function longestPrefixPresent(text: string, secret: string): number {
  for (let length = secret.length; length >= 6; length -= 1) {
    if (text.includes(secret.slice(0, length))) return length;
  }
  return 0;
}

async function runFor(url: string, key: string) {
  return openShl({
    input: encodeShlink({ url, key }),
    viewer: HTTPS_VIEWER,
    recipient: 'Loupe redaction test',
    transport: dead,
  });
}

describe('a report never carries the key, at any URL length', () => {
  // Where the key begins inside the base64url payload is a function of the URL
  // length, so a single case proves nothing.
  const lengths = [1, 5, 12, 30, 60, 90];

  for (const format of ['markdown', 'json'] as const) {
    it(`leaks no prefix of the key in ${format}`, async () => {
      for (const pathLength of lengths) {
        const key = randomKey();
        const result = await runFor(`https://localhost/${'a'.repeat(pathLength)}`, key);
        const report = buildDiagnosisReport(result.run, result.redactor, { format });
        expect(
          longestPrefixPresent(report, key),
          `url path length ${pathLength} leaked a key prefix`,
        ).toBe(0);
      }
    });
  }

  it('says that it redacted, and means it', async () => {
    const key = randomKey();
    const result = await runFor('https://localhost:5173/api/manifest?bid=1', key);
    const report = buildDiagnosisReport(result.run, result.redactor, { format: 'markdown' });
    expect(report).toContain('replaced with placeholders');
    expect(report).toContain('[link key redacted]');
    // The facts a reader needs are still there: redaction is not censorship.
    expect(report).toContain('localhost:5173');
    expect(report).toContain('SHL-URL-LOOPBACK');
  });

  it('leaks no passcode either', async () => {
    const key = randomKey();
    const result = await openShl({
      input: encodeShlink({ url: 'https://example.org/manifest/abc', key, flag: 'P' }),
      viewer: HTTPS_VIEWER,
      recipient: 'Loupe redaction test',
      passcode: 'correct-horse-battery-staple',
      transport: dead,
    });
    for (const format of ['markdown', 'json'] as const) {
      const report = buildDiagnosisReport(result.run, result.redactor, { format });
      expect(report).not.toContain('correct-horse-battery-staple');
    }
  });

  it('identifies the input without quoting it', async () => {
    const key = randomKey();
    const result = await runFor('https://example.org/manifest/abc', key);
    const fingerprint = await inputFingerprint(result.run.input.source);
    const report = buildDiagnosisReport(result.run, result.redactor, {
      format: 'markdown',
      fingerprint,
    });
    // Eight hex characters answers "is this the same link you sent me?" and
    // discloses nothing, which is all the echoed link was ever really for.
    expect(fingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(report).toContain(fingerprint);
    expect(report).toContain('characters');
  });

  it('is stable: the same input fingerprints the same way', async () => {
    const a = await inputFingerprint('shlink:/eyJhIjoxfQ');
    const b = await inputFingerprint('shlink:/eyJhIjoxfQ');
    const c = await inputFingerprint('shlink:/eyJhIjoyfQ');
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('keeps the sender explanation free of the key as well', async () => {
    // This one is written to be forwarded verbatim, so it matters most of all.
    const key = randomKey();
    const result = await runFor('https://localhost:5173/api/manifest?bid=1', key);
    const explanation = buildSenderExplanation(result.run);
    expect(longestPrefixPresent(explanation, key)).toBe(0);
    expect(explanation).toContain('localhost');
  });
});
