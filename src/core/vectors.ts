/**
 * Run somebody else's conformance suite against this engine.
 *
 * The KTC specification publishes 23 machine-readable test vectors: an input (a
 * SHLink, bare and viewer-prefixed), the outcome a conformant receiver should
 * reach, and a `responses` map of every HTTP response the run needs. That map is
 * the interesting part, because it means the whole suite can be executed with the
 * cable out, through the transport seam this pipeline already has.
 *
 * Why bother, when the suite is not ours and the profile is not ours either:
 *
 * IT IS THE ONLY EXTERNAL CHECK AVAILABLE. Every other test in this project was
 * written by the same hand as the code, so a shared misunderstanding is invisible
 * to all of them at once. A suite written by somebody else, with expected
 * outcomes decided before this tool existed, is the one thing that can catch
 * that. (The live-IG test does the same job for the crypto, against real bytes.)
 *
 * DISAGREEMENT IS THE OUTPUT, not failure. Eleven of the 23 vectors expect a
 * REJECTION, and for four of those the correct behaviour for a base-specification
 * viewer is to open the link: `ktc-d6-no-exp` and `ktc-d7-flag-p` are conformant
 * SMART Health Links that are not KTC links. The suite's own description of d6
 * says exactly that. So a run has three verdicts rather than two, and the middle
 * one, `agree-via-profile`, is where SHLoupe and a KTC validator reach the same
 * conclusion by different routes: it opens the link and reports the profile
 * requirement as unmet. Collapsing that into a pass or a fail would throw away
 * the distinction this whole tool is built on.
 *
 * NOTHING IS FETCHED WITHOUT BEING ASKED. The suite lives on a third party's
 * site, so loading it is an explicit action, the URLs are shown before the button
 * is pressed, and the transport used for the runs themselves serves the vectors'
 * own canned responses rather than reaching out again.
 */
import { openShl } from './pipeline';
import { BrowserTransport } from './net/browser';
import { HTTPS_VIEWER } from './diagnose/context';
import { NetworkFailure } from './net/transport';
import type { Transport, TransportRequest, TransportResponse } from './net/transport';
import type { RunOutcome, TraceRun } from './trace';

/** Where the suite lives. Its own pages call this the canonical location. */
export const SUITE_BASE = 'https://ktc-spec.github.io/vectors';
export const SUITE_INDEX = `${SUITE_BASE}/index.json`;
export const SUITE_PAGE = 'https://ktc-spec.github.io/test-vectors';

// ---------------------------------------------------------------------------
// The published shape, parsed defensively
// ---------------------------------------------------------------------------

export type VectorTier = 'decode' | 'retrieve' | 'decrypt' | 'bundle';

/** The stages the suite names when it expects a rejection. */
export type FailStage = 'decode' | 'payload' | 'retrieve' | 'decrypt' | 'bundle';

export interface VectorExpectation {
  outcome: 'success' | 'reject';
  failStage?: FailStage;
  payload?: Record<string, unknown>;
  decrypted?: { sha256?: string; entries?: number; bundle?: string };
  notes?: string[];
}

export interface Vector {
  id: string;
  title: string;
  tier: VectorTier;
  level: string;
  description: string;
  /** The bare link, preferred, falling back to whatever form is published. */
  input: string;
  /** Which member of `input` the link came from, since it is worth showing. */
  inputForm: string;
  expect: VectorExpectation;
  /** url to canned response, with bodies already resolved to text. */
  responses: Record<string, TransportResponse>;
}

export interface SuiteMeta {
  specVersion: string;
  generated: string;
  expires: string;
  /** True when the live links in this suite have passed their own expiry date. */
  stale: boolean;
}

export interface VectorSuite {
  meta: SuiteMeta;
  vectors: Vector[];
}

/**
 * Fetch one file of the suite, through the transport seam like everything else.
 *
 * This is the only request SHLoupe makes that is not part of opening a link, and
 * it still goes through `Transport`: "every request goes through the seam" is
 * worth more as an invariant with no exceptions than as a rule with one, and the
 * lint rule that enforces it caught this the first time it was written as a bare
 * fetch.
 */
