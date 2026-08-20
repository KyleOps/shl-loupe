/**
 * The variant catalogue, and the rule that holds it together.
 *
 * The rule is that a different profile is never reported as invalid, so most of
 * what is asserted here is a NEGATIVE: for every well-formed payload from every
 * family, no signal comes back at `error` or `fatal` severity. That is the whole
 * defect this module exists to prevent, and it is the assertion that would fail
 * if somebody later added a rule that treats "not the HL7 baseline" as broken.
 *
 * The HCERT cases are minted here rather than pasted, because a real EU or WHO
 * certificate is a signed document belonging to somebody. Minting one needs a
 * CBOR encoder, which the module itself does not have (it only ever decodes), so
 * a small one lives in this file with the reason stated.
 */
import { describe, expect, it } from 'vitest';
import { zlibSync } from 'fflate';
import {
  base45Complaint,
  base45Decode,
  base45Encode,
  decodeCbor,
  decodeHcert,
  identifyVariant,
  impliedProtocol,
  VARIANTS,
  type VariantId,
  type VariantIdentification,
  type VariantInput,
} from './variants';
import { deflateRawBytes } from './compress';
import { bytesToBase64url, stringToBase64url, utf8Decode, utf8Encode } from './bytes';
import { encodeShlink, type ShlPayload } from './shlink';
import { DecodeError } from './bytes';
import { IG_IPS_BUNDLE } from '../fixtures/ips-bundle';
import { IG_SHC_FILE } from '../fixtures/shc-card';
import { PLATYPUS_AU_PS_BUNDLE } from '../fixtures/platypus';

const KEY = bytesToBase64url(new Uint8Array(32).fill(3));
const MANIFEST_URL =
  'https://sharing.example.org/manifest/JmNBOoNRVKQ0BeQvVJQrKYYzMdAWkPPeNJmvxfXBLNM';

const payload = (extra: ShlPayload = {}): ShlPayload => ({ url: MANIFEST_URL, key: KEY, ...extra });

/** Identify, assert the id, and hand back the whole identification. */
function expectVariant(input: VariantInput, id: VariantId): VariantIdentification {
  const identification = identifyVariant(input);
  expect(identification.variant.id, JSON.stringify(input).slice(0, 120)).toBe(id);
  // The catalogue is the only source of a variant, so an identification can
  // never carry a description nobody wrote.
  expect(identification.variant).toBe(VARIANTS[id]);
  return identification;
}

const said = (identification: VariantIdentification): string =>
  identification.signals.map((signal) => `${signal.observation} ${signal.meaning}`).join('\n');

/** Every id an identification names, itself and any inner one. */
function idsIn(identification: VariantIdentification): VariantId[] {
  return [
    identification.variant.id,
    ...(identification.inner === undefined ? [] : idsIn(identification.inner)),
  ];
}

// ---------------------------------------------------------------------------
// A tiny CBOR encoder, for minting HCERT fixtures only
// ---------------------------------------------------------------------------

const bytes = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
};

/** Major type plus argument, using the shortest form, which is what canonical CBOR wants. */
function head(major: number, value: number): Uint8Array {
  if (value < 24) return new Uint8Array([(major << 5) | value]);
  if (value < 0x100) return new Uint8Array([(major << 5) | 24, value]);
  if (value < 0x10000) return new Uint8Array([(major << 5) | 25, value >> 8, value & 0xff]);
  return new Uint8Array([
    (major << 5) | 26,
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ]);
}

const cborInt = (value: number): Uint8Array => (value < 0 ? head(1, -1 - value) : head(0, value));
const cborBytes = (value: Uint8Array): Uint8Array => bytes(head(2, value.length), value);
const cborText = (value: string): Uint8Array => {
  const encoded = utf8Encode(value);
  return bytes(head(3, encoded.length), encoded);
};
const cborArray = (items: Uint8Array[]): Uint8Array => bytes(head(4, items.length), ...items);
const cborMap = (pairs: Array<[Uint8Array, Uint8Array]>): Uint8Array =>
  bytes(head(5, pairs.length), ...pairs.flat());
const cborTag = (tag: number, value: Uint8Array): Uint8Array => bytes(head(6, tag), value);

