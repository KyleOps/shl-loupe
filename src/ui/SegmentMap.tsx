/**
 * The link anatomy, mapped.
 *
 * This is the teaching device the format deserves and no FHIR tool offers: the
 * link on the left, tinted part by part, and what each part means beside it, the
 * way jwt.io lays out a token. Three tiers, each one level deeper than the last:
 * the characters as they arrive, the JSON they decode to, and what the two
 * members that do real work are used for.
 *
 * Four decisions are load bearing.
 *
 * 1. **The segments are derived from the link that was passed in, not from a
 *    stored copy of one.** The prose comes from `content/spec-guide.ts`, which is
 *    checked against the specification, but the characters are the caller's. So
 *    the map cannot quietly describe a different link than the one on screen,
 *    which is the failure mode of every hand-drawn diagram of a wire format.
 * 2. **A tint never carries the mapping on its own.** Each part has a marker (a
 *    number in the link, a letter in the payload), a word, and a tint, in that
 *    order of importance. A projector that washes every tint to the same grey
 *    loses nothing. The tints are mixed down from the accent, exception and warn
 *    hues rather than taken from the status palette at full strength, and nothing
 *    tinted here carries an icon-and-word verdict, so a tint cannot be misread as
 *    a pass or a failure.
 * 3. **Selection is one piece of state, and it is bidirectional.** Choosing a
 *    part of the link marks the members it decodes to; choosing a member marks
 *    the part it came from. Two independent selections would let the two panes
 *    disagree, which is the confusion the map exists to remove.
 * 4. **The key is masked in the usage tier, and only there.** Masking it inside
 *    the strip would break the one promise the strip makes, that its segments
 *    joined are the link. But the tier explaining what a key is for is where
 *    somebody picks up the habit, so that one is masked with an explicit reveal.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { ArrowDown, CornerDownRight, KeyRound, Link2 } from 'lucide-react';
import { clsx } from 'clsx';
import { base64urlToString } from '../core/bytes';
import { decodeShlPayload, extractShlink, type ShlinkForm } from '../core/shlink';
import { curlForDirectFile, curlForManifest } from '../core/net/curl';
import {
  ANATOMIES,
  anchorForTarget,
  labelForTarget,
  sectionById,
  type AnatomySegment,
  type AnatomyTarget,
  type GuideBlock,
  type PayloadMember,
} from '../content/spec-guide';
import { Callout, CodeBlock, CopyButton, Secret } from './primitives';

// ---------------------------------------------------------------------------
// Splitting the link
// ---------------------------------------------------------------------------

/**
 * `query` and `trailing` are the two roles the guide has no anatomy segment for,
 * because the IG's own example has neither: the non-conformant query-string
 * carrier, and a caption after the payload. Both turn up in the wild, so both
 * are described rather than silently dropped from the strip.
 */
type PartRole = 'prefix' | 'hash' | 'token' | 'query' | 'payload' | 'trailing';

interface LinkPart {
  role: PartRole;
  text: string;
  label: string;
  explains: string;
  target: AnatomyTarget | undefined;
}

const LINK_ANATOMY_DOCS = new Map(ANATOMIES.link.segments.map((segment) => [segment.id, segment]));

function anatomyDoc(role: PartRole): AnatomySegment | undefined {
  return LINK_ANATOMY_DOCS.get(`link-${role}`);
}

const LOCAL_DOCS: Partial<Record<PartRole, { label: string; explains: string }>> = {
  query: {
    label: 'Query parameter',
    explains:
      'The payload in a query string rather than after a "#". Nothing in the specification permits this, and it is not a style choice: a query string is sent to the viewer’s own server, so the decryption key lands in its access log and in anything watching it.',
  },
  trailing: {
    label: 'Trailing text',
    explains:
      'Characters after the payload. A receiver finds the token and ignores whatever surrounds it, which is what lets one QR carry a link plus a human-readable caption, and what makes a full stop pasted out of a chat message harmless.',
  },
};

/** How the payload was carried, said in words, since the form is a conformance fact. */
const FORM_LABELS: Record<ShlinkForm, string> = {
  'shlink-uri': 'bare shlink URI, the form a QR carries',
  'shlink-uri-double-slash': 'bare shlink URI with two slashes, which is one too many',
  'viewer-fragment': 'viewer prefix with the payload in the fragment',
  'viewer-query':
    'viewer prefix with the payload in a query string, which the specification does not permit',
  'bare-payload': 'a bare payload, with no token in front of it',
};

