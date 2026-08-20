/**
 * What came out of the link, whatever it turned out to be.
 *
 * Five kinds of file arrive here and all five are handled, because "Loupe showed
 * nothing" must never be a possible outcome: a FHIR document, a FHIR collection
 * or single resource, a signed health card, an API access token file, and a file
 * that decrypted into something nobody recognises. A file that did not open at
 * all is handled too, and it says what stopped it.
 *
 * The rule the whole module is built around: **every entry is accounted for.**
 * A resource is either rendered by its own view, rendered by the generic tree, or
 * listed and counted under "no dedicated renderer" with a one-line summary and
 * its JSON. There is no fourth outcome. The incumbent viewer renders only
 * resources reachable from `Composition.section.entry` and `console.warn`s the
 * rest, so a `Provenance` (which relates to its targets rather than sitting in a
 * section) is invisible on a page that looks complete, and that is
 * indistinguishable from the server never having sent it.
 *
 * The reconciliation line at the top of every bundle is the proof: entries in,
 * entries rendered, entries listed. If those three numbers ever fail to add up,
 * the bug is here and it is visible rather than silent.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { FileQuestion, KeyRound, PackageOpen } from 'lucide-react';
import { formatBytes } from '../../core/bytes';
import type { OpenedFile } from '../../core/pipeline';
import { inspectJws, parseHealthCardFile } from '../../core/shc';
import { Callout, Chip, CodeBlock, Disclosure, EmptyState, Secret } from '../primitives';
import { ShcVerification } from '../shc';
import {
  buildBundleIndex,
  censusReferences,
  unreferencedEntries,
  type BundleIndex,
  type IndexedEntry,
} from './BundleIndex';
import { claimedEntries, CompositionView } from './CompositionView';
import { ErrorBoundary } from './ErrorBoundary';
import { hasRenderer, RenderedResource } from './registry';
import { DetailTable } from './ResourceCard';
import {
  DateValue,
  IdentifierValue,
  primitiveText,
  UnhandledRow,
  type RenderContext,
} from './UnknownResource';
import {
  asRecord,
  profileName,
  profilesOf,
  resourceTypeOf,
  strField,
  summariseResource,
} from './display';

// ---------------------------------------------------------------------------
// The entry point
// ---------------------------------------------------------------------------

export function PayloadView({ file }: { file: OpenedFile }): ReactNode {
  if (file.content === undefined) return <UnopenedFile file={file} />;
  return (
    <ErrorBoundary label="this payload" unit="section" subject={file.content}>
      {file.kind === 'fhir' ? (
        <FhirPayload content={file.content} />
      ) : file.kind === 'smart-health-card' ? (
        <HealthCardPayload file={file} />
      ) : file.kind === 'smart-api-access' ? (
        <ApiAccessPayload content={file.content} />
      ) : (
        <UnrecognisedPayload file={file} />
      )}
    </ErrorBoundary>
  );
}

// ---------------------------------------------------------------------------
// A file that never opened
// ---------------------------------------------------------------------------

/**
 * The pane says what stopped this file and nothing else.
 *
 * An empty payload pane beside a failed trace reads as the TOOL having failed
 * rather than the link, which is precisely the misattribution this project
 * exists to stop, so the failure is stated here in the place the payload would
 * have been.
 */
function UnopenedFile({ file }: { file: OpenedFile }): ReactNode {
  const failure = file.failure;
  if (failure === undefined) {
    return (
      <EmptyState icon={<PackageOpen size={20} aria-hidden />} title="Nothing decrypted yet">
        <p>
          This file has not been opened. The trace beside this pane has every step that ran, and the
          last one is where it stopped.
        </p>
      </EmptyState>
    );
  }
  return (
    <div className="payload-failure">
      <Callout tone="fail" title="This file did not open">
        <p>{failure.message}</p>
        {failure.hint !== undefined && <p className="payload-hint">{failure.hint}</p>}
      </Callout>
      <DetailTable
        rows={[
          { key: 'file', value: `${file.index + 1}` },
          { key: 'source', value: sourceWord(file.source) },
          ...(file.declaredContentType === undefined
            ? []
            : [
                {
                  key: 'declared as',
                  value: file.declaredContentType,
                  mono: true,
                  note: 'What the manifest said this file would be. Loupe never got far enough to check.',
                },
              ]),
          ...(file.bytes === undefined ? [] : [{ key: 'size', value: formatBytes(file.bytes) }]),
        ]}
      />
      {file.plaintext !== undefined && (
        <Disclosure summary="What did come out, verbatim">
          <p className="value-note">
            Decryption succeeded and the result is below. Whatever is wrong is in the file that was
            encrypted, not in the encryption, which is a different person to talk to.
          </p>
          <CodeBlock maxHeight={320}>{file.plaintext.slice(0, 4000)}</CodeBlock>
        </Disclosure>
      )}
    </div>
  );
}

