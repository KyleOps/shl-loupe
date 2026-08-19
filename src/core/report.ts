/**
 * The two artefacts a person actually sends after a link fails.
 *
 * A trace on screen ends an argument for the one engineer looking at it. What
 * ends it for everybody else is a paste into Zulip or an email, so this module
 * treats the export as a product surface rather than a debug dump. Two things
 * come out of here, and they are different in kind on purpose:
 *
 *  - {@link buildDiagnosisReport} is evidence: verdict, URL, payload, every hop
 *    with its timing, every finding with its rule id and its audience, and the
 *    commands to reproduce it outside a browser. It is written for a channel
 *    where other implementers will read it and argue with it.
 *  - {@link buildSenderExplanation} is a message to one person, in second
 *    person, with no rule ids and no trace in it. At an event the blocker is
 *    rarely knowledge, it is that nobody wants to tell a colleague their link is
 *    broken. Writing that message for them is the feature.
 *
 * Both go through {@link redactRun} first. The run itself holds the real key,
 * because it is the user's own key on the user's own screen; nothing that leaves
 * the tab may carry it, and this is one of the two places that boundary exists.
 */
import { curlForManifest } from './net/curl';
import {
  redactRun,
  worstSeverity,
  type Audience,
  type Evidence,
  type Finding,
  type Redactor,
  type Severity,
  type StepStatus,
  type TraceRun,
  type TraceStep,
} from './trace';

const TOOL_LINE =
  'Produced by Loupe, a SMART Health Link debugger that runs entirely in one browser tab.';

/** Recipient used only in a synthesised command, so it is obviously a stand-in. */
const REPORT_RECIPIENT = 'Loupe (manual check)';

export interface ReportOptions {
  format?: 'markdown' | 'json';
}

// ---------------------------------------------------------------------------
// The pasteable diagnosis
// ---------------------------------------------------------------------------

export function buildDiagnosisReport(
  run: TraceRun,
  redactor: Redactor | undefined,
  options: ReportOptions = {},
): string {
  const safe = redactor === undefined ? run : redactRun(run, redactor);
  if (options.format === 'json') {
    return `${JSON.stringify(
      { tool: 'Loupe', reportVersion: 1, secrets: secretState(redactor), run: safe },
      null,
      2,
    )}\n`;
  }
  return markdownReport(safe, redactor);
}

type SecretState = 'removed' | 'none-registered' | 'unchecked';

function secretState(redactor: Redactor | undefined): SecretState {
  if (redactor === undefined) return 'unchecked';
  return redactor.isActive ? 'removed' : 'none-registered';
}

/**
 * The redaction sentence is the first line of the report, not a footnote.
 *
 * The `unchecked` wording is deliberately unhelpful about safety: a caller that
 * passes no registry has not proven anything, and a reassuring sentence there
 * would be the exact failure this module exists to prevent.
 */
function redactionSentence(state: SecretState): string {
  switch (state) {
    case 'removed':
      return 'The decryption key and any passcode in this run were replaced with placeholders before this report was written, so it is safe to paste into a shared channel.';
    case 'none-registered':
      return 'No decryption key or passcode was registered while this run happened, so there was nothing to remove.';
    default:
      return 'This report was written without a secret registry, so read it before pasting it anywhere shared: if the run decoded a link, its decryption key may appear below.';
  }
}