interface SplitLink {
  parts: readonly LinkPart[];
  form: ShlinkForm;
  encodedPayload: string;
}

/**
 * Split a link into its parts, or give up.
 *
 * Giving up is a real outcome, and it is reported rather than papered over.
 * `extractShlink` unescapes a percent-encoded link before reading it, so the
 * payload it returns may not appear literally in the text on screen. A strip
 * whose segments do not join back into the artefact is worse than no strip, so
 * when the characters cannot be located the map says so instead of drawing
 * something plausible.
 */
function splitLink(link: string): SplitLink | undefined {
  const extraction = extractShlink(link);
  if (extraction === undefined) return undefined;
  const index = link.indexOf(extraction.encodedPayload);
  if (index === -1) return undefined;

  const parts: LinkPart[] = [];
  const push = (role: PartRole, text: string): void => {
    if (text.length === 0) return;
    const doc = anatomyDoc(role);
    const local = LOCAL_DOCS[role];
    parts.push({
      role,
      text,
      // The guide's label for the payload counts the characters of ITS example,
      // so for any other link that number would be a quiet lie. The prose is
      // the guide's; the count is this link's.
      label:
        role === 'payload'
          ? `Payload, ${text.length} characters`
          : (doc?.label ?? local?.label ?? role),
      explains: doc?.explains ?? local?.explains ?? '',
      target: doc?.target,
    });
  };

  // The head is consumed from the right: the token is the last thing before the
  // payload, and whatever introduced the token (a "#" or a query parameter) is
  // the last thing before that.
  const head = link.slice(0, index);
  const tokenMatch = /(shlink:\/{1,2})$/i.exec(head);
  const token = tokenMatch?.[1] ?? '';
  const beforeToken = head.slice(0, head.length - token.length);
  const queryMatch = /[?&](?:shlink|shl)=$/i.exec(beforeToken);

  if (beforeToken.endsWith('#')) {
    push('prefix', beforeToken.slice(0, -1));
    push('hash', '#');
  } else if (queryMatch !== null) {
    const parameter = queryMatch[0];
    push('prefix', beforeToken.slice(0, beforeToken.length - parameter.length));
    push('query', parameter);
  } else {
    push('prefix', beforeToken);
  }
  push('token', token);
  push('payload', extraction.encodedPayload);
  push('trailing', link.slice(index + extraction.encodedPayload.length));

  return { parts, form: extraction.form, encodedPayload: extraction.encodedPayload };
}

// ---------------------------------------------------------------------------
// Splitting the decoded JSON
// ---------------------------------------------------------------------------

interface JsonSpan {
  text: string;
  /** Set when this span is one member of the outer object. */
  member: string | undefined;
}

/**
 * Cut a JSON object into one span per member, keeping every character.
 *
 * A regular expression is not enough: a member's value may itself contain a
 * brace, a comma or an escaped quote (a `label` of `{"a", b}` is legal), and a
 * split that gets that wrong produces a strip that does not reassemble into the
 * payload. So this is a small scanner tracking string state, escapes and nesting
 * depth, and every span it emits is a literal slice, which is what keeps the
 * joined result byte-identical to its input.
 */
function splitJsonMembers(json: string): readonly JsonSpan[] {
  const open = json.indexOf('{');
  if (open === -1) return [{ text: json, member: undefined }];

  const spans: JsonSpan[] = [{ text: json.slice(0, open + 1), member: undefined }];
  let start = open + 1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  const flush = (end: number): void => {
    const text = json.slice(start, end);
    if (text.length === 0) return;
    const name = /^\s*"((?:[^"\\]|\\.)*)"\s*:/.exec(text)?.[1];
    spans.push({ text, member: name });
  };

  for (let cursor = start; cursor < json.length; cursor += 1) {
    const character = json[cursor];
    if (character === undefined) break;
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === '{' || character === '[') {
      depth += 1;
    } else if (character === '}' && depth === 0) {
      flush(cursor);
      spans.push({ text: json.slice(cursor), member: undefined });
      return spans;
    } else if (character === '}' || character === ']') {
      depth -= 1;
    } else if (character === ',' && depth === 0) {
      flush(cursor);
      spans.push({ text: ',', member: undefined });
      start = cursor + 1;
    }
  }

  // An unterminated object: keep the remainder rather than losing characters.
  flush(json.length);
  return spans;
}

