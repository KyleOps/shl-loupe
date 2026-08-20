/**
 * `DocumentReference`, `Attachment` and `Binary`, done properly.
 *
 * This is the gap that prompted the project. The incumbent viewer registered a
 * `DocumentReference` renderer, and it still shows nothing in three live ways:
 * a `DocumentReference` with no `content` throws a TypeError that blanks the
 * whole page; `attachment.url` is never read, so a document pointing at a
 * `Binary` renders a row saying "0 B" with a modal that reports an unsupported
 * type; and a document not referenced from a `Composition.section` is never
 * passed to the renderer at all.
 *
 * So the obligations here are specific:
 *
 *  - **`content` is `1..*`, and the entries are the same document in different
 *    formats.** A PDF and a CDA of one discharge summary are one card with a
 *    format switcher. Rendering them as two documents doubles every document in
 *    the list.
 *  - **No `content` renders a row that says so** and never throws.
 *  - **A `url` pointing at a `Binary` in this bundle is resolved and rendered**,
 *    because that is the normal shape from a real FHIR server.
 *  - **An external `url` is never fetched.** It is named as external, shown, and
 *    offered as a copy. A silent request to a third party out of an untrusted
 *    payload is exactly what this tool promises not to make, and a `localhost`
 *    attachment URL inside an otherwise working link is the motivating incident
 *    one layer down.
 *  - **The bytes are checked against what the payload claims about them**: the
 *    `att-1` invariant, the declared `size`, the SHA-1 `hash`, and a sniff of the
 *    leading bytes against the declared `contentType`.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Download, FileText, Link as LinkIcon, ShieldAlert } from 'lucide-react';
import { formatBytes, toArrayBuffer, utf8Decode } from '../../core/bytes';
import { classifyHost, reachIsUnreachableByOthers } from '../../core/diagnose/host';
import { hashForLink } from '../../app/router';
import { Button, Callout, Chip, CodeBlock, CopyButton, Disclosure, type Tone } from '../primitives';
import { DetailTable } from './ResourceCard';
import { ErrorBoundary } from './ErrorBoundary';
import {
  arrField,
  asRecord,
  codeableConcept,
  codeableConceptText,
  numField,
  strField,
  type FhirNode,
} from './display';
import {
  Absent,
  ConceptValue,
  DateValue,
  ReferenceValue,
  type RenderContext,
} from './UnknownResource';

/** Above this, bytes are decoded only when the reader asks. */
const INLINE_DECODE_LIMIT = 8 * 1024 * 1024;
/** Text shown inline before it is truncated with a note. */
const TEXT_PREVIEW_LIMIT = 60 * 1024;

// ---------------------------------------------------------------------------
// Bytes
// ---------------------------------------------------------------------------

export interface DecodedData {
  bytes?: Uint8Array;
  error?: string;
}

/**
 * Decode `Attachment.data`.
 *
 * FHIR `base64Binary` is standard base64, so the strict base64url decoder in
 * `core/bytes` (right for JOSE, where mixing alphabets is the classic bug)
 * refuses it by design. Both alphabets are accepted here because both are in the
 * wild, and whitespace is stripped because a base64 blob that has been through
 * an XML pretty-printer arrives wrapped.
 */
export function decodeAttachmentData(data: string): DecodedData {
  const compact = data.replace(/\s+/g, '');
  const standard = compact.replace(/-/g, '+').replace(/_/g, '/');
  const padded = standard + '='.repeat((4 - (standard.length % 4)) % 4);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(padded)) {
    return {
      error:
        'This is not base64 at all. Whatever produced it wrote something else into a base64Binary element, so no receiver will get bytes out of it.',
    };
  }
  try {
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return { bytes };
  } catch {
    return { error: 'The base64 is malformed, most often because it was truncated in transit.' };
  }
}

export interface Sniffed {
  contentType: string;
  label: string;
}

/**
 * What the leading bytes say the content really is.
 *
 * A declared type that disagrees with the bytes is exactly the class of bug that
 * makes a receiver fail mysteriously, and it costs nothing to check.
 */
