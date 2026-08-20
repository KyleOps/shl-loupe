/**
 * Profile conformance: whose rule is this link breaking?
 *
 * The question that produced this module came from the KTC specification's own
 * test-vector page, which reports this for a link that has no `flag`:
 *
 *     ✗  KTC payload checks
 *        flag must be exactly "U" (found null)
 *
 * That is correct, and stated alone it is misleading, because the same link is
 * perfectly valid against the specification KTC profiles. `flag` is optional in
 * HL7 SMART Health Links STU 1: a payload without one is a manifest link with no
 * passcode, which is the default case. So a viewer that reports "flag must be
 * exactly U" as an error is telling a sender their link is broken when what is
 * actually true is narrower and more useful: this link is a valid SMART Health
 * Link and is not a KTC link.
 *
 * KTC's own vector says so, in the description of `ktc-d6-no-exp`: "A payload
 * without it is a conformant base-spec SHLink but NOT a KTC link; receivers
 * validating KTC conformance flag it." That sentence is the model this module
 * implements.
 *
 * So the rules here are:
 *
 * A PROFILE IS A DELTA, never a second opinion on the base specification. Only
 * requirements a profile ADDS or TIGHTENS live here. Whether `key` is 43
 * characters is a base-spec question, answered once in diagnose/rules.ts, and
 * duplicating it here would be two implementations of one rule, drifting.
 *
 * FAILING A PROFILE IS NOT AN ERROR, and never sets the run's verdict. Nothing in
 * this module returns `fatal`. A link that fails every profile check can still be
 * opened, and usually should be: the sender chose their profile, not us.
 *
 * A REQUIREMENT THAT CANNOT BE OBSERVED SAYS SO, rather than passing quietly.
 * Half of KTC's constraints are on the retrieval endpoint and the returned
 * Bundle, so a link diagnosed with no request can only answer the payload half.
 * "Not observed" is a third verdict, and the count in the summary keeps it
 * visible instead of rounding it into a pass.
 *
 * A REQUIREMENT ON US IS ALSO CHECKED. Both specifications put duties on the
 * receiving viewer, not only on the sender: KTC's receiver SHALL send a
 * `recipient` and SHALL NOT block on a failed attestation. Those are checked
 * against what SHLoupe actually did, because a conformance tool that grades only
 * the other side is marking its own homework.
 */
import type { Citation } from './trace';
import type { ShlPayload } from './shlink';

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

export type ProfileId = 'ktc' | 'who-phw';

/** Where the evidence for a requirement comes from. */
export type Observable =
  | 'payload' // the decoded link, so answerable with no network at all
  | 'response' // the headers or status of the retrieval
  | 'bundle' // the decrypted FHIR
  | 'viewer'; // what this tool itself did

export type RequirementLevel = 'SHALL' | 'SHOULD';

export interface ProfileRequirement {
  /** Stable id, quoted in reports and in the vector runner. */
  id: string;
  level: RequirementLevel;
  /** What the profile requires, one line, in the profile's own terms. */
  requirement: string;
  observed: Observable;
  citation: Citation;
  /** Whose behaviour this constrains. */
  onWhom: 'sender' | 'server' | 'receiver';
}

export type RequirementVerdict = 'met' | 'unmet' | 'not-observed';

export interface RequirementCheck {
  requirement: ProfileRequirement;
  verdict: RequirementVerdict;
  /**
   * What was actually seen, in words, always. For `met` as much as for `unmet`:
   * a conformance tool that says only "pass" cannot be checked by the person
   * reading it.
   */
  saw: string;
}

export interface Profile {
  id: ProfileId;
  name: string;
  publisher: string;
  /** The version these requirements were read from. */
  version: string;
  url: string;
  /** Why this profile exists, one or two sentences. */
  summary: string;
  /**
   * How a link says it is this profile, or that nothing in a link can say so.
   * This is the sentence that stops a conformance report reading as an
   * accusation: most links are not claiming the profile they are being measured
   * against.
   */
  declaration: string;
  /**
   * Whether anything observed says a link was MEANT to be this profile.
   *
   * Without this, a profile whose requirements are all conditional reads as
   * "meets this profile" for every link in the world, which is a claim nobody
   * made and the reader has to unpick. `undeclarable` is the honest answer for a
   * profile that a link cannot announce at all.
   */
  declaredBy: (observations: ProfileObservations) => 'declared' | 'absent' | 'undeclarable';
  requirements: ProfileRequirement[];
}