// ---------------------------------------------------------------------------
// Member documentation, taken from the guide rather than restated
// ---------------------------------------------------------------------------

function guideMembers(): readonly PayloadMember[] {
  const block = sectionById('payload')?.blocks.find(
    (candidate): candidate is Extract<GuideBlock, { kind: 'members' }> =>
      candidate.kind === 'members',
  );
  return block?.members ?? [];
}

const MEMBER_DOCS = new Map<string, PayloadMember>(
  guideMembers().map((member) => [member.name, member]),
);

/**
 * The payload anatomy documents each member as it appears in the IG's example,
 * keyed by the label it renders under, which is the member's own name. That
 * example-specific sentence is the better one to lead with, so it wins where it
 * exists; the member's standing purpose is the fallback for a member the example
 * does not carry (`exp` and `v`).
 */
const MEMBER_ANATOMY = new Map(
  ANATOMIES.payload.segments
    .filter((segment) => segment.label.length > 0)
    .map((segment) => [segment.label, segment]),
);

function memberExplanation(name: string): string {
  return MEMBER_ANATOMY.get(name)?.explains ?? MEMBER_DOCS.get(name)?.purpose ?? '';
}

// ---------------------------------------------------------------------------
// The component
// ---------------------------------------------------------------------------

export interface SegmentMapProps {
  /** The link to take apart. Its characters, not a copy of the example. */
  link: string;
  /**
   * The recipient string the generated request carries, so the command shown is
   * the one this page would actually send rather than a generic one.
   */
  recipient?: string | undefined;
  /**
   * Follow an in-page target (a member row, a section, another anatomy). The
   * hash belongs to the router, and a link's payload lives in it, so in-page
   * navigation cannot use an `href` and is handed up to the screen instead.
   */
  onFollow?: ((anchor: string) => void) | undefined;
}

type Selection = { kind: 'part'; role: PartRole } | { kind: 'member'; index: number };

