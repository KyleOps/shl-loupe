/**
 * One finding.
 *
 * The attribution line is the reason this component exists. At an event the
 * argument is always "it works for me", and a finding that names the side which
 * can actually fix the thing ends that argument in one line. So audience is
 * rendered as prominently as severity, and never dropped for space.
 *
 * The rule id is rendered in mono with its own copy button because it is the
 * token a chat message quotes and a test plan cites, and it has to survive
 * being retyped from a projected screen.
 */
import type { ReactNode } from 'react';
import type { Finding } from '../../core/trace';
import { Chip, CopyButton, StatusIcon, toneForSeverity } from '../primitives';
import { CitationView } from './EvidenceView';
import { AUDIENCE_ACTION, AUDIENCE_LABEL, SEVERITY_WORD } from './format';

export function FindingCard({ finding }: { finding: Finding }): ReactNode {
  const tone = toneForSeverity(finding.severity);
  return (
    <article className={`finding tone tone-${tone}`}>
      <header className="finding-head">
        <Chip tone={tone}>
          <StatusIcon tone={tone} size={12} />
          {SEVERITY_WORD[finding.severity]}
        </Chip>
        <h4 className="finding-title">{finding.title}</h4>
      </header>

      <p className="finding-detail">{finding.detail}</p>

      {finding.remedy !== undefined && (
        <p className="finding-remedy">
          <strong>Next:</strong> {finding.remedy}
        </p>
      )}

      <p className="finding-audience">
        <strong>{AUDIENCE_LABEL[finding.audience]}.</strong>{' '}
        {AUDIENCE_ACTION[finding.audience]}
      </p>

      {finding.citation !== undefined && <CitationView citation={finding.citation} />}

      <p className="finding-rule">
        <span className="mono">{finding.ruleId}</span>
        <CopyButton value={finding.ruleId} label="Copy id" />
      </p>
    </article>
  );
}
