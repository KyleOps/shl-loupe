/**
 * The document-shaped types: `DocumentReference`, `Binary`, and a `Composition`
 * met as an ordinary entry rather than as the document shell.
 *
 * The mechanics of attachments live in `DocumentReferenceView`; this module is
 * the thin card layer over them, and it exists so the registry has one entry per
 * type rather than a special case.
 *
 * `Composition` appears here because a payload can carry more than one: a
 * summary that embeds a referral, or a bundle carrying two documents. The FIRST
 * Composition is what makes a bundle a document and it renders through
 * `CompositionView`; a second one is an entry like any other, and rendering it as
 * a second document shell would claim the payload has two subjects.
 */
import type { ReactNode } from 'react';
import { Chip, Disclosure } from '../../primitives';
import { DetailTable, ResourceCard, type RendererProps } from '../ResourceCard';
import { BinaryView, DocumentReferenceView } from '../DocumentReferenceView';
import { Narrative } from '../Narrative';
import { ConceptValue, DateValue, ReferenceValue } from '../UnknownResource';
import { arrField, codeableConceptText, codeToWords, strField } from '../display';

export function DocumentReferenceCard({ resource, context, entry }: RendererProps): ReactNode {
  const status = strField(resource, 'status');
  const contents = arrField(resource, 'content');
  return (
    <ResourceCard
      resource={resource}
      context={context}
      entry={entry}
      title={
        codeableConceptText(resource['type']) ??
        strField(resource, 'description') ??
        'Document with no type'
      }
      subtitle={
        codeableConceptText(resource['type']) === undefined
          ? undefined
          : strField(resource, 'description')
      }
      tone={contents.length === 0 ? 'fail' : undefined}
      chips={
        <>
          {status !== undefined && (
            <Chip tone={status === 'current' ? 'info' : 'warn'}>{codeToWords(status)}</Chip>
          )}
          {contents.length > 1 && <Chip tone="info">{contents.length} formats</Chip>}
          {contents.length === 0 && <Chip tone="fail">No content</Chip>}
        </>
      }
    >
      <DocumentReferenceView resource={resource} context={context} />
    </ResourceCard>
  );
}

export function BinaryCard({ resource, context, entry }: RendererProps): ReactNode {
  const contentType = strField(resource, 'contentType');
  return (
    <ResourceCard
      resource={resource}
      context={context}
      entry={entry}
      title="Binary"
      subtitle={contentType}
      chips={contentType === undefined ? <Chip tone="warn">No contentType</Chip> : undefined}
    >
      <BinaryView resource={resource} context={context} />
    </ResourceCard>
  );
}

/**
 * A `Composition` as an entry: its own metadata, its section titles, and its
 * narrative, without pretending to be the payload's document shell.
 */
export function CompositionCard({ resource, context, entry }: RendererProps): ReactNode {
  const sections = arrField(resource, 'section');
  return (
    <ResourceCard
      resource={resource}
      context={context}
      entry={entry}
      title={strField(resource, 'title') ?? 'Composition with no title'}
      chips={
        <>
          {strField(resource, 'status') !== undefined && (
            <Chip>{codeToWords(strField(resource, 'status') as string)}</Chip>
          )}
          <Chip tone="info">
            {sections.length} {sections.length === 1 ? 'section' : 'sections'}
          </Chip>
        </>
      }
    >
      <DetailTable
        rows={[
          { key: 'type', value: <ConceptValue value={resource['type']} /> },
          ...(strField(resource, 'date') === undefined
            ? []
            : [{ key: 'date', value: <DateValue value={resource['date']} /> }]),
          ...(resource['subject'] === undefined
            ? []
            : [
                {
                  key: 'subject',
                  value: <ReferenceValue value={resource['subject']} context={context} />,
                },
              ]),
          ...(resource['author'] === undefined
            ? []
            : [
                {
                  key: 'author',
                  value: (
                    <span className="reference-list">
                      {arrField(resource, 'author').map((value, position) => (
                        <ReferenceValue key={position} value={value} context={context} />
                      ))}
                    </span>
                  ),
                },
              ]),
          ...(resource['custodian'] === undefined
            ? []
            : [
                {
                  key: 'custodian',
                  value: <ReferenceValue value={resource['custodian']} context={context} />,
                },
              ]),
          {
            key: 'sections',
            value: sections
              .map((section, position) => strField(section, 'title') ?? `section ${position + 1}`)
              .join(' · '),
          },
        ]}
      />
      {resource['text'] !== undefined && (
        <Disclosure summary="The narrative of this composition">
          <Narrative narrative={resource['text']} />
        </Disclosure>
      )}
    </ResourceCard>
  );
}
