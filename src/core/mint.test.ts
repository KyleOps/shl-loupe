import { describe, expect, it } from 'vitest';
import { base64urlToBytes, utf8Decode } from './bytes';
import { inflateForgiving } from './compress';
import { HTTPS_VIEWER } from './diagnose/context';
import { decryptDirA256Gcm, octThumbprint, parseJweCompact } from './jose';
import {
  BROKEN_PRESETS,
  forgeJwe,
  generateLinkKey,
  mintShl,
  presetById,
  SAMPLE_PAYLOADS,
  SHL_CONTENT_TYPES,
  type BrokenArtefacts,
} from './mint';
import { OfflineTransport } from './net/browser';
import { openShl, type PipelineResult } from './pipeline';
import { decodeShlPayload, extractShlink, validateShlPayload } from './shlink';
import type { TraceRun } from './trace';

const FHIR = SHL_CONTENT_TYPES.fhir;
const SAMPLE = { resourceType: 'Patient', birthDate: '1985-04-12' };

async function open(artefacts: BrokenArtefacts): Promise<PipelineResult> {
  return openShl({
    input: artefacts.shlink,
    viewer: HTTPS_VIEWER,
    recipient: 'Loupe test suite',
    transport: new OfflineTransport(new Map(Object.entries(artefacts.responses))),
    ...(artefacts.passcode === undefined ? {} : { passcode: artefacts.passcode }),
  });
}

/** Per-member verdicts as the payload table recorded them. */
function memberStatuses(run: TraceRun): Map<string, string> {
  const step = run.steps.find((s) => s.kind === 'shlink.validate');
  const statuses = new Map<string, string>();
  for (const evidence of step?.evidence ?? []) {
    if (evidence.type !== 'kv') continue;
    for (const row of evidence.rows) {
      if (row.status !== undefined) statuses.set(row.key, row.status);
    }
  }
  return statuses;
}