export interface ProfileConformance {
  profile: Profile;
  checks: RequirementCheck[];
  met: number;
  unmet: number;
  notObserved: number;
  /**
   * `conformant` only when nothing is unmet AND nothing is unobserved: a link
   * whose server half was never tested has not been shown to conform, and
   * saying otherwise is the exact overclaim this tool exists to argue against.
   */
  verdict: 'conformant' | 'non-conformant' | 'undetermined';
  /** Whether anything says this link was meant to be this profile. */
  declared: 'declared' | 'absent' | 'undeclarable';
  /** One line, ready to render. */
  headline: string;
}

/** Everything a check may look at. Absent members mean "not observed". */
export interface ProfileObservations {
  payload?: ShlPayload;
  /** The retrieval response, if a request was made. Header names lower case. */
  response?: { status: number; headers: Record<string, string> };
  /** Whether this viewer sent a `recipient` on the retrieval it made. */
  recipientSent?: boolean;
  /** The decrypted FHIR resource, if one was obtained. */
  content?: unknown;
  /**
   * Whether an attestation was present and whether it verified, when the
   * profile has something to say about that. Absent means none was seen.
   */
  attestation?: { present: boolean; verified?: boolean };
}

// ---------------------------------------------------------------------------
// Citations
// ---------------------------------------------------------------------------

const KTC_URL = 'https://ktc-spec.github.io/';
const KTC_VECTORS = 'https://ktc-spec.github.io/test-vectors';

const ktc = (section: string, quote: string): Citation => ({
  spec: 'Patient-Shared Health Documents via SMART Health Links (KTC)',
  section,
  url: KTC_URL,
  quote,
});

// ---------------------------------------------------------------------------
// The profiles
// ---------------------------------------------------------------------------

/**
 * KTC, read from the published specification at version 0.10.2 (the
 * `specVersion` its own vector index carries).
 *
 * Worth knowing about this profile, because it changes how its requirements
 * should be read: KTC constrains BOTH ends. The `U` flag and `exp` are duties on
 * the patient app that mints the link; the CORS policy is a duty on whatever
 * serves the file; `recipient` and the attestation rule are duties on the
 * receiving EHR, which here is SHLoupe.
 */
const KTC: Profile = {
  id: 'ktc',
  name: 'KTC patient-shared documents',
  publisher: 'ktc-spec.github.io',
  version: '0.10.2',
  url: KTC_URL,
  summary:
    'A downstream profile of SMART Health Links for a patient handing a document to a provider at reception, associated with the "kill the clipboard" work. It narrows the base specification to the one shape a front desk can rely on: a direct file, always dated, readable from a browser.',
  declaration:
    'Nothing inside a link declares it: the payload has the same six members as the base specification, with two of them pinned, so a link is measured against this profile because somebody says it is a KTC link and never because it announced itself as one.',
  declaredBy: () => 'undeclarable',
  requirements: [
    {
      id: 'KTC-FLAG-U',
      level: 'SHALL',
      requirement: 'The `flag` member is present and is exactly `U`.',
      observed: 'payload',
      onWhom: 'sender',
      citation: ktc(
        'SHLink Constraints',
        'Patient Apps SHALL generate SHLinks with the U flag, meaning the link resolves directly to a single encrypted file.',
      ),
    },
    {
      id: 'KTC-EXP-PRESENT',
      level: 'SHALL',
      requirement: 'The `exp` member is present.',
      observed: 'payload',
      onWhom: 'sender',
      citation: ktc(
        'SHLink Payload',
        'exp: Required. Expiration timestamp. SHOULD be short-lived for sensitive data.',
      ),
    },
    {
      id: 'KTC-CORS-OPEN',
      level: 'SHOULD',
      requirement: 'The retrieval endpoint answers with a permissive CORS policy.',
      observed: 'response',
      onWhom: 'server',
      citation: ktc(
        'Retrieval Protocol',
        'Patient Apps SHOULD serve the retrieval endpoint with a permissive CORS policy.',
      ),
    },
    {
      id: 'KTC-RECIPIENT-SENT',
      level: 'SHALL',
      requirement: 'The receiver supplies a `recipient` parameter identifying itself.',
      observed: 'viewer',
      onWhom: 'receiver',
      citation: ktc(
        'Retrieval Protocol: Request',
        'The EHR SHALL supply a recipient query parameter identifying the requesting organization.',
      ),
    },
    {
      id: 'KTC-BUNDLE-COLLECTION',
      level: 'SHALL',
      requirement: 'The payload is a FHIR Bundle of type `collection`.',
      observed: 'bundle',
      onWhom: 'sender',
      citation: ktc('PatientSharedBundle Constraints', 'Bundle.type: Fixed: collection.'),
    },
    {
      id: 'KTC-BUNDLE-PATIENT-PLUS-ONE',
      level: 'SHALL',
      requirement: 'The Bundle carries a Patient and at least one content entry.',
      observed: 'bundle',
      onWhom: 'sender',
      citation: ktc(
        'PatientSharedBundle Constraints',
        'Minimum: Patient and at least one patient-shared content entry.',
      ),
    },
    {
      id: 'KTC-ATTESTATION-NON-BLOCKING',
      level: 'SHALL',
      requirement: 'The receiver does not refuse a Bundle for a missing or failed attestation.',
      observed: 'viewer',
      onWhom: 'receiver',
      citation: ktc(
        'Conformance Requirements',
        'Receivers SHALL NOT block Bundle processing when App Attestation is absent or fails verification.',
      ),
    },
  ],
};

