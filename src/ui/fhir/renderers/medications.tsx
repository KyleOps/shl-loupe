/**
 * The five medication types, and the `medication[x]` choice resolved in ONE
 * place.
 *
 * That choice is the whole reason this file exists as its own module.
 * `MedicationStatement`, `MedicationRequest`, `MedicationDispense` and
 * `MedicationAdministration` each carry either a `medicationCodeableConcept` or a
 * `medicationReference`, and the reference can point at a contained
 * `Medication`, at another entry in the bundle, or at nothing this payload
 * carries. A renderer that reads only the concept shows a real, active medicine
 * with no name: Platypus emits exactly that shape, with the concept inside a
 * contained `Medication` reached by `medicationReference: '#bisoprolol'`.
 *
 * The other rule worth stating: `Dosage.text` is the prescriber's own sig, and it
 * is shown whole and verbatim when it is there. Recomposing a dose from the
 * structured parts is how a viewer ends up displaying an instruction nobody
 * wrote.
 */
import type { ReactNode } from 'react';
import { Chip } from '../../primitives';
import {
  AbsenceAssertionCard,
  DetailTable,
  ResourceCard,
  type RendererProps,
} from '../ResourceCard';
import {
  Absent,
  ConceptList,
  ConceptValue,
  DateValue,
  primitiveText,
  QuantityValue,
  ReferenceValue,
  type RenderContext,
} from '../UnknownResource';
import { ChoiceValue, NoteList } from './clinical';
import {
  absenceAssertion,
  arrField,
  asRecord,
  codeableConcept,
  codeableConceptText,
  codeToWords,
  dosageText,
  ratioText,
  strField,
  type FhirNode,
} from '../display';

export type MedicationSource = 'concept' | 'contained' | 'bundled' | 'unresolved' | 'none';

export interface MedicationConcept {
  /** What the medicine is called, or undefined when nothing named it. */
  text?: string;
  /** Where the name came from, which is the fact a debugger needs. */
  source: MedicationSource;
  /** The `Medication` resource, when the choice resolved to one. */
  medication?: FhirNode;
  detail?: string;
}

/**
 * Resolve `medication[x]` once.
 *
 * Returns where the answer came from as well as what it is, because "this
 * medicine has no name" and "this medicine is named in a resource the payload
 * did not include" are different problems with different owners.
 */
export function medicationConcept(resource: FhirNode, context: RenderContext): MedicationConcept {
  const concept = resource['medicationCodeableConcept'];
  if (concept !== undefined) {
    const text = codeableConceptText(concept);
    return { source: 'concept', ...(text === undefined ? {} : { text }) };
  }
  const reference = resource['medicationReference'];
  if (reference === undefined) {
    return {
      source: 'none',
      detail:
        'Neither medicationCodeableConcept nor medicationReference is present, and the element is 1..1, so this resource does not say what medicine it is about.',
    };
  }
  const resolution = context.index.resolve(reference, context.from);
  if (resolution.kind === 'contained' || resolution.kind === 'resolved') {
    const medication =
      resolution.kind === 'contained' ? resolution.resource : resolution.entry.resource;
    const text = codeableConceptText(medication['code']) ?? strField(medication, 'code');
    return {
      source: resolution.kind === 'contained' ? 'contained' : 'bundled',
      medication,
      ...(text === undefined ? {} : { text }),
      detail:
        resolution.kind === 'contained'
          ? 'The concept is inside this resource, as a contained Medication. Read only medicationCodeableConcept and this medicine has no name.'
          : 'The concept is in a separate Medication entry in this bundle.',
    };
  }
  const label = strField(reference, 'display');
  return {
    source: 'unresolved',
    ...(label === undefined ? {} : { text: label }),
    detail:
      'The medication reference points at a resource this payload does not carry, so the only name available is whatever the reference itself stated.',
  };
}

function DosageRows({ resource }: { resource: FhirNode }): ReactNode {
  const dosages = [...arrField(resource, 'dosage'), ...arrField(resource, 'dosageInstruction')];
  if (dosages.length === 0) return null;
  return (
    <DetailTable
      dense
      rows={dosages.map((dosage, position) => ({
        key: dosages.length === 1 ? 'dosage' : `dosage ${position + 1}`,
        value: dosageText(dosage) ?? <Absent>Empty dosage</Absent>,
        note:
          strField(dosage, 'text') === undefined
            ? 'Composed by SHLoupe from the structured dose, timing and route, because this dosage carries no text of its own.'
            : "The prescriber's own wording, shown verbatim.",
      }))}
    />
  );
}

