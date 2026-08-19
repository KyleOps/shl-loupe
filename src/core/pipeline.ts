/**
 * The pipeline: one traced run from pasted text to rendered payload.
 *
 * Written as a flat sequence of named steps against the {@link Recorder}, and
 * deliberately not as a chain of promises with one try/catch around it. The
 * reference implementation for this protocol collapses a six-hop pipeline into
 * a single stringified exception, which is why a link pointing at the sender's
 * own laptop reports "TypeLoad failed" instead of saying so. Every design
 * choice below exists to make that impossible here:
 *
 *  - Everything decidable offline is decided BEFORE any request is issued, and
 *    a fatal static finding stops the run rather than spending a request to
 *    learn what the URL already said.
 *  - Every hop keeps its request, its response, its status and its timing.
 *  - Per-file work is independent: one undecryptable file does not discard the
 *    ones that opened.
 *  - The network is injected, so offline mode and tests are the same code path.
 */
import { base64urlToBytes, formatBytes, utf8Decode } from './bytes';
import { CITATIONS } from './citations';
import { inflateForgiving } from './compress';
import type { DiagnosisContext, ViewerOrigin } from './diagnose/context';
import { differentialFor, differentialPreamble, type ProbeResults } from './diagnose/differential';
import { isBlocking, runStaticRules } from './diagnose/rules';
import {
  decryptDirA256Gcm,
  describeIvLength,
  JoseError,
  matchKeyToJweKid,
  parseJweCompact,
  type JweHeader,
} from './jose';
import {
  corsRequirementsFor,
  curlForDirectFile,
  curlForManifest,
  curlForPreflight,
  manifestBody,
} from './net/curl';
import {
  BrowserTransport,
  describeFetchEngine,
  failureToResponseRecord,
  toRequestRecord,
  toResponseRecord,
} from './net/browser';
import {
  combineProbePair,
  describeTimingBand,
  detectLnaEnforcement,
  isLnaGatedTarget,
  onlineHint,
  probeDns,
  probeReachability,
  timingBand,
} from './net/probe';
import { NetworkFailure, readableHeaderNote, type Transport } from './net/transport';
import {
  decodeShlPayload,
  extractShlink,
  validateShlPayload,
  verdictsToRows,
  type ShlLink,
} from './shlink';
import {
  Recorder,
  Redactor,
  StepFailure,
  type RunOutcome,
  type StepHandle,
  type TraceRun,
} from './trace';

// ---------------------------------------------------------------------------
// Options and results
// ---------------------------------------------------------------------------

export interface PipelineOptions {
  /** Raw text from the input box, a QR scan, or the page fragment. */
  input: string;
  viewer: ViewerOrigin;
  transport?: Transport;
  /** Sent as `recipient`. Named so a server operator's log says who called. */
  recipient: string;
  /** Supplied only after the user typed one. Never guessed, never retried. */
  passcode?: string;
  /**
   * Sent as `embeddedLengthMax`. A large value is a CORS survival strategy, not
   * only an optimisation: an embedded file needs no second cross-origin hop,
   * whereas a `location` puts a second origin's CORS posture in the way.
   */
  embeddedLengthMax?: number;
  /**
   * Opt-in probes that narrow an opaque failure. Off by default because two of
   * them talk to a third party (a public DNS-over-HTTPS resolver), and this
   * tool does not make a request the user did not ask for.
   */
  probes?: { reachability?: boolean; dns?: boolean };
  now?: () => number;
  /** Called on every trace mutation so the UI streams the run as it happens. */
  onProgress?: (run: TraceRun) => void;
}

export type FileKind = 'smart-health-card' | 'fhir' | 'smart-api-access' | 'unknown';

export interface OpenedFile {
  index: number;
  /** Where the bytes came from, which is a different question per file. */
  source: 'embedded' | 'location' | 'direct';
  /** From the manifest, when there was one. */
  declaredContentType?: string;
  jweHeader?: JweHeader;
  kind: FileKind;
  /** Decrypted, inflated, parsed. Present when the file opened. */
  content?: unknown;
  /** The decrypted text, kept so the raw view can show it. */
  plaintext?: string;
  compressed: boolean;
  bytes?: number;
  /** Present when this file did not open. The others still may have. */
  failure?: { message: string; hint?: string };
}

export interface PipelineResult {
  run: TraceRun;
  link?: ShlLink;
  files: OpenedFile[];
  outcome: RunOutcome;
  /**
   * The secret registry for this run. Anything that leaves the tab (a copied
   * diagnosis, an exported report) passes the run through `redactRun` with this
   * first, which is the single place that guarantee is made.
   */
  redactor: Redactor;
}

const SHL_CONTENT_TYPES = [
  'application/smart-health-card',
  'application/fhir+json',
  'application/smart-api-access',
];

/** The manifest `status` values STU 1 defines. */
const MANIFEST_STATUSES = ['finalized', 'can-change', 'no-longer-valid'];

/**
 * The `location` lifetime the specification puts on a sharing application: a
 * location URL "SHALL NOT" be dereferenced more than one hour after the
 * manifest was requested, and may be single use.
 */
