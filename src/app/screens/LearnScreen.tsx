/**
 * Learn: the specification as the life of one link.
 *
 * The content is not here. It lives in `src/content/spec-guide.ts` as typed
 * data, checked by `spec-guide.test.ts` against three things prose in a debugger
 * gets wrong when it rots: a citation nobody can follow, a rule described that
 * the engine no longer runs, and a worked example that is not what it claims to
 * decode to. This screen's whole job is to render that data faithfully.
 *
 * Three presentation decisions are deliberate.
 *
 * 1. **Every quote carries its section heading and a link out.** A teaching tool
 *    that paraphrases normative text teaches something the reader cannot then
 *    find in the specification, and one that quotes without saying where from is
 *    asking to be believed. So a quote block is a `<figure>`: the sentence, then
 *    the spec, the section as printed, and a link.
 * 2. **In-page navigation is JavaScript, not an `href`.** The hash belongs to the
 *    router, and a link's payload lives in it (`#shlink:/…`), so an `href="#…"`
 *    here would throw away the app's primary state. Targets therefore resolve
 *    through `anchorForTarget` and are scrolled to and focused, which is also
 *    what makes the anatomy's clickable segments work.
 * 3. **The table of contents tracks scroll with an IntersectionObserver.** A
 *    scroll listener recomputing offsets on every frame is the version of this
 *    that janks on a projector-driving laptop; the observer fires only when a
 *    section boundary crosses the line, and the negative bottom margin is what
 *    stops the last long section claiming the highlight the whole way down.
 */
import { useMemo, type ReactNode } from 'react';
import { Check, ExternalLink, Quote as QuoteIcon } from 'lucide-react';
import { clsx } from 'clsx';
import type { Citation } from '../../core/trace';
import { corsRequirementsFor, curlForPreflight } from '../../core/net/curl';
import { sampleById } from '../../fixtures';
import {
  ANATOMIES,
  EXAMPLE_LINK,
  EXAMPLE_MANIFEST_URL,
  EXAMPLE_VIEWER_PREFIX,
  GUIDE_SECTIONS,
  type Anatomy,
  type AnatomyId,
  type GuideBlock,
  type GuideSection,
  type PayloadMember,
} from '../../content/spec-guide';
import { GLOSSARY, type GlossaryEntry } from '../../content/glossary';
import {
  Callout,
  Chip,
  CodeBlock,
  FieldTable,
  StatusIcon,
  TONE_WORD,
  type FieldRow,
} from '../../ui/primitives';
import { SegmentMap } from '../../ui/SegmentMap';
import { useSettings } from '../store';
import { PageNav, useFollow } from '../PageNav';

// ---------------------------------------------------------------------------
// The worked example
// ---------------------------------------------------------------------------

/**
 * The anatomy is built from the implementation guide's own example, read out of
 * the sample catalogue so this page and the one-click sample cannot drift apart.
 * The catalogue holds it in the bare form a QR carries; the guide documents the
 * viewer-prefixed form, and the two differ by the prefix alone, so it is wrapped
 * here to show all four parts. If the catalogue entry ever disappears, the
 * guide's own copy of the same link stands in.
 */
const EXAMPLE = ((): string => {
  const fixture = sampleById('ig-ips-link')?.link;
  if (fixture === undefined) return EXAMPLE_LINK;
  return fixture.startsWith('shlink:') ? `${EXAMPLE_VIEWER_PREFIX}#${fixture}` : fixture;
})();

const GLOSSARY_ANCHOR = 'glossary';

const NAV_ITEMS: ReadonlyArray<{ anchor: string; label: string }> = [
  ...GUIDE_SECTIONS.map((section) => ({ anchor: `section-${section.id}`, label: section.nav })),
  { anchor: GLOSSARY_ANCHOR, label: 'Vocabulary' },
];

