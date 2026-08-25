/**
 * The clinical statements: `Condition`, `AllergyIntolerance`, `Observation`,
 * `Procedure`, `DiagnosticReport`, `Immunization`, `Specimen` and `Flag`.
 *
 * `Observation` is over half the entries in a typical summary, so most of the
 * care goes there. Four things it has to get right, each of which is a real
 * defect somewhere:
 *
 *  - **The `value[x]` choice.** Six datatypes can occupy the value slot, and a
 *    renderer that handles `valueQuantity` alone shows nothing for a smoking
 *    status, which is a `valueCodeableConcept`.
 *  - **`component[]`.** A blood pressure has no top-level value at all: both
 *    numbers are components. Reading only `value[x]` renders the one row a
 *    clinician most wants as empty.
 *  - **`dataAbsentReason`, on the observation and on a component.** A component
 *    with an absent reason is a stated absence, not a zero and not a gap. This is
 *    the third distinct absence mechanism in FHIR and they all render
 *    differently.
 *  - **A reference range with only a `high`.** Rendered as a range it reads as a
 *    target rather than a ceiling, which inverts the clinical meaning.
 *
 * `AllergyIntolerance` gets its own care for a different reason: `criticality`,
 * `clinicalStatus`, `type` and `category` are four separate axes that people
 * conflate, so each one gets its own chip with its own word.
 */
import type { ReactNode } from 'react';
import { Chip, Disclosure } from '../../primitives';
import {
  AbsenceAssertionCard,
  DetailTable,
  ResourceCard,
  type RendererProps,
} from '../ResourceCard';
import {
  Absent,
  AnnotationValue,
  ConceptList,
  ConceptValue,
  DateValue,
  primitiveText,
  QuantityValue,
  ReferenceValue,
  StatedAbsence,
  type RenderContext,
} from '../UnknownResource';
import { AttachmentPreview } from '../DocumentReferenceView';
import { Narrative } from '../Narrative';
import {
  absenceAssertion,
  arrField,
  asRecord,
  codeableConceptText,
  codeToWords,
  elementAbsentReason,
  pickChoice,
  primitiveAbsentReason,
  rangeText,
  strField,
  type FhirNode,
} from '../display';

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/**
 * A `[x]` choice element, rendered as the datatype that actually arrived, with
 * the suffix stated.
 *
 * The suffix matters in a debugger: `valueQuantity` and `valueString` are
 * different facts, and "5.9" with no unit is a different claim from "5.9 mmol/L".
 *
 * `suffix={false}` is for the one caller where that argument does not hold. Every
 * other call site is a `DetailTable` row whose key is the element name, so
 * `onset` in the key and `onsetDateTime` beside the value is a fact the row does
 * not otherwise carry. A `QuestionnaireResponse` answer has a QUESTION for its
 * key, and the same `valueString` printed after forty answers to forty questions
 * is not a fact, it is a texture. The element name is still one click away in
 * this card's own Fields and JSON views, which is what those views are for.
 */
export function ChoiceValue({
  node,
  base,
  context,
  suffix: showSuffix = true,
}: {
  node: FhirNode;
  base: string;
  context: RenderContext;
  suffix?: boolean | undefined;
}): ReactNode {
  const chosen = pickChoice(node, base);
  if (chosen === undefined) {
    const absent =
      primitiveAbsentReason(node, `${base}DateTime`) ?? primitiveAbsentReason(node, base);
    if (absent !== undefined) return <StatedAbsence reason={absent} element={`${base}[x]`} />;
    return <Absent>Not stated</Absent>;
  }
  const { suffix, value } = chosen;
  const rendered = (() => {
    switch (suffix) {
      case 'Quantity':
      case 'SimpleQuantity':
      case 'Age':
      case 'Count':
      case 'Duration':
        return <QuantityValue value={value} />;
      case 'CodeableConcept':
        return <ConceptValue value={value} />;
      case 'Boolean':
        return <span>{value === true ? 'Yes' : 'No'}</span>;
      case 'String':
      case 'Markdown':
        return <span>{String(value)}</span>;
      case 'Integer':
      case 'Decimal':
      case 'PositiveInt':
      case 'UnsignedInt':
        return <span className="mono">{String(value)}</span>;
      case 'Range':
        return <span>{rangeText(value) ?? 'Empty range'}</span>;
      case 'Reference':
        return <ReferenceValue value={value} context={context} />;
      case 'Attachment':
        return <AttachmentPreview attachment={value} context={context} />;
      case 'Period':
      case 'DateTime':
      case 'Date':
      case 'Instant':
      case 'Timing':
        return <DateValue value={value} />;
      default:
        return <span className="mono">{JSON.stringify(value)}</span>;
    }
  })();
  return (
    <span className="choice-value">
      {rendered}
      {showSuffix && (
        <span className="value-note mono">
          {base}
          {suffix}
        </span>
      )}
    </span>
  );
}