function sourceWord(source: OpenedFile['source']): string {
  switch (source) {
    case 'embedded':
      return 'Embedded in the manifest, so no second request was needed';
    case 'location':
      return 'Fetched from a location URL given by the manifest';
    default:
      return 'Fetched directly, with no manifest';
  }
}

// ---------------------------------------------------------------------------
// FHIR
// ---------------------------------------------------------------------------

export function FhirPayload({ content }: { content: unknown }): ReactNode {
  const index = useMemo(() => buildBundleIndex(content), [content]);
  const census = useMemo(() => censusReferences(index), [index]);
  const composition = index.composition;
  // Every hook runs before the first early return below. React counts hooks by
  // call order, so a `return` above one turns "this payload is not FHIR" into a
  // crash on the render AFTER it, which is the worst kind of bug to chase.
  const claimed = useMemo(
    () => (composition === undefined ? new Set<number>() : claimedEntries(index, composition)),
    [index, composition],
  );
  const leftovers = useMemo(() => unreferencedEntries(index, claimed), [index, claimed]);
  const context: RenderContext = { index };
  const renderable = leftovers.filter((entry) => hasRenderer(entry.resourceType));
  const unhandled = leftovers.filter((entry) => !hasRenderer(entry.resourceType));

  if (resourceTypeOf(index.root) === undefined) {
    return (
      <Callout tone="fail" title="This is JSON, but it is not a FHIR resource">
        <p>
          The file decrypted and parsed as JSON, and it carries no{' '}
          <span className="mono">resourceType</span>, so there is nothing here for a FHIR receiver
          to work with. Everything the object does carry is below, so you can see what was sent
          instead.
        </p>
        <CodeBlock language="json" maxHeight={400}>
          {JSON.stringify(content, null, 2)}
        </CodeBlock>
      </Callout>
    );
  }

  if (!index.isBundle) {
    return (
      <div className="payload">
        <SingleResourceHeader index={index} />
        <RenderedResource
          resource={index.root}
          context={context}
          {...(index.entries[0] === undefined ? {} : { entry: index.entries[0] })}
        />
      </div>
    );
  }

  return (
    <div className="payload">
      <BundleHeader
        index={index}
        census={census}
        inSections={claimed.size}
        renderedBelow={renderable.length}
        unhandled={unhandled.length}
      />

      {composition !== undefined && (
        <ErrorBoundary label="this document" unit="section" subject={composition.resource}>
          <CompositionView index={index} entry={composition} />
        </ErrorBoundary>
      )}

      {renderable.length > 0 && (
        <section className="payload-rest">
          <h2 className="payload-heading">
            {composition === undefined
              ? `${renderable.length} ${renderable.length === 1 ? 'resource' : 'resources'} in this bundle`
              : `Also in this payload: ${renderable.length} ${renderable.length === 1 ? 'resource' : 'resources'} no section points at`}
          </h2>
          {composition !== undefined && (
            <p className="payload-note">
              These are in the bundle but not referenced from any{' '}
              <span className="mono">Composition.section.entry</span>. That is normal and it is
              where origin lives: a <span className="mono">Provenance</span> relates to its records
              by <span className="mono">target</span> rather than sitting in a section, so a viewer
              that renders only section entries never shows any of this.
            </p>
          )}
          {groupByType(renderable).map(([type, entries]) => (
            <div key={type} className="payload-group">
              <h3 className="payload-group-title">
                {type}
                <span className="value-note">
                  {entries.length} {entries.length === 1 ? 'entry' : 'entries'}
                </span>
              </h3>
              {entries.map((entry) => (
                <RenderedResource
                  key={entry.index}
                  resource={entry.resource}
                  context={context}
                  entry={entry}
                />
              ))}
            </div>
          ))}
        </section>
      )}

      <UnhandledList entries={unhandled} context={context} />
    </div>
  );
}