/** The shared body: every medication type answers the same five questions. */
function MedicationBody({
  resource,
  context,
  dateRows,
}: {
  resource: FhirNode;
  context: RenderContext;
  dateRows: Array<{ key: string; value: ReactNode; note?: ReactNode }>;
}): ReactNode {
  const medication = medicationConcept(resource, context);
  return (
    <>
      <DetailTable
        rows={[
          {
            key: 'medication[x]',
            value:
              medication.text === undefined ? (
                <Absent>Nothing named this medicine</Absent>
              ) : medication.source === 'concept' ? (
                <ConceptValue value={resource['medicationCodeableConcept']} />
              ) : medication.medication !== undefined ? (
                <ConceptValue value={medication.medication['code']} />
              ) : (
                <span>{medication.text}</span>
              ),
            tone:
              medication.source === 'unresolved' || medication.source === 'none'
                ? 'warn'
                : undefined,
            note: medication.detail,
          },
          ...dateRows,
          ...(resource['subject'] === undefined
            ? []
            : [
                {
                  key: 'subject',
                  value: <ReferenceValue value={resource['subject']} context={context} />,
                },
              ]),
          ...(resource['reasonCode'] === undefined
            ? []
            : [{ key: 'reasonCode', value: <ConceptList value={resource['reasonCode']} /> }]),
          ...(resource['reasonReference'] === undefined
            ? []
            : [
                {
                  key: 'reasonReference',
                  value: (
                    <span className="reference-list">
                      {arrField(resource, 'reasonReference').map((value, position) => (
                        <ReferenceValue key={position} value={value} context={context} />
                      ))}
                    </span>
                  ),
                },
              ]),
        ]}
      />
      <DosageRows resource={resource} />
      <NoteList resource={resource} />
    </>
  );
}

function statusChip(resource: FhirNode): ReactNode {
  const status = strField(resource, 'status');
  if (status === undefined) return undefined;
  const tone = status === 'active' ? 'pass' : status === 'entered-in-error' ? 'fail' : 'info';
  return <Chip tone={tone}>{codeToWords(status)}</Chip>;
}

function headingFor(resource: FhirNode, context: RenderContext, fallback: string): string {
  return medicationConcept(resource, context).text ?? fallback;
}

// ---------------------------------------------------------------------------
// The four statements
// ---------------------------------------------------------------------------

export function MedicationStatementCard(props: RendererProps): ReactNode {
  const { resource, context, entry } = props;
  if (absenceAssertion(resource) !== undefined) return <AbsenceAssertionCard {...props} />;
  return (
    <ResourceCard
      resource={resource}
      context={context}
      entry={entry}
      title={headingFor(resource, context, 'Medication with no name')}
      chips={statusChip(resource)}
    >
      <MedicationBody
        resource={resource}
        context={context}
        dateRows={[
          {
            key: 'effective',
            value: <ChoiceValue node={resource} base="effective" context={context} />,
            note: 'AU PS raises this to 1..1 where AU Core leaves it optional, so a summary claiming AU PS must either carry it or state it absent. Reading dateAsserted into it instead would be stating something else entirely.',
          },
          ...(strField(resource, 'dateAsserted') === undefined
            ? []
            : [
                {
                  key: 'dateAsserted',
                  value: <DateValue value={resource['dateAsserted']} />,
                  note: 'When somebody said this was true, which is not when the patient was taking it.',
                },
              ]),
        ]}
      />
    </ResourceCard>
  );
}

export function MedicationRequestCard({ resource, context, entry }: RendererProps): ReactNode {
  const intent = strField(resource, 'intent');
  return (
    <ResourceCard
      resource={resource}
      context={context}
      entry={entry}
      title={headingFor(resource, context, 'Medication request with no medicine')}
      chips={
        <>
          {statusChip(resource)}
          {intent !== undefined && <Chip title={`intent: ${intent}`}>{codeToWords(intent)}</Chip>}
          {resource['priority'] !== undefined && (
            <Chip>{codeToWords(strField(resource, 'priority') as string)}</Chip>
          )}
        </>
      }
    >
      <MedicationBody
        resource={resource}
        context={context}
        dateRows={[
          ...(strField(resource, 'authoredOn') === undefined
            ? []
            : [{ key: 'authoredOn', value: <DateValue value={resource['authoredOn']} /> }]),
          ...(resource['requester'] === undefined
            ? []
            : [
                {
                  key: 'requester',
                  value: <ReferenceValue value={resource['requester']} context={context} />,
                },
              ]),
          ...(asRecord(resource['dispenseRequest']) === undefined
            ? []
            : [
                {
                  key: 'dispenseRequest',
                  value: (
                    <span>
                      {primitiveText(
                        asRecord(resource['dispenseRequest'])?.['numberOfRepeatsAllowed'],
                      ) ?? 'no repeats stated'}
                      <span className="value-note">repeats allowed</span>
                    </span>
                  ),
                },
              ]),
        ]}
      />
    </ResourceCard>
  );
}