export function suiteFetcher(transport: Transport = new BrowserTransport()) {
  return async (url: string): Promise<string> => {
    const response = await transport.send({ method: 'GET', url, purpose: 'vector-suite' });
    if (!response.ok) throw new Error(`${url} answered ${String(response.status)}`);
    return response.body;
  };
}

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

/**
 * Load the suite.
 *
 * `fetchText` is injected rather than calling fetch here, so this is testable
 * with no network and so the one place that reaches a third-party host stays
 * visible to the caller that asked for it.
 */
export async function loadVectorSuite(
  fetchText: (url: string) => Promise<string>,
  now: number = Date.now(),
): Promise<VectorSuite> {
  const index = asRecord(JSON.parse(await fetchText(SUITE_INDEX)));
  const listed = Array.isArray(index['vectors']) ? index['vectors'] : [];

  const vectors: Vector[] = [];
  for (const entry of listed) {
    const file = asString(asRecord(entry)['file']);
    if (file === undefined) continue;
    const raw = asRecord(JSON.parse(await fetchText(`${SUITE_BASE}/${file}`)));
    const vector = await hydrate(raw, fetchText);
    if (vector !== undefined) vectors.push(vector);
  }

  const expires = asString(index['expires']) ?? '';
  return {
    meta: {
      specVersion: asString(index['specVersion']) ?? 'unknown',
      generated: (asString(index['generated']) ?? '').slice(0, 10),
      expires: expires.slice(0, 10),
      // Worth saying out loud: the suite dates its own live links, and a stale
      // suite fails for a reason that is nobody's defect.
      stale: expires !== '' && Date.parse(expires) < now,
    },
    vectors,
  };
}

function expectedDigest(
  decrypted: Record<string, unknown>,
): NonNullable<VectorExpectation['decrypted']> {
  const sha256 = asString(decrypted['sha256']);
  const entries = decrypted['entries'];
  return {
    ...(sha256 === undefined ? {} : { sha256 }),
    ...(typeof entries === 'number' ? { entries } : {}),
  };
}

/** One vector, with its response bodies fetched and its input chosen. */
async function hydrate(
  raw: Record<string, unknown>,
  fetchText: (url: string) => Promise<string>,
): Promise<Vector | undefined> {
  const id = asString(raw['id']);
  if (id === undefined) return undefined;

  const input = asRecord(raw['input']);
  // `shlink` on most, `raw` on the negative decode vectors, `viewerPrefixed` on
  // the one that tests extraction from a URL. Whichever is published is the one
  // a receiver would be handed.
  const forms: Array<[string, string | undefined]> = [
    ['shlink', asString(input['shlink'])],
    ['raw', asString(input['raw'])],
    ['viewerPrefixed', asString(input['viewerPrefixed'])],
    ['qrContent', asString(input['qrContent'])],
  ];
  const chosen = forms.find(([, value]) => value !== undefined);
  if (chosen === undefined) return undefined;

  const expected = asRecord(raw['expect']);
  const decrypted = asRecord(expected['decrypted']);
  const responses: Record<string, TransportResponse> = {};

  for (const [url, value] of Object.entries(asRecord(raw['responses']))) {
    const response = asRecord(value);
    const bodyFile = asString(response['bodyFile']);
    const body =
      bodyFile === undefined
        ? (asString(response['body']) ?? '')
        : await fetchText(`${SUITE_BASE}/${bodyFile}`);
    const status = typeof response['status'] === 'number' ? response['status'] : 200;
    const headers: Record<string, string> = {};
    for (const [name, header] of Object.entries(asRecord(response['headers']))) {
      const text = asString(header);
      if (text !== undefined) headers[name.toLowerCase()] = text;
    }
    responses[url] = {
      ok: status >= 200 && status < 300,
      status,
      statusText: `${String(status)} (from the vector)`,
      headers,
      body,
      bodyBytes: new TextEncoder().encode(body).byteLength,
      responseType: 'cors',
      redirected: false,
      finalUrl: url,
      durationMs: 0,
    };
  }

  const tier = asString(raw['tier']);
  return {
    id,
    title: asString(raw['title']) ?? id,
    tier: tier === 'retrieve' || tier === 'decrypt' || tier === 'bundle' ? tier : 'decode',
    level: asString(raw['level']) ?? 'baseline',
    description: asString(raw['description']) ?? '',
    input: chosen[1] as string,
    inputForm: chosen[0],
    expect: {
      outcome: expected['outcome'] === 'reject' ? 'reject' : 'success',
      ...(asString(expected['failStage']) === undefined
        ? {}
        : { failStage: asString(expected['failStage']) as FailStage }),
      ...(typeof expected['payload'] === 'object' && expected['payload'] !== null
        ? { payload: asRecord(expected['payload']) }
        : {}),
      ...(Object.keys(decrypted).length === 0 ? {} : { decrypted: expectedDigest(decrypted) }),
    },
    responses,
  };
}