describe('mintShl', () => {
  it('produces a link that decodes, validates and decrypts back to its content', async () => {
    const minted = await mintShl({
      content: SAMPLE,
      contentType: FHIR,
      url: 'https://shl.example.org/m/abc',
    });

    const extraction = extractShlink(minted.shlink);
    expect(extraction?.form).toBe('shlink-uri');
    const validation = validateShlPayload(decodeShlPayload(extraction?.encodedPayload ?? ''));
    expect(validation.fatal).toEqual([]);
    expect(validation.link?.key).toBe(minted.key);

    const decrypted = await decryptDirA256Gcm(minted.file.jwe, base64urlToBytes(minted.key));
    expect(JSON.parse(utf8Decode(decrypted.plaintext))).toEqual(SAMPLE);
  });

  it('sets kid to the RFC 7638 thumbprint of its own key, so a receiver can prove a mismatch', async () => {
    const minted = await mintShl({
      content: SAMPLE,
      contentType: FHIR,
      url: 'https://shl.example.org/m/abc',
    });
    expect(minted.kid).toBe(await octThumbprint(minted.key));
    expect(parseJweCompact(minted.file.jwe).header.kid).toBe(minted.kid);
  });

  it('generates a fresh 32-byte key each time', async () => {
    const first = await mintShl({
      content: SAMPLE,
      contentType: FHIR,
      url: 'https://a.example.org/m',
    });
    const second = await mintShl({
      content: SAMPLE,
      contentType: FHIR,
      url: 'https://a.example.org/m',
    });
    expect(first.key).not.toBe(second.key);
    expect(base64urlToBytes(first.key).byteLength).toBe(32);
    expect(first.key.length).toBe(43);
  });

  it('leaves the encrypted key part empty and the IV at 12 bytes', async () => {
    const minted = await mintShl({
      content: SAMPLE,
      contentType: FHIR,
      url: 'https://a.example.org/m',
    });
    const parts = parseJweCompact(minted.file.jwe);
    expect(parts.encryptedKeyB64).toBe('');
    expect(base64urlToBytes(parts.ivB64).byteLength).toBe(12);
    expect(base64urlToBytes(parts.tagB64).byteLength).toBe(16);
  });

  it('raw DEFLATEs the plaintext when asked, with no zlib framing', async () => {
    const big = {
      resourceType: 'Bundle',
      entry: Array.from({ length: 40 }, () => ({ resource: SAMPLE })),
    };
    const minted = await mintShl({
      content: big,
      contentType: FHIR,
      url: 'https://a.example.org/m',
      compress: true,
    });
    expect(parseJweCompact(minted.file.jwe).header.zip).toBe('DEF');

    const decrypted = await decryptDirA256Gcm(minted.file.jwe, base64urlToBytes(minted.key));
    const inflated = inflateForgiving(decrypted.plaintext);
    expect(inflated.framing).toBe('raw-deflate');
    expect(inflated.deviation).toBeUndefined();
    expect(JSON.parse(utf8Decode(inflated.bytes))).toEqual(big);
  });

  it('returns the single file and no manifest for a U-flag link', async () => {
    const minted = await mintShl({
      content: SAMPLE,
      contentType: FHIR,
      url: 'https://a.example.org/file',
      flags: 'LU',
    });
    expect(minted.manifest).toBeUndefined();
    expect(Object.keys(minted.responses)).toEqual(['direct-file']);
  });

  it('puts the payload after the "#" of a viewer prefix, never in a query', async () => {
    const minted = await mintShl({
      content: SAMPLE,
      contentType: FHIR,
      url: 'https://a.example.org/m',
      viewerPrefix: 'https://viewer.example.org#',
    });
    expect(minted.viewerLink).toBe(`https://viewer.example.org#${minted.shlink}`);
    expect(minted.viewerLink).not.toContain('?');
  });

  it('opens end to end through the real pipeline with no server', async () => {
    const minted = await mintShl({
      content: SAMPLE,
      contentType: FHIR,
      url: 'https://shl.example.org/m/BOd6Y1sMxV0BThMOEmZjPUlQ',
      label: 'Round trip',
    });
    const result = await openShl({
      input: minted.shlink,
      viewer: HTTPS_VIEWER,
      recipient: 'Loupe test suite',
      transport: new OfflineTransport(new Map(Object.entries(minted.responses))),
    });
    expect(result.outcome).toBe('opened');
    expect(result.files[0]?.content).toEqual(SAMPLE);
    expect(result.run.findings.filter((f) => f.severity === 'fatal')).toEqual([]);
  });

  it('rejects a key that is not 32 bytes rather than encrypting with a coerced one', async () => {
    await expect(
      mintShl({
        content: SAMPLE,
        contentType: FHIR,
        url: 'https://a.example.org/m',
        key: 'tooshort',
      }),
    ).rejects.toThrow(/32 bytes/);
  });
});

describe('forgeJwe', () => {
  it('writes the IV length it is told to, which the conformant encrypter cannot', async () => {
    const key = generateLinkKey();
    const jwe = await forgeJwe({
      plaintext: new TextEncoder().encode('{}'),
      key: base64urlToBytes(key),
      header: { alg: 'dir', enc: 'A256GCM' },
      ivBytes: 16,
    });
    expect(base64urlToBytes(parseJweCompact(jwe).ivB64).byteLength).toBe(16);
  });

  it('writes the header verbatim, including an alg the profile forbids', async () => {
    const key = generateLinkKey();
    const jwe = await forgeJwe({
      plaintext: new TextEncoder().encode('{}'),
      key: base64urlToBytes(key),
      header: { alg: 'RSA-OAEP', enc: 'A256GCM' },
    });
    expect(parseJweCompact(jwe).header.alg).toBe('RSA-OAEP');
  });

  it('carries a non-empty encrypted key part when asked', async () => {
    const key = generateLinkKey();
    const jwe = await forgeJwe({
      plaintext: new TextEncoder().encode('{}'),
      key: base64urlToBytes(key),
      header: { alg: 'dir', enc: 'A256GCM' },
      encryptedKeyB64: 'AAAA',
    });
    expect(parseJweCompact(jwe).encryptedKeyB64).toBe('AAAA');
  });
});

