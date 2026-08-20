/**
 * The same pipeline, over content that arrived some other way.
 *
 * This is not a fallback. It is the only path that always works: it survives a
 * relay that is down, a server with no CORS headers, a link that points at the
 * sender's laptop, a locked-down conference network and an air gap. Every
 * "Loupe cannot fetch this" verdict is only useful because it ends with "run
 * this command and paste what comes back", and this module is what makes that
 * sentence true.
 *
 * Two design decisions are worth stating, because both look like bugs otherwise.
 *
 * 1. **A fatal reachability finding does not stop an offline run.** Online, a
 *    link pointing at `localhost` stops the pipeline, because spending a request
 *    to learn what the URL already said is waste. Offline the bytes are already
 *    in hand, so the reachability verdict is recorded as what it is (the link is
 *    unusable by anyone else) and the content is opened anyway. A run can
 *    therefore carry a fatal finding and an outcome of `opened`, and that pair is
 *    the exact truth of the motivating incident: the link is broken, and here is
 *    what is inside it.
 *
 * 2. **A step that was not sent says so.** The manifest step records the request
 *    it WOULD have sent, so the reader can compare it against what they ran by
 *    hand, and a note states plainly that nothing left the tab. `networkUsed`
 *    stays false for the whole run, which is what the offline badge reads.
 *
 * The per-step bodies here duplicate a little of {@link file://./pipeline.ts},
 * whose step helpers are module-private. That is deliberate rather than lazy:
 * the offline steps genuinely differ (no fetch, no location hop, no blocking
 * static gate), and sharing them would mean parameterising the online pipeline
 * with an "actually, do not" flag, which is how the honesty of the trace gets
 * lost.
 */
import { base64urlToBytes, formatBytes, utf8Decode } from './bytes';
import { CITATIONS } from './citations';
import { inflateForgiving } from './compress';
import { HTTPS_VIEWER, type DiagnosisContext, type ViewerOrigin } from './diagnose/context';
import { runStaticRules } from './diagnose/rules';
import {
  decryptDirA256Gcm,
  describeIvLength,
  jwkThumbprint,
  JoseError,
  matchKeyToJweKid,
  parseJweCompact,
  parseJwsCompact,
  verifyEs256,
  type EcJwk,
  type JweHeader,
  type JwsParts,
} from './jose';
import { OfflineTransport, toRequestRecord, toResponseRecord } from './net/browser';
import { curlForDirectFile, curlForOfflineHandoff, manifestBody } from './net/curl';
import { classifyContent, type OpenedFile, type PipelineResult } from './pipeline';
import { decodeShlPayload, extractShlink, validateShlPayload, verdictsToRows } from './shlink';
import type { ShlLink } from './shlink';
import {
  Recorder,
  StepFailure,
  type Finding,
  type InputKind,
  type RunOutcome,
  type StepHandle,
  type TraceRun,
} from './trace';

export interface OfflineInput {
  /** From `detectInput`, so the screen and the pipeline agree on what this is. */
  kind: InputKind;
  /** The primary pasted content, with any HTTP wrapper already peeled off. */
  text: string;
  /** The link's decryption key, or one the user typed. base64url, 43 characters. */
  key?: string;
  /** A manifest response fetched some other way, for a run that starts at a link. */
  manifest?: string;
  /** A single encrypted file, when the primary text is a link or a manifest. */
  jwe?: string;
  /**
   * An issuer key set, for verifying a health card with no network. Optional
   * because it usually is not to hand, and a card that cannot be verified is
   * still worth rendering as long as the trace says it was not verified.
   */
  jwks?: string;
  viewer?: ViewerOrigin;
  recipient?: string;
  now?: () => number;
  onProgress?: (run: TraceRun) => void;
}

const DEFAULT_RECIPIENT = 'Loupe (offline)';

const NO_NETWORK_NOTE =
  'Nothing in this run touched the network. Every byte came from what you pasted.';

/**
 * Open whatever was pasted, with no network at all.
 *
 * Dispatch is on the detected kind rather than re-sniffing, so the verdict the
 * screen showed while the user was typing is the one that runs.
 */
export async function openOffline(input: OfflineInput): Promise<PipelineResult> {
  switch (input.kind) {
    case 'shlink':
      return openOfflineLink(input);
    case 'manifest':
      return openOfflineManifest(input);
    case 'jwe':
      return openOfflineJwe(input);
    case 'fhir':
      return openOfflineFhir(input);
    case 'shc':
    case 'jws':
      return openOfflineHealthCard(input);
    case 'hcert':
      return openUnsupported(
        input,
        'hcert',
        'This is an HC1 certificate, from the EU Digital COVID Certificate and WHO DDCC family.',
        'Loupe reads SMART Health Links and SMART Health Cards. An HC1 payload is base45-encoded CBOR inside a COSE signature envelope, which is a different stack end to end, and a half-decode that showed you some bytes would be worse than saying so.',
      );
    default:
      return openUnsupported(
        input,
        'unknown',
        'Loupe does not recognise this content.',
        'It reads a SMART Health Link, a manifest response, an encrypted JWE file, a SMART Health Card, a FHIR resource or bundle, and the raw output of a curl command. If you believe this is one of those, the detection sentence above the box says what it saw.',
      );
  }
}

// ---------------------------------------------------------------------------
// A link, plus a manifest somebody fetched by hand
// ---------------------------------------------------------------------------

