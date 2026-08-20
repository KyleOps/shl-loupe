/**
 * The vectors runner: somebody else's conformance suite, run against this engine.
 *
 * It sits at the bottom of the Checks screen rather than in a tab of its own.
 * Checks answers "what does this tool verify", and this answers "and does that
 * agree with anybody outside this repository", which is the same question one
 * step further out. It was briefly a tab, and eight tabs to reach seven jobs is
 * one too many. `#/vectors` still resolves, to Checks, scrolled here.
 *
 * The KTC specification publishes 23 machine-readable test vectors. Its own page
 * lists them, with a copy button and a QR wall, and leaves running them to you.
 * This screen runs them: it loads the suite, executes every vector through the
 * same pipeline the Open screen uses, over each vector's own canned responses,
 * and shows where this tool and the suite's expectations agree.
 *
 * Two things make it worth a screen of its own rather than a paragraph on the
 * Checks page.
 *
 * IT IS THE ONLY EXTERNAL CHECK IN THE BUILDING. Every other test in this project
 * was written by whoever wrote the code, so a shared misunderstanding is
 * invisible to all of them at once. Twenty-three expected outcomes decided by
 * somebody else, before this tool existed, is the one thing that catches that.
 * Showing the result in the product rather than only in CI is the point: at an
 * event, "here is this engine against the published vectors, live, on your
 * laptop" is a different kind of claim from "our tests pass".
 *
 * THE DISAGREEMENTS ARE THE TEACHING. Eleven vectors expect a REJECTION, and five
 * of those are links a base-specification viewer should open: they are conformant
 * SMART Health Links that are not KTC links, and the suite's own description of
 * `ktc-d6-no-exp` says so. So there is a third verdict, `agree-via-profile`, for
 * where both reach the same conclusion about the profile by different routes.
 * That distinction is the whole thesis of this tool, and here it is somebody
 * else's data making the case.
 *
 * On the network: this is the only screen that fetches from a third party, so it
 * does nothing until asked, names every host before the button is pressed, and
 * the runs themselves reach nothing at all (each vector carries its responses).
 */
import { useCallback, useState, type ReactNode } from 'react';
import { ExternalLink, FlaskConical, Play } from 'lucide-react';
import {
  loadVectorSuite,
  runVector,
  SUITE_BASE,
  SUITE_INDEX,
  SUITE_PAGE,
  suiteFetcher,
  tallyRuns,
  type VectorRun,
  type VectorSuite,
  type VectorTier,
  type VectorVerdict,
} from '../core/vectors';
import { Button, Callout, Chip, Disclosure, StatusIcon, type Tone } from '../ui/primitives';
import { QrCode } from '../ui/QrCode';

const TIERS: Array<{ tier: VectorTier; title: string; blurb: string }> = [
  {
    tier: 'decode',
    title: 'Decode',
    blurb: 'The carrier forms and the payload. Pure functions, no network involved.',
  },
  {
    tier: 'retrieve',
    title: 'Retrieve',
    blurb: 'What a receiver does with a 404, and with a link whose expiry has passed.',
  },
  {
    tier: 'decrypt',
    title: 'Decrypt',
    blurb: 'The JWE: compression, a tampered ciphertext, and the base64url alphabet.',
  },
  {
    tier: 'bundle',
    title: 'Bundle',
    blurb: 'The FHIR the profile expects, and the two shapes it rules out.',
  },
];

const VERDICT_TONE: Record<VectorVerdict, Tone> = {
  agree: 'pass',
  'agree-via-profile': 'info',
  disagree: 'fail',
};

const VERDICT_WORD: Record<VectorVerdict, string> = {
  agree: 'Agrees',
  'agree-via-profile': 'Agrees via the profile',
  disagree: 'Disagrees',
};

type Phase = 'idle' | 'loading' | 'running' | 'done' | 'error';

