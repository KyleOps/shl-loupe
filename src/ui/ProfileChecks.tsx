/**
 * Whose rule is this link breaking?
 *
 * The presentation problem this component solves is the one the KTC
 * specification's own test-vector page has: it reports a link with no `flag` as
 *
 *     ✗  KTC payload checks: flag must be exactly "U" (found null)
 *
 * which is true, and read alone says "your link is broken" about a link that is
 * a perfectly valid SMART Health Link. `flag` is optional in the base
 * specification. So every line here is built to keep two facts in view at once,
 * and the order is deliberate:
 *
 *  1. The link is valid. That is settled elsewhere, by the member table, and this
 *     component never contradicts it.
 *  2. A downstream profile adds requirements, and this link does or does not meet
 *     them.
 *  3. WHICH DOCUMENT requires it, quoted, with a link to the section.
 *
 * A chip says which of the three verdicts it is, and never by colour alone: the
 * word is in the chip. `undetermined` is its own verdict rather than being folded
 * into either, because most of what a profile constrains is the server and the
 * Bundle, and a link diagnosed with no request has not been shown to conform.
 */
import type { ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import type { ProfileConformance, RequirementCheck, RequirementVerdict } from '../core/profiles';
import { profileAside } from '../core/profiles';
import { Chip, Disclosure, FieldTable, StatusIcon, type FieldRow, type Tone } from './primitives';

const VERDICT_TONE: Record<ProfileConformance['verdict'], Tone> = {
  conformant: 'pass',
  'non-conformant': 'warn',
  undetermined: 'skip',
};

function toneFor(conformance: ProfileConformance): Tone {
  // Green says "this passed". For a profile nothing declared, there was nothing
  // to pass, so it is informational instead.
  if (conformance.verdict === 'conformant' && conformance.declared !== 'declared') return 'info';
  return VERDICT_TONE[conformance.verdict];
}

/**
 * `warn`, never `fail`, for a profile a link does not meet.
 *
 * A failure tone would say the link is wrong, and it is not: it is somebody
 * else's profile. The distinction is the whole reason this component exists, so
 * it is enforced by the type of this table rather than left to each caller.
 */
function chipWord(conformance: ProfileConformance): string {
  if (conformance.verdict === 'non-conformant') return 'Not this profile';
  if (conformance.verdict === 'undetermined') return 'Not fully observed';
  // Conformant, but to what end? A link that never claimed the profile has not
  // "met" it in any sense the reader cares about; it simply does not clash with
  // it. Saying "Meets this profile" there would put a claim in the sender's
  // mouth, which is this component's one thing to avoid.
  return conformance.declared === 'declared' ? 'Declares and meets' : 'Nothing clashes';
}

const CHECK_TONE: Record<RequirementVerdict, Tone> = {
  met: 'pass',
  unmet: 'warn',
  'not-observed': 'skip',
};

export function ProfileChecks({
  conformances,
}: {
  conformances: readonly ProfileConformance[];
}): ReactNode {
  if (conformances.length === 0) return null;
  const aside = profileAside(conformances);

  return (
    <div className="profiles">
      <h3 className="profiles-heading">Downstream profiles</h3>
      {/* The sentence that keeps the two facts together. Only rendered when a
          profile is actually contradicted: announcing "not KTC" over every
          ordinary manifest link would be noise. */}
      {aside === undefined ? (
        <p className="profiles-aside">
          Nothing below contradicts this link. A profile adds requirements to the base
          specification; failing one is a different statement from being invalid.
        </p>
      ) : (
        <p className="profiles-aside">{aside}</p>
      )}

      {conformances.map((conformance) => (
        <ProfileRow key={conformance.profile.id} conformance={conformance} />
      ))}
    </div>
  );
}

function ProfileRow({ conformance }: { conformance: ProfileConformance }): ReactNode {
  const tone = toneFor(conformance);
  const { profile } = conformance;

  return (
    <div className="profile">
      <Disclosure
        /*
         * A profile opens itself when the LINK CLAIMS IT, and on no other
         * condition.
         *
         * This used to open on `unmet > 0`, which sounds like helpfulness and
         * measured as the opposite. On an ordinary manifest link the profile the
         * link IS (SMART Health Links, carried by the variant badge above)
         * rendered as a 40px closed row, and the profile it is NOT opened to
         * 1569px of quoted SHALLs: 68% of the whole link pane spent arguing a
         * negative about a specification the sender never claimed. That is this
         * component's own stated failure mode, reached through the layout rather
         * than through the wording.
         *
         * Nothing is hidden by closing it. The row still carries its verdict
         * chip and its `4 met, 3 unmet` count, and `profiles-aside` above states
         * the finding in a sentence. A reader who wants the seven requirements
         * is one click from them.
         *
         * `declared` is the right condition rather than `verdict`, because it is
         * the only one that means the sender said something. KTC is
         * `undeclarable` by construction, so it never opens on its own; WHO PHW
         * declares itself with a `type` member, and a link that claims a profile
         * has earned the space to be held to it, met or unmet.
         */
        defaultOpen={conformance.declared === 'declared'}
        summary={
          <span className="profile-summary">
            <Chip tone={tone}>
              <StatusIcon tone={tone} size={12} />
              {chipWord(conformance)}
            </Chip>
            <strong className="profile-name">{profile.name}</strong>
          </span>
        }
        meta={
          <span className="profile-count">
            {conformance.met} met
            {conformance.unmet > 0 ? `, ${String(conformance.unmet)} unmet` : ''}
            {conformance.notObserved > 0 ? `, ${String(conformance.notObserved)} not seen` : ''}
          </span>
        }
      >
        <p className="profile-headline">{conformance.headline}</p>
        <p className="profile-blurb">{profile.summary}</p>
        {/* How a link declares the profile, or that nothing in a link can. This
            is what stops the table below reading as an accusation. */}
        <p className="profile-declaration">{profile.declaration}</p>

        <FieldTable rows={conformance.checks.map(requirementRow)} dense />

        <p className="profile-source">
          {profile.name}, version {profile.version}, published by {profile.publisher}.{' '}
          <a href={profile.url} target="_blank" rel="noreferrer noopener">
            Read the profile
            <ExternalLink size={12} aria-hidden />
          </a>
        </p>
      </Disclosure>
    </div>
  );
}

function requirementRow(check: RequirementCheck): FieldRow {
  const { requirement } = check;
  return {
    key: requirement.id,
    value: (
      <span className="requirement">
        <span className="requirement-text">
          <strong className="requirement-level">{requirement.level}</strong>{' '}
          {requirement.requirement}
        </span>
        <span className="requirement-whom">
          {requirement.onWhom === 'receiver'
            ? 'on this viewer'
            : requirement.onWhom === 'server'
              ? 'on the server'
              : 'on the sender'}
        </span>
      </span>
    ),
    mono: false,
    tone: CHECK_TONE[check.verdict],
    note: (
      <span className="requirement-note">
        {check.saw}
        <span className="requirement-cite">
          <a href={requirement.citation.url} target="_blank" rel="noreferrer noopener">
            {requirement.citation.section}
            <ExternalLink size={11} aria-hidden />
          </a>
          {requirement.citation.quote === undefined ? null : (
            <q className="requirement-quote">{requirement.citation.quote}</q>
          )}
        </span>
      </span>
    ),
  };
}