function markdownReport(run: TraceRun, redactor: Redactor | undefined): string {
  const payload = decodedPayload(run);
  const url = typeof payload?.url === 'string' ? payload.url : undefined;
  const label = typeof payload?.label === 'string' ? payload.label : undefined;

  const lines: string[] = [];
  lines.push('# SMART Health Link diagnosis', '');
  lines.push(redactionSentence(secretState(redactor)), '');
  lines.push(`**Verdict:** ${verdictSentence(run)}`);
  if (label !== undefined) lines.push(`**Link label:** ${label}`);
  if (url !== undefined) lines.push(`**Manifest URL:** \`${url}\``);
  lines.push(`**Input:** ${describeInput(run)}`);
  lines.push(`**Requests made:** ${run.networkUsed ? 'yes, listed in the steps below' : 'none'}`);
  lines.push(`**Run at:** ${new Date(run.startedAt).toISOString()}${totalTime(run)}`);
  lines.push('');

  if (payload !== undefined) {
    lines.push('## Payload', '');
    lines.push('```json', JSON.stringify(payload, null, 2), '```', '');
  }

  if (run.steps.length > 0) {
    lines.push('## Steps', '', '| Step | Result | Time |', '| --- | --- | --- |');
    for (const step of orderedSteps(run.steps)) {
      lines.push(
        `| ${step.depth > 0 ? '&nbsp;&nbsp;' : ''}${escapeCell(step.step.title)} | ${statusWord(
          step.step.status,
        )} | ${step.step.durationMs === undefined ? '' : `${step.step.durationMs} ms`} |`,
      );
    }
    lines.push('');
  }

  if (run.findings.length > 0) {
    lines.push('## Findings', '');
    for (const [index, finding] of run.findings.entries()) {
      lines.push(
        `**${index + 1}. ${finding.ruleId} · ${severityWord(finding.severity)} · ${audiencePhrase(
          finding.audience,
        )}**`,
      );
      lines.push('');
      lines.push(finding.title);
      lines.push('');
      lines.push(finding.detail);
      if (finding.remedy !== undefined) lines.push('', `Fix: ${finding.remedy}`);
      if (finding.citation !== undefined) {
        lines.push(
          '',
          `Spec: ${finding.citation.spec}, ${finding.citation.section}. ${finding.citation.url}`,
        );
      }
      lines.push('');
    }
  } else {
    lines.push('## Findings', '', 'Nothing was flagged.', '');
  }

  const commands = reproductionCommands(run, url);
  if (commands.length > 0) {
    lines.push('## Reproduce this outside the browser', '');
    for (const command of commands) {
      lines.push(`${command.label}:`, '', '```bash', command.command, '```', '');
    }
  }

  lines.push('---', TOOL_LINE, '');
  return lines.join('\n');
}

function verdictSentence(run: TraceRun): string {
  const severity = worstSeverity(run.findings);
  switch (run.outcome) {
    case 'opened':
      return severity === 'warning' || severity === 'error'
        ? 'The link opened, and something about it is still worth fixing.'
        : 'The link opened and its contents were readable.';
    case 'partial':
      return 'Some of the files opened and some did not, so the link is partly usable.';
    case 'blocked':
      return 'Blocked before any request. Loupe could tell from the link alone that it cannot work, so it sent nothing.';
    case 'failed':
      return run.networkUsed
        ? 'Failed after a request was made. The step that broke is named below.'
        : 'Failed before a request was made. The step that broke is named below.';
    default:
      return 'Still running, so this report is a snapshot.';
  }
}

function describeInput(run: TraceRun): string {
  const source = run.input.source.replace(/\s+/g, ' ').trim();
  const shortened = source.length > 120 ? `${source.slice(0, 120)}…` : source;
  return `${run.input.kind} · \`${shortened}\``;
}

function totalTime(run: TraceRun): string {
  if (run.finishedAt === undefined) return '';
  return `, ${run.finishedAt - run.startedAt} ms end to end`;
}

// ---------------------------------------------------------------------------
// The message to the sender
// ---------------------------------------------------------------------------

/**
 * A message addressed to whoever minted the link, ready to send as it stands.
 *
 * Three short paragraphs, always in the same order: what happens when someone
 * else opens it, why it worked for them, and the smallest change that fixes it.
 * That order is the point. A message that opens with the mechanism reads as a
 * lecture, and a message that opens with the fix gets argued with.
 */
export function buildSenderExplanation(run: TraceRun): string {
  const payload = decodedPayload(run);
  const url = typeof payload?.url === 'string' ? payload.url : undefined;
  const finding = explanationTarget(run);

  if (finding === undefined) {
    const opened = run.outcome === 'opened' || run.outcome === 'partial';
    return opened
      ? [
          'I opened the link you sent and it worked from here, first go.',
          'Everything decoded: the manifest answered, the file decrypted with the key in the link, and the contents rendered. Nothing at your end needs changing.',
        ].join('\n\n')
      : [
          'I tried the link you sent and I could not get a clear answer out of it, but nothing points at your end specifically.',
          'Nothing was flagged against the link itself, so this may well be my network or my browser rather than your server. Worth one more try from a different connection before either of us changes anything.',
        ].join('\n\n');
  }

  const note = senderNote(finding, url);
  return [
    `I tried opening the SMART Health Link you sent and it does not open from here. ${note.what}`,
    note.why,
    note.fix,
  ].join('\n\n');
}

