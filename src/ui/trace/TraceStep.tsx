/**
 * One row of the trace, collapsed or expanded.
 *
 * The header is a single `<button aria-expanded aria-controls>` spanning the
 * whole row, and the body is a region labelled by it. That is the disclosure
 * pattern, deliberately not a custom accordion: one button and one region is
 * what screen readers already understand, and a chevron-only hit target is what
 * makes a projected demo miss.
 *
 * The body always carries the step's own one-line explanation, including on a
 * pass. Expanding a green step is meant to be rewarding, because that is what
 * makes somebody read the specification at a table.
 */
import { useId, type ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { clsx } from 'clsx';
import { formatBytes } from '../../core/bytes';
import type { TraceRun, TraceStep as TraceStepRecord } from '../../core/trace';
import { CopyButton, Duration, StatusIcon, toneForStatus } from '../primitives';
import { EvidenceView } from './EvidenceView';
import { FindingCard } from './FindingCard';
import { stepDomId, stepMetrics, stepToText, type DurationBar } from './format';

export interface TraceStepProps {
  step: TraceStepRecord;
  run: TraceRun;
  /** "5", or "5.2" for a nested step. Supplied by the list. */
  number?: string;
  bar?: DurationBar;
  expanded?: boolean;
  /** True when this row holds the list's single tab stop. */
  active?: boolean;
  onToggle?: (id: string) => void;
  onSelect?: (id: string) => void;
  /** Applied to copied text. The clipboard is outside the tab. */
  mask?: (text: string) => string;
  /** Nested steps, rendered inside this row's list item. */
  children?: ReactNode;
}

export function TraceStep({
  step,
  run,
  number,
  bar,
  expanded = false,
  active = false,
  onToggle,
  onSelect,
  mask,
  children,
}: TraceStepProps): ReactNode {
  const headerId = useId();
  const bodyId = useId();
  const tone = toneForStatus(step.status);
  const metrics = stepMetrics(step);
  const findings = run.findings.filter((finding) => step.findingIds.includes(finding.id));

  return (
    <li id={stepDomId(step.id)} className={clsx('trace-item', expanded && 'is-open')}>
      <div className={clsx('step', 'tone', `tone-${tone}`, active && 'is-active')}>
        <span className="step-rail" aria-hidden />
        <div className="step-head-row">
          <button
            type="button"
            id={headerId}
            className="step-head"
            aria-expanded={expanded}
            aria-controls={bodyId}
            tabIndex={active ? 0 : -1}
            onFocus={() => onSelect?.(step.id)}
            onClick={() => onToggle?.(step.id)}
          >
            <StatusIcon tone={tone} />
            {number !== undefined && <span className="step-number mono">{number}</span>}
            <span className="step-title">{step.title}</span>
            <span className="step-metrics">
              <span className="metric mono" title="HTTP status">
                {metrics.status === undefined ? '--' : metrics.status}
              </span>
              <span className="metric mono">
                {step.durationMs === undefined ? '--' : <Duration ms={step.durationMs} />}
              </span>
              <span className="metric mono" title="Bytes handled">
                {metrics.bytes === undefined ? '--' : formatBytes(metrics.bytes)}
              </span>
            </span>
            {/* The number beside it carries the same fact, so the bar is decoration
                for the eye scanning a column and is hidden from assistive tech. */}
            <span className="step-bar" aria-hidden>
              {bar !== undefined && bar.totalPercent > 0 && (
                <span className="step-bar-fill" style={{ width: `${bar.totalPercent}%` }}>
                  {bar.hasNetwork && bar.waitingPercent > 0 && (
                    <span className="step-bar-wait" style={{ width: `${bar.waitingPercent}%` }} />
                  )}
                </span>
              )}
            </span>
            <ChevronRight
              size={14}
              aria-hidden
              className={clsx('step-chevron', expanded && 'is-open')}
            />
          </button>
          <CopyButton
            className="step-copy"
            label="Copy step"
            value={() =>
              stepToText(step, run.findings, {
                ...(number === undefined ? {} : { number }),
                ...(mask === undefined ? {} : { mask }),
              })
            }
          />
        </div>

        <div
          id={bodyId}
          role="region"
          aria-labelledby={headerId}
          hidden={!expanded}
          className="step-body"
        >
          {expanded && (
            <>
              {step.summary !== undefined && <p className="step-summary">{step.summary}</p>}
              {step.evidence.map((evidence, index) => (
                <EvidenceView key={index} evidence={evidence} />
              ))}
              {findings.map((finding) => (
                <FindingCard key={finding.id} finding={finding} />
              ))}
            </>
          )}
        </div>
      </div>
      {children}
    </li>
  );
}
