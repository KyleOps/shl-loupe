/**
 * One renderer per Evidence variant.
 *
 * The rule this file exists to hold: evidence is rendered as the KIND of thing
 * it is. A header set is a table, a request is a request with a copyable
 * reproduction, a spec quote is a quote with a link out. Stringifying all of it
 * into one grey block is how the incumbent viewer turns a six-hop pipeline into
 * "TypeLoad failed".
 *
 * Two traps are handled here rather than at the call sites:
 *
 *  - A cross-origin response's header list is a SUBSET of what the server sent,
 *    and a reader who sees three headers where curl shows twenty will conclude
 *    the server sent three. So the response pane says so, every time.
 *  - Status 0 is not a status. It is the Fetch spec's stand-in for "no response
 *    reached script", and printing it as a number is how a participant ends up
 *    told their server returned zero.
 *
 * Masking is read from the stores rather than passed in: the redactor holds the
 * user's own key on purpose, and a secret is masked on the way to the SCREEN
 * (which gets projected) as well as on the way to the clipboard.
 */
import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { ChevronRight, ExternalLink, Eye, EyeOff } from 'lucide-react';
import { clsx } from 'clsx';
import { useSession, useSettings } from '../../app/store';
import { formatBytes } from '../../core/bytes';
import { describeFetchEngine } from '../../core/net/browser';
import { readableHeaderNote } from '../../core/net/transport';
import type {
  Citation,
  Evidence,
  HttpRequestRecord,
  HttpResponseRecord,
  KvRow,
} from '../../core/trace';
import {
  Button,
  Callout,
  Chip,
  CodeBlock,
  CopyButton,
  FieldTable,
  StatusIcon,
  toneForStatus,
  type FieldRow,
} from '../primitives';
import { evidenceLabel, isCrossOriginResponse, statusLabel, statusPillTone } from './format';

// ---------------------------------------------------------------------------
// Masking
// ---------------------------------------------------------------------------

interface Masking {
  mask: (text: string) => string;
  maskJson: <T>(value: T) => T;
  /** True when the run registered something that must not leave the tab. */
  hasSecrets: boolean;
  revealed: boolean;
}

function useMasking(): Masking {
  const redactor = useSession((state) => state.redactor);
  const revealed = useSettings((state) => state.revealSecrets);
  const active = redactor?.isActive === true;
  const masking = active && !revealed ? redactor : undefined;

  const mask = useCallback(
    (text: string) => (masking ? masking.text(text) : text),
    [masking],
  );
  const maskJson = useCallback(
    <T,>(value: T) => (masking ? masking.json(value) : value),
    [masking],
  );
  return { mask, maskJson, hasSecrets: active, revealed };
}

/**
 * Shown only where something was actually masked, so it reads as a fact about
 * this value rather than as a standing disclaimer nobody sees any more.
 */
function MaskNotice({ masked }: { masked: boolean }): ReactNode {
  const revealed = useSettings((state) => state.revealSecrets);
  const setRevealSecrets = useSettings((state) => state.setRevealSecrets);
  const projector = useSettings((state) => state.projector);
  const [confirming, setConfirming] = useState(false);

  if (!masked && !revealed) return null;

  // Projector Mode asks twice on the way to revealing: the audience is looking
  // at a decryption key, and the person driving is usually not the person who
  // owns it. Hiding again is one press, always.
  const needsConfirm = projector && !revealed && !confirming;

  return (
    <p className="mask-note">
      <span>
        {revealed
          ? 'The link key is shown in full below.'
          : 'The link key is masked below. Loupe holds the real value; nothing is lost.'}
      </span>
      <Button
        size="sm"
        onClick={() => {
          if (needsConfirm) {
            setConfirming(true);
            return;
          }
          setConfirming(false);
          setRevealSecrets(!revealed);
        }}
      >
        {revealed ? <EyeOff size={13} aria-hidden /> : <Eye size={13} aria-hidden />}
        <span>
          {revealed ? 'Hide the key' : needsConfirm ? 'Reveal on this screen?' : 'Reveal the key'}
        </span>
      </Button>
    </p>
  );
}

// ---------------------------------------------------------------------------
// Long values
// ---------------------------------------------------------------------------