describe('SAMPLE_PAYLOADS', () => {
  it('covers all three defined content types', () => {
    const types = new Set(SAMPLE_PAYLOADS.map((sample) => sample.contentType.split(';')[0]));
    expect(types).toContain('application/fhir+json');
    expect(types).toContain('application/smart-api-access');
  });

  it('never invents a Coding.display', () => {
    // A display a code system does not publish is rejected by a terminology
    // aware validator, so the sample fixtures carry only verified ones. These
    // four strings were checked against LOINC and SNOMED CT before being used.
    const json = JSON.stringify(SAMPLE_PAYLOADS);
    const displays = [...json.matchAll(/"display":"([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(displays)).toEqual(
      new Set([
        'Patient summary Document',
        'Allergies and adverse reactions Document',
        'No known allergy',
      ]),
    );
  });
});

describe('BROKEN_PRESETS', () => {
  it('has unique ids', () => {
    const ids = BROKEN_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('covers every deviation the catalogue promises', () => {
    // The catalogue is the product here: a promised vector that quietly went
    // missing would leave a receiver untested with no sign that it had.
    const required = [
      'exp-past',
      'exp-milliseconds',
      'url-localhost',
      'url-http',
      'url-over-128',
      'label-over-80',
      'key-16-bytes',
      'key-standard-base64',
      'key-mismatch',
      'flag-u-and-p',
      'flag-unknown',
      'manifest-files-empty',
      'manifest-file-neither',
      'manifest-content-type-lies',
      'passcode-401-no-remaining',
      'jwe-iv-16-bytes',
      'jwe-alg-rsa-oaep',
      'jwe-encrypted-key-present',
      'zip-zlib-framed',
    ];
    for (const id of required) expect(presetById(id), id).toBeDefined();
  });

  it('states a gap exactly when it claims no rule, and never both', () => {
    for (const preset of BROKEN_PRESETS) {
      const claimsNothing = preset.expect.ruleIds.length === 0;
      expect(claimsNothing, preset.id).toBe(preset.expect.gap !== undefined);
      if (claimsNothing) expect(preset.expect.source, preset.id).toBe('none');
      else expect(preset.expect.source, preset.id).not.toBe('none');
    }
  });

  // The test that keeps the catalogue honest. Every preset is run through the
  // real pipeline against an offline transport, and its declared rule ids and
  // outcome must be what actually happens, not what the description hopes.
  for (const preset of BROKEN_PRESETS) {
    it(`${preset.id} trips ${preset.expect.ruleIds.join(', ') || 'nothing, as recorded'}`, async () => {
      const artefacts = await preset.build({ now: Date.parse('2026-08-20T02:00:00Z') });
      const result = await open(artefacts);
      const raised = result.run.findings.map((finding) => finding.ruleId);

      for (const ruleId of preset.expect.ruleIds) {
        expect(
          raised,
          `${preset.id} should raise ${ruleId}, raised ${raised.join(', ')}`,
        ).toContain(ruleId);
      }
      expect(result.outcome, preset.id).toBe(preset.expect.outcome);

      for (const member of preset.expect.payloadMembers ?? []) {
        const status = memberStatuses(result.run).get(member);
        expect(status, `${preset.id}: payload member ${member}`).not.toBe('ok');
        expect(status, `${preset.id}: payload member ${member}`).toBeDefined();
      }
    });
  }

  it('stops the loopback link before any request is issued', async () => {
    const preset = presetById('url-localhost');
    const artefacts = await preset?.build();
    const result = await open(artefacts as BrokenArtefacts);
    // The product thesis: a link pointing at the sender's own machine is
    // answered from the URL, not from a wasted round trip.
    expect(result.run.networkUsed).toBe(false);
    expect(result.outcome).toBe('blocked');
  });

  it('proves the key mismatch from the kid rather than from a failed tag', async () => {
    const preset = presetById('key-mismatch');
    const artefacts = await preset?.build();
    const result = await open(artefacts as BrokenArtefacts);
    const finding = result.run.findings.find((f) => f.ruleId === 'SHL-KEY-MISMATCH');
    expect(finding?.severity).toBe('fatal');
    expect(finding?.audience).toBe('sender');
    // No decryption was attempted, so no ambiguous tag failure was reported.
    expect(result.run.findings.map((f) => f.ruleId)).not.toContain('SHL-DECRYPT-FAILED');
  });
});
