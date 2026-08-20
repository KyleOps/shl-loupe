/**
 * The "who" of a payload: `Patient`, the three practitioner-shaped types,
 * `Organization`, `RelatedPerson`, `Device` and `Coverage`.
 *
 * `Patient` is the only always-present card and the one a clinician looks at
 * first, so it is a banner rather than a row. Three details in it are the ones
 * viewers get wrong:
 *
 *  - **Age is computed and its precision is stated.** A birth date of `1983-08`
 *    supports "about 43", not "43 years, 0 months", and a viewer that prints the
 *    second has invented a day.
 *  - **`gender` is administrative.** It is the value used for correspondence and
 *    record matching, and it is not a clinical sex observation. Labelling it
 *    "sex" is how the two get conflated in a room full of people who care about
 *    the difference.
 *  - **An unlabelled IHI is indistinguishable from a random 16-digit number**, so
 *    every identifier is named by its system.
 *
 * `Device` earns its place here for one reason: Platypus writes a device with
 * `deviceName` and no `type`, so a viewer that names a device from `Device.type`
 * shows a blank row for the party that authored half the payload.
 */
import type { ReactNode } from 'react';
import { Chip } from '../../primitives';
import { DetailTable, ResourceCard, type RendererProps } from '../ResourceCard';
import {
  Absent,
  ConceptList,
  ConceptValue,
  DateValue,
  IdentifierValue,
  primitiveText,
  ReferenceValue,
} from '../UnknownResource';
import {
  addressLine,
  arrField,
  asRecord,
  bestHumanName,
  codeToWords,
  formatDateValue,
  humanName,
  strField,
} from '../display';

/**
 * Age from a birth date, no more precisely than the date allows.
 *
 * Computed by comparing calendar parts rather than dividing milliseconds: a
 * division gets the answer wrong for anyone born on 29 February, and it is
 * wrong on the birthday itself for about a third of people.
 */
export function ageFromBirthDate(birthDate: string, today = new Date()): string | undefined {
  const parsed = formatDateValue(birthDate);
  if (parsed.shape === 'unparsed') return undefined;
  const parts = birthDate.split('-');
  const year = Number(parts[0]);
  if (!Number.isFinite(year)) return undefined;
  const month = parts[1] === undefined ? undefined : Number(parts[1]);
  const day = parts[2] === undefined ? undefined : Number(parts[2]);
  let age = today.getFullYear() - year;
  if (month !== undefined) {
    const beforeBirthday =
      today.getMonth() + 1 < month ||
      (today.getMonth() + 1 === month && day !== undefined && today.getDate() < day);
    if (beforeBirthday) age -= 1;
  }
  if (age < 0 || age > 130) return undefined;
  if (month === undefined) return `about ${age}, from a year-only birth date`;
  if (day === undefined) return `about ${age}, from a month-precision birth date`;
  return `${age}`;
}

export function PatientCard({ resource, context, entry }: RendererProps): ReactNode {
  const name = bestHumanName(resource['name']);
  const birthDate = strField(resource, 'birthDate');
  const gender = strField(resource, 'gender');
  const identifiers = arrField(resource, 'identifier');
  const otherNames = arrField(resource, 'name')
    .map((value) => humanName(value))
    .filter((value): value is string => value !== undefined);
  const deceased = resource['deceasedDateTime'] ?? resource['deceasedBoolean'];

  return (
    <ResourceCard
      resource={resource}
      context={context}
      entry={entry}
      title={name ?? 'Patient with no name'}
      subtitle={
        name === undefined
          ? 'This Patient carries no name at all, which both IPS and AU PS treat as a defect: there is nothing for a receiver to match a person against.'
          : undefined
      }
      chips={
        <>
          {gender !== undefined && <Chip>{codeToWords(gender)}</Chip>}
          {deceased !== undefined && <Chip tone="warn">Deceased</Chip>}
        </>
      }
    >
      <DetailTable
        rows={[
          {
            key: 'birthDate',
            value:
              birthDate === undefined ? (
                <Absent>Not stated</Absent>
              ) : (
                <span>
                  <DateValue value={birthDate} />
                  {ageFromBirthDate(birthDate) !== undefined && (
                    <span className="value-note">age {ageFromBirthDate(birthDate)}</span>
                  )}
                </span>
              ),
          },
          {
            key: 'gender',
            value: gender === undefined ? <Absent>Not stated</Absent> : codeToWords(gender),
            note: 'Administrative gender: the value used for correspondence and record matching. It is not a clinical observation of sex, and the two are different elements for a reason.',
          },
          ...(deceased === undefined
            ? []
            : [
                {
                  key: 'deceased',
                  value:
                    typeof deceased === 'string' ? (
                      <DateValue value={deceased} />
                    ) : (
                      (primitiveText(deceased) ?? 'Stated in a shape SHLoupe cannot read')
                    ),
                  tone: 'warn' as const,
                },
              ]),
          ...(otherNames.length > 1
            ? [
                {
                  key: 'other names',
                  value: otherNames.slice(1).join(' · '),
                  note: 'SHLoupe shows the official or usual name in the heading, so a name marked old does not become the label for a person who no longer uses it.',
                },
              ]
            : []),
          ...identifiers.map((value, position) => ({
            key: position === 0 ? 'identifier' : `identifier ${position + 1}`,
            value: <IdentifierValue value={value} />,
          })),
          ...(identifiers.length === 0
            ? [
                {
                  key: 'identifier',
                  value: <Absent>None</Absent>,
                  note: 'Nothing here for a receiving system to match this person against, so any linkage has to be done on name and date of birth.',
                },
              ]
            : []),
          ...arrField(resource, 'address').map((value, position) => ({
            key: position === 0 ? 'address' : `address ${position + 1}`,
            value: addressLine(value) ?? <Absent>Empty address</Absent>,
          })),
          ...arrField(resource, 'telecom').map((value, position) => ({
            key: position === 0 ? 'contact' : `contact ${position + 1}`,
            value: (
              <span>
                {strField(value, 'value') ?? '(no value)'}
                {strField(value, 'system') !== undefined && (
                  <Chip>{strField(value, 'system') as string}</Chip>
                )}
              </span>
            ),
          })),
          ...(resource['communication'] === undefined
            ? []
            : [
                {
                  key: 'communication',
                  value: (
                    <ConceptList
                      value={arrField(resource, 'communication').map(
                        (entryValue) => asRecord(entryValue)?.['language'],
                      )}
                    />
                  ),
                },
              ]),
          ...(resource['managingOrganization'] === undefined
            ? []
            : [
                {
                  key: 'managingOrganization',
                  value: (
                    <ReferenceValue value={resource['managingOrganization']} context={context} />
                  ),
                },
              ]),
        ]}
      />
    </ResourceCard>
  );
}

