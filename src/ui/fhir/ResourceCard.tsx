/**
 * The card every resource is rendered in, and the three views it always offers.
 *
 * `Rendered | Fields | JSON` is one component doing triple duty, and it is what
 * removes the temptation to leave a type unhandled: the worst case for a type
 * nobody wrote a renderer for is that it opens on `Fields`, which is still a
 * typed, ordered, datatype-formatted view rather than a wall of JSON.
 *
 * The header is what somebody reads out loud across a table: the type, then the
 * identity (`fullUrl` when the bundle gave it one, otherwise `Type/id`) in mono
 * with a copy button, then what the resource CLAIMS about itself as profile
 * chips. A claim is worth showing precisely because this tool cannot check it: a
 * browser cannot do profile validation, so the honest presentation is "this is
 * what the payload says of itself", never a conformance verdict.
 */
import { useState, type ReactNode } from 'react';
import { clsx } from 'clsx';
import {
  Chip,
  CodeBlock,
  CopyButton,
  FieldTable,
  StatusIcon,
  type FieldRow,
  type Tone,
} from '../primitives';
import { ErrorBoundary } from './ErrorBoundary';
import type { IndexedEntry } from './BundleIndex';
import { ResourceTree, type RenderContext } from './UnknownResource';
import {
  absenceAssertion,
  profileName,
  profilesOf,
  resourceTypeOf,
  shortenUrn,
  strField,
  type FhirNode,
} from './display';

export type CardView = 'rendered' | 'fields' | 'json';

/**
 * What every purpose-built renderer is handed. Declared here rather than in the
 * registry so a renderer never has to import the registry that registers it,
 * which is what keeps the module graph a tree.
 */
export interface RendererProps {
  resource: FhirNode;
  context: RenderContext;
  /** The bundle entry, when this resource came from one. */
  entry?: IndexedEntry | undefined;
}

export type ResourceRenderer = (props: RendererProps) => ReactNode;

/**
 * A detail row. Thin over `FieldRow` for one reason: `FieldTable` treats a value
 * as opaque bytes unless told otherwise, which is right for a JWE segment and
 * wrong for a medicine name, so every renderer would otherwise have to remember
 * `mono: false` on every row.
 */
export interface DetailRow {
  key: string;
  value: ReactNode;
  note?: ReactNode;
  tone?: Tone | undefined;
  /** Opt back in to the monospace treatment for a genuinely opaque value. */
  mono?: boolean | undefined;
}

export function DetailTable({
  rows,
  dense,
}: {
  rows: readonly DetailRow[];
  dense?: boolean | undefined;
}): ReactNode {
  const mapped: FieldRow[] = rows.map((row) => ({
    key: row.key,
    value: row.value,
    mono: row.mono ?? false,
    ...(row.note === undefined ? {} : { note: row.note }),
    ...(row.tone === undefined ? {} : { tone: row.tone }),
  }));
  return <FieldTable rows={mapped} dense={dense} />;
}

export interface ResourceCardProps {
  resource: FhirNode;
  context: RenderContext;
  entry?: IndexedEntry | undefined;
  /** Overrides the type as the heading. Used when the resource states an absence. */
  title?: ReactNode;
  subtitle?: ReactNode;
  /** Status chips, severity chips: the axes a reader scans before the detail. */
  chips?: ReactNode;
  tone?: Tone | undefined;
  dense?: boolean | undefined;
  /** The purpose-built view. Absent means this type has no renderer yet. */
  children?: ReactNode;
}