/**
 * The WHO GDHCN Personal Health Wallet model, which adds exactly one member.
 *
 * One requirement, and it is here rather than in the base rules because a `type`
 * member is not part of the HL7 payload at all: a baseline client ignores it, and
 * only a reader who knows this model exists can say whether its value is one the
 * model defines.
 */
const WHO_PHW: Profile = {
  id: 'who-phw',
  name: 'WHO Personal Health Wallet health link',
  publisher: 'WHO GDHCN',
  version: 'trust-phw, current publication',
  url: 'https://smart.who.int/trust-phw/',
  summary:
    'The WHO Personal Health Wallet reuses the HL7 payload exactly and adds one classifying member, so that a wallet holding both health links and verifiable health links can tell them apart before retrieving either.',
  declaration:
    'A `type` member, which the HL7 payload does not define. A link with no `type` is a SMART Health Link by this model’s own default, so its absence is not a failure.',
  declaredBy: (observations) =>
    observations.payload?.['type'] === undefined ? 'absent' : 'declared',
  requirements: [
    {
      id: 'WHO-TYPE-CODE',
      level: 'SHALL',
      requirement: 'A `type` member, when present, is one of `shl` or `vhl`.',
      observed: 'payload',
      onWhom: 'sender',
      citation: {
        spec: 'WHO GDHCN Personal Health Wallet',
        section: 'HealthLinkPayload: type',
        url: 'https://smart.who.int/trust-phw/',
        quote:
          'Classifying type code to distinguish different types of health links. If not present then the Health Link is a SMART Health Link.',
      },
    },
  ],
};

export const PROFILES: Profile[] = [KTC, WHO_PHW];

export const VECTOR_SUITE_URL = KTC_VECTORS;

// ---------------------------------------------------------------------------
// Checking
// ---------------------------------------------------------------------------

const notObserved = (requirement: ProfileRequirement, saw: string): RequirementCheck => ({
  requirement,
  verdict: 'not-observed',
  saw,
});

