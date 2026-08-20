/**
 * The verdict. One sentence, the address it is about, the facts behind it, and
 * the two messages a person actually sends afterwards.
 *
 * This is the thing that has to read from the back of a room, so it holds
 * exactly one display-size sentence and everything else is small. Three
 * decisions are worth knowing before changing it.
 *
 * BLOCKED IS THE GOOD OUTCOME, AND THE COPY SAYS SO. "Blocked" means Loupe knew
 * the link could not work from the link itself and never troubled a server;
 * "failed" means it asked and did not get through. A viewer that renders both as
 * one red failure is how a sender concludes their link is fine and the viewer is
 * broken, which is the whole reason this tool exists. So the two get different
 * sublines, and "no request was made" is a headline fact rather than a footnote:
 * it is the proof the diagnosis cost nobody anything.
 *
 * THE REPORTS ARE BUILT AT CLICK TIME, NOT AT RENDER TIME. Both builders walk
 * the entire run and serialise it, and the recorder emits a fresh snapshot on
 * every mutation, so building them during render would re-serialise the run on
 * each of dozens of renders. {@link CopyButton} takes a thunk for exactly this.
 *
 * THE REDACTOR IS NOT OPTIONAL IN PRACTICE. `buildDiagnosisReport` with no
 * registry cannot promise anything, and says so in its first line, so a caller
 * that omits the prop falls back to the session's registry rather than silently
 * exporting a report that warns the reader it may carry a decryption key.
 */
import { useCallback, type ReactNode } from 'react';
import { CornerDownRight } from 'lucide-react';
import { useSession } from '../../app/store';
import { buildDiagnosisReport, buildSenderExplanation } from '../../core/report';
import type { Redactor, Severity, TraceRun } from '../../core/trace';
import { Button, Chip, CopyButton, Duration, StatusIcon, toneForSeverity } from '../primitives';
import {
  AUDIENCE_LABEL,
  OUTCOME_WORD,
  buildStepTree,
  countRequests,
  failingStepId,
  flattenStepTree,
  highlightPartForRule,
  highlightUrlPart,
  leadingFinding,
  manifestUrlFromRun,
  outcomeHeadline,
  outcomeTone,
  type UrlPart,
  type UrlSegment,
} from './format';

const SEVERITY_SEQUENCE: readonly Severity[] = ['fatal', 'error', 'warning', 'info', 'good'];

/** Countable phrasing, because "2 Fatal" is not a sentence anyone would write. */
function severityCount(severity: Severity, count: number): string {
  const plural = count === 1 ? '' : 's';
  switch (severity) {
    case 'fatal':
      return `${count} fatal`;
    case 'error':
      return `${count} error${plural}`;
    case 'warning':
      return `${count} warning${plural}`;
    case 'info':
      return `${count} note${plural}`;
    default:
      return `${count} good sign${plural}`;
  }
}

const URL_PART_WORD: Record<UrlPart, string> = {
  scheme: 'scheme',
  host: 'host name',
  port: 'port',
};

/**
 * The line under the headline. Keyed on the outcome rather than on the finding,
 * because what the reader needs next is whether anybody has been troubled yet
 * and where to look, and the finding's own detail is one tap away in the trace.
 */
function subline(run: TraceRun, requests: number): string {
  switch (run.outcome) {
    case 'running':
      return 'Each step appears here as it settles.';
    case 'opened':
      return 'Every hop that had to happen did, and the contents are shown alongside this trace.';
    case 'partial':
      return 'Some of what this link points at opened and some of it did not, so the trace is the part worth reading.';
    case 'blocked':
      return requests === 0
        ? 'Loupe worked this out from the link itself and made no request, so no server was troubled and nothing timed out.'
        : 'Loupe stopped rather than keep asking. What it already knows settles it.';
    default:
      return 'Loupe went as far as it could get. The failing step below carries the response verbatim, including the browser’s own words.';
  }
}

export interface VerdictBannerProps {
  run: TraceRun;
  /** The run's secret registry. Defaults to the session's; see the note above. */
  redactor?: Redactor | undefined;
  /** Defaults to selecting the step in the session, which the trace list follows. */
  onJumpToStep?: ((stepId: string) => void) | undefined;
}

