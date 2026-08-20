/**
 * Minting: building a SMART Health Link, and its files, from scratch in the tab.
 *
 * This is what turns a viewer into a conformance test-vector generator. Two
 * distinct jobs live here and they pull in opposite directions, so they are kept
 * apart rather than parameterised into one function:
 *
 *  1. {@link mintShl} produces a link that is exactly right. It goes through the
 *     same {@link encryptDirA256Gcm} the rest of the tool uses, so a bug in the
 *     encrypter shows up in both directions rather than cancelling itself out.
 *  2. {@link BROKEN_PRESETS} produces links that are exactly wrong, each in one
 *     named way, and each declaring what a receiver ought to do about it. Those
 *     cannot go through the conformant encrypter, because it normalises away the
 *     very deviations they exist to carry, so they use {@link forgeJwe}, which
 *     writes whatever header, IV length and encrypted-key part it is handed.
 *
 * The presets are the interesting half. A catalogue of broken links whose claims
 * nobody checks is worse than no catalogue: it teaches wrong things with
 * confidence. So every preset carries an {@link PresetExpectation} naming the
 * rule ids Loupe must raise and the outcome the run must reach, and
 * `mint.test.ts` runs the real pipeline over every one of them against an
 * offline transport. When a preset says Loupe raises nothing, that is recorded
 * as a gap with a reason rather than quietly dressed up as a check.
 */
import { zlibSync } from 'fflate';
import { base64urlToBytes, bytesToBase64url, toArrayBuffer, utf8Encode } from './bytes';
import { deflateRawBytes } from './compress';
import { encryptDirA256Gcm, octThumbprint, type JweHeader } from './jose';
import type { TransportResponse } from './net/transport';
import { encodeShlink, type ShlPayload } from './shlink';
import type { RunOutcome } from './trace';

// ---------------------------------------------------------------------------
// Content types and manifest shapes
// ---------------------------------------------------------------------------

export const SHL_CONTENT_TYPES = {
  fhir: 'application/fhir+json;fhirVersion=4.0.1',
  healthCard: 'application/smart-health-card',
  apiAccess: 'application/smart-api-access',
} as const;

export interface MintedManifestFile {
  contentType: string;
  embedded?: string;
  location?: string;
  lastUpdated?: string;
}

export interface MintedManifest {
  status: 'finalized' | 'can-change' | 'no-longer-valid';
  files: MintedManifestFile[];
}

/**
 * Canned wire responses, ready to hand to `OfflineTransport`.
 *
 * Keyed by the pipeline's request `purpose` rather than by URL, because the
 * direct-file (U flag) request appends `?recipient=...` to the link's own url,
 * so a URL key would silently miss and the preset would fail for the wrong
 * reason.
 */
export type CannedResponses = Record<string, TransportResponse | string>;

// ---------------------------------------------------------------------------
// Minting a link that is right
// ---------------------------------------------------------------------------

export interface MintOptions {
  /** The plaintext the encrypted file carries. Serialised as minified JSON. */
  content: unknown;
  /** Goes in the manifest entry, and in the JWE `cty`. */
  contentType: string;
  /** The manifest URL, or with the U flag, the file URL. */
  url: string;
  label?: string;
  /** Epoch SECONDS. The millisecond mistake is a preset, not an accident here. */
  exp?: number;
  /** Concatenated flag characters, alphabetical, for example "LU". */
  flags?: string;
  /** Adds `zip: "DEF"` and raw DEFLATEs the plaintext. */
  compress?: boolean;
  /** A viewer prefix ending in "#", which is where the payload belongs. */
  viewerPrefix?: string;
  /** Reuse an existing 43-character base64url key instead of generating one. */
  key?: string;
  /**
   * Emit the `cty` header. On by default because the specification's prose asks
   * for it, and off-able because every example in the IG omits it, so a sender
   * chasing real-world shapes wants to reproduce that.
   */
  contentTypeHeader?: boolean;
}

export interface MintResult {
  /** `shlink:/...`, the bare URI form a QR carries. */
  shlink: string;
  /** The viewer-prefixed form, present when a prefix was supplied. */
  viewerLink?: string;
  payload: ShlPayload;
  /** 43 characters of base64url: the content encryption key, in the clear. */
  key: string;
  /** RFC 7638 thumbprint of the key as an `oct` JWK, which is what `kid` is. */
  kid: string;
  file: { contentType: string; jwe: string };
  /** What a sharing server would serve. Absent for a U link, which has none. */
  manifest?: MintedManifest;
  plaintextBytes: number;
  ciphertextBytes: number;
  compressed: boolean;
  /** So a minted link opens in Loupe against `OfflineTransport`, with no server. */
  responses: CannedResponses;
}