/**
 * Which finding the message is about.
 *
 * Ordered by who has to act before severity: a fatal note aimed at the server
 * operator is not the thing to tell the sender first if there is also something
 * wrong with the link they minted.
 */
function explanationTarget(run: TraceRun): Finding | undefined {
  const actionable = run.findings.filter((f) => f.severity === 'fatal' || f.severity === 'error');
  const order: Audience[] = ['sender', 'server', 'you', 'nobody'];
  for (const audience of order) {
    const match = actionable.find((f) => f.audience === audience);
    if (match !== undefined) return match;
  }
  return undefined;
}

interface SenderNote {
  what: string;
  why: string;
  fix: string;
}

function senderNote(finding: Finding, url: string | undefined): SenderNote {
  const parsed = safeUrl(url);
  const origin = parsed?.origin ?? url ?? 'the address in the link';
  const host = parsed?.hostname ?? 'that host';
  const port = parsed?.port === undefined || parsed.port === '' ? 'that port' : parsed.port;

  switch (finding.ruleId) {
    case 'SHL-URL-LOOPBACK':
      return {
        what: `The manifest address inside it is ${origin}, which is your own machine.`,
        why: `"localhost" is not a name that travels. In my browser it means my computer, so my browser goes looking for your sharing server on my machine, on port ${port}, where nothing is listening. Even if something were, a dev server's certificate is signed by a root that only exists on your machine, and current Chrome blocks a public page from reaching a loopback address at all. That is why this link opens perfectly for you and for nobody else, and it is not something a viewer can work around.`,
        fix: 'Re-issue the link with a manifest URL I can reach: your deployed environment, or a tunnel in front of your dev server (cloudflared or ngrok) if it only has to last today. If you would rather not stand anything up, run the manifest request yourself and send me the JSON it returns, and I can open the contents without touching your server.',
      };
    case 'SHL-URL-PRIVATE-NETWORK':
      return {
        what: `The manifest address inside it is ${origin}, which is an address on your own network.`,
        why: `${host} is not routable across the internet, so my browser has nowhere to send the request. If I were on your office network or your VPN it would work, which is why it looks fine from where you are sitting.`,
        fix: 'Re-issue the link against a host that is reachable from outside your network, or send me the manifest JSON directly and I will open the contents from that.',
      };
    case 'SHL-URL-UNRESOLVABLE-NAME':
      return {
        what: `The manifest address inside it is ${origin}, and that name does not exist outside your own network.`,
        why: `${host} resolves through something local to you, a Bonjour name, a hosts-file entry or an internal resolver. My machine has no way to look it up, so the request never leaves the browser.`,
        fix: 'Re-issue the link against a name that resolves publicly. If that is a while off, send me the manifest JSON and I can open the contents without resolving anything.',
      };
    case 'SHL-URL-OVERLAY-NETWORK':
      return {
        what: `The manifest address inside it is ${origin}, which lives on an overlay network.`,
        why: `${host} only resolves for machines joined to that network. You are on it, so the link opens for you; I am not, so my browser cannot find the host at all.`,
        fix: 'Publish the manifest on an address reachable from the ordinary internet and re-issue the link, or send me the manifest JSON to open in the meantime.',
      };
    case 'SHL-URL-EPHEMERAL-TUNNEL':
    case 'SHL-URL-PREVIEW-DEPLOYMENT':
      return {
        what: `The manifest address inside it is ${origin}, which is a temporary address.`,
        why: 'A quick tunnel or a preview deployment gets a fresh hostname every time it starts, and the old one stops answering the moment the process ends. It worked when you sent it and the address has almost certainly died since.',
        fix: 'Re-issue the link while the tunnel is up if we are testing right now, or point it at a stable host if this needs to survive the afternoon.',
      };
    case 'SHL-URL-NOT-HTTPS':
      return {
        what: `The manifest address inside it is ${origin}, which is plain http.`,
        why: 'A viewer served over https is not allowed to fetch an http address: the browser blocks it before any request goes out, and it will not tell the page why. On top of that, the specification requires https here, because everything about the share travels over that connection.',
        fix: 'Serve the manifest endpoint over https and re-issue the link.',
      };
    case 'SHL-EXP-PAST':
      return {
        what: 'The link says it expired before I opened it.',
        why: 'The expiry is inside the link itself, so every viewer reads the same value and refuses it. Nothing on your server is wrong; the link simply outlived its own deadline, and the copy you tested was still inside it.',
        fix: 'Re-issue the link with a later expiry, and if these are for a testing session give them a few days rather than a few hours.',
      };
    case 'SHL-EXP-MILLISECONDS':
      return {
        what: 'The expiry in the link is a millisecond timestamp where the specification wants seconds.',
        why: 'Everything that reads it multiplies by a thousand, so the link claims to be valid for tens of thousands of years. Your own code presumably divides it back, which is why nothing looked wrong at your end.',
        fix: 'Divide the expiry by 1000 when you mint the payload, so it is Unix seconds.',
      };
    case 'SHL-CARRIED-IN-QUERY':
      return {
        what: 'The link put its whole payload in the query string of the viewer URL rather than after the "#".',
        why: 'A fragment never reaches a server; a query string does. So the decryption key for this share has already been sent to the viewer host and is sitting in its access logs, its proxy logs and whatever analytics it runs. Anyone with those logs can decrypt the data.',
        fix: 'Distribute it as https://viewer.example.org#shlink:/… and treat this one as compromised: revoke it and issue a new one.',
      };
    case 'SHL-KEY-MISMATCH':
      return {
        what: 'The file behind the link was encrypted with a different key than the link carries.',
        why: 'The encrypted file names the key it was made with, and the fingerprint does not match the key in the payload, so this is not a guess: no viewer can decrypt it. The usual cause is a link re-minted after a key rotation, or a link and a file that came from two different shares.',
        fix: 'Re-mint the link from the same share that produced the file, and send that one.',
      };
    case 'SHL-DECRYPT-FAILED':
      return {
        what: 'The file came back fine and then would not decrypt with the key in the link.',
        why: 'The encryption check failed, which means one of three things and no viewer can tell which: the key does not belong to this file, the bytes changed somewhere between your server and me, or the encrypter computed its authentication tag over something other than the protected header. Your own tooling would round-trip all three of those happily.',
        fix: 'Re-mint the share end to end and send a fresh link. If it fails the same way, encrypt a two-byte test file and send that: it isolates the encrypter from the data.',
      };
    case 'SHL-PAYLOAD-INVALID':
      return {
        what: `The payload inside the link cannot be used as it stands. ${finding.detail}`,
        why: 'This is inside the link text itself, so every viewer reads the same thing and stops in the same place. Your own code presumably fills the missing piece in from context, which is why it opens on your side.',
        fix: 'Fix the payload where it is minted and issue a new link.',
      };
    case 'SHL-MANIFEST-404':
      return {
        what: 'Your server answers, and it says this link is not active.',
        why: 'A 404 there is the one answer the specification defines for "no longer active", and it deliberately covers expired, revoked, disabled after too many wrong passcodes, and never existed. The server will not say which, so I cannot narrow it from out here.',
        fix: 'Check whether the share still exists at your end, and send a new link if it does not.',
      };
    case 'SHL-MANIFEST-EMPTY':
      return {
        what: 'Your server answers with a valid manifest that contains no files.',
        why: 'The link works, the request succeeds, and there is nothing behind it. That usually means the share was created before its content was attached, so a viewer has nothing to show and no way to say why.',
        fix: 'Check that the content is attached to the share before the link goes out, and send a new link once it is.',
      };
    case 'SHL-MANIFEST-UNPARSEABLE':
    case 'SHL-MANIFEST-NOT-JSON':
      return {
        what: 'Your server answers the manifest request with something that is not a manifest.',
        why: 'The status says success and the body is a web page, which is what a framework error page, a login redirect or a single-page-app fallback looks like from out here. A viewer hands that to its decoder and reports a parse error, which sends everyone looking in the wrong place.',
        fix: 'Check what that endpoint returns for a POST with a JSON body from outside your session, and make it answer with the manifest JSON.',
      };
    case 'SHL-ZIP-FRAMING':
      return {
        what: 'The file behind the link is compressed, and not in the framing the specification requires.',
        why: 'JOSE compression means raw DEFLATE with no zlib or gzip header. Your encrypter added one, and a decoder that follows the specification refuses it, so the file opens in the tool that wrote it and nowhere else.',
        fix: 'Switch the compression to raw DEFLATE, or send the file uncompressed: several widely used JOSE libraries dropped compression support entirely, so uncompressed is the safer choice for interoperability.',
      };
    default:
      break;
  }

  if (finding.ruleId.startsWith('NET-')) {
    return {
      what: `My browser could not complete the request to ${origin}, and it will not say why.`,
      why: 'A browser gives a page one bare error for a cross-site request it refused, whatever the cause, so I cannot tell a missing header from a refused connection from out here. The most likely cause is that the response does not carry the Access-Control-Allow-Origin header a browser requires before it hands a cross-site response to a web page. Native apps are not subject to that, which is why the same link can work in a phone app and fail in every browser.',
      fix: 'Answer the OPTIONS preflight on that endpoint with Access-Control-Allow-Origin, Access-Control-Allow-Methods including POST, and Access-Control-Allow-Headers including content-type. If you run curl against it and it works, that is consistent with this: curl does not enforce any of it.',
    };
  }

  return {
    what: finding.title,
    why: finding.detail,
    fix:
      finding.remedy ??
      'Worth a look at your end before the link goes out again. Happy to run it once more if you want to change something and re-issue.',
  };
}