const LOCATION_LIFETIME_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export async function openShl(options: PipelineOptions): Promise<PipelineResult> {
  const now = options.now ?? (() => Date.now());
  const transport = options.transport ?? new BrowserTransport();
  const recorder = new Recorder(
    { kind: 'shlink', source: options.input.trim() },
    now,
  );
  if (options.onProgress) recorder.subscribe(options.onProgress);

  const files: OpenedFile[] = [];
  let link: ShlLink | undefined;

  try {
    // -----------------------------------------------------------------------
    // 1. Recognise
    // -----------------------------------------------------------------------
    const extraction = await recorder.run(
      {
        kind: 'input.detect',
        title: 'Recognise the link',
        summary: 'Find the shlink payload inside whatever was pasted, scanned or linked.',
      },
      (step) => {
        const found = extractShlink(options.input);
        if (!found) {
          step.find({
            ruleId: 'INPUT-NOT-A-SHLINK',
            severity: 'fatal',
            audience: 'you',
            title: 'This does not contain a SMART Health Link.',
            detail:
              'Loupe looked for a "shlink:/" token, a viewer URL carrying one in its fragment, and a bare base64url payload that decodes to an object with a url and a key. None matched. If you have a manifest, a JWE or a FHIR bundle rather than a link, use Offline mode, which runs the same pipeline over pasted content.',
          });
          throw new StepFailure('No shlink payload found');
        }
        step.kv([
          { key: 'form', value: found.form },
          ...(found.viewerUrl === undefined
            ? []
            : [{ key: 'viewer prefix', value: found.viewerUrl }]),
          { key: 'payload length', value: `${found.encodedPayload.length} characters` },
        ]);
        step.cite(CITATIONS.linkUri);

        if (found.form === 'viewer-query') {
          step.find({
            ruleId: 'SHL-CARRIED-IN-QUERY',
            severity: 'error',
            audience: 'sender',
            title: 'The payload was in the query string, so the decryption key reached a server.',
            detail:
              'A SMART Health Link belongs after the "#" of a viewer URL, because a fragment is never sent to the server. In a query string the whole payload, decryption key included, travels to the viewer\'s own host and lands in its access logs, its proxy logs and its analytics. Whoever runs that viewer can decrypt this share.',
            remedy:
              'Distribute the link as "https://viewer.example.org#shlink:/..." and treat this one as compromised.',
            citation: CITATIONS.viewerUrl,
          });
        }
        if (found.form === 'shlink-uri-double-slash') {
          step.find({
            ruleId: 'SHL-DOUBLE-SLASH',
            severity: 'warning',
            audience: 'sender',
            title: 'The URI is written "shlink://" but the specification uses one slash.',
            detail:
              'A single slash is correct: "shlink:/" is not an authority-based URI, so there is no "//" host part. Loupe accepts both, and a strict receiver may not.',
            citation: CITATIONS.linkUri,
          });
        }
        if (found.viewerUrl !== undefined && !found.viewerUrl.endsWith('#')) {
          step.note(
            `The viewer prefix "${found.viewerUrl}" does not end with "#". The specification's viewer convention relies on the fragment so the payload never reaches a server.`,
          );
        }
        return found;
      },
    );

    // -----------------------------------------------------------------------
    // 2. Decode
    // -----------------------------------------------------------------------
    const payload = await recorder.run(
      {
        kind: 'shlink.decode',
        title: 'Decode the payload',
        summary: 'base64url to JSON. Nothing here touches the network.',
      },
      (step) => {
        const decoded = decodeShlPayload(extraction.encodedPayload);
        // Registered here, at the first moment the key exists, so any export
        // taken from this point on masks it. The trace itself keeps the real
        // value: it is the user's own key, on the user's own screen.
        if (typeof decoded.key === 'string') recorder.redactor.register(decoded.key, 'link key');
        step.json('Decoded payload', decoded);
        step.cite(CITATIONS.payloadMembers);
        return decoded;
      },
    );

    // -----------------------------------------------------------------------
    // 3. Judge each member
    // -----------------------------------------------------------------------
    const validation = await recorder.run(
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
        if (result.link && result.verdicts.some((v) => v.status !== 'ok')) step.end('warn');
        return result;
      },
    );
    link = validation.link;
    if (!link) throw new StepFailure('Payload unusable');
    // Bound locally so the step callbacks below carry a narrowed, non-optional
    // value: TypeScript cannot narrow a mutable outer binding across a closure.
    const shl: ShlLink = link;

    // -----------------------------------------------------------------------
    // 4. Everything decidable with no network at all
    // -----------------------------------------------------------------------
    const url = await recorder.run(
      {
        kind: 'static.analyse',
        title: 'Inspect the manifest URL, before requesting anything',
        summary:
          'Most links that fail at an event fail for a reason fully visible in the URL. This step is why Loupe often has an answer before the first request.',
      },
      (step) => {
        let parsed: URL;
        try {
          parsed = new URL(shl.url);
        } catch {
          step.find({
            ruleId: 'SHL-URL-UNPARSEABLE',
            severity: 'fatal',
            audience: 'sender',
            title: 'The manifest URL is not a URL.',
            detail: `"${shl.url}" cannot be parsed. A missing scheme is the usual cause: "example.org/manifest" is a relative path, not an address.`,
            citation: CITATIONS.payloadUrl,
          });
          throw new StepFailure('Unparseable URL');
        }
        const context: DiagnosisContext = {
          url: parsed,
          rawUrl: shl.url,
          link: shl,
          viewer: options.viewer,
          now: now(),
        };
        step.kv([
          { key: 'scheme', value: parsed.protocol.replace(':', '') },
          { key: 'host', value: parsed.hostname },
          { key: 'port', value: parsed.port || '(default)' },
          { key: 'path', value: parsed.pathname },
          { key: 'query', value: parsed.search || '(none)' },
          { key: 'url length', value: `${shl.url.length} of 128 characters permitted` },
        ]);
        const findings = runStaticRules(context);
        for (const finding of findings) step.find(finding);
        if (isBlocking(findings)) {
          throw new StepFailure('Stopped by a fatal static finding');
        }
        if (findings.some((f) => f.severity === 'error' || f.severity === 'warning')) {
          step.end('warn');
        }
        return parsed;
      },
    );

    // -----------------------------------------------------------------------
    // 5. Retrieve: either the manifest, or the single file for a U link
    // -----------------------------------------------------------------------
    if (shl.flags.includes('U')) {
      const file = await fetchDirectFile(recorder, transport, shl, url, options);
      files.push(await openFile(recorder, file, shl, 'direct', undefined, options));
    } else {
      const manifest = await fetchManifest(recorder, transport, shl, url, options);
      const entries = await validateManifest(recorder, manifest, shl, options.embeddedLengthMax);
      const manifestAt = now();
      for (const [index, entry] of entries.entries()) {
        files.push(
          await openManifestFile(recorder, transport, shl, entry, index, manifestAt, options),
        );
      }
    }
  } catch (error) {
    if (!(error instanceof StepFailure)) {
      recorder.find({
        ruleId: 'LOUPE-INTERNAL',
        severity: 'error',
        audience: 'nobody',
        title: 'Loupe itself hit an unexpected error.',
        detail: `This is a defect in the tool, not in the link: ${
          error instanceof Error ? error.message : String(error)
        }. The trace above is still accurate up to the step that failed.`,
      });
    }
  }

  const outcome = decideOutcome(recorder.snapshot(), files);
  const run = recorder.finish(outcome);
  return {
    run,
    ...(link === undefined ? {} : { link }),
    files,
    outcome,
    redactor: recorder.redactor,
  };
}

