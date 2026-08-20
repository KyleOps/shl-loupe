/**
 * The sample catalogue, checked against the code that has to open it.
 *
 * A catalogue is a set of CLAIMS: this entry is a health card, that link is
 * openable, this key is the published one. A label nobody verifies is how a
 * demo dies in front of a room, so every claim here is re-derived from the
 * thing itself: `kind` against `classifyContent`, every link against the same
 * extractor and validator the pipeline runs, and the encrypted fixture against
 * the plaintext one by actually decrypting it.
 *
 * Nothing here touches the network, including the checks about the live links.
 * What is asserted about those is what the payload SAYS (the U flag, the host,
 * the published key), which is exactly the part that has to be right before
 * anyone tries them at an event.
 */
import { describe, expect, it } from 'vitest';
import { SAMPLES, sampleById, type Sample, type SampleKind } from './index';
import { IG_EXAMPLE_KEY, IG_SHC_FILE, IG_SHC_JWE } from './shc-card';
import { IG_IPS_BUNDLE } from './ips-bundle';
import { NESTED_SHLINK, PLATYPUS_AU_PS_BUNDLE, PLATYPUS_COLLECTION_BUNDLE } from './platypus';
import { classifyContent } from '../core/pipeline';
import { decodeShlPayload, extractShlink, validateShlPayload } from '../core/shlink';
import { decryptDirA256Gcm } from '../core/jose';
import { base64urlToBytes, utf8Decode } from '../core/bytes';

const withContent = SAMPLES.filter((sample) => sample.content !== undefined);
const withLink = SAMPLES.filter((sample) => sample.link !== undefined);

// ---------------------------------------------------------------------------
// The catalogue's own shape
// ---------------------------------------------------------------------------

describe('the catalogue', () => {
  it('gives every sample an id that is safe in a URL and a shortcut', () => {
    for (const sample of SAMPLES) {
      expect(sample.id, sample.title).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(sampleById(sample.id)).toBe(sample);
    }
    expect(new Set(SAMPLES.map((sample) => sample.id)).size).toBe(SAMPLES.length);
    expect(sampleById('no-such-sample')).toBeUndefined();
  });

  it('says what each sample is and what it is for, in both fields', () => {
    for (const sample of SAMPLES) {
      // `title` names the thing, `teaches` is the reason to reach for it. A
      // sample with no teaching hook is one nobody will open at a table.
      expect(sample.title.length, sample.id).toBeGreaterThan(0);
      expect(sample.description.length, sample.id).toBeGreaterThan(80);
      expect(sample.teaches.length, sample.id).toBeGreaterThan(20);
      // Australian English, and no em or en dashes anywhere in copy.
      expect(`${sample.title} ${sample.description} ${sample.teaches}`, sample.id).not.toMatch(
        /[—–]/,
      );
    }
  });

  it('puts the two links to reach for first, and costs a request for nothing else', () => {
    // Ninety seconds of somebody else's attention: the first two entries are
    // the ones that work over a real network.
    expect(SAMPLES.slice(0, 2).map((sample) => sample.id)).toEqual(['ig-ips-link', 'ig-shc-link']);
    expect(withLink.map((sample) => sample.id)).toEqual(['ig-ips-link', 'ig-shc-link']);
    // Everything else opens with the cable out.
    for (const sample of SAMPLES.slice(2)) {
      expect(sample.link, sample.id).toBeUndefined();
    }
  });

  it('carries either a link, some content, or neither and a reason', () => {
    const kinds: SampleKind[] = [
      'smart-health-card',
      'fhir',
      'smart-api-access',
      'unknown',
      'sandbox',
    ];
    for (const sample of SAMPLES) {
      expect(kinds, sample.id).toContain(sample.kind);
      if (sample.kind !== 'sandbox') {
        expect(sample.link !== undefined || sample.content !== undefined, sample.id).toBe(true);
      }
    }
    // The one signpost entry is a signpost, not a payload with a missing member.
    const sandbox = SAMPLES.filter((sample) => sample.kind === 'sandbox');
    expect(sandbox.map((sample) => sample.id)).toEqual(['broken-link-presets']);
    expect(sandbox[0]?.link).toBeUndefined();
    expect(sandbox[0]?.content).toBeUndefined();
    expect(sandbox[0]?.description).toContain('Not a payload');
  });
});

