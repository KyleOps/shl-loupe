/**
 * The generic layer: one leaf formatter per FHIR datatype, and the tree that
 * uses them.
 *
 * This is not a fallback in the apologetic sense. It is the component every
 * specific renderer uses as its own `Fields` view, which is what removes any
 * temptation to leave a resource type unhandled: an unplanned-for type still
 * renders as something a human can read, with every value formatted by its
 * datatype rather than dumped as JSON.
 *
 * The leaf formatters live here rather than in a shared module of their own
 * because this is the lowest layer that needs them: `ResourceCard` and every
 * specific renderer import them from here, and nothing here imports either of
 * those, so the dependency graph stays a tree.
 *
 * Three rules earn their keep:
 *
 *  1. **Order is derived**, not alphabetical and not JSON order. Alphabetical
 *     puts `abatementDateTime` above `code`, which is how every generic FHIR
 *     renderer ends up looking machine-generated.
 *  2. **A value never loses its wire form.** A date shows a human form and keeps
 *     the source string in its tooltip; a `urn:uuid` is shortened on screen and
 *     copied in full. This is a debugger, and the argument at the table is
 *     usually about the exact bytes.
 *  3. **Absent and empty are different.** A `_`-prefixed primitive sibling
 *     carrying a data-absent-reason is rendered as a stated absence, in the
 *     element's own row, never as a blank cell. AU PS mandates elements AU Core
 *     leaves optional, so that extension is the CONFORMANT answer for a source
 *     that had no value, and it must not look like a gap.
 */
import { useState, type ReactNode } from 'react';
import { ExternalLink, Link2, Link2Off, Paperclip } from 'lucide-react';
import { formatBytes } from '../../core/bytes';
import { Chip, CodeBlock, CopyButton, Disclosure, FieldTable, type FieldRow } from '../primitives';
import type { BundleIndex, IndexedEntry, Resolution } from './BundleIndex';
import {
  addressLine,
  annotationText,
  arrField,
  asArray,
  asRecord,
  asString,
  codeableConcept,
  codeToWords,
  dosageText,
  elementAbsentReason,
  humanName,
  identifier,
  primitiveAbsentReason,
  periodText,
  quantityText,
  rangeText,
  ratioText,
  referenceLabel,
  renderableDate,
  resourceTypeOf,
  shortenUrn,
  strField,
  summariseResource,
  timingScheduleText,
  ucumNote,
  type ConceptDisplay,
  type FhirNode,
} from './display';

/** What a leaf needs to resolve a reference and to say where it came from. */
export interface RenderContext {
  index: BundleIndex;
  /** The entry the value belongs to, which is the base a relative reference uses. */
  from?: IndexedEntry | undefined;
}

// ---------------------------------------------------------------------------
// Codes and concepts
// ---------------------------------------------------------------------------

/** The codes behind a concept, as mono chips. Identity, not decoration. */
export function CodeChips({ concept }: { concept: ConceptDisplay }): ReactNode {
  if (concept.codes.length === 0) return null;
  return (
    <span className="code-chips">
      {concept.codes.map((code) => (
        <span
          key={`${code.system ?? ''}|${code.code}`}
          className="code-chip mono"
          title={
            code.system === undefined
              ? `Code ${code.code}, with no system stated, so nothing can look it up.`
              : `${code.system}#${code.code}${code.display === undefined ? '' : ` (${code.display})`}${
                  code.version === undefined ? '' : ` version ${code.version}`
                }`
          }
        >
          {code.label}
        </span>
      ))}
    </span>
  );
}

export function ConceptValue({ value }: { value: unknown }): ReactNode {
  const concept = codeableConcept(value);
  if (concept === undefined) return <Absent>No concept</Absent>;
  return (
    <span className="concept">
      <span className={concept.codeOnly ? 'concept-text is-code-only' : 'concept-text'}>
        {concept.text}
      </span>
      <CodeChips concept={concept} />
      {concept.codeOnly && (
        <span className="concept-note">
          Nothing in this concept carried a human label, so what is shown is the code itself. Loupe
          does not invent a display for a code it cannot look up.
        </span>
      )}
    </span>
  );
}