function safeUrl(value: string | undefined): URL | undefined {
  if (value === undefined) return undefined;
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Reading a run
// ---------------------------------------------------------------------------

/**
 * The decoded payload, taken from the trace rather than re-decoded.
 *
 * Re-decoding would read the input again and reintroduce the real key into a
 * value that is about to be exported. Reading it back out of the (already
 * redacted) run is what keeps the masking guarantee in one place.
 */
function decodedPayload(run: TraceRun): Record<string, unknown> | undefined {
  for (const step of run.steps) {
    if (step.kind !== 'shlink.decode') continue;
    for (const evidence of step.evidence) {
      if (evidence.type !== 'json') continue;
      const value = evidence.value;
      if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    }
  }
  return undefined;
}

interface OrderedStep {
  step: TraceStep;
  depth: number;
}

/** Parents followed by their children, so the table reads as the link's path. */
function orderedSteps(steps: readonly TraceStep[]): OrderedStep[] {
  const out: OrderedStep[] = [];
  for (const step of steps) {
    if (step.parentId !== undefined) continue;
    out.push({ step, depth: 0 });
    for (const child of steps) {
      if (child.parentId === step.id) out.push({ step: child, depth: 1 });
    }
  }
  // A child whose parent is missing would otherwise vanish from the report.
  for (const step of steps) {
    if (step.parentId === undefined) continue;
    if (!out.some((entry) => entry.step.id === step.id)) out.push({ step, depth: 1 });
  }
  return out;
}

interface ReportCommand {
  label: string;
  command: string;
}

function reproductionCommands(run: TraceRun, url: string | undefined): ReportCommand[] {
  const out: ReportCommand[] = [];
  const seen = new Set<string>();
  for (const step of run.steps) {
    for (const evidence of step.evidence) {
      if (!isCommand(evidence) || evidence.shell !== 'bash') continue;
      if (seen.has(evidence.command)) continue;
      seen.add(evidence.command);
      out.push({ label: evidence.label, command: evidence.command });
    }
  }
  if (out.length === 0 && url !== undefined) {
    // A run blocked by static analysis records no command, and this is exactly
    // the case where a reader wants one: it is the check that settles whether
    // the address is reachable at all.
    out.push({
      label: 'Run the manifest request yourself, from a shell, where CORS does not apply',
      command: curlForManifest({ url, recipient: REPORT_RECIPIENT }),
    });
  }
  return out.slice(0, 3);
}

function isCommand(evidence: Evidence): evidence is Extract<Evidence, { type: 'command' }> {
  return evidence.type === 'command';
}

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

const STATUS_WORDS: Record<StepStatus, string> = {
  pending: 'not started',
  running: 'running',
  ok: 'pass',
  warn: 'warning',
  fail: 'failed',
  blocked: 'stopped',
  skipped: 'not run',
};

function statusWord(status: StepStatus): string {
  return STATUS_WORDS[status];
}

const SEVERITY_WORDS: Record<Severity, string> = {
  fatal: 'fatal',
  error: 'error',
  warning: 'warning',
  info: 'note',
  good: 'good',
};

function severityWord(severity: Severity): string {
  return SEVERITY_WORDS[severity];
}

const AUDIENCE_PHRASES: Record<Audience, string> = {
  you: 'you, whoever is opening the link',
  sender: 'the person who created the link',
  server: 'whoever runs the sharing server',
  nobody: 'nobody, this is background',
};

function audiencePhrase(audience: Audience): string {
  return AUDIENCE_PHRASES[audience];
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|');
}
