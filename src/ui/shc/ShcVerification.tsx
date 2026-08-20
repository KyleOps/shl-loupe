/**
 * The SMART Health Card verification panel.
 *
 * Four decisions shape this file, and each answers something a viewer at an
 * event actually got wrong.
 *
 * 1. **Nothing is checked until somebody asks.** Checking a signature means
 *    fetching the issuer's key set, which is a request to the issuer, so the
 *    panel opens in an idle state that says so and offers the button. The
 *    in-flight state names the URL it is fetching rather than showing a
 *    spinner, because "it is loading" is not information and the URL is the
 *    thing an engineer needs when the fetch never returns.
 *
 * 2. **An unsigned payload gets the same care as a signed one.** A plain
 *    `application/fhir+json` file carries no signature, and the incumbent
 *    viewer renders that case as blank space, which leaves a reader to assume a
 *    check passed. So `not-signed` has its own posture, its own copy, and the
 *    same visual weight as `verified`.
 *
 * 3. **The whole ladder is rendered, including what was not reached.** A tool
 *    that says "verified" without saying what that covered is worse than one
 *    that says nothing, because a reader adds up green ticks. `shc.ts` always
 *    emits every check, and this panel always shows every check, split into
 *    what ran and what did not.
 *
 * 4. **A debugging switch that changes a verdict says so loudly.** Permissive
 *    mode downgrades a conformance failure to a warning; rendered quietly it
 *    would be a trap, so it gets a warning callout outside the options
 *    disclosure and a list of exactly which checks it downgraded.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Building2, FileJson, KeyRound, ListChecks, ShieldCheck } from 'lucide-react';
import {
  KNOWN_TRUST_DIRECTORIES,
  POSTURE,
  inspectJws,
  issuerJwksUrl,
  minificationFindings,
  parseHealthCardFile,
  verifyHealthCard,
  type CheckState,
  type HealthCardVerification,
  type JwsInspection,
  type RevocationState,
  type TrustDirectory,
  type TrustState,
  type VerificationCheck,
  type VerificationPosture,
} from '../../core/shc';
import type { RuleOutput } from '../../core/diagnose/rules';
import type { Finding, Severity } from '../../core/trace';
import type { OpenedFile } from '../../core/pipeline';
import { formatBytes } from '../../core/bytes';
import { BrowserTransport } from '../../core/net/browser';
import type { Transport } from '../../core/net/transport';
import {
  Button,
  Callout,
  Chip,
  CodeBlock,
  Disclosure,
  FieldTable,
  Panel,
  StatusIcon,
  type FieldRow,
  type Tone,
} from '../primitives';
import { FindingCard } from '../trace/FindingCard';

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/**
 * Six postures, six icon silhouettes. `unverifiable` deliberately borrows the
 * octagon rather than the cross: "the signature could not be checked" and "the
 * signature failed" are the two verdicts a reader most often collapses into one,
 * and they must not share an outline.
 */
export const POSTURE_TONE: Record<VerificationPosture, Tone> = {
  verified: 'pass',
  'verified-with-warnings': 'warn',
  invalid: 'fail',
  unverifiable: 'exception',
  'not-checked': 'skip',
  'not-signed': 'info',
};

export const CHECK_TONE: Record<CheckState, Tone> = {
  pass: 'pass',
  warn: 'warn',
  fail: 'fail',
  'not-reached': 'skip',
  skipped: 'skip',
};

/**
 * The word beside the icon. `not-reached` and `skipped` are both "did not run"
 * and mean different things: one is a consequence of an earlier failure, the
 * other is a choice nobody made yet.
 */
export const CHECK_WORD: Record<CheckState, string> = {
  pass: 'Pass',
  warn: 'Warning',
  fail: 'Fail',
  'not-reached': 'Not reached',
  skipped: 'Not requested',
};

const SEVERITY_ORDER: Record<Severity, number> = {
  fatal: 0,
  error: 1,
  warning: 2,
  info: 3,
  good: 4,
};

function bySeverity(a: RuleOutput, b: RuleOutput): number {
  return SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
}

/**
 * `FindingCard` renders a {@link Finding}, which is a `RuleOutput` plus the id a
 * recorded trace step would have given it. Nothing here belongs to a step, so
 * the id is synthesised from the rule and its position and is stable across
 * re-renders of the same result.
 */