export async function openOfflineLink(input: OfflineInput): Promise<PipelineResult> {
  const recorder = newRecorder(input, 'shlink');
  const files: OpenedFile[] = [];
  let link: ShlLink | undefined;

  try {
    const extraction = await recorder.run(
      {
        kind: 'input.detect',
        title: 'Recognise the link',
        summary: 'Find the shlink payload inside whatever was pasted.',
      },
      (step) => {
        const found = extractShlink(input.text);
        if (found === undefined) {
          step.find({
            ruleId: 'INPUT-NOT-A-SHLINK',
            severity: 'fatal',
            audience: 'you',
            title: 'This does not contain a SMART Health Link.',
            detail:
              'Offline mode was asked to treat this as a link, and no shlink payload could be found in it.',
          });
          throw new StepFailure('No shlink payload found');
        }
        step.kv([
          { key: 'form', value: found.form },
          { key: 'payload length', value: `${found.encodedPayload.length} characters` },
        ]);
        step.note(NO_NETWORK_NOTE);
        step.cite(CITATIONS.linkUri);
        return found;
      },
    );

    const payload = await recorder.run(
      { kind: 'shlink.decode', title: 'Decode the payload', summary: 'base64url to JSON.' },
      (step) => {
        const decoded = decodeShlPayload(extraction.encodedPayload);
        if (typeof decoded.key === 'string') recorder.redactor.register(decoded.key, 'link key');
        step.json('Decoded payload', decoded);
        step.cite(CITATIONS.payloadMembers);
        return decoded;
      },
    );

    link = await recorder.run(
      {
        kind: 'shlink.validate',
        title: 'Check the payload against the specification',
        summary: 'Member by member, so the whole table is visible at once.',
      },
      (step) => {
        const result = validateShlPayload(payload);
        step.kv(verdictsToRows(result.verdicts));
        step.cite(CITATIONS.payloadMembers);
        for (const problem of result.fatal) {
          step.find({
            ruleId: 'SHL-PAYLOAD-INVALID',
            severity: 'fatal',
            audience: 'sender',
            title: 'The payload is not usable as it stands.',
            detail: problem,
            citation: CITATIONS.payloadMembers,
          });
        }
        if (result.link === undefined) throw new StepFailure('Payload unusable');
        if (result.verdicts.some((v) => v.status !== 'ok')) step.end('warn');
        return result.link;
      },
    );
    const shl = link;

    await recorder.run(
      {
        kind: 'static.analyse',
        title: 'Inspect the manifest URL anyway',
        summary:
          'The address still tells you whether anybody else could have opened this link, even though we are not going to request it.',
      },
      (step) => {
        let parsed: URL;
        try {
          parsed = new URL(shl.url);
        } catch {
          step.find({
            ruleId: 'SHL-URL-UNPARSEABLE',
            severity: 'error',
            audience: 'sender',
            title: 'The manifest URL is not a URL.',
            detail: `"${shl.url}" cannot be parsed. Offline mode does not need it, so the run carries on, but no browser could ever have fetched it.`,
            citation: CITATIONS.payloadUrl,
          });
          step.end('warn');
          return;
        }
        step.kv([
          { key: 'scheme', value: parsed.protocol.replace(':', '') },
          { key: 'host', value: parsed.hostname },
          { key: 'port', value: parsed.port || '(default)' },
          { key: 'path', value: parsed.pathname },
        ]);
        const context: DiagnosisContext = {
          url: parsed,
          rawUrl: shl.url,
          link: shl,
          viewer: input.viewer ?? HTTPS_VIEWER,
          now: (input.now ?? Date.now)(),
        };
        const findings = runStaticRules(context);
        for (const finding of findings) step.find(finding);
        // The online pipeline stops here on a fatal finding. Offline it must not:
        // the whole point of this screen is that the content is already in hand,
        // so a verdict about reachability is information rather than a gate.
        step.note(
          findings.some((f) => f.severity === 'fatal')
            ? 'Loupe would stop here on a live run, because no request to this address can succeed. Offline it carries on: the content came from your paste, so reachability decides who else can open the link, not whether you can read it now.'
            : 'Nothing about this address would have stopped a live run.',
        );
        if (findings.length > 0) step.end('warn');
      },
    );

    const manifestText = input.manifest?.trim();
    if (manifestText === undefined || manifestText.length === 0) {
      await recorder.run(
        {
          kind: 'net.manifest',
          title: 'Fetch the manifest',
          summary: 'Offline mode has nothing to fetch it with.',
        },
        (step) => {
          const recipient = input.recipient ?? DEFAULT_RECIPIENT;
          step.command(
            'Run this, then paste what it prints into the manifest box',
            'bash',
            curlForOfflineHandoff({ url: shl.url, recipient }),
          );
          step.find({
            ruleId: 'OFFLINE-NO-MANIFEST',
            severity: 'info',
            audience: 'you',
            title: 'Loupe needs the manifest response before it can open this link.',
            detail:
              'Offline mode issues no requests, so the manifest has to arrive the same way everything else here does: pasted. The command above fetches it from a shell, where the browser rules that block this page do not apply.',
            remedy: 'Run the command, then paste its output into the manifest box and open it again.',
            citation: CITATIONS.manifestRequest,
          });
          step.end('blocked');
        },
      );
    } else {
      const manifest = await servedManifest(recorder, shl, manifestText, input);
      const entries = await readManifest(recorder, manifest, shl.url);
      for (const [index, entry] of entries.entries()) {
        files.push(await openEntry(recorder, entry, index, shl.key, input));
      }
    }
  } catch (error) {
    recordUnexpected(recorder, error);
  }

  return finish(recorder, files, link);
}

interface ManifestEntry {
  contentType?: string;
  embedded?: string;
  location?: string;
  lastUpdated?: string;
}

/**
 * Run the manifest step against a pasted response, through the transport seam.
 *
 * Going through {@link OfflineTransport} rather than reading the string directly
 * is what keeps this step the same shape as its online twin: a recorded request,
 * a recorded response, a status to interpret. The transport is keyed by purpose
 * so it answers whatever URL the link happens to carry.
 */