/** The one-line label for a resource's own concept, used as the card heading. */
function conceptHeading(resource: FhirNode, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const text = codeableConceptText(resource[key]);
    if (text !== undefined) return text;
  }
  return undefined;
}

function StatusChip({ value, label }: { value: unknown; label: string }): ReactNode {
  const text =
    codeableConceptText(value) ?? (typeof value === 'string' ? codeToWords(value) : undefined);
  if (text === undefined) return null;
  return <Chip title={`${label}: ${text}`}>{text}</Chip>;
}

/** Rows every clinical statement shares, so no renderer forgets the subject. */
function subjectRows(
  resource: FhirNode,
  context: RenderContext,
): Array<{ key: string; value: ReactNode }> {
  const subject = resource['subject'] ?? resource['patient'];
  return subject === undefined
    ? []
    : [{ key: 'subject', value: <ReferenceValue value={subject} context={context} /> }];
}

// ---------------------------------------------------------------------------
// Condition
// ---------------------------------------------------------------------------

export function ConditionCard(props: RendererProps): ReactNode {
  const { resource, context, entry } = props;
  if (absenceAssertion(resource) !== undefined) return <AbsenceAssertionCard {...props} />;
  return (
    <ResourceCard
      resource={resource}
      context={context}
      entry={entry}
      title={conceptHeading(resource, 'code') ?? 'Condition with no code'}
      chips={
        <>
          <StatusChip value={resource['clinicalStatus']} label="Clinical status" />
          <StatusChip value={resource['verificationStatus']} label="Verification status" />
          {arrField(resource, 'category').map((category, position) => (
            <StatusChip key={position} value={category} label="Category" />
          ))}
        </>
      }
    >
      <DetailTable
        rows={[
          { key: 'code', value: <ConceptValue value={resource['code']} /> },
          {
            key: 'clinicalStatus',
            value: <ConceptValue value={resource['clinicalStatus']} />,
            note: 'Whether the condition is active now. A separate axis from verificationStatus, which is about whether anyone has confirmed it.',
          },
          {
            key: 'verificationStatus',
            value:
              resource['verificationStatus'] === undefined ? (
                <Absent>Not stated</Absent>
              ) : (
                <ConceptValue value={resource['verificationStatus']} />
              ),
          },
          {
            key: 'category',
            value: <ConceptList value={resource['category']} />,
            note: 'problem-list-item and encounter-diagnosis are different claims: the first is a lasting entry on the problem list, the second is what was diagnosed at one visit.',
          },
          { key: 'onset', value: <ChoiceValue node={resource} base="onset" context={context} /> },
          ...(pickChoice(resource, 'abatement') === undefined
            ? []
            : [
                {
                  key: 'abatement',
                  value: <ChoiceValue node={resource} base="abatement" context={context} />,
                },
              ]),
          ...(strField(resource, 'recordedDate') === undefined
            ? []
            : [{ key: 'recordedDate', value: <DateValue value={resource['recordedDate']} /> }]),
          ...(resource['severity'] === undefined
            ? []
            : [{ key: 'severity', value: <ConceptValue value={resource['severity']} /> }]),
          ...(resource['bodySite'] === undefined
            ? []
            : [{ key: 'bodySite', value: <ConceptList value={resource['bodySite']} /> }]),
          ...subjectRows(resource, context),
          ...(resource['recorder'] === undefined
            ? []
            : [
                {
                  key: 'recorder',
                  value: <ReferenceValue value={resource['recorder']} context={context} />,
                },
              ]),
          ...(resource['asserter'] === undefined
            ? []
            : [
                {
                  key: 'asserter',
                  value: <ReferenceValue value={resource['asserter']} context={context} />,
                },
              ]),
        ]}
      />
      <NoteList resource={resource} />
    </ResourceCard>
  );
}

