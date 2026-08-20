/**
 * A FHIR document: the `Composition` and its sections.
 *
 * Six obligations, and each one is a place a viewer goes wrong.
 *
 * **1. The heading is `section.title`, never the LOINC display.** The IPS profile
 * pins `section.code` as a pattern with the code only and no display, so tools
 * invent one and get it wrong: the real display for `8716-3` is "Vital signs
 * note", for `30954-2` it is "Relevant diagnostic tests/laboratory data note",
 * and three of the commonly written displays are simply not what LOINC
 * publishes. `section.title` is what the author wrote for a human, it carries the
 * correct local spelling (Australian "Immunisation" in an AU PS), and it is 1..1
 * must-support there. The code goes beside it as a chip, with the verified
 * display in the tooltip where we have verified one.
 *
 * **2. Sections are ordered by the profile, not by the document.** Two payloads
 * from different vendors then look the same on screen, which is the entire point
 * of a comparison tool at a connectathon. Document order is one click away for
 * the people who care about the wire, which at an event is most of them.
 *
 * **3. Structured entries by default, narrative always reachable.** With one
 * exception that matters: when `section.text.status` is `additional` or
 * `extensions`, the author is stating that the narrative carries content the
 * entries do not, so that section opens on the narrative. A structured-only view
 * of it would be losing clinical content silently.
 *
 * **4. `emptyReason` is a positive statement.** An empty section with an
 * `emptyReason` is the source saying something, and rendering it as blank space
 * throws that away. An empty section with no `emptyReason`, no entries and no
 * narrative is a different thing again, and it is a warning.
 *
 * **5. Nothing is claimed that was not rendered.** `claimedEntries` is exported
 * so the payload view can list everything the sections did not cover. That is the
 * single largest gap in the incumbent viewer: it renders only resources reachable
 * from `Composition.section.entry`, so a `Provenance` (which relates to its
 * targets rather than sitting in a section) is invisible no matter what.
 *
 * **6. The checks are structural, and they say so.** A browser cannot do profile
 * validation: no slicing by a code-based discriminator without an expansion, no
 * SNOMED CT-AU without that edition, no must-support semantics without the IG
 * package. Implying otherwise would be worse than staying quiet.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { Button, Callout, Chip, Disclosure } from '../primitives';
import type { BundleIndex, IndexedEntry } from './BundleIndex';
import { ErrorBoundary } from './ErrorBoundary';
import { Narrative, narrativeMayExceedEntries, narrativeStatus } from './Narrative';
import { RenderedResource } from './registry';
import { DetailTable } from './ResourceCard';
import { ConceptValue, DateValue, ReferenceValue, type RenderContext } from './UnknownResource';
import {
  arrField,
  asRecord,
  claimsAuPs,
  codeableConceptText,
  codeToWords,
  sectionLoinc,
  sectionSlice,
  sectionSortKey,
  strField,
  type FhirNode,
} from './display';

const SECTION_NOTE_URL = 'http://hl7.org.au/fhir/StructureDefinition/section-note';

// ---------------------------------------------------------------------------
// What the sections account for
// ---------------------------------------------------------------------------

/**
 * Every entry index a `Composition` claims: itself, and everything its sections
 * point at that this bundle actually carries.
 *
 * Pure, and exported, because the payload view subtracts it from the bundle to
 * find what nothing has rendered. A reference that does not resolve claims
 * nothing, which is correct: it did not render either.
 */
export function claimedEntries(index: BundleIndex, composition: IndexedEntry): Set<number> {
  const claimed = new Set<number>([composition.index]);
  const walk = (sections: readonly unknown[]): void => {
    for (const section of sections) {
      for (const reference of arrField(section, 'entry')) {
        const resolution = index.resolve(reference, composition);
        if (resolution.kind === 'resolved') claimed.add(resolution.entry.index);
      }
      walk(arrField(section, 'section'));
    }
  };
  walk(arrField(composition.resource, 'section'));
  return claimed;
}