const termAnchor = (term: string): string =>
  `term-${term.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

export function LearnScreen(): ReactNode {
  const recipient = useSettings((state) => state.recipient);
  const follow = useFollow();

  // A page served from `file://` has no origin to name, and the Origin header in
  // a copied command has to be something a server operator can read, so a
  // stand-in is used rather than the literal "null".
  const origin = useMemo(() => {
    const value = window.location.origin;
    return value === '' || value === 'null' ? 'https://viewer.example.org' : value;
  }, []);

  return (
    <div className="learn">
      <header className="learn-head">
        <h1>The life of a link</h1>
        <p className="learn-lede">
          What a SMART Health Link is, what each field means, and where the specification says so.
          Every quoted sentence is verbatim and carries the section it came from, so you can take an
          argument back to the source rather than to this page.
        </p>
      </header>

      <div className="learn-body">
        <PageNav items={NAV_ITEMS} label="Sections of this guide" />

        <div className="learn-sections">
          {GUIDE_SECTIONS.map((section) => (
            <GuideSectionView
              key={section.id}
              section={section}
              recipient={recipient}
              origin={origin}
              onFollow={follow}
            />
          ))}
          <GlossaryView onFollow={follow} />
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Scroll tracking, and following a target
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Sections and blocks
// ---------------------------------------------------------------------------

interface BlockContext {
  recipient: string;
  origin: string;
  onFollow: (anchor: string) => void;
}

function GuideSectionView({
  section,
  recipient,
  origin,
  onFollow,
}: { section: GuideSection } & BlockContext): ReactNode {
  return (
    <section className="learn-section" id={`section-${section.id}`} tabIndex={-1}>
      <h2>{section.title}</h2>
      <p className="learn-section-lede">{section.lede}</p>
      {section.blocks.map((block, index) => (
        <BlockView
          key={index}
          block={block}
          recipient={recipient}
          origin={origin}
          onFollow={onFollow}
        />
      ))}
    </section>
  );
}

function BlockView({
  block,
  recipient,
  origin,
  onFollow,
}: { block: GuideBlock } & BlockContext): ReactNode {
  switch (block.kind) {
    case 'prose':
      return (
        <div className="learn-prose">
          {block.paragraphs.map((paragraph, index) => (
            <p key={index}>{paragraph}</p>
          ))}
        </div>
      );

    case 'quote':
      return <CitationView citation={block.citation} />;

    case 'members':
      return (
        <div className="learn-members">
          {block.members.map((member) => (
            <MemberView key={member.name} member={member} />
          ))}
        </div>
      );

    case 'wire':
      return (
        <div className="learn-wire">
          <p className="learn-caption">{block.caption}</p>
          {block.members.map((member) => (
            <article className="learn-wire-member" key={member.name}>
              <h4>
                <span className="mono">{member.name}</span>
                <Chip>{member.cardinality}</Chip>
                <span className="learn-wire-type">{member.type}</span>
              </h4>
              <p>{member.purpose}</p>
              {member.note !== undefined && <p className="learn-note">{member.note}</p>}
              {member.quote !== undefined && <CitationView citation={member.quote} compact />}
            </article>
          ))}
        </div>
      );

    case 'table': {
      const toned = block.rows.some((row) => row.tone !== undefined);
      return (
        <figure className="learn-table">
          <figcaption className="learn-caption">{block.caption}</figcaption>
          <div className="scroll-x">
            <table>
              <thead>
                <tr>
                  {block.columns.map((column, index) => (
                    <th key={index} scope="col">
                      {column}
                    </th>
                  ))}
                  {toned && <th scope="col">Verdict</th>}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>
                    {row.cells.map((cell, cellIndex) => (
                      <td key={cellIndex}>{cell}</td>
                    ))}
                    {toned && (
                      <td className="learn-table-verdict">
                        {row.tone !== undefined && (
                          <span className={`tone tone-${row.tone}`}>
                            <StatusIcon tone={row.tone} />
                            <span>{TONE_WORD[row.tone]}</span>
                          </span>
                        )}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </figure>
      );
    }

    case 'code':
      return (
        <figure className="learn-code">
          <figcaption className="learn-caption">{block.label}</figcaption>
          <CodeBlock language={block.language}>{block.code}</CodeBlock>
        </figure>
      );

    case 'callout':
      return (
        <Callout tone={block.tone} title={block.title}>
          {block.body}
        </Callout>
      );

    case 'anatomy':
      return <AnatomyView id={block.anatomy} recipient={recipient} onFollow={onFollow} />;

    case 'flags':
      return (
        <div className="learn-flags">
          {block.flags.map((flag) => (
            <article className="learn-flag" key={flag.flag}>
              <h4>
                <span className="learn-flag-letter mono" aria-hidden>
                  {flag.flag}
                </span>
                <span>
                  <span className="visually-hidden">Flag {flag.flag}: </span>
                  {flag.title}
                </span>
              </h4>
              <CitationView citation={flag.quote} compact />
              <dl className="learn-flag-facts">
                <dt>What it obliges a client to do</dt>
                <dd>{flag.obliges}</dd>
                <dt>Can it be ignored</dt>
                <dd>{flag.ignorable}</dd>
              </dl>
            </article>
          ))}
          <figure className="learn-table">
            <figcaption className="learn-caption">
              Every combination, and the one that cannot work
            </figcaption>
            <div className="scroll-x">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Flags</th>
                    <th scope="col">Legal</th>
                    <th scope="col">What it means</th>
                  </tr>
                </thead>
                <tbody>
                  {block.combinations.map((combination) => (
                    <tr key={combination.combo}>
                      <td className="mono">{combination.combo}</td>
                      <td>
                        <span className={`tone tone-${combination.legal ? 'pass' : 'fail'}`}>
                          <StatusIcon tone={combination.legal ? 'pass' : 'fail'} />
                          <span>{combination.legal ? 'Legal' : 'Forbidden'}</span>
                        </span>
                      </td>
                      <td>{combination.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </figure>
        </div>
      );

    case 'checklist':
      return (
        <div className="learn-checklist">
          <p className="learn-caption">{block.title}</p>
          <ul>
            {block.items.map((item) => (
              <li key={item.label}>
                <Check size={14} aria-hidden />
                <div>
                  <strong>{item.label}</strong>
                  <p>{item.detail}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      );

    case 'generated':
      return block.generator === 'cors-headers' ? (
        <div className="learn-generated">
          <p className="learn-caption">
            What the OPTIONS response has to carry for this page, at {origin}
          </p>
          <FieldTable rows={corsHeaderRows(origin)} />
          <p className="learn-note">
            Generated from the same helper the diagnosis uses, so this checklist and the verdict on
            a failed run cannot drift apart.
          </p>
        </div>
      ) : (
        <figure className="learn-code">
          <figcaption className="learn-caption">
            The preflight a browser sends, as a command you can run
          </figcaption>
          <CodeBlock language="bash">{curlForPreflight(EXAMPLE_MANIFEST_URL, origin)}</CodeBlock>
          <p className="learn-note">
            Read the response headers, not the status. A 200 with no Access-Control-Allow-Origin is
            the failure, and it is the shape that convinces a sender their link is fine.
          </p>
        </figure>
      );

    default: {
      // A new block kind is a compile error here rather than a silent gap on the
      // page, which is the failure this exists to prevent.
      const exhaustive: never = block;
      return exhaustive;
    }
  }
}

function corsHeaderRows(origin: string): readonly FieldRow[] {
  return corsRequirementsFor(origin).map((requirement) => ({
    key: requirement.header,
    value: requirement.value,
  }));
}

// ---------------------------------------------------------------------------
// Citations
// ---------------------------------------------------------------------------

/**
 * A quote, or a reference with no quote, and the difference is visible.
 *
 * The guide carries citations with no `quote` where only the section is known.
 * Rendering those inside quotation marks would be quoting nothing, so they get a
 * different shape: a pointer at a section, not a sentence attributed to it.
 */
function CitationView({
  citation,
  compact,
}: {
  citation: Citation;
  compact?: boolean | undefined;
}): ReactNode {
  const source = (
    <span className="learn-cite-source">
      <span className="learn-cite-spec">{citation.spec}</span>
      <span className="learn-cite-section">{citation.section}</span>
      <a href={citation.url} target="_blank" rel="noreferrer noopener">
        <span>Read the section</span>
        <ExternalLink size={12} aria-hidden />
        <span className="visually-hidden"> (opens the specification in a new tab)</span>
      </a>
    </span>
  );

  if (citation.quote === undefined) {
    return <p className={clsx('learn-reference', compact === true && 'is-compact')}>{source}</p>;
  }

  return (
    <figure className={clsx('learn-quote', compact === true && 'is-compact')}>
      <blockquote>
        <QuoteIcon size={13} aria-hidden className="learn-quote-mark" />
        {citation.quote}
      </blockquote>
      <figcaption>{source}</figcaption>
    </figure>
  );
}

// ---------------------------------------------------------------------------
// Payload members
// ---------------------------------------------------------------------------

function MemberView({ member }: { member: PayloadMember }): ReactNode {
  const required = member.cardinality.startsWith('1');
  return (
    <article className="learn-member" id={`member-${member.name}`} tabIndex={-1}>
      <h3>
        <span className="mono">{member.name}</span>
        <Chip tone={required ? 'info' : 'skip'}>
          {member.cardinality} {required ? 'required' : 'optional'}
        </Chip>
        <span className="learn-member-type">{member.type}</span>
      </h3>
      <p>{member.purpose}</p>
      <dl className="learn-member-facts">
        <dt>Constraint</dt>
        <dd>{member.constraint}</dd>
        <dt>In the example</dt>
        <dd className="opaque-value">{member.example}</dd>
      </dl>
      <p className="learn-note">{member.exampleNote}</p>
      <CitationView citation={member.quote} compact />
      {member.alsoSee !== undefined && <CitationView citation={member.alsoSee} compact />}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Anatomies
// ---------------------------------------------------------------------------

/**
 * The link anatomy is the interactive map; the other three are strips.
 *
 * The map derives its segments from a real link, so it can only be built for the
 * one anatomy that is a whole link. A JWE's ciphertext is 81,298 characters and a
 * JWS payload is compressed bytes, so those are rendered as the content has
 * them: segments carrying their real sizes, with the elided parts saying that
 * they are elided rather than pretending to be characters.
 */
function AnatomyView({
  id,
  recipient,
  onFollow,
}: {
  id: AnatomyId;
  recipient: string;
  onFollow: (anchor: string) => void;
}): ReactNode {
  const anatomy: Anatomy = ANATOMIES[id];
  return (
    <div className="learn-anatomy" id={`anatomy-${id}`} tabIndex={-1}>
      <h3>{anatomy.title}</h3>
      <p className="learn-section-lede">{anatomy.lede}</p>
      {id === 'link' ? (
        <SegmentMap link={EXAMPLE} recipient={recipient} onFollow={onFollow} />
      ) : (
        <AnatomyStrip anatomy={anatomy} />
      )}
    </div>
  );
}

function AnatomyStrip({ anatomy }: { anatomy: Anatomy }): ReactNode {
  const parts = anatomy.segments.filter((segment) => segment.label.length > 0);
  return (
    <div className="anatomy-strip">
      <ol className="anatomy-parts">
        {parts.map((segment) => (
          <li
            key={segment.id}
            className={clsx('anatomy-part', segment.elided === true && 'is-elided')}
          >
            <div className="anatomy-part-head">
              <span className="anatomy-part-label">{segment.label}</span>
              {segment.elided === true && <Chip tone="skip">Not shown in full</Chip>}
            </div>
            <p className="anatomy-part-text opaque-value">{segment.text}</p>
            {segment.decodes !== undefined && (
              <p className="anatomy-part-decodes opaque-value">
                <span className="anatomy-part-decodes-label">decodes to</span>
                {segment.decodes}
              </p>
            )}
            <p>{segment.explains}</p>
          </li>
        ))}
      </ol>
      {anatomy.literal && anatomy.whole !== undefined && (
        <p className="learn-note">
          Those parts joined, separators included, are the artefact exactly: {anatomy.whole.length}{' '}
          characters.
        </p>
      )}
      {!anatomy.literal && (
        <p className="learn-note">
          Some parts are described rather than printed, because they are tens of thousands of
          characters long. Sizes here are from the real file.
        </p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * The glossary, last, because it is a reference rather than a reading.
 *
 * `confusedWith` is the member that earns this section its place: at a table
 * someone says "the manifest" and someone else hears "the file", and twenty
 * minutes go missing. So each pairing is rendered as a way to jump to the term
 * it gets mixed up with, not as a footnote.
 */
function GlossaryView({ onFollow }: { onFollow: (anchor: string) => void }): ReactNode {
  return (
    <section className="learn-section" id={GLOSSARY_ANCHOR} tabIndex={-1}>
      <h2>Vocabulary</h2>
      <p className="learn-section-lede">
        {GLOSSARY.length} terms, each with the one it is most often confused with.
      </p>
      <div className="learn-glossary">
        {GLOSSARY.map((entry) => (
          <GlossaryEntryView key={entry.term} entry={entry} onFollow={onFollow} />
        ))}
      </div>
    </section>
  );
}

function GlossaryEntryView({
  entry,
  onFollow,
}: {
  entry: GlossaryEntry;
  onFollow: (anchor: string) => void;
}): ReactNode {
  return (
    <article className="learn-term" id={termAnchor(entry.term)} tabIndex={-1}>
      <h3>
        <span>{entry.term}</span>
        {entry.aka?.map((alias) => (
          <Chip key={alias} tone="skip">
            {alias}
          </Chip>
        ))}
      </h3>
      <p className="learn-term-short">{entry.short}</p>
      {entry.detail !== undefined && <p>{entry.detail}</p>}
      {entry.confusedWith !== undefined && (
        <p className="learn-term-confused">
          <span>Not the same thing as</span>
          {entry.confusedWith.map((other) => (
            <button
              key={other}
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => onFollow(termAnchor(other))}
            >
              {other}
            </button>
          ))}
        </p>
      )}
      {entry.citation !== undefined && <CitationView citation={entry.citation} compact />}
    </article>
  );
}