interface MintHcert {
  /** The HCERT subclaims to put under CWT claim -260, keyed by claim number. */
  subclaims?: Array<[number, Uint8Array]>;
  contextId?: string;
  /** Framing for the compressed body. HCERT requires zlib; raw is the deviation. */
  framing?: 'zlib' | 'raw-deflate';
  tag?: number;
}

/** A COSE_Sign1 HCERT QR string, unsigned: the signature bytes are filler. */
function mintHcert(options: MintHcert = {}): string {
  const cwt = cborMap([
    [cborInt(1), cborText('AU')],
    [cborInt(4), cborInt(2000000000)],
    [cborInt(6), cborInt(1700000000)],
    [
      cborInt(-260),
      cborMap((options.subclaims ?? []).map(([claim, value]) => [cborInt(claim), value])),
    ],
  ]);
  const sign1 = cborArray([
    // The protected header travels as a byte string because its bytes are part
    // of the signed input.
    cborBytes(cborMap([[cborInt(1), cborInt(-7)]])),
    cborMap([[cborInt(4), cborBytes(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))]]),
    cborBytes(cwt),
    cborBytes(new Uint8Array(64)),
  ]);
  const wrapped = cborTag(options.tag ?? 18, sign1);
  const compressed =
    options.framing === 'raw-deflate' ? deflateRawBytes(wrapped) : zlibSync(wrapped);
  return `${options.contextId ?? 'HC1'}:${base45Encode(compressed)}`;
}

/** CWT claim -260, subclaim 5: the health-link slot. */
const hcertLinkClaim = (uri: string): Array<[number, Uint8Array]> => [[5, cborText(uri)]];

// ---------------------------------------------------------------------------
// The catalogue as data
// ---------------------------------------------------------------------------

describe('the catalogue', () => {
  it('states a capability rather than a verdict for every entry', () => {
    for (const [id, variant] of Object.entries(VARIANTS)) {
      expect(variant.id).toBe(id);
      expect(variant.name.length).toBeGreaterThan(0);
      expect(variant.summary.endsWith('.'), id).toBe(true);
      expect(['full', 'partial', 'decode-only', 'unsupported']).toContain(variant.support);
      // What is missing is named exactly when something is, so "Loupe cannot
      // finish this" never reads as "this is broken".
      expect(variant.missing.length > 0, id).toBe(variant.support !== 'full');
    }
  });

  it('says nothing differs for the baseline, and something differs for every profile of it', () => {
    expect(VARIANTS['shl-baseline'].differences).toEqual([]);
    // A "flavour" that turns out to be the same payload with different
    // governance still has to say what it changes, or the pane has nothing to
    // teach with.
    expect(VARIANTS['shl-who-phw'].differences.length).toBeGreaterThan(0);
    expect(VARIANTS['shl-ktc'].differences.length).toBeGreaterThan(0);
    expect(VARIANTS['shl-ktc'].differences[0]).toContain('byte for byte');
  });
});

// ---------------------------------------------------------------------------
// Link payload families
// ---------------------------------------------------------------------------

