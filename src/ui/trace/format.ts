/**
 * Pure shaping and formatting for the trace view.
 *
 * These live apart from the components because every one of them is a claim
 * about somebody else's data: an epoch second that might be milliseconds, a URL
 * that might not parse, a status code that might be the browser's stand-in for
 * "there was no response at all". Each is far easier to argue about in a test
 * than on a screen, and at an event the argument is the point.
 */
import type {
  Audience,
  Evidence,
  Finding,
  HttpResponseRecord,
  RunOutcome,
  Severity,
  TraceRun,
  TraceStep,
} from '../../core/trace';
import type { Tone } from '../primitives';

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/**
 * An epoch-seconds instant as a phrase relative to now. Used for `exp`, which
 * is the one field in a link whose meaning changes while you look at it.
 */
export function relativeTime(seconds: number, nowMs: number = Date.now()): string {
  if (!Number.isFinite(seconds)) return 'an unknown time';
  const deltaMs = seconds * 1000 - nowMs;
  if (Math.abs(deltaMs) < 1000) return 'now';
  const [count, unit] = splitDuration(Math.abs(deltaMs));
  const phrase = `${count} ${unit}${count === 1 ? '' : 's'}`;
  return deltaMs > 0 ? `in ${phrase}` : `${phrase} ago`;
}

function splitDuration(ms: number): [number, string] {
  const secondsTotal = Math.round(ms / 1000);
  if (secondsTotal < 60) return [secondsTotal, 'second'];
  const minutes = Math.round(secondsTotal / 60);
  if (minutes < 60) return [minutes, 'minute'];
  const hours = Math.round(minutes / 60);
  if (hours < 24) return [hours, 'hour'];
  const days = Math.round(hours / 24);
  if (days < 365) return [days, 'day'];
  return [Math.round(days / 365), 'year'];
}

// ---------------------------------------------------------------------------
// HTTP status
// ---------------------------------------------------------------------------

/**
 * Status 0 is not a status. It is what the Fetch spec hands script when the
 * request never produced a response, or produced one script may not read, and
 * rendering it as a number is how a viewer ends up telling a participant their
 * server returned zero.
 */
export function statusLabel(status: number): string {
  return status === 0 ? 'no response' : String(status);
}

export function statusPillTone(status: number): Tone {
  if (status === 0) return 'fail';
  if (status < 200) return 'info';
  if (status < 300) return 'pass';
  // A redirect that survives to here is worth flagging rather than colouring
  // green: fetch follows redirects itself, so seeing a 3xx means something
  // unusual happened, and a redirected manifest POST loses its body.
  if (status < 400) return 'warn';
  return 'fail';
}

/**
 * Whether the response came from another origin, and so whether the header list
 * shown is the full one. `undefined` means the transport did not record a type,
 * in which case the UI says nothing rather than guessing.
 */
export function isCrossOriginResponse(response: HttpResponseRecord): boolean | undefined {
  switch (response.responseType) {
    case undefined:
      return undefined;
    case 'basic':
      return false;
    default:
      return true;
  }
}

// ---------------------------------------------------------------------------
// Pointing at the offending part of a URL
// ---------------------------------------------------------------------------

export type UrlPart = 'scheme' | 'host' | 'port';

export interface UrlSegment {
  text: string;
  highlight: boolean;
}

/**
 * Split a URL so the offending part can be marked in place. Concatenating the
 * segments always reproduces the input exactly, which is what lets the banner
 * point at `localhost` inside the real URL rather than paraphrasing it.
 */
export function highlightUrlPart(url: string, part: UrlPart): UrlSegment[] {
  const bounds = partBounds(url, part);
  if (!bounds) return [{ text: url, highlight: false }];
  const [start, end] = bounds;
  const segments: UrlSegment[] = [];
  if (start > 0) segments.push({ text: url.slice(0, start), highlight: false });
  segments.push({ text: url.slice(start, end), highlight: true });
  if (end < url.length) segments.push({ text: url.slice(end), highlight: false });
  return segments;
}