export function PractitionerCard({ resource, context, entry }: RendererProps): ReactNode {
  const name = bestHumanName(resource['name']);
  const qualifications = arrField(resource, 'qualification');
  return (
    <ResourceCard
      resource={resource}
      context={context}
      entry={entry}
      title={name ?? 'Practitioner with no name'}
    >
      <DetailTable
        rows={[
          ...arrField(resource, 'identifier').map((value, position) => ({
            key: position === 0 ? 'identifier' : `identifier ${position + 1}`,
            value: <IdentifierValue value={value} />,
          })),
          ...(qualifications.length === 0
            ? []
            : [
                {
                  key: 'qualification',
                  value: (
                    <ConceptList value={qualifications.map((value) => asRecord(value)?.['code'])} />
                  ),
                },
              ]),
          ...arrField(resource, 'telecom').map((value, position) => ({
            key: position === 0 ? 'contact' : `contact ${position + 1}`,
            value: strField(value, 'value') ?? <Absent>No value</Absent>,
          })),
          ...arrField(resource, 'address').map((value, position) => ({
            key: position === 0 ? 'address' : `address ${position + 1}`,
            value: addressLine(value) ?? <Absent>Empty address</Absent>,
          })),
        ]}
      />
    </ResourceCard>
  );
}

/**
 * `PractitionerRole` is the type most often referenced and least often carried.
 * A summary that references one it does not include is normal, so the card says
 * what it is for rather than implying something is missing.
 */
export function PractitionerRoleCard({ resource, context, entry }: RendererProps): ReactNode {
  return (
    <ResourceCard resource={resource} context={context} entry={entry} title="Practitioner role">
      <DetailTable
        rows={[
          {
            key: 'practitioner',
            value: <ReferenceValue value={resource['practitioner']} context={context} />,
          },
          {
            key: 'organization',
            value: <ReferenceValue value={resource['organization']} context={context} />,
          },
          { key: 'code', value: <ConceptList value={resource['code']} /> },
          ...(resource['specialty'] === undefined
            ? []
            : [{ key: 'specialty', value: <ConceptList value={resource['specialty']} /> }]),
          ...(resource['period'] === undefined
            ? []
            : [{ key: 'period', value: <DateValue value={resource['period']} /> }]),
          ...(resource['location'] === undefined
            ? []
            : [
                {
                  key: 'location',
                  value: <ReferenceValue value={resource['location']} context={context} />,
                },
              ]),
        ]}
      />
    </ResourceCard>
  );
}

export function RelatedPersonCard({ resource, context, entry }: RendererProps): ReactNode {
  const name = bestHumanName(resource['name']);
  return (
    <ResourceCard
      resource={resource}
      context={context}
      entry={entry}
      title={name ?? 'Related person with no name'}
    >
      <DetailTable
        rows={[
          { key: 'relationship', value: <ConceptList value={resource['relationship']} /> },
          {
            key: 'patient',
            value: <ReferenceValue value={resource['patient']} context={context} />,
          },
          ...arrField(resource, 'telecom').map((value, position) => ({
            key: position === 0 ? 'contact' : `contact ${position + 1}`,
            value: strField(value, 'value') ?? <Absent>No value</Absent>,
          })),
        ]}
      />
    </ResourceCard>
  );
}