describe('link payloads', () => {
  it('calls a payload with only specification members the baseline, and says so as good news', () => {
    const identification = expectVariant({ kind: 'payload', payload: payload() }, 'shl-baseline');
    expect(identification.protocol).toBe('shl-manifest-post');
    expect(identification.signals.some((signal) => signal.severity === 'good')).toBe(true);
    // Downstream profiles that reuse the payload byte for byte are named here,
    // because "indistinguishable" is the answer and it needs explaining.
    expect(said(identification)).toContain('CA:SHL');
  });

  it('recognises the WHO wallet model from its one added member', () => {
    const identification = expectVariant(
      { kind: 'payload', payload: payload({ type: 'shl' }) },
      'shl-who-phw',
    );
    expect(identification.protocol).toBe('shl-manifest-post');
    expect(said(identification)).toContain('The HL7 payload has no `type` member');
  });

  it('warns about a type value the WHO model does not define, without calling the link invalid', () => {
    const identification = identifyVariant({ kind: 'payload', payload: payload({ type: 'card' }) });
    const type = identification.signals.find((signal) => signal.observation.includes('`type`'));
    expect(type?.severity).toBe('warning');
    expect(identification.signals.some((signal) => signal.severity === 'error')).toBe(false);
  });

  it('reads a List search url as an IHE link even with no type member', () => {
    const identification = expectVariant(
      {
        kind: 'payload',
        payload: payload({ url: 'https://vhl.example.org/fhir/List/_search?_id=abc' }),
      },
      'vhl',
    );
    expect(identification.protocol).toBe('vhl-list-search');
    // The point of saying it early: an SHL manifest POST against this was never
    // going to work, so nobody should spend an afternoon debugging one.
    expect(said(identification)).toContain('was never going to work');
  });

  it('takes the vhlink scheme as the statement it is, whatever the payload looks like', () => {
    const identification = expectVariant(
      `vhlink:/${stringToBase64url(JSON.stringify(payload()))}`,
      'vhl',
    );
    expect(identification.protocol).toBe('vhl-list-search');
    expect(said(identification)).toContain('The URI scheme is `vhlink:`');
  });

  it('takes the sender’s word for KTC, and says that is what it is doing', () => {
    const identification = expectVariant(
      { kind: 'payload', payload: payload({ _ktcVersion: '1' }) },
      'shl-ktc',
    );
    // Nothing in a link can prove KTC conformance, because KTC constrains the
    // server. Saying so is the difference between a claim and a finding.
    expect(said(identification)).toContain('nothing in a link can prove KTC conformance');
  });

  it('treats an unrecognised member as a legal extension, not a fault', () => {
    const identification = expectVariant(
      { kind: 'payload', payload: payload({ somethingNew: 1 }) },
      'shl-extension-unknown',
    );
    expect(said(identification)).toContain('has to ignore it rather than fail');
    expect(identification.signals.every((signal) => signal.severity === 'info')).toBe(true);
  });

  it('recognises the underscore convention the specification reserves', () => {
    const identification = identifyVariant({
      kind: 'payload',
      payload: payload({ _manifestId: 'abc' }),
    });
    expect(identification.variant.id).toBe('shl-baseline');
    expect(said(identification)).toContain(
      'that is the extension SHLServer emits, and it is legal'.slice(4),
    );
  });

  it('names the plural extensions member that IHE’s own example carries', () => {
    const identification = identifyVariant({
      kind: 'payload',
      payload: payload({ extensions: { a: 1 } }),
    });
    const signal = identification.signals.find((entry) => entry.observation.includes('plural'));
    expect(signal?.severity).toBe('warning');
    expect(signal?.meaning).toContain('IHE’s own worked example');
  });

  it('flags a raw vertical bar in the url, which is not legal in a URI', () => {
    const identification = identifyVariant({
      kind: 'payload',
      payload: payload({
        url: 'https://vhl.example.org/fhir/List/_search?patient.identifier=urn:oid:1.2|3',
      }),
    });
    const signal = identification.signals.find((entry) => entry.observation.includes('`|`'));
    expect(signal?.severity).toBe('warning');
    expect(signal?.meaning).toContain('%7C');
  });

  it('keeps the family the scheme declared when the payload will not decode', () => {
    // The scheme is an observation in its own right, so the family stands and
    // the decode failure is reported as a signal about the bytes. Reporting
    // `unknown` instead would throw away the one thing that WAS observable.
    const identification = expectVariant('shlink:/bm90LWEtcGF5bG9hZA', 'shl-baseline');
    expect(identification.protocol).toBe('unknown');
    const problem = identification.signals.find((signal) => signal.severity === 'error');
    expect(problem?.observation).toBe('The payload after `shlink:/` did not decode.');
    expect(problem?.meaning).toContain('not JSON');
  });

  it('reads a bare payload with no scheme, and says the protocol was inferred', () => {
    const identification = expectVariant(
      stringToBase64url(JSON.stringify(payload())),
      'shl-baseline',
    );
    expect(said(identification)).toContain(
      'inferred from the payload rather than stated by a scheme',
    );
  });
});

describe('impliedProtocol', () => {
  it('reads the U flag as a direct GET', () => {
    expect(impliedProtocol(payload({ flag: 'LU' }))).toBe('shl-direct-get');
    expect(impliedProtocol(payload({ flag: 'lu' }))).toBe('shl-direct-get');
  });

  it('lets a List search url outrank the U flag, because the endpoint decides', () => {
    expect(
      impliedProtocol({ url: 'https://x.example.org/fhir/List/_search', key: KEY, flag: 'U' }),
    ).toBe('vhl-list-search');
  });

  it('defaults to the manifest POST', () => {
    expect(impliedProtocol(payload())).toBe('shl-manifest-post');
    expect(impliedProtocol({})).toBe('shl-manifest-post');
  });
});