export function VectorRunner(): ReactNode {
  const [phase, setPhase] = useState<Phase>('idle');
  const [suite, setSuite] = useState<VectorSuite | undefined>(undefined);
  const [runs, setRuns] = useState<VectorRun[]>([]);
  const [error, setError] = useState<string | undefined>(undefined);

  const start = useCallback(() => {
    void (async () => {
      setPhase('loading');
      setError(undefined);
      setRuns([]);
      try {
        const loaded = await loadVectorSuite(suiteFetcher());
        setSuite(loaded);
        setPhase('running');

        // One at a time, appending as each finishes, so a slow machine shows
        // progress rather than a frozen button. The runs touch no network.
        const finished: VectorRun[] = [];
        for (const vector of loaded.vectors) {
          finished.push(await runVector(vector));
          setRuns([...finished]);
        }
        setPhase('done');
      } catch (thrown) {
        setError(thrown instanceof Error ? thrown.message : String(thrown));
        setPhase('error');
      }
    })();
  }, []);

  const tally = tallyRuns(runs);

  return (
    <section className="vectors" id="vectors">
      <header className="vectors-head">
        <h2>Somebody else&rsquo;s conformance suite, run against this engine</h2>
        <p className="vectors-lede">
          The KTC specification publishes machine-readable test vectors: an input, the outcome a
          conformant receiver should reach, and every HTTP response the run needs. This page runs
          all of them through the same pipeline the Open screen uses, in this browser, and shows
          where the two agree.
        </p>
      </header>

      <Callout tone="info" title="Why an outside suite is worth more than another test of our own">
        <p>
          Every other test in this project was written by whoever wrote the code, so a shared
          misunderstanding passes all of them at once. These expectations were decided by somebody
          else, for a different implementation, before this tool existed.
        </p>
      </Callout>

      <section className="vectors-verdicts">
        <h3>Three outcomes, and the middle one is the interesting one</h3>
        <dl className="vectors-legend">
          <div>
            <dt>
              <Chip tone="pass">
                <StatusIcon tone="pass" size={12} />
                Agrees
              </Chip>
            </dt>
            <dd>
              The suite expects it to resolve and it resolved, with every value the vector pins
              coming back identical, or the suite expects a rejection and this pipeline stopped at
              the same stage.
            </dd>
          </div>
          <div>
            <dt>
              <Chip tone="info">
                <StatusIcon tone="info" size={12} />
                Agrees via the profile
              </Chip>
            </dt>
            <dd>
              The suite expects a rejection, and the link is a conformant SMART Health Link that
              simply is not a KTC link. Refusing it would be wrong, so SHLoupe opens it and reports
              the unmet KTC requirement instead. Same conclusion about the profile, without calling
              a valid link broken. The suite says so itself, in its description of{' '}
              <code>ktc-d6-no-exp</code>.
            </dd>
          </div>
          <div>
            <dt>
              <Chip tone="fail">
                <StatusIcon tone="fail" size={12} />
                Disagrees
              </Chip>
            </dt>
            <dd>
              A real difference, and a defect in one of the two. Nothing here is graded on a curve:
              if this appears, it is worth reporting to whichever side is wrong.
            </dd>
          </div>
        </dl>
      </section>

      <section className="vectors-run">
        <h3>Run it</h3>
        <p className="vectors-note">
          Pressing this fetches the suite from <code>{new URL(SUITE_INDEX).host}</code>, which is
          the only third-party request any screen in SHLoupe makes. Each vector carries its own HTTP
          responses, so the runs themselves reach nothing: they execute against those, through the
          same transport seam offline mode uses.
        </p>
        <div className="vectors-actions">
          <Button
            variant="primary"
            onClick={start}
            disabled={phase === 'loading' || phase === 'running'}
          >
            <Play size={13} aria-hidden />
            <span>
              {phase === 'loading'
                ? 'Loading the suite…'
                : phase === 'running'
                  ? `Running ${String(runs.length)} of ${String(suite?.vectors.length ?? 0)}…`
                  : phase === 'done'
                    ? 'Run it again'
                    : 'Load and run the vectors'}
            </span>
          </Button>
          <a className="vectors-source" href={SUITE_PAGE} target="_blank" rel="noreferrer noopener">
            The suite&rsquo;s own page
            <ExternalLink size={12} aria-hidden />
          </a>
        </div>

        {error !== undefined ? (
          <Callout tone="fail" title="The suite could not be loaded">
            <p>{error}</p>
            <p>
              This is about reaching <code>{new URL(SUITE_BASE).host}</code>, not about the engine.
              Conference wifi, a captive portal, or the suite having moved will all look like this.
            </p>
          </Callout>
        ) : null}

        {suite !== undefined ? (
          <p className="vectors-meta">
            Suite version {suite.meta.specVersion}, generated {suite.meta.generated}, live links
            valid until {suite.meta.expires}.{' '}
            {suite.meta.stale
              ? 'That date has passed, so the suite’s own links are expired: a rejection at the payload stage is the suite ageing, not a defect.'
              : ''}
          </p>
        ) : null}

        {runs.length > 0 ? (
          <p className="vectors-tally">
            <Chip tone="pass">{tally.agree} agree</Chip>
            <Chip tone="info">{tally['agree-via-profile']} via the profile</Chip>
            <Chip tone={tally.disagree > 0 ? 'fail' : 'skip'}>{tally.disagree} disagree</Chip>
          </p>
        ) : null}
      </section>

      {runs.length > 0
        ? TIERS.map(({ tier, title, blurb }) => {
            const inTier = runs.filter((run) => run.vector.tier === tier);
            if (inTier.length === 0) return null;
            return (
              <section key={tier} className="vectors-tier">
                <h3>{title}</h3>
                <p className="vectors-note">{blurb}</p>
                <div className="vectors-list">
                  {inTier.map((run) => (
                    <VectorCard key={run.vector.id} run={run} />
                  ))}
                </div>
              </section>
            );
          })
        : null}

      {phase === 'idle' ? (
        <section className="vectors-empty">
          <FlaskConical size={22} aria-hidden />
          <p>
            Nothing has been fetched or run. The suite is 23 vectors across four tiers, and a full
            run takes a few seconds.
          </p>
        </section>
      ) : null}
    </section>
  );
}

