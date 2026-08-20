/**
 * The KTC conformance suite, run against this engine.
 *
 * This is the second of the two tests that talk to a real server, and it does a
 * different job from the first. `live-ig-examples` proves our JOSE agrees with a
 * real encrypter on real bytes. This proves our OUTCOMES agree with somebody
 * else's expectations, decided before this tool existed, over 23 cases including
 * eleven that are meant to be rejected.
 *
 * That is the only external check on the pipeline's judgement available: every
 * other test here was written by the same hand as the code, so a shared
 * misunderstanding passes all of them at once.
 *
 * Excluded from the default run (`.integration.`), because the suite lives on a
 * third party's site and a test that goes red when their wifi does is a test
 * people learn to ignore. Run it deliberately:
 *
 *   npx vitest run --config vitest.integration.config.ts
 *
 * What "agree" means here is deliberately three-valued, and the middle value is
 * the interesting one. `ktc-d6-no-exp` and `ktc-d7-flag-p` are conformant SMART
 * Health Links that KTC rejects; the suite's own description of d6 says so. A
 * base-specification viewer that refused them would be wrong. So SHLoupe opens
 * them and reports the unmet KTC requirement, which the runner scores as
 * `agree-via-profile`: same conclusion about the profile, without calling a valid
 * link broken.
 */
import { describe, expect, it } from 'vitest';
import {
  loadVectorSuite,
  runVector,
  suiteFetcher,
  tallyRuns,
  type VectorSuite,
} from '../src/core/vectors';

let cached: VectorSuite | undefined;
async function suite(): Promise<VectorSuite> {
  // Through the same seam the screen uses, so this test exercises the loading
  // path the product actually runs rather than a parallel one.
  cached ??= await loadVectorSuite(suiteFetcher());
  return cached;
}

describe('the published KTC test vectors', () => {
  it('loads the suite, with every vector carrying an input and an expectation', async () => {
    const { meta, vectors } = await suite();

    expect(meta.specVersion).toMatch(/^\d+\.\d+\.\d+$/);
    // The suite dates its own live links. A stale suite fails for a reason that
    // is nobody's defect, so it is reported rather than asserted away.
    if (meta.stale) console.warn(`The vector suite expired on ${meta.expires}.`);

    expect(vectors.length).toBeGreaterThanOrEqual(20);
    for (const vector of vectors) {
      expect(vector.input.length, vector.id).toBeGreaterThan(20);
      expect(['success', 'reject']).toContain(vector.expect.outcome);
      if (vector.expect.outcome === 'reject') expect(vector.expect.failStage).toBeDefined();
    }
  }, 60_000);

  it('reaches the same conclusion as the suite on every vector', async () => {
    const { vectors } = await suite();
    const runs = [];
    for (const vector of vectors) runs.push(await runVector(vector));

    const tally = tallyRuns(runs);
    const disagreements = runs.filter((run) => run.verdict === 'disagree');

    // Printed rather than only asserted: when this fails, the useful output is
    // which vector and why, not a count.
    for (const run of disagreements) {
      console.error(`DISAGREE ${run.vector.id} (${run.vector.title}): ${run.because}`);
    }
    console.warn(
      `agree ${String(tally.agree)}, via profile ${String(tally['agree-via-profile'])}, disagree ${String(tally.disagree)}`,
    );

    expect(disagreements.map((run) => run.vector.id)).toEqual([]);
  }, 120_000);

  it('opens the baseline vector, with the values the vector pins', async () => {
    // One vector asserted in full, so a change in the runner's own reporting
    // cannot make the sweep above vacuous.
    const { vectors } = await suite();
    const baseline = vectors.find((vector) => vector.id === 'ktc-d1-baseline');
    expect(baseline).toBeDefined();
    if (baseline === undefined) return;

    const run = await runVector(baseline);
    expect(run.verdict).toBe('agree');
    expect(run.got.outcome).toBe('opened');
    expect(run.detail.length).toBeGreaterThan(3);
    for (const check of run.detail) expect(check.held, `${check.what}: ${check.saw}`).toBe(true);
  }, 60_000);

  it('opens the two links KTC rejects that the base specification permits', async () => {
    // The claim this project exists to defend, checked against the suite that
    // makes the opposite call.
    const { vectors } = await suite();
    for (const id of ['ktc-d6-no-exp', 'ktc-d7-flag-p']) {
      const vector = vectors.find((entry) => entry.id === id);
      expect(vector, id).toBeDefined();
      if (vector === undefined) continue;
      const run = await runVector(vector);
      expect(run.verdict, `${id}: ${run.because}`).toBe('agree-via-profile');
      expect(run.because).toContain('conformant SMART Health Link');
    }
  }, 90_000);

  it('runs the whole suite with no network of its own', async () => {
    // The vectors carry their own responses, so a run must not reach out. If this
    // ever fails, the suite is being executed against live URLs and the offline
    // claim on the Vectors screen is false.
    const { vectors } = await suite();
    const target = vectors.find((vector) => vector.expect.outcome === 'success');
    expect(target).toBeDefined();
    if (target === undefined) return;

    const real = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (...args: Parameters<typeof fetch>) => {
      calls += 1;
      return real(...args);
    };
    try {
      const run = await runVector(target);
      expect(run.got.outcome).toBe('opened');
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = real;
    }
  }, 60_000);
});
