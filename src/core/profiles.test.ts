/**
 * The profile checks, and the distinction they exist to keep.
 *
 * Nearly every test in here is really one assertion: a link can fail a profile
 * and be valid. If that ever collapses into "invalid", this module has become
 * the thing it was written to correct.
 */
import { describe, expect, it } from 'vitest';
import {
  checkProfile,
  checkProfiles,
  PROFILES,
  profileAside,
  type ProfileObservations,
} from './profiles';

const KTC = PROFILES.find((profile) => profile.id === 'ktc');
const WHO = PROFILES.find((profile) => profile.id === 'who-phw');
if (KTC === undefined || WHO === undefined) throw new Error('the profile registry moved');

/** The link from the incident this whole project started with. */
const SHOVAN: ProfileObservations = {
  payload: {
    url: 'https://localhost:5173/api/shl-manifest?bid=4836470',
    key: 'IGXdCGucFRBw-oSVAj87MPw-wx1GVXfykPAkpNwHzsk',
    label: 'Patient Summary',
    exp: 1787347263,
    v: 1,
  },
};

/** A KTC vector that is meant to resolve: U flag, exp, direct file. */
const KTC_BASELINE: ProfileObservations = {
  payload: {
    url: 'https://ktc-spec.github.io/vectors/files/ktc-d1-baseline.jwe',
    flag: 'U',
    key: '7f8fN7xgfZ8W8S9PAirfZ1tAayQFmHr4Xm9kVszSkc8',
    exp: 1812837337,
  },
  response: { status: 200, headers: { 'access-control-allow-origin': '*' } },
  recipientSent: true,
  content: {
    resourceType: 'Bundle',
    type: 'collection',
    entry: [
      { resource: { resourceType: 'Patient', id: 'jessica' } },
      { resource: { resourceType: 'DocumentReference', id: 'story' } },
    ],
  },
};

const check = (observations: ProfileObservations) => checkProfile(KTC, observations);

describe('the link that started this', () => {
  it('fails the KTC flag requirement, and says whose rule that is', () => {
    const result = check(SHOVAN);
    const flag = result.checks.find((entry) => entry.requirement.id === 'KTC-FLAG-U');

    expect(flag?.verdict).toBe('unmet');
    // The whole point: the sentence explaining the failure states that the base
    // specification permits exactly this.
    expect(flag?.saw).toContain('optional');
    expect(flag?.requirement.citation.spec).toContain('KTC');
    expect(flag?.requirement.level).toBe('SHALL');
  });

  it('passes the exp requirement, because it has one', () => {
    const exp = check(SHOVAN).checks.find((entry) => entry.requirement.id === 'KTC-EXP-PRESENT');
    expect(exp?.verdict).toBe('met');
  });

  it('reports the server half as not observed rather than as passing', () => {
    const result = check(SHOVAN);
    const cors = result.checks.find((entry) => entry.requirement.id === 'KTC-CORS-OPEN');
    expect(cors?.verdict).toBe('not-observed');
    expect(result.notObserved).toBeGreaterThan(0);
    // A payload-only run cannot have shown conformance, whatever it passed.
    expect(result.verdict).toBe('non-conformant');
  });

  it('never calls it invalid, in any wording it produces', () => {
    const result = check(SHOVAN);
    const wording = [result.headline, ...result.checks.map((entry) => entry.saw)]
      .join(' ')
      .toLowerCase();
    expect(wording).not.toContain('invalid');
    expect(wording).not.toContain('broken');
    expect(wording).not.toContain('malformed');
    // And it names the profile in the headline, so the reader knows whose rule
    // was broken without opening anything.
    expect(result.headline).toContain('KTC');
  });

  it('offers one aside for a link beside a profile it fails', () => {
    const aside = profileAside(checkProfiles(SHOVAN));
    expect(aside).toContain('valid SMART Health Link');
    expect(aside).toContain('KTC');
  });
});

describe('a link that really is a KTC link', () => {
  it('meets every requirement, including the two on this viewer', () => {
    const result = check(KTC_BASELINE);
    expect(result.unmet).toBe(0);
    expect(result.notObserved).toBe(0);
    expect(result.verdict).toBe('conformant');
    // Nothing in a KTC link can declare the profile, so even a link meeting
    // every requirement gets the weaker sentence. Claiming a link "meets KTC"
    // when nobody said it was one is the overclaim this wording avoids.
    expect(result.declared).toBe('undeclarable');
    expect(result.headline).toContain('Nothing here contradicts it');
  });

  it('says what it saw even when it passed', () => {
    // A pass with no evidence cannot be checked by a reader, which makes it
    // worth as little as an unexplained failure.
    for (const entry of check(KTC_BASELINE).checks) {
      expect(entry.saw.length).toBeGreaterThan(10);
    }
  });

  it('produces no aside, because nothing is contradicted', () => {
    expect(profileAside(checkProfiles(KTC_BASELINE))).toBeUndefined();
  });
});