async function servedManifest(
  recorder: Recorder,
  link: ShlLink,
  manifestText: string,
  input: OfflineInput,
): Promise<unknown> {
  const recipient = input.recipient ?? DEFAULT_RECIPIENT;
  const transport = OfflineTransport.withBodies({ manifest: manifestText });
  return recorder.run(
    {
      kind: 'net.manifest',
      title: 'Read the manifest you supplied',
      summary: 'The manifest step, run against pasted bytes instead of a response.',
    },
    async (step) => {
      const request = {
        method: 'POST' as const,
        url: link.url,
        headers: { 'content-type': 'application/json' },
        body: manifestBody({ url: link.url, recipient }),
        purpose: 'manifest' as const,
      };
      step.request(toRequestRecord(request));
      step.note(
        'This request was not sent. It is recorded so you can compare it against the one you ran by hand: a manifest request is a POST with a JSON body, and a GET to the same URL is a different thing entirely.',
      );
      const response = await transport.send(request);
      step.response(toResponseRecord(response));
      try {
        const parsed: unknown = JSON.parse(response.body);
        step.json('Manifest', parsed);
        return parsed;
      } catch {
        step.text('What was pasted, verbatim', response.body.slice(0, 4000));
        step.find({
          ruleId: 'OFFLINE-MANIFEST-NOT-JSON',
          severity: 'fatal',
          audience: 'you',
          title: 'What you pasted as a manifest is not JSON.',
          detail: `${formatBytes(response.bodyBytes)} arrived and none of it parses. If this came from curl with -D or -i, the response headers are still on the front of it: paste the whole thing, headers included, and Loupe will split them off for you.`,
          citation: CITATIONS.manifestResponse,
        });
        throw new StepFailure('Pasted manifest not JSON');
      }
    },
  );
}

const SHL_CONTENT_TYPES = [
  'application/smart-health-card',
  'application/fhir+json',
  'application/smart-api-access',
];

async function readManifest(
  recorder: Recorder,
  manifest: unknown,
  linkUrl: string,
): Promise<ManifestEntry[]> {
  return recorder.run(
    {
      kind: 'manifest.validate',
      title: 'Read the manifest',
      summary: 'Check its shape, then account for every file it names.',
    },
    (step) => {
      if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
        step.find({
          ruleId: 'SHL-MANIFEST-NOT-OBJECT',
          severity: 'fatal',
          audience: 'server',
          title: 'The manifest is not a JSON object.',
          detail: 'A manifest is an object with a files array. This is not.',
          citation: CITATIONS.manifestResponse,
        });
        throw new StepFailure('Manifest not an object');
      }
      const record = manifest as Record<string, unknown>;
      const rawFiles = record.files;
      if (!Array.isArray(rawFiles)) {
        step.find({
          ruleId: 'SHL-MANIFEST-NO-FILES',
          severity: 'fatal',
          audience: 'server',
          title: 'The manifest has no files array.',
          detail: `It parsed as JSON and carries ${
            Object.keys(record).length === 0
              ? 'no members at all'
              : `only ${Object.keys(record).join(', ')}`
          }. A manifest's files array is what a receiver reads.`,
          citation: CITATIONS.manifestFiles,
        });
        throw new StepFailure('No files array');
      }
      if (typeof record.status === 'string') {
        step.kv([{ key: 'status', value: record.status }]);
      }
      if (rawFiles.length === 0) {
        step.find({
          ruleId: 'SHL-MANIFEST-EMPTY',
          severity: 'error',
          audience: 'sender',
          title: 'The manifest is valid and contains nothing.',
          detail:
            'files is an empty array, so there is nothing to decrypt. The usual cause is a share created before its content was attached.',
          citation: CITATIONS.manifestFiles,
        });
        throw new StepFailure('Manifest empty', 'blocked');
      }

      const entries: ManifestEntry[] = [];
      const rows = [];
      for (const [index, raw] of rawFiles.entries()) {
        const entry = (typeof raw === 'object' && raw !== null ? raw : {}) as ManifestEntry;
        entries.push(entry);
        const known =
          entry.contentType !== undefined &&
          SHL_CONTENT_TYPES.some((type) => entry.contentType?.startsWith(type) === true);
        const neither = entry.embedded === undefined && entry.location === undefined;
        rows.push({
          key: `files[${index}]`,
          value: [
            entry.contentType ?? 'no contentType',
            entry.embedded === undefined
              ? undefined
              : `embedded (${formatBytes(entry.embedded.length)})`,
            entry.location === undefined ? undefined : 'by location',
          ]
            .filter((part): part is string => part !== undefined)
            .join(' · '),
          status: neither ? ('fail' as const) : known ? ('ok' as const) : ('warn' as const),
          ...(neither
            ? { note: 'Neither embedded nor location, so there is nothing to open.' }
            : {}),
        });
      }
      step.kv(rows);
      step.cite(CITATIONS.manifestFiles);

      // A location is the one thing offline mode cannot follow, so say which
      // command fetches it rather than reporting each one as a failure later.
      for (const [index, entry] of entries.entries()) {
        if (entry.location === undefined || entry.embedded !== undefined) continue;
        let resolved = entry.location;
        try {
          resolved = new URL(entry.location, linkUrl).toString();
        } catch {
          // A location that will not resolve against the manifest URL is
          // reported as it was written, which is more useful than dropping it.
        }
        step.command(`Fetch file ${index + 1} yourself`, 'bash', curlForDirectFile(resolved));
      }
      return entries;
    },
  );
}