// ---------------------------------------------------------------------------
// Running one
// ---------------------------------------------------------------------------

export type VectorVerdict = 'agree' | 'agree-via-profile' | 'disagree';

export interface VectorRun {
  vector: Vector;
  verdict: VectorVerdict;
  /** What SHLoupe did, in the suite's own vocabulary. */
  got: { outcome: RunOutcome; stoppedAt?: FailStage; entries?: number; sha256?: string };
  /** One sentence: why these two agree, or where they part. */
  because: string;
  /** Every extra check the vector asked for, and whether it held. */
  detail: Array<{ what: string; held: boolean; saw: string }>;
  run: TraceRun;
}

/**
 * Map our step kinds onto the stage vocabulary the suite uses.
 *
 * The suite has five stage names and this pipeline has seventeen step kinds, so
 * this is the translation, and it is written out rather than inferred because a
 * wrong mapping would silently turn a real disagreement into a pass.
 */
function stageOf(kind: string): FailStage | undefined {
  if (kind === 'input.detect' || kind === 'shlink.decode') return 'decode';
  if (kind === 'shlink.validate' || kind === 'static.analyse') return 'payload';
  if (kind.startsWith('net.') || kind === 'manifest.validate') return 'retrieve';
  if (kind.startsWith('jwe.') || kind === 'payload.inflate') return 'decrypt';
  if (kind === 'payload.classify' || kind.startsWith('fhir.')) return 'bundle';
  return undefined;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Serve one vector's canned responses, matching on the URL WITHOUT its query.
 *
 * The query is the reason this is not `OfflineTransport`. A conformant receiver
 * adds `recipient` to a direct GET, and KTC requires it, so the URL that goes out
 * is never byte-identical to the URL the vector keys its response under. Matching
 * exactly made 17 of 23 vectors "stop at the retrieve stage", which read as a
 * pipeline defect and was this runner's own bug.
 */
class VectorTransport implements Transport {
  readonly name = 'ktc-vector';
  private readonly byPath: Map<string, TransportResponse>;

  constructor(responses: Record<string, TransportResponse>) {
    this.byPath = new Map(
      Object.entries(responses).map(([url, response]) => [withoutQuery(url), response]),
    );
  }

  async send(request: TransportRequest): Promise<TransportResponse> {
    const hit = this.byPath.get(withoutQuery(request.url));
    if (hit === undefined) {
      throw new NetworkFailure(
        `This vector supplies no response for ${request.url}.`,
        'offline',
        0,
      );
    }
    return { ...hit, finalUrl: request.url };
  }
}

function withoutQuery(url: string): string {
  const cut = url.indexOf('?');
  return cut === -1 ? url : url.slice(0, cut);
}

/** Run one vector through the real pipeline, over its own canned responses. */
export async function runVector(vector: Vector): Promise<VectorRun> {
  const result = await openShl({
    input: vector.input,
    viewer: HTTPS_VIEWER,
    // The suite's own debugger uses "KTC Spec Debugger" here. Naming ourselves is
    // what KTC requires of a receiver, and it is checked as a requirement of the
    // profile too.
    recipient: 'SHLoupe conformance run',
    transport: new VectorTransport(vector.responses),
  });

  const failed = result.run.steps.find(
    (step) => step.status === 'fail' || step.status === 'blocked',
  );
  const stoppedAt = failed === undefined ? undefined : stageOf(failed.kind);
  const file = result.files.find((entry) => entry.content !== undefined);
  const entries = countEntries(file?.content);
  const plaintext = file?.plaintext;
  const sha256 = plaintext === undefined ? undefined : await sha256Hex(plaintext);

  const detail: VectorRun['detail'] = [];

  // Every payload member the vector pins has to round-trip through our decoder.
  if (vector.expect.payload !== undefined) {
    for (const [member, want] of Object.entries(vector.expect.payload)) {
      const got = result.link?.raw[member];
      detail.push({
        what: `payload.${member}`,
        held: JSON.stringify(got) === JSON.stringify(want),
        saw: got === undefined ? 'absent' : JSON.stringify(got),
      });
    }
  }
  if (vector.expect.decrypted?.entries !== undefined) {
    detail.push({
      what: 'Bundle entries',
      held: entries === vector.expect.decrypted.entries,
      saw: entries === undefined ? 'no Bundle' : String(entries),
    });
  }
  if (vector.expect.decrypted?.sha256 !== undefined) {
    detail.push({
      what: 'SHA-256 of the decrypted bytes',
      held: sha256 === vector.expect.decrypted.sha256,
      saw: sha256 === undefined ? 'nothing decrypted' : `${sha256.slice(0, 12)}…`,
    });
  }

  const { verdict, because } = judge(vector, result.outcome, stoppedAt, detail, result.profiles);

  return {
    vector,
    verdict,
    got: {
      outcome: result.outcome,
      ...(stoppedAt === undefined ? {} : { stoppedAt }),
      ...(entries === undefined ? {} : { entries }),
      ...(sha256 === undefined ? {} : { sha256 }),
    },
    because,
    detail,
    run: result.run,
  };
}

function countEntries(content: unknown): number | undefined {
  if (typeof content !== 'object' || content === null) return undefined;
  const entry = (content as Record<string, unknown>)['entry'];
  return Array.isArray(entry) ? entry.length : undefined;
}

/** The comparison, and the reason for it. */
function judge(
  vector: Vector,
  outcome: RunOutcome,
  stoppedAt: FailStage | undefined,
  detail: VectorRun['detail'],
  profiles: readonly { profile: { id: string }; checks: ReadonlyArray<{ verdict: string }> }[],
): { verdict: VectorVerdict; because: string } {
  const broken = detail.filter((check) => !check.held);

  if (vector.expect.outcome === 'success') {
    if (outcome !== 'opened') {
      return {
        verdict: 'disagree',
        because: `The suite expects this to resolve. SHLoupe stopped at the ${stoppedAt ?? 'unknown'} stage.`,
      };
    }
    if (broken.length > 0) {
      return {
        verdict: 'disagree',
        because: `It opened, and ${String(broken.length)} of the vector's own checks did not hold: ${broken
          .map((check) => `${check.what} was ${check.saw}`)
          .join('; ')}.`,
      };
    }
    return {
      verdict: 'agree',
      because: 'It resolved, and every value the vector pins came back the same.',
    };
  }

  // A rejection is expected.
  if (stoppedAt === vector.expect.failStage) {
    return {
      verdict: 'agree',
      because: `Both stop at the ${vector.expect.failStage ?? 'same'} stage.`,
    };
  }

  const ktc = profiles.find((entry) => entry.profile.id === 'ktc');
  const unmet = ktc?.checks.filter((check) => check.verdict === 'unmet').length ?? 0;
  if (unmet > 0) {
    return {
      verdict: 'agree-via-profile',
      because: `A KTC validator rejects this at the ${vector.expect.failStage ?? 'payload'} stage. SHLoupe opens it, because it is a conformant SMART Health Link, and reports ${String(unmet)} unmet KTC requirement${unmet === 1 ? '' : 's'}. Same conclusion about the profile, reached without calling the link broken.`,
    };
  }

  return {
    verdict: 'disagree',
    because: `The suite expects a rejection at the ${vector.expect.failStage ?? 'unknown'} stage. SHLoupe reached "${outcome}"${
      stoppedAt === undefined ? '' : ` after stopping at ${stoppedAt}`
    }, and no profile requirement caught it either.`,
  };
}

/** Counts for a header line. */
export function tallyRuns(runs: readonly VectorRun[]): Record<VectorVerdict, number> {
  return {
    agree: runs.filter((run) => run.verdict === 'agree').length,
    'agree-via-profile': runs.filter((run) => run.verdict === 'agree-via-profile').length,
    disagree: runs.filter((run) => run.verdict === 'disagree').length,
  };
}