// ---------------------------------------------------------------------------
// Manifests
// ---------------------------------------------------------------------------

describe('a manifest response', () => {
  it('reports an unexpected content type to the server operator without refusing the file', () => {
    const identification = expectVariant(
      {
        kind: 'manifest',
        manifest: { files: [{ contentType: 'application/pdf', location: 'https://x.example/f' }] },
      },
      'shl-baseline',
    );
    const signal = identification.signals.find((entry) => entry.observation.includes('pdf'));
    expect(signal?.severity).toBe('warning');
    // A real national deployment emits it, so it is a deviation to report
    // rather than a reason to reject the manifest.
    expect(signal?.meaning).toContain('Malaysia');
    expect(signal?.meaning).toContain('does not reject the manifest');
  });

  it('accepts the three content types the specification allows with nothing to say', () => {
    const identification = identifyVariant({
      kind: 'manifest',
      manifest: {
        files: [
          { contentType: 'application/fhir+json;fhirVersion=4.0.1', embedded: 'x' },
          { contentType: 'application/smart-health-card', embedded: 'y' },
          { contentType: 'application/smart-api-access', embedded: 'z' },
        ],
      },
    });
    expect(identification.signals).toHaveLength(1);
    expect(identification.signals[0]?.observation).toContain('SHL manifest response');
  });

  it('names the list extension point as the conformant place for an extension', () => {
    const identification = identifyVariant({
      kind: 'manifest',
      manifest: {
        files: [],
        list: {
          resourceType: 'List',
          meta: { profile: ['https://profiles.ihe.net/ITI/VHL/StructureDefinition/vhl-list'] },
          extension: [{ url: 'https://example.org/x', valueString: 'y' }],
        },
      },
    });
    expect(said(identification)).toContain('the designated slot for manifest extensions');
    expect(said(identification)).toContain('IHE Verifiable Health Links profile');
  });
});

// ---------------------------------------------------------------------------
// Content families
// ---------------------------------------------------------------------------

