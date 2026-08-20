/**
 * `Narrative.div`: sanitised, then inlined.
 *
 * The narrative is the one part of a payload that is HTML written by somebody we
 * have never met, arriving from a server the patient did not vet. One of the
 * bundled Platypus fixtures carries a hostile narrative on purpose, because it
 * is a real shape rather than a contrived one: a record placed from a clinical
 * system keeps the narrative that system wrote.
 *
 * Two decisions, both deliberate:
 *
 * **The sanitiser is ours, and there is exactly one of it.** No DOMPurify: this
 * page must render identically with the network unplugged and with nothing
 * fetched at runtime, and a 1.7 MB dependency to strip about thirty tag names is
 * a poor trade. The allowlist tokeniser lives in `display.ts`
 * (`sanitiseNarrativeHtml`), which reserialises from a parse rather than
 * stripping patterns out of the input, and is unit tested against the real
 * attack payloads. This module owns the boundary the component actually inserts
 * (`sanitiseNarrative`) and is tested against the same battery, so the thing
 * under test is the thing that reaches `innerHTML`. Writing a second allowlist
 * here would mean two of them, drifting apart, in security-critical code: that
 * is the defect this arrangement exists to avoid, not a shortcut.
 *
 * **No iframe.** A same-origin `srcdoc` iframe inherits the origin, so it buys
 * nothing, and it costs text selection, printing and Cmd-F. Sanitise and inline.
 */
import { useMemo, type ReactNode } from 'react';
import {
  narrativeRowCount,
  narrativeTextContent,
  sanitiseNarrativeHtml,
  strField,
} from './display';
import { Callout, Chip } from '../primitives';

const XHTML_NS = 'http://www.w3.org/1999/xhtml';

/**
 * `<caption>` is on the FHIR narrative allowlist, and it is the one allowed tag
 * that cannot survive as itself: the HTML parser foster-parents a `<caption>`
 * that is not inside a `<table>` at insertion time, and the tokeniser's output is
 * inserted as a fragment. So the tag is renamed to a `div` carrying its own
 * class BEFORE sanitising, which keeps the caption's text and its visual
 * distinction while leaving every security property to the one sanitiser: the
 * rename touches the tag name only, so any attribute the payload hung on the
 * element is still stripped downstream. A duplicate `class` from the payload is
 * dropped rather than merged, because the tokeniser keeps the first occurrence
 * of an attribute and this one is injected first.
 */
const CAPTION_OPEN = /<caption(?=[\s/>])/gi;
const CAPTION_CLOSE = /<\/caption\s*>/gi;

export function sanitiseNarrative(html: string): string {
  const captionsRenamed = html
    .replace(CAPTION_OPEN, '<div class="narrative-caption"')
    .replace(CAPTION_CLOSE, '</div>');
  return sanitiseNarrativeHtml(captionsRenamed);
}

// ---------------------------------------------------------------------------
// What the status means, which is a clinical fact and not a formality
// ---------------------------------------------------------------------------

export type NarrativeStatus = 'generated' | 'extensions' | 'additional' | 'empty' | 'unstated';

export function narrativeStatus(narrative: unknown): NarrativeStatus {
  const status = strField(narrative, 'status');
  switch (status) {
    case 'generated':
    case 'extensions':
    case 'additional':
    case 'empty':
      return status;
    default:
      return 'unstated';
  }
}

/**
 * `additional` and `extensions` both mean the narrative may say something the
 * entries do not, so a structured-only view of that section is LOSING clinical
 * content. That is the whole reason this value is surfaced rather than ignored,
 * and it is what decides which view a section opens on.
 */
export function narrativeMayExceedEntries(status: NarrativeStatus): boolean {
  return status === 'additional' || status === 'extensions';
}

const STATUS_MEANING: Record<NarrativeStatus, string> = {
  generated:
    'The author states this narrative was generated entirely from the structured entries, so the two should say the same thing.',
  extensions:
    'The author states this narrative also carries content from extensions, so it may say more than the entries do.',
  additional:
    'The author states this narrative carries human-authored content beyond the structured data. Reading only the entries loses some of what was sent.',
  empty:
    'The author states this narrative is a placeholder with no real content, which is legal but unusual in a summary.',
  unstated:
    'Narrative.status is 1..1 and this narrative does not carry one, so there is no statement about whether the entries say the same thing.',
};

export function narrativeStatusMeaning(status: NarrativeStatus): string {
  return STATUS_MEANING[status];
}

// ---------------------------------------------------------------------------
// The component
// ---------------------------------------------------------------------------

export interface NarrativeProps {
  /** The `Narrative` element itself, as it arrived. */
  narrative: unknown;
  /** Shown as a chip beside the status. Absent for a resource-level narrative. */
  entryCount?: number | undefined;
  /** False on a resource card, where the status chips would be noise. */
  showStatus?: boolean | undefined;
}