/** 32 fresh bytes, base64url, which is exactly what the `key` member is. */
export function generateLinkKey(): string {
  return bytesToBase64url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function mintShl(options: MintOptions): Promise<MintResult> {
  const key = options.key ?? generateLinkKey();
  const kid = await octThumbprint(key);
  const json = JSON.stringify(options.content);
  const plaintext = utf8Encode(json);
  const compressed = options.compress === true;
  const body = compressed ? deflateRawBytes(plaintext) : plaintext;

  const header: JweHeader = {
    alg: 'dir',
    enc: 'A256GCM',
    kid,
    ...(compressed ? { zip: 'DEF' } : {}),
    ...(options.contentTypeHeader === false ? {} : { cty: options.contentType }),
  };
  const jwe = await encryptDirA256Gcm(body, keyBytes(key), header);

  const flags = options.flags ?? '';
  const payload: ShlPayload = {
    url: options.url,
    key,
    ...(options.exp === undefined ? {} : { exp: options.exp }),
    ...(flags === '' ? {} : { flag: flags }),
    ...(options.label === undefined ? {} : { label: options.label }),
  };
  const shlink = encodeShlink(payload);

  const direct = flags.includes('U');
  const manifest: MintedManifest = {
    status: 'finalized',
    files: [{ contentType: options.contentType, embedded: jwe }],
  };

  return {
    shlink,
    ...(options.viewerPrefix === undefined
      ? {}
      : { viewerLink: `${options.viewerPrefix}${shlink}` }),
    payload,
    key,
    kid,
    file: { contentType: options.contentType, jwe },
    ...(direct ? {} : { manifest }),
    plaintextBytes: plaintext.byteLength,
    ciphertextBytes: jwe.length,
    compressed,
    responses: direct ? { 'direct-file': jwe } : { manifest: JSON.stringify(manifest, null, 2) },
  };
}

// ---------------------------------------------------------------------------
// Forging a JWE that is wrong on purpose
// ---------------------------------------------------------------------------

export interface ForgeJweOptions {
  plaintext: Uint8Array;
  key: Uint8Array;
  /**
   * Written into the protected header verbatim, in the order given. Nothing is
   * defaulted or corrected, which is the whole point: `encryptDirA256Gcm`
   * forces `alg` and `enc` and always emits a 12-byte IV and an empty encrypted
   * key, so it cannot express any of the deviations a test vector needs.
   */
  header: JweHeader;
  /** Defaults to the 12 the specification requires. 16 is the python-jose bug. */
  ivBytes?: number;
  /** Non-empty is a hard violation under `alg: dir`, and a real sender bug. */
  encryptedKeyB64?: string;
}

export async function forgeJwe(options: ForgeJweOptions): Promise<string> {
  const protectedHeaderB64 = bytesToBase64url(utf8Encode(JSON.stringify(options.header)));
  const iv = crypto.getRandomValues(new Uint8Array(options.ivBytes ?? 12));
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(options.key),
    'AES-GCM',
    false,
    ['encrypt'],
  );
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: toArrayBuffer(iv),
        // Still the real AAD, so the tag verifies for a receiver that gets past
        // the header check. A vector that fails for two reasons at once tells
        // the person reading the trace nothing about either.
        additionalData: toArrayBuffer(utf8Encode(protectedHeaderB64)),
        tagLength: 128,
      },
      cryptoKey,
      toArrayBuffer(options.plaintext),
    ),
  );
  return [
    protectedHeaderB64,
    options.encryptedKeyB64 ?? '',
    bytesToBase64url(iv),
    bytesToBase64url(sealed.slice(0, sealed.byteLength - 16)),
    bytesToBase64url(sealed.slice(sealed.byteLength - 16)),
  ].join('.');
}

// ---------------------------------------------------------------------------
// Sample payloads
// ---------------------------------------------------------------------------

export interface SamplePayload {
  id: string;
  label: string;
  contentType: string;
  /** One line, shown beside the selector. */
  blurb: string;
  content: unknown;
}

/**
 * Small, synthetic, and deliberately code-light.
 *
 * Every `Coding` here carries either the code system's own display or no
 * display at all, and the wording a human reads sits in `section.title`. A
 * `display` a code system does not publish is rejected by any terminology-aware
 * validator, so a teaching fixture that invents one teaches the mistake.
 */