export function ConceptList({ value }: { value: unknown }): ReactNode {
  const items = asArray(value);
  if (items.length === 0) return <Absent>None</Absent>;
  return (
    <span className="concept-list">
      {items.map((item, position) => (
        <ConceptValue key={position} value={item} />
      ))}
    </span>
  );
}

/** A FHIR `code` primitive: a closed kebab-case vocabulary, so re-casing is safe. */
export function CodeValue({ value }: { value: unknown }): ReactNode {
  const code = asString(value);
  if (code === undefined) return <Absent>Not stated</Absent>;
  return (
    <span className="code-value">
      {codeToWords(code)} <span className="code-chip mono">{code}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Dates, quantities, primitives
// ---------------------------------------------------------------------------

export function DateValue({ value }: { value: unknown }): ReactNode {
  const date = renderableDate(value);
  if (date === undefined) return <Absent>Not stated</Absent>;
  return (
    <span className="date-value">
      <span title={date.raw}>{date.text}</span>
      {date.precision !== 'time' && date.shape === 'dateTime' && (
        <span className="value-note">stated to {date.precision} precision</span>
      )}
      {date.note !== undefined && <span className="value-note">{date.note}</span>}
    </span>
  );
}

export function QuantityValue({ value }: { value: unknown }): ReactNode {
  const text = quantityText(value);
  if (text === undefined) return <Absent>No value</Absent>;
  const note = ucumNote(value);
  return (
    <span className="quantity-value">
      {text}
      {note !== undefined && <span className="value-note">{note}</span>}
    </span>
  );
}

export function BooleanValue({ value }: { value: unknown }): ReactNode {
  if (typeof value !== 'boolean') return <Absent>Not stated</Absent>;
  return (
    <span>
      {value ? 'Yes' : 'No'} <span className="code-chip mono">{String(value)}</span>
    </span>
  );
}

export function IdentifierValue({ value }: { value: unknown }): ReactNode {
  const parsed = identifier(value);
  if (parsed === undefined) return <Absent>No identifier</Absent>;
  return (
    <span className="identifier-value">
      <span className="identifier-label">{parsed.label}</span>
      <span className="mono">{parsed.value}</span>
      {parsed.use !== undefined && <Chip>{parsed.use}</Chip>}
      <CopyButton value={parsed.value} label="Copy" />
      {parsed.system !== undefined && (
        <span className="value-note mono" title={parsed.system}>
          {parsed.system}
        </span>
      )}
    </span>
  );
}

export function AnnotationValue({ value }: { value: unknown }): ReactNode {
  const note = annotationText(value);
  if (note === undefined) return <Absent>Empty note</Absent>;
  return (
    <figure className="annotation">
      <blockquote>{note.text}</blockquote>
      {note.caption !== undefined && <figcaption>{note.caption}</figcaption>}
    </figure>
  );
}

/**
 * An opaque or long value: shortened on screen, complete on the clipboard.
 * Truncating without the copy button would make the tool useless for the
 * argument it exists to settle.
 */
export function OpaqueValue({ value }: { value: string }): ReactNode {
  const short = shortenUrn(value);
  return (
    <span className="opaque-pair">
      <span className="opaque-value" title={value}>
        {short}
      </span>
      {short !== value && <CopyButton value={value} label="Copy in full" />}
    </span>
  );
}

/**
 * A primitive as text, and nothing else.
 *
 * The point is what it refuses: `String(someUnknown)` on an object produces
 * "[object Object]", which is how a viewer ends up printing that where a dose
 * number should be. A caller that gets `undefined` back knows the payload put
 * something other than a primitive in the element, which is worth saying.
 */
export function primitiveText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

/** Nothing here, and saying so is the job. Never an empty cell. */
export function Absent({ children }: { children: ReactNode }): ReactNode {
  return <span className="absent-value">{children}</span>;
}

/**
 * A stated absence. The wording matters: "the source said so" is a different
 * fact from "nothing arrived", and the two must not read the same.
 */
export function StatedAbsence({
  reason,
  element,
}: {
  reason: string;
  element?: string | undefined;
}): ReactNode {
  return (
    <span className="stated-absence">
      <Chip tone="info">{codeToWords(reason)}</Chip>
      <span className="value-note">
        {element === undefined
          ? 'The source stated this value absent rather than leaving it out.'
          : `The source stated ${element} absent rather than leaving it out, using a data-absent-reason of ${reason}. That is the conformant answer for a mandated element nobody supplied, and it is not the same as a gap.`}
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// References: positive signal only
// ---------------------------------------------------------------------------

/**
 * A reference, resolved through the bundle index and never guessed at.
 *
 * A resolved reference is a real tap-through: the button reveals the target
 * inline, which is the only honest affordance in a viewer with no server behind
 * it. An unresolved one renders the row with no tap-through and a quiet note, so
 * the reader can tell the difference between "the bundle does not carry this"
 * and "the viewer could not be bothered". A conformant Platypus summary ships
 * around 26 unresolvable references by design, so treating one as an error would
 * report a defect that is not there.
 */
export function ReferenceValue({
  value,
  context,
  label,
}: {
  value: unknown;
  context: RenderContext;
  label?: string | undefined;
}): ReactNode {
  const [open, setOpen] = useState(false);
  const resolution = context.index.resolve(value, context.from);
  const fallback = label ?? referenceLabel(value);
  const raw = strField(value, 'reference');

  if (resolution.kind === 'resolved' || resolution.kind === 'contained') {
    const target = resolution.kind === 'resolved' ? resolution.entry.resource : resolution.resource;
    const type =
      resolution.kind === 'resolved' ? resolution.entry.resourceType : resolution.resourceType;
    const name = fallback ?? summariseResource(target);
    return (
      <span className="reference">
        <button
          type="button"
          className="ref-chip is-resolved"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <Link2 size={12} aria-hidden />
          <span>{name}</span>
          <span className="ref-type mono">{type}</span>
        </button>
        <span className="ref-how">
          {resolution.kind === 'contained'
            ? 'contained in this resource'
            : `matched by ${resolution.via === 'fullUrl' ? 'fullUrl' : resolution.via === 'type-id' ? 'ResourceType/id' : 'the entry base URL'}`}
        </span>
        {resolution.kind === 'resolved' && resolution.note !== undefined && (
          <span className="value-note">{resolution.note}</span>
        )}
        {open && (
          <span className="ref-peek">
            <FieldTable
              dense
              rows={[
                { key: 'type', mono: false, value: type },
                { key: 'summary', mono: false, value: summariseResource(target) },
                ...(raw === undefined
                  ? []
                  : [{ key: 'reference', mono: false, value: <OpaqueValue value={raw} /> }]),
              ]}
            />
            <Disclosure summary="This resource as JSON">
              <CodeBlock language="json">{JSON.stringify(target, null, 2)}</CodeBlock>
            </Disclosure>
          </span>
        )}
      </span>
    );
  }

  if (resolution.kind === 'external') {
    return (
      <span className="reference">
        <span className="ref-chip is-external">
          <ExternalLink size={12} aria-hidden />
          <span>{fallback ?? resolution.url}</span>
        </span>
        <span className="value-note">
          This points outside the payload. Loupe does not fetch it: a viewer that silently
          dereferences a URL out of an untrusted payload is a beacon.
        </span>
        <CopyButton value={resolution.url} label="Copy URL" />
      </span>
    );
  }

  return (
    <span className="reference">
      <span className="ref-chip is-unresolved">
        <Link2Off size={12} aria-hidden />
        <span>{fallback ?? 'Not carried by this bundle'}</span>
      </span>
      <span className="value-note">{unresolvedNote(resolution)}</span>
    </span>
  );
}

function unresolvedNote(resolution: Resolution): string {
  return resolution.kind === 'unresolved' ? resolution.detail : '';
}

/** Every item of a `0..*` reference element, each resolved on its own. */
export function ReferenceList({
  value,
  context,
  max = 12,
}: {
  value: unknown;
  context: RenderContext;
  max?: number;
}): ReactNode {
  const items = asArray(value);
  if (items.length === 0) return <Absent>None</Absent>;
  const shown = items.slice(0, max);
  return (
    <span className="reference-list">
      {shown.map((item, position) => (
        <ReferenceValue key={position} value={item} context={context} />
      ))}
      {items.length > shown.length && (
        <span className="value-note">
          and {items.length - shown.length} more, not listed here to keep the row readable
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Attachments, in summary form
// ---------------------------------------------------------------------------

/**
 * An attachment as one line.
 *
 * Deliberately not the previewer: decoding, sniffing and previewing bytes lives
 * in `DocumentReferenceView`, which imports these formatters. Rendering a full
 * preview from inside the generic tree would make the graph circular, and it
 * would also mean a `Fields` view quietly decoding megabytes.
 */
export function AttachmentSummary({ value }: { value: unknown }): ReactNode {
  const record = asRecord(value);
  if (record === undefined) return <Absent>No attachment</Absent>;
  const contentType = strField(record, 'contentType');
  const title = strField(record, 'title');
  const size = record['size'];
  const data = strField(record, 'data');
  const url = strField(record, 'url');
  return (
    <span className="attachment-summary">
      <Paperclip size={12} aria-hidden />
      <span>{title ?? contentType ?? 'Untitled attachment'}</span>
      {contentType !== undefined && <span className="code-chip mono">{contentType}</span>}
      {typeof size === 'number' && <span className="value-note">{formatBytes(size)} declared</span>}
      {data !== undefined && (
        <span className="value-note">carries its own bytes ({data.length} base64 characters)</span>
      )}
      {url !== undefined && (
        <span className="value-note mono" title={url}>
          {shortenUrn(url)}
        </span>
      )}
      {data === undefined && url === undefined && (
        <span className="value-note">
          Neither data nor url, so there is nothing to open. Usually a broken export.
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// The generic dispatcher
// ---------------------------------------------------------------------------

const DATE_KEYS =
  /^(date|.*Date|.*DateTime|.*Instant|recorded|issued|authoredOn|created|timestamp|birthDate|deceasedDateTime|lastOccurrence|expirationDate|occurrenceDateTime)$/;

/**
 * Format one value by its shape, with the key as a hint.
 *
 * The key hint is not laziness: `HumanName` and `Address` are both objects with
 * a `text` member, and `Identifier` and `Quantity` are both `system` plus
 * `value`, so shape alone cannot separate them. Where shape is decisive it wins;
 * where it is not, the element name is the evidence FHIR itself gives us.
 */
export function LeafValue({
  value,
  fieldKey,
  context,
  depth = 0,
}: {
  value: unknown;
  fieldKey: string;
  context: RenderContext;
  depth?: number;
}): ReactNode {
  if (value === null) return <Absent>null</Absent>;

  if (Array.isArray(value)) {
    // Array.isArray narrows unknown to any[], which would spread `any` through
    // every leaf below it. The annotation puts it back to unknown, where the
    // rest of this file expects to start from.
    const items: unknown[] = value;
    if (items.length === 0) return <Absent>Empty list</Absent>;
    if (items.length === 1) {
      return <LeafValue value={items[0]} fieldKey={fieldKey} context={context} depth={depth} />;
    }
    return (
      <Disclosure summary={`${items.length} items`}>
        <ol className="leaf-list">
          {items.slice(0, 40).map((item, position) => (
            <li key={position}>
              <LeafValue value={item} fieldKey={fieldKey} context={context} depth={depth + 1} />
            </li>
          ))}
        </ol>
        {items.length > 40 && (
          <p className="value-note">
            and {items.length - 40} more; open the JSON view for the complete list
          </p>
        )}
      </Disclosure>
    );
  }

  if (typeof value === 'boolean') return <BooleanValue value={value} />;
  if (typeof value === 'number') return <span className="mono">{value}</span>;

  if (typeof value === 'string') {
    if (DATE_KEYS.test(fieldKey)) return <DateValue value={value} />;
    if (fieldKey === 'div') return <span className="value-note">Narrative, shown above</span>;
    if (/^(https?:|urn:)/i.test(value) || value.length > 48) return <OpaqueValue value={value} />;
    if (fieldKey === 'status' || fieldKey.endsWith('Status') || fieldKey === 'intent') {
      return <CodeValue value={value} />;
    }
    return <span>{value}</span>;
  }

  const record = asRecord(value);
  if (record === undefined) return <Absent>Not a value Loupe can read</Absent>;

  // Shape tests, ordered so the decisive ones run first. `coding` and
  // `system`+`code` are tested BEFORE anything keying on `display`, because a
  // `Coding` carries a `display` too: read that as a reference and every code in
  // the payload renders as an unresolvable link.
  if ('coding' in record || ('text' in record && Object.keys(record).length === 1)) {
    return <ConceptValue value={record} />;
  }
  if ('system' in record && 'code' in record && !('value' in record)) {
    return <ConceptValue value={{ coding: [record] }} />;
  }
  // A reference that names its target with no URL is legal and real (AU
  // eRequesting uses it), so `display` alone is enough to treat this as one.
  if ('reference' in record || 'display' in record) {
    return <ReferenceValue value={record} context={context} />;
  }
  if ('value' in record && typeof record['value'] === 'number') {
    return <QuantityValue value={record} />;
  }
  if ('value' in record && typeof record['value'] === 'string' && 'system' in record) {
    return <IdentifierValue value={record} />;
  }
  if ('start' in record || 'end' in record) {
    const text = periodText(record);
    return text === undefined ? <Absent>Empty period</Absent> : <span>{text}</span>;
  }
  if ('low' in record || 'high' in record) {
    const text = rangeText(record);
    return text === undefined ? <Absent>Empty range</Absent> : <span>{text}</span>;
  }
  if ('numerator' in record) {
    const text = ratioText(record);
    return text === undefined ? <Absent>Empty ratio</Absent> : <span>{text}</span>;
  }
  if ('contentType' in record || 'data' in record || fieldKey === 'attachment') {
    return <AttachmentSummary value={record} />;
  }
  if (fieldKey === 'name' || 'family' in record || 'given' in record) {
    const text = humanName(record);
    if (text !== undefined) {
      const use = strField(record, 'use');
      return (
        <span>
          {text}
          {use !== undefined && <Chip>{use}</Chip>}
        </span>
      );
    }
  }
  if (fieldKey === 'address' || 'line' in record || 'postalCode' in record) {
    const text = addressLine(record);
    if (text !== undefined) return <span>{text}</span>;
  }
  if ('authorString' in record || ('text' in record && 'time' in record)) {
    return <AnnotationValue value={record} />;
  }
  if ('repeat' in record || 'event' in record) {
    const schedule = timingScheduleText(record) ?? renderableDate(record)?.text;
    if (schedule !== undefined) return <span>{schedule}</span>;
  }
  if (fieldKey === 'dosage' || fieldKey === 'dosageInstruction') {
    const text = dosageText(record);
    if (text !== undefined) return <span>{text}</span>;
  }
  if (fieldKey === 'telecom' && 'value' in record) {
    const system = strField(record, 'system');
    return (
      <span>
        {strField(record, 'value') ?? '(no value)'}
        {system !== undefined && <Chip>{system}</Chip>}
      </span>
    );
  }

  // Nothing recognised it, so it is rendered as its own small tree. The depth cap
  // is the guard against a payload that nests itself, which a `contained`
  // resource pointing back at its container really does.
  if (depth >= 5) {
    return <CodeBlock language="json">{JSON.stringify(record, null, 2)}</CodeBlock>;
  }
  return <ElementTree node={record} context={context} depth={depth + 1} />;
}

// ---------------------------------------------------------------------------
// Field order
// ---------------------------------------------------------------------------

/**
 * The order a clinician reads a resource in. Derived, so two payloads from
 * different vendors line up on screen, which is the point of a comparison tool.
 */
const PRIORITY: readonly string[] = [
  'status',
  'clinicalStatus',
  'verificationStatus',
  'docStatus',
  'intent',
  'criticality',
  'code',
  'medicationCodeableConcept',
  'medicationReference',
  'vaccineCode',
  'type',
  'category',
  'class',
  'severity',
  'subject',
  'patient',
  'beneficiary',
  'value',
  'component',
  'interpretation',
  'referenceRange',
  'dataAbsentReason',
  'effective',
  'onset',
  'abatement',
  'performed',
  'occurrence',
  'recordedDate',
  'recorded',
  'dateAsserted',
  'date',
  'issued',
  'authoredOn',
  'period',
  'reaction',
  'manifestation',
  'dosage',
  'dosageInstruction',
  'reasonCode',
  'reasonReference',
  'conclusion',
  'result',
  'presentedForm',
  'performer',
  'requester',
  'recorder',
  'asserter',
  'author',
  'custodian',
  'agent',
  'activity',
  'target',
  'encounter',
  'location',
  'note',
];

/** Housekeeping, always last and always collapsed. */
const TRAILING: readonly string[] = [
  'identifier',
  'contained',
  'extension',
  'modifierExtension',
  'text',
  'meta',
  'implicitRules',
  'language',
  'id',
  'resourceType',
];

const PRIORITY_RANK = new Map(PRIORITY.map((key, position) => [key, position]));
const TRAILING_RANK = new Map(TRAILING.map((key, position) => [key, 900 + position]));

/**
 * A choice element's rank comes from its base, so `effectiveDateTime` and
 * `effectivePeriod` sort where `effective` does rather than falling to the tail
 * with everything the priority list does not name.
 */
function rankOf(key: string, jsonIndex: number): number {
  const trailing = TRAILING_RANK.get(key);
  if (trailing !== undefined) return trailing;
  const exact = PRIORITY_RANK.get(key);
  if (exact !== undefined) return exact;
  for (const [base, rank] of PRIORITY_RANK) {
    if (key.startsWith(base) && key.length > base.length) {
      const next = key.charAt(base.length);
      if (next === next.toUpperCase()) return rank + 0.5;
    }
  }
  return 500 + jsonIndex;
}

export interface OrderedField {
  key: string;
  value: unknown;
  /** Set when the element is absent and its `_` sibling says why. */
  absentReason?: string;
}

/**
 * Every field of a resource, in reading order, with the `_`-prefixed primitive
 * siblings folded into the elements they describe.
 *
 * Exported and pure so the ordering can be tested without a DOM, and so a
 * specific renderer can ask "what did I not show?" rather than guessing.
 */
export function orderedFields(node: FhirNode): OrderedField[] {
  const keys = Object.keys(node);
  const fields: OrderedField[] = [];
  const seen = new Set<string>();

  for (const key of keys) {
    if (key.startsWith('_') || key === 'resourceType') continue;
    const value = node[key];
    if (value === undefined) continue;
    seen.add(key);
    const absent = primitiveAbsentReason(node, key);
    fields.push({ key, value, ...(absent === undefined ? {} : { absentReason: absent }) });
  }

  // A `_x` sibling with no `x` is the interesting case: the element is absent and
  // the payload says why. Walking named fields alone drops it silently, which is
  // the exact defect this whole file exists to prevent.
  for (const key of keys) {
    if (!key.startsWith('_')) continue;
    const element = key.slice(1);
    if (seen.has(element)) continue;
    const reason = primitiveAbsentReason(node, element);
    if (reason === undefined) continue;
    fields.push({ key: element, value: undefined, absentReason: reason });
  }

  const order = new Map(keys.map((key, position) => [key, position]));
  return fields.sort(
    (a, b) => rankOf(a.key, order.get(a.key) ?? 999) - rankOf(b.key, order.get(b.key) ?? 999),
  );
}

// ---------------------------------------------------------------------------
// The trees
// ---------------------------------------------------------------------------

/** A nested element (not a resource) as a small table. */
export function ElementTree({
  node,
  context,
  depth = 0,
}: {
  node: FhirNode;
  context: RenderContext;
  depth?: number;
}): ReactNode {
  const absent = elementAbsentReason(node);
  const rows: FieldRow[] = orderedFields(node).map((field) => ({
    key: field.key,
    // `mono: false` because these values are prose and chips, not opaque bytes.
    // FieldTable's default is the monospace treatment, which is right for a JWE
    // segment and wrong for a medicine name.
    mono: false,
    value:
      field.value === undefined && field.absentReason !== undefined ? (
        <StatedAbsence reason={field.absentReason} element={field.key} />
      ) : (
        <LeafValue value={field.value} fieldKey={field.key} context={context} depth={depth} />
      ),
    ...(field.absentReason === undefined ? {} : { tone: 'info' as const }),
  }));
  if (absent !== undefined) {
    rows.unshift({
      key: 'data absent',
      mono: false,
      value: <StatedAbsence reason={absent} />,
      tone: 'info',
    });
  }
  if (rows.length === 0) return <Absent>Empty element</Absent>;
  return (
    <div className="element-tree">
      <FieldTable dense rows={rows} />
    </div>
  );
}

/**
 * A whole resource as a typed key/value tree. This is the `Fields` view of every
 * card in the app, and the primary view of a type nobody wrote a renderer for.
 */
export function ResourceTree({
  resource,
  context,
}: {
  resource: FhirNode;
  context: RenderContext;
}): ReactNode {
  const fields = orderedFields(resource);
  const main = fields.filter(
    (field) => field.key !== 'extension' && field.key !== 'modifierExtension',
  );
  const extensions = [
    ...arrField(resource, 'extension'),
    ...arrField(resource, 'modifierExtension'),
  ];
  const modifiers = arrField(resource, 'modifierExtension').length;

  const rows: FieldRow[] = main.map((field) => ({
    key: field.key,
    mono: false,
    value:
      field.value === undefined && field.absentReason !== undefined ? (
        <StatedAbsence reason={field.absentReason} element={field.key} />
      ) : (
        <LeafValue value={field.value} fieldKey={field.key} context={context} />
      ),
    ...(field.absentReason === undefined ? {} : { tone: 'info' as const }),
  }));

  return (
    <div className="resource-tree">
      <FieldTable rows={rows} />
      {extensions.length > 0 && (
        <Disclosure
          summary={`${extensions.length} ${extensions.length === 1 ? 'extension' : 'extensions'}${
            modifiers > 0 ? `, ${modifiers} of them modifying` : ''
          }`}
        >
          {modifiers > 0 && (
            <p className="value-note">
              A modifier extension changes the meaning of what it is attached to, so a receiver that
              does not understand one is required to reject the resource rather than ignore it.
            </p>
          )}
          <FieldTable
            dense
            rows={extensions.map((extension, position) => ({
              key: extensionLabel(extension, position),
              mono: false,
              value: <ExtensionValue extension={extension} context={context} />,
            }))}
          />
        </Disclosure>
      )}
    </div>
  );
}

function extensionLabel(extension: unknown, position: number): string {
  const url = strField(extension, 'url');
  if (url === undefined) return `extension ${position + 1}`;
  const tail = url.split('/').pop();
  return tail === undefined || tail === '' ? url : tail;
}

function ExtensionValue({
  extension,
  context,
}: {
  extension: unknown;
  context: RenderContext;
}): ReactNode {
  const record = asRecord(extension);
  if (record === undefined) return <Absent>Not an extension</Absent>;
  const url = strField(record, 'url');
  const valueKey = Object.keys(record).find((key) => key.startsWith('value'));
  const nested = arrField(record, 'extension');
  return (
    <span className="extension-value">
      {valueKey !== undefined && (
        <LeafValue value={record[valueKey]} fieldKey={valueKey} context={context} />
      )}
      {valueKey === undefined && nested.length > 0 && (
        <FieldTable
          dense
          rows={nested.map((child, position) => ({
            key: extensionLabel(child, position),
            mono: false,
            value: <ExtensionValue extension={child} context={context} />,
          }))}
        />
      )}
      {valueKey === undefined && nested.length === 0 && <Absent>No value</Absent>}
      {url !== undefined && (
        <span className="value-note mono" title={url}>
          {url}
        </span>
      )}
    </span>
  );
}

// ---------------------------------------------------------------------------
// The unhandled type
// ---------------------------------------------------------------------------

/**
 * A resource of a type with no dedicated renderer.
 *
 * The body is the same tree every other card offers, plus one line saying
 * plainly that this type has no purpose-built view. That sentence is the whole
 * point: the incumbent viewer logs a console warning and renders nothing, which
 * is indistinguishable from the server never having sent the resource.
 */
export function UnknownResource({
  resource,
  context,
}: {
  resource: FhirNode;
  context: RenderContext;
}): ReactNode {
  const type = resourceTypeOf(resource);
  return (
    <div className="unknown-resource">
      <p className="value-note">
        {type === undefined
          ? 'This object carries no resourceType, so Loupe cannot tell what it is meant to be. Every field it does carry is below.'
          : `Loupe has no purpose-built view for ${type}, so every field it carries is listed below, formatted by datatype. Nothing has been dropped.`}
      </p>
      <ResourceTree resource={resource} context={context} />
    </div>
  );
}

/**
 * One line for a resource in the "no dedicated renderer" list, so a reader can
 * tell what is in the payload without opening each one.
 */
export function UnhandledRow({
  entry,
  context,
}: {
  entry: IndexedEntry;
  context: RenderContext;
}): ReactNode {
  const empty = Object.keys(entry.resource).length === 0;
  return (
    <Disclosure
      summary={
        <span className="unhandled-summary">
          <span className="unhandled-type mono">{entry.resourceType}</span>
          <span>
            {empty
              ? 'Entry with no resource. That is legal in a search result and forbidden in a document.'
              : summariseResource(entry.resource)}
          </span>
        </span>
      }
      meta={
        entry.fullUrl === undefined ? undefined : (
          <span className="value-note mono" title={entry.fullUrl}>
            {shortenUrn(entry.fullUrl)}
          </span>
        )
      }
    >
      {empty ? (
        <p className="value-note">
          The bundle entry is present but carries no resource, so there is nothing to render. Loupe
          counts it anyway, because an entry that vanishes from the screen makes the count here
          disagree with the count on the wire.
        </p>
      ) : (
        <>
          <ResourceTree resource={entry.resource} context={context} />
          <Disclosure summary="This resource as JSON">
            <CodeBlock language="json">{JSON.stringify(entry.resource, null, 2)}</CodeBlock>
          </Disclosure>
        </>
      )}
    </Disclosure>
  );
}