async function openEntry(
  recorder: Recorder,
  entry: ManifestEntry,
  index: number,
  keyB64: string,
  input: OfflineInput,
): Promise<OpenedFile> {
  const declared = entry.contentType;
  if (entry.embedded !== undefined) {
    return openJweFile(recorder, entry.embedded, keyB64, index, declared);
  }
  // A single pasted JWE stands in for one file the manifest only located, which
  // is exactly what the two-step curl handoff produces.
  const pasted = input.jwe?.trim();
  if (pasted !== undefined && pasted.length > 0 && index === 0) {
    return openJweFile(recorder, pasted, keyB64, index, declared);
  }
  return {
    index,
    source: 'location',
    ...(declared === undefined ? {} : { declaredContentType: declared }),
    kind: 'unknown',
    compressed: false,
    failure: {
      message: 'This file is only available by location, and offline mode issues no requests.',
      hint: 'Fetch it with the command in the manifest step, then paste the file into the encrypted-file box.',
    },
  };
}

// ---------------------------------------------------------------------------
// A manifest on its own
// ---------------------------------------------------------------------------

export async function openOfflineManifest(input: OfflineInput): Promise<PipelineResult> {
  const recorder = newRecorder(input, 'manifest');
  const files: OpenedFile[] = [];
  const key = input.key?.trim();

  try {
    const manifest = await recorder.run(
      {
        kind: 'input.detect',
        title: 'Read the pasted manifest',
        summary: 'A manifest response, with no link and no request behind it.',
      },
      (step) => {
        step.note(NO_NETWORK_NOTE);
        try {
          const parsed: unknown = JSON.parse(input.text);
          step.json('Manifest', parsed);
          return parsed;
        } catch {
          step.find({
            ruleId: 'OFFLINE-MANIFEST-NOT-JSON',
            severity: 'fatal',
            audience: 'you',
            title: 'This does not parse as JSON.',
            detail:
              'A manifest response is a JSON object with a files array. If this came from curl with -D or -i, paste the whole output including the headers and Loupe will split them off.',
          });
          throw new StepFailure('Pasted manifest not JSON');
        }
      },
    );

    const entries = await readManifest(recorder, manifest, 'https://example.invalid/');
    if (key === undefined || key.length === 0) {
      recorder.find({
        ruleId: 'OFFLINE-NO-KEY',
        severity: 'info',
        audience: 'you',
        title: 'The files in this manifest are encrypted, and there is no key yet.',
        detail:
          'A manifest lists ciphertext. The key that decrypts it lives in the SMART Health Link the manifest came from, as its `key` member, which is 43 characters of base64url.',
        remedy: 'Paste the link, or just its key, into the key box and open it again.',
        citation: CITATIONS.payloadKey,
      });
    } else {
      recorder.redactor.register(key, 'supplied key');
      for (const [index, entry] of entries.entries()) {
        files.push(await openEntry(recorder, entry, index, key, input));
      }
    }
  } catch (error) {
    recordUnexpected(recorder, error);
  }

  return finish(recorder, files, undefined);
}

// ---------------------------------------------------------------------------
// One encrypted file
// ---------------------------------------------------------------------------

export async function openOfflineJwe(input: OfflineInput): Promise<PipelineResult> {
  const recorder = newRecorder(input, 'jwe');
  const files: OpenedFile[] = [];
  const key = input.key?.trim();

  try {
    if (key === undefined || key.length === 0) {
      await recorder.run(
        {
          kind: 'input.detect',
          title: 'Read the pasted file',
          summary: 'An encrypted file needs the key from its link.',
        },
        (step) => {
          step.note(NO_NETWORK_NOTE);
          step.find({
            ruleId: 'OFFLINE-NO-KEY',
            severity: 'info',
            audience: 'you',
            title: 'This file is encrypted, and there is no key yet.',
            detail:
              'The key is the `key` member of the SMART Health Link this file belongs to: 43 characters of base64url, being 32 random bytes. Loupe decrypts with it here in the tab and never sends it anywhere.',
            remedy: 'Paste the link, or just its key, into the key box and open it again.',
            citation: CITATIONS.payloadKey,
          });
          step.end('blocked');
        },
      );
    } else {
      recorder.redactor.register(key, 'supplied key');
      files.push(await openJweFile(recorder, input.text.trim(), key, 0, undefined));
    }
  } catch (error) {
    recordUnexpected(recorder, error);
  }

  return finish(recorder, files, undefined);
}

/**
 * Decrypt, decompress and identify one file.
 *
 * Every precondition is checked and recorded before the opaque call, because
 * AES-GCM authentication failure is one indistinguishable error for a wrong key,
 * a truncated ciphertext and a tampered tag. After the checks below, that error
 * means one of exactly three things, and the trace can say which three.
 */