// ---------------------------------------------------------------------------
// A declared kind is a claim the pipeline can check
// ---------------------------------------------------------------------------

describe('every sample with content', () => {
  it('is classified by the pipeline as the kind it declares', () => {
    expect(withContent).toHaveLength(4);
    for (const sample of withContent) {
      // No declared content type is passed: the point is that the CONTENT says
      // what it is, which is what the pipeline relies on for a direct link with
      // no manifest to declare anything.
      expect(classifyContent(sample.content), sample.id).toBe(sample.kind);
    }
  });

  it('is real JSON of the shape its kind implies', () => {
    for (const sample of withContent) {
      const round: unknown = JSON.parse(JSON.stringify(sample.content));
      expect(round, sample.id).toEqual(sample.content);
      const record = round as Record<string, unknown>;
      if (sample.kind === 'fhir') expect(typeof record.resourceType, sample.id).toBe('string');
      if (sample.kind === 'smart-health-card') {
        expect(Array.isArray(record.verifiableCredential), sample.id).toBe(true);
      }
    }
  });

  it('holds the exact fixtures it says it holds', () => {
    expect(sampleById('ig-ips-bundle')?.content).toBe(IG_IPS_BUNDLE);
    expect(sampleById('ig-shc-card')?.content).toBe(IG_SHC_FILE);
    expect(sampleById('platypus-au-ps')?.content).toBe(PLATYPUS_AU_PS_BUNDLE);
    expect(sampleById('platypus-collection')?.content).toBe(PLATYPUS_COLLECTION_BUNDLE);
  });
});

// ---------------------------------------------------------------------------
// Every link in the catalogue
// ---------------------------------------------------------------------------

/** Every link the catalogue ships, including the one inside a fixture payload. */
const ALL_LINKS: Array<[string, string]> = [
  ...withLink.map((sample): [string, string] => [sample.id, sample.link as string]),
  ['platypus-collection nested link', NESTED_SHLINK],
];

describe('every link the catalogue ships', () => {
  it('is extractable, decodable and valid, with no fatal finding', () => {
    for (const [id, link] of ALL_LINKS) {
      const extraction = extractShlink(link);
      expect(extraction, id).toBeDefined();
      if (extraction === undefined) continue;

      const payload = decodeShlPayload(extraction.encodedPayload);
      const validation = validateShlPayload(payload);
      // The whole table, not the first problem: a sample that raises even a
      // warning teaches the wrong lesson when it is meant to be the happy path.
      expect(validation.fatal, id).toEqual([]);
      expect(validation.link, id).toBeDefined();
      expect(
        validation.verdicts.filter((verdict) => verdict.status === 'fail'),
        id,
      ).toEqual([]);
    }
  });

  it('carries a 32-byte key over https, which is what makes it openable at all', () => {
    for (const [id, link] of ALL_LINKS) {
      const extraction = extractShlink(link);
      const payload = decodeShlPayload((extraction as { encodedPayload: string }).encodedPayload);
      const validated = validateShlPayload(payload).link;
      expect(base64urlToBytes(validated?.key ?? '').byteLength, id).toBe(32);
      expect(new URL(validated?.url ?? '').protocol, id).toBe('https:');
    }
  });

  it('uses the carrier form the catalogue says it does', () => {
    // The bare form is what a QR code carries; the prefixed form is what the IG
    // publishes. Both are in here on purpose, and the payload is the same shape
    // in each, which is the convention worth demonstrating.
    expect(extractShlink(sampleById('ig-ips-link')?.link ?? '')?.form).toBe('shlink-uri');
    expect(extractShlink(sampleById('ig-shc-link')?.link ?? '')?.form).toBe('viewer-fragment');
    expect(sampleById('ig-shc-link')?.link).toContain('#shlink:/');
    // A payload after the '#' never reaches the viewer's host. The same payload
    // in a query string would publish the key.
    expect(sampleById('ig-shc-link')?.link).not.toContain('?shlink=');
  });

  it('is a direct-GET link on a CORS-open host, which is why it works in a browser at all', () => {
    for (const sample of withLink) {
      const extraction = extractShlink(sample.link as string);
      const payload = decodeShlPayload((extraction as { encodedPayload: string }).encodedPayload);
      const link = validateShlPayload(payload).link;
      // U means no manifest POST, so no preflight, so no server operator had to
      // think about browsers. That is the entire reason these two are usable.
      expect(link?.flags, sample.id).toContain('U');
      expect(new URL(link?.url ?? '').host, sample.id).toBe('raw.githubusercontent.com');
    }
  });
});