export function VerdictBanner({ run, redactor, onJumpToStep }: VerdictBannerProps): ReactNode {
  const sessionRedactor = useSession((state) => state.redactor);
  const expandStep = useSession((state) => state.expandStep);
  const activeRedactor = redactor ?? sessionRedactor;
  const jump = onJumpToStep ?? expandStep;

  /**
   * Two tones, because the banner states two different things.
   *
   * `outcomeTone` describes what LOUPE did, and for a blocked run that is a good
   * outcome: it worked the answer out from the link and troubled no server. So
   * the outcome chip is informational there, on purpose.
   *
   * The headline describes what is wrong with the LINK, and it takes the leading
   * finding's severity. Without the split, a fatal verdict rendered a calm blue
   * information icon beside the sentence "nobody else can open it", which is a
   * mixed signal at exactly the moment the reader most needs a clear one.
   */
  const outcome = outcomeTone(run.outcome);
  const leading = leadingFinding(run.findings);
  const tone = leading === undefined ? outcome : toneForSeverity(leading.severity);
  const headline = leading?.title ?? outcomeHeadline(run.outcome);
  const requests = countRequests(run);
  const elapsedMs = run.finishedAt === undefined ? undefined : run.finishedAt - run.startedAt;

  const url = manifestUrlFromRun(run);
  const part = leading === undefined ? undefined : highlightPartForRule(leading.ruleId);
  // No rule pointing at a part of the URL means nothing is marked. Passing a
  // default part would underline the host of a perfectly good link.
  const segments: UrlSegment[] =
    url === undefined
      ? []
      : part === undefined
        ? [{ text: url, highlight: false }]
        : highlightUrlPart(url, part);

  const failing = failingStepId(run);
  // Numbered the way the trace numbers it, so the button names where it lands
  // rather than saying "the failing step" and moving the reader blind.
  const failingNumber =
    failing === undefined
      ? undefined
      : flattenStepTree(buildStepTree(run.steps)).find((node) => node.step.id === failing)?.number;

  const diagnosis = useCallback(
    () => buildDiagnosisReport(run, activeRedactor, { format: 'markdown' }),
    [run, activeRedactor],
  );
  const explanation = useCallback(() => buildSenderExplanation(run), [run]);

  const severityCounts = SEVERITY_SEQUENCE.map((severity) => ({
    severity,
    count: run.findings.filter((finding) => finding.severity === severity).length,
  })).filter((entry) => entry.count > 0);

  return (
    <section
      className={`verdict tone tone-${tone}`}
      role="status"
      aria-live="polite"
      // The headline is usually a finding's title, which never contains the
      // outcome word, so the name states the verdict explicitly. The visible
      // outcome chip carries the same word for everybody else.
      aria-label={`Verdict: ${OUTCOME_WORD[run.outcome]}. ${headline}`}
    >
      <div className="verdict-lead">
        <span className="verdict-icon">
          <StatusIcon tone={tone} size={30} />
        </span>
        <div className="verdict-lead-text">
          <h2 className="verdict-headline">{headline}</h2>
          <p className="verdict-subline">{subline(run, requests)}</p>
        </div>
      </div>

      {url !== undefined && (
        <div className="verdict-url">
          <p className="verdict-url-label">
            <span>The address in this link</span>
            {part !== undefined && (
              <span className="verdict-url-part">Marked: the {URL_PART_WORD[part]}</span>
            )}
          </p>
          <p className="verdict-url-value">
            <span className="opaque-value">
              {segments.map((segment, index) =>
                segment.highlight ? (
                  <mark key={index} className="verdict-url-mark">
                    {segment.text}
                  </mark>
                ) : (
                  <span key={index}>{segment.text}</span>
                ),
              )}
            </span>
            <CopyButton value={url} label="Copy address" />
          </p>
        </div>
      )}

      <ul className="verdict-facts">
        <li>
          <Chip tone={outcome}>
            <StatusIcon tone={outcome} size={12} />
            {OUTCOME_WORD[run.outcome]}
          </Chip>
        </li>
        <li>
          <Chip
            tone="info"
            title={
              run.networkUsed
                ? 'Every request is listed in the trace below.'
                : 'Nothing was sent anywhere. This verdict came from the link itself.'
            }
          >
            {run.networkUsed
              ? `${requests} request${requests === 1 ? '' : 's'} made`
              : 'No request was made'}
          </Chip>
        </li>
        {severityCounts.length === 0 ? (
          <li>
            <Chip tone="info">Nothing flagged</Chip>
          </li>
        ) : (
          severityCounts.map((entry) => (
            <li key={entry.severity}>
              <Chip tone={toneForSeverity(entry.severity)}>
                <StatusIcon tone={toneForSeverity(entry.severity)} size={12} />
                {severityCount(entry.severity, entry.count)}
              </Chip>
            </li>
          ))
        )}
        {leading !== undefined && (
          <li>
            <Chip tone={toneForSeverity(leading.severity)}>{AUDIENCE_LABEL[leading.audience]}</Chip>
          </li>
        )}
        {/* Plain rather than a chip, and last: the elapsed time is the least
            load-bearing fact here, and a skip-toned chip carrying 11px text is
            3.96:1 in the light theme, under the floor for text that size. */}
        <li className="verdict-fact-plain">
          {elapsedMs === undefined ? (
            'Still running'
          ) : (
            <>
              Took <Duration ms={elapsedMs} />
            </>
          )}
        </li>
      </ul>

      <div className="verdict-actions">
        <CopyButton value={diagnosis} label="Copy diagnosis" className="verdict-action-key" />
        <CopyButton value={explanation} label="Explain to the sender" />
        {failing !== undefined && (
          <Button onClick={() => jump(failing)}>
            <CornerDownRight size={13} aria-hidden />
            <span>
              {failingNumber === undefined
                ? 'Jump to the failing step'
                : `Jump to step ${failingNumber}`}
            </span>
          </Button>
        )}
      </div>
    </section>
  );
}