export const SAMPLE_PAYLOADS: SamplePayload[] = [
  {
    id: 'ips-tiny',
    label: 'Patient summary document (tiny)',
    contentType: SHL_CONTENT_TYPES.fhir,
    blurb: 'A document Bundle whose first entry is a Composition, which is the shape a summary takes.',
    content: {
      resourceType: 'Bundle',
      type: 'document',
      timestamp: '2026-08-20T02:15:00Z',
      entry: [
        {
          fullUrl: 'urn:uuid:0f8f6a1e-5b0e-4a3a-9a41-8a2d4e6c1b01',
          resource: {
            resourceType: 'Composition',
            status: 'final',
            type: {
              coding: [
                {
                  system: 'http://loinc.org',
                  code: '60591-5',
                  display: 'Patient summary Document',
                },
              ],
            },
            date: '2026-08-20T02:15:00Z',
            title: 'Patient Summary',
            subject: { reference: 'urn:uuid:0f8f6a1e-5b0e-4a3a-9a41-8a2d4e6c1b02' },
            section: [
              {
                title: 'Allergies and Adverse Reactions',
                code: {
                  coding: [
                    {
                      system: 'http://loinc.org',
                      code: '48765-2',
                      display: 'Allergies and adverse reactions Document',
                    },
                  ],
                },
                entry: [{ reference: 'urn:uuid:0f8f6a1e-5b0e-4a3a-9a41-8a2d4e6c1b03' }],
              },
            ],
          },
        },
        {
          fullUrl: 'urn:uuid:0f8f6a1e-5b0e-4a3a-9a41-8a2d4e6c1b02',
          resource: {
            resourceType: 'Patient',
            name: [{ family: 'Argonaut', given: ['Jessica'] }],
            gender: 'female',
            birthDate: '1985-04-12',
          },
        },
        {
          fullUrl: 'urn:uuid:0f8f6a1e-5b0e-4a3a-9a41-8a2d4e6c1b03',
          resource: {
            resourceType: 'AllergyIntolerance',
            clinicalStatus: {
              coding: [
                {
                  system: 'http://terminology.hl7.org/CodeSystem/allergyintolerance-clinical',
                  code: 'active',
                },
              ],
            },
            code: {
              coding: [
                { system: 'http://snomed.info/sct', code: '716186003', display: 'No known allergy' },
              ],
            },
            patient: { reference: 'urn:uuid:0f8f6a1e-5b0e-4a3a-9a41-8a2d4e6c1b02' },
          },
        },
      ],
    },
  },
  {
    id: 'patient-only',
    label: 'One Patient resource',
    contentType: SHL_CONTENT_TYPES.fhir,
    blurb: 'The smallest useful payload: a single resource rather than a Bundle. Legal, and rarely tested.',
    content: {
      resourceType: 'Patient',
      name: [{ family: 'Argonaut', given: ['Jessica'] }],
      gender: 'female',
      birthDate: '1985-04-12',
    },
  },
  {
    id: 'api-access',
    label: 'SMART API access grant (synthetic)',
    contentType: SHL_CONTENT_TYPES.apiAccess,
    blurb:
      'The third defined content type. Not data: a bearer token in the clear, pointing at a FHIR server. The token below is invented and grants nothing.',
    content: {
      aud: 'https://fhir.example.org/r4',
      access_token: 'not-a-real-token-0000000000000000',
      token_type: 'Bearer',
      expires_in: 3600,
      scope: 'patient/*.rs',
      query: ['Patient/$summary'],
    },
  },
];

// ---------------------------------------------------------------------------
// The broken-link catalogue
// ---------------------------------------------------------------------------

/**
 * What Loupe must do with a preset, checked by `mint.test.ts` against the real
 * pipeline.
 *
 * `ruleIds` is the contract. An empty `ruleIds` with a `gap` is the honest
 * record of a deviation Loupe reports in a table row but raises no finding for:
 * sometimes because ignoring it is what the specification requires, sometimes
 * because Loupe has no rule for it yet, and the `gap` text says which.
 */
export interface PresetExpectation {
  ruleIds: string[];
  /** Which file the check lives in, for a reader who wants to go and read it. */
  source: 'diagnose/rules.ts' | 'shlink.ts' | 'pipeline.ts' | 'none';
  outcome: RunOutcome;
  /** Payload members the member table must mark warn or fail. */
  payloadMembers?: string[];
  gap?: string;
}

export interface BrokenArtefacts {
  shlink: string;
  payload: ShlPayload;
  key: string;
  /** Present when the preset's fault is in a file rather than in the link. */
  jwe?: string;
  /** Present when the preset's fault is in, or reachable through, a manifest. */
  manifest?: unknown;
  /** Hand this to `OfflineTransport` to reproduce the preset with no server. */
  responses: CannedResponses;
  /** Supply this to the pipeline when the preset needs one to reach its fault. */
  passcode?: string;
}