export function sniffContentType(bytes: Uint8Array): Sniffed | undefined {
  const head = bytes.subarray(0, 512);
  const ascii = String.fromCharCode(...Array.from(head.subarray(0, 256)));
  if (ascii.startsWith('%PDF-')) return { contentType: 'application/pdf', label: 'a PDF' };
  if (head[0] === 0x89 && head[1] === 0x50)
    return { contentType: 'image/png', label: 'a PNG image' };
  if (head[0] === 0xff && head[1] === 0xd8) {
    return { contentType: 'image/jpeg', label: 'a JPEG image' };
  }
  if (ascii.startsWith('GIF8')) return { contentType: 'image/gif', label: 'a GIF image' };
  if (ascii.startsWith('RIFF') && ascii.includes('WEBP')) {
    return { contentType: 'image/webp', label: 'a WebP image' };
  }
  if (ascii.startsWith('PK')) {
    return {
      contentType: 'application/zip',
      label: 'a zip container (which is what an ODF or OOXML file is)',
    };
  }
  if (/<\?xml|^\s*</.test(ascii)) {
    if (/<ClinicalDocument[\s>]/.test(ascii)) {
      return { contentType: 'application/hl7-v3+xml', label: 'an HL7 v3 CDA clinical document' };
    }
    return { contentType: 'application/xml', label: 'XML' };
  }
  if (/^\s*[[{]/.test(ascii)) return { contentType: 'application/json', label: 'JSON' };
  return undefined;
}

/** The first bytes as hex and ASCII, for a type nothing can preview. */
export function hexDump(bytes: Uint8Array, limit = 256): string {
  const lines: string[] = [];
  const end = Math.min(bytes.byteLength, limit);
  for (let offset = 0; offset < end; offset += 16) {
    const row = bytes.subarray(offset, Math.min(offset + 16, end));
    const hex = Array.from(row)
      .map((byte) => byte.toString(16).padStart(2, '0'))
      .join(' ')
      .padEnd(47, ' ');
    const text = Array.from(row)
      .map((byte) => (byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.'))
      .join('');
    lines.push(`${offset.toString(16).padStart(8, '0')}  ${hex}  ${text}`);
  }
  if (bytes.byteLength > end) lines.push(`… ${formatBytes(bytes.byteLength - end)} more`);
  return lines.join('\n');
}

/**
 * An object URL that is revoked when it stops being used.
 *
 * Leaking one is not a rounding error at these sizes: a demo that opens a dozen
 * documents holds every one of them in memory until the tab closes.
 */
function useObjectUrl(bytes: Uint8Array | undefined, contentType: string): string | undefined {
  // Created during render rather than in an effect, deliberately. Creating it in
  // an effect means a first paint with no src, then a setState, then a second
  // paint: a visible flash on every attachment. The revoke stays in an effect
  // keyed on the url, so a changed attachment releases the previous blob and an
  // unmount releases the last one.
  const url = useMemo(
    () =>
      bytes === undefined
        ? undefined
        : URL.createObjectURL(new Blob([toArrayBuffer(bytes)], { type: contentType })),
    [bytes, contentType],
  );
  useEffect(
    () => () => {
      if (url !== undefined) URL.revokeObjectURL(url);
    },
    [url],
  );
  return url;
}

function fileNameFor(title: string | undefined, contentType: string): string {
  const base = (title ?? 'attachment').replace(/[^A-Za-z0-9 ._-]+/g, '').trim() || 'attachment';
  if (/\.[A-Za-z0-9]{2,5}$/.test(base)) return base;
  const extension = contentType.includes('pdf')
    ? 'pdf'
    : contentType.includes('png')
      ? 'png'
      : contentType.includes('jpeg')
        ? 'jpg'
        : contentType.includes('gif')
          ? 'gif'
          : contentType.includes('json')
            ? 'json'
            : contentType.includes('xml')
              ? 'xml'
              : contentType.includes('zip')
                ? 'zip'
                : contentType.startsWith('text/')
                  ? 'txt'
                  : 'bin';
  return `${base}.${extension}`;
}

// ---------------------------------------------------------------------------
// The attachment previewer
// ---------------------------------------------------------------------------

export interface AttachmentPreviewProps {
  attachment: unknown;
  context: RenderContext;
  /** From `DocumentReference.content.format`, which says what shape the bytes are. */
  format?: unknown;
}

export function AttachmentPreview({
  attachment,
  context,
  format,
}: AttachmentPreviewProps): ReactNode {
  const record = asRecord(attachment);
  // The missing-attachment case returns before any hook runs, which is why it is
  // a separate component rather than an early return inside one: an early return
  // above a hook is how a renderer that handles a malformed payload once starts
  // throwing on the render after it.
  if (record === undefined) {
    return (
      <Callout tone="fail" title="This content entry has no attachment">
        <span className="mono">DocumentReference.content.attachment</span> is 1..1, so an entry
        without one carries nothing at all. There is no document here to render, and a receiver
        expecting one will fail rather than skip it.
      </Callout>
    );
  }
  return <AttachmentDetail record={record} context={context} format={format} />;
}

function AttachmentDetail({
  record,
  context,
  format,
}: {
  record: FhirNode;
  context: RenderContext;
  format?: unknown;
}): ReactNode {
  const [decodeAnyway, setDecodeAnyway] = useState(false);

  const declared = strField(record, 'contentType');
  const title = strField(record, 'title');
  const language = strField(record, 'language');
  const creation = strField(record, 'creation');
  const declaredSize = numField(record, 'size');
  const hash = strField(record, 'hash');
  const data = strField(record, 'data');
  const url = strField(record, 'url');

  // A url pointing at a Binary in this bundle is the normal shape from a real
  // server, and resolving it is the difference between rendering the document and
  // rendering "0 B".
  const binary = url === undefined ? undefined : resolveBundledBinary(url, context);
  const effectiveData = data ?? binary?.data;
  const effectiveDeclared = declared ?? binary?.contentType;

  const tooBig = effectiveData !== undefined && effectiveData.length > INLINE_DECODE_LIMIT * 1.4;
  const decoded = useMemo<DecodedData | undefined>(() => {
    if (effectiveData === undefined) return undefined;
    if (tooBig && !decodeAnyway) return undefined;
    return decodeAttachmentData(effectiveData);
  }, [effectiveData, tooBig, decodeAnyway]);

  const bytes = decoded?.bytes;
  const sniffed = bytes === undefined ? undefined : sniffContentType(bytes);
  const effective = sniffed?.contentType ?? effectiveDeclared ?? 'application/octet-stream';

  const rows = [
    {
      key: 'contentType',
      value:
        effectiveDeclared === undefined ? (
          <Absent>Not stated</Absent>
        ) : (
          <span className="mono">{effectiveDeclared}</span>
        ),
      ...(effectiveDeclared === undefined && effectiveData !== undefined
        ? {
            tone: 'fail' as Tone,
            note: 'The att-1 invariant is "if the Attachment has data, it SHALL have a contentType". This one has bytes and no declared type, so a receiver has to guess what to do with them.',
          }
        : {}),
    },
    ...(title === undefined ? [] : [{ key: 'title', value: title }]),
    ...(language === undefined
      ? []
      : [
          {
            key: 'language',
            value: <span className="mono">{language}</span>,
            note: 'The human language of the content, as a BCP-47 tag.',
          },
        ]),
    ...(creation === undefined ? [] : [{ key: 'creation', value: <DateValue value={creation} /> }]),
    ...(declaredSize === undefined
      ? []
      : [
          {
            key: 'size',
            value: `${formatBytes(declaredSize)} declared`,
            ...sizeVerdict(declaredSize, bytes),
          },
        ]),
    ...(format === undefined
      ? []
      : [
          {
            key: 'format',
            value: <ConceptValue value={format} />,
            note: 'The document structure and template beyond the mime type. This is what tells a receiver that an application/xml attachment is a CDA CCD rather than arbitrary XML.',
          },
        ]),
    ...(hash === undefined
      ? []
      : [
          {
            key: 'hash',
            value: <HashCheck hash={hash} bytes={bytes} />,
            note: 'The FHIR hash element is SHA-1, base64 encoded, and it is the only integrity check the payload offers.',
          },
        ]),
  ];

  return (
    <div className="attachment">
      <DetailTable dense rows={rows} />

      {sniffed !== undefined &&
        effectiveDeclared !== undefined &&
        !typesAgree(effectiveDeclared, sniffed.contentType) && (
          <Callout tone="warn" title="The bytes are not what the payload says they are">
            This attachment declares <span className="mono">{effectiveDeclared}</span> and its
            leading bytes are {sniffed.label} (<span className="mono">{sniffed.contentType}</span>).
            SHLoupe previews it as what it actually is. A receiver that switches on the declared
            type will fail here, and the failure will look like a corrupt file rather than a
            mislabelled one.
          </Callout>
        )}

      {effective === 'application/hl7-v3+xml' && (
        <Callout tone="info" title="This is a CDA document, not FHIR">
          An HL7 v3 Clinical Document Architecture document: XML with a{' '}
          <span className="mono">ClinicalDocument</span> root, structured completely differently
          from anything else in this payload. SHLoupe shows the XML as it arrived rather than
          transforming it, because the usual transform is HL7's own informative stylesheet and it is
          a sample rendering, not the document. Send it to a CDA viewer if you need it laid out.
        </Callout>
      )}

      {decoded?.error !== undefined && (
        <Callout tone="fail" title="The attachment bytes could not be decoded">
          {decoded.error}
        </Callout>
      )}

      {binary !== undefined && (
        <Callout tone="pass" title="This attachment's URL points at a Binary in this bundle">
          The URL is <span className="mono">{url}</span>, and this bundle carries the matching{' '}
          <span className="mono">Binary</span>, so the bytes are here and no request is needed.
          Inside a health link that is always the case: the specification says a Binary is
          represented in the native FHIR format when wrapped in a Bundle, so its data travels with
          it.
        </Callout>
      )}

      {/* Four states of data-versus-url, and the third is the one to get right: a
          url beside bytes that are already here is PROVENANCE, not a document
          SHLoupe is missing. Saying "the bytes are not in the payload" over an
          attachment being previewed two rows down is the kind of contradiction
          that makes a reader stop trusting the whole page. */}
      {url !== undefined && binary === undefined && data === undefined && (
        <ExternalAttachmentUrl url={url} />
      )}
      {url !== undefined && binary === undefined && data !== undefined && (
        <div className="attachment-provenance">
          <DetailTable
            dense
            rows={[
              {
                key: 'url',
                value: <span className="opaque-value">{url}</span>,
                note: 'This attachment carries its own bytes AND says where they came from. The preview below is the bytes in the payload; the URL is recorded provenance, and SHLoupe does not fetch it to compare.',
              },
            ]}
          />
          <CopyButton value={url} label="Copy the URL" />
        </div>
      )}

      {tooBig && !decodeAnyway && (
        <Callout tone="warn" title="Large attachment, not decoded yet">
          <p>
            This attachment is about {formatBytes(Math.floor(effectiveData.length * 0.75))} once
            decoded. Decoding it inline will freeze the tab for a moment, which is not something to
            discover mid-demo, so it waits for you.
          </p>
          <Button variant="primary" onClick={() => setDecodeAnyway(true)}>
            Decode and preview it
          </Button>
        </Callout>
      )}

      {bytes !== undefined && (
        <ErrorBoundary label="this attachment preview" unit="table">
          <AttachmentBody bytes={bytes} contentType={effective} title={title} />
        </ErrorBoundary>
      )}

      {effectiveData === undefined && url === undefined && (
        <Callout tone="warn" title="Metadata only: no bytes and no location">
          Both <span className="mono">data</span> and <span className="mono">url</span> are absent,
          so this attachment describes a document that is not here and says nothing about where to
          get it. That is usually a broken export rather than a deliberate reference.
        </Callout>
      )}
    </div>
  );
}

function sizeVerdict(
  declaredSize: number,
  bytes: Uint8Array | undefined,
): { tone?: Tone; note?: string } {
  if (bytes === undefined) return {};
  if (bytes.byteLength === declaredSize) {
    return { tone: 'pass', note: 'Matches the decoded byte length.' };
  }
  const looksLikeBase64Length = Math.abs(declaredSize - Math.ceil(bytes.byteLength / 3) * 4) <= 4;
  return {
    tone: 'warn',
    note: looksLikeBase64Length
      ? `The decoded content is ${formatBytes(bytes.byteLength)}, and the declared size matches the length of the base64 STRING instead. The element is defined as the byte count before base64 encoding, so this is the common off-by-a-third bug.`
      : `The decoded content is ${formatBytes(bytes.byteLength)}, which is not what was declared. A receiver that allocates or validates against size will reject this.`,
  };
}

/** Two content types agree when their type and subtype do; parameters are noise. */
function typesAgree(declared: string, sniffed: string): boolean {
  const base = (value: string): string => (value.split(';')[0] ?? '').trim().toLowerCase();
  const left = base(declared);
  const right = base(sniffed);
  if (left === right) return true;
  // A CDA is legitimately declared as several things, and text/xml versus
  // application/xml is not a defect worth shouting about.
  const xml = new Set([
    'application/xml',
    'text/xml',
    'application/hl7-v3+xml',
    'application/cda+xml',
    'application/xml+cda',
  ]);
  if (xml.has(left) && xml.has(right)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// The preview bodies
// ---------------------------------------------------------------------------

function AttachmentBody({
  bytes,
  contentType,
  title,
}: {
  bytes: Uint8Array;
  contentType: string;
  title: string | undefined;
}): ReactNode {
  const objectUrl = useObjectUrl(bytes, contentType);
  const download =
    objectUrl === undefined ? null : (
      <a
        className="btn btn-default attachment-download"
        href={objectUrl}
        download={fileNameFor(title, contentType)}
      >
        <Download size={13} aria-hidden />
        <span>Download {fileNameFor(title, contentType)}</span>
      </a>
    );

  if (contentType.startsWith('image/')) {
    return (
      <div className="attachment-preview">
        {objectUrl !== undefined && (
          <img className="attachment-image" src={objectUrl} alt={title ?? 'Attached image'} />
        )}
        <div className="attachment-actions">{download}</div>
      </div>
    );
  }

  if (contentType.includes('pdf')) {
    return (
      <div className="attachment-preview">
        {objectUrl !== undefined && (
          // A fully restricted sandbox: no scripts, no same-origin access, no
          // forms, no top-level navigation. The browser's own PDF viewer needs
          // none of those, and a PDF out of an untrusted payload gets no
          // capability at all. If a browser declines to render it in these
          // conditions the download below is the always-working path, which is
          // why it is beside the frame rather than behind a menu.
          <iframe
            className="attachment-frame"
            src={objectUrl}
            sandbox=""
            title={title ?? 'Attached PDF'}
          />
        )}
        <div className="attachment-actions">
          {download}
          <span className="value-note">
            Rendered by your browser's own PDF viewer, inside a sandboxed frame with no scripting
            and no access to this page.
          </span>
        </div>
      </div>
    );
  }

  if (
    contentType.startsWith('text/') ||
    contentType.includes('xml') ||
    contentType.includes('json') ||
    contentType.includes('html')
  ) {
    const text = utf8Decode(bytes);
    const clipped = text.slice(0, TEXT_PREVIEW_LIMIT);
    return (
      <div className="attachment-preview">
        <CodeBlock language={contentType.includes('json') ? 'json' : 'xml'} maxHeight={420}>
          {clipped}
        </CodeBlock>
        {clipped.length < text.length && (
          <p className="value-note">
            Showing the first {formatBytes(clipped.length)} of {formatBytes(text.length)}. Download
            it for the rest.
          </p>
        )}
        <div className="attachment-actions">{download}</div>
      </div>
    );
  }

  return (
    <div className="attachment-preview">
      <p className="value-note">
        Nothing in the browser can lay out <span className="mono">{contentType}</span>, so here are
        the leading bytes and a download. The bytes are worth a look before you reach for another
        tool: a file that is not what it claims usually says so in its first sixteen.
      </p>
      <CodeBlock language="hexdump">{hexDump(bytes)}</CodeBlock>
      <div className="attachment-actions">{download}</div>
    </div>
  );
}

/**
 * A `url` we are not going to fetch, and why.
 *
 * The static checks are the same ones the link pipeline runs on a manifest URL,
 * because the failure is the same failure: an attachment on `localhost` inside an
 * otherwise working link opens on the machine that minted it and nowhere else.
 */
function ExternalAttachmentUrl({ url }: { url: string }): ReactNode {
  // The nested-link case is decided before anything is parsed as a URL: a
  // `shlink:/` payload does parse as one (scheme plus opaque path), and running
  // the host checks over its empty hostname would be answering a question nobody
  // asked.
  const shlink = /shlink:\/{1,2}[A-Za-z0-9_-]+/.exec(url)?.[0];
  if (shlink !== undefined) {
    return (
      <Callout tone="info" title="This attachment is itself a SMART Health Link">
        <p>
          The attachment's URL is a <span className="mono">shlink:/</span> payload rather than a
          document location, which is how a received link is preserved so it can be passed on. It is
          a link inside a payload, and opening it is a separate decision with its own network
          requests.
        </p>
        <div className="attachment-actions">
          <a className="btn btn-primary" href={hashForLink(shlink)}>
            <LinkIcon size={13} aria-hidden />
            <span>Open this link in SHLoupe</span>
          </a>
          <CopyButton value={shlink} label="Copy the link" />
        </div>
      </Callout>
    );
  }

  const parsed = (() => {
    try {
      return new URL(url);
    } catch {
      return undefined;
    }
  })();
  const host = parsed === undefined ? undefined : classifyHost(parsed.hostname);
  const unreachable = host !== undefined && reachIsUnreachableByOthers(host.reach);

  return (
    <Callout tone={unreachable ? 'warn' : 'info'} title="This attachment lives somewhere else">
      <p>
        The bytes are not in the payload. SHLoupe will not fetch them: a viewer that dereferences a
        URL out of a payload it was handed is a beacon, and this one would run on your network, from
        your address, with your cookies for that origin.
      </p>
      <DetailTable
        dense
        rows={[
          { key: 'url', value: <span className="opaque-value">{url}</span> },
          ...(parsed === undefined
            ? [
                {
                  key: 'shape',
                  value: 'Not a URL SHLoupe can parse',
                  tone: 'warn' as Tone,
                  note: 'A url element that is not a URL cannot be dereferenced by anything.',
                },
              ]
            : [
                { key: 'scheme', value: <span className="mono">{parsed.protocol}</span> },
                { key: 'host', value: <span className="mono">{parsed.hostname}</span> },
              ]),
          ...(host === undefined
            ? []
            : [
                {
                  key: 'reachable by',
                  value: reachWord(host.reach),
                  tone: (unreachable ? 'warn' : 'info') as Tone,
                  note: host.because,
                },
              ]),
        ]}
      />
      {unreachable && (
        <p className="attachment-warning">
          <ShieldAlert size={14} aria-hidden /> An address only the sending machine can reach is the
          motivating bug of this whole tool, one layer down: the link works for its author and for
          nobody else, and the failure surfaces as an empty document rather than as an unreachable
          host.
        </p>
      )}
      {parsed?.protocol === 'http:' && (
        <p className="value-note">
          Plain <span className="mono">http:</span>, so a browser on an https page will block the
          request as mixed content even if the host is reachable.
        </p>
      )}
      <CopyButton value={url} label="Copy the URL" />
    </Callout>
  );
}

function reachWord(reach: string): string {
  switch (reach) {
    case 'public':
      return 'Anyone on the internet';
    case 'loopback':
      return 'Only the machine that wrote this';
    case 'private-network':
      return 'Only devices on the same network';
    default:
      return reach.replace(/-/g, ' ');
  }
}

/**
 * Verify the SHA-1 hash, on request.
 *
 * SHA-1 is deprecated for signing and not for digesting, and the specification
 * mandates it here, so `crypto.subtle.digest('SHA-1', …)` is both available and
 * correct. On request rather than automatically, because a page that quietly
 * hashes every attachment on render is doing work nobody asked for.
 */
function HashCheck({ hash, bytes }: { hash: string; bytes: Uint8Array | undefined }): ReactNode {
  const [state, setState] = useState<'idle' | 'checking' | 'match' | 'mismatch' | 'error'>('idle');
  const [computed, setComputed] = useState<string | undefined>(undefined);

  const check = async (): Promise<void> => {
    if (bytes === undefined) return;
    setState('checking');
    try {
      const digest = await crypto.subtle.digest('SHA-1', toArrayBuffer(bytes));
      const encoded = btoa(String.fromCharCode(...Array.from(new Uint8Array(digest))));
      setComputed(encoded);
      setState(encoded === hash.trim() ? 'match' : 'mismatch');
    } catch {
      setState('error');
    }
  };

  return (
    <span className="hash-check">
      <span className="opaque-value">{hash}</span>
      {bytes !== undefined && state === 'idle' && (
        <Button size="sm" onClick={() => void check()}>
          Verify
        </Button>
      )}
      {state === 'checking' && <span className="value-note">Hashing…</span>}
      {state === 'match' && <Chip tone="pass">Matches the bytes</Chip>}
      {state === 'mismatch' && (
        <>
          <Chip tone="fail">Does not match</Chip>
          <span className="value-note">
            The bytes hash to <span className="mono">{computed}</span>. The attachment has been
            altered, truncated or re-encoded since the hash was written, and this is the only
            integrity check the payload offers.
          </span>
        </>
      )}
      {state === 'error' && (
        <span className="value-note">
          This browser refused a SHA-1 digest, so the hash cannot be checked here.
        </span>
      )}
    </span>
  );
}

/** A `Binary` in this bundle, found by the attachment URL. */
function resolveBundledBinary(
  url: string,
  context: RenderContext,
): { data?: string; contentType?: string } | undefined {
  const resolution = context.index.resolve({ reference: url }, context.from);
  const resource =
    resolution.kind === 'resolved'
      ? resolution.entry.resource
      : resolution.kind === 'contained'
        ? resolution.resource
        : undefined;
  if (resource === undefined) return undefined;
  if (strField(resource, 'resourceType') !== 'Binary') return undefined;
  const data = strField(resource, 'data');
  const contentType = strField(resource, 'contentType');
  return {
    ...(data === undefined ? {} : { data }),
    ...(contentType === undefined ? {} : { contentType }),
  };
}

// ---------------------------------------------------------------------------
// DocumentReference
// ---------------------------------------------------------------------------

export function DocumentReferenceView({
  resource,
  context,
}: {
  resource: FhirNode;
  context: RenderContext;
}): ReactNode {
  const contents = arrField(resource, 'content');
  const [selected, setSelected] = useState(0);

  const description = strField(resource, 'description');
  const date = strField(resource, 'date');
  const docStatus = strField(resource, 'docStatus');
  const relatesTo = arrField(resource, 'relatesTo');
  const contextElement = asRecord(resource['context']);

  return (
    <div className="document-reference">
      <DetailTable
        rows={[
          { key: 'type', value: <ConceptValue value={resource['type']} /> },
          ...(description === undefined ? [] : [{ key: 'description', value: description }]),
          ...(date === undefined ? [] : [{ key: 'date', value: <DateValue value={date} /> }]),
          ...(docStatus === undefined
            ? []
            : [
                {
                  key: 'docStatus',
                  value: docStatus,
                  note: 'Where the document itself is up to, which is a different axis from status: a current DocumentReference can point at a preliminary document.',
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
          ...(resource['author'] === undefined
            ? []
            : [
                {
                  key: 'author',
                  value: (
                    <span className="reference-list">
                      {arrField(resource, 'author').map((author, position) => (
                        <ReferenceValue key={position} value={author} context={context} />
                      ))}
                    </span>
                  ),
                },
              ]),
        ]}
      />

      {contents.length === 0 ? (
        <Callout tone="fail" title="This DocumentReference carries no content">
          <span className="mono">DocumentReference.content</span> is 1..* and this one has none, so
          the resource points at no document at all: no bytes, no location, no content type. It is a
          record that a document exists with no way to reach it, and it is worth telling whoever
          produced the payload, because it is invisible in a viewer that dereferences{' '}
          <span className="mono">content[0]</span> without checking (which is how one missing
          element takes down a whole page).
        </Callout>
      ) : (
        <>
          {contents.length > 1 && (
            <div className="doc-formats" role="group" aria-label="Formats of this one document">
              <p className="value-note">
                This document arrived in {contents.length} formats. They are the same document, not{' '}
                {contents.length} documents: <span className="mono">content</span> is 1..* precisely
                so a sender can offer a PDF and a CDA of one discharge summary.
              </p>
              {contents.map((entry, position) => (
                <Button
                  key={position}
                  size="sm"
                  variant={position === selected ? 'primary' : 'default'}
                  onClick={() => setSelected(position)}
                >
                  {formatLabel(entry, position)}
                </Button>
              ))}
            </div>
          )}
          <ErrorBoundary
            label="this document's attachment"
            unit="table"
            subject={contents[selected]}
          >
            <AttachmentPreview
              attachment={asRecord(contents[selected])?.['attachment']}
              context={context}
              format={asRecord(contents[selected])?.['format']}
            />
          </ErrorBoundary>
        </>
      )}

      {relatesTo.length > 0 && (
        <Disclosure
          summary={`Relates to ${relatesTo.length} other document${relatesTo.length === 1 ? '' : 's'}`}
        >
          <DetailTable
            dense
            rows={relatesTo.map((relation, position) => ({
              key: strField(relation, 'code') ?? `relation ${position + 1}`,
              value: <ReferenceValue value={asRecord(relation)?.['target']} context={context} />,
              note: 'A replaces or appends pointing at a document this bundle does not carry is normal, not an error.',
            }))}
          />
        </Disclosure>
      )}

      {contextElement !== undefined && (
        <Disclosure summary="Clinical context">
          <DetailTable
            dense
            rows={[
              ...(contextElement['encounter'] === undefined
                ? []
                : [
                    {
                      key: 'encounter',
                      value: (
                        <ReferenceValue value={contextElement['encounter']} context={context} />
                      ),
                    },
                  ]),
              ...(contextElement['period'] === undefined
                ? []
                : [{ key: 'period', value: <DateValue value={contextElement['period']} /> }]),
              ...(contextElement['facilityType'] === undefined
                ? []
                : [
                    {
                      key: 'facilityType',
                      value: <ConceptValue value={contextElement['facilityType']} />,
                    },
                  ]),
              ...(contextElement['practiceSetting'] === undefined
                ? []
                : [
                    {
                      key: 'practiceSetting',
                      value: <ConceptValue value={contextElement['practiceSetting']} />,
                    },
                  ]),
            ]}
          />
        </Disclosure>
      )}
    </div>
  );
}

function formatLabel(content: unknown, position: number): string {
  const attachment = asRecord(content)?.['attachment'];
  const contentType = strField(attachment, 'contentType');
  const formatText =
    codeableConceptText(asRecord(content)?.['format']) ??
    codeableConcept(asRecord(content)?.['format'])?.codes[0]?.code;
  if (contentType === undefined && formatText === undefined) return `Format ${position + 1}`;
  return [contentType, formatText].filter((part) => part !== undefined).join(' · ');
}

// ---------------------------------------------------------------------------
// Binary
// ---------------------------------------------------------------------------

/**
 * A `Binary` inside a payload is always the JSON form, so its bytes are already
 * here and no request is required. It renders through the same previewer as an
 * attachment, because it is the same three fields.
 */
export function BinaryView({
  resource,
  context,
}: {
  resource: FhirNode;
  context: RenderContext;
}): ReactNode {
  const securityContext = resource['securityContext'];
  return (
    <div className="binary-view">
      <p className="value-note">
        <FileText size={13} aria-hidden /> A Binary carried inside a Bundle is always the native
        FHIR JSON form, so the bytes travel with it. Nothing is fetched to show this.
      </p>
      <AttachmentPreview
        attachment={{
          ...(strField(resource, 'contentType') === undefined
            ? {}
            : { contentType: strField(resource, 'contentType') }),
          ...(strField(resource, 'data') === undefined ? {} : { data: strField(resource, 'data') }),
        }}
        context={context}
      />
      {securityContext !== undefined && (
        <div className="binary-security">
          <DetailTable
            dense
            rows={[
              {
                key: 'securityContext',
                value: <ReferenceValue value={securityContext} context={context} />,
                note: 'The resource whose access rules govern these bytes. When it points outside the payload, the rules that were meant to protect this content are not here either.',
              },
            ]}
          />
        </div>
      )}
      {strField(resource, 'data') === undefined && (
        <Callout tone="warn" title="This Binary has no data">
          <span className="mono">Binary.data</span> is 0..1, and inside a bundle it is the only
          place the bytes can be, so a Binary without it carries nothing. Anything referring to it
          will render empty.
        </Callout>
      )}
    </div>
  );
}
