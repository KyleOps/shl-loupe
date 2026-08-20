/**
 * What kind of link is this, and how far can SHLoupe take it.
 *
 * This component exists because of one sentence in `src/core/variants.ts`: a
 * different profile is never "invalid". Four ecosystems reuse the same payload
 * shape over three incompatible retrieval protocols, so a viewer that decodes a
 * payload and then assumes the HL7 manifest POST reports a perfectly good WHO or
 * IHE link as broken. The fix is to say which family it is, out loud, before
 * anything is retrieved.
 *
 * So the collapsed state answers the question somebody actually asks at a table
 * ("what is this, and will this tool open it?"), and the expanded state carries
 * the four things that settle an argument: what differs from the HL7 baseline,
 * what SHLoupe can do with it, what SHLoupe cannot, and which observation licensed
 * each of those claims. A capability is never dressed up as a verdict: "SHLoupe
 * cannot finish this" and "this link is broken" are different sentences, and
 * conflating them is the incumbent viewer's whole bug.
 */
import type { ReactNode } from 'react';
import {
  Callout,
  Chip,
  Disclosure,
  FieldTable,
  StatusIcon,
  toneForSeverity,
  type FieldRow,
  type Tone,
} from './primitives';
import {
  FAMILY_LABEL,
  PROTOCOL_LABEL,
  SUPPORT_LABEL,
  type RetrievalProtocol,
  type VariantIdentification,
  type VariantSupport,
} from '../core/variants';

/**
 * `unsupported` is deliberately not a failure tone. SHLoupe not going further is
 * a fact about SHLoupe, and painting it red would make this component tell the
 * lie the module it renders was written to avoid.
 */
const SUPPORT_TONE: Record<VariantSupport, Tone> = {
  full: 'pass',
  partial: 'warn',
  'decode-only': 'info',
  unsupported: 'skip',
};

/**
 * A chip is eleven pixels of uppercase, so it needs a phrase rather than the
 * sentence in `SUPPORT_LABEL`. The sentence is still shown, in the body, where
 * it has room to be read.
 */
const SUPPORT_CHIP: Record<VariantSupport, string> = {
  full: 'Full support',
  partial: 'Partial support',
  'decode-only': 'Read only',
  unsupported: 'Not processed',
};

export interface VariantBadgeProps {
  /** Straight from `identifyVariant`. */
  identification: VariantIdentification;
  /** Expanded on first render. Use for a run whose variant is not the baseline. */
  defaultOpen?: boolean;
}