export function ResourceCard({
  resource,
  context,
  entry,
  title,
  subtitle,
  chips,
  tone,
  dense,
  children,
}: ResourceCardProps): ReactNode {
  const [view, setView] = useState<CardView>(children === undefined ? 'fields' : 'rendered');
  const type = resourceTypeOf(resource) ?? 'Resource with no resourceType';
  const id = strField(resource, 'id');
  const identity = entry?.fullUrl ?? (id === undefined ? undefined : `${type}/${id}`);
  const profiles = profilesOf(resource);

  const views: CardView[] =
    children === undefined ? ['fields', 'json'] : ['rendered', 'fields', 'json'];

  return (
    <article
      className={clsx(
        'resource-card',
        dense && 'is-dense',
        tone !== undefined && `tone tone-${tone}`,
      )}
    >
      <header className="resource-head">
        <div className="resource-identity">
          <h3 className="resource-title">
            {tone !== undefined && tone !== 'info' && <StatusIcon tone={tone} />}
            {title ?? type}
          </h3>
          {title !== undefined && <span className="resource-type mono">{type}</span>}
          {identity !== undefined && (
            <span className="resource-key">
              <span className="mono" title={identity}>
                {shortenUrn(identity)}
              </span>
              <CopyButton value={identity} label="Copy id" />
            </span>
          )}
        </div>
        {subtitle !== undefined && <p className="resource-subtitle">{subtitle}</p>}
        <div className="resource-chips">
          {chips}
          {profiles.map((profile) => (
            <Chip key={profile} tone="info" title={`Claims conformance to ${profile}`}>
              {profileName(profile)}
            </Chip>
          ))}
          {entry?.fullUrl === undefined && entry !== undefined && (
            <Chip tone="warn" title="IPS and AU PS both make Bundle.entry.fullUrl 1..1">
              No fullUrl
            </Chip>
          )}
        </div>
        <div className="resource-views" role="group" aria-label={`How to view this ${type}`}>
          {views.map((option) => (
            <button
              key={option}
              type="button"
              className={clsx('view-tab', view === option && 'is-current')}
              aria-pressed={view === option}
              onClick={() => setView(option)}
            >
              {option === 'rendered' ? 'Rendered' : option === 'fields' ? 'Fields' : 'JSON'}
            </button>
          ))}
        </div>
      </header>
      <div className="resource-body">
        {/* The table is its own failure unit: a value that defeats one formatter
            costs this card, not the section around it. */}
        <ErrorBoundary label={`this ${type}`} unit="table" subject={resource}>
          {view === 'rendered' && children}
          {view === 'fields' && <ResourceTree resource={resource} context={context} />}
          {view === 'json' && (
            <CodeBlock language="json" maxHeight={420}>
              {JSON.stringify(resource, null, 2)}
            </CodeBlock>
          )}
        </ErrorBoundary>
      </div>
    </article>
  );
}

/**
 * The card for a resource that states an absence rather than recording a
 * finding.
 *
 * "None recorded, and the source said so" is a different fact from an empty
 * section, and it is the classic viewer bug in the other direction: render a
 * SNOMED negation code as an ordinary row and you have told a clinician the
 * patient is allergic to something called "No known allergy".
 */
export function AbsenceAssertionCard({
  resource,
  context,
  entry,
}: {
  resource: FhirNode;
  context: RenderContext;
  entry?: IndexedEntry | undefined;
}): ReactNode {
  const absence = absenceAssertion(resource);
  if (absence === undefined) return null;
  const type = resourceTypeOf(resource) ?? 'Resource';
  // The two meanings are rendered differently on purpose, and this is the whole
  // point of the absence contract. `asserted-none` is a clinical statement:
  // somebody asked and the answer was none. `no-information` says only that
  // nobody asked, which carries exactly as much information as an empty section
  // and must never read as a clean bill of health.
  const assertedNone = absence.meaning === 'asserted-none';
  return (
    <ResourceCard
      resource={resource}
      context={context}
      entry={entry}
      tone={assertedNone ? 'pass' : 'warn'}
      title={absence.text}
      chips={
        <Chip tone={assertedNone ? 'pass' : 'warn'}>
          {assertedNone ? 'Stated absence' : 'No information'}
        </Chip>
      }
      dense
    >
      <p className="absence-explainer">
        {assertedNone
          ? `None recorded, and the source said so. This is a ${type} carrying a concept that asserts an absence, which is a positive statement by the sender rather than an empty list.`
          : `This ${type} states that no information is available, which is not the same as stating there is none. Nobody has answered the question, so this row carries as much clinical information as a blank section: none.`}{' '}
        {absence.basis === 'code'
          ? `Recognised from code ${absence.code ?? ''}`.trim() + '.'
          : 'Recognised from the wording of the concept, since the code was not one Loupe knows as a negation.'}
      </p>
      <DetailTable
        dense
        rows={[
          {
            key: 'means',
            value: assertedNone
              ? 'The sender states there is nothing to record here.'
              : 'The sender states only that it cannot say.',
          },
          {
            key: 'does not mean',
            value: assertedNone
              ? 'That nobody has asked. An unasked question is an empty section with no assertion in it.'
              : 'That the patient has none. Reading it that way turns "we do not know" into "there is nothing", which is the more dangerous of the two mistakes.',
            tone: assertedNone ? undefined : 'warn',
          },
          ...(absence.deprecatedCode === undefined
            ? []
            : [
                {
                  key: 'the code itself',
                  value: absence.deprecatedCode,
                  tone: 'warn' as const,
                },
              ]),
        ]}
      />
    </ResourceCard>
  );
}