/** One requirement against one set of observations. */
function checkRequirement(
  requirement: ProfileRequirement,
  observations: ProfileObservations,
): RequirementCheck {
  const { payload, response, content } = observations;

  switch (requirement.id) {
    case 'KTC-FLAG-U': {
      if (payload === undefined) return notObserved(requirement, 'The link did not decode.');
      const flag = payload['flag'];
      if (flag === 'U') return { requirement, verdict: 'met', saw: '`flag` is `U`.' };
      if (flag === undefined || flag === null) {
        return {
          requirement,
          verdict: 'unmet',
          saw: 'No `flag` member. Valid in the base specification, where `flag` is optional and its absence means a manifest link with no passcode.',
        };
      }
      // JSON.stringify rather than String: `flag` is `unknown` here, and an
      // object stringifies to "[object Object]", which would report a
      // structurally wrong payload as an ordinary flag value.
      return {
        requirement,
        verdict: 'unmet',
        saw: `\`flag\` is ${JSON.stringify(flag)}, which the base specification allows and this profile does not.`,
      };
    }

    case 'KTC-EXP-PRESENT': {
      if (payload === undefined) return notObserved(requirement, 'The link did not decode.');
      const exp = payload['exp'];
      if (typeof exp === 'number') {
        return { requirement, verdict: 'met', saw: `\`exp\` is ${String(exp)}.` };
      }
      return {
        requirement,
        verdict: 'unmet',
        saw:
          exp === undefined
            ? 'No `exp` member. Optional in the base specification, required here.'
            : `\`exp\` is ${JSON.stringify(exp)}, which is not a number of seconds.`,
      };
    }

    case 'KTC-CORS-OPEN': {
      if (response === undefined) {
        return notObserved(
          requirement,
          'No retrieval was made, so nothing has been seen of the server. This is the half of the profile a link alone cannot answer.',
        );
      }
      const allow = response.headers['access-control-allow-origin'];
      if (allow === '*') {
        return { requirement, verdict: 'met', saw: '`access-control-allow-origin: *`.' };
      }
      if (allow === undefined) {
        return {
          requirement,
          verdict: 'unmet',
          saw: 'No `access-control-allow-origin` header on the response. The request succeeded here, so this is about what a browser is allowed to read rather than about the server being up.',
        };
      }
      return {
        requirement,
        verdict: 'met',
        saw: `\`access-control-allow-origin: ${allow}\`, which named an origin rather than allowing any. Permissive enough for this reader, and not for every reader.`,
      };
    }

    case 'KTC-RECIPIENT-SENT': {
      if (observations.recipientSent === undefined) {
        return notObserved(requirement, 'No retrieval was made, so nothing was sent.');
      }
      return observations.recipientSent
        ? {
            requirement,
            verdict: 'met',
            saw: 'SHLoupe sent a `recipient` on the retrieval. It is in the request evidence on the retrieval step.',
          }
        : {
            requirement,
            verdict: 'unmet',
            saw: 'SHLoupe did not send a `recipient`, which is this tool’s defect and not the link’s.',
          };
    }

    case 'KTC-BUNDLE-COLLECTION': {
      const bundle = asBundle(content);
      if (bundle === undefined) {
        return notObserved(
          requirement,
          content === undefined
            ? 'Nothing was retrieved and decrypted, so there is no Bundle to check.'
            : 'What was retrieved is not a FHIR Bundle, so this profile does not apply to it.',
        );
      }
      return bundle.type === 'collection'
        ? { requirement, verdict: 'met', saw: '`Bundle.type` is `collection`.' }
        : {
            requirement,
            verdict: 'unmet',
            saw: `\`Bundle.type\` is \`${String(bundle.type)}\`. A document Bundle is what an IPS is, so this is the usual reason a real summary is not a KTC payload.`,
          };
    }

    case 'KTC-BUNDLE-PATIENT-PLUS-ONE': {
      const bundle = asBundle(content);
      if (bundle === undefined) {
        return notObserved(requirement, 'No Bundle was retrieved and decrypted.');
      }
      const types = (bundle.entry ?? []).map((entry) => resourceTypeOf(entry));
      const patients = types.filter((type) => type === 'Patient').length;
      const others = types.filter((type) => type !== undefined && type !== 'Patient').length;
      if (patients >= 1 && others >= 1) {
        return {
          requirement,
          verdict: 'met',
          saw: `${String(patients)} Patient and ${String(others)} other ${others === 1 ? 'entry' : 'entries'}.`,
        };
      }
      return {
        requirement,
        verdict: 'unmet',
        saw:
          patients === 0
            ? `No Patient entry among ${String(types.length)}.`
            : 'A Patient and nothing else, so the Bundle names a person and shares nothing about them.',
      };
    }

    case 'KTC-ATTESTATION-NON-BLOCKING': {
      // Structural rather than observed: SHLoupe has no attestation gate to
      // fail, which is what this requirement asks for. Saying "not observed"
      // here would be false modesty about a guarantee the code does make.
      const attestation = observations.attestation;
      return {
        requirement,
        verdict: 'met',
        saw:
          attestation === undefined
            ? 'SHLoupe has no attestation gate: nothing in the pipeline can refuse a payload for a missing or failed attestation, so this holds by construction.'
            : `An attestation was ${attestation.present ? 'present' : 'absent'}${
                attestation.verified === undefined
                  ? ''
                  : attestation.verified
                    ? ' and verified'
                    : ' and did not verify'
              }, and the payload was processed either way.`,
      };
    }

    case 'WHO-TYPE-CODE': {
      if (payload === undefined) return notObserved(requirement, 'The link did not decode.');
      const type = payload['type'];
      if (type === undefined) {
        return {
          requirement,
          verdict: 'met',
          saw: 'No `type` member, which this model reads as a SMART Health Link.',
        };
      }
      return type === 'shl' || type === 'vhl'
        ? { requirement, verdict: 'met', saw: `\`type\` is \`${type}\`.` }
        : {
            requirement,
            verdict: 'unmet',
            saw: `\`type\` is ${JSON.stringify(type)}, which is neither \`shl\` nor \`vhl\`.`,
          };
    }

    default:
      return notObserved(requirement, 'No check is written for this requirement.');
  }
}