export function Narrative({ narrative, entryCount, showStatus = true }: NarrativeProps): ReactNode {
  const div = strField(narrative, 'div');
  const status = narrativeStatus(narrative);
  const clean = useMemo(() => (div === undefined ? '' : sanitiseNarrative(div)), [div]);
  const text = useMemo(() => (div === undefined ? '' : narrativeTextContent(div)), [div]);
  const rows = useMemo(() => (div === undefined ? 0 : narrativeRowCount(div)), [div]);

  if (div === undefined) {
    return (
      <Callout tone="warn" title="This section carries no narrative">
        Both IPS and AU PS make <span className="mono">section.text</span> 1..1 and must-support, so
        a section with no narrative is a payload defect rather than a gap in the viewer. There is
        nothing here for a receiver that cannot process the structured entries.
      </Callout>
    );
  }

  const divergence =
    entryCount !== undefined && rows > 0 && rows !== entryCount
      ? `The narrative shows ${rows} ${rows === 1 ? 'row' : 'rows'} and the section carries ${entryCount} ${
          entryCount === 1 ? 'entry' : 'entries'
        }. That is worth a look: the two are meant to describe the same content.`
      : undefined;

  return (
    <div className="narrative-block">
      {showStatus && (
        <div className="narrative-meta">
          <Chip
            tone={narrativeMayExceedEntries(status) ? 'warn' : 'info'}
            title={narrativeStatusMeaning(status)}
          >
            {status === 'unstated' ? 'No status' : status}
          </Chip>
          {rows > 0 && (
            <span className="narrative-count">
              {rows} {rows === 1 ? 'row' : 'rows'}
            </span>
          )}
          <p className="narrative-status-note">{narrativeStatusMeaning(status)}</p>
        </div>
      )}
      {divergence !== undefined && (
        <Callout tone="info" title="The narrative and the entries do not count the same">
          {divergence}
        </Callout>
      )}
      {text === '' && (
        <Callout tone="warn" title="The narrative has no text in it">
          The narrative invariant txt-2 requires some non-whitespace content. This one has markup
          but nothing to read, so a receiver falling back to the narrative gets a blank panel.
        </Callout>
      )}
      {!hasXhtmlNamespace(div) && (
        <p className="narrative-note">
          The narrative <span className="mono">div</span> does not declare{' '}
          <span className="mono">xmlns=&quot;{XHTML_NS}&quot;</span>. FHIR requires it, and an XML
          receiver will reject the resource, although a JSON one usually will not notice.
        </p>
      )}
      {/* Sanitised above. The only thing reaching innerHTML is a string this
          module built from an allowlist, tag by tag. */}
      <div className="fhir-narrative" dangerouslySetInnerHTML={{ __html: clean }} />
      {carriedActiveContent(div) && (
        <p className="narrative-note">
          This narrative arrived carrying active content, and SHLoupe removed it: a script, an event
          handler, a style, an embedded object, a remote image or an unsafe link. What is above is
          what survives the allowlist, which is also all a conformant receiver is allowed to render.
          Worth telling whoever produced the payload, since the narrative invariant forbids it.
        </p>
      )}
    </div>
  );
}

/**
 * The namespace check reads the raw string rather than the sanitised output,
 * because `xmlns` is not on the attribute allowlist and so is always gone by
 * then. Checking after sanitising would report every payload as non-conformant.
 */
function hasXhtmlNamespace(div: string): boolean {
  const firstTag = /<div\b[^>]*>/i.exec(div);
  if (firstTag === null) return true;
  return firstTag[0].includes(XHTML_NS);
}

/**
 * Whether the narrative actually carried something the invariant forbids.
 *
 * Deliberately NOT `sanitised !== original`. Almost every conformant narrative
 * differs from its sanitised form, because `xmlns` is not on the attribute
 * allowlist and entities get normalised, so comparing the two would put "SHLoupe
 * removed dangerous markup" under every payload ever rendered. A note that fires
 * on everything is a note nobody reads, and it would also libel a perfectly good
 * producer. This looks for the things the exclusion list actually names.
 */
const ACTIVE_CONTENT =
  /<\s*(script|style|iframe|object|embed|form|input|button|svg|math|applet|frame|base|link|meta|img|video|audio|source|track|picture)\b|\son[a-z]+\s*=|\sstyle\s*=|\ssrcset\s*=|\sbackground\s*=|(?:href|src|data|action)\s*=\s*["']?\s*(?:javascript|vbscript|data):/i;

export function carriedActiveContent(div: string): boolean {
  return ACTIVE_CONTENT.test(div);
}