export interface BrokenPreset {
  id: string;
  /** Short name, sentence case, no trailing full stop. */
  title: string;
  /** One line: what is wrong with it. */
  wrong: string;
  /** What a conformant receiver ought to do about it. */
  receiverShould: string;
  expect: PresetExpectation;
  build(options?: { now?: number }): Promise<BrokenArtefacts>;
}

/** A host that is public, parseable and serves nothing, which is the point. */
const HOST = 'https://shl.example.org';
const MANIFEST_URL = `${HOST}/manifest/BOd6Y1sMxV0BThMOEmZjPUlQBHRPFrnv7BqDCM4ynqE`;

const SAMPLE = SAMPLE_PAYLOADS[1]?.content ?? { resourceType: 'Patient' };
const SAMPLE_JSON = JSON.stringify(SAMPLE);

/**
 * Deliberately strict. Every preset that carries a deliberately broken key is
 * one whose run stops at the payload check, so nothing here ever encrypts with
 * one; a lenient coercion would hide a mistake in a new preset instead.
 */
function keyBytes(key: string): Uint8Array {
  const bytes = base64urlToBytes(key);
  if (bytes.byteLength !== 32) {
    throw new Error(`A link key is 32 bytes; this one decodes to ${bytes.byteLength}.`);
  }
  return bytes;
}

function canned(status: number, body: string, headers: Record<string, string> = {}): TransportResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `${status} (supplied by the sandbox)`,
    headers: { 'content-type': 'application/json', ...headers },
    body,
    bodyBytes: utf8Encode(body).byteLength,
    responseType: 'basic',
    redirected: false,
    finalUrl: MANIFEST_URL,
    durationMs: 0,
  };
}

/** A payload plus the shlink that carries it, for a preset whose fault is in the link. */
function link(payload: ShlPayload): { shlink: string; payload: ShlPayload } {
  return { shlink: encodeShlink(payload), payload };
}

/** One embedded file, conformant, so a preset's own fault is the only fault. */
async function goodManifest(key: string, contentType = SHL_CONTENT_TYPES.fhir): Promise<MintedManifest> {
  const kid = await octThumbprint(key);
  const jwe = await forgeJwe({
    plaintext: utf8Encode(SAMPLE_JSON),
    key: keyBytes(key),
    header: { alg: 'dir', enc: 'A256GCM', kid, cty: contentType },
  });
  return { status: 'finalized', files: [{ contentType, embedded: jwe }] };
}

const DEMO_KEY = 'rxTgYlOaKJPFtcEd0qcceN8wEU4p94SqAwIWQe6uX7Q';