function groupByType<T extends { resourceType: string }>(
  entries: readonly T[],
): Array<[string, T[]]> {
  const groups = new Map<string, T[]>();
  for (const entry of entries) {
    const list = groups.get(entry.resourceType);
    if (list === undefined) groups.set(entry.resourceType, [entry]);
    else list.push(entry);
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

/**
 * The list that makes the promise true.
 *
 * Every entry nothing has a renderer for, with its type, a one-line summary and
 * its JSON, and the count in the heading. A reader can see at a glance that the
 * payload carried three things Loupe cannot lay out nicely, which is a completely
 * different statement from a page that quietly omits them.
 */
function UnhandledList({
  entries,
  context,
}: {
  entries: readonly IndexedEntry[];
  context: RenderContext;
}): ReactNode {
  if (entries.length === 0) return null;
  const types = [...new Set(entries.map((entry) => entry.resourceType))];
  return (
    <section className="payload-unhandled">
      <h2 className="payload-heading">
        {entries.length} {entries.length === 1 ? 'resource' : 'resources'} with no dedicated
        renderer
      </h2>
      <p className="payload-note">
        {types.length === 1 ? 'The type is' : 'The types are'} {types.join(', ')}. Loupe has no
        purpose-built view for {types.length === 1 ? 'it' : 'them'}, so each one is listed here with
        every field it carries and its raw JSON. Nothing has been dropped, and this list existing at
        all is the point: a resource that vanishes from the screen is indistinguishable from one the
        server never sent.
      </p>
      <div className="unhandled-list">
        {entries.map((entry) => (
          <ErrorBoundary key={entry.index} label={`this ${entry.resourceType}`} unit="row">
            <UnhandledRow entry={entry} context={context} />
          </ErrorBoundary>
        ))}
      </div>
    </section>
  );
}

function SingleResourceHeader({ index }: { index: BundleIndex }): ReactNode {
  const type = resourceTypeOf(index.root) ?? 'Resource';
  return (
    <header className="payload-head">
      <h2 className="payload-heading">One {type}, not a bundle</h2>
      <p className="payload-note">
        This file carries a single resource rather than a Bundle, so there is nothing for its
        references to resolve against: any reference it makes points outside the payload by
        definition. That is legal and it is worth knowing before you go looking for the patient.
      </p>
      <ProfileChips resource={index.root} />
    </header>
  );
}

function ProfileChips({ resource }: { resource: unknown }): ReactNode {
  const profiles = profilesOf(resource);
  if (profiles.length === 0) {
    return (
      <p className="value-note">
        No <span className="mono">meta.profile</span>: this payload claims conformance to nothing,
        so there is no profile to hold it to. A viewer that keys its layout off a profile canonical
        shows nothing at all for a payload like this.
      </p>
    );
  }
  return (
    <div className="profile-chips">
      {profiles.map((profile) => (
        <Chip key={profile} tone="info" title={profile}>
          {profileName(profile)}
        </Chip>
      ))}
    </div>
  );
}

/**
 * The bundle's own facts, and the reconciliation.
 *
 * The structural checks here are the ones a browser can genuinely make with no
 * terminology server and no IG package, and the panel says so in as many words.
 * A tool that implies conformance it did not check is worse than one that stays
 * quiet, and that overclaim is a recurring pattern in FHIR tooling.
 */
function BundleHeader({
  index,
  census,
  inSections,
  renderedBelow,
  unhandled,
}: {
  index: BundleIndex;
  census: ReturnType<typeof censusReferences>;
  inSections: number;
  renderedBelow: number;
  unhandled: number;
}): ReactNode {
  const total = index.entries.length;
  const accounted = inSections + renderedBelow + unhandled;
  const timestamp = strField(index.root, 'timestamp');
  const identifier = asRecord(index.root['identifier']);

  return (
    <header className="payload-head">
      <div className="payload-title-row">
        <h2 className="payload-heading">
          {index.bundleType === undefined ? 'Bundle with no type' : `${index.bundleType} Bundle`}
        </h2>
        <Chip tone="info">
          {total} {total === 1 ? 'entry' : 'entries'}
        </Chip>
        {index.composition !== undefined && index.bundleType !== 'document' && (
          <Chip tone="warn" title="Bundle.type is fixed to document in both IPS and AU PS">
            Composition in a {index.bundleType ?? 'typeless'} bundle
          </Chip>
        )}
      </div>

      <ProfileChips resource={index.root} />

      <p className="payload-reconciliation">
        {index.composition === undefined
          ? `${renderedBelow} of ${total} ${total === 1 ? 'entry is' : 'entries are'} rendered below`
          : `${inSections} of ${total} entries are claimed by the document's sections, ${renderedBelow} more are rendered after it`}
        {unhandled > 0
          ? `, and ${unhandled} ${unhandled === 1 ? 'is' : 'are'} listed with no dedicated renderer.`
          : '.'}
        {accounted === total
          ? ' Every entry in this bundle is on this page.'
          : ` Loupe accounts for ${accounted} of ${total}, which is a bug in Loupe rather than in the payload: please say so.`}
      </p>

      <DetailTable
        rows={[
          ...(timestamp === undefined
            ? [
                {
                  key: 'timestamp',
                  value: 'Not stated',
                  tone: 'warn' as const,
                  note: 'IPS makes Bundle.timestamp 1..1 must-support. Without it there is nothing to say when this document was assembled.',
                },
              ]
            : [{ key: 'timestamp', value: <DateValue value={timestamp} /> }]),
          ...(identifier === undefined
            ? [
                {
                  key: 'identifier',
                  value: 'Not stated',
                  note: 'IPS makes Bundle.identifier 1..1. A collection legitimately carries none: it asserts no conformance and no completeness, so there is nothing to identify a document by.',
                },
              ]
            : [{ key: 'identifier', value: <IdentifierValue value={identifier} /> }]),
          {
            key: 'fullUrl',
            value:
              index.missingFullUrl === 0
                ? 'Every entry has one'
                : `${index.missingFullUrl} of ${total} entries have none`,
            tone: index.missingFullUrl === 0 ? 'pass' : 'warn',
            note:
              index.missingFullUrl === 0
                ? 'So every entry is addressable, and a reference that does not resolve is unambiguously a defect rather than an ambiguity.'
                : 'IPS and AU PS both make Bundle.entry.fullUrl 1..1. An entry without one cannot be the target of any reference, so anything pointing at it dangles.',
          },
          ...(index.duplicateKeys.length === 0
            ? []
            : [
                {
                  key: 'duplicate keys',
                  value: index.duplicateKeys.join(', '),
                  mono: true,
                  tone: 'warn' as const,
                  note: 'Two or more entries claim the same key, and R4 leaves it undefined which one a reference means. Loupe resolves neither rather than picking.',
                },
              ]),
          {
            key: 'references',
            value: (
              <span className="census">
                {census.total} in total: {census.resolved} resolved, {census.contained} contained,{' '}
                {census.external} external, {census.unresolved} not carried here
              </span>
            ),
            tone: census.unresolved === 0 ? 'pass' : 'info',
            note: referenceNote(census),
          },
        ]}
      />
      <p className="payload-caveat">
        These are structural checks, not profile validation. A browser cannot slice by a code-based
        discriminator without an expansion, cannot read SNOMED CT-AU without that edition, and has
        no must-support semantics without the IG package. For a conformance answer, run the payload
        through a validator with the implementation guide loaded.
      </p>
    </header>
  );
}

function referenceNote(census: ReturnType<typeof censusReferences>): string {
  if (census.unresolved === 0) {
    return 'Every reference in this payload points at something the payload carries, is contained, or is explicitly external.';
  }
  const urn = census.byReason['relative-against-urn-uuid'];
  const parts = [
    `${census.unresolved} references have no target here.`,
    urn > 0
      ? `${urn} of them are relative references inside urn:uuid entries, which R4 2.36.4.1 says have no defined meaning: there is no base to make them absolute against. That is a payload defect rather than something a viewer can work around, and it is extremely common, because a summary assembled by copying resources off a REST server keeps the relative references that server wrote.`
      : undefined,
    'In a collection this is expected: it carries the records the patient chose and asserts nothing about completeness.',
  ];
  return parts.filter((part) => part !== undefined).join(' ');
}

// ---------------------------------------------------------------------------
// Health cards
// ---------------------------------------------------------------------------

/**
 * A signed card is two payloads in one: the signature story, and the FHIR bundle
 * inside `vc.credentialSubject.fhirBundle`.
 *
 * The verification panel goes ABOVE the clinical content and is owned by another
 * module, because a reader has to know whether anything below it was signed by
 * somebody they trust before they read it. The bundle renders through exactly the
 * same path as a bare FHIR file, so a card's contents are never rendered by a
 * lesser code path than a document's.
 */
function HealthCardPayload({ file }: { file: OpenedFile }): ReactNode {
  const parsed = useMemo(() => parseHealthCardFile(file.content), [file.content]);
  const cards = useMemo(
    () => parsed.cards.map((card) => ({ jws: card, inspection: inspectJws(card) })),
    [parsed.cards],
  );

  return (
    <div className="payload payload-card">
      {/* Owned by src/ui/shc. This module codes against the `file` prop only. */}
      <ShcVerification file={file} />

      {cards.length === 0 && (
        <Callout tone="fail" title="This health card file carries no cards">
          The wrapper parsed and its <span className="mono">verifiableCredential</span> array is
          empty or absent, so there is nothing signed to check and nothing clinical to show.
        </Callout>
      )}

      {cards.map(({ inspection }, position) => (
        <section key={position} className="card-payload">
          {cards.length > 1 && (
            <h2 className="payload-heading">
              Card {position + 1} of {cards.length}
            </h2>
          )}
          {!inspection.ok ? (
            <Callout tone="fail" title="This card could not be read">
              <p>
                The signature story is above. The card's own contents cannot be shown because it did
                not decode:
              </p>
              <ul>
                {inspection.findings.map((finding, index) => (
                  <li key={index}>{finding.title}</li>
                ))}
              </ul>
            </Callout>
          ) : inspection.card.fhirBundle === undefined ? (
            <Callout tone="warn" title="This card carries no FHIR bundle">
              <p>
                The card decoded and its claims are readable, and{' '}
                <span className="mono">vc.credentialSubject.fhirBundle</span> is absent, so it has
                no clinical content at all. A card in this shape verifies perfectly and shows
                nothing, which is a confusing thing to debug from the receiving end.
              </p>
              <CodeBlock language="json" maxHeight={280}>
                {JSON.stringify(inspection.card.raw, null, 2)}
              </CodeBlock>
            </Callout>
          ) : (
            <>
              <DetailTable
                dense
                rows={[
                  ...(inspection.card.iss === undefined
                    ? []
                    : [
                        {
                          key: 'iss',
                          value: inspection.card.iss,
                          mono: true,
                          note: 'The issuer the signature is checked against. It is a claim about who signed, not about who the patient is.',
                        },
                      ]),
                  ...(inspection.card.fhirVersion === undefined
                    ? []
                    : [{ key: 'fhirVersion', value: inspection.card.fhirVersion, mono: true }]),
                  {
                    key: 'types',
                    value:
                      inspection.card.types.length === 0
                        ? 'None stated'
                        : inspection.card.types.join(', '),
                    mono: true,
                  },
                  {
                    key: 'compression',
                    value: `${formatBytes(inspection.sizes.compressed)} compressed, ${formatBytes(
                      inspection.sizes.inflated,
                    )} inflated`,
                  },
                ]}
              />
              <ErrorBoundary label="this card's bundle" unit="section">
                <FhirPayload content={inspection.card.fhirBundle} />
              </ErrorBoundary>
            </>
          )}
        </section>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// API access
// ---------------------------------------------------------------------------

/**
 * A `smart-api-access` file is not clinical data: it is credentials for reaching
 * an API that holds some.
 *
 * Loupe shows what it contains and does not use it. Spending somebody's token to
 * fetch their record, on their behalf, without being asked, is exactly the
 * unrequested request this tool promises never to make, and a token is a secret
 * on a projected screen, so it is masked until revealed.
 */
function ApiAccessPayload({ content }: { content: unknown }): ReactNode {
  const record = asRecord(content) ?? {};
  const [revealed, setRevealed] = useState(false);
  const token = strField(record, 'access_token');
  const refresh = strField(record, 'refresh_token');

  return (
    <div className="payload payload-api">
      <Callout tone="info" title="This file is API access, not a record">
        <p>
          It carries credentials for reaching a FHIR API rather than any clinical content. Loupe
          does not use them: it makes no request you did not ask for, and it never acts as you
          against somebody's API. What the file says is below.
        </p>
      </Callout>
      <DetailTable
        rows={[
          {
            key: 'aud',
            value: strField(record, 'aud') ?? 'Not stated',
            mono: true,
            note: 'The FHIR server these credentials are for. Everything else in this file is meaningless without it.',
          },
          ...(token === undefined
            ? [
                {
                  key: 'access_token',
                  value: 'Not present',
                  tone: 'warn' as const,
                  note: 'A smart-api-access file with no token grants nothing.',
                },
              ]
            : [
                {
                  key: 'access_token',
                  value: (
                    <Secret
                      value={token}
                      label="access token"
                      revealed={revealed}
                      onReveal={setRevealed}
                    />
                  ),
                  note: 'Masked because this screen is often projected. It is a bearer credential: anyone who can read it can use it.',
                },
              ]),
          ...(refresh === undefined
            ? []
            : [
                {
                  key: 'refresh_token',
                  value: (
                    <Secret
                      value={refresh}
                      label="refresh token"
                      revealed={revealed}
                      onReveal={setRevealed}
                    />
                  ),
                  note: 'A refresh token usually outlives the access token by a long way, which makes it the more sensitive of the two.',
                },
              ]),
          ...(record['expires_in'] === undefined
            ? []
            : [
                {
                  key: 'expires_in',
                  value: `${primitiveText(record['expires_in']) ?? 'stated in a shape that is not a number'} seconds`,
                  note: 'Relative to when the token was issued, which is not when you opened this link.',
                },
              ]),
          ...(strField(record, 'scope') === undefined
            ? []
            : [
                {
                  key: 'scope',
                  value: strField(record, 'scope') as string,
                  mono: true,
                  note: 'What the token is allowed to do. A scope set wider than the share is worth raising with whoever minted it.',
                },
              ]),
          ...(strField(record, 'token_type') === undefined
            ? []
            : [{ key: 'token_type', value: strField(record, 'token_type') as string, mono: true }]),
        ]}
      />
      <Disclosure summary="The file as it arrived">
        <CodeBlock language="json" maxHeight={280}>
          {JSON.stringify(content, null, 2)}
        </CodeBlock>
      </Disclosure>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Something else entirely
// ---------------------------------------------------------------------------

/**
 * The file decrypted and Loupe cannot say what it is.
 *
 * This is a real outcome and it deserves better than a shrug: the bytes are
 * here, they came out of a correctly encrypted file, and the question is what
 * whoever built the payload intended. So the pane states what was checked, in
 * order, and then shows the content.
 */
function UnrecognisedPayload({ file }: { file: OpenedFile }): ReactNode {
  const record = asRecord(file.content);
  return (
    <div className="payload payload-unknown">
      <Callout tone="warn" title="This file opened, and Loupe cannot tell what it is">
        <p>
          Decryption and parsing both succeeded, so the key and the bytes are fine. What came out is
          not one of the three things a health link file is defined to carry.
        </p>
      </Callout>
      <DetailTable
        rows={[
          {
            key: 'declared as',
            value: file.declaredContentType ?? 'Nothing: the manifest gave no contentType',
            mono: file.declaredContentType !== undefined,
            note: 'Loupe goes by the content rather than the declaration, because content is what a renderer has to work with. A receiver that filters on the declared type would skip this file entirely.',
          },
          {
            key: 'looked for',
            value:
              'a verifiableCredential array (health card), a resourceType (FHIR), an access_token or aud (API access)',
          },
          {
            key: 'found',
            value:
              record === undefined
                ? `a JSON ${Array.isArray(file.content) ? 'array' : typeof file.content}`
                : `an object with ${Object.keys(record).length} members: ${Object.keys(record).slice(0, 8).join(', ')}`,
            mono: record !== undefined,
          },
          ...(file.bytes === undefined ? [] : [{ key: 'size', value: formatBytes(file.bytes) }]),
        ]}
      />
      {record !== undefined && (
        <p className="payload-note">
          <FileQuestion size={13} aria-hidden /> One line of what it might be:{' '}
          {summariseResource(record)}
        </p>
      )}
      <CodeBlock language="json" maxHeight={420}>
        {file.plaintext ?? JSON.stringify(file.content, null, 2)}
      </CodeBlock>
      <p className="payload-caveat">
        <KeyRound size={13} aria-hidden /> Worth knowing: nothing here was ever sent anywhere. The
        file was decrypted in this tab with the key from the link, and this pane is the only place
        its contents exist.
      </p>
    </div>
  );
}