describe('decrypted content', () => {
  const profiled = (profile: string): VariantInput => ({
    kind: 'content',
    content: { resourceType: 'Bundle', type: 'document', meta: { profile: [profile] } },
  });

  it('recognises a health-card file, and a SMART API access file', () => {
    expectVariant({ kind: 'content', content: IG_SHC_FILE }, 'shc');
    const api = expectVariant(
      { kind: 'content', content: { access_token: 'x', aud: 'https://ehr.example.org/fhir' } },
      'smart-api-access',
    );
    expect(said(api)).toContain('an API endpoint and a token rather than a document');
  });

  it('names each profile family from its canonical prefix', () => {
    expectVariant(
      profiled('http://hl7.org/fhir/uv/ips/StructureDefinition/Bundle-uv-ips'),
      'fhir-ips',
    );
    expectVariant(profiled('http://smart.who.int/icvp/StructureDefinition/DVC'), 'fhir-icvp');
    expectVariant(
      profiled('http://smart.who.int/ddcc/StructureDefinition/DDCCDocument'),
      'fhir-ddcc',
    );
    expectVariant(
      profiled('http://hl7.org/fhir/us/insurance-card/StructureDefinition/C4DIC-Coverage'),
      'fhir-c4dic',
    );
  });

  it('matches on the canonical base, so an IG release that renames a slug still matches', () => {
    expectVariant(
      profiled('http://hl7.org/fhir/uv/ips/StructureDefinition/Bundle-uv-ips-2'),
      'fhir-ips',
    );
  });

  it('lets AU PS win over IPS, since AU PS derives from it', () => {
    const both = expectVariant(
      {
        kind: 'content',
        content: {
          resourceType: 'Bundle',
          meta: {
            profile: [
              'http://hl7.org/fhir/uv/ips/StructureDefinition/Bundle-uv-ips',
              'http://hl7.org.au/fhir/ps/StructureDefinition/au-ps-bundle',
            ],
          },
        },
      },
      'fhir-au-ps',
    );
    expect(both.profiles).toHaveLength(2);
  });

  it('identifies a real Australian summary from the profile it actually stamps', () => {
    const identification = expectVariant(
      { kind: 'content', content: PLATYPUS_AU_PS_BUNDLE },
      'fhir-au-ps',
    );
    expect(identification.protocol).toBe('self-contained');
    // Conformance is a separate question from family, and the wording says so
    // rather than implying the stamp proves anything.
    expect(said(identification)).toContain('Whether it conforms is a separate question');
  });

  it('does not read absence of a profile as absence of an IPS', () => {
    // The guide's own IPS example stamps no profile at all, which is exactly why
    // this cannot be treated as evidence.
    const identification = expectVariant(
      { kind: 'content', content: IG_IPS_BUNDLE },
      'fhir-unprofiled',
    );
    expect(identification.profiles).toEqual([]);
    expect(said(identification)).toContain('absence is not evidence that this is not an IPS');
  });

  it('calls an unrecognised canonical a gap in Loupe, not a problem with the payload', () => {
    const identification = expectVariant(
      profiled('http://example.org/fhir/national/StructureDefinition/summary'),
      'fhir-unprofiled',
    );
    expect(said(identification)).toContain('a gap in Loupe rather than a problem with the payload');
  });

  it('notes AU Core without treating it as a summary profile claim', () => {
    const identification = identifyVariant({
      kind: 'content',
      content: {
        resourceType: 'Bundle',
        entry: [
          {
            resource: {
              resourceType: 'Patient',
              meta: {
                profile: ['http://hl7.org.au/fhir/core/StructureDefinition/au-core-patient'],
              },
            },
          },
        ],
      },
    });
    expect(identification.variant.id).toBe('fhir-unprofiled');
    expect(said(identification)).toContain(
      'says nothing about which summary profile the bundle claims',
    );
  });

  it('reads a W3C Verifiable Credential carrying a link, and identifies the link inside it', () => {
    const identification = expectVariant(
      {
        kind: 'content',
        content: {
          '@context': ['https://www.w3.org/ns/credentials/v2'],
          type: ['VerifiableCredential'],
          credentialSubject: { url: MANIFEST_URL, key: KEY },
          proof: { type: 'DataIntegrityProof' },
        },
      },
      'vhl-vc',
    );
    expect(identification.inner?.variant.id).toBe('shl-baseline');
    // An unverifiable proof is recorded as unverified rather than dropped or
    // reported as a failure.
    expect(said(identification)).toContain('recorded and left unverified');
  });

  it('records a declared content type without letting it decide the family', () => {
    const identification = identifyVariant({
      kind: 'content',
      content: { resourceType: 'Patient' },
      declaredContentType: 'application/smart-health-card',
    });
    expect(identification.variant.id).toBe('fhir-unprofiled');
    expect(said(identification)).toContain('a manifest that mislabels a file is a real condition');
  });
});

// ---------------------------------------------------------------------------
// Health cards, which are not links
// ---------------------------------------------------------------------------

it('says a numeric health card is a card, not a link', () => {
  const identification = expectVariant('shc:/567629095243206034602924374044603122295953', 'shc');
  expect(identification.protocol).toBe('self-contained');
  expect(said(identification)).toContain('no manifest to fetch and no key to decrypt with');
});

// ---------------------------------------------------------------------------
// Base45, against the published vectors
// ---------------------------------------------------------------------------

describe('base45', () => {
  // RFC 9285, section 4.4. Both directions, because an encoder and a decoder
  // that share a mistake round-trip perfectly and agree with nobody else.
  const VECTORS: Array<[string, string]> = [
    ['AB', 'BB8'],
    ['Hello!!', '%69 VD92EX0'],
    ['base-45', 'UJCLQE7W581'],
    ['ietf!', 'QED8WEX0'],
  ];

  it('encodes every published vector', () => {
    for (const [plain, encoded] of VECTORS) {
      expect(base45Encode(utf8Encode(plain)), plain).toBe(encoded);
    }
  });

  it('decodes every published vector', () => {
    for (const [plain, encoded] of VECTORS) {
      expect(utf8Decode(base45Decode(encoded)), encoded).toBe(plain);
    }
  });

  it('round-trips arbitrary bytes, including an odd length', () => {
    for (const length of [0, 1, 2, 3, 17, 64]) {
      const data = crypto.getRandomValues(new Uint8Array(length));
      expect([...base45Decode(base45Encode(data))], `${length} bytes`).toEqual([...data]);
    }
  });

  it('names a lowercase character as the downcasing it almost always is', () => {
    const complaint = base45Complaint('bb8');
    expect(complaint).toContain('not in the Base45 alphabet');
    expect(complaint).toContain('something downcased the QR text');
  });

  it('catches a truncated string from its length alone, before decoding anything', () => {
    // Three characters carry two bytes and two carry one, so a length whose
    // remainder modulo three is one is impossible.
    expect(base45Complaint('BB8B')).toContain('This string lost its tail');
    expect(base45Complaint('BB8')).toBeUndefined();
    expect(base45Complaint('BB')).toBeUndefined();
    expect(() => base45Decode('BB8B')).toThrow(DecodeError);
  });

  it('refuses a group that decodes to more than the bytes it carries', () => {
    // ':::' is 44 + 44*45 + 44*2025 = 91124, well past two bytes.
    expect(() => base45Decode(':::')).toThrow(/not valid Base45/);
  });
});