// ---------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------

export type SectionOrder = 'profile' | 'document';

export function CompositionView({
  index,
  entry,
}: {
  index: BundleIndex;
  entry: IndexedEntry;
}): ReactNode {
  const composition = entry.resource;
  const [order, setOrder] = useState<SectionOrder>('profile');
  const context: RenderContext = { index, from: entry };
  const auPs = claimsAuPs(composition) || claimsAuPs(index.root);

  const sections = useMemo(() => {
    const list = arrField(composition, 'section').map((section, documentIndex) => ({
      section,
      documentIndex,
    }));
    if (order === 'document') return list;
    return [...list].sort(
      (a, b) =>
        sectionSortKey(a.section, a.documentIndex) - sectionSortKey(b.section, b.documentIndex),
    );
  }, [composition, order]);

  const named = sections.filter(
    ({ section }) => sectionSlice(sectionLoinc(section)) !== undefined,
  ).length;

  return (
    <div className="composition">
      <header className="composition-head">
        <h2 className="composition-title">
          {strField(composition, 'title') ?? 'Document with no title'}
        </h2>
        <div className="composition-chips">
          {strField(composition, 'status') !== undefined && (
            <Chip>{codeToWords(strField(composition, 'status') as string)}</Chip>
          )}
          <Chip tone="info">
            {sections.length} {sections.length === 1 ? 'section' : 'sections'}
          </Chip>
          {auPs && sections.length < 3 && (
            <Chip tone="fail" title="AU PS makes Composition.section 3..*">
              Below the AU PS minimum
            </Chip>
          )}
        </div>
        <DetailTable
          rows={[
            { key: 'type', value: <ConceptValue value={composition['type']} /> },
            {
              key: 'subject',
              value: <ReferenceValue value={composition['subject']} context={context} />,
            },
            ...(strField(composition, 'date') === undefined
              ? []
              : [
                  {
                    key: 'date',
                    value: <DateValue value={composition['date']} />,
                    note: 'When the document was assembled, which is not the date of anything in it.',
                  },
                ]),
            ...(composition['author'] === undefined
              ? []
              : [
                  {
                    key: 'author',
                    value: (
                      <span className="reference-list">
                        {arrField(composition, 'author').map((author, position) => (
                          <ReferenceValue key={position} value={author} context={context} />
                        ))}
                      </span>
                    ),
                    note: 'More than one author is normal in a patient-held summary: the app that assembled it, and the patient, where the payload carries anything they contributed.',
                  },
                ]),
            ...(composition['custodian'] === undefined
              ? []
              : [
                  {
                    key: 'custodian',
                    value: <ReferenceValue value={composition['custodian']} context={context} />,
                  },
                ]),
            ...(composition['attester'] === undefined
              ? []
              : [
                  {
                    key: 'attester',
                    value: (
                      <span className="reference-list">
                        {arrField(composition, 'attester').map((attester, position) => (
                          <ReferenceValue
                            key={position}
                            value={asRecord(attester)?.['party']}
                            context={context}
                          />
                        ))}
                      </span>
                    ),
                  },
                ]),
          ]}
        />
        <div className="section-order" role="group" aria-label="Section order">
          <span className="value-note">
            Showing {order === 'profile' ? 'profile order' : 'document order'}
            {order === 'profile' && named < sections.length
              ? `, with ${sections.length - named} section${sections.length - named === 1 ? '' : 's'} the profile does not name at the end`
              : ''}
          </span>
          <Button size="sm" onClick={() => setOrder(order === 'profile' ? 'document' : 'profile')}>
            Show {order === 'profile' ? 'document order' : 'profile order'}
          </Button>
        </div>
      </header>

      {composition['text'] !== undefined && (
        <Disclosure summary="The narrative of the document as a whole">
          <Narrative narrative={composition['text']} />
        </Disclosure>
      )}

      <div className="section-list">
        {sections.map(({ section, documentIndex }) => (
          <ErrorBoundary
            key={documentIndex}
            label={`the ${strField(section, 'title') ?? 'untitled'} section`}
            unit="section"
            subject={section}
          >
            <SectionView
              section={asRecord(section) ?? {}}
              index={index}
              from={entry}
              auPs={auPs}
              documentIndex={documentIndex}
            />
          </ErrorBoundary>
        ))}
        {sections.length === 0 && (
          <Callout tone="fail" title="This document has no sections">
            A Composition with no sections carries a title, a subject and nothing else. Everything
            in the bundle is still in the payload, and Loupe lists it below, but nothing here says
            what any of it is FOR.
          </Callout>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One section
// ---------------------------------------------------------------------------

type SectionTab = 'structured' | 'narrative';

function SectionView({
  section,
  index,
  from,
  auPs,
  documentIndex,
}: {
  section: FhirNode;
  index: BundleIndex;
  from: IndexedEntry;
  auPs: boolean;
  documentIndex: number;
}): ReactNode {
  const context: RenderContext = { index, from };
  const loinc = sectionLoinc(section);
  const slice = sectionSlice(loinc);
  const title = strField(section, 'title');
  const references = arrField(section, 'entry');
  const status = narrativeStatus(section['text']);
  const narrativeFirst = narrativeMayExceedEntries(status);
  const [tab, setTab] = useState<SectionTab>(narrativeFirst ? 'narrative' : 'structured');
  const emptyReason = section['emptyReason'];
  const nested = arrField(section, 'section');
  const notes = arrField(section, 'extension').filter(
    (extension) => strField(extension, 'url') === SECTION_NOTE_URL,
  );

  const resolved = references.map((reference) => ({
    reference,
    resolution: index.resolve(reference, from),
  }));
  const missing = resolved.filter(
    (item) => item.resolution.kind !== 'resolved' && item.resolution.kind !== 'contained',
  );

  return (
    <section className="doc-section">
      <header className="doc-section-head">
        {/* The heading is the author's own wording. The code is identity and sits
            beside it, never in place of it. */}
        <h3 className="doc-section-title">
          {title ?? slice?.verifiedDisplay ?? `Section ${documentIndex + 1}`}
        </h3>
        <div className="doc-section-meta">
          {loinc !== undefined && (
            <span
              className="code-chip mono"
              title={
                slice?.verifiedDisplay === undefined
                  ? `LOINC ${loinc}. Loupe does not carry a verified display for this code, and it will not guess one.`
                  : `LOINC ${loinc}, whose published display is "${slice.verifiedDisplay}". The heading above is the author's own title, which is what a human should read.`
              }
            >
              LOINC {loinc}
            </span>
          )}
          {title === undefined && (
            <Chip tone="warn" title="AU PS makes section.title 1..1 must-support">
              No title
            </Chip>
          )}
          {loinc === undefined && (
            <Chip tone="warn">No LOINC code, so this section cannot be identified by machine</Chip>
          )}
          <Chip tone="info">
            {references.length} {references.length === 1 ? 'entry' : 'entries'}
          </Chip>
        </div>
        <div
          className="doc-section-tabs"
          role="group"
          aria-label={`How to read ${title ?? 'this section'}`}
        >
          {(['structured', 'narrative'] as const).map((option) => (
            <button
              key={option}
              type="button"
              className={tab === option ? 'view-tab is-current' : 'view-tab'}
              aria-pressed={tab === option}
              onClick={() => setTab(option)}
            >
              {option === 'structured' ? 'Entries' : 'Narrative'}
            </button>
          ))}
        </div>
      </header>

      {narrativeFirst && (
        <Callout tone="warn" title="This section opens on its narrative on purpose">
          Its <span className="mono">text.status</span> is <span className="mono">{status}</span>,
          which is the author stating that the narrative carries content the entries do not. Reading
          only the entries here loses part of what was sent.
        </Callout>
      )}

      {notes.map((note, position) => (
        <Callout key={position} tone="info" title="A note on this section">
          {strField(note, 'valueString') ?? strField(note, 'valueMarkdown') ?? 'Empty note'}
        </Callout>
      ))}

      {nested.length > 0 && auPs && (
        <Callout tone="fail" title="Subsections are not allowed here">
          This payload claims AU PS, which sets <span className="mono">section.section</span> to
          ..0, and this section has {nested.length} of them. Their content is rendered below so
          nothing is lost, but a conformant receiver would reject the document.
        </Callout>
      )}

      {tab === 'narrative' ? (
        <Narrative narrative={section['text']} entryCount={references.length} />
      ) : (
        <div className="section-entries">
          {references.length === 0 ? (
            <EmptySection emptyReason={emptyReason} hasNarrative={section['text'] !== undefined} />
          ) : (
            resolved.map(({ reference, resolution }, position) => {
              if (resolution.kind === 'resolved') {
                return (
                  <RenderedResource
                    key={position}
                    resource={resolution.entry.resource}
                    context={context}
                    entry={resolution.entry}
                  />
                );
              }
              if (resolution.kind === 'contained') {
                return (
                  <RenderedResource
                    key={position}
                    resource={resolution.resource}
                    context={context}
                  />
                );
              }
              return (
                <div key={position} className="section-entry-missing">
                  <ReferenceValue value={reference} context={context} />
                </div>
              );
            })
          )}
          {missing.length > 0 && (
            <p className="value-note">
              {missing.length} of this section's {references.length} entries point at resources this
              bundle does not carry. In a conformant IPS or AU PS every entry has a{' '}
              <span className="mono">fullUrl</span>, so a reference with no target here is a defect
              in the payload rather than something a viewer can work around.
            </p>
          )}
        </div>
      )}

      {nested.length > 0 && (
        <div className="nested-sections">
          {nested.map((child, position) => (
            <SectionView
              key={position}
              section={asRecord(child) ?? {}}
              index={index}
              from={from}
              auPs={auPs}
              documentIndex={position}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * An empty section, and the three different things it can mean.
 *
 * This is the whole "absence is not emptiness" rule in one component: a source
 * that states why a section is empty has said something, and a source that says
 * nothing has not. Rendering both as white space collapses two different facts
 * into one, and it is the more dangerous of the two directions: a reader takes
 * blank space to mean "nothing to report".
 */
function EmptySection({
  emptyReason,
  hasNarrative,
}: {
  emptyReason: unknown;
  hasNarrative: boolean;
}): ReactNode {
  if (emptyReason !== undefined) {
    const text = codeableConceptText(emptyReason);
    const code = strField(arrField(emptyReason, 'coding')[0], 'code');
    return (
      <div className="absence-row">
        <div className="absence-headline">
          <strong>{text ?? 'The source stated a reason this section is empty'}</strong>
          <ConceptValue value={emptyReason} />
        </div>
        <p className="value-note">
          {code === 'nilknown'
            ? 'None recorded, and the source said so: nothing is known to record here. That is a statement about the patient, not a gap in the payload.'
            : code === 'notasked'
              ? 'Nobody has been asked, so the payload says nothing about the patient either way. This is NOT "the patient has none".'
              : code === 'unavailable' || code === 'withheld'
                ? 'The source has the information or cannot say, and has deliberately not put it here. Absent for a stated reason is not the same as absent because there is nothing.'
                : 'The source stated a reason this section is empty, which is a statement rather than a gap.'}
        </p>
      </div>
    );
  }
  return (
    <Callout tone="warn" title="Empty, with nothing said about why">
      This section has no entries and no <span className="mono">emptyReason</span>, so it does not
      say whether the patient has nothing to record or whether nobody looked.
      {hasNarrative
        ? ' Its narrative may say more; it is one click away above.'
        : ' It has no narrative either, so there is nothing here at all.'}
    </Callout>
  );
}