function partBounds(url: string, part: UrlPart): [number, number] | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const schemeEnd = url.indexOf(':');
  if (schemeEnd <= 0) return undefined;
  if (part === 'scheme') return [0, schemeEnd];

  // The authority is located by position, not by searching the whole string for
  // the hostname: `https://localhost:5173/x?next=localhost` would otherwise get
  // its query parameter underlined and the reader sent to the wrong place.
  const authorityStart = url.startsWith('//', schemeEnd + 1) ? schemeEnd + 3 : schemeEnd + 1;
  const rest = url.slice(authorityStart);
  const delimiter = rest.search(/[/?#]/);
  const authority = delimiter === -1 ? rest : rest.slice(0, delimiter);
  // Userinfo before an `@` is not the host, and a link carrying userinfo is one
  // of the things this tool reports, so it must not be mistaken for one.
  const hostStart = authority.lastIndexOf('@') + 1;
  const hostPortion = authority.slice(hostStart);

  if (part === 'host') {
    const host = hostText(hostPortion);
    if (host.length === 0) return undefined;
    return [authorityStart + hostStart, authorityStart + hostStart + host.length];
  }

  if (parsed.port === '') return undefined;
  const colon = hostPortion.lastIndexOf(':');
  if (colon === -1) return undefined;
  return [authorityStart + hostStart + colon + 1, authorityStart + hostStart + hostPortion.length];
}

function hostText(hostPortion: string): string {
  if (hostPortion.startsWith('[')) {
    const close = hostPortion.indexOf(']');
    return close === -1 ? hostPortion : hostPortion.slice(0, close + 1);
  }
  return hostPortion.split(':')[0] ?? '';
}

/**
 * Which part of the URL a rule is complaining about. Driven by rule id rather
 * than by parsing the finding's prose, so a reworded finding cannot silently
 * stop underlining anything.
 */
export function highlightPartForRule(ruleId: string): UrlPart | undefined {
  switch (ruleId) {
    case 'SHL-URL-LOOPBACK':
    case 'SHL-URL-PRIVATE-NETWORK':
    case 'SHL-URL-UNRESOLVABLE-NAME':
    case 'SHL-URL-OVERLAY-NETWORK':
    case 'SHL-URL-EPHEMERAL-TUNNEL':
    case 'SHL-URL-PREVIEW-DEPLOYMENT':
    case 'SHL-URL-IP-LITERAL':
    case 'SHL-URL-USERINFO':
      return 'host';
    case 'SHL-URL-NOT-HTTPS':
      return 'scheme';
    case 'SHL-URL-DEV-PORT':
      return 'port';
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Steps: shape, numbering, metrics, bars
// ---------------------------------------------------------------------------

export interface StepNode {
  step: TraceStep;
  /** "3", or "3.1" for a step nested under another. Stable across machines. */
  number: string;
  children: StepNode[];
}

/**
 * Nest steps under their `parentId` and number them.
 *
 * Two defences, both because a trace that silently drops a step is worse than
 * one whose indentation is wrong: a `parentId` naming a step that was never
 * recorded is treated as a root, and any step left unreachable (a parent cycle)
 * is appended at the root rather than disappearing.
 */
export function buildStepTree(steps: readonly TraceStep[]): StepNode[] {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const roots: TraceStep[] = [];
  const childrenOf = new Map<string, TraceStep[]>();

  for (const step of steps) {
    const parentId = step.parentId;
    if (parentId === undefined || parentId === step.id || !byId.has(parentId)) {
      roots.push(step);
      continue;
    }
    const existing = childrenOf.get(parentId);
    if (existing) existing.push(step);
    else childrenOf.set(parentId, [step]);
  }

  const seen = new Set<string>();
  const build = (step: TraceStep, number: string): StepNode => {
    seen.add(step.id);
    return {
      step,
      number,
      children: (childrenOf.get(step.id) ?? []).map((child, index) =>
        build(child, `${number}.${index + 1}`),
      ),
    };
  };

  const nodes = roots.map((step, index) => build(step, `${index + 1}`));
  for (const step of steps) {
    if (seen.has(step.id)) continue;
    nodes.push({ step, number: `${nodes.length + 1}`, children: [] });
  }
  return nodes;
}

/** Every node in a tree, depth first, in render order. */
export function flattenStepTree(nodes: readonly StepNode[]): StepNode[] {
  const out: StepNode[] = [];
  const walk = (list: readonly StepNode[]): void => {
    for (const node of list) {
      out.push(node);
      walk(node.children);
    }
  };
  walk(nodes);
  return out;
}

export interface StepMetrics {
  /** Present only when a response was recorded. Otherwise the column reads "--". */
  status?: number;
  /** Bytes the step handled: a response body, or a recorded byte string. */
  bytes?: number;
  /** True when the step issued a request or recorded a response. */
  hasNetwork: boolean;
}

export function stepMetrics(step: TraceStep): StepMetrics {
  let status: number | undefined;
  let bytes: number | undefined;
  let hasNetwork = false;
  for (const evidence of step.evidence) {
    if (evidence.type === 'request') hasNetwork = true;
    if (evidence.type === 'response') {
      hasNetwork = true;
      status = evidence.response.status;
      if (evidence.response.bodyBytes !== undefined) bytes = evidence.response.bodyBytes;
    }
    if (evidence.type === 'bytes' && bytes === undefined) bytes = evidence.length;
  }
  return {
    ...(status === undefined ? {} : { status }),
    ...(bytes === undefined ? {} : { bytes }),
    hasNetwork,
  };
}

export interface DurationBar {
  /** Width of the bar as a share of the longest step in the run, 0 to 100. */
  totalPercent: number;
  /**
   * Share of this bar spent waiting on the network, 0 to 100. Rendered as the
   * light fill, with the rest solid, following DevTools' two-tone convention.
   * This is the only split our data supports honestly: cross-origin
   * `PerformanceResourceTiming` is zeroed without `Timing-Allow-Origin`, so a
   * DNS/connect/TTFB breakdown would be fabricated.
   */
  waitingPercent: number;
  /** False when nothing was fetched, so the bar is all Loupe's own work. */
  hasNetwork: boolean;
}

export function durationBarWidths(steps: readonly TraceStep[]): Map<string, DurationBar> {
  const longest = steps.reduce((max, step) => Math.max(max, step.durationMs ?? 0), 0);
  const bars = new Map<string, DurationBar>();
  for (const step of steps) {
    const total = step.durationMs ?? 0;
    let waiting = 0;
    let hasNetwork = false;
    for (const evidence of step.evidence) {
      if (evidence.type === 'request') hasNetwork = true;
      if (evidence.type === 'response') {
        hasNetwork = true;
        waiting += evidence.response.durationMs ?? 0;
      }
    }
    bars.set(step.id, {
      // A 2% floor rather than 0: a 3 ms step still happened, and a bar that
      // rounds away reads as a step that did nothing.
      totalPercent: longest > 0 && total > 0 ? Math.max(2, Math.round((total / longest) * 100)) : 0,
      waitingPercent: total > 0 ? Math.min(100, Math.round((waiting / total) * 100)) : 0,
      hasNetwork,
    });
  }
  return bars;
}

/** The DOM id of a step row, so the verdict banner can jump to one. */
export function stepDomId(stepId: string): string {
  return `trace-step-${stepId}`;
}

// ---------------------------------------------------------------------------
// Run level
// ---------------------------------------------------------------------------

export function countRequests(run: TraceRun): number {
  let count = 0;
  for (const step of run.steps) {
    for (const evidence of step.evidence) if (evidence.type === 'request') count += 1;
  }
  return count;
}

const SEVERITY_ORDER: readonly Severity[] = ['fatal', 'error', 'warning', 'info', 'good'];

/** The finding the verdict banner leads with. */
export function worstFinding(findings: readonly Finding[]): Finding | undefined {
  for (const severity of SEVERITY_ORDER) {
    const match = findings.find((finding) => finding.severity === severity);
    if (match) return match;
  }
  return undefined;
}

export const SEVERITY_WORD: Record<Severity, string> = {
  fatal: 'Fatal',
  error: 'Error',
  warning: 'Warning',
  info: 'Note',
  good: 'Good',
};

export const OUTCOME_WORD: Record<RunOutcome, string> = {
  running: 'Running',
  opened: 'Opened',
  partial: 'Partly opened',
  blocked: 'Blocked',
  failed: 'Failed',
};

export function outcomeTone(outcome: RunOutcome): Tone {
  switch (outcome) {
    case 'opened':
      return 'pass';
    case 'partial':
      return 'warn';
    case 'blocked':
      return 'info';
    case 'failed':
      return 'fail';
    default:
      return 'running';
  }
}

/**
 * The headline when nothing went wrong. Separate from the finding path because
 * "it worked" still deserves a sentence, and because the wording differs by how
 * much of the link opened.
 */
export function outcomeHeadline(outcome: RunOutcome): string {
  switch (outcome) {
    case 'opened':
      return 'This link opens.';
    case 'partial':
      return 'Part of this link opened.';
    case 'blocked':
      return 'This link cannot go further without a person.';
    case 'failed':
      return 'This link did not open.';
    default:
      return 'Opening this link.';
  }
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

export const AUDIENCE_LABEL: Record<Audience, string> = {
  you: 'Over to you',
  sender: 'Over to the sender',
  server: 'Over to the server operator',
  nobody: 'Nobody has to act',
};

/**
 * The sentence that ends the "it works for me" argument at a table. Naming the
 * side that can fix a thing is the whole reason findings carry an audience.
 */
export const AUDIENCE_ACTION: Record<Audience, string> = {
  you: 'Something on this machine, or in what was pasted, has to change.',
  sender: 'Whoever minted this link has to republish it. Nothing done here will fix it.',
  server: 'The sharing server has to change. Its operator is the only one who can.',
  nobody: 'This is recorded for information.',
};

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/** The heading above one piece of evidence. */
export function evidenceLabel(evidence: Evidence): string {
  switch (evidence.type) {
    case 'note':
      return 'Note';
    case 'kv':
      return 'Fields';
    case 'json':
    case 'text':
    case 'bytes':
      return evidence.label;
    case 'request':
      return 'Request';
    case 'response':
      return 'Response';
    case 'command':
      return evidence.label;
    case 'citation':
      return 'Specification';
  }
}

// ---------------------------------------------------------------------------
// Copy as text
// ---------------------------------------------------------------------------

export interface StepTextOptions {
  number?: string;
  /**
   * Applied to every value on the way out. The caller passes the run's redactor,
   * because a step's evidence holds the real key on purpose and the clipboard is
   * outside the tab.
   */
  mask?: (text: string) => string;
}

/**
 * One step as flat, greppable text. The artefact that resolves an issue at an
 * event is the paste into chat, not the screenshot, so this is a first-class
 * output rather than a debug dump.
 */
export function stepToText(
  step: TraceStep,
  findings: readonly Finding[],
  options: StepTextOptions = {},
): string {
  const mask = options.mask ?? ((text: string) => text);
  const lines: string[] = [];
  const prefix = options.number === undefined ? '' : `step ${options.number}  `;
  const duration = step.durationMs === undefined ? '' : `  ${step.durationMs} ms`;
  lines.push(`${prefix}${step.title}  [${step.status}]${duration}`);
  if (step.summary !== undefined) lines.push(step.summary);

  for (const evidence of step.evidence) {
    lines.push('');
    switch (evidence.type) {
      case 'note':
        lines.push(`note: ${mask(evidence.text)}`);
        break;
      case 'kv':
        lines.push('fields:');
        for (const row of evidence.rows) {
          const status = row.status === undefined ? '' : ` [${row.status}]`;
          lines.push(`  ${row.key} = ${mask(row.value)}${status}`);
          if (row.note !== undefined) lines.push(`    ${mask(row.note)}`);
        }
        break;
      case 'json':
        lines.push(`${evidence.label}:`);
        lines.push(indent(mask(JSON.stringify(evidence.value, null, 2))));
        break;
      case 'text':
        lines.push(`${evidence.label}:`);
        lines.push(indent(mask(evidence.value)));
        break;
      case 'bytes':
        lines.push(`${evidence.label}: ${evidence.length} bytes`);
        lines.push(`  ${evidence.preview}`);
        break;
      case 'request':
        lines.push(`request: ${evidence.request.method} ${mask(evidence.request.url)}`);
        for (const [name, value] of Object.entries(evidence.request.headers)) {
          lines.push(`  ${name}: ${mask(value)}`);
        }
        if (evidence.request.body !== undefined) lines.push(indent(mask(evidence.request.body)));
        break;
      case 'response': {
        const response = evidence.response;
        const timing = response.durationMs === undefined ? '' : ` in ${response.durationMs} ms`;
        lines.push(
          `response: ${statusLabel(response.status)} ${response.statusText ?? ''}${timing}`.trimEnd(),
        );
        for (const [name, value] of Object.entries(response.headers)) {
          lines.push(`  ${name}: ${mask(value)}`);
        }
        if (response.networkError !== undefined) {
          lines.push(`  browser said: ${response.networkError}`);
        }
        if (response.bodyPreview !== undefined) lines.push(indent(mask(response.bodyPreview)));
        break;
      }
      case 'command':
        lines.push(`${evidence.label} (${evidence.shell}):`);
        lines.push(indent(mask(evidence.command)));
        break;
      case 'citation':
        lines.push(`spec: ${evidence.citation.spec}, ${evidence.citation.section}`);
        lines.push(`  ${evidence.citation.url}`);
        break;
    }
  }

  const raised = findings.filter((finding) => step.findingIds.includes(finding.id));
  for (const finding of raised) {
    lines.push('');
    lines.push(`${finding.severity}: ${finding.ruleId}  ${finding.title}`);
    lines.push(indent(mask(finding.detail)));
    if (finding.remedy !== undefined) lines.push(indent(`remedy: ${mask(finding.remedy)}`));
  }

  return lines.join('\n');
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

// ---------------------------------------------------------------------------
// Reading the link back out of the run
// ---------------------------------------------------------------------------

/**
 * The decoded payload, as the run recorded it.
 *
 * Read back out of the trace rather than passed alongside it, so the verdict
 * banner can point at the real manifest URL for a link that was stopped before
 * any request was made. That case is the whole product thesis, and it is exactly
 * the case where there is no response to read the URL from.
 */
function decodedPayload(run: TraceRun): Record<string, unknown> | undefined {
  for (const step of run.steps) {
    if (step.kind !== 'shlink.decode') continue;
    for (const evidence of step.evidence) {
      if (evidence.type !== 'json') continue;
      const value = evidence.value;
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    }
  }
  return undefined;
}

export function manifestUrlFromRun(run: TraceRun): string | undefined {
  const url = decodedPayload(run)?.['url'];
  if (typeof url === 'string' && url.length > 0) return url;
  // No decoded payload: a pasted manifest or a bare JWE. The first request made
  // is then the closest thing to an address this run has.
  for (const step of run.steps) {
    for (const evidence of step.evidence) {
      if (evidence.type === 'request') return evidence.request.url;
    }
  }
  return undefined;
}

/** The link's `exp`, in epoch seconds, when it carried one. */
export function linkExpiryFromRun(run: TraceRun): number | undefined {
  const exp = decodedPayload(run)?.['exp'];
  return typeof exp === 'number' && Number.isFinite(exp) ? exp : undefined;
}

/**
 * The finding the verdict banner leads with: only one that says something is
 * wrong. A run whose worst finding is an informational note leads with its
 * outcome instead, because "Opened" is the headline there.
 */
export function leadingFinding(findings: readonly Finding[]): Finding | undefined {
  const worst = worstFinding(findings);
  if (!worst) return undefined;
  return worst.severity === 'fatal' || worst.severity === 'error' || worst.severity === 'warning'
    ? worst
    : undefined;
}

/** The step the banner's jump lands on. */
export function failingStepId(run: TraceRun): string | undefined {
  const leading = leadingFinding(run.findings);
  if (leading?.stepId !== undefined) return leading.stepId;
  const stopped = run.steps.find((step) => step.status === 'fail' || step.status === 'blocked');
  return stopped?.id ?? run.steps.find((step) => step.status === 'warn')?.id;
}