interface MinimalBundle {
  type?: unknown;
  entry?: unknown[];
}

function asBundle(content: unknown): MinimalBundle | undefined {
  if (typeof content !== 'object' || content === null) return undefined;
  const record = content as Record<string, unknown>;
  if (record['resourceType'] !== 'Bundle') return undefined;
  const entry = record['entry'];
  return {
    type: record['type'],
    ...(Array.isArray(entry) ? { entry } : {}),
  };
}

function resourceTypeOf(entry: unknown): string | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined;
  const resource = (entry as Record<string, unknown>)['resource'];
  if (typeof resource !== 'object' || resource === null) return undefined;
  const type = (resource as Record<string, unknown>)['resourceType'];
  return typeof type === 'string' ? type : undefined;
}

/** One profile, checked. */
export function checkProfile(
  profile: Profile,
  observations: ProfileObservations,
): ProfileConformance {
  const checks = profile.requirements.map((requirement) =>
    checkRequirement(requirement, observations),
  );
  const met = checks.filter((check) => check.verdict === 'met').length;
  const unmet = checks.filter((check) => check.verdict === 'unmet').length;
  const notObservedCount = checks.filter((check) => check.verdict === 'not-observed').length;
  const verdict =
    unmet > 0 ? 'non-conformant' : notObservedCount > 0 ? 'undetermined' : 'conformant';

  const declared = profile.declaredBy(observations);

  return {
    profile,
    checks,
    met,
    unmet,
    notObserved: notObservedCount,
    verdict,
    declared,
    headline: headlineFor(profile, checks, verdict, declared, unmet, notObservedCount),
  };
}

function headlineFor(
  profile: Profile,
  checks: RequirementCheck[],
  verdict: ProfileConformance['verdict'],
  declared: ProfileConformance['declared'],
  unmet: number,
  notObservedCount: number,
): string {
  if (verdict === 'conformant') {
    // "Meets this profile" for a link that never claimed it is a claim nobody
    // made. Whether anything declared the profile changes the sentence.
    return declared === 'declared'
      ? `Declares this profile and meets all ${String(checks.length)} of its added requirements.`
      : `Nothing here contradicts it: all ${String(checks.length)} of its added requirements hold, and nothing in the link says it was meant to be this profile.`;
  }
  if (verdict === 'undetermined') {
    return `Nothing contradicts ${profile.name}, and ${String(notObservedCount)} of its ${String(checks.length)} requirements ${notObservedCount === 1 ? 'was' : 'were'} not observed here.`;
  }
  // Name the failing requirement by id, and let the table say the rest: a count
  // alone sends the reader hunting, and repeating the requirement's sentence in
  // the headline reads as though the sentence itself were the problem.
  const failing = checks
    .filter((check) => check.verdict === 'unmet')
    .map((check) => check.requirement.id)
    .join(', ');
  return `Not a ${profile.name} link: ${String(unmet)} of ${String(checks.length)} added requirements unmet (${failing}).`;
}

/** Every profile, checked, in a stable order. */
export function checkProfiles(observations: ProfileObservations): ProfileConformance[] {
  return PROFILES.map((profile) => checkProfile(profile, observations));
}

/**
 * The one sentence to put beside a link, when there is one worth putting there.
 *
 * Deliberately quiet: it speaks only when a profile is actually contradicted, and
 * it says which document is doing the requiring. A viewer that announces "not
 * KTC conformant" over every ordinary manifest link would be noise, and it would
 * be making exactly the incumbent's mistake in the other direction.
 */
export function profileAside(conformances: readonly ProfileConformance[]): string | undefined {
  const failed = conformances.filter((conformance) => conformance.unmet > 0);
  if (failed.length === 0) return undefined;
  const names = failed.map((conformance) => conformance.profile.name).join(' or ');
  return `This is a valid SMART Health Link. It is not ${names}, which some receivers check for.`;
}