function VectorCard({ run }: { run: VectorRun }): ReactNode {
  const tone = VERDICT_TONE[run.verdict];
  const { vector } = run;

  return (
    <article className={`vector vector-${run.verdict}`}>
      <header className="vector-head">
        <code className="vector-id">{vector.id}</code>
        <Chip tone={tone}>
          <StatusIcon tone={tone} size={12} />
          {VERDICT_WORD[run.verdict]}
        </Chip>
        <strong className="vector-title">{vector.title}</strong>
        <span className="vector-expected">
          {vector.expect.outcome === 'success'
            ? 'expects: resolves'
            : `expects: rejected at ${vector.expect.failStage ?? 'some stage'}`}
        </span>
      </header>

      <p className="vector-description">{vector.description}</p>
      <p className="vector-because">{run.because}</p>

      {run.detail.length > 0 ? (
        <ul className="vector-detail">
          {run.detail.map((check) => (
            <li key={check.what} className={check.held ? 'is-held' : 'is-broken'}>
              <StatusIcon tone={check.held ? 'pass' : 'fail'} size={12} />
              <span className="vector-detail-what">{check.what}</span>
              <span className="vector-detail-saw">{check.saw}</span>
            </li>
          ))}
        </ul>
      ) : null}

      {/* Straight into the Open screen with this vector's own link, because the
          next question after "it disagrees" is always "show me". */}
      <a className="vector-open" href={`#${vector.input}`}>
        Open this vector in the trace
      </a>

      {/*
        The suite's own page has a wall of QR images for pointing a real scanner
        at. This is the same affordance without the images: the code is generated
        here from the vector's own link, so it is vector art that survives a
        projector, and it works for testing SOMEBODY ELSE'S app, which is what a
        QR wall is actually for. Collapsed, because 23 encoders running at once
        to show 23 codes nobody is scanning is a waste of a laptop.
      */}
      <Disclosure summary="Scan this with another app" defaultOpen={false}>
        <QrCode
          value={vector.input}
          size={200}
          caption={
            <>
              <code>{vector.id}</code> as a {vector.inputForm === 'raw' ? 'bare' : vector.inputForm}{' '}
              link.{' '}
              {vector.expect.outcome === 'success'
                ? 'A conformant receiver should open this.'
                : `A KTC validator should stop at the ${vector.expect.failStage ?? 'payload'} stage.`}
            </>
          }
        />
      </Disclosure>
    </article>
  );
}