async function openJweFile(
  recorder: Recorder,
  jwe: string,
  keyB64: string,
  index: number,
  declared: string | undefined,
): Promise<OpenedFile> {
  const base: OpenedFile = {
    index,
    source: 'embedded',
    ...(declared === undefined ? {} : { declaredContentType: declared }),
    kind: 'unknown',
    compressed: false,
  };

  let header: JweHeader;
  try {
    header = await recorder.run(
      {
        kind: 'jwe.header',
        title: `Read file ${index + 1}'s encryption header`,
        summary: 'Five dot-separated parts, and every one of them checkable.',
      },
      async (step) => {
        const parts = parseJweCompact(jwe);
        const iv = base64urlToBytes(parts.ivB64);
        const tag = base64urlToBytes(parts.tagB64);
        const ciphertext = base64urlToBytes(parts.ciphertextB64);
        step.json('Protected header', parts.header);
        step.kv([
          {
            key: 'alg',
            value: String(parts.header.alg),
            status: parts.header.alg === 'dir' ? 'ok' : 'fail',
          },
          {
            key: 'enc',
            value: String(parts.header.enc),
            status: parts.header.enc === 'A256GCM' ? 'ok' : 'fail',
          },
          {
            key: 'zip',
            value: parts.header.zip === undefined ? '(none)' : String(parts.header.zip),
            status: parts.header.zip === undefined || parts.header.zip === 'DEF' ? 'ok' : 'warn',
          },
          {
            key: 'encrypted key',
            value:
              parts.encryptedKeyB64 === ''
                ? '(empty, correct for alg=dir)'
                : `${parts.encryptedKeyB64.length} characters`,
            status: parts.encryptedKeyB64 === '' ? 'ok' : 'fail',
          },
          {
            key: 'iv',
            value: `${iv.byteLength} bytes`,
            status: iv.byteLength === 12 ? 'ok' : 'fail',
            ...(describeIvLength(iv.byteLength) === undefined
              ? {}
              : { note: describeIvLength(iv.byteLength) as string }),
          },
          { key: 'ciphertext', value: formatBytes(ciphertext.byteLength) },
          {
            key: 'tag',
            value: `${tag.byteLength} bytes`,
            status: tag.byteLength === 16 ? 'ok' : 'fail',
          },
        ]);
        step.cite(CITATIONS.jweCompact);

        const match = await matchKeyToJweKid(parts.header, keyB64);
        if (match.verdict === 'mismatch') {
          step.find({
            ruleId: 'SHL-KEY-MISMATCH',
            severity: 'fatal',
            audience: 'sender',
            title: 'This file was encrypted with a different key than the one supplied.',
            detail: `The header names key ${match.kid}, and the key here is ${match.expected}. Those are RFC 7638 thumbprints, so this is proof rather than inference: decryption cannot succeed.`,
            remedy: 'Use the key from the link that this file came from.',
            citation: CITATIONS.shcKid,
          });
          throw new StepFailure('Key mismatch');
        }
        if (match.verdict === 'match') {
          step.note(
            `The header's kid matches the key supplied (RFC 7638 thumbprint ${match.kid}), so if decryption fails below, the cause is the bytes and not the key.`,
          );
        }
        return parts.header;
      },
    );
  } catch (error) {
    return { ...base, failure: failureOf(error) };
  }

  let plainBytes: Uint8Array;
  try {
    plainBytes = await recorder.run(
      {
        kind: 'jwe.decrypt',
        title: `Decrypt file ${index + 1}`,
        summary: 'AES-256-GCM with the key supplied. Nothing leaves this tab.',
      },
      async (step) => {
        const result = await decryptDirA256Gcm(jwe, base64urlToBytes(keyB64));
        step.kv([
          { key: 'plaintext', value: formatBytes(result.sizes.plaintext) },
          {
            key: 'expansion',
            value: `${result.sizes.ciphertext - result.sizes.plaintext} bytes of overhead`,
          },
        ]);
        step.cite(CITATIONS.encryption);
        return result.plaintext;
      },
    );
  } catch (error) {
    const failure = failureOf(error);
    recorder.find({
      ruleId: 'SHL-DECRYPT-FAILED',
      severity: 'fatal',
      audience: 'sender',
      title: `File ${index + 1} could not be decrypted.`,
      detail: `${failure.message} ${failure.hint ?? ''}`.trim(),
      citation: CITATIONS.encryption,
    });
    return { ...base, jweHeader: header, failure };
  }

  let compressed = false;
  if (header.zip === 'DEF') {
    try {
      const inflated = plainBytes;
      plainBytes = await recorder.run(
        {
          kind: 'payload.inflate',
          title: `Decompress file ${index + 1}`,
          summary: 'zip=DEF means raw DEFLATE, with no zlib or gzip framing.',
        },
        (step) => {
          const result = inflateForgiving(inflated);
          step.kv([
            { key: 'framing', value: result.framing },
            { key: 'inflated', value: formatBytes(result.bytes.byteLength) },
          ]);
          if (result.deviation !== undefined) {
            step.find({
              ruleId: 'SHL-ZIP-FRAMING',
              severity: 'error',
              audience: 'sender',
              title: 'The compressed payload is not raw DEFLATE.',
              detail: result.deviation,
              citation: CITATIONS.encryption,
            });
            step.end('warn');
          }
          return result.bytes;
        },
      );
      compressed = true;
    } catch (error) {
      return { ...base, jweHeader: header, failure: failureOf(error) };
    }
  }

  return classifyPlaintext(recorder, { ...base, jweHeader: header, compressed }, plainBytes, {
    ...(declared === undefined ? {} : { declared }),
    ...(typeof header.cty === 'string' ? { cty: header.cty } : {}),
  });
}

// ---------------------------------------------------------------------------
// Already-decrypted content
// ---------------------------------------------------------------------------

export async function openOfflineFhir(input: OfflineInput): Promise<PipelineResult> {
  const recorder = newRecorder(input, 'fhir');
  const files: OpenedFile[] = [];

  try {
    const file = await recorder.run(
      {
        kind: 'fhir.parse',
        title: 'Read the pasted FHIR',
        summary: 'Already decrypted, so there is nothing to decode and nothing to check a key on.',
      },
      (step) => {
        step.note(NO_NETWORK_NOTE);
        let parsed: unknown;
        try {
          parsed = JSON.parse(input.text);
        } catch {
          step.find({
            ruleId: 'OFFLINE-FHIR-NOT-JSON',
            severity: 'fatal',
            audience: 'you',
            title: 'This does not parse as JSON.',
            detail: 'A FHIR resource is a JSON object with a resourceType member.',
          });
          throw new StepFailure('Pasted FHIR not JSON');
        }
        const record =
          typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : undefined;
        const resourceType = typeof record?.resourceType === 'string' ? record.resourceType : undefined;
        step.kv([
          { key: 'resourceType', value: resourceType ?? '(absent)', status: resourceType === undefined ? 'fail' : 'ok' },
          ...(Array.isArray(record?.entry) ? [{ key: 'entries', value: String(record.entry.length) }] : []),
        ]);
        if (resourceType === undefined) {
          step.find({
            ruleId: 'OFFLINE-FHIR-NO-RESOURCE-TYPE',
            severity: 'error',
            audience: 'you',
            title: 'This JSON has no resourceType, so it is not a FHIR resource.',
            detail:
              'Every FHIR resource names its own type. Without it there is nothing to render, and a manifest or a health-card file is a different shape entirely.',
          });
          step.end('warn');
        }
        const text = input.text.trim();
        return {
          index: 0,
          source: 'embedded' as const,
          kind: 'fhir' as const,
          content: parsed,
          plaintext: text,
          compressed: false,
          bytes: new TextEncoder().encode(text).byteLength,
        };
      },
    );
    files.push(file);
  } catch (error) {
    recordUnexpected(recorder, error);
  }

  return finish(recorder, files, undefined);
}