// ---------------------------------------------------------------------------
// CBOR, only as much as COSE needs
// ---------------------------------------------------------------------------

describe('decodeCbor', () => {
  it('reads the shapes COSE and CWT are made of', () => {
    expect(decodeCbor(cborInt(1))).toBe(1);
    expect(decodeCbor(cborInt(-7))).toBe(-7);
    expect(decodeCbor(cborText('AU'))).toBe('AU');
    expect(decodeCbor(cborArray([cborInt(1), cborText('x')]))).toEqual([1, 'x']);
    const map = decodeCbor(cborMap([[cborInt(-260), cborInt(5)]]));
    expect(map instanceof Map && map.get(-260)).toBe(5);
  });

  it('names an indefinite length as a non-canonical encoder rather than a parse error', () => {
    // 0x9f is an indefinite-length array. A generic codec reports "unexpected
    // end of input", which sends the reader looking in the wrong place.
    expect(() => decodeCbor(new Uint8Array([0x9f, 0x01, 0xff]))).toThrow(/indefinite length/);
  });

  it('refuses trailing bytes, because a COSE_Sign1 is a single item', () => {
    expect(() => decodeCbor(new Uint8Array([0x01, 0x02]))).toThrow(/trailing bytes/);
  });

  it('says where it ran out, when a declared length is longer than the data', () => {
    expect(() => decodeCbor(new Uint8Array([0x43, 0x01]))).toThrow(
      /declares more bytes than it contains/,
    );
  });
});

// ---------------------------------------------------------------------------
// HCERT
// ---------------------------------------------------------------------------