function decideOutcome(run: TraceRun, files: OpenedFile[]): RunOutcome {
  const opened = files.filter((f) => f.content !== undefined).length;
  if (opened > 0) return opened === files.length ? 'opened' : 'partial';
  if (run.findings.some((f) => f.severity === 'fatal')) {
    // "Blocked" means we knew, and did not waste a request finding out.
    return run.networkUsed ? 'failed' : 'blocked';
  }
  return 'failed';
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

interface ManifestEntry {
  contentType?: string;
  embedded?: string;
  location?: string;
  lastUpdated?: string;
}

async function fetchManifest(
  recorder: Recorder,
  transport: Transport,
  link: ShlLink,
  url: URL,
  options: PipelineOptions,
): Promise<unknown> {
  const body = manifestBody({
    url: link.url,
    recipient: options.recipient,
    ...(options.passcode === undefined ? {} : { passcode: options.passcode }),
    ...(options.embeddedLengthMax === undefined
      ? {}
      : { embeddedLengthMax: options.embeddedLengthMax }),
  });
  if (options.passcode !== undefined) recorder.redactor.register(options.passcode, 'passcode');

  return recorder.run(
    {
      kind: 'net.manifest',
      title: 'Request the manifest',
      summary: 'POST with content-type application/json, which always triggers a CORS preflight.',
    },
    async (step) => {
      if (link.flags.includes('P') && options.passcode === undefined) {
        step.find({
          ruleId: 'SHL-PASSCODE-REQUIRED',
          severity: 'info',
          audience: 'you',
          title: 'A passcode is needed before this request can be made.',
          detail:
            'The link carries the P flag, so the server will reject a request without one. Loupe stops here rather than spending an attempt: every wrong passcode counts against a lifetime limit that permanently disables the link, so it never guesses and never retries on your behalf.',
          citation: CITATIONS.flagP,
        });
        throw new StepFailure('Passcode required', 'blocked');
      }

      const request = {
        method: 'POST' as const,
        url: link.url,
        headers: { 'content-type': 'application/json' },
        body,
        purpose: 'manifest' as const,
      };
      step.request(toRequestRecord(request));
      step.command('Reproduce outside the browser', 'bash', curlForManifest({ url: link.url, recipient: options.recipient }));
      step.command(
        'Check the preflight the browser sends first',
        'bash',
        curlForPreflight(link.url, options.viewer.origin),
      );
      recorder.markNetworkUsed();

      try {
        const response = await transport.send(request);
        step.response(toResponseRecord(response));
        step.note(readableHeaderNote(url.origin === options.viewer.origin));

        if (response.redirected) {
          step.find({
            ruleId: 'SHL-MANIFEST-REDIRECTED',
            severity: 'info',
            audience: 'server',
            title: 'The manifest request was redirected.',
            detail: `The response came from ${response.finalUrl}. A browser follows redirects transparently and does not expose the intermediate hops to script, so Loupe can tell you that at least one redirect happened and where you ended up, but not the chain. The curl command above, with -L -D -, prints every hop.`,
          });
        }

        interpretManifestStatus(step, response.status, response.body, link, response.headers);

        const contentType = response.headers['content-type'] ?? '';
        if (response.ok && contentType !== '' && !contentType.includes('json')) {
          step.find({
            ruleId: 'SHL-MANIFEST-NOT-JSON',
            severity: 'error',
            audience: 'server',
            title: `The manifest came back as ${contentType}, not JSON.`,
            detail:
              'A 200 with an HTML content type is almost always a framework error page, a login redirect landing page, or a single-page app fallback serving index.html for an unmatched route. The status says success and the body is not a manifest.',
            citation: CITATIONS.manifestResponse,
          });
        }

        try {
          const parsed: unknown = JSON.parse(response.body);
          step.json('Manifest', parsed);
          return parsed;
        } catch {
          step.text('Body, verbatim', response.body.slice(0, 4000));
          step.find({
            ruleId: 'SHL-MANIFEST-UNPARSEABLE',
            severity: 'fatal',
            audience: 'server',
            title: 'The manifest response is not JSON.',
            detail: `The server returned ${response.status} with ${formatBytes(response.bodyBytes)} that does not parse as JSON. The body is shown above exactly as received.`,
            citation: CITATIONS.manifestResponse,
          });
          throw new StepFailure('Manifest not JSON');
        }
      } catch (error) {
        if (error instanceof StepFailure) throw error;
        if (error instanceof NetworkFailure) {
          await recordNetworkFailure(recorder, transport, step, error, link, url, options);
          throw new StepFailure(error.message);
        }
        throw error;
      }
    },
  );
}

/**
 * The two statuses the specification defines, and honest handling of everything
 * else. A 404 here is deliberately ambiguous: expired, revoked, exhausted,
 * mistyped and never-existed all look identical, because a response that
 * distinguished them would be an oracle for which links exist.
 */
function interpretManifestStatus(
  step: StepHandle,
  status: number,
  body: string,
  link: ShlLink,
  headers: Record<string, string>,
): void {
  if (status === 200) return;

  if (status === 401) {
    let remaining: unknown;
    try {
      remaining = (JSON.parse(body) as { remainingAttempts?: unknown }).remainingAttempts;
    } catch {
      remaining = undefined;
    }
    const count = typeof remaining === 'number' ? remaining : undefined;
    step.find({
      ruleId: 'SHL-PASSCODE-WRONG',
      severity: 'error',
      audience: 'you',
      title:
        count === undefined
          ? 'The passcode was rejected.'
          : count === 0
            ? 'The passcode was rejected, and that was the last attempt.'
            : `The passcode was rejected. ${count} attempt${count === 1 ? '' : 's'} remain.`,
      detail:
        count === 0
          ? 'The server counts wrong passcodes against a lifetime limit to stop an exhaustive search. That limit is now reached, so this link is permanently disabled and further requests will return 404. Ask the sender for a new one.'
          : 'The server counts wrong passcodes against a lifetime limit that permanently disables the link. Loupe will not retry on its own, and neither should you guess.',
      remedy: 'Get the passcode from the person who shared the link, through a separate channel.',
      citation: CITATIONS.passcodeFailure,
    });
    if (count === undefined) {
      step.find({
        ruleId: 'SHL-PASSCODE-NO-REMAINING',
        severity: 'warning',
        audience: 'server',
        title: 'The 401 body did not carry remainingAttempts.',
        detail:
          'The specification requires the invalid-passcode response body to be JSON with a remainingAttempts member, so a receiver can warn before the last try. The exact member name matters: attemptsRemaining and remaining_attempts are read by nothing.',
        citation: CITATIONS.passcodeFailure,
      });
    }
    throw new StepFailure('Passcode rejected');
  }

  if (status === 404) {
    step.find({
      ruleId: 'SHL-MANIFEST-404',
      severity: 'fatal',
      audience: 'sender',
      title: 'The server says this link is not active.',
      detail: `A 404 is the one answer the specification defines for "no longer active", and it covers expired, revoked, disabled after too many wrong passcodes, mistyped, and never existed. The server will not say which, on purpose: an answer that distinguished them would tell an attacker which links exist. ${
        link.exp === undefined
          ? 'The payload carries no exp, so there is no local evidence either way.'
          : `The payload's own exp is ${new Date(link.exp * 1000).toISOString()}, which is the only local evidence available.`
      }`,
      remedy: 'Ask the sender to confirm the link is still live and to re-issue it if not.',
      citation: CITATIONS.manifestResponse,
    });
    throw new StepFailure('Link not active');
  }

  if (status === 429) {
    const retryAfter = headers['retry-after'];
    step.find({
      ruleId: 'SHL-MANIFEST-429',
      severity: 'error',
      audience: 'you',
      title: 'The server is rate limiting manifest requests.',
      detail: `429 with${retryAfter === undefined ? 'out a' : ' a'} Retry-After header${
        retryAfter === undefined ? '' : ` of ${retryAfter}`
      }. The specification allows this and requires a client to wait at least that long before asking again. Note that repeated re-opens of the same link, or a component that fires its request twice, is the usual local cause.`,
      remedy:
        retryAfter === undefined ? 'Wait a minute and try again.' : `Wait ${retryAfter} seconds.`,
      citation: CITATIONS.rateLimit,
    });
    throw new StepFailure('Rate limited');
  }

  step.find({
    ruleId: 'SHL-MANIFEST-UNEXPECTED-STATUS',
    severity: 'fatal',
    audience: 'server',
    title: `The server answered ${status}, which the specification does not define here.`,
    detail: `Only 401 (bad passcode), 404 (not active) and 429 (rate limited) are defined for a manifest request. A ${status} is the server's own choice, so its body is the only guide, and it is shown verbatim in this step. A 405 usually means the endpoint accepts GET but not POST; a 400 usually means the request body was not what it expected.`,
    citation: CITATIONS.manifestResponse,
  });
  throw new StepFailure(`Unexpected status ${status}`);
}

/**
 * Turn an opaque failure into a ranked differential, running the opt-in probes
 * first when they were asked for.
 *
 * The probes are the difference between reasoning about the URL and having
 * evidence: a plain GET that succeeds where the real request failed is what
 * makes "reachable, but not sending CORS headers" a conclusion rather than a
 * guess. They are opt-in because one of them issues an extra request to somebody
 * else's server and the other discloses the host name to a public resolver, and
 * this tool does not make a request its user did not ask for.
 */
async function recordNetworkFailure(
  recorder: Recorder,
  transport: Transport,
  step: StepHandle,
  failure: NetworkFailure,
  link: ShlLink,
  url: URL,
  options: PipelineOptions,
): Promise<void> {
  step.response(failureToResponseRecord(failure));
  const engine = describeFetchEngine(failure.browserMessage ?? '');
  const probes: ProbeResults = { failureDurationMs: failure.durationMs };

  const online = onlineHint();
  probes.online = online.online;
  if (!online.online) step.note(online.interpretation);

  // Chromium refuses a public page's request to a loopback or private address
  // outright, and delivers that refusal as a CORS policy error. Anyone reading
  // the console for the word CORS then goes looking for a server header that
  // cannot help, so this gets said explicitly before anything else.
  if (isLnaGatedTarget(url.hostname) && detectLnaEnforcement() === 'enforced') {
    step.find({
      ruleId: 'NET-LOCAL-NETWORK-ACCESS',
      severity: 'fatal',
      audience: 'sender',
      title: 'This browser blocked the request under its local network policy, before it left.',
      detail:
        'Since Chrome 142, a page served from a public site may not reach a loopback or private-network address without an explicit permission prompt. The refusal is reported as a CORS error, which is misleading: no header the server sends can lift it, and a no-cors probe does not bypass it either. A link whose delivery depends on a stranger granting a local-network permission is not a shareable link.',
      remedy: 'The link has to be re-issued against a publicly reachable host.',
    });
  }

  if (options.probes?.reachability === true) {
    const reachability = await recorder.run(
      {
        kind: 'net.reachability',
        title: 'Probe whether anything is answering',
        summary: 'A plain GET, which needs no CORS, to tell a silent server from an unreachable one.',
        parentId: step.id,
      },
      async (probeStep) => {
        const result = await probeReachability(transport, link.url);
        probeStep.kv([
          { key: 'verdict', value: result.verdict },
          { key: 'took', value: `${result.durationMs} ms (${result.band})` },
        ]);
        probeStep.note(result.interpretation);
        const combined = combineProbePair(result.verdict, true);
        probeStep.note(combined.conclusion);
        if (result.verdict === 'nothing-answered') probeStep.end('warn');
        return result;
      },
    );
    probes.opaqueGetSucceeded = reachability.verdict === 'server-answered';
  } else {
    step.note(
      `${describeTimingBand(timingBand(failure.durationMs))} Turning on the reachability probe in settings would settle this: a plain GET needs no CORS, so if it succeeds where this request failed, the server is up and simply not sending the headers a browser needs.`,
    );
  }

  if (options.probes?.dns === true) {
    const dns = await recorder.run(
      {
        kind: 'net.reachability',
        title: 'Look the host name up',
        summary: 'A DNS-over-HTTPS query, which discloses the host name to a public resolver.',
        parentId: step.id,
      },
      async (probeStep) => {
        const result = await probeDns(transport, url.hostname);
        probeStep.kv([
          { key: 'resolver', value: result.resolver },
          { key: 'DNS status', value: result.status === undefined ? 'no answer' : String(result.status) },
          { key: 'addresses', value: result.addresses?.join(', ') ?? 'none' },
        ]);
        probeStep.note(result.interpretation);
        if (!result.resolved) probeStep.end('warn');
        return result;
      },
    );
    probes.dns = {
      resolved: dns.resolved,
      ...(dns.addresses === undefined ? {} : { addresses: dns.addresses }),
      ...(dns.status === undefined ? {} : { status: dns.status }),
    };
  }

  const causes = differentialFor(
    { url, rawUrl: link.url, link, viewer: options.viewer, now: Date.now() },
    probes,
  );
  step.note(differentialPreamble(failure.browserMessage, engine));
  step.kv(
    causes.map((cause) => ({
      key: `${cause.likelihood}%`,
      value: cause.title,
      mono: false,
      note: `${cause.reasoning} Test: ${cause.discriminator}`,
    })),
  );
  const top = causes[0];
  step.find({
    ruleId: `NET-${(top?.id ?? 'unknown').toUpperCase()}`,
    severity: 'fatal',
    audience: top?.owner === 'network' ? 'you' : (top?.owner ?? 'server'),
    title: top?.title ?? 'The request could not be completed.',
    detail: `${differentialPreamble(failure.browserMessage, engine)} ${top?.reasoning ?? ''}`,
    ...(top?.discriminator === undefined ? {} : { remedy: top.discriminator }),
    citation: CITATIONS.corsProtocol,
  });
  if (top?.id === 'cors-missing' || top?.id === 'cors-preflight-unimplemented') {
    step.kv(
      corsRequirementsFor(options.viewer.origin).map((row) => ({
        key: row.header,
        value: row.value,
      })),
    );
  }
}

async function validateManifest(
  recorder: Recorder,
  manifest: unknown,
  link: ShlLink,
  embeddedLengthMax: number | undefined,
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

      if (typeof record.status === 'string') {
        const known = MANIFEST_STATUSES.includes(record.status);
        step.kv([
          {
            key: 'status',
            value: record.status,
            status: known ? 'ok' : 'warn',
            ...(known ? {} : { note: `Not one of ${MANIFEST_STATUSES.join(', ')}.` }),
          },
        ]);
        if (record.status === 'no-longer-valid') {
          step.find({
            ruleId: 'SHL-MANIFEST-NO-LONGER-VALID',
            severity: 'warning',
            audience: 'sender',
            title: 'The server says this link is no longer valid.',
            detail:
              'It answered the request and returned a manifest, but marked its status "no-longer-valid". Any content below is historical: treat it as stale rather than current.',
            citation: CITATIONS.manifestResponse,
          });
        }
        if (record.status === 'can-change') {
          step.note(
            'status is "can-change", so the manifest content may differ on a later request. That is what the L flag anticipates.',
          );
        }
      }

      if (record.list !== undefined) {
        step.json('list (the manifest extension point)', record.list, true);
        step.note(
          'The manifest carries a `list`, which is where the specification puts extensions relating to the manifest or to individual files, as a FHIR List with standard FHIR extensions. A client is required to ignore extensions it does not understand, so Loupe shows it and moves on rather than guessing at its meaning.',
        );
      }

      const rawFiles = record.files;
      if (!Array.isArray(rawFiles)) {
        step.find({
          ruleId: 'SHL-MANIFEST-NO-FILES',
          severity: 'fatal',
          audience: 'server',
          title: 'The manifest has no files array.',
          detail: `The response parsed as JSON but carries ${
            Object.keys(record).length === 0
              ? 'no members at all'
              : `only ${Object.keys(record).join(', ')}`
          }. A manifest's files array is what a receiver reads.`,
          citation: CITATIONS.manifestFiles,
        });
        throw new StepFailure('No files array');
      }
      if (rawFiles.length === 0) {
        step.find({
          ruleId: 'SHL-MANIFEST-EMPTY',
          severity: 'error',
          audience: 'sender',
          title: 'The manifest is valid and contains nothing.',
          detail:
            'files is an empty array. The prose table permits that (0..*) while the logical model requires at least one (1..*), so it is legal by one reading and not the other. Either way there is nothing to show, and the usual cause is a share that was created before its content was attached.',
          citation: CITATIONS.manifestFiles,
        });
        throw new StepFailure('Manifest empty', 'blocked');
      }

      const entries: ManifestEntry[] = [];
      const rows = [];
      for (const [index, raw] of rawFiles.entries()) {
        const entry = (typeof raw === 'object' && raw !== null ? raw : {}) as ManifestEntry;
        entries.push(entry);
        const both = entry.embedded !== undefined && entry.location !== undefined;
        const neither = entry.embedded === undefined && entry.location === undefined;
        const known =
          entry.contentType === undefined
            ? false
            : SHL_CONTENT_TYPES.some((t) => entry.contentType?.startsWith(t) === true);
        rows.push({
          key: `files[${index}]`,
          value: [
            entry.contentType ?? 'no contentType',
            entry.embedded === undefined
              ? undefined
              : `embedded (${formatBytes(entry.embedded.length)})`,
            entry.location === undefined ? undefined : `location ${new URL(entry.location, link.url).origin}`,
            entry.lastUpdated === undefined ? undefined : `updated ${entry.lastUpdated}`,
          ]
            .filter(Boolean)
            .join(' · '),
          status: neither ? ('fail' as const) : known ? ('ok' as const) : ('warn' as const),
          ...(neither
            ? { note: 'Neither embedded nor location, so there is nothing to fetch.' }
            : both
              ? {
                  note: 'Both embedded and location are present, which is legal. They must decrypt to identical plaintext, though the two ciphertexts differ because each encryption uses a fresh IV.',
                }
              : known
                ? {}
                : {
                    note:
                      entry.contentType === undefined
                        ? 'contentType is required on every file entry.'
                        : `Not one of the three defined content types. Loupe will sniff the decrypted plaintext instead.`,
                  }),
        });
      }
      step.kv(rows);
      step.cite(CITATIONS.manifestFiles);

      if (embeddedLengthMax !== undefined) {
        const oversize = entries
          .map((entry, index) => ({ index, length: entry.embedded?.length ?? 0 }))
          .filter((entry) => entry.length > embeddedLengthMax);
        if (oversize.length > 0) {
          step.find({
            ruleId: 'SHL-EMBEDDED-LENGTH-MAX-IGNORED',
            severity: 'warning',
            audience: 'server',
            title: 'The server embedded a file larger than the maximum this client asked for.',
            detail: `The request set embeddedLengthMax to ${formatBytes(embeddedLengthMax)}, and ${oversize
              .map((entry) => `files[${entry.index}] is ${formatBytes(entry.length)}`)
              .join(', ')}. The specification says a server shall not return an embedded payload longer than the client's stated maximum, and is expected to serve a location instead. Nothing breaks here, since Loupe reads it anyway, but a client that sized a buffer from that number would.`,
            citation: CITATIONS.manifestRequest,
          });
          step.end('warn');
        }
        const locationsOnly = entries.filter(
          (entry) => entry.embedded === undefined && entry.location !== undefined,
        ).length;
        if (locationsOnly > 0) {
          step.note(
            `${locationsOnly} of ${entries.length} file${entries.length === 1 ? '' : 's'} came as a location rather than embedded, despite this client offering to accept up to ${formatBytes(embeddedLengthMax)} inline. That is legal, and it costs a browser a second cross-origin hop whose CORS configuration, TLS chain and DNS all have to work as well, so it is the more fragile of the two shapes at an event.`,
          );
        }
      }

      for (const [index, entry] of entries.entries()) {
        if (entry.contentType?.startsWith('application/fhir+json') === true) {
          if (!entry.contentType.includes('fhirVersion')) {
            step.note(
              `files[${index}] does not state a fhirVersion parameter. Servers should send one, for example application/fhir+json;fhirVersion=4.0.1; a receiver may assume 4.0.1 when it is absent.`,
            );
          }
        }
      }
      return entries;
    },
  );
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