const LONG_STRING = 2000;

/**
 * A very long opaque value (an embedded 4 MB base64url file is a real manifest)
 * is clamped behind an explicit expander rather than ellipsed. A truncated key
 * that looks complete is worse than one that obviously is not, and the copy
 * button always copies the whole thing either way.
 */
function LongString({ value }: { value: string }): ReactNode {
  const [expanded, setExpanded] = useState(false);
  if (value.length <= LONG_STRING) return <span className="opaque-value">{value}</span>;
  return (
    <span className="long-string">
      <span className="opaque-value">{expanded ? value : value.slice(0, LONG_STRING)}</span>
      <Button
        size="sm"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        {expanded
          ? 'Show less'
          : `Show all ${value.length.toLocaleString('en-AU')} characters`}
      </Button>
    </span>
  );
}

// ---------------------------------------------------------------------------
// JSON tree
// ---------------------------------------------------------------------------

function isBranch(value: unknown): value is Record<string, unknown> | unknown[] {
  return typeof value === 'object' && value !== null;
}

function childEntries(value: Record<string, unknown> | unknown[]): Array<[string, unknown]> {
  return Array.isArray(value)
    ? value.map((child, index) => [String(index), child])
    : Object.entries(value);
}

function branchSummary(value: Record<string, unknown> | unknown[]): string {
  const count = childEntries(value).length;
  const noun = count === 1 ? 'entry' : 'entries';
  return Array.isArray(value) ? `[${count}]` : `{${count} ${noun}}`;
}

function JsonLeaf({ name, value }: { name?: string; value: unknown }): ReactNode {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return (
    <div className="json-row json-leaf">
      {name !== undefined && <span className="json-key">{name}</span>}
      <span className={clsx('json-value', `json-${typeof value}`, value === null && 'json-null')}>
        {typeof value === 'string' ? <LongString value={value} /> : (text ?? 'null')}
      </span>
      <CopyButton value={text ?? 'null'} label="Copy" className="json-copy" />
    </div>
  );
}