// ---------------------------------------------------------------------------
// Health cards
// ---------------------------------------------------------------------------

export async function openOfflineHealthCard(input: OfflineInput): Promise<PipelineResult> {
  const recorder = newRecorder(input, input.kind === 'jws' ? 'jws' : 'shc');
  const files: OpenedFile[] = [];

  try {
    const cards = await recorder.run(
      {
        kind: 'input.detect',
        title: 'Find the signed cards',
        summary: 'A health card arrives as digits, as a file wrapper, or as a bare signed token.',
      },
      (step) => {
        step.note(NO_NETWORK_NOTE);
        const text = input.text.trim();
        if (/^shc:\//i.test(text)) {
          const decoded = decodeShcNumeric(text);
          step.kv([
            { key: 'form', value: 'numeric, as a QR code carries it' },
            { key: 'digits', value: String(decoded.digits) },
            { key: 'chunks', value: String(decoded.chunks) },
          ]);
          if (decoded.problem !== undefined) {
            step.find({
              ruleId: 'SHC-NUMERIC-MALFORMED',
              severity: 'fatal',
              audience: 'you',
              title: 'The numeric card is not a whole number of character pairs.',
              detail: decoded.problem,
              citation: CITATIONS.shcFile,
            });
            throw new StepFailure('Numeric card malformed');
          }
          return [decoded.jws];
        }
        if (text.startsWith('{')) {
          const parsed: unknown = JSON.parse(text);
          const record = parsed as { verifiableCredential?: unknown };
          const list = Array.isArray(record.verifiableCredential)
            ? record.verifiableCredential.filter((value): value is string => typeof value === 'string')
            : [];
          step.kv([
            { key: 'form', value: 'a health-card file wrapper' },
            { key: 'cards', value: String(list.length) },
          ]);
          if (list.length === 0) {
            step.find({
              ruleId: 'SHC-FILE-EMPTY',
              severity: 'fatal',
              audience: 'sender',
              title: 'The health-card file carries no cards.',
              detail:
                'A health-card file is an object whose verifiableCredential member is an array of compact JWS strings. This one has none, or they are not strings.',
              citation: CITATIONS.shcFile,
            });
            throw new StepFailure('No credentials in file');
          }
          return list;
        }
        step.kv([{ key: 'form', value: 'a bare compact JWS' }]);
        return [text];
      },
    );

    const keySet = readJwks(recorder, input.jwks);
    for (const [index, card] of cards.entries()) {
      files.push(await openCard(recorder, card, index, keySet));
    }
  } catch (error) {
    recordUnexpected(recorder, error);
  }

  return finish(recorder, files, undefined);
}

interface NumericDecode {
  jws: string;
  digits: number;
  chunks: number;
  problem?: string;
}

/**
 * `shc:/` digits back to the signed token.
 *
 * Each pair of digits is one character of the JWS, offset by 45 so the whole
 * card fits a QR code's numeric mode. A chunked card is `shc:/1/2/…`, and the
 * chunk header is not part of the payload.
 */
export function decodeShcNumeric(text: string): NumericDecode {
  const body = text.replace(/^shc:\//i, '');
  const chunkMatch = /^(\d+)\/(\d+)\//.exec(body);
  const chunks = chunkMatch?.[2] === undefined ? 1 : Number.parseInt(chunkMatch[2], 10);
  const digits = (chunkMatch === null ? body : body.slice(chunkMatch[0].length)).replace(
    /[^\d]/g,
    '',
  );
  if (digits.length % 2 === 1) {
    return {
      jws: '',
      digits: digits.length,
      chunks,
      problem: `The card decodes two digits per character, and ${digits.length} digits leaves one over. A digit was lost, most often to a partial QR scan or a copy that clipped the end.`,
    };
  }
  let out = '';
  for (let i = 0; i < digits.length; i += 2) {
    out += String.fromCharCode(Number.parseInt(digits.slice(i, i + 2), 10) + 45);
  }
  return { jws: out, digits: digits.length, chunks };
}

function readJwks(recorder: Recorder, jwks: string | undefined): EcJwk[] | undefined {
  const text = jwks?.trim();
  if (text === undefined || text.length === 0) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    const record = parsed as { keys?: unknown };
    const keys = Array.isArray(record.keys) ? record.keys : Array.isArray(parsed) ? parsed : [parsed];
    return keys.filter((key): key is EcJwk => typeof key === 'object' && key !== null);
  } catch {
    recorder.find({
      ruleId: 'OFFLINE-JWKS-NOT-JSON',
      severity: 'warning',
      audience: 'you',
      title: 'The issuer key set you pasted is not JSON, so no signature was checked.',
      detail:
        'An issuer key set is the JSON document served at the issuer URL plus /.well-known/jwks.json. The cards below are still decoded and rendered, and the trace says they are unverified.',
    });
    return undefined;
  }
}