async function fetchDirectFile(
  recorder: Recorder,
  transport: Transport,
  link: ShlLink,
  url: URL,
  options: PipelineOptions,
): Promise<string> {
  return recorder.run(
    {
      kind: 'net.direct',
      title: 'Fetch the file directly',
      summary: 'The U flag means one file by GET, and no manifest request at all.',
    },
    async (step) => {
      const target = new URL(link.url);
      target.searchParams.set('recipient', options.recipient);
      const request = { method: 'GET' as const, url: target.toString(), purpose: 'direct-file' as const };
      step.request(toRequestRecord(request));
      step.command('Reproduce outside the browser', 'bash', curlForDirectFile(target.toString()));
      step.note(
        'With the U flag the recipient string goes in the query, not a JSON body, so unlike the payload it does reach the server logs. That is by design: it is what tells the person sharing who opened their link.',
      );
      step.cite(CITATIONS.directFile);
      recorder.markNetworkUsed();
      try {
        const response = await transport.send(request);
        step.response(toResponseRecord(response));
        if (!response.ok) {
          step.find({
            ruleId: 'SHL-DIRECT-FILE-STATUS',
            severity: 'fatal',
            audience: 'server',
            title: `The file request returned ${response.status}.`,
            detail:
              response.status === 404
                ? 'A 404 on a direct link means the file is gone, the link expired, or the URL never existed. As with a manifest 404, the server does not distinguish.'
                : 'The body is recorded above exactly as received.',
          });
          throw new StepFailure(`Direct file ${response.status}`);
        }
        const contentType = response.headers['content-type'];
        if (contentType !== undefined && !contentType.includes('jose')) {
          step.note(
            `The response content type is ${contentType}. The specification does not pin one for a direct file (the IG's own example is served as text/plain), so this is information, not a defect: never gate on it.`,
          );
        }
        return response.body.trim();
      } catch (error) {
        if (error instanceof StepFailure) throw error;
        if (error instanceof NetworkFailure) {
          await recordNetworkFailure(recorder, transport, step, error, link, url, options);
          throw new StepFailure(error.message);
        }
        throw error;
      }
    },
  );
}