export function OrganizationCard({ resource, context, entry }: RendererProps): ReactNode {
  const name = strField(resource, 'name');
  return (
    <ResourceCard
      resource={resource}
      context={context}
      entry={entry}
      title={name ?? 'Organisation with no name'}
      subtitle={
        name === undefined
          ? 'An Organization with no name cannot be presented to a human at all, so anything referring to it will show an identifier or nothing.'
          : undefined
      }
    >
      <DetailTable
        rows={[
          ...(resource['type'] === undefined
            ? []
            : [{ key: 'type', value: <ConceptList value={resource['type']} /> }]),
          ...arrField(resource, 'identifier').map((value, position) => ({
            key: position === 0 ? 'identifier' : `identifier ${position + 1}`,
            value: <IdentifierValue value={value} />,
          })),
          ...arrField(resource, 'address').map((value, position) => ({
            key: position === 0 ? 'address' : `address ${position + 1}`,
            value: addressLine(value) ?? <Absent>Empty address</Absent>,
          })),
          ...arrField(resource, 'telecom').map((value, position) => ({
            key: position === 0 ? 'contact' : `contact ${position + 1}`,
            value: strField(value, 'value') ?? <Absent>No value</Absent>,
          })),
          ...(resource['partOf'] === undefined
            ? []
            : [
                {
                  key: 'partOf',
                  value: <ReferenceValue value={resource['partOf']} context={context} />,
                },
              ]),
        ]}
      />
    </ResourceCard>
  );
}

export function DeviceCard({ resource, context, entry }: RendererProps): ReactNode {
  // deviceName first, and this is the trap: a real payload can carry a device
  // named only here, with no `type` at all, and naming a device from `type`
  // leaves the row blank for the party that authored half the payload.
  const names = arrField(resource, 'deviceName')
    .map((value) => strField(value, 'name'))
    .filter((value): value is string => value !== undefined);
  const status = strField(resource, 'status');
  return (
    <ResourceCard
      resource={resource}
      context={context}
      entry={entry}
      title={names[0] ?? 'Device with no name'}
      chips={status === undefined ? undefined : <Chip>{codeToWords(status)}</Chip>}
    >
      <DetailTable
        rows={[
          {
            key: 'deviceName',
            value: names.length === 0 ? <Absent>Not stated</Absent> : names.join(' · '),
            note:
              names.length > 0 && resource['type'] === undefined
                ? 'This device is named here and nowhere else: it has no type element. Naming a device from Device.type, as most viewers do, would render this row blank.'
                : undefined,
          },
          ...(resource['type'] === undefined
            ? []
            : [{ key: 'type', value: <ConceptValue value={resource['type']} /> }]),
          ...(strField(resource, 'manufacturer') === undefined
            ? []
            : [{ key: 'manufacturer', value: strField(resource, 'manufacturer') as string }]),
          ...(strField(resource, 'modelNumber') === undefined
            ? []
            : [{ key: 'modelNumber', value: strField(resource, 'modelNumber') as string }]),
          ...(strField(resource, 'serialNumber') === undefined
            ? []
            : [{ key: 'serialNumber', value: strField(resource, 'serialNumber') as string }]),
          ...(resource['patient'] === undefined
            ? []
            : [
                {
                  key: 'patient',
                  value: <ReferenceValue value={resource['patient']} context={context} />,
                },
              ]),
        ]}
      />
    </ResourceCard>
  );
}

export function CoverageCard({ resource, context, entry }: RendererProps): ReactNode {
  const status = strField(resource, 'status');
  const classes = arrField(resource, 'class');
  return (
    <ResourceCard
      resource={resource}
      context={context}
      entry={entry}
      title="Coverage"
      chips={status === undefined ? undefined : <Chip>{codeToWords(status)}</Chip>}
    >
      <DetailTable
        rows={[
          { key: 'type', value: <ConceptValue value={resource['type']} /> },
          {
            key: 'beneficiary',
            value: <ReferenceValue value={resource['beneficiary']} context={context} />,
          },
          ...(resource['subscriber'] === undefined
            ? []
            : [
                {
                  key: 'subscriber',
                  value: <ReferenceValue value={resource['subscriber']} context={context} />,
                },
              ]),
          ...(strField(resource, 'subscriberId') === undefined
            ? []
            : [
                {
                  key: 'subscriberId',
                  value: strField(resource, 'subscriberId') as string,
                  mono: true,
                },
              ]),
          ...(resource['payor'] === undefined
            ? []
            : [
                {
                  key: 'payor',
                  value: (
                    <span className="reference-list">
                      {arrField(resource, 'payor').map((value, position) => (
                        <ReferenceValue key={position} value={value} context={context} />
                      ))}
                    </span>
                  ),
                },
              ]),
          ...(resource['period'] === undefined
            ? []
            : [{ key: 'period', value: <DateValue value={resource['period']} /> }]),
          ...classes.map((value, position) => ({
            key: strField(asRecord(value)?.['type'], 'text') ?? `class ${position + 1}`,
            value: (
              <span>
                {strField(value, 'value') ?? <Absent>No value</Absent>}
                {strField(value, 'name') !== undefined && (
                  <span className="value-note">{strField(value, 'name') as string}</span>
                )}
              </span>
            ),
          })),
        ]}
      />
    </ResourceCard>
  );
}