describe('the requirements that need more than the link', () => {
  it('reads a document Bundle as not this profile, rather than as a bad Bundle', () => {
    const result = check({
      ...KTC_BASELINE,
      content: {
        resourceType: 'Bundle',
        type: 'document',
        entry: [
          { resource: { resourceType: 'Composition' } },
          { resource: { resourceType: 'Patient' } },
        ],
      },
    });
    const type = result.checks.find((entry) => entry.requirement.id === 'KTC-BUNDLE-COLLECTION');
    expect(type?.verdict).toBe('unmet');
    // An IPS is a document Bundle, so this is the common case and the wording
    // has to explain it rather than accuse.
    expect(type?.saw).toContain('IPS');
  });

  it('does not apply the Bundle requirements to a health card', () => {
    const result = check({
      ...KTC_BASELINE,
      content: { verifiableCredential: ['eyJ...'] },
    });
    const type = result.checks.find((entry) => entry.requirement.id === 'KTC-BUNDLE-COLLECTION');
    expect(type?.verdict).toBe('not-observed');
    expect(type?.saw).toContain('does not apply');
  });

  it('counts a Patient with nothing else as unmet', () => {
    const result = check({
      ...KTC_BASELINE,
      content: {
        resourceType: 'Bundle',
        type: 'collection',
        entry: [{ resource: { resourceType: 'Patient' } }],
      },
    });
    const min = result.checks.find(
      (entry) => entry.requirement.id === 'KTC-BUNDLE-PATIENT-PLUS-ONE',
    );
    expect(min?.verdict).toBe('unmet');
  });

  it('holds the attestation rule by construction, with nothing observed', () => {
    // This one is a promise about our own code, and the point of asserting it is
    // that it must not silently become conditional.
    const attestation = check({}).checks.find(
      (entry) => entry.requirement.id === 'KTC-ATTESTATION-NON-BLOCKING',
    );
    expect(attestation?.verdict).toBe('met');
    expect(attestation?.saw).toContain('no attestation gate');
  });

  it('names a specific origin as met, and says what it is not', () => {
    const result = check({
      ...KTC_BASELINE,
      response: {
        status: 200,
        headers: { 'access-control-allow-origin': 'https://viewer.example.org' },
      },
    });
    const cors = result.checks.find((entry) => entry.requirement.id === 'KTC-CORS-OPEN');
    expect(cors?.verdict).toBe('met');
    expect(cors?.saw).toContain('not for every reader');
  });

  it('calls a missing CORS header unmet only once a response has been seen', () => {
    const seen = check({ ...KTC_BASELINE, response: { status: 200, headers: {} } });
    expect(seen.checks.find((e) => e.requirement.id === 'KTC-CORS-OPEN')?.verdict).toBe('unmet');
  });
});

describe('the WHO Personal Health Wallet model', () => {
  it('treats an absent type as a health link rather than as a failure', () => {
    const result = checkProfile(WHO, SHOVAN);
    expect(result.verdict).toBe('conformant');
    expect(result.checks[0]?.saw).toContain('SMART Health Link');
    // And says nothing declared it, so the UI does not report a pass for a
    // profile this link never claimed.
    expect(result.declared).toBe('absent');
  });

  it('says so when a link does declare itself', () => {
    const result = checkProfile(WHO, { payload: { type: 'shl' } });
    expect(result.declared).toBe('declared');
    expect(result.headline).toContain('Declares this profile');
  });

  it('accepts the two codes it defines and flags anything else', () => {
    for (const type of ['shl', 'vhl']) {
      expect(checkProfile(WHO, { payload: { type } }).unmet).toBe(0);
    }
    const odd = checkProfile(WHO, { payload: { type: 'ips' } });
    expect(odd.unmet).toBe(1);
    expect(odd.checks[0]?.saw).toContain('neither');
  });
});

describe('the shape of the registry itself', () => {
  it('gives every requirement an id, a level, a citation and a quote', () => {
    for (const profile of PROFILES) {
      expect(profile.requirements.length).toBeGreaterThan(0);
      for (const requirement of profile.requirements) {
        expect(requirement.id).toMatch(/^[A-Z]+(-[A-Z0-9]+)+$/);
        expect(['SHALL', 'SHOULD']).toContain(requirement.level);
        expect(requirement.citation.url).toMatch(/^https:\/\//);
        // A requirement without the sentence it comes from is an assertion, and
        // this tool's whole argument is that an assertion is not evidence.
        expect(requirement.citation.quote?.length ?? 0).toBeGreaterThan(20);
      }
    }
  });

  it('has a check written for every requirement it lists', () => {
    // A requirement with no case in the switch falls through to "no check is
    // written", which would otherwise be indistinguishable from a genuine
    // absence of evidence.
    for (const profile of PROFILES) {
      for (const entry of checkProfile(profile, KTC_BASELINE).checks) {
        expect(entry.saw, entry.requirement.id).not.toContain('No check is written');
      }
    }
  });

  it('says how a link declares each profile, including that it cannot', () => {
    for (const profile of PROFILES) {
      expect(profile.declaration.length).toBeGreaterThan(40);
    }
  });
});