export const BROKEN_PRESETS: BrokenPreset[] = [
  // -------------------------------------------------------------------------
  // The link itself
  // -------------------------------------------------------------------------
  {
    id: 'exp-past',
    title: 'Expired link',
    wrong: 'exp is a week in the past.',
    receiverShould:
      'Say the link expired, and how long ago, from the link alone. It must not spend a request to find out, and it must not present a 404 later as if the cause were unknown.',
    expect: {
      ruleIds: ['SHL-EXP-PAST'],
      source: 'diagnose/rules.ts',
      outcome: 'blocked',
      payloadMembers: [],
    },
    build: async ({ now = Date.now() } = {}) => {
      const key = generateLinkKey();
      return {
        ...link({
          url: MANIFEST_URL,
          key,
          exp: Math.floor(now / 1000) - 7 * 86_400,
          flag: 'L',
          label: 'Expired a week ago',
        }),
        key,
        responses: {},
      };
    },
  },
  {
    id: 'exp-milliseconds',
    title: 'Expiry in milliseconds',
    wrong: 'exp carries Date.now() rather than Date.now()/1000, so it reads as the year 57000.',
    receiverShould:
      'Recognise the magnitude, name the mistake, and carry on rather than refusing: read as seconds the link has simply not expired.',
    expect: {
      ruleIds: ['SHL-EXP-MILLISECONDS'],
      source: 'diagnose/rules.ts',
      outcome: 'opened',
      payloadMembers: ['exp'],
    },
    build: async ({ now = Date.now() } = {}) => {
      const key = generateLinkKey();
      const manifest = await goodManifest(key);
      return {
        ...link({ url: MANIFEST_URL, key, exp: now, label: 'Expiry in milliseconds' }),
        key,
        manifest,
        responses: { manifest: JSON.stringify(manifest) },
      };
    },
  },
  {
    id: 'url-localhost',
    title: 'Manifest URL on localhost',
    wrong: 'The url is https://localhost:5173, which names whichever machine is doing the asking.',
    receiverShould:
      'Say so in one sentence, before any request: this link can only ever open on the machine that minted it. This is the failure the whole tool exists for.',
    expect: {
      ruleIds: ['SHL-URL-LOOPBACK'],
      source: 'diagnose/rules.ts',
      outcome: 'blocked',
    },
    build: async () => {
      const key = generateLinkKey();
      return {
        ...link({
          url: 'https://localhost:5173/api/shl-manifest?bid=4836470',
          key,
          flag: 'L',
          label: 'Works on my machine',
        }),
        key,
        responses: {},
      };
    },
  },
  {
    id: 'url-http',
    title: 'Manifest URL over plain http',
    wrong: 'The url scheme is http, so the manifest and every file it names cross the network readable.',
    receiverShould:
      'Refuse. Note that Loupe stops at the payload check (SHL-PAYLOAD-INVALID) rather than reaching its own http rule, because shlink.ts treats a non-https url as making the payload unusable, so the URL rules never run.',
    expect: {
      ruleIds: ['SHL-PAYLOAD-INVALID'],
      source: 'shlink.ts',
      outcome: 'blocked',
      payloadMembers: ['url'],
    },
    build: async () => {
      const key = generateLinkKey();
      return {
        ...link({
          url: 'http://shl.example.org/manifest/BOd6Y1sMxV0BThMOEmZjPUlQBHRPFrnv',
          key,
          label: 'Plain http manifest',
        }),
        key,
        responses: {},
      };
    },
  },
  {
    id: 'url-over-128',
    title: 'Manifest URL over 128 characters',
    wrong: 'The url is 139 characters; the specification caps it at 128.',
    receiverShould:
      'Report the length against the cap. A receiver should not refuse the link over it, since the server will serve it happily.',
    expect: {
      ruleIds: [],
      source: 'none',
      outcome: 'opened',
      gap: 'Loupe prints the length against the 128-character cap in the static analysis step but raises no finding for it, so nothing names the sender. That is a missing rule, not a design choice.',
    },
    build: async () => {
      const key = generateLinkKey();
      const path = 'BOd6Y1sMxV0BThMOEmZjPUlQBHRPFrnv7BqDCM4ynqE'.repeat(3).slice(0, 113);
      const url = `${HOST}/m/${path}`;
      const manifest = await goodManifest(key);
      return {
        ...link({ url, key, label: 'Over-long manifest URL' }),
        key,
        manifest,
        responses: { manifest: JSON.stringify(manifest) },
      };
    },
  },
  {
    id: 'label-over-80',
    title: 'Label over 80 characters',
    wrong: 'The label is 113 characters; the specification caps it at 80.',
    receiverShould:
      'Show the label, truncated for display if it must be, and note the length. Refusing the link over a long label helps nobody.',
    expect: {
      ruleIds: [],
      source: 'none',
      outcome: 'opened',
      payloadMembers: ['label'],
      gap: 'The member table marks label as a warning with the character count, and no finding is raised, so nothing in the report names the sender.',
    },
    build: async () => {
      const key = generateLinkKey();
      const manifest = await goodManifest(key);
      return {
        ...link({
          url: MANIFEST_URL,
          key,
          label:
            'A label long enough to break a QR code, a phone notification and a receiving wallet all at once, well past eighty',
        }),
        key,
        manifest,
        responses: { manifest: JSON.stringify(manifest) },
      };
    },
  },

  // -------------------------------------------------------------------------
  // The key
  // -------------------------------------------------------------------------
  {
    id: 'key-16-bytes',
    title: 'Key of 16 bytes',
    wrong: 'The key decodes to 16 bytes; A256GCM needs exactly 32.',
    receiverShould:
      'Say nothing in this link can be decrypted, and say it from the key length alone rather than after an opaque decryption failure.',
    expect: {
      ruleIds: ['SHL-PAYLOAD-INVALID'],
      source: 'shlink.ts',
      outcome: 'blocked',
      payloadMembers: ['key'],
    },
    build: async () => {
      const key = bytesToBase64url(crypto.getRandomValues(new Uint8Array(16)));
      return {
        ...link({ url: MANIFEST_URL, key, label: 'Half-length key' }),
        key,
        responses: {},
      };
    },
  },
  {
    id: 'key-standard-base64',
    title: 'Key in standard base64',
    wrong: 'The key was encoded with the standard base64 alphabet, so it carries "+", "/" and "=".',
    receiverShould:
      'Name the alphabet as the fault. This is the single most common hand-rolled encoder bug, and "invalid link" hides the one-line fix.',
    expect: {
      ruleIds: ['SHL-PAYLOAD-INVALID'],
      source: 'shlink.ts',
      outcome: 'blocked',
      payloadMembers: ['key'],
    },
    build: async () => {
      // The first three bytes are fixed so the standard encoding is guaranteed
      // to contain both "+" and "/": a random key often contains neither, and a
      // vector that only sometimes demonstrates its own fault is not a vector.
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      bytes[0] = 0xfb;
      bytes[1] = 0xff;
      bytes[2] = 0xff;
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      const key = btoa(binary);
      return {
        ...link({ url: MANIFEST_URL, key, label: 'Standard base64 key' }),
        key,
        responses: {},
      };
    },
  },
  {
    id: 'key-mismatch',
    title: 'File encrypted with a different key',
    wrong: "The JWE's kid is the thumbprint of another key, so the link's key cannot open it.",
    receiverShould:
      'Prove the mismatch from the kid before attempting decryption, and say so, rather than reporting an authentication-tag failure that reads as corrupted data.',
    expect: {
      ruleIds: ['SHL-KEY-MISMATCH'],
      source: 'pipeline.ts',
      outcome: 'failed',
    },
    build: async () => {
      const key = generateLinkKey();
      const otherKey = generateLinkKey();
      const jwe = await forgeJwe({
        plaintext: utf8Encode(SAMPLE_JSON),
        key: keyBytes(otherKey),
        header: {
          alg: 'dir',
          enc: 'A256GCM',
          kid: await octThumbprint(otherKey),
          cty: SHL_CONTENT_TYPES.fhir,
        },
      });
      const manifest: MintedManifest = {
        status: 'finalized',
        files: [{ contentType: SHL_CONTENT_TYPES.fhir, embedded: jwe }],
      };
      return {
        ...link({ url: MANIFEST_URL, key, label: 'Re-minted against a rotated key' }),
        key,
        jwe,
        manifest,
        responses: { manifest: JSON.stringify(manifest) },
      };
    },
  },

  // -------------------------------------------------------------------------
  // Flags
  // -------------------------------------------------------------------------
  {
    id: 'flag-u-and-p',
    title: 'U and P together',
    wrong: 'The flag is "PU". A direct GET has no manifest request, so there is nowhere to put a passcode.',
    receiverShould:
      'Say the two flags contradict each other and name which one it is going to honour, rather than sending a passcode into a query string.',
    expect: {
      ruleIds: ['SHL-FLAG-U-AND-P'],
      source: 'diagnose/rules.ts',
      outcome: 'opened',
      payloadMembers: ['flag'],
    },
    build: async () => {
      const key = generateLinkKey();
      const jwe = await forgeJwe({
        plaintext: utf8Encode(SAMPLE_JSON),
        key: keyBytes(key),
        header: {
          alg: 'dir',
          enc: 'A256GCM',
          kid: await octThumbprint(key),
          cty: SHL_CONTENT_TYPES.fhir,
        },
      });
      return {
        ...link({ url: `${HOST}/file/BOd6Y1sMxV0BThMOEmZjPUlQ`, key, flag: 'PU', label: 'PU' }),
        key,
        jwe,
        responses: { 'direct-file': jwe },
      };
    },
  },
  {
    id: 'flag-unknown',
    title: 'Unrecognised flag character',
    wrong: 'The flag is "LX", and no "X" flag is defined.',
    receiverShould:
      'Ignore it and carry on. The specification is explicit: a receiver "SHALL ignore flag values they don\'t recognize".',
    expect: {
      ruleIds: [],
      source: 'none',
      outcome: 'opened',
      payloadMembers: ['flag'],
      gap: 'No finding, and correctly so: the specification requires a receiver to ignore an unknown flag. It appears as a warning row in the member table, which is the right amount of noise.',
    },
    build: async () => {
      const key = generateLinkKey();
      const manifest = await goodManifest(key);
      return {
        ...link({ url: MANIFEST_URL, key, flag: 'LX', label: 'Unknown flag' }),
        key,
        manifest,
        responses: { manifest: JSON.stringify(manifest) },
      };
    },
  },

  // -------------------------------------------------------------------------
  // The manifest
  // -------------------------------------------------------------------------
  {
    id: 'manifest-files-empty',
    title: 'Manifest with an empty files array',
    wrong: 'The manifest is valid JSON, answers 200, and contains nothing.',
    receiverShould:
      'Say the manifest is empty rather than showing a blank screen, and note the cardinality disagreement: the prose table says 0..*, the logical model says 1..*.',
    expect: {
      ruleIds: ['SHL-MANIFEST-EMPTY'],
      source: 'pipeline.ts',
      outcome: 'failed',
    },
    build: async () => {
      const key = generateLinkKey();
      const manifest = { status: 'finalized', files: [] };
      return {
        ...link({ url: MANIFEST_URL, key, label: 'Share created before its content' }),
        key,
        manifest,
        responses: { manifest: JSON.stringify(manifest) },
      };
    },
  },
  {
    id: 'manifest-file-neither',
    title: 'File entry with neither embedded nor location',
    wrong: 'files[0] declares a contentType and gives no content and no URL, so there is nothing to fetch.',
    receiverShould:
      'Account for the entry explicitly as unusable. Silently skipping it turns a server bug into an apparently empty share.',
    expect: {
      ruleIds: [],
      source: 'none',
      outcome: 'failed',
      gap: 'The manifest table marks the row as a failure with the reason, and the file carries a failure, but no finding is raised, so no audience is named. A rule belongs here.',
    },
    build: async () => {
      const key = generateLinkKey();
      const manifest = { status: 'finalized', files: [{ contentType: SHL_CONTENT_TYPES.fhir }] };
      return {
        ...link({ url: MANIFEST_URL, key, label: 'Entry with no content' }),
        key,
        manifest,
        responses: { manifest: JSON.stringify(manifest) },
      };
    },
  },
  {
    id: 'manifest-content-type-lies',
    title: 'Manifest declares a health card and carries FHIR',
    wrong: 'files[0].contentType says application/smart-health-card; the plaintext is a FHIR resource.',
    receiverShould:
      'Go by the content, since that is what a renderer has to work with, and report the disagreement. A receiver that filters on the declared type skips this file entirely.',
    expect: {
      ruleIds: ['SHL-CONTENT-TYPE-MISMATCH'],
      source: 'pipeline.ts',
      outcome: 'opened',
    },
    build: async () => {
      const key = generateLinkKey();
      const jwe = await forgeJwe({
        plaintext: utf8Encode(SAMPLE_JSON),
        key: keyBytes(key),
        header: { alg: 'dir', enc: 'A256GCM', kid: await octThumbprint(key) },
      });
      const manifest: MintedManifest = {
        status: 'finalized',
        files: [{ contentType: SHL_CONTENT_TYPES.healthCard, embedded: jwe }],
      };
      return {
        ...link({ url: MANIFEST_URL, key, label: 'Mislabelled file' }),
        key,
        jwe,
        manifest,
        responses: { manifest: JSON.stringify(manifest) },
      };
    },
  },
  {
    id: 'passcode-401-no-remaining',
    title: '401 with no remainingAttempts',
    wrong: 'The passcode is rejected with a 401 whose body carries no remainingAttempts member.',
    receiverShould:
      'Report the rejection AND the missing member, because without it a receiver cannot warn before the attempt that permanently disables the link.',
    expect: {
      ruleIds: ['SHL-PASSCODE-WRONG', 'SHL-PASSCODE-NO-REMAINING'],
      source: 'pipeline.ts',
      outcome: 'failed',
    },
    build: async () => {
      const key = generateLinkKey();
      return {
        ...link({ url: MANIFEST_URL, key, flag: 'P', label: 'Passcode protected' }),
        key,
        responses: { manifest: canned(401, JSON.stringify({ error: 'invalid_passcode' })) },
        passcode: 'wrong-on-purpose',
      };
    },
  },

  // -------------------------------------------------------------------------
  // The encrypted file
  // -------------------------------------------------------------------------
  {
    id: 'jwe-iv-16-bytes',
    title: 'JWE with a 16-byte IV',
    wrong: 'The initialisation vector is 16 bytes. AES-GCM uses 12, and python-jose historically emitted 16.',
    receiverShould:
      'Refuse, and name the byte count and the library signature. The file round-trips in the tool that wrote it and nowhere else, which is why the sender believes it is fine.',
    expect: {
      ruleIds: ['SHL-DECRYPT-FAILED'],
      source: 'pipeline.ts',
      outcome: 'failed',
    },
    build: async () => {
      const key = generateLinkKey();
      const jwe = await forgeJwe({
        plaintext: utf8Encode(SAMPLE_JSON),
        key: keyBytes(key),
        header: { alg: 'dir', enc: 'A256GCM', kid: await octThumbprint(key) },
        ivBytes: 16,
      });
      const manifest: MintedManifest = {
        status: 'finalized',
        files: [{ contentType: SHL_CONTENT_TYPES.fhir, embedded: jwe }],
      };
      return {
        ...link({ url: MANIFEST_URL, key, label: 'python-jose IV' }),
        key,
        jwe,
        manifest,
        responses: { manifest: JSON.stringify(manifest) },
      };
    },
  },
  {
    id: 'jwe-alg-rsa-oaep',
    title: 'JWE with alg RSA-OAEP',
    wrong: 'The protected header claims key wrapping, so the link key is not the content encryption key.',
    receiverShould:
      "Refuse on the header alone and say the link's key is not the content key. SMART Health Links pin alg to dir; there is no negotiation to get wrong.",
    expect: {
      ruleIds: ['SHL-DECRYPT-FAILED'],
      source: 'pipeline.ts',
      outcome: 'failed',
    },
    build: async () => {
      const key = generateLinkKey();
      const jwe = await forgeJwe({
        plaintext: utf8Encode(SAMPLE_JSON),
        key: keyBytes(key),
        header: { alg: 'RSA-OAEP', enc: 'A256GCM', kid: await octThumbprint(key) },
      });
      const manifest: MintedManifest = {
        status: 'finalized',
        files: [{ contentType: SHL_CONTENT_TYPES.fhir, embedded: jwe }],
      };
      return {
        ...link({ url: MANIFEST_URL, key, label: 'Key wrapping claimed' }),
        key,
        jwe,
        manifest,
        responses: { manifest: JSON.stringify(manifest) },
      };
    },
  },
  {
    id: 'jwe-encrypted-key-present',
    title: 'JWE with a non-empty encrypted key under alg dir',
    wrong: 'The second part of the compact serialisation carries bytes, which alg dir forbids.',
    receiverShould:
      "Refuse and say the sender's library did not really use direct encryption, rather than reporting a decryption failure that points at the key in the link.",
    expect: {
      ruleIds: ['SHL-DECRYPT-FAILED'],
      source: 'pipeline.ts',
      outcome: 'failed',
    },
    build: async () => {
      const key = generateLinkKey();
      const jwe = await forgeJwe({
        plaintext: utf8Encode(SAMPLE_JSON),
        key: keyBytes(key),
        header: { alg: 'dir', enc: 'A256GCM', kid: await octThumbprint(key) },
        encryptedKeyB64: bytesToBase64url(crypto.getRandomValues(new Uint8Array(32))),
      });
      const manifest: MintedManifest = {
        status: 'finalized',
        files: [{ contentType: SHL_CONTENT_TYPES.fhir, embedded: jwe }],
      };
      return {
        ...link({ url: MANIFEST_URL, key, label: 'Encrypted CEK under dir' }),
        key,
        jwe,
        manifest,
        responses: { manifest: JSON.stringify(manifest) },
      };
    },
  },
  {
    id: 'zip-zlib-framed',
    title: 'zip DEF carrying zlib-framed DEFLATE',
    wrong: 'The header says zip DEF, which means raw DEFLATE, and the plaintext carries a zlib header.',
    receiverShould:
      'Name the framing. A strict inflater fails here in a way indistinguishable from a wrong key, which sends the reader looking at their encryption.',
    expect: {
      ruleIds: ['SHL-ZIP-FRAMING'],
      source: 'pipeline.ts',
      outcome: 'opened',
    },
    build: async () => {
      const key = generateLinkKey();
      // fflate's zlibSync rather than the repo's deflateRawBytes, which by
      // design cannot produce the wrong framing this vector exists to carry.
      const jwe = await forgeJwe({
        plaintext: zlibSync(utf8Encode(SAMPLE_JSON), { level: 9 }),
        key: keyBytes(key),
        header: { alg: 'dir', enc: 'A256GCM', zip: 'DEF', kid: await octThumbprint(key) },
      });
      const manifest: MintedManifest = {
        status: 'finalized',
        files: [{ contentType: SHL_CONTENT_TYPES.fhir, embedded: jwe }],
      };
      return {
        ...link({ url: MANIFEST_URL, key, label: 'zlib where raw DEFLATE is required' }),
        key,
        jwe,
        manifest,
        responses: { manifest: JSON.stringify(manifest) },
      };
    },
  },
];

/**
 * The specification's own demo key, which every tutorial and both IG examples
 * reuse. Content encrypted with it is public by construction, so a viewer that
 * recognises it can say so instead of implying confidentiality it does not have.
 */
export const WELL_KNOWN_DEMO_KEY = DEMO_KEY;

export function isWellKnownDemoKey(key: string): boolean {
  return key === DEMO_KEY;
}

export function presetById(id: string): BrokenPreset | undefined {
  return BROKEN_PRESETS.find((preset) => preset.id === id);
}