describe('an HC1 certificate', () => {
  it('unwraps base45, zlib, COSE and the CWT, and reports what each layer said', () => {
    const report = decodeHcert(mintHcert({ subclaims: [[1, cborInt(1)]] }));
    expect(report?.contextId).toBe('HC1');
    expect(report?.compression).toBe('zlib');
    expect(report?.cose.tag).toBe(18);
    expect(report?.cose.algorithm).toBe('ES256 (ECDSA P-256 with SHA-256)');
    expect(report?.cose.signatureBytes).toBe(64);
    expect(report?.cwt.issuer).toBe('AU');
    expect(report?.cwt.issuerName).toBe('Australia');
    expect(report?.subclaims).toEqual([1]);
    expect(report?.problems).toEqual([]);
  });

  it('publishes the key identifier in the padded form a trust list uses, and the other one too', () => {
    const report = decodeHcert(mintHcert());
    // A base64url form of the same eight bytes never matches a GDHCN trust list
    // entry, which is why both forms are carried and labelled.
    expect(report?.cose.kidBase64).toBe('AQIDBAUGBwg=');
    expect(report?.cose.kidBase64url).toBe('AQIDBAUGBwg');
    expect(report?.cose.kidFrom).toBe('unprotected header');
  });

  it('returns nothing for a string with no context identifier, so "not an HCERT" is distinguishable', () => {
    expect(decodeHcert('shlink:/eyJ1cmwiOiJodHRwczovL3gueSJ9')).toBeUndefined();
    // An HCERT that did not decode is a report with problems in it, not absence.
    const truncated = decodeHcert('HC1:6BF');
    expect(truncated).toBeDefined();
    expect(truncated?.problems.length).toBeGreaterThan(0);
  });

  it('reads a certificate compressed the wrong way, and says a strict verifier will not', () => {
    const report = decodeHcert(mintHcert({ framing: 'raw-deflate' }));
    expect(report?.compression).toBe('raw-deflate');
    expect(report?.problems[0]).toContain('HCERT requires zlib');
    // The distinction that matters: Loupe read it, and it is still wrong.
    expect(report?.problems[0]).toContain('Loupe read it');
    expect(report?.cwt.issuer).toBe('AU');
  });

  it('reads the whole reserved context range, not only HC1', () => {
    const identification = identifyVariant(
      mintHcert({ contextId: 'HC2', subclaims: [[1, cborInt(1)]] }),
    );
    expect(identification.hcert?.contextId).toBe('HC2');
    const signal = identification.signals.find((entry) => entry.observation.includes('`HC2`'));
    // A new identifier is a compatibility warning about the reading, not a
    // refusal to read.
    expect(signal?.severity).toBe('warning');
    expect(identification.variant.id).toBe('hcert-dcc');
  });

  it('names the certificate families by subclaim', () => {
    expectVariant(mintHcert({ subclaims: [[1, cborInt(1)]] }), 'hcert-dcc');
    expectVariant(mintHcert({ subclaims: [[3, cborInt(1)]] }), 'hcert-ddcc');
    expectVariant(mintHcert({ subclaims: [[4, cborInt(1)]] }), 'hcert-ddcc');
    expectVariant(mintHcert({ subclaims: [[-6, cborInt(1)]] }), 'hcert-icvp');
    expectVariant(mintHcert({ subclaims: [[42, cborInt(1)]] }), 'hcert-unknown');
  });

  it('treats a negative subclaim as a development payload, by WHO’s own rule', () => {
    const identification = identifyVariant(mintHcert({ subclaims: [[-6, cborInt(1)]] }));
    expect(said(identification)).toContain('development payload by WHO’s own governance rule');
  });

  it('follows an shlink claim through to the link inside it', () => {
    const identification = expectVariant(
      mintHcert({ subclaims: hcertLinkClaim(encodeShlink(payload())) }),
      'hcert-shl',
    );
    expect(identification.protocol).toBe('shl-manifest-post');
    expect(identification.inner?.variant.id).toBe('shl-baseline');
    expect(said(identification)).toContain('the inner link is an ordinary SMART Health Link');
  });

  it('follows a vhlink claim to the IHE protocol instead', () => {
    const identification = expectVariant(
      {
        kind: 'raw',
        text: mintHcert({
          subclaims: hcertLinkClaim(`vhlink:/${stringToBase64url(JSON.stringify(payload()))}`),
        }),
      },
      'hcert-vhl',
    );
    expect(identification.protocol).toBe('vhl-list-search');
    expect(said(identification)).toContain(
      'needs a trust-network credential this page does not hold',
    );
  });

  it('reports a link claim with no scheme as genuinely ambiguous, and names both readings', () => {
    const identification = expectVariant(
      mintHcert({ subclaims: hcertLinkClaim('https://sharing.example.org/manifest/abc') }),
      'hcert-link-ambiguous',
    );
    expect(identification.protocol).toBe('unknown');
    // Two published specifications disagree about this slot, so both are
    // reported rather than one being silently chosen.
    expect(said(identification)).toContain(
      'the normative HCERT text titles this slot Smart Health Link'.slice(4),
    );
    expect(said(identification)).toContain('Verifiable Health Link');
  });

  it('says the signature is unchecked rather than invalid, and says why a miss is an answer', () => {
    const identification = identifyVariant(mintHcert({ subclaims: [[1, cborInt(1)]] }));
    expect(said(identification)).toContain('unchecked, not invalid');
    // Absence from a trust list is how this ecosystem expresses revocation, so
    // a lookup that finds nothing is a result, not an error.
    expect(said(identification)).toContain('a lookup that finds nothing is a real answer');
  });

  it('reports a wrong CBOR tag as a defect in the bytes, and keeps reading', () => {
    const identification = identifyVariant(mintHcert({ tag: 61, subclaims: [[1, cborInt(1)]] }));
    expect(identification.hcert?.problems[0]).toContain('The CBOR tag is 61');
    // A defect in the bytes IS an error signal. That is the contrast that makes
    // the profile rule below meaningful.
    expect(identification.signals.some((signal) => signal.severity === 'error')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The rule the whole module exists for
// ---------------------------------------------------------------------------

describe('a different profile is never reported as invalid', () => {
  /** One well-formed input per family Loupe claims to recognise. */
  const WELL_FORMED: Array<[VariantId, VariantInput]> = [
    ['shl-baseline', { kind: 'payload', payload: payload() }],
    ['shl-who-phw', { kind: 'payload', payload: payload({ type: 'shl' }) }],
    ['shl-ktc', { kind: 'payload', payload: payload({ _ktcVersion: '1' }) }],
    ['shl-extension-unknown', { kind: 'payload', payload: payload({ somethingNew: 1 }) }],
    [
      'vhl',
      {
        kind: 'payload',
        payload: payload({ type: 'vhl', url: 'https://v.example.org/fhir/List/_search' }),
      },
    ],
    [
      'vhl-vc',
      {
        kind: 'content',
        content: {
          type: ['VerifiableCredential'],
          credentialSubject: { url: MANIFEST_URL, key: KEY },
        },
      },
    ],
    ['hcert-shl', mintHcert({ subclaims: hcertLinkClaim(encodeShlink(payload())) })],
    [
      'hcert-vhl',
      mintHcert({
        subclaims: hcertLinkClaim(`vhlink:/${stringToBase64url(JSON.stringify(payload()))}`),
      }),
    ],
    [
      'hcert-link-ambiguous',
      mintHcert({ subclaims: hcertLinkClaim('https://sharing.example.org/m') }),
    ],
    ['hcert-dcc', mintHcert({ subclaims: [[1, cborInt(1)]] })],
    ['hcert-ddcc', mintHcert({ subclaims: [[3, cborInt(1)]] })],
    ['hcert-icvp', mintHcert({ subclaims: [[-6, cborInt(1)]] })],
    ['hcert-unknown', mintHcert({ subclaims: [[42, cborInt(1)]] })],
    ['shc', 'shc:/5676290952432060346029243740446031222959'],
    ['smart-api-access', { kind: 'content', content: { access_token: 'x' } }],
    [
      'fhir-ips',
      {
        kind: 'content',
        content: {
          resourceType: 'Bundle',
          meta: { profile: ['http://hl7.org/fhir/uv/ips/StructureDefinition/Bundle-uv-ips'] },
        },
      },
    ],
    ['fhir-au-ps', { kind: 'content', content: PLATYPUS_AU_PS_BUNDLE }],
    [
      'fhir-icvp',
      {
        kind: 'content',
        content: {
          resourceType: 'Bundle',
          meta: { profile: ['http://smart.who.int/icvp/StructureDefinition/DVC'] },
        },
      },
    ],
    [
      'fhir-ddcc',
      {
        kind: 'content',
        content: {
          resourceType: 'Bundle',
          meta: { profile: ['http://smart.who.int/ddcc/StructureDefinition/DDCCDocument'] },
        },
      },
    ],
    [
      'fhir-c4dic',
      {
        kind: 'content',
        content: {
          resourceType: 'Coverage',
          meta: {
            profile: ['http://hl7.org/fhir/us/insurance-card/StructureDefinition/C4DIC-Coverage'],
          },
        },
      },
    ],
    ['fhir-unprofiled', { kind: 'content', content: IG_IPS_BUNDLE }],
    ['unknown', 'not anything at all'],
  ];

  it('identifies each family it claims to recognise', () => {
    const named = new Set<VariantId>();
    for (const [id, input] of WELL_FORMED) {
      for (const found of idsIn(expectVariant(input, id))) named.add(found);
    }
    // Every entry in the catalogue is reachable from an input, so no family is
    // documented in a pane that nothing can ever land on.
    expect([...Object.keys(VARIANTS)].filter((id) => !named.has(id as VariantId))).toEqual([]);
  });

  it('raises no error or fatal signal for any of them', () => {
    for (const [id, input] of WELL_FORMED) {
      const identification = identifyVariant(input);
      const bad = identification.signals.filter(
        (signal) => signal.severity === 'error' || signal.severity === 'fatal',
      );
      expect(
        bad.map((signal) => signal.observation),
        id,
      ).toEqual([]);
      // Nor may a signal call one of them broken in prose while carrying an
      // `info` severity.
      expect(said(identification).toLowerCase(), id).not.toContain('invalid link');
    }
  });

  it('reports an unrecognised payload as a gap in the catalogue, not a broken link', () => {
    const identification = expectVariant('not anything at all', 'unknown');
    expect(identification.variant.support).toBe('unsupported');
    expect(identification.variant.missing[0]).toBeDefined();
    expect(identification.signals).toEqual([]);
  });
});