export function MedicationDispenseCard({ resource, context, entry }: RendererProps): ReactNode {
  return (
    <ResourceCard
      resource={resource}
      context={context}
      entry={entry}
      title={headingFor(resource, context, 'Dispense with no medicine')}
      chips={statusChip(resource)}
    >
      <MedicationBody
        resource={resource}
        context={context}
        dateRows={[
          ...(strField(resource, 'whenHandedOver') === undefined
            ? []
            : [
                {
                  key: 'whenHandedOver',
                  value: <DateValue value={resource['whenHandedOver']} />,
                  note: 'When the patient got it, which is the date that matters clinically. whenPrepared is when the pharmacy made it up.',
                },
              ]),
          ...(strField(resource, 'whenPrepared') === undefined
            ? []
            : [{ key: 'whenPrepared', value: <DateValue value={resource['whenPrepared']} /> }]),
          ...(resource['quantity'] === undefined
            ? []
            : [{ key: 'quantity', value: <QuantityValue value={resource['quantity']} /> }]),
          ...(resource['daysSupply'] === undefined
            ? []
            : [{ key: 'daysSupply', value: <QuantityValue value={resource['daysSupply']} /> }]),
          ...(resource['type'] === undefined
            ? []
            : [{ key: 'type', value: <ConceptValue value={resource['type']} /> }]),
        ]}
      />
    </ResourceCard>
  );
}

export function MedicationAdministrationCard({
  resource,
  context,
  entry,
}: RendererProps): ReactNode {
  const dose = asRecord(resource['dosage']);
  return (
    <ResourceCard
      resource={resource}
      context={context}
      entry={entry}
      title={headingFor(resource, context, 'Administration with no medicine')}
      chips={statusChip(resource)}
    >
      <MedicationBody
        resource={resource}
        context={context}
        dateRows={[
          {
            key: 'effective',
            value: <ChoiceValue node={resource} base="effective" context={context} />,
          },
          ...(dose === undefined
            ? []
            : [
                {
                  key: 'dose',
                  value: dosageText(dose) ?? <Absent>Empty dose</Absent>,
                },
              ]),
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
    </ResourceCard>
  );
}

/**
 * `Medication` on its own.
 *
 * The incumbent viewer drops this type unconditionally, with a comment that it
 * "isn't a valid standalone entity". It is: a bundled `Medication` is where the
 * form, the strength and the ingredients live, and a `MedicationStatement`
 * pointing at one has no other source for them.
 */
export function MedicationCard({ resource, context, entry }: RendererProps): ReactNode {
  const ingredients = arrField(resource, 'ingredient');
  return (
    <ResourceCard
      resource={resource}
      context={context}
      entry={entry}
      title={codeableConceptText(resource['code']) ?? 'Medication with no code'}
      chips={
        strField(resource, 'status') === undefined ? undefined : (
          <Chip>{codeToWords(strField(resource, 'status') as string)}</Chip>
        )
      }
    >
      <DetailTable
        rows={[
          { key: 'code', value: <ConceptValue value={resource['code']} /> },
          ...(resource['form'] === undefined
            ? []
            : [{ key: 'form', value: <ConceptValue value={resource['form']} /> }]),
          ...(resource['manufacturer'] === undefined
            ? []
            : [
                {
                  key: 'manufacturer',
                  value: <ReferenceValue value={resource['manufacturer']} context={context} />,
                },
              ]),
          ...(asRecord(resource['amount']) === undefined
            ? []
            : [{ key: 'amount', value: <QuantityValue value={resource['amount']} /> }]),
          ...ingredients.map((ingredient, position) => {
            const record = asRecord(ingredient) ?? {};
            const item =
              codeableConceptText(record['itemCodeableConcept']) ??
              strField(record['itemReference'], 'display') ??
              codeableConcept(record['itemCodeableConcept'])?.text;
            return {
              key: ingredients.length === 1 ? 'ingredient' : `ingredient ${position + 1}`,
              value: (
                <span>
                  {item ?? <Absent>Unnamed ingredient</Absent>}
                  {ratioText(record['strength']) !== undefined && (
                    <span className="value-note">strength {ratioText(record['strength'])}</span>
                  )}
                </span>
              ),
            };
          }),
        ]}
      />
    </ResourceCard>
  );
}