async function openManifestFile(
  recorder: Recorder,
  transport: Transport,
  link: ShlLink,
  entry: ManifestEntry,
  index: number,
  manifestAt: number,
  options: PipelineOptions,
): Promise<OpenedFile> {
  if (entry.embedded !== undefined) {
    return openFile(recorder, entry.embedded, link, 'embedded', entry, options, index);
  }
  if (entry.location === undefined) {
    return {
      index,
      source: 'location',
      ...(entry.contentType === undefined ? {} : { declaredContentType: entry.contentType }),
      kind: 'unknown',
      compressed: false,
      failure: { message: 'The manifest entry has neither embedded content nor a location.' },
    };
  }

  const location = entry.location;
  let jwe: string;
  try {
    jwe = await recorder.run(
      {
        kind: 'net.file',
        title: `Fetch file ${index + 1} from its location`,
        summary: 'A location URL is short lived and may be single use.',
      },
      async (step) => {
        const locationUrl = new URL(location, link.url);
        const age = Date.now() - manifestAt;
        step.kv([
          { key: 'origin', value: locationUrl.origin },
          { key: 'manifest age', value: `${Math.round(age / 1000)} s` },
        ]);
        if (locationUrl.origin !== new URL(link.url).origin) {
          step.note(
            `This file is on a different origin (${locationUrl.origin}) from the manifest. That is normal, since presigned bucket URLs are what the specification suggests, and it means a second origin's CORS configuration, TLS chain and DNS all have to work too.`,
          );
        }
        if (age > LOCATION_LIFETIME_MS) {
          step.find({
            ruleId: 'SHL-LOCATION-STALE',
            severity: 'error',
            audience: 'you',
            title: 'This location URL is older than an hour, so it must not be used.',
            detail:
              'A receiver is required not to dereference a location more than one hour after requesting the manifest, and to re-request the manifest for fresh links instead. Loupe stops rather than sending a request that would fail confusingly.',
            remedy: 'Re-run the link, which fetches a new manifest and new location URLs.',
            citation: CITATIONS.manifestFiles,
          });
          throw new StepFailure('Location stale', 'blocked');
        }
        const request = {
          method: 'GET' as const,
          url: locationUrl.toString(),
          purpose: 'manifest-file' as const,
        };
        step.request(toRequestRecord(request));
        step.command('Reproduce outside the browser', 'bash', curlForDirectFile(locationUrl.toString()));
        recorder.markNetworkUsed();
        const response = await transport.send(request);
        step.response(toResponseRecord(response));
        if (!response.ok) {
          step.find({
            ruleId: 'SHL-LOCATION-STATUS',
            severity: 'error',
            audience: 'server',
            title: `The file location returned ${response.status}.`,
            detail:
              response.status === 403 || response.status === 404
                ? 'A location URL may be one-time use, and it expires within the hour. A 403 or 404 here most often means it was already consumed, by a retry, by a component fetching twice, or by another viewer. Re-request the manifest to get a fresh one rather than retrying this URL.'
                : 'The response is recorded above. Note that this hop is the one most viewers do not status-check at all: they hand an HTML error page to the decrypter and then report a JOSE parse error, which sends the reader looking at their encryption.',
            citation: CITATIONS.manifestFiles,
          });
          throw new StepFailure(`Location ${response.status}`);
        }
        return response.body.trim();
      },
    );
  } catch (error) {
    return {
      index,
      source: 'location',
      ...(entry.contentType === undefined ? {} : { declaredContentType: entry.contentType }),
      kind: 'unknown',
      compressed: false,
      failure: { message: error instanceof Error ? error.message : String(error) },
    };
  }
  return openFile(recorder, jwe, link, 'location', entry, options, index);
}