export function VariantBadge({ identification, defaultOpen }: VariantBadgeProps): ReactNode {
  const { variant, protocol, signals } = identification;
  const tone = SUPPORT_TONE[variant.support];

  const facts: FieldRow[] = [
    { key: 'Family', value: FAMILY_LABEL[variant.family], mono: false },
    { key: 'Retrieval', value: protocolValue(protocol, variant.protocol), mono: false },
    { key: 'In SHLoupe', value: SUPPORT_LABEL[variant.support], mono: false, tone },
    { key: 'Variant id', value: variant.id },
  ];
  if (identification.profiles !== undefined && identification.profiles.length > 0) {
    facts.push({
      key: 'meta.profile',
      value: (
        <ul className="variant-profiles">
          {identification.profiles.map((profile) => (
            <li key={profile} className="opaque-value">
              {profile}
            </li>
          ))}
        </ul>
      ),
    });
  }

  return (
    <div className="variant-badge">
      <Disclosure
        defaultOpen={defaultOpen ?? false}
        summary={
          <span className="variant-summary">
            <Chip tone={tone}>
              <StatusIcon tone={tone} size={12} />
              {SUPPORT_CHIP[variant.support]}
            </Chip>
            <strong className="variant-name">{variant.name}</strong>
          </span>
        }
        meta={<Chip tone="info">{FAMILY_LABEL[variant.family]}</Chip>}
      >
        <p className="variant-blurb">{inlineCode(variant.summary)}</p>

        <FieldTable rows={facts} dense />

        <h4 className="variant-heading">What differs from the HL7 baseline</h4>
        {variant.differences.length === 0 ? (
          <p className="variant-blurb">
            Nothing. This is the HL7 SMART Health Links payload, unmodified. Several
            &ldquo;flavours&rdquo; turn out to be exactly this, with a different governance story
            around them.
          </p>
        ) : (
          <ul className="variant-list">
            {variant.differences.map((difference) => (
              <li key={difference}>{inlineCode(difference)}</li>
            ))}
          </ul>
        )}

        {variant.support !== 'full' && (
          <Callout tone={tone} title={`${SUPPORT_LABEL[variant.support]}. Missing here:`}>
            {variant.missing.length === 0 ? (
              <p className="variant-blurb">
                The catalogue does not record what is missing, which is itself a gap worth
                reporting: this variant is named but its limits are not written down.
              </p>
            ) : (
              <ul className="variant-list">
                {variant.missing.map((gap) => (
                  <li key={gap}>{inlineCode(gap)}</li>
                ))}
              </ul>
            )}
          </Callout>
        )}

        {signals.length > 0 && (
          <>
            <h4 className="variant-heading">How SHLoupe decided</h4>
            <FieldTable
              rows={signals.map((signal) => ({
                key: 'Saw',
                value: inlineCode(signal.observation),
                mono: false,
                tone: toneForSeverity(signal.severity),
                note: (
                  <>
                    {inlineCode(signal.meaning)}
                    {signal.citation !== undefined && (
                      <>
                        {' '}
                        <CitationLink
                          spec={signal.citation.spec}
                          section={signal.citation.section}
                          url={signal.citation.url}
                        />
                      </>
                    )}
                  </>
                ),
              }))}
            />
          </>
        )}

        {variant.citation !== undefined && (
          <p className="variant-source">
            Defined by{' '}
            <CitationLink
              spec={variant.citation.spec}
              section={variant.citation.section}
              url={variant.citation.url}
            />
            {variant.citation.quote !== undefined && (
              <>
                {' '}
                <q className="variant-quote">{variant.citation.quote}</q>
              </>
            )}
          </p>
        )}

        {identification.inner !== undefined && (
          <>
            <h4 className="variant-heading">The link inside the carrier</h4>
            <p className="variant-blurb">
              A carrier and its contents are identified separately, because an <code>HC1:</code>{' '}
              certificate says nothing about which retrieval protocol the link it holds expects.
            </p>
            {/* Recursion is bounded by the data: a carrier holds a link, and a
                link holds nothing. It is written recursively anyway so a
                three-level carrier, if one is ever profiled, renders rather
                than silently stopping at the level this component knew about. */}
            <VariantBadge identification={identification.inner} defaultOpen />
          </>
        )}
      </Disclosure>
    </div>
  );
}

function CitationLink({
  spec,
  section,
  url,
}: {
  spec: string;
  section: string;
  url: string;
}): ReactNode {
  return (
    <a href={url} target="_blank" rel="noreferrer noopener">
      {spec}, {section}
    </a>
  );
}

/**
 * The payload's own `protocol` can differ from its variant's default, because
 * the `U` flag changes retrieval without changing which family the link belongs
 * to. When they disagree, both are shown: a reader comparing the trace against
 * the catalogue would otherwise see a contradiction and have no way to resolve
 * it.
 */
function protocolValue(actual: RetrievalProtocol, catalogued: RetrievalProtocol): ReactNode {
  if (actual === catalogued) return PROTOCOL_LABEL[actual];
  return (
    <>
      {PROTOCOL_LABEL[actual]} <span className="variant-aside">(this payload)</span>{' '}
      {PROTOCOL_LABEL[catalogued]} <span className="variant-aside">(the family default)</span>
    </>
  );
}

const CODE_SPAN = /`([^`]+)`/g;

/**
 * The catalogue's prose is authored with Markdown backticks around wire-level
 * names, so the same strings can go verbatim into an exported report or a chat
 * message. Rendered raw in a component, those backticks show up on screen, so
 * they are turned into `<code>` here rather than being stripped from the data,
 * which would cost the report its formatting to fix the UI's.
 */
function inlineCode(text: string): ReactNode {
  if (!text.includes('`')) return text;
  const parts: ReactNode[] = [];
  let cursor = 0;
  // `matchAll` over a /g regex, because `exec` in a loop carries lastIndex on a
  // module-level regex and would resume mid-string on the next call.
  for (const match of text.matchAll(CODE_SPAN)) {
    const at = match.index;
    if (at > cursor) parts.push(text.slice(cursor, at));
    parts.push(<code key={`${String(at)}-${match[1] ?? ''}`}>{match[1]}</code>);
    cursor = at + match[0].length;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}
