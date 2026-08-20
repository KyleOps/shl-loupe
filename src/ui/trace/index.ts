/**
 * The trace area's public surface.
 *
 * Components, their prop types, and the run-level formatting another area
 * legitimately needs (a payload pane says "opened" with the same word the
 * banner does, and points at a step by id the same way). Deliberately not a
 * re-export of everything in `format`: the step-shaping and copy-as-text
 * helpers are internal to this area, and a barrel that exposes them invites a
 * second trace renderer somewhere else.
 */
export { VerdictBanner, type VerdictBannerProps } from './VerdictBanner';
export { TraceList } from './TraceList';
export { TraceStep, type TraceStepProps } from './TraceStep';
export { EvidenceView, JsonTree, CitationView } from './EvidenceView';
export { FindingCard } from './FindingCard';

export {
  OUTCOME_WORD,
  SEVERITY_WORD,
  AUDIENCE_LABEL,
  AUDIENCE_ACTION,
  countRequests,
  failingStepId,
  leadingFinding,
  linkExpiryFromRun,
  manifestUrlFromRun,
  outcomeHeadline,
  outcomeTone,
  relativeTime,
  statusLabel,
  statusPillTone,
  stepDomId,
  worstFinding,
  type DurationBar,
  type StepNode,
  type UrlPart,
  type UrlSegment,
} from './format';