async function openCard(
  recorder: Recorder,
  compact: string,
  index: number,
  keySet: EcJwk[] | undefined,
): Promise<OpenedFile> {
  const base: OpenedFile = { index, source: 'embedded', kind: 'smart-health-card', compressed: true };

  let jws: JwsParts;
  let payload: Record<string, unknown>;
  try {
    const read = await recorder.run(
      {
        kind: 'shc.verify',
        title: `Read card ${index + 1}`,
        summary: 'A health card is an ES256 JWS over a raw-DEFLATE payload.',
      },
      async (step) => {
        const parts = parseJwsCompact(compact);
        step.json('Protected header', parts.header);
        step.kv([
          {
            key: 'alg',
            value: String(parts.header.alg),
            status: parts.header.alg === 'ES256' ? 'ok' : 'fail',
            ...(parts.header.alg === 'ES256'
              ? {}
              : { note: 'A health card is signed with ES256 and nothing else.' }),
          },
          {
            key: 'zip',
            value: parts.header.zip === undefined ? '(none)' : String(parts.header.zip),
            status: parts.header.zip === 'DEF' ? 'ok' : 'warn',
            ...(parts.header.zip === 'DEF'
              ? {}
              : { note: 'A health card payload is required to be raw DEFLATE compressed.' }),
          },
          { key: 'kid', value: parts.header.kid === undefined ? '(absent)' : String(parts.header.kid) },
        ]);
        step.cite(CITATIONS.shcJws);

        const rawPayload = base64urlToBytes(parts.payloadB64);
        const bytes =
          parts.header.zip === 'DEF' ? inflateForgiving(rawPayload).bytes : rawPayload;
        const parsed: unknown = JSON.parse(utf8Decode(bytes));
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new StepFailure('Card payload is not a JSON object');
        }
        const record = parsed as Record<string, unknown>;
        step.kv([
          { key: 'iss', value: typeof record.iss === 'string' ? record.iss : '(absent)' },
          {
            key: 'nbf',
            value:
              typeof record.nbf === 'number'
                ? new Date(record.nbf * 1000).toISOString()
                : '(absent)',
          },
        ]);
        await verifyCard(step, parts, record, keySet);
        return { parts, record };
      },
    );
    jws = read.parts;
    payload = read.record;
  } catch (error) {
    return { ...base, failure: failureOf(error) };
  }

  const bundle = fhirBundleOf(payload);
  if (bundle === undefined) {
    return {
      ...base,
      content: payload,
      plaintext: JSON.stringify(payload),
      failure: {
        message: 'The card verified structurally and carries no FHIR bundle.',
        hint: 'A health card holds its content at vc.credentialSubject.fhirBundle. This one does not, so there is nothing clinical to render.',
      },
    };
  }
  void jws;
  const text = JSON.stringify(bundle);
  return {
    ...base,
    kind: 'smart-health-card',
    content: bundle,
    plaintext: text,
    bytes: new TextEncoder().encode(text).byteLength,
  };
}

/**
 * Check the signature when a key set is to hand, and say so plainly when it is
 * not.
 *
 * "Unverified" has to be stated rather than left blank. The incumbent reader
 * renders nothing at all for an unsigned payload, so "this was not checked" and
 * "this checked out" look identical, which is the worst possible outcome for a
 * tool people use to judge conformance.
 */
async function verifyCard(
  step: StepHandle,
  jws: JwsParts,
  payload: Record<string, unknown>,
  keySet: EcJwk[] | undefined,
): Promise<void> {
  const iss = typeof payload.iss === 'string' ? payload.iss : undefined;
  if (keySet === undefined) {
    if (iss !== undefined) {
      step.command(
        "Fetch the issuer's key set, then paste it in to check the signature",
        'bash',
        `curl -sS ${JSON.stringify(`${iss.replace(/\/$/, '')}/.well-known/jwks.json`)}`,
      );
    }
    step.find({
      ruleId: 'SHC-NOT-VERIFIED',
      severity: 'info',
      audience: 'you',
      title: 'The signature on this card was not checked.',
      detail: `Checking it needs the issuer's public key set, which lives at${
        iss === undefined ? ' the issuer URL' : ` ${iss}/.well-known/jwks.json`
      } and can only be fetched over the network. Everything below is what the card says about itself, not something Loupe has confirmed.`,
      remedy: 'Fetch the key set with the command above and paste it into the key-set box.',
      citation: CITATIONS.shcJwks,
    });
    step.end('warn');
    return;
  }

  const kid = jws.header.kid;
  const candidates: EcJwk[] = [];
  for (const key of keySet) {
    if (kid === undefined) {
      candidates.push(key);
      continue;
    }
    if (key.kid === kid) candidates.push(key);
  }
  if (candidates.length === 0 && kid !== undefined) {
    // A key set may omit `kid`, in which case the thumbprint is the identity the
    // card is naming, so compute it rather than declaring the key absent.
    for (const key of keySet) {
      try {
        if ((await jwkThumbprint(key)) === kid) candidates.push(key);
      } catch {
        // Not a thumbprintable key; the loop below reports the miss.
      }
    }
  }
  if (candidates.length === 0) {
    step.find({
      ruleId: 'SHC-KEY-NOT-IN-SET',
      severity: 'error',
      audience: 'server',
      title: 'The key set you pasted does not contain the key this card names.',
      detail: `The card's kid is ${String(kid)}, and no key in the set has that kid or that RFC 7638 thumbprint. Either the issuer rotated its key and left the old card in circulation, or the key set came from a different issuer.`,
      citation: CITATIONS.shcJwks,
    });
    step.end('warn');
    return;
  }

  for (const candidate of candidates) {
    try {
      await verifyEs256(jws, candidate);
      step.kv([{ key: 'signature', value: 'verified', status: 'ok' }]);
      step.find({
        ruleId: 'SHC-VERIFIED',
        severity: 'good',
        audience: 'nobody',
        title: 'The signature on this card verifies against the key set you supplied.',
        detail:
          'The card was signed by the holder of that key and has not been altered since. Whether that key belongs to an issuer you trust is a separate question, and not one a viewer can answer.',
        citation: CITATIONS.shcJws,
      });
      return;
    } catch (error) {
      const failure = failureOf(error);
      step.find({
        ruleId: 'SHC-SIGNATURE-INVALID',
        severity: 'error',
        audience: 'sender',
        title: 'The signature on this card does not verify.',
        detail: `${failure.message} ${failure.hint ?? ''}`.trim(),
        citation: CITATIONS.shcJws,
      });
      step.end('warn');
      return;
    }
  }
}