// ---------------------------------------------------------------------------
// AllergyIntolerance
// ---------------------------------------------------------------------------

export function AllergyCard(props: RendererProps): ReactNode {
  const { resource, context, entry } = props;
  if (absenceAssertion(resource) !== undefined) return <AbsenceAssertionCard {...props} />;
  const criticality = strField(resource, 'criticality');
  const reactions = arrField(resource, 'reaction');
  return (
    <ResourceCard
      resource={resource}
      context={context}
      entry={entry}
      title={conceptHeading(resource, 'code') ?? 'Allergy with no substance'}
      tone={criticality === 'high' ? 'warn' : undefined}
      chips={
        <>
          {criticality !== undefined && (
            <Chip tone={criticality === 'high' ? 'warn' : 'info'}>
              {codeToWords(criticality)} risk
            </Chip>
          )}
          <StatusChip value={resource['clinicalStatus']} label="Clinical status" />
          <StatusChip value={resource['verificationStatus']} label="Verification status" />
          {strField(resource, 'type') !== undefined && (
            <Chip>{codeToWords(strField(resource, 'type') as string)}</Chip>
          )}
        </>
      }
    >
      <DetailTable
        rows={[
          { key: 'code', value: <ConceptValue value={resource['code']} /> },
          {
            key: 'criticality',
            value:
              criticality === undefined ? <Absent>Not stated</Absent> : codeToWords(criticality),
            note: 'The worst case if the patient is exposed again. Not the same as severity, which describes what happened last time, and not the same as clinicalStatus, which is about whether the allergy is current.',
          },
          {
            key: 'type',
            value:
              strField(resource, 'type') === undefined ? (
                <Absent>Not stated</Absent>
              ) : (
                codeToWords(strField(resource, 'type') as string)
              ),
            note: 'allergy or intolerance: an immune response versus a reaction that is not immune-mediated.',
          },
          {
            key: 'category',
            value: <ConceptList value={resource['category']} />,
            note: 'food, medication, environment or biologic: what kind of thing the substance is.',
          },
          { key: 'onset', value: <ChoiceValue node={resource} base="onset" context={context} /> },
          ...(strField(resource, 'recordedDate') === undefined
            ? []
            : [{ key: 'recordedDate', value: <DateValue value={resource['recordedDate']} /> }]),
          ...subjectRows(resource, context),
          ...(resource['asserter'] === undefined
            ? []
            : [
                {
                  key: 'asserter',
                  value: <ReferenceValue value={resource['asserter']} context={context} />,
                  note: 'Who says so. A patient-asserted allergy and a clinician-asserted one carry different weight, and this is the only element that distinguishes them.',
                },
              ]),
        ]}
      />
      {reactions.length > 0 && (
        <div className="reaction-list">
          <h4>
            {reactions.length} recorded {reactions.length === 1 ? 'reaction' : 'reactions'}
          </h4>
          {reactions.map((reaction, position) => (
            <DetailTable
              key={position}
              dense
              rows={[
                {
                  key: 'manifestation',
                  value: <ConceptList value={asRecord(reaction)?.['manifestation']} />,
                },
                ...(asRecord(reaction)?.['substance'] === undefined
                  ? []
                  : [
                      {
                        key: 'substance',
                        value: <ConceptValue value={asRecord(reaction)?.['substance']} />,
                      },
                    ]),
                ...(strField(reaction, 'severity') === undefined
                  ? []
                  : [
                      {
                        key: 'severity',
                        value: codeToWords(strField(reaction, 'severity') as string),
                        note: 'What happened that time. Criticality above is the forward-looking risk.',
                      },
                    ]),
                ...(strField(reaction, 'onset') === undefined
                  ? []
                  : [{ key: 'onset', value: <DateValue value={asRecord(reaction)?.['onset']} /> }]),
                ...(asRecord(reaction)?.['exposureRoute'] === undefined
                  ? []
                  : [
                      {
                        key: 'exposureRoute',
                        value: <ConceptValue value={asRecord(reaction)?.['exposureRoute']} />,
                      },
                    ]),
              ]}
            />
          ))}
        </div>
      )}
      <NoteList resource={resource} />
    </ResourceCard>
  );
}

// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------

export function ObservationCard({ resource, context, entry }: RendererProps): ReactNode {
  const components = arrField(resource, 'component');
  const ranges = arrField(resource, 'referenceRange');
  const absent = elementAbsentReason(resource);
  const dataAbsent = resource['dataAbsentReason'];
  const category = codeableConceptText(arrField(resource, 'category')[0]);
  const interpretation = codeableConceptText(arrField(resource, 'interpretation')[0]);

  return (
    <ResourceCard
      resource={resource}
      context={context}
      entry={entry}
      title={conceptHeading(resource, 'code') ?? 'Observation with no code'}
      chips={
        <>
          {strField(resource, 'status') !== undefined && (
            <Chip>{codeToWords(strField(resource, 'status') as string)}</Chip>
          )}
          {category !== undefined && <Chip tone="info">{category}</Chip>}
          {interpretation !== undefined && <Chip tone="warn">{interpretation}</Chip>}
        </>
      }
    >
      <DetailTable
        rows={[
          { key: 'code', value: <ConceptValue value={resource['code']} /> },
          ...(components.length > 0 && pickChoice(resource, 'value') === undefined
            ? [
                {
                  key: 'value',
                  value: (
                    <Absent>
                      No top-level value: this observation carries its numbers in components
                    </Absent>
                  ),
                  note: 'A blood pressure is the everyday case. A renderer that reads only value[x] shows the row a clinician most wants as empty.',
                },
              ]
            : [
                {
                  key: 'value',
                  value: <ChoiceValue node={resource} base="value" context={context} />,
                },
              ]),
          ...(dataAbsent === undefined
            ? []
            : [
                {
                  key: 'dataAbsentReason',
                  value: <ConceptValue value={dataAbsent} />,
                  tone: 'info' as const,
                  note: 'The source states this observation has no value and says why. That is a statement, not a gap.',
                },
              ]),
          ...(absent === undefined
            ? []
            : [
                {
                  key: 'data absent',
                  value: <StatedAbsence reason={absent} />,
                  tone: 'info' as const,
                },
              ]),
          {
            key: 'effective',
            value: <ChoiceValue node={resource} base="effective" context={context} />,
          },
          ...(strField(resource, 'issued') === undefined
            ? []
            : [
                {
                  key: 'issued',
                  value: <DateValue value={resource['issued']} />,
                  note: 'When the result was released, which is not when it was observed.',
                },
              ]),
          { key: 'category', value: <ConceptList value={resource['category']} /> },
          ...(resource['interpretation'] === undefined
            ? []
            : [
                {
                  key: 'interpretation',
                  value: <ConceptList value={resource['interpretation']} />,
                },
              ]),
          ...ranges.map((range, position) => ({
            key: ranges.length === 1 ? 'referenceRange' : `referenceRange ${position + 1}`,
            value: <ReferenceRangeValue range={range} />,
          })),
          ...subjectRows(resource, context),
          ...(resource['performer'] === undefined
            ? []
            : [
                {
                  key: 'performer',
                  value: (
                    <span className="reference-list">
                      {arrField(resource, 'performer').map((value, position) => (
                        <ReferenceValue key={position} value={value} context={context} />
                      ))}
                    </span>
                  ),
                },
              ]),
          ...(resource['derivedFrom'] === undefined
            ? []
            : [
                {
                  key: 'derivedFrom',
                  value: (
                    <span className="reference-list">
                      {arrField(resource, 'derivedFrom').map((value, position) => (
                        <ReferenceValue key={position} value={value} context={context} />
                      ))}
                    </span>
                  ),
                },
              ]),
          ...(resource['specimen'] === undefined
            ? []
            : [
                {
                  key: 'specimen',
                  value: <ReferenceValue value={resource['specimen']} context={context} />,
                },
              ]),
        ]}
      />

      {components.length > 0 && (
        <div className="component-list">
          <h4>
            {components.length} {components.length === 1 ? 'component' : 'components'}
          </h4>
          <DetailTable
            dense
            rows={components.map((component, position) => {
              const record = asRecord(component) ?? {};
              const componentAbsent = record['dataAbsentReason'];
              return {
                key: codeableConceptText(record['code']) ?? `component ${position + 1}`,
                value:
                  componentAbsent !== undefined ? (
                    <span className="stated-absence">
                      <ConceptValue value={componentAbsent} />
                      <span className="value-note">
                        Stated absent by the source, which is not a zero and not a gap.
                      </span>
                    </span>
                  ) : (
                    <ChoiceValue node={record} base="value" context={context} />
                  ),
                ...(componentAbsent === undefined ? {} : { tone: 'info' as const }),
              };
            })}
          />
        </div>
      )}

      <NoteList resource={resource} />
      {resource['text'] !== undefined && (
        <Disclosure summary="The narrative this observation carries">
          <Narrative narrative={resource['text']} showStatus={false} />
        </Disclosure>
      )}
    </ResourceCard>
  );
}