function JsonNode({
  name,
  value,
  depth,
  openToDepth,
}: {
  name?: string;
  value: unknown;
  depth: number;
  openToDepth: number;
}): ReactNode {
  const [open, setOpen] = useState(depth < openToDepth);
  if (!isBranch(value)) return <JsonLeaf {...(name === undefined ? {} : { name })} value={value} />;

  const entries = childEntries(value);
  return (
    <div className="json-branch">
      <div className="json-row">
        <button
          type="button"
          className="json-toggle"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <ChevronRight
            size={13}
            aria-hidden
            className={clsx('json-chevron', open && 'is-open')}
          />
          {name !== undefined && <span className="json-key">{name}</span>}
          <span className="json-summary">{branchSummary(value)}</span>
        </button>
        <CopyButton
          value={() => JSON.stringify(value, null, 2)}
          label="Copy"
          className="json-copy"
        />
      </div>
      {open && (
        <ul className="json-children">
          {entries.map(([childName, childValue]) => (
            <li key={childName}>
              <JsonNode
                name={childName}
                value={childValue}
                depth={depth + 1}
                openToDepth={openToDepth}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function JsonTree({
  value,
  openToDepth = 2,
}: {
  value: unknown;
  openToDepth?: number;
}): ReactNode {
  return (
    <div className="json-tree">
      <JsonNode value={value} depth={0} openToDepth={openToDepth} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Citations
// ---------------------------------------------------------------------------

/**
 * Exported because a finding cites the same way a step does, and one rendering
 * keeps a quote looking like a quote in both places.
 */
export function CitationView({ citation }: { citation: Citation }): ReactNode {
  return (
    <div className="citation">
      <p className="citation-where">
        <span className="citation-spec">{citation.spec}</span>
        <span className="citation-section">{citation.section}</span>
      </p>
      {citation.quote !== undefined && <blockquote>{citation.quote}</blockquote>}
      <a href={citation.url} target="_blank" rel="noreferrer noopener">
        Read this section
        <ExternalLink size={12} aria-hidden />
      </a>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Requests and responses
// ---------------------------------------------------------------------------

function headerRows(headers: Record<string, string>, mask: (text: string) => string): FieldRow[] {
  return Object.entries(headers).map(([name, value]) => ({
    key: name,
    value: <LongString value={mask(value)} />,
  }));
}

function bodyLanguage(body: string): string | undefined {
  const trimmed = body.trimStart();
  return trimmed.startsWith('{') || trimmed.startsWith('[') ? 'json' : undefined;
}

function RequestView({ request }: { request: HttpRequestRecord }): ReactNode {
  const { mask } = useMasking();
  const url = mask(request.url);
  const body = request.body === undefined ? undefined : mask(request.body);
  return (
    <div className="wire">
      <p className="wire-line">
        <Chip tone="info">{request.method}</Chip>
        <span className="opaque-value">{url}</span>
        <CopyButton value={url} label="Copy URL" />
      </p>
      {request.redacted === true && (
        <p className="wire-note">
          Secret material was removed from this record before it was written down, so what is shown
          is not byte-for-byte what went on the wire.
        </p>
      )}
      {Object.keys(request.headers).length > 0 && (
        <FieldTable rows={headerRows(request.headers, mask)} dense />
      )}
      {body !== undefined && (
        <CodeBlock {...(bodyLanguage(body) === undefined ? {} : { language: bodyLanguage(body) })}>
          {body}
        </CodeBlock>
      )}
      <MaskNotice masked={url !== request.url || (body !== undefined && body !== request.body)} />
    </div>
  );
}

function ResponseView({ response }: { response: HttpResponseRecord }): ReactNode {
  const { mask } = useMasking();
  const crossOrigin = isCrossOriginResponse(response);
  const engine =
    response.networkError === undefined ? undefined : describeFetchEngine(response.networkError);
  const tone = statusPillTone(response.status);

  const facts: FieldRow[] = [];
  if (response.responseType !== undefined) {
    facts.push({ key: 'response type', value: response.responseType, mono: true });
  }
  if (response.redirected === true) {
    facts.push({
      key: 'redirected',
      value: 'yes',
      tone: 'warn',
      note: 'A browser cannot show script the intermediate hops, so only the final URL is knowable here.',
    });
  }
  if (response.finalUrl !== undefined) {
    facts.push({ key: 'final URL', value: <LongString value={mask(response.finalUrl)} /> });
  }
  if (response.bodyBytes !== undefined) {
    facts.push({ key: 'body size', value: formatBytes(response.bodyBytes), mono: true });
  }

  return (
    <div className="wire">
      <p className="wire-line">
        <span className={`chip tone tone-${tone}`}>
          <StatusIcon tone={tone} size={12} />
          {statusLabel(response.status)}
          {response.statusText !== undefined && response.statusText !== ''
            ? ` ${response.statusText}`
            : ''}
        </span>
        {response.durationMs !== undefined && (
          <span className="duration mono">{response.durationMs} ms</span>
        )}
      </p>

      {response.status === 0 && (
        <p className="wire-note">
          No response reached this page. The status column is empty rather than zero, because zero is
          not something a server can send.
        </p>
      )}

      {response.networkError !== undefined && (
        <Callout tone="fail" title="The browser's own words">
          <p className="verbatim">{response.networkError}</p>
          <p>
            {engine === undefined
              ? 'That message is all a page is given. The cause is written to the developer console, where page JavaScript cannot read it, so the trace narrows it by elimination instead of guessing.'
              : `That is ${engine} wording for a transport-level failure, and it is all a page is given: CORS, DNS, TLS and a closed port all produce it. The cause is written to the developer console, where page JavaScript cannot read it.`}
          </p>
        </Callout>
      )}

      {facts.length > 0 && <FieldTable rows={facts} dense />}

      {Object.keys(response.headers).length > 0 ? (
        <FieldTable rows={headerRows(response.headers, mask)} dense />
      ) : (
        <p className="wire-note">No headers were readable from this response.</p>
      )}

      {crossOrigin !== undefined && <p className="wire-note">{readableHeaderNote(!crossOrigin)}</p>}

      {response.bodyPreview !== undefined && response.bodyPreview !== '' && (
        <CodeBlock
          {...(bodyLanguage(response.bodyPreview) === undefined
            ? {}
            : { language: bodyLanguage(response.bodyPreview) })}
        >
          {mask(response.bodyPreview)}
        </CodeBlock>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Key/value evidence
// ---------------------------------------------------------------------------

function kvRows(rows: readonly KvRow[], mask: (text: string) => string): FieldRow[] {
  return rows.map((row) => ({
    key: row.key,
    value: <LongString value={mask(row.value)} />,
    ...(row.mono === undefined ? {} : { mono: row.mono }),
    ...(row.status === undefined ? {} : { tone: toneForStatus(row.status) }),
    ...(row.note === undefined ? {} : { note: mask(row.note) }),
  }));
}

// ---------------------------------------------------------------------------
// The switch
// ---------------------------------------------------------------------------

const SHELL_NAME: Record<'bash' | 'powershell', string> = {
  bash: 'bash',
  powershell: 'PowerShell',
};

/** Small enough that a tree would be more chrome than content. */
function fitsInABlock(value: unknown): boolean {
  if (!isBranch(value)) return true;
  const text = JSON.stringify(value, null, 2) ?? '';
  return text.split('\n').length <= 3;
}

export function EvidenceView({ evidence }: { evidence: Evidence }): ReactNode {
  const { mask, maskJson } = useMasking();
  const label = evidenceLabel(evidence);

  const json = useMemo(
    () => (evidence.type === 'json' ? maskJson(evidence.value) : undefined),
    [evidence, maskJson],
  );

  switch (evidence.type) {
    case 'note':
      return (
        <div className="evidence evidence-note">
          <p>{mask(evidence.text)}</p>
        </div>
      );

    case 'kv':
      return (
        <div className="evidence">
          <FieldTable rows={kvRows(evidence.rows, mask)} />
          <MaskNotice
            masked={evidence.rows.some((row) => mask(row.value) !== row.value)}
          />
        </div>
      );

    case 'json': {
      const pretty = JSON.stringify(json, null, 2) ?? 'null';
      return (
        <div className="evidence">
          <p className="evidence-label">{label}</p>
          {fitsInABlock(json) ? (
            <CodeBlock language="json">{pretty}</CodeBlock>
          ) : (
            <>
              <div className="evidence-actions">
                <CopyButton value={pretty} label="Copy JSON" />
              </div>
              <JsonTree value={json} openToDepth={evidence.collapsed === true ? 1 : 2} />
            </>
          )}
          <MaskNotice masked={pretty !== (JSON.stringify(evidence.value, null, 2) ?? 'null')} />
        </div>
      );
    }

    case 'text': {
      const masked = mask(evidence.value);
      return (
        <div className="evidence">
          <p className="evidence-label">{label}</p>
          <CodeBlock
            {...(evidence.language === undefined ? {} : { language: evidence.language })}
          >
            {masked}
          </CodeBlock>
          <MaskNotice masked={masked !== evidence.value} />
        </div>
      );
    }

    case 'bytes':
      return (
        <div className="evidence">
          <p className="evidence-label">
            {label}
            <span className="evidence-meta mono">
              {formatBytes(evidence.length)} ({evidence.length.toLocaleString('en-AU')} bytes)
            </span>
          </p>
          <CodeBlock copy={false}>{evidence.preview}</CodeBlock>
        </div>
      );

    case 'request':
      return (
        <div className="evidence">
          <p className="evidence-label">{label}</p>
          <RequestView request={evidence.request} />
        </div>
      );

    case 'response':
      return (
        <div className="evidence">
          <p className="evidence-label">{label}</p>
          <ResponseView response={evidence.response} />
        </div>
      );

    case 'command':
      return (
        <div className="evidence">
          <p className="evidence-label">
            {label}
            <span className="evidence-meta">{SHELL_NAME[evidence.shell]}</span>
          </p>
          <CodeBlock language={evidence.shell}>{mask(evidence.command)}</CodeBlock>
          <p className="wire-note">
            Run this in {SHELL_NAME[evidence.shell]} to take the browser out of the picture. A
            request that works here and fails in the page is a positive CORS diagnosis, which a page
            cannot make on its own.
          </p>
          <MaskNotice masked={mask(evidence.command) !== evidence.command} />
        </div>
      );

    case 'citation':
      return (
        <div className="evidence">
          <CitationView citation={evidence.citation} />
        </div>
      );
  }
}