export function SegmentMap({ link, recipient, onFollow }: SegmentMapProps): ReactNode {
  // The payload part is selected first: it is the part with something inside it,
  // so the pane opens on the thing worth reading rather than empty.
  const [selection, setSelection] = useState<Selection>({ kind: 'part', role: 'payload' });
  const [keyRevealed, setKeyRevealed] = useState(false);

  const split = useMemo(() => splitLink(link), [link]);

  const decoded = useMemo(() => {
    if (split === undefined) return undefined;
    try {
      return {
        spans: splitJsonMembers(base64urlToString(split.encodedPayload)),
        payload: decodeShlPayload(split.encodedPayload),
        error: undefined,
      };
    } catch (error) {
      return {
        spans: [] as readonly JsonSpan[],
        payload: undefined,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }, [split]);

  if (split === undefined || decoded === undefined) {
    return (
      <Callout tone="warn" title="This link cannot be laid out character by character">
        Its payload had to be unwrapped first, by unescaping it or by dropping a line break or a
        caption around it, so the characters on screen are not the characters that decode. A strip
        that did not join back into the link would teach the wrong thing, so there is none. Open the
        link on the Open screen instead: the trace shows the same steps in order.
      </Callout>
    );
  }

  const { spans } = decoded;
  // The letter shown against a member, by its position among the members only,
  // so the punctuation spans between them do not consume letters.
  const memberOrder = new Map<number, number>();
  spans.forEach((span, index) => {
    if (span.member !== undefined) memberOrder.set(index, memberOrder.size);
  });

  const payloadSelected = selection.kind === 'part' && selection.role === 'payload';
  const selectedPart = split.parts.find((part) =>
    selection.kind === 'part' ? part.role === selection.role : part.role === 'payload',
  );

  const payload = decoded.payload;
  const url = typeof payload?.url === 'string' ? payload.url : undefined;
  const secret = typeof payload?.key === 'string' ? payload.key : undefined;
  const direct = typeof payload?.flag === 'string' && payload.flag.toUpperCase().includes('U');

  return (
    <div className="segmap">
      <div className="segmap-grid">
        <div className="segmap-strips">
          <section className="segmap-tier" aria-labelledby="segmap-tier-link">
            <h4 className="segmap-tier-title" id="segmap-tier-link">
              1. The link, as it arrives
            </h4>
            <div className="segmap-strip scroll-x" role="group" aria-label="Parts of the link">
              {split.parts.map((part, index) => (
                <button
                  key={part.role}
                  type="button"
                  className={clsx(
                    'segmap-seg',
                    selection.kind === 'part' && selection.role === part.role && 'is-selected',
                    part.role === 'payload' && selection.kind === 'member' && 'is-related',
                  )}
                  data-tint={(index % 4) + 1}
                  aria-pressed={selection.kind === 'part' && selection.role === part.role}
                  onClick={() => setSelection({ kind: 'part', role: part.role })}
                >
                  <span className="segmap-marker" aria-hidden>
                    {index + 1}
                  </span>
                  <span className="segmap-seg-text opaque-value">{part.text}</span>
                  <span className="segmap-seg-label">{part.label}</span>
                </button>
              ))}
            </div>
            <div className="segmap-note">
              <CopyButton value={link} label="Copy the link" />
              <span>
                {split.parts.length} parts, {link.length} characters, carried as a{' '}
                {FORM_LABELS[split.form]}. Joined back together they are the link exactly.
              </span>
            </div>
          </section>

          <p className="segmap-arrow">
            <ArrowDown size={14} aria-hidden />
            <span>base64url decode. No key is needed for this, and nothing here is signed.</span>
          </p>

          <section className="segmap-tier" aria-labelledby="segmap-tier-payload">
            <h4 className="segmap-tier-title" id="segmap-tier-payload">
              2. The payload it decodes to
            </h4>
            {decoded.error !== undefined ? (
              <Callout tone="fail" title="The payload does not decode">
                {decoded.error}
              </Callout>
            ) : (
              <>
                <div
                  className={clsx('segmap-json', 'scroll-x', payloadSelected && 'is-related')}
                  role="group"
                  aria-label="Members of the payload"
                >
                  {spans.map((span, index) =>
                    span.member === undefined ? (
                      <span key={index} className="segmap-punct opaque-value">
                        {span.text}
                      </span>
                    ) : (
                      <button
                        key={index}
                        type="button"
                        className={clsx(
                          'segmap-member',
                          selection.kind === 'member' && selection.index === index && 'is-selected',
                        )}
                        data-tint={((memberOrder.get(index) ?? 0) % 4) + 1}
                        aria-pressed={selection.kind === 'member' && selection.index === index}
                        onClick={() => setSelection({ kind: 'member', index })}
                      >
                        <span className="segmap-marker" aria-hidden>
                          {letterFor(memberOrder.get(index) ?? 0)}
                        </span>
                        <span className="opaque-value">{span.text}</span>
                      </button>
                    ),
                  )}
                </div>
                <p className="segmap-legend">
                  {spans.map((span, index) =>
                    span.member === undefined ? null : (
                      <span key={index} className="segmap-legend-item">
                        <span className="segmap-marker" aria-hidden>
                          {letterFor(memberOrder.get(index) ?? 0)}
                        </span>
                        <span className="mono">{span.member}</span>
                      </span>
                    ),
                  )}
                </p>
              </>
            )}
          </section>
        </div>

        <aside className="segmap-pane" aria-live="polite">
          {selection.kind === 'member' ? (
            <MemberDetail
              name={spans[selection.index]?.member ?? ''}
              value={spans[selection.index]?.text ?? ''}
              onFollow={onFollow}
            />
          ) : (
            <PartDetail part={selectedPart} onFollow={onFollow} />
          )}
        </aside>
      </div>

      <section className="segmap-tier segmap-usage" aria-labelledby="segmap-tier-usage">
        <h4 className="segmap-tier-title" id="segmap-tier-usage">
          3. Where the two required members are used
        </h4>
        <div className="segmap-usage-grid">
          <article className="segmap-use">
            <h5>
              <Link2 size={14} aria-hidden />
              <span className="mono">url</span>
              <span>is requested, once</span>
            </h5>
            {url === undefined ? (
              <p>This payload carries no usable url member, so there is nothing to request.</p>
            ) : (
              <>
                <p>
                  {direct
                    ? 'The U flag is set, so this is a GET and the response body is the encrypted file itself. No manifest, no POST, and no preflight so long as no custom header is sent.'
                    : 'There is no U flag, so this is a manifest endpoint: a POST carrying a JSON body, which means the browser sends an OPTIONS preflight to it first.'}
                </p>
                <CodeBlock language="bash">
                  {direct
                    ? curlForDirectFile(url)
                    : curlForManifest({ url, recipient: recipient ?? 'Loupe' })}
                </CodeBlock>
                <p className="segmap-use-note">
                  The key is not in that command and does not need to be: it decrypts the file after
                  it arrives, and is not a credential any server checks. Nothing else stands between
                  a stranger and this endpoint, which is why the specification asks for 256 bits of
                  entropy in the url itself.
                </p>
              </>
            )}
          </article>

          <article className="segmap-use">
            <h5>
              <KeyRound size={14} aria-hidden />
              <span className="mono">key</span>
              <span>never leaves the page</span>
            </h5>
            {secret === undefined ? (
              <p>
                This payload carries no usable key member, so nothing it points at can be opened.
              </p>
            ) : (
              <>
                <p>
                  Used as the AES-256-GCM content encryption key for every file this link ever
                  serves. The algorithm is <span className="mono">dir</span>, so this value is the
                  content key directly: there is nothing to unwrap and nothing to derive.
                </p>
                <div className="segmap-secret-row">
                  <Secret
                    value={secret}
                    label="the link’s key"
                    revealed={keyRevealed}
                    onReveal={setKeyRevealed}
                  />
                </div>
                <p className="segmap-use-note">
                  Masked here because the habit matters more than this particular value: this one is
                  the specification’s own published demo key, so everything encrypted under it is
                  public by construction. A real link’s key opens somebody’s record.
                </p>
                {onFollow !== undefined && (
                  <FollowButton
                    target={{ to: 'section', section: 'encryption' }}
                    onFollow={onFollow}
                  />
                )}
              </>
            )}
          </article>
        </div>
      </section>
    </div>
  );
}

function letterFor(order: number): string {
  return String.fromCharCode(97 + (order % 26));
}

function PartDetail({
  part,
  onFollow,
}: {
  part: LinkPart | undefined;
  onFollow: ((anchor: string) => void) | undefined;
}): ReactNode {
  if (part === undefined) return <p className="segmap-pane-empty">Choose a part of the link.</p>;
  return (
    <div className="segmap-detail">
      <h4>{part.label}</h4>
      <p className="segmap-detail-chars opaque-value">{part.text}</p>
      <p>{part.explains}</p>
      {part.role === 'payload' && (
        <p className="segmap-detail-hint">
          <ArrowDown size={13} aria-hidden />
          <span>Every lettered member below came out of these characters.</span>
        </p>
      )}
      {part.target !== undefined && onFollow !== undefined && (
        <FollowButton target={part.target} onFollow={onFollow} />
      )}
    </div>
  );
}

function MemberDetail({
  name,
  value,
  onFollow,
}: {
  name: string;
  value: string;
  onFollow: ((anchor: string) => void) | undefined;
}): ReactNode {
  const doc = MEMBER_DOCS.get(name);
  return (
    <div className="segmap-detail">
      <h4>
        <span className="mono">{name}</span>
        {doc === undefined && <span className="segmap-detail-tag">not a specified member</span>}
      </h4>
      <p className="segmap-detail-chars opaque-value">{value}</p>
      {doc === undefined ? (
        <p>
          A receiver is required to ignore members it does not recognise, so this one is shown and
          otherwise left alone. A name beginning with an underscore, and the name "extension", are
          reserved for downstream guides rather than free for a sender to invent.
        </p>
      ) : (
        <>
          <p>{memberExplanation(name)}</p>
          <dl className="segmap-detail-facts">
            <dt>Cardinality</dt>
            <dd className="mono">{doc.cardinality}</dd>
            <dt>Type</dt>
            <dd>{doc.type}</dd>
            <dt>Constraint</dt>
            <dd>{doc.constraint}</dd>
          </dl>
          {onFollow !== undefined && (
            <FollowButton target={{ to: 'member', member: doc.name }} onFollow={onFollow} />
          )}
        </>
      )}
    </div>
  );
}

function FollowButton({
  target,
  onFollow,
}: {
  target: AnatomyTarget;
  onFollow: (anchor: string) => void;
}): ReactNode {
  return (
    <button
      type="button"
      className="btn btn-ghost btn-sm"
      onClick={() => onFollow(anchorForTarget(target))}
    >
      <CornerDownRight size={13} aria-hidden />
      <span>{labelForTarget(target)}</span>
    </button>
  );
}