/**
 * A reference range, and the one case worth being careful with: a range with a
 * `high` and no `low` is a ceiling ("up to 5.6"), and rendering it as a range
 * reads as a target.
 */
function ReferenceRangeValue({ range }: { range: unknown }): ReactNode {
  const text = rangeText(range);
  const type = codeableConceptText(asRecord(range)?.['type']);
  const applies = codeableConceptText(arrField(range, 'appliesTo')[0]);
  const freeText = strField(range, 'text');
  return (
    <span>
      {text ?? freeText ?? <Absent>Empty range</Absent>}
      {type !== undefined && <span className="value-note">{type}</span>}
      {applies !== undefined && <span className="value-note">applies to {applies}</span>}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Procedure, Immunization, DiagnosticReport, Specimen, Flag
// ---------------------------------------------------------------------------

export function ProcedureCard(props: RendererProps): ReactNode {
  const { resource, context, entry } = props;
  if (absenceAssertion(resource) !== undefined) return <AbsenceAssertionCard {...props} />;
  return (
    <ResourceCard
      resource={resource}
      context={context}
      entry={entry}
      title={conceptHeading(resource, 'code') ?? 'Procedure with no code'}
      chips={
        strField(resource, 'status') === undefined ? undefined : (
          <Chip>{codeToWords(strField(resource, 'status') as string)}</Chip>
        )
      }
    >
      <DetailTable
        rows={[
          { key: 'code', value: <ConceptValue value={resource['code']} /> },
          {
            key: 'performed',
            value: <ChoiceValue node={resource} base="performed" context={context} />,
          },
          ...(resource['category'] === undefined
            ? []
            : [{ key: 'category', value: <ConceptValue value={resource['category']} /> }]),
          ...(resource['bodySite'] === undefined
            ? []
            : [{ key: 'bodySite', value: <ConceptList value={resource['bodySite']} /> }]),
          ...(resource['outcome'] === undefined
            ? []
            : [{ key: 'outcome', value: <ConceptValue value={resource['outcome']} /> }]),
          ...(resource['reasonCode'] === undefined
            ? []
            : [{ key: 'reasonCode', value: <ConceptList value={resource['reasonCode']} /> }]),
          ...subjectRows(resource, context),
          ...(resource['performer'] === undefined
            ? []
            : [
                {
                  key: 'performer',
                  value: (
                    <span className="reference-list">
                      {arrField(resource, 'performer').map((value, position) => (
                        <ReferenceValue
                          key={position}
                          value={asRecord(value)?.['actor'] ?? value}
                          context={context}
                        />
                      ))}
                    </span>
                  ),
                },
              ]),
        ]}
      />
      <NoteList resource={resource} />
    </ResourceCard>
  );
}

/** Australian spelling in the label, American spelling in the resource name. */
export function ImmunisationCard({ resource, context, entry }: RendererProps): ReactNode {
  const protocols = arrField(resource, 'protocolApplied');
  return (
    <ResourceCard
      resource={resource}
      context={context}
      entry={entry}
      title={conceptHeading(resource, 'vaccineCode') ?? 'Immunisation with no vaccine code'}
      chips={
        <>
          {strField(resource, 'status') !== undefined && (
            <Chip>{codeToWords(strField(resource, 'status') as string)}</Chip>
          )}
          {resource['primarySource'] === false && (
            <Chip
              tone="warn"
              title="Recorded from a report rather than from the administering source"
            >
              Secondary source
            </Chip>
          )}
        </>
      }
    >
      <DetailTable
        rows={[
          { key: 'vaccineCode', value: <ConceptValue value={resource['vaccineCode']} /> },
          {
            key: 'occurrence',
            value: <ChoiceValue node={resource} base="occurrence" context={context} />,
          },
          ...(strField(resource, 'lotNumber') === undefined
            ? []
            : [{ key: 'lotNumber', value: strField(resource, 'lotNumber') as string, mono: true }]),
          ...(resource['site'] === undefined
            ? []
            : [{ key: 'site', value: <ConceptValue value={resource['site']} /> }]),
          ...(resource['route'] === undefined
            ? []
            : [{ key: 'route', value: <ConceptValue value={resource['route']} /> }]),
          ...(resource['doseQuantity'] === undefined
            ? []
            : [{ key: 'doseQuantity', value: <QuantityValue value={resource['doseQuantity']} /> }]),
          ...protocols.map((protocol, position) => ({
            key: protocols.length === 1 ? 'dose' : `dose ${position + 1}`,
            value: (
              <span>
                {primitiveText(asRecord(protocol)?.['doseNumberPositiveInt']) ??
                  primitiveText(asRecord(protocol)?.['doseNumberString']) ??
                  'not numbered'}
                {codeableConceptText(arrField(protocol, 'targetDisease')[0]) !== undefined && (
                  <span className="value-note">
                    against {codeableConceptText(arrField(protocol, 'targetDisease')[0]) as string}
                  </span>
                )}
              </span>
            ),
          })),
          ...subjectRows(resource, context),
          ...(resource['performer'] === undefined
            ? []
            : [
                {
                  key: 'performer',
                  value: (
                    <span className="reference-list">
                      {arrField(resource, 'performer').map((value, position) => (
                        <ReferenceValue
                          key={position}
                          value={asRecord(value)?.['actor'] ?? value}
                          context={context}
                        />
                      ))}
                    </span>
                  ),
                },
              ]),
        ]}
      />
      <NoteList resource={resource} />
    </ResourceCard>
  );
}

/**
 * `DiagnosticReport` resolves its `result` references into the observations they
 * point at, and renders `presentedForm` as an attachment.
 *
 * The second half is not optional: a report whose real content is a PDF is
 * common, and a renderer that shows only the structured elements renders it as
 * an empty card.
 */
export function DiagnosticReportCard({ resource, context, entry }: RendererProps): ReactNode {
  const results = arrField(resource, 'result');
  const forms = arrField(resource, 'presentedForm');
  const conclusion = strField(resource, 'conclusion');
  return (
    <ResourceCard
      resource={resource}
      context={context}
      entry={entry}
      title={conceptHeading(resource, 'code') ?? 'Diagnostic report with no code'}
      chips={
        strField(resource, 'status') === undefined ? undefined : (
          <Chip>{codeToWords(strField(resource, 'status') as string)}</Chip>
        )
      }
    >
      <DetailTable
        rows={[
          { key: 'code', value: <ConceptValue value={resource['code']} /> },
          { key: 'category', value: <ConceptList value={resource['category']} /> },
          {
            key: 'effective',
            value: <ChoiceValue node={resource} base="effective" context={context} />,
          },
          ...(strField(resource, 'issued') === undefined
            ? []
            : [{ key: 'issued', value: <DateValue value={resource['issued']} /> }]),
          ...(conclusion === undefined ? [] : [{ key: 'conclusion', value: conclusion }]),
          ...(resource['conclusionCode'] === undefined
            ? []
            : [
                {
                  key: 'conclusionCode',
                  value: <ConceptList value={resource['conclusionCode']} />,
                },
              ]),
          ...subjectRows(resource, context),
          ...(resource['performer'] === undefined
            ? []
            : [
                {
                  key: 'performer',
                  value: (
                    <span className="reference-list">
                      {arrField(resource, 'performer').map((value, position) => (
                        <ReferenceValue key={position} value={value} context={context} />
                      ))}
                    </span>
                  ),
                },
              ]),
        ]}
      />

      {results.length > 0 && (
        <div className="nested-results">
          <h4>
            {results.length} {results.length === 1 ? 'result' : 'results'} in this report
          </h4>
          {results.map((result, position) => {
            const resolution = context.index.resolve(result, context.from);
            const target =
              resolution.kind === 'resolved'
                ? resolution.entry.resource
                : resolution.kind === 'contained'
                  ? resolution.resource
                  : undefined;
            if (target === undefined) {
              return (
                <div key={position} className="nested-result is-unresolved">
                  <ReferenceValue value={result} context={context} />
                </div>
              );
            }
            return (
              <div key={position} className="nested-result">
                <ObservationCard
                  resource={target}
                  context={context}
                  {...(resolution.kind === 'resolved' ? { entry: resolution.entry } : {})}
                />
              </div>
            );
          })}
        </div>
      )}

      {forms.length > 0 && (
        <div className="presented-forms">
          <h4>The report as {forms.length === 1 ? 'a document' : `${forms.length} documents`}</h4>
          <p className="value-note">
            This is where a report's real content usually lives. A viewer that renders only the
            structured elements shows this report as empty.
          </p>
          {forms.map((form, position) => (
            <AttachmentPreview key={position} attachment={form} context={context} />
          ))}
        </div>
      )}
    </ResourceCard>
  );
}

export function SpecimenCard({ resource, context, entry }: RendererProps): ReactNode {
  const collection = asRecord(resource['collection']);
  return (
    <ResourceCard
      resource={resource}
      context={context}
      entry={entry}
      title={conceptHeading(resource, 'type') ?? 'Specimen with no type'}
      chips={
        strField(resource, 'status') === undefined ? undefined : (
          <Chip>{codeToWords(strField(resource, 'status') as string)}</Chip>
        )
      }
    >
      <DetailTable
        rows={[
          { key: 'type', value: <ConceptValue value={resource['type']} /> },
          ...(collection === undefined
            ? []
            : [
                {
                  key: 'collected',
                  value: <ChoiceValue node={collection} base="collected" context={context} />,
                },
                ...(collection['bodySite'] === undefined
                  ? []
                  : [{ key: 'bodySite', value: <ConceptValue value={collection['bodySite']} /> }]),
                ...(collection['method'] === undefined
                  ? []
                  : [{ key: 'method', value: <ConceptValue value={collection['method']} /> }]),
              ]),
          ...(strField(resource, 'receivedTime') === undefined
            ? []
            : [{ key: 'receivedTime', value: <DateValue value={resource['receivedTime']} /> }]),
          ...subjectRows(resource, context),
        ]}
      />
    </ResourceCard>
  );
}

/**
 * `Flag` is the IPS Alerts section's entry type, and an alert that renders as a
 * quiet row has failed at its one job.
 */
export function FlagCard({ resource, context, entry }: RendererProps): ReactNode {
  const status = strField(resource, 'status');
  return (
    <ResourceCard
      resource={resource}
      context={context}
      entry={entry}
      tone={status === 'active' ? 'warn' : undefined}
      title={conceptHeading(resource, 'code') ?? 'Flag with no code'}
      chips={
        <>
          {status !== undefined && (
            <Chip tone={status === 'active' ? 'warn' : 'info'}>{codeToWords(status)}</Chip>
          )}
          {resource['category'] !== undefined && (
            <StatusChip value={arrField(resource, 'category')[0]} label="Category" />
          )}
        </>
      }
    >
      <DetailTable
        rows={[
          { key: 'code', value: <ConceptValue value={resource['code']} /> },
          ...(resource['period'] === undefined
            ? []
            : [{ key: 'period', value: <DateValue value={resource['period']} /> }]),
          ...subjectRows(resource, context),
          ...(resource['author'] === undefined
            ? []
            : [
                {
                  key: 'author',
                  value: <ReferenceValue value={resource['author']} context={context} />,
                },
              ]),
        ]}
      />
    </ResourceCard>
  );
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------

/**
 * `note` is where a patient's own words most often arrive, so it is rendered as
 * prose with its attribution rather than folded into a field table.
 */
export function NoteList({ resource }: { resource: FhirNode }): ReactNode {
  const notes = arrField(resource, 'note');
  if (notes.length === 0) return null;
  return (
    <div className="note-list">
      {notes.map((note, position) => (
        <AnnotationValue key={position} value={note} />
      ))}
    </div>
  );
}