// ---------------------------------------------------------------------------
// Nothing committed here is secret
// ---------------------------------------------------------------------------

describe('the published example key', () => {
  it('is the key both live links carry', () => {
    // Stated in the catalogue's own header, and it is what makes projecting
    // these safe. Asserted rather than trusted, because a fixture re-minted
    // under a fresh key would quietly become a real share.
    for (const sample of withLink) {
      const extraction = extractShlink(sample.link as string);
      const payload = decodeShlPayload((extraction as { encodedPayload: string }).encodedPayload);
      expect(payload.key, sample.id).toBe(IG_EXAMPLE_KEY);
    }
    expect(decodeShlPayload(extractShlink(NESTED_SHLINK)?.encodedPayload ?? '').key).toBe(
      IG_EXAMPLE_KEY,
    );
  });

  it('decrypts the committed ciphertext to the committed plaintext', async () => {
    // Anyone can do this, which is the point: the key is published in the
    // specification's own encryption example. It also pins the two fixtures
    // together, so the "already decrypted" sample cannot drift from the file
    // the live link serves.
    const result = await decryptDirA256Gcm(IG_SHC_JWE, base64urlToBytes(IG_EXAMPLE_KEY));
    expect(JSON.parse(utf8Decode(result.plaintext))).toEqual(IG_SHC_FILE);
    expect(result.header.alg).toBe('dir');
    expect(result.header.enc).toBe('A256GCM');
  });

  it('is 32 bytes, so it is a real key rather than a placeholder', () => {
    expect(base64urlToBytes(IG_EXAMPLE_KEY).byteLength).toBe(32);
    expect(IG_EXAMPLE_KEY).toHaveLength(43);
  });
});

// ---------------------------------------------------------------------------
// The claims each Platypus fixture makes about itself
// ---------------------------------------------------------------------------

describe('the Platypus fixtures', () => {
  const entries = (bundle: typeof PLATYPUS_AU_PS_BUNDLE) => bundle.entry;

  it('keeps the summary profiled and the collection unprofiled, as the catalogue says', () => {
    expect(PLATYPUS_AU_PS_BUNDLE.meta?.profile).toEqual([
      'http://hl7.org.au/fhir/ps/StructureDefinition/au-ps-bundle',
    ]);
    // A collection asserts nothing about completeness, so it claims no profile
    // and carries no Composition. That is what makes a dangling reference in
    // one of them correct rather than a defect.
    expect(PLATYPUS_COLLECTION_BUNDLE.meta?.profile).toBeUndefined();
    expect(entries(PLATYPUS_COLLECTION_BUNDLE)[0]?.resource.resourceType).not.toBe('Composition');
    expect(entries(PLATYPUS_AU_PS_BUNDLE)[0]?.resource.resourceType).toBe('Composition');
  });

  it('carries the nested link the catalogue promises, and it is a link inside a payload', () => {
    // Rendering it means a viewer meets a link while already inside one, which
    // is the case the fixture exists for.
    expect(JSON.stringify(PLATYPUS_COLLECTION_BUNDLE)).toContain(NESTED_SHLINK);
    expect(extractShlink(NESTED_SHLINK)?.form).toBe('shlink-uri');
  });

  it('gives every entry a fullUrl, since half the traps depend on one', () => {
    for (const bundle of [PLATYPUS_AU_PS_BUNDLE, PLATYPUS_COLLECTION_BUNDLE]) {
      for (const entry of entries(bundle)) {
        expect(entry.fullUrl).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
      }
    }
  });
});

function sample(id: string): Sample {
  const found = sampleById(id);
  if (found === undefined) expect.unreachable(`no sample ${id}`);
  return found;
}

it('describes the health-card sample as the one that adds a signature', () => {
  // The card sample is the only one where "the signature was not checked" and
  // "the signature failed" are different answers, and its copy has to say so
  // or the distinction is invisible.
  expect(sample('ig-shc-card').teaches).toContain('signature nobody could check');
  expect(sample('ig-shc-link').description).toContain('verifiableCredential');
});