/** Decrypt one file, inflate it if needed, and work out what it is. */
async function openFile(
  recorder: Recorder,
  jwe: string,
  link: ShlLink,
  source: OpenedFile['source'],
  entry: ManifestEntry | undefined,
  _options: PipelineOptions,
  index = 0,
): Promise<OpenedFile> {
  const base: OpenedFile = {
    index,
    source,
    ...(entry?.contentType === undefined ? {} : { declaredContentType: entry.contentType }),
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
          { key: 'alg', value: String(parts.header.alg), status: parts.header.alg === 'dir' ? 'ok' : 'fail' },
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
            key: 'cty',
            value: parts.header.cty === undefined ? '(absent)' : String(parts.header.cty),
            status: 'ok',
            ...(parts.header.cty === undefined
              ? {
                  note: 'The prose asks for a cty header, and in practice almost nothing sends one, including the IG\'s own examples. Loupe resolves the content type from the manifest first, then cty, then by sniffing the plaintext.',
                }
              : {}),
          },
          { key: 'encrypted key', value: parts.encryptedKeyB64 === '' ? '(empty, correct for alg=dir)' : `${parts.encryptedKeyB64.length} characters`, status: parts.encryptedKeyB64 === '' ? 'ok' : 'fail' },
          {
            key: 'iv',
            value: `${iv.byteLength} bytes`,
            status: iv.byteLength === 12 ? 'ok' : 'fail',
            ...(describeIvLength(iv.byteLength) === undefined
              ? {}
              : { note: describeIvLength(iv.byteLength) as string }),
          },
          { key: 'ciphertext', value: formatBytes(ciphertext.byteLength) },
          { key: 'tag', value: `${tag.byteLength} bytes`, status: tag.byteLength === 16 ? 'ok' : 'fail' },
        ]);
        step.cite(CITATIONS.jweCompact);

        // The single most useful check in the tool: when a kid is present it is
        // the RFC 7638 thumbprint of the link's own key, so a key mismatch can
        // be PROVEN rather than inferred from an opaque tag failure.
        const match = await matchKeyToJweKid(parts.header, link.key);
        if (match.verdict === 'mismatch') {
          step.find({
            ruleId: 'SHL-KEY-MISMATCH',
            severity: 'fatal',
            audience: 'sender',
            title: 'This file was encrypted with a different key than the link carries.',
            detail: `The header names key ${match.kid}, and the key in this link is ${match.expected}. Those are RFC 7638 thumbprints, so this is proof rather than inference: decryption cannot succeed. The usual cause is a link re-minted against a rotated key, or a link and a file from two different shares.`,
            remedy: 'Ask the sender for the link that goes with this file.',
            citation: CITATIONS.shcKid,
          });
          throw new StepFailure('Key mismatch');
        }
        if (match.verdict === 'match') {
          step.note(
            `The header's kid matches this link's key (RFC 7638 thumbprint ${match.kid}), so if decryption fails below, the cause is the bytes and not the key.`,
          );
        }
        return parts.header;
      },
    );
  } catch (error) {
    return {
      ...base,
      failure: {
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof JoseError && error.hint !== undefined ? { hint: error.hint } : {}),
      },
    };
  }

  let plainBytes: Uint8Array;
  try {
    plainBytes = await recorder.run(
      {
        kind: 'jwe.decrypt',
        title: `Decrypt file ${index + 1}`,
        summary: 'AES-256-GCM with the key from the link. Nothing leaves this tab.',
      },
      async (step) => {
        const result = await decryptDirA256Gcm(jwe, base64urlToBytes(link.key));
        step.kv([
          { key: 'plaintext', value: formatBytes(result.sizes.plaintext) },
          { key: 'expansion', value: `${result.sizes.ciphertext - result.sizes.plaintext} bytes of overhead` },
        ]);
        step.cite(CITATIONS.encryption);
        return result.plaintext;
      },
    );
  } catch (error) {
    const hint = error instanceof JoseError ? error.hint : undefined;
    recorder.find({
      ruleId: 'SHL-DECRYPT-FAILED',
      severity: 'fatal',
      audience: 'sender',
      title: `File ${index + 1} could not be decrypted.`,
      detail: `${error instanceof Error ? error.message : String(error)} ${hint ?? ''}`.trim(),
      citation: CITATIONS.encryption,
    });
    return {
      ...base,
      jweHeader: header,
      failure: {
        message: error instanceof Error ? error.message : String(error),
        ...(hint === undefined ? {} : { hint }),
      },
    };
  }

  let compressed = false;
  if (header.zip === 'DEF') {
    try {
      plainBytes = await recorder.run(
        {
          kind: 'payload.inflate',
          title: `Decompress file ${index + 1}`,
          summary: 'zip=DEF means raw DEFLATE, with no zlib or gzip framing.',
        },
        (step) => {
          const result = inflateForgiving(plainBytes);
          step.kv([
            { key: 'framing', value: result.framing },
            { key: 'inflated', value: formatBytes(result.bytes.byteLength) },
            {
              key: 'ratio',
              value: `${(result.bytes.byteLength / Math.max(1, plainBytes.byteLength)).toFixed(1)}x`,
            },
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
          step.note(
            'Worth knowing: several widely used JOSE libraries dropped JWE zip support entirely, and current ones cap the decompressed size (jose defaults to 250 kB). A compressed summary above that cap fails in a receiver that just calls compactDecrypt, so senders after maximum compatibility send payloads uncompressed.',
          );
          return result.bytes;
        },
      );
      compressed = true;
    } catch (error) {
      return {
        ...base,
        jweHeader: header,
        failure: { message: error instanceof Error ? error.message : String(error) },
      };
    }
  }

  return recorder.run(
    {
      kind: 'payload.classify',
      title: `Identify what file ${index + 1} contains`,
      summary: 'Manifest contentType first, then the JWE cty, then the plaintext itself.',
    },
    (step) => {
      const text = utf8Decode(plainBytes);
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        step.text('Plaintext, verbatim', text.slice(0, 2000));
        step.find({
          ruleId: 'SHL-PLAINTEXT-NOT-JSON',
          severity: 'error',
          audience: 'sender',
          title: `File ${index + 1} decrypted, but its contents are not JSON.`,
          detail:
            'Decryption succeeded, so the key and the ciphertext are both fine. What came out is not JSON, which points at the file that was encrypted rather than at the encryption.',
        });
        step.end('warn');
        return {
          ...base,
          jweHeader: header,
          compressed,
          plaintext: text,
          bytes: plainBytes.byteLength,
          failure: { message: 'Decrypted content is not JSON.' },
        };
      }

      const kind = classifyContent(parsed, entry?.contentType, header.cty);
      step.kv([
        { key: 'declared by manifest', value: entry?.contentType ?? '(none)' },
        { key: 'declared by cty', value: header.cty === undefined ? '(none)' : String(header.cty) },
        { key: 'identified as', value: kind, status: kind === 'unknown' ? 'warn' : 'ok' },
        { key: 'size', value: formatBytes(plainBytes.byteLength) },
      ]);
      if (
        entry?.contentType !== undefined &&
        !entry.contentType.startsWith(contentTypeFor(kind)) &&
        kind !== 'unknown'
      ) {
        step.find({
          ruleId: 'SHL-CONTENT-TYPE-MISMATCH',
          severity: 'warning',
          audience: 'server',
          title: 'The manifest describes this file as something other than what it is.',
          detail: `The manifest says ${entry.contentType}, and the decrypted content is ${kind}. Loupe goes by the content, since that is what a renderer has to work with, but a receiver that trusts the manifest and filters on content type will skip this file entirely.`,
          citation: CITATIONS.manifestFiles,
        });
        step.end('warn');
      }
      return {
        ...base,
        jweHeader: header,
        kind,
        content: parsed,
        plaintext: text,
        compressed,
        bytes: plainBytes.byteLength,
      };
    },
  );
}