function asFinding(output: RuleOutput, scope: string, index: number): Finding {
  return { ...output, id: `${scope}-${output.ruleId}-${index}` };
}

function FindingList({
  findings,
  scope,
}: {
  findings: readonly RuleOutput[];
  scope: string;
}): ReactNode {
  return (
    <div className="shc-findings">
      {findings.map((output, index) => (
        <FindingCard key={`${output.ruleId}-${index}`} finding={asFinding(output, scope, index)} />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** How many entries the card's bundle carries, which decides whether a minimisation result means anything. */
export function bundleEntryCount(bundle: unknown): number {
  if (typeof bundle !== 'object' || bundle === null) return 0;
  const entry = (bundle as { entry?: unknown }).entry;
  return Array.isArray(entry) ? entry.length : 0;
}

/** What a file is, in words, for the case where it carries no signature at all. */
export function unsignedFileLabel(file: OpenedFile): string {
  if (file.declaredContentType !== undefined) return file.declaredContentType;
  switch (file.kind) {
    case 'fhir':
      return 'a FHIR resource (application/fhir+json)';
    case 'smart-api-access':
      return 'a SMART API access token set (application/smart-api-access)';
    case 'smart-health-card':
      return 'a SMART Health Card file (application/smart-health-card)';
    default:
      return 'a file whose content type Loupe does not recognise';
  }
}

/** The checks split the way a reader has to read them: what ran, and what did not. */
export function splitChecks(checks: readonly VerificationCheck[]): {
  ran: VerificationCheck[];
  notRun: VerificationCheck[];
} {
  const ran: VerificationCheck[] = [];
  const notRun: VerificationCheck[] = [];
  for (const check of checks) {
    if (check.state === 'not-reached' || check.state === 'skipped') notRun.push(check);
    else ran.push(check);
  }
  return { ran, notRun };
}

export function revocationSentence(revocation: RevocationState): { tone: Tone; text: string } {
  switch (revocation.state) {
    case 'clean':
      return {
        tone: 'pass',
        text: `The issuer publishes a revocation list for this key at version ${revocation.ctr} with ${revocation.entries} ${revocation.entries === 1 ? 'entry' : 'entries'}, and this card is not on it.`,
      };
    case 'revoked':
      return {
        tone: 'fail',
        text: `This card is revoked. Its rid ${revocation.rid} matches the entry ${revocation.matched} on the issuer's list.`,
      };
    case 'not-published':
      return {
        tone: 'warn',
        text: 'The issuer publishes no revocation list for this key, so whether this card has been revoked is unknown. Unknown is not the same as not revoked, and no verifier anywhere can tell the difference.',
      };
    case 'no-rid':
      return {
        tone: 'info',
        text: 'The card carries no rid, so there is nothing per-card to look up. Revocation for this issuer can only work at the level of the whole key.',
      };
    case 'unavailable':
      return { tone: 'warn', text: revocation.reason };
    default:
      return { tone: 'skip', text: revocation.reason };
  }
}

export function trustSentence(trust: TrustState): { tone: Tone; text: string } {
  switch (trust.state) {
    case 'listed':
      return {
        tone: 'pass',
        text: `${trust.directory} lists this issuer, matched on ${trust.matchedOn}${trust.name === undefined ? '' : `, under the name ${trust.name}`}. That is one directory vouching for it, not a statement that the issuer is trustworthy.`,
      };
    case 'unlisted':
      return {
        tone: 'info',
        // The trap this wording exists to stop: a connectathon or Australian
        // issuer is legitimately absent from a COVID-era US directory, and a
        // viewer that renders absence as a red cross teaches the room wrongly.
        text: `This issuer is not listed in ${trust.directories.join(', ')}. Unlisted is not untrusted: each directory covers a defined set of institutions, and an issuer outside that set is expected to be absent.`,
      };
    case 'unavailable':
      return { tone: 'warn', text: `${trust.directory} could not be read: ${trust.reason}` };
    default:
      return { tone: 'skip', text: trust.reason };
  }
}

// ---------------------------------------------------------------------------
// The panel
// ---------------------------------------------------------------------------

export interface ShcVerificationProps {
  file: OpenedFile;
  /** Injected in tests and by a caller with its own recorder. Defaults to the browser. */
  transport?: Transport | undefined;
}

export function ShcVerification({ file, transport }: ShcVerificationProps): ReactNode {
  const activeTransport = useMemo(() => transport ?? new BrowserTransport(), [transport]);
  const [permissive, setPermissive] = useState(false);
  const [directoryIds, setDirectoryIds] = useState<readonly string[]>([]);

  const directories = useMemo(
    () => KNOWN_TRUST_DIRECTORIES.filter((entry) => directoryIds.includes(entry.id)),
    [directoryIds],
  );

  const parsed = useMemo(
    () =>
      file.kind === 'smart-health-card' && file.content !== undefined
        ? parseHealthCardFile(file.content)
        : undefined,
    [file.kind, file.content],
  );

  // A file that never opened is not an unsigned file. The trap is to fall
  // through to the not-signed copy here, which would state a fact about content
  // nobody has seen: a card that failed to decrypt would be reported as
  // carrying no signature.
  if (file.content === undefined) {
    return (
      <Panel title="Verification">
        <div className="shc">
          <Callout tone="skip" title="Nothing to verify yet.">
            This file did not open, so its contents were never read.
            {file.failure === undefined
              ? ' Whether it carries a signature is unknown, and the trace says where the run stopped.'
              : ` ${file.failure.message} Whether it carries a signature is unknown.`}
          </Callout>
        </div>
      </Panel>
    );
  }

  if (parsed === undefined) {
    return (
      <Panel title="Verification">
        <UnsignedPayload file={file} />
      </Panel>
    );
  }

  const fileFindings = [...parsed.findings].sort(bySeverity);

  return (
    <Panel title="Verification">
      <div className="shc">
        {parsed.cards.length > 1 ? (
          <p className="shc-lede">
            This file carries {parsed.cards.length} cards. The specification allows entries from
            different issuers in one file, so each is inspected and checked on its own and there is
            no combined verdict.
          </p>
        ) : null}

        {parsed.extraMembers.length > 0 ? (
          <p className="shc-lede">
            The file also carries {parsed.extraMembers.join(', ')}, which the specification does not
            define at the top level. Loupe ignored{' '}
            {parsed.extraMembers.length === 1 ? 'it' : 'them'}.
          </p>
        ) : null}

        {fileFindings.length > 0 ? <FindingList findings={fileFindings} scope="file" /> : null}

        {parsed.cards.length === 0 ? (
          <Callout tone="fail" title="This file carries no cards.">
            The wrapper opened and its verifiableCredential array holds nothing Loupe could read as
            a card, so there is no signature, no issuer and no key set to check. The findings above
            say what the file held instead. This is the sender&rsquo;s to fix.
          </Callout>
        ) : null}

        {parsed.cards.length > 0 ? (
          <VerificationOptions
            permissive={permissive}
            onPermissive={setPermissive}
            selected={directoryIds}
            onSelect={setDirectoryIds}
          />
        ) : null}

        {parsed.cards.map((jws, index) => (
          // Remounting on an options change is deliberate: a settled result
          // rendered underneath a switch that was flipped after the run would
          // describe a run that never happened.
          <CardVerification
            key={`${index}:${permissive ? 'permissive' : 'strict'}:${directoryIds.join('+')}`}
            jws={jws}
            ordinal={index + 1}
            total={parsed.cards.length}
            transport={activeTransport}
            permissive={permissive}
            directories={directories}
          />
        ))}
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// A payload with no signature
// ---------------------------------------------------------------------------

/**
 * The normal state for a plain FHIR file, and the one the incumbent viewer
 * renders as nothing at all. Said out loud, with the same weight a pass gets.
 */
function UnsignedPayload({ file }: { file: OpenedFile }): ReactNode {
  return (
    <div className="shc">
      <PostureBlock posture="not-signed" />
      <FieldTable
        rows={[
          {
            key: 'This file is',
            value: unsignedFileLabel(file),
            mono: false,
            note: 'A signature would arrive as a SMART Health Card: a compact JWS with an issuer, a key set and a key id. There is none here, so there is no issuer to name and nothing to check.',
          },
          {
            key: 'What is proven',
            value: 'That the sender held the link key.',
            mono: false,
            note: 'The file arrived encrypted under the key in the link, so whoever served it had that key. That says nothing about who authored the contents, and nothing about whether they were altered before encryption.',
          },
        ]}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

function VerificationOptions({
  permissive,
  onPermissive,
  selected,
  onSelect,
}: {
  permissive: boolean;
  onPermissive: (value: boolean) => void;
  selected: readonly string[];
  onSelect: (ids: readonly string[]) => void;
}): ReactNode {
  const toggle = (directory: TrustDirectory): void => {
    onSelect(
      selected.includes(directory.id)
        ? selected.filter((id) => id !== directory.id)
        : [...selected, directory.id],
    );
  };

  return (
    <div className="shc-options">
      {permissive ? (
        <Callout tone="warn" title="Permissive mode is on.">
          A failed conformance check is being reported as a warning so a run can continue past it.
          The signature, the validity dates and revocation are never downgraded, so a broken card
          cannot be made to look acceptable, but every other failure below reads one step softer
          than it is. Turn this off before you read anything here as a verdict.
        </Callout>
      ) : null}

      <Disclosure summary="Options: permissive mode, and trust directories">
        <div className="shc-option">
          <label className="shc-check">
            <input
              type="checkbox"
              checked={permissive}
              onChange={(event) => onPermissive(event.target.checked)}
            />
            <span>
              <strong>Permissive mode</strong>
              <span className="shc-option-note">
                For debugging a producer, where stopping at the first defect hides the next three.
                Downgrades a failed conformance check to a warning and lists which ones it
                downgraded. Never touches the signature, the dates or revocation.
              </span>
            </span>
          </label>
        </div>

        <div className="shc-option">
          <p className="shc-option-lede">
            <Building2 size={14} aria-hidden /> A trust directory is a third party with no
            relationship to the card in front of you, so reading one tells that third party which
            issuer somebody is looking at. Nothing below is fetched until you tick it, and the URL
            is here first.
          </p>
          {KNOWN_TRUST_DIRECTORIES.map((directory) => (
            <label key={directory.id} className="shc-check">
              <input
                type="checkbox"
                checked={selected.includes(directory.id)}
                onChange={() => toggle(directory)}
              />
              <span>
                <strong>{directory.name}</strong>
                <span className="shc-option-note">{directory.scope}</span>
                <span className="opaque-value shc-option-url">{directory.url}</span>
              </span>
            </label>
          ))}
        </div>
      </Disclosure>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One card
// ---------------------------------------------------------------------------

type RunPhase =
  | { phase: 'idle' }
  | { phase: 'checking'; jwksUrl: string | undefined }
  | { phase: 'settled'; verification: HealthCardVerification }
  /** Loupe itself broke. Distinct from a failed check, and it must not read as one. */
  | { phase: 'error'; message: string };

function CardVerification({
  jws,
  ordinal,
  total,
  transport,
  permissive,
  directories,
}: {
  jws: string;
  ordinal: number;
  total: number;
  transport: Transport;
  permissive: boolean;
  directories: readonly TrustDirectory[];
}): ReactNode {
  const [run, setRun] = useState<RunPhase>({ phase: 'idle' });
  const inspection = useMemo(() => inspectJws(jws), [jws]);

  const iss = inspection.ok ? inspection.card.iss : undefined;
  // Known before the fetch, and shown before it, so the in-flight state can name
  // the URL rather than saying "loading". Concatenation, never URL resolution:
  // see issuerJwksUrl.
  const jwksUrl = useMemo(
    () => (iss === undefined ? undefined : issuerJwksUrl(iss).jwksUrl),
    [iss],
  );

  // A state update after unmount is not an error worth risking on a panel that
  // can be swapped out mid-fetch by the file switcher above it.
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const check = useCallback(() => {
    setRun({ phase: 'checking', jwksUrl });
    void verifyHealthCard(jws, {
      transport,
      permissive,
      ...(directories.length === 0 ? {} : { trustedDirectories: directories }),
    }).then(
      (verification) => {
        if (live.current) setRun({ phase: 'settled', verification });
      },
      (error: unknown) => {
        // verifyHealthCard reports a transport failure as a finding rather than
        // rejecting, so a rejection here is a defect in Loupe rather than
        // anything about the card. It gets its own phase for that reason: shown
        // as a failed check it would blame the sender for our bug.
        if (!live.current) return;
        setRun({
          phase: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      },
    );
  }, [jws, jwksUrl, transport, permissive, directories]);

  const verification = run.phase === 'settled' ? run.verification : undefined;
  const posture: VerificationPosture = verification?.posture ?? 'not-checked';
  const checks = verification?.checks ?? inspection.checks;

  return (
    <section className="shc-card">
      {total > 1 ? (
        <h3 className="shc-card-title">
          Card {ordinal} of {total}
        </h3>
      ) : null}

      <PostureBlock posture={posture} />

      {verification?.permissive === true ? (
        <PermissiveResult downgraded={verification.downgraded} checks={checks} />
      ) : null}

      <IssuerBlock iss={iss} jwksUrl={jwksUrl} verification={verification} phase={run.phase} />

      {run.phase === 'error' ? (
        <Callout tone="exception" title="Loupe could not finish the check.">
          {run.message} This is a defect in this tool, not a finding about the card. Nothing below
          has been decided by it, and the button will try again.
        </Callout>
      ) : null}

      {run.phase === 'idle' || run.phase === 'error' ? (
        <div className="shc-action">
          <Button variant="primary" onClick={check}>
            <KeyRound size={14} aria-hidden />
            Check the signature
          </Button>
          <p className="shc-action-note">
            {jwksUrl === undefined
              ? 'No request will be made: the card names no issuer, so there is nowhere to fetch a key set from.'
              : `This makes one request, a GET of ${jwksUrl}, and a second one only if that key set advertises a revocation list. Nothing else is contacted.`}
          </p>
        </div>
      ) : null}

      {run.phase === 'checking' ? (
        <Callout tone="running" title="Fetching the issuer's key set.">
          {run.jwksUrl === undefined
            ? 'The card names no issuer, so there is no key set to fetch. Reading the ladder now.'
            : `A GET of ${run.jwksUrl}, which is the issuer's iss with the well-known path appended. If this never returns, that URL is the one to try with curl.`}
        </Callout>
      ) : null}

      <KeyIdentityBlock verification={verification} inspection={inspection} />

      <ChecksBlock checks={checks} checked={verification !== undefined} />

      {verification !== undefined ? <StateBlock verification={verification} /> : null}

      <CardClaims inspection={inspection} />

      <Minimisation inspection={inspection} />

      <FailureBlocks inspection={inspection} verification={verification} />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Posture
// ---------------------------------------------------------------------------

function PostureBlock({ posture }: { posture: VerificationPosture }): ReactNode {
  const tone = POSTURE_TONE[posture];
  return (
    <div className={`shc-posture tone tone-${tone}`}>
      <Chip tone={tone}>
        <StatusIcon tone={tone} size={12} />
        {POSTURE[posture].word}
      </Chip>
      <p>{POSTURE[posture].meaning}</p>
    </div>
  );
}

function PermissiveResult({
  downgraded,
  checks,
}: {
  downgraded: readonly string[];
  checks: readonly VerificationCheck[];
}): ReactNode {
  const labels = downgraded.map((id) => checks.find((check) => check.id === id)?.label ?? id);
  return (
    <Callout tone="warn" title="This result was produced with permissive mode on.">
      {labels.length === 0
        ? 'Nothing needed downgrading, so this run reads the same with permissive mode off.'
        : `${labels.length} failed ${labels.length === 1 ? 'check is' : 'checks are'} shown below as a warning rather than a failure: ${labels.join('; ')}.`}
    </Callout>
  );
}

// ---------------------------------------------------------------------------
// Issuer
// ---------------------------------------------------------------------------

function IssuerBlock({
  iss,
  jwksUrl,
  verification,
  phase,
}: {
  iss: string | undefined;
  jwksUrl: string | undefined;
  verification: HealthCardVerification | undefined;
  phase: RunPhase['phase'];
}): ReactNode {
  if (iss === undefined) {
    return (
      <Callout tone="fail" title="The card names no issuer.">
        Without an iss claim there is no domain to fetch a key set from, so this card cannot be
        verified by anybody, anywhere. This is the sender&rsquo;s to fix.
      </Callout>
    );
  }

  const name = verification?.issuer?.name;
  const fetched = verification?.exchanges.filter((exchange) =>
    exchange.request.url.includes('/.well-known/jwks.json'),
  );
  const rows: FieldRow[] = [
    {
      key: 'iss',
      value: iss,
      note: "The issuer's own URL, taken from the card. It is an address, not a name: nothing about it has been checked against any register.",
    },
    {
      key: 'Key set URL',
      value: jwksUrl ?? '',
      note:
        phase === 'settled'
          ? 'Built by appending the well-known path to iss, as the specification requires, and this is the URL that was requested.'
          : phase === 'checking'
            ? 'Built by appending the well-known path to iss, as the specification requires. This is the request in flight.'
            : 'Built by appending the well-known path to iss, as the specification requires. Nothing has been requested from it yet.',
    },
  ];

  if (name !== undefined) {
    rows.push({
      key: 'Directory name',
      value: name,
      mono: false,
      tone: 'info',
      note: 'The name a trust directory publishes for this iss. It is that directory’s claim, not something the card asserts and not something Loupe verified.',
    });
  }

  if (fetched !== undefined && fetched.length > 1) {
    rows.push({
      key: 'Second attempt',
      value: fetched[fetched.length - 1]?.request.url ?? '',
      tone: 'warn',
      note: 'The first URL did not return a key set, so Loupe retried with the doubled slash collapsed. A receiver that builds the URL exactly as the specification says to will fail against this issuer.',
    });
  }

  return (
    <div className="shc-section">
      <h4 className="shc-heading">
        <Building2 size={14} aria-hidden /> The issuer
      </h4>
      <FieldTable rows={rows} dense />
      {verification !== undefined && verification.exchanges.length > 0 ? (
        <Disclosure summary={`Requests made for this card (${verification.exchanges.length})`}>
          <FieldTable
            rows={verification.exchanges.map((exchange) => ({
              key: `${exchange.request.method} ${exchange.response.status === 0 ? 'failed' : exchange.response.status}`,
              value: exchange.request.url,
              tone: exchange.response.status === 0 ? 'fail' : undefined,
              ...(exchange.response.networkError === undefined
                ? {}
                : { note: exchange.response.networkError }),
            }))}
            dense
          />
        </Disclosure>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// kid against the thumbprint
// ---------------------------------------------------------------------------

/**
 * The `kid` and the recomputed thumbprint side by side.
 *
 * Printing only "thumbprint matches" is an assertion the reader has to take on
 * faith, and the mismatch case is a real producer defect that changes which
 * verifiers can find the key at all. Both values, always.
 */
function KeyIdentityBlock({
  verification,
  inspection,
}: {
  verification: HealthCardVerification | undefined;
  inspection: JwsInspection;
}): ReactNode {
  const headerKid = inspection.ok
    ? typeof inspection.header.kid === 'string'
      ? inspection.header.kid
      : undefined
    : undefined;
  if (headerKid === undefined && verification === undefined) return null;

  const thumbprint = verification?.thumbprint;
  const matches =
    headerKid !== undefined && thumbprint !== undefined ? headerKid === thumbprint : undefined;

  const rows: FieldRow[] = [
    {
      key: 'kid (JWS header)',
      value: headerKid ?? 'absent',
      tone: headerKid === undefined ? 'fail' : undefined,
      note:
        headerKid === undefined
          ? 'The card names no key, so no key can be selected from the set. Loupe will not try each key until one verifies: that would report a card signed with a withdrawn key as valid.'
          : 'The key this card says it was signed with.',
    },
    {
      key: 'RFC 7638 thumbprint',
      value: thumbprint ?? 'not computed',
      tone: matches === undefined ? undefined : matches ? 'pass' : 'fail',
      note:
        thumbprint === undefined
          ? 'Computed from the published key, so it exists only once a key set has been fetched and a key selected.'
          : matches === true
            ? 'Computed here from that key’s own crv, kty, x and y. It equals the kid above, so the two agree.'
            : 'Computed here from that key’s own crv, kty, x and y, and it does not equal the kid above. Any verifier that indexes keys by recomputed thumbprint rather than by the literal kid string will not find this key at all.',
    },
  ];

  const kids = verification?.keySetKids;
  if (kids !== undefined) {
    rows.push({
      key: 'Keys in the set',
      value: kids.length === 0 ? 'none' : kids.join(', '),
      note: `The issuer publishes ${kids.length} ${kids.length === 1 ? 'key' : 'keys'}. An old public key is meant to stay in the set for as long as the cards it signed are clinically relevant, so a short set beside a card that does not verify is worth asking about.`,
    });
  }

  return (
    <div className="shc-section">
      <h4 className="shc-heading">
        <KeyRound size={14} aria-hidden /> The key, and its two identities
      </h4>
      <FieldTable rows={rows} dense />
      {verification?.key !== undefined ? (
        <Disclosure summary="The public key as published">
          <CodeBlock language="json">{JSON.stringify(verification.key, null, 2)}</CodeBlock>
        </Disclosure>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------

function ChecksBlock({
  checks,
  checked,
}: {
  checks: readonly VerificationCheck[];
  checked: boolean;
}): ReactNode {
  const { ran, notRun } = splitChecks(checks);

  return (
    <div className="shc-section">
      <h4 className="shc-heading">
        <ListChecks size={14} aria-hidden /> What was checked, and what was not
      </h4>
      <p className="shc-note">
        {checked
          ? `Every check in the specification's order, all ${checks.length} of them. ${ran.length} ran and ${notRun.length} did not, and a check that did not run is never a pass.`
          : `Nothing has been fetched yet, so only the ${ran.length} checks that need no network have run. The other ${notRun.length} are listed as not reached rather than left out.`}
      </p>

      {ran.length > 0 ? <CheckList checks={ran} /> : null}

      {notRun.length > 0 ? (
        <Disclosure summary={`Not checked (${notRun.length})`} defaultOpen={!checked}>
          <CheckList checks={notRun} />
        </Disclosure>
      ) : null}
    </div>
  );
}

function CheckList({ checks }: { checks: readonly VerificationCheck[] }): ReactNode {
  return (
    <ul className="shc-ladder">
      {checks.map((check) => {
        const tone = CHECK_TONE[check.state];
        return (
          <li key={check.id} className={`shc-rung tone tone-${tone}`}>
            <span className="shc-rung-state">
              <StatusIcon tone={tone} size={14} />
              <span className="shc-rung-word">{CHECK_WORD[check.state]}</span>
            </span>
            <span className="shc-rung-body">
              <span className="shc-rung-label">{check.label}</span>
              {check.detail !== undefined ? (
                <span className="shc-rung-detail">{check.detail}</span>
              ) : null}
              <span className="shc-rung-id mono">{check.id}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// Revocation and trust
// ---------------------------------------------------------------------------

function StateBlock({ verification }: { verification: HealthCardVerification }): ReactNode {
  const revocation = revocationSentence(verification.revocation);
  const trust = trustSentence(verification.trust);
  return (
    <div className="shc-section">
      <h4 className="shc-heading">
        <ShieldCheck size={14} aria-hidden /> Revocation, and who vouches for the issuer
      </h4>
      <FieldTable
        rows={[
          {
            key: 'Revocation',
            value: revocation.text,
            mono: false,
            tone: revocation.tone,
          },
          {
            key: 'Trust directory',
            value: trust.text,
            mono: false,
            tone: trust.tone,
          },
        ]}
        dense
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// The claims, before any verification
// ---------------------------------------------------------------------------

function CardClaims({ inspection }: { inspection: JwsInspection }): ReactNode {
  if (!inspection.ok) return null;
  const card = inspection.card;

  const rows: FieldRow[] = [
    { key: 'vc.type', value: card.types.length === 0 ? 'absent' : card.types.join(', ') },
    {
      key: 'fhirVersion',
      value: card.fhirVersion ?? 'absent',
    },
    {
      key: 'nbf',
      value:
        card.nbf === undefined
          ? 'absent'
          : `${new Date(card.nbf.epochMs).toISOString()} (raw ${card.nbf.raw}, read as ${card.nbf.unit})`,
      ...(card.nbf?.unit === 'milliseconds'
        ? {
            tone: 'warn',
            note: 'The value is too large to be seconds, so Loupe read it as milliseconds. A verifier that reads it as seconds dates this card tens of thousands of years into the future and refuses it.',
          }
        : {}),
    },
    {
      key: 'exp',
      value: card.exp === undefined ? 'absent' : new Date(card.exp.epochMs).toISOString(),
      ...(card.exp === undefined
        ? {
            note: 'Absent is the norm. A health card states a fact that does not change, so most carry no expiry at all.',
          }
        : {}),
    },
    { key: 'rid', value: card.rid ?? 'absent' },
    {
      key: 'Payload size',
      value: `${formatBytes(inspection.sizes.compressed)} compressed, ${formatBytes(inspection.sizes.inflated)} inflated`,
      note: `Compression framing: ${inspection.framing}. A card shown as a QR code has to fit in one, so the inflated size is what decides whether it can be.`,
    },
  ];

  return (
    <Disclosure summary="The card's claims, as they arrived">
      <FieldTable rows={rows} dense />
      <Disclosure summary="The JWS header">
        <CodeBlock language="json">{JSON.stringify(inspection.header, null, 2)}</CodeBlock>
      </Disclosure>
      <Disclosure summary="The payload JSON, exactly as it inflated">
        <CodeBlock language="json">{inspection.payloadText}</CodeBlock>
      </Disclosure>
    </Disclosure>
  );
}

// ---------------------------------------------------------------------------
// Content minimisation
// ---------------------------------------------------------------------------

/**
 * The minimisation check, which no other browser tool offers.
 *
 * The trap here is reading an empty result as a pass. `minificationFindings`
 * returns nothing both for a perfectly minimised bundle and for a card with no
 * bundle to look at, so the entry count decides which sentence gets said.
 */
function Minimisation({ inspection }: { inspection: JwsInspection }): ReactNode {
  const bundle = inspection.ok ? inspection.card.fhirBundle : undefined;
  const entries = bundleEntryCount(bundle);
  const findings = useMemo(
    // Delivered through a SMART Health Link, not as a QR code, so shc.ts reports
    // these one severity lower and says why in each finding.
    () => (entries === 0 ? [] : minificationFindings(bundle, { deliveredAsQr: false })),
    [bundle, entries],
  );

  if (entries === 0) {
    return (
      <div className="shc-section">
        <h4 className="shc-heading">
          <FileJson size={14} aria-hidden /> Content minimisation
        </h4>
        <p className="shc-note">
          The card carries no FHIR bundle entries, so there is nothing to measure. This is not a
          pass.
        </p>
      </div>
    );
  }

  const total = findings.length;
  const tone: Tone = total === 0 ? 'pass' : 'warn';

  return (
    <div className="shc-section">
      <h4 className="shc-heading">
        <FileJson size={14} aria-hidden /> Content minimisation
        <Chip tone={tone}>
          <StatusIcon tone={tone} size={12} />
          {total === 0 ? 'Clean' : `${total} ${total === 1 ? 'finding' : 'findings'}`}
        </Chip>
      </h4>
      <p className="shc-note">
        Across {entries} {entries === 1 ? 'entry' : 'entries'}, checked for everything a minimised
        bundle strips: <code>Resource.id</code>, <code>meta</code> beyond security labels, narrative
        text, <code>CodeableConcept.text</code>, <code>Coding.display</code>, and entry{' '}
        <code>fullUrl</code>s and references that are not short <code>resource:N</code> URIs.
      </p>
      {total === 0 ? (
        <p className="shc-note">
          None of them is present, so this bundle is minimised. That is worth saying: a bundle
          carrying narrative and a display for every code is around three times the size it needs to
          be, which is the difference between a card that fits in one QR and one that does not.
        </p>
      ) : (
        <Disclosure
          summary={`The ${total} ${total === 1 ? 'finding' : 'findings'}, grouped by rule`}
          defaultOpen
        >
          <p className="shc-note">
            Each rule is reported once with a count and a few example paths. Two hundred separate
            findings for a 55-entry bundle would be accurate and unreadable.
          </p>
          <FindingList findings={[...findings].sort(bySeverity)} scope="minify" />
        </Disclosure>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

/**
 * Every failure as its own block.
 *
 * Findings from the static inspection are already inside the verification's own
 * list once a run has settled, so the settled case renders that list alone: two
 * copies of the same defect reads as two defects.
 */
function FailureBlocks({
  inspection,
  verification,
}: {
  inspection: JwsInspection;
  verification: HealthCardVerification | undefined;
}): ReactNode {
  const all = verification?.findings ?? inspection.findings;
  const serious = all
    .filter((f) => f.severity === 'fatal' || f.severity === 'error')
    .sort(bySeverity);
  const rest = all.filter((f) => f.severity !== 'fatal' && f.severity !== 'error').sort(bySeverity);

  if (all.length === 0) {
    return (
      <p className="shc-note">
        No defect was found in what has been examined so far. That is a statement about the checks
        above, not about the checks that have not run.
      </p>
    );
  }

  return (
    <div className="shc-section">
      {serious.length > 0 ? (
        <>
          <h4 className="shc-heading">
            {serious.length} {serious.length === 1 ? 'failure' : 'failures'}
          </h4>
          <FindingList findings={serious} scope="fail" />
        </>
      ) : null}

      {rest.length > 0 ? (
        <Disclosure
          summary={`Other observations (${rest.length})`}
          defaultOpen={serious.length === 0}
        >
          <FindingList findings={rest} scope="note" />
        </Disclosure>
      ) : null}
    </div>
  );
}