function fhirBundleOf(payload: Record<string, unknown>): unknown {
  const vc = payload.vc;
  if (typeof vc !== 'object' || vc === null) return undefined;
  const subject = (vc as { credentialSubject?: unknown }).credentialSubject;
  if (typeof subject !== 'object' || subject === null) return undefined;
  const bundle = (subject as { fhirBundle?: unknown }).fhirBundle;
  return typeof bundle === 'object' && bundle !== null ? bundle : undefined;
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

function classifyPlaintext(
  recorder: Recorder,
  base: OpenedFile,
  bytes: Uint8Array,
  declared: { declared?: string; cty?: string },
): Promise<OpenedFile> {
  return recorder.run(
    {
      kind: 'payload.classify',
      title: `Identify what file ${base.index + 1} contains`,
      summary: 'The declared content type first, then the plaintext itself.',
    },
    (step) => {
      const text = utf8Decode(bytes);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        step.text('Plaintext, verbatim', text.slice(0, 2000));
        step.find({
          ruleId: 'SHL-PLAINTEXT-NOT-JSON',
          severity: 'error',
          audience: 'sender',
          title: `File ${base.index + 1} decrypted, and its contents are not JSON.`,
          detail:
            'Decryption succeeded, so the key and the ciphertext are both fine. What came out is not JSON, which points at the file that was encrypted rather than at the encryption.',
        });
        step.end('warn');
        return {
          ...base,
          plaintext: text,
          bytes: bytes.byteLength,
          failure: { message: 'Decrypted content is not JSON.' },
        };
      }
      const kind = classifyContent(parsed, declared.declared, declared.cty);
      step.kv([
        { key: 'declared', value: declared.declared ?? '(none)' },
        { key: 'cty', value: declared.cty ?? '(none)' },
        { key: 'identified as', value: kind, status: kind === 'unknown' ? 'warn' : 'ok' },
        { key: 'size', value: formatBytes(bytes.byteLength) },
      ]);
      return { ...base, kind, content: parsed, plaintext: text, bytes: bytes.byteLength };
    },
  );
}

async function openUnsupported(
  input: OfflineInput,
  kind: InputKind,
  title: string,
  detail: string,
): Promise<PipelineResult> {
  const recorder = newRecorder(input, kind);
  await recorder.run(
    { kind: 'input.detect', title: 'Recognise what was pasted' },
    (step) => {
      step.note(NO_NETWORK_NOTE);
      step.find({
        ruleId: kind === 'hcert' ? 'OFFLINE-HCERT-UNSUPPORTED' : 'OFFLINE-UNRECOGNISED',
        severity: 'error',
        audience: 'you',
        title,
        detail,
      });
      step.end('blocked');
    },
  );
  return finish(recorder, [], undefined);
}

function newRecorder(input: OfflineInput, kind: InputKind): Recorder {
  const recorder = new Recorder(
    { kind, source: input.text.trim(), label: 'Pasted offline' },
    input.now ?? (() => Date.now()),
  );
  if (input.onProgress !== undefined) recorder.subscribe(input.onProgress);
  return recorder;
}

function finish(
  recorder: Recorder,
  files: OpenedFile[],
  link: ShlLink | undefined,
): PipelineResult {
  const snapshot = recorder.snapshot();
  const outcome = decideOutcome(snapshot.steps, snapshot.findings, files);
  const run = recorder.finish(outcome);
  return {
    run,
    ...(link === undefined ? {} : { link }),
    files,
    outcome,
    redactor: recorder.redactor,
  };
}

/**
 * `blocked` means "we stopped on purpose and can say why"; `failed` means we
 * tried and it broke. Offline the distinction is still worth keeping, because a
 * missing key or a location-only file is a thing the user can go and fix, while
 * a tag mismatch is not.
 */
function decideOutcome(
  steps: TraceRun['steps'],
  findings: readonly Finding[],
  files: readonly OpenedFile[],
): RunOutcome {
  const opened = files.filter((file) => file.content !== undefined).length;
  if (opened > 0) return opened === files.length ? 'opened' : 'partial';
  if (steps.some((step) => step.status === 'fail')) return 'failed';
  if (steps.some((step) => step.status === 'blocked')) return 'blocked';
  return findings.some((finding) => finding.severity === 'fatal') ? 'blocked' : 'failed';
}

function failureOf(error: unknown): NonNullable<OpenedFile['failure']> {
  const message = error instanceof Error ? error.message : String(error);
  const hint = error instanceof JoseError ? error.hint : undefined;
  return { message, ...(hint === undefined ? {} : { hint }) };
}

function recordUnexpected(recorder: Recorder, error: unknown): void {
  if (error instanceof StepFailure) return;
  recorder.find({
    ruleId: 'LOUPE-INTERNAL',
    severity: 'error',
    audience: 'nobody',
    title: 'Loupe itself hit an unexpected error.',
    detail: `This is a defect in the tool, not in what you pasted: ${
      error instanceof Error ? error.message : String(error)
    }. The trace above is accurate up to the step that failed.`,
  });
}