function contentTypeFor(kind: FileKind): string {
  switch (kind) {
    case 'smart-health-card':
      return 'application/smart-health-card';
    case 'fhir':
      return 'application/fhir+json';
    case 'smart-api-access':
      return 'application/smart-api-access';
    default:
      return 'application/octet-stream';
  }
}

/**
 * Work out what a decrypted file is.
 *
 * Content sniffing beats the declared type on purpose: `cty` is absent from
 * almost every real file including the IG's own examples, a direct (U flag)
 * link has no manifest to declare anything, and a manifest that mislabels a
 * file is a real and observed condition. The declared types are still recorded,
 * and a disagreement is reported rather than silently resolved.
 */
export function classifyContent(
  value: unknown,
  declared?: string,
  cty?: unknown,
): FileKind {
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    if (Array.isArray(record.verifiableCredential)) return 'smart-health-card';
    if (typeof record.resourceType === 'string') return 'fhir';
    if (typeof record.access_token === 'string' || typeof record.aud === 'string')
      return 'smart-api-access';
  }
  const hint = declared ?? (typeof cty === 'string' ? cty : undefined);
  if (hint?.startsWith('application/smart-health-card') === true) return 'smart-health-card';
  if (hint?.startsWith('application/fhir+json') === true) return 'fhir';
  if (hint?.startsWith('application/smart-api-access') === true) return 'smart-api-access';
  return 'unknown';
}
