/**
 * The Sandbox: making links, rather than reading them.
 *
 * This is the screen that turns a viewer into a conformance test-vector
 * generator, and the reason it is worth building is asymmetric. Reading a link
 * well helps the person holding a broken one. Producing a link that is wrong in
 * one named way, with the rule it breaks and the behaviour a receiver owes it
 * written beside it, helps everybody who has to prove their receiver is right,
 * and there is no other browser tool that does it.
 *
 * Two halves, deliberately not tabbed:
 *
 *  - Minting a link that is correct, so a sender has a known-good input.
 *  - The broken catalogue from `core/mint.ts`, whose claims are checked against
 *    the real pipeline by `mint.test.ts`. The rule ids shown here are what
 *    actually fires, not what a description hopes fires.
 *
 * One scrolling page rather than tabs, because the two halves are read together:
 * you mint the good link, point a viewer at it, then walk down the broken list
 * pointing the same viewer at each one. Tabs would hide half of that job behind
 * a control nobody presses twice.
 *
 * NOTHING MINTED HERE IS SERVABLE, AND THAT IS SAID THREE TIMES ON PURPOSE. The
 * caveat opens the mint section, every artefact carries a short marker of its
 * own, and each broken card says what its link alone will reach. Three, because
 * these artefacts travel as cropped screenshots and pasted code blocks: a
 * caveat that lives only at the top of a section does not survive either.
 *
 * The useful path is therefore made one press. A minted link plus the manifest a
 * server would have served is exactly what the Offline screen wants, so the
 * hand-off hands both over through that screen's published fragment contract
 * (see `parseOfflineHandoff` there) rather than reaching into its store: a query
 * is a stated interface, and the result is a link that survives a reload.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Beaker,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  RefreshCw,
  ServerOff,
  Wand,
  WifiOff,
} from 'lucide-react';
import { formatBytes } from '../../core/bytes';
import {
  BROKEN_PRESETS,
  generateLinkKey,
  mintShl,
  PASSCODE_REJECTION_BODY,
  SAMPLE_PAYLOADS,
  SHL_CONTENT_TYPES,
  type BrokenArtefacts,
  type BrokenPreset,
  type MintedPasscode,
  type MintOptions,
  type MintResult,
} from '../../core/mint';
import type { RunOutcome } from '../../core/trace';
import { QrCode } from '../../ui/QrCode';
import {
  Button,
  Callout,
  Chip,
  CodeBlock,
  CopyButton,
  Disclosure,
  FieldTable,
  Panel,
  Secret,
  StatusIcon,
  type FieldRow,
  type Tone,
} from '../../ui/primitives';
import { hashForLink, hashForScreen, navigate } from '../router';
import { useSettings } from '../store';

// ---------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------

export interface FlagChoices {
  L: boolean;
  P: boolean;
  U: boolean;
}

/**
 * Flags are concatenated in alphabetical order, which the letters happen to
 * already be in. Sorting anyway means adding a fourth letter later cannot
 * silently produce an out-of-order string that a strict receiver rejects.
 */
export function flagsFromChoices(choices: FlagChoices): string {
  return (['L', 'P', 'U'] as const).filter((letter) => choices[letter]).join('');
}

export interface ExpiryChoice {
  id: string;
  label: string;
  /** Seconds from now. Absent means no `exp` member at all. */
  seconds?: number;
}

export const EXPIRY_CHOICES: ExpiryChoice[] = [
  { id: 'none', label: 'No exp member' },
  { id: 'hour', label: 'In 1 hour', seconds: 60 * 60 },
  { id: 'day', label: 'In 24 hours', seconds: 24 * 60 * 60 },
  { id: 'week', label: 'In 7 days', seconds: 7 * 24 * 60 * 60 },
  { id: 'month', label: 'In 30 days', seconds: 30 * 24 * 60 * 60 },
];

/**
 * `exp` is epoch SECONDS. The milliseconds mistake is common enough to be a
 * catalogue entry in its own right, so the one place that computes it here does
 * the division once and nowhere else.
 */
export function expiryEpochSeconds(choice: ExpiryChoice, now: number): number | undefined {
  return choice.seconds === undefined ? undefined : Math.floor(now / 1000) + choice.seconds;
}

export type ParsedPayload = { content: unknown } | { error: string };

export function parsePayloadJson(text: string): ParsedPayload {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { error: 'There is nothing to encrypt yet.' };
  try {
    return { content: JSON.parse(trimmed) };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : 'That is not JSON.',
    };
  }
}

/**
 * Why the mint action is unavailable, in the words shown beside it, or undefined
 * when it is available.
 *
 * Stated rather than merely disabled. The review's finding was that selecting
 * the P flag offered nowhere to type a passcode; a button that quietly stops
 * working is the same failure one layer down, so the reason is rendered next to
 * the control and pointed at by `aria-describedby`.
 */
export function mintBlocker(state: {
  jsonError: string | undefined;
  flags: FlagChoices;
  passcode: string;
}): string | undefined {
  if (state.jsonError !== undefined) {
    return 'The payload above is not JSON yet, so there is nothing to encrypt.';
  }
  if (state.flags.P && state.passcode.trim() === '') {
    return 'The P flag says the sharing server demands a passcode, so this link needs one first. A link claiming P with no passcode behind it sends every receiver to prompt for a secret that cannot match, and each attempt is charged for the life of the link.';
  }
  return undefined;
}

/** How an expected outcome reads. Never the colour on its own: a word too. */
export function describeOutcome(outcome: RunOutcome): { tone: Tone; word: string } {
  switch (outcome) {
    case 'opened':
      return { tone: 'pass', word: 'Opens' };
    case 'partial':
      return { tone: 'warn', word: 'Partly opens' };
    case 'blocked':
      return { tone: 'exception', word: 'Stopped before any request' };
    case 'failed':
      return { tone: 'fail', word: 'Fails' };
    default:
      return { tone: 'running', word: 'Still running' };
  }
}

/**
 * What "Open in SHLoupe" will actually show for a given preset, which is not the
 * same question for all nineteen of them.
 *
 * Two independent facts decide it. A preset whose expected outcome is `blocked`
 * is answered from the link alone, so no request is issued and the demonstration
 * is complete; that is the product thesis and worth saying out loud. Separately,
 * a preset carrying a manifest or a file has its fault in bytes a server would
 * have served, and SHLoupe has no server, so the fault is only reachable with
 * those bytes supplied, which is what the offline hand-off beside it does.
 *
 * Getting this wrong in either direction wastes somebody's minute: promising a
 * clean diagnosis that ends in a fetch error, or sending them to Offline mode
 * for a link that needed no server at all.
 */
export function reachSentence(outcome: RunOutcome, artefacts: BrokenArtefacts): string {
  if (outcome === 'blocked') {
    return 'SHLoupe answers this one from the link alone, with no request issued at all. That is the whole demonstration: a receiver that has to make a request to find this out is a receiver spending a round trip on a question it could already answer.';
  }
  if (artefacts.manifest === undefined && artefacts.jwe === undefined) {
    return 'The fault is in the link, so it is reported before the fetch. The fetch then fails too, because the host serves nothing; both appear in the trace, in that order.';
  }
  return 'The fault is in bytes a server would have served, and SHLoupe has no server, so opening the link alone stops at the failed fetch. Open it offline instead and those bytes are supplied for you.';
}

// ---------------------------------------------------------------------------
// The hand-off into Offline mode
// ---------------------------------------------------------------------------

interface OfflineHandoffFields {
  /** The primary box: a link, or a bare encrypted file. */
  input: string;
  /** The manifest response, for a hand-off that starts at a link. */
  manifest?: string;
  /** Needed only when the primary box is a bare file, which carries no key. */
  key?: string;
}

/**
 * Build the Offline screen's published hand-off fragment:
 * `#/offline?input=…&manifest=…&key=…&open=1`. See `parseOfflineHandoff` in
 * `OfflineScreen.tsx`, which owns the contract.
 *
 * A fragment rather than that screen's store, deliberately: it is somebody
 * else's screen, the query is a stated interface where a store action is an
 * internal, and the result is a link that survives a reload and can be pasted to
 * a colleague.
 *
 * `URLSearchParams` does the encoding, and both traps the contract names are
 * encoding traps. The router matches a bare `shlink:/` ANYWHERE in the fragment
 * and would send the whole hand-off to the Open screen, which would then try to
 * fetch it; and a manifest carries `application/fhir+json`, whose `+` decodes as
 * a space unless it is written `%2B`. Hand-concatenating this query breaks both.
 */
export function offlineHandoffHash(fields: OfflineHandoffFields): string {
  const params = new URLSearchParams();
  params.set('input', fields.input);
  if (fields.manifest !== undefined) params.set('manifest', fields.manifest);
  if (fields.key !== undefined) params.set('key', fields.key);
  // Fill the boxes AND run it. Safe unasked in a way it would not be on the Open
  // screen: an offline run issues no request, so it cannot spend one of the
  // link's counted passcode attempts.
  params.set('open', '1');
  return `${hashForScreen('offline')}?${params.toString()}`;
}

/** The artefacts of a minted link, as the Offline screen wants them. */
export function handoffForMint(minted: MintResult): string {
  if (minted.manifest === undefined) {
    // A U link has no manifest, so the encrypted file itself is the paste. It
    // carries no link, and therefore no key, so the key goes in beside it.
    return offlineHandoffHash({ input: minted.file.jwe, key: minted.key });
  }
  return offlineHandoffHash({
    input: minted.shlink,
    manifest: JSON.stringify(minted.manifest, null, 2),
  });
}

/**
 * The same, for a catalogue entry. Undefined when there is nothing a server
 * would have served, in which case the link alone already reaches the fault and
 * a hand-off would only add a step.
 */
export function handoffForPreset(artefacts: BrokenArtefacts): string | undefined {
  if (artefacts.manifest !== undefined) {
    return offlineHandoffHash({
      input: artefacts.shlink,
      manifest: JSON.stringify(artefacts.manifest, null, 2),
    });
  }
  if (artefacts.jwe !== undefined) {
    return offlineHandoffHash({ input: artefacts.jwe, key: artefacts.key });
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

export function SandboxScreen(): ReactNode {
  return (
    <div className="sandbox">
      <section className="sandbox-lede">
        <h1>Make links, correct and broken, to test something else.</h1>
        <p className="prose">
          Everything here is produced in this tab, by the same encrypter SHLoupe uses to read a
          link, so a defect in one direction shows up in the other rather than cancelling itself
          out. Nothing is uploaded, and nothing is stored.
        </p>
      </section>
      <MintSection />
      <CatalogueSection />
    </div>
  );
}

/**
 * The caveat, small enough to sit on an individual artefact.
 *
 * These leave the screen as cropped screenshots and pasted code blocks, so the
 * marker rides on each one. The word carries the meaning and the icon gives it a
 * silhouette; the colour is the third signal, never the only one.
 */
function NotLive({ what }: { what: string }): ReactNode {
  return (
    <Chip tone="warn" title={`${what} is a test vector. The host in it serves nothing.`}>
      <ServerOff size={11} aria-hidden />
      Test vector, not live
    </Chip>
  );
}

function ArtefactHead({ title, what }: { title: string; what: string }): ReactNode {
  return (
    <div className="artefact-head">
      <h4 className="artefact-title">{title}</h4>
      <NotLive what={what} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Minting a link that is right
// ---------------------------------------------------------------------------

const DEFAULT_URL = 'https://shl.example.org/manifest/BOd6Y1sMxV0BThMOEmZjPUlQBHRPFrnv7BqDCM4ynqE';

function MintSection(): ReactNode {
  const firstSample = SAMPLE_PAYLOADS[0];
  const [sampleId, setSampleId] = useState<string>(firstSample?.id ?? 'custom');
  const [json, setJson] = useState<string>(() =>
    JSON.stringify(firstSample?.content ?? { resourceType: 'Patient' }, null, 2),
  );
  const [contentType, setContentType] = useState<string>(
    firstSample?.contentType ?? SHL_CONTENT_TYPES.fhir,
  );
  const [url, setUrl] = useState(DEFAULT_URL);
  const [label, setLabel] = useState('Minted by SHLoupe');
  const [flags, setFlags] = useState<FlagChoices>({ L: true, P: false, U: false });
  const [passcode, setPasscode] = useState('');
  const [expiryId, setExpiryId] = useState('day');
  const [compress, setCompress] = useState(false);
  const [ctyHeader, setCtyHeader] = useState(true);
  const [viewerPrefix, setViewerPrefix] = useState('');
  const [key, setKey] = useState(() => generateLinkKey());

  const [minted, setMinted] = useState<MintResult | undefined>(undefined);
  const [failure, setFailure] = useState<string | undefined>(undefined);
  const [working, setWorking] = useState(false);

  const parsed = useMemo(() => parsePayloadJson(json), [json]);
  const flagString = flagsFromChoices(flags);
  const conflictingFlags = flags.P && flags.U;
  const blocker = mintBlocker({
    jsonError: 'error' in parsed ? parsed.error : undefined,
    flags,
    passcode,
  });

  const mint = async (): Promise<void> => {
    if (!('content' in parsed)) return;
    setWorking(true);
    setFailure(undefined);
    try {
      const choice = EXPIRY_CHOICES.find((entry) => entry.id === expiryId) ?? EXPIRY_CHOICES[0];
      const exp = choice === undefined ? undefined : expiryEpochSeconds(choice, Date.now());
      const options: MintOptions = {
        content: parsed.content,
        contentType,
        url: url.trim(),
        key,
        compress,
        contentTypeHeader: ctyHeader,
        ...(label.trim() === '' ? {} : { label: label.trim() }),
        ...(exp === undefined ? {} : { exp }),
        ...(flagString === '' ? {} : { flags: flagString }),
        ...(viewerPrefix.trim() === '' ? {} : { viewerPrefix: viewerPrefix.trim() }),
        // Sent only when the flag that makes a receiver ask for one is set:
        // mintShl refuses the mismatched pair in either direction, and a
        // passcode left in the field after unticking P is the user's draft, not
        // an instruction. It is passed verbatim, never trimmed: silently
        // altering a secret is worse than minting a surprising one.
        ...(flags.P && passcode !== '' ? { passcode } : {}),
      };
      setMinted(await mintShl(options));
    } catch (error) {
      setMinted(undefined);
      setFailure(error instanceof Error ? error.message : 'The link could not be minted.');
    } finally {
      setWorking(false);
    }
  };

  return (
    <Panel title="Mint a link that works">
      <div className="mint">
        {/* First thing in the section, before a single field: the review's
            finding was that this read as a footnote, and it was one. */}
        <div className="mint-caveat tone tone-warn">
          <StatusIcon tone="warn" />
          <div className="mint-caveat-body prose">
            <strong>None of these links is real, and none of them can be opened.</strong>
            <p>
              A minted link carries the <code>url</code> exactly as typed below, and{' '}
              <code>example.org</code> is a reserved name that nothing answers on, here or anywhere
              else. So no viewer, SHLoupe included, can fetch what one of these points at.
            </p>
            <p>
              They are for two jobs. Paste one into another viewer to watch how it behaves before
              any network is involved, which is most of what a receiver gets wrong. Or open it in
              SHLoupe&rsquo;s own Offline mode with the manifest supplied by hand, which runs the
              whole pipeline end to end; there is a button for that under every minted link.
            </p>
          </div>
        </div>

        <fieldset className="mint-field mint-field-wide">
          <legend>What the encrypted file carries</legend>
          <div className="mint-samples">
            {SAMPLE_PAYLOADS.map((sample) => (
              <button
                key={sample.id}
                type="button"
                className="mint-sample"
                aria-pressed={sampleId === sample.id}
                onClick={() => {
                  setSampleId(sample.id);
                  setContentType(sample.contentType);
                  setJson(JSON.stringify(sample.content, null, 2));
                }}
              >
                <span className="mint-sample-name">{sample.label}</span>
                <span className="mint-sample-blurb">{sample.blurb}</span>
              </button>
            ))}
          </div>
          <label className="mint-label" htmlFor="mint-json">
            Payload JSON
          </label>
          <p className="mint-note">
            Edit one of the samples above, or paste your own over the top. It is minified before
            encryption, so the indentation here is only for reading.
          </p>
          <textarea
            id="mint-json"
            className="mint-json mono scroll-x"
            spellCheck={false}
            rows={10}
            value={json}
            onChange={(event) => {
              setSampleId('custom');
              setJson(event.target.value);
            }}
          />
          {'error' in parsed ? (
            <Callout tone="fail" title="This is not valid JSON yet">
              {parsed.error}
            </Callout>
          ) : null}
        </fieldset>

        <div className="mint-grid">
          <div className="mint-field">
            <label className="mint-label" htmlFor="mint-content-type">
              Content type
            </label>
            <select
              id="mint-content-type"
              className="mint-control"
              value={contentType}
              onChange={(event) => setContentType(event.target.value)}
            >
              {Object.entries(SHL_CONTENT_TYPES).map(([name, value]) => (
                <option key={name} value={value}>
                  {value}
                </option>
              ))}
            </select>
            <p className="mint-note">
              Goes in the manifest entry, and in the JWE <code>cty</code> header when that is on. A
              content type that disagrees with the bytes is a catalogue entry below.
            </p>
          </div>

          <div className="mint-field">
            <label className="mint-label" htmlFor="mint-expiry">
              Expiry
            </label>
            <select
              id="mint-expiry"
              className="mint-control"
              value={expiryId}
              onChange={(event) => setExpiryId(event.target.value)}
            >
              {EXPIRY_CHOICES.map((choice) => (
                <option key={choice.id} value={choice.id}>
                  {choice.label}
                </option>
              ))}
            </select>
            <p className="mint-note">
              Written as epoch seconds. A receiver may check it, and must not treat its absence as
              an expiry.
            </p>
          </div>

          <div className="mint-field mint-field-wide">
            <label className="mint-label" htmlFor="mint-url">
              Manifest URL, or with the U flag, the file URL
            </label>
            <input
              id="mint-url"
              className="mint-control opaque-value"
              type="text"
              spellCheck={false}
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
            <p className="mint-note">
              <code>example.org</code> is reserved and serves nothing, which is what makes these
              safe to hand around. The path should be long and unguessable, and the whole URL should
              stay under 128 characters.
            </p>
          </div>

          <div className="mint-field">
            <label className="mint-label" htmlFor="mint-label-field">
              Label
            </label>
            <input
              id="mint-label-field"
              className="mint-control"
              type="text"
              maxLength={200}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
            <p className="mint-note">
              80 characters at most, and it is read by a human before anything is decrypted, so it
              should carry no clinical detail. {label.trim().length} of 80 used.
            </p>
            {label.trim().length > 80 ? (
              <Callout tone="warn" title="Past the 80-character limit">
                A receiver may truncate or refuse this. That is a catalogue entry below, so mint it
                on purpose if that is what you are testing.
              </Callout>
            ) : null}
          </div>

          <div className="mint-field">
            <label className="mint-label" htmlFor="mint-viewer-prefix">
              Viewer prefix (optional)
            </label>
            <input
              id="mint-viewer-prefix"
              className="mint-control opaque-value"
              type="text"
              spellCheck={false}
              placeholder="https://viewer.example.org/#"
              value={viewerPrefix}
              onChange={(event) => setViewerPrefix(event.target.value)}
            />
            <p className="mint-note">
              End it with <code>#</code>. The payload carries the decryption key, so it belongs in a
              fragment, which is never sent to the viewer&rsquo;s own server.
            </p>
          </div>

          <fieldset className="mint-field">
            <legend>Flags</legend>
            <div className="mint-checks">
              {(
                [
                  ['L', 'L, long-term: the manifest may change, so a receiver may poll it.'],
                  ['P', 'P, passcode: the server refuses a manifest request without one.'],
                  ['U', 'U, one file: the url IS the encrypted file, fetched with GET.'],
                ] as const
              ).map(([letter, meaning]) => (
                <label key={letter} className="mint-check">
                  <input
                    type="checkbox"
                    checked={flags[letter]}
                    onChange={(event) =>
                      setFlags((current) => ({ ...current, [letter]: event.target.checked }))
                    }
                  />
                  <span>{meaning}</span>
                </label>
              ))}
            </div>
            {conflictingFlags ? (
              <Callout tone="fail" title="P and U cannot both be set">
                A U link is fetched with GET, and a GET has nowhere to carry a passcode. SHLoupe
                will still mint it, because a vector for exactly this exists in the catalogue below,
                and the passcode will come out with nowhere to send it, which is the contradiction
                made visible.
              </Callout>
            ) : null}
          </fieldset>

          <fieldset className="mint-field">
            <legend>Encoding</legend>
            <div className="mint-checks">
              <label className="mint-check">
                <input
                  type="checkbox"
                  checked={compress}
                  onChange={(event) => setCompress(event.target.checked)}
                />
                <span>
                  Compress: adds <code>zip: &quot;DEF&quot;</code> and raw DEFLATEs the payload.
                  Raw, with no zlib framing, which is the thing implementations get wrong.
                </span>
              </label>
              <label className="mint-check">
                <input
                  type="checkbox"
                  checked={ctyHeader}
                  onChange={(event) => setCtyHeader(event.target.checked)}
                />
                <span>
                  Emit the <code>cty</code> header. The prose asks for it and every example in the
                  implementation guide omits it, so turning it off reproduces real-world shapes.
                </span>
              </label>
            </div>
          </fieldset>

          {/* Only while the flag that demands it is set. A passcode field on a
              link with no P flag is a field nothing would ever read. */}
          {flags.P ? <PasscodeField value={passcode} onChange={setPasscode} /> : null}

          <div className="mint-field mint-field-wide">
            <span className="mint-label" id="mint-key-label">
              Content encryption key
            </span>
            <div className="mint-key" aria-labelledby="mint-key-label">
              <MintKey value={key} />
              <Button
                size="sm"
                onClick={() => {
                  setKey(generateLinkKey());
                  setMinted(undefined);
                }}
              >
                <RefreshCw size={13} aria-hidden />
                <span>New key</span>
              </Button>
            </div>
            <p className="mint-note">
              32 random bytes, base64url, 43 characters. It travels inside the link, so a link is a
              bearer credential: anyone holding it can decrypt the file.
            </p>
          </div>
        </div>

        {/* The action sits after the fields, not in the panel header: this form
            is taller than a screen, and a control above everything it acts on
            is one somebody has to scroll back up to find. */}
        <div className="mint-actions">
          <Button
            variant="primary"
            onClick={() => void mint()}
            disabled={working || blocker !== undefined}
            aria-describedby="mint-action-note"
          >
            <Wand size={14} aria-hidden />
            <span>{working ? 'Minting…' : 'Mint the link'}</span>
          </Button>
          <span
            className={blocker === undefined ? 'mint-note' : 'mint-note mint-note-blocked'}
            id="mint-action-note"
          >
            {blocker ?? 'Encrypted here in the tab, with Web Crypto. Nothing leaves the page.'}
          </span>
        </div>

        {failure === undefined ? null : (
          <Callout tone="fail" title="The link could not be minted">
            {failure}
          </Callout>
        )}

        {minted === undefined ? null : <MintedOutput minted={minted} />}
      </div>
    </Panel>
  );
}

/**
 * The key is the user's own, for a payload they just wrote, on their own screen,
 * so it is shown rather than withheld. Masked by default all the same, because
 * this screen gets projected.
 */
function MintKey({ value }: { value: string }): ReactNode {
  const revealDefault = useSettings((settings) => settings.revealSecrets);
  const [revealed, setRevealed] = useState(revealDefault);
  return (
    <Secret
      value={value}
      label="the minted key"
      revealed={revealed}
      onReveal={(next) => setRevealed(next)}
    />
  );
}

/**
 * The passcode, which the P flag has always claimed and until now had nowhere to
 * come from.
 *
 * Typed rather than generated, because a passcode is the one part of a share
 * that travels by voice or by a separate message, and something a person has to
 * read out loud is something they choose. Masked like the key field on the
 * Offline screen, and for the stronger reason: this is a field somebody types a
 * secret INTO while a room watches.
 */
function PasscodeField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}): ReactNode {
  const revealDefault = useSettings((settings) => settings.revealSecrets);
  const [revealed, setRevealed] = useState(revealDefault);
  const empty = value.trim() === '';

  return (
    <div className="mint-field mint-field-wide">
      <label className="mint-label" htmlFor="mint-passcode">
        <KeyRound size={12} aria-hidden /> Passcode (required by the P flag)
      </label>
      <div className="mint-passcode-row">
        <input
          id="mint-passcode"
          className="mint-control opaque-value"
          type={revealed ? 'text' : 'password'}
          spellCheck={false}
          autoComplete="off"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder="Spoken aloud, or sent by a separate message"
          aria-describedby="mint-passcode-note"
          aria-invalid={empty}
        />
        <Button size="sm" aria-pressed={revealed} onClick={() => setRevealed(!revealed)}>
          {revealed ? <EyeOff size={13} aria-hidden /> : <Eye size={13} aria-hidden />}
          <span className="visually-hidden">
            {revealed ? 'Hide the passcode' : 'Show the passcode'}
          </span>
        </Button>
      </div>
      <p className="mint-note" id="mint-passcode-note">
        A receiver sends this in the manifest POST body as <code>passcode</code>, beside{' '}
        <code>recipient</code>. It is never inside the link and never in the manifest, so you have
        to hand it over separately, which is the whole point of it. Every wrong attempt is charged
        against a lifetime limit that permanently disables the link, so a conformant server counts
        them and says how many are left.
      </p>
      {empty ? (
        <Callout tone="warn" title="This link cannot be minted without it">
          The P flag tells a receiver to ask for a passcode. Type the one this link should demand,
          or untick P.
        </Callout>
      ) : null}
    </div>
  );
}

/**
 * Every member of `ShlPayload` is typed `unknown`, deliberately: it is the shape
 * a decoded link arrives in, and nothing about a stranger's payload can be
 * assumed. The mint wrote these members a moment ago, but reading them through
 * narrowing helpers rather than a cast keeps that convenience from becoming an
 * assumption the type system is quietly carrying.
 */
function asText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function MintedOutput({ minted }: { minted: MintResult }): ReactNode {
  const qrValue = minted.viewerLink ?? minted.shlink;
  const exp = asNumber(minted.payload.exp);
  const rows: FieldRow[] = [
    { key: 'url', value: asText(minted.payload.url) ?? 'not set' },
    { key: 'flag', value: asText(minted.payload.flag) ?? 'none set' },
    {
      key: 'exp',
      value: exp === undefined ? 'no exp member' : `${exp} (${new Date(exp * 1000).toISOString()})`,
    },
    { key: 'label', value: asText(minted.payload.label) ?? 'none set' },
    {
      key: 'kid',
      value: minted.kid,
      note: 'The RFC 7638 thumbprint of the key as an oct JWK. A receiver can prove a key mismatch from this alone, with no decryption attempt.',
    },
    {
      key: 'plaintext',
      value: formatBytes(minted.plaintextBytes),
      note: minted.compressed
        ? 'Raw DEFLATEd before encryption, so the ciphertext below is smaller than the plaintext.'
        : undefined,
    },
    { key: 'file', value: `${formatBytes(minted.ciphertextBytes)} of compact JWE` },
    { key: 'content type', value: minted.file.contentType },
  ];

  const direct = minted.manifest === undefined;

  return (
    <div className="mint-output">
      <h3>What came out</h3>

      <div className="mint-artefact">
        <ArtefactHead title="The minted link" what="This link" />
        <CodeBlock language="text" maxHeight={160}>
          {minted.shlink}
        </CodeBlock>
      </div>

      {minted.viewerLink === undefined ? null : (
        <div className="mint-artefact">
          <ArtefactHead title="With the viewer prefix" what="This link" />
          <CodeBlock language="text" maxHeight={160}>
            {minted.viewerLink}
          </CodeBlock>
        </div>
      )}

      <div className="mint-output-split">
        <div className="mint-output-facts">
          <FieldTable rows={rows} dense />
          <div className="mint-output-actions">
            <Button variant="primary" onClick={() => navigate(handoffForMint(minted))}>
              <WifiOff size={14} aria-hidden />
              <span>{direct ? 'Open the file offline' : 'Open offline, manifest supplied'}</span>
            </Button>
            <Button onClick={() => navigate(hashForLink(minted.shlink))}>
              <ExternalLink size={14} aria-hidden />
              <span>Open the link alone in SHLoupe</span>
            </Button>
          </div>
          <p className="mint-note">
            The first runs the whole pipeline over these bytes, with{' '}
            {direct ? 'the file and its key' : 'the manifest below'} already in the boxes and no
            request at any step. The second navigates to the link and nothing else, so it shows
            every check that happens before the network and then a failed fetch, which is true and
            is not the link being wrong.
          </p>
        </div>
        <QrCode
          value={qrValue}
          caption={
            <>
              {minted.viewerLink === undefined
                ? 'The bare shlink, which is what a QR normally carries.'
                : 'The viewer-prefixed form, since that is what you supplied a prefix for.'}{' '}
              <NotLive what="This code" />
            </>
          }
        />
      </div>

      {minted.passcode === undefined ? null : (
        <PasscodeOutput passcode={minted.passcode} direct={direct} />
      )}

      {direct ? (
        <Callout tone="info" title="A U link has no manifest">
          The <code>url</code> is the encrypted file itself. There is one GET, a{' '}
          <code>recipient</code> query parameter on it, and no manifest to serve.
        </Callout>
      ) : (
        <Disclosure
          summary="The manifest a server would serve"
          meta={<NotLive what="This manifest" />}
        >
          <CodeBlock language="json">{JSON.stringify(minted.manifest, null, 2)}</CodeBlock>
        </Disclosure>
      )}

      <Disclosure summary="The encrypted file, as compact JWE" meta={<NotLive what="This file" />}>
        <CodeBlock language="text">{minted.file.jwe}</CodeBlock>
      </Disclosure>

      <p className="mint-note prose">
        Either button leaves this screen, and the mint is not kept when you come back, so copy
        anything you still need first.
      </p>
    </div>
  );
}

/**
 * The passcode as artefacts, which is the part that has no home in the link.
 *
 * A passcode is not a member of anything the sender publishes: it is held by the
 * server and compared against a request. So what can be handed over is the
 * secret itself, out of band, plus the exchange it takes part in, and the
 * refusal a conformant server owes when it does not match.
 */
function PasscodeOutput({
  passcode,
  direct,
}: {
  passcode: MintedPasscode;
  direct: boolean;
}): ReactNode {
  const revealDefault = useSettings((settings) => settings.revealSecrets);
  const [revealed, setRevealed] = useState(revealDefault);

  return (
    <div className="mint-passcode-out">
      <ArtefactHead title="The passcode, and how it is spent" what="This passcode" />
      {/*
        Not the shared `Secret`, and this is the reason rather than a preference.
        That primitive masks the middle and shows four characters at each end,
        which is right for a 43-character key and useless for a passcode:
        "gumnut-42" comes out as "gumn•t-42". A passcode is short by design,
        because somebody reads it out, so the mask has to cover all of it.
      */}
      <div className="mint-passcode-value">
        <span className="opaque-value">
          {revealed ? passcode.value : '•'.repeat(Math.min(passcode.value.length, 12))}
        </span>
        <Button size="sm" aria-pressed={revealed} onClick={() => setRevealed(!revealed)}>
          {revealed ? <EyeOff size={13} aria-hidden /> : <Eye size={13} aria-hidden />}
          <span className="visually-hidden">
            {revealed ? 'Hide the minted passcode' : 'Reveal the minted passcode'}
          </span>
        </Button>
        <CopyButton value={passcode.value} label="Copy" />
      </div>
      <p className="mint-note prose">
        This travels to the receiver some other way: spoken, or in a separate message. It is not in
        the link, so anybody who intercepts the link alone still cannot request the manifest.
      </p>

      {passcode.requestBody === undefined ? (
        <Callout tone="fail" title="There is nowhere to send this one">
          The U flag makes the <code>url</code> the encrypted file itself, fetched with a GET, so
          there is no manifest request and no body to put a passcode in. That is why P and U
          contradict each other, and it is the catalogue&rsquo;s <code>flag-u-and-p</code> entry.
        </Callout>
      ) : (
        <>
          <p className="mint-note prose">
            A receiver POSTs it to the <code>url</code> as the <code>passcode</code> member of the
            manifest request body, with <code>content-type: application/json</code>. The{' '}
            <code>recipient</code> member beside it is the receiver&rsquo;s own name for itself,
            which is why it is a placeholder below.
          </p>
          {/* Behind a disclosure because the body necessarily carries the
              passcode in the clear, and masking the value above buys nothing if
              the same characters sit in an open code block underneath it on a
              projected screen. */}
          <Disclosure summary="The manifest request body, with the passcode in it">
            <CodeBlock language="json">{passcode.requestBody}</CodeBlock>
          </Disclosure>
        </>
      )}

      {direct ? null : (
        <Disclosure summary="What the server owes on a wrong attempt">
          <p className="mint-note prose">
            401, with a JSON body naming how many attempts are left. The member name is exact:{' '}
            <code>attemptsRemaining</code> and <code>remaining_attempts</code> are read by nothing,
            and a receiver that cannot see the count cannot warn anybody before the attempt that
            permanently disables the link. A vector for a 401 that omits it is in the catalogue
            below.
          </p>
          <CodeBlock language="json">{PASSCODE_REJECTION_BODY}</CodeBlock>
          <p className="mint-note prose">
            The manifest above is what a server serves once the passcode MATCHED. SHLoupe&rsquo;s
            offline transport serves the bytes it was handed without reading the request body, so an
            offline run cannot check a passcode: it shows the accepted case.
          </p>
        </Disclosure>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The broken catalogue
// ---------------------------------------------------------------------------

function CatalogueSection(): ReactNode {
  const [built, setBuilt] = useState<Map<string, BrokenArtefacts>>(() => new Map());
  const [failure, setFailure] = useState<string | undefined>(undefined);

  useEffect(() => {
    // An AbortController rather than a captured boolean flag: `signal.aborted`
    // is read from an object, so neither the typechecker nor a lint rule can
    // decide the guard is dead code, which is what happens to the flag idiom.
    const controller = new AbortController();
    void (async () => {
      const next = new Map<string, BrokenArtefacts>();
      try {
        // Built at the current time, not at a frozen one, so the expired link
        // is a week before today rather than a week before whenever this
        // catalogue was written.
        for (const preset of BROKEN_PRESETS) next.set(preset.id, await preset.build());
      } catch (error) {
        if (!controller.signal.aborted) {
          setFailure(
            error instanceof Error
              ? error.message
              : 'The catalogue could not be built in this browser.',
          );
        }
      }
      if (!controller.signal.aborted) setBuilt(next);
    })();
    return () => controller.abort();
  }, []);

  return (
    <Panel title="Links that are wrong on purpose">
      <div className="catalogue">
        {/*
          The framing, as the section's own opening statement rather than as one
          callout among several. It is the single thing somebody has to
          understand before the cards mean anything: the expected result of a
          good test here is a refusal.
        */}
        <div className="catalogue-thesis">
          <h3 className="catalogue-thesis-title">A red result here is a pass</h3>
          <p className="prose">
            Every one of the {BROKEN_PRESETS.length} links below breaks exactly one rule and says
            which. Hand one to the viewer you are testing: the vector worked if that viewer refused
            the link and named the reason. A viewer that opens one of these, or that reports
            something unrelated, is the finding you came for.
          </p>
          <ol className="catalogue-steps prose">
            <li>
              <strong>Take one link.</strong> Copy it from the card, or show its QR code to a phone.
            </li>
            <li>
              <strong>Give it to the viewer under test</strong>, and write down what it said.
            </li>
            <li>
              <strong>Compare that against the card.</strong> Each one states what a conformant
              receiver should do, which is the thing being tested, and separately what SHLoupe
              itself raises.
            </li>
          </ol>
          <p className="catalogue-thesis-note prose">
            SHLoupe&rsquo;s own reading of every entry is run through the real pipeline by{' '}
            <code>mint.test.ts</code>, so the rule ids on the cards are what actually fires. Where
            SHLoupe raises nothing, the card records that as a gap with the reason rather than
            dressing it up as a check. These links are test vectors like the minted ones: the hosts
            in them serve nothing, and the outcome on each card is what SHLoupe reaches with the
            bytes a server would have served supplied, which is what the offline button on the card
            does.
          </p>
        </div>

        {failure === undefined ? null : (
          <Callout tone="fail" title="The catalogue could not be built">
            {failure} Every entry is encrypted here in the tab, so this usually means Web Crypto is
            unavailable, which happens when the page is not a secure context.
          </Callout>
        )}

        {/* A build that threw part-way still shows what it managed, beside the
            failure. An empty map with a failure shows only the failure: a wall
            of nineteen cards each saying "building…" forever would be worse
            than the honest single message. */}
        {built.size > 0 ? (
          <ul className="preset-list">
            {BROKEN_PRESETS.map((preset) => (
              <li key={preset.id}>
                <PresetCard preset={preset} artefacts={built.get(preset.id)} />
              </li>
            ))}
          </ul>
        ) : failure === undefined ? (
          <p className="catalogue-waiting">
            <StatusIcon tone="running" /> Encrypting {BROKEN_PRESETS.length} test vectors…
          </p>
        ) : null}
      </div>
    </Panel>
  );
}

function PresetCard({
  preset,
  artefacts,
}: {
  preset: BrokenPreset;
  artefacts: BrokenArtefacts | undefined;
}): ReactNode {
  const outcome = describeOutcome(preset.expect.outcome);
  const offline = artefacts === undefined ? undefined : handoffForPreset(artefacts);

  return (
    <article className="preset">
      <header className="preset-head">
        <h3>
          <Beaker size={15} aria-hidden />
          {preset.title}
        </h3>
        {/* Labelled, because "Opens" on its own reads as a prediction about
            the button below it. It is not: it is what SHLoupe reaches when the
            bytes a server would have served are supplied, which is how
            mint.test.ts runs every one of these. */}
        <div className="preset-verdict">
          <span className="preset-verdict-label">SHLoupe reaches</span>
          <StatusIcon tone={outcome.tone} />
          <Chip tone={outcome.tone}>{outcome.word}</Chip>
        </div>
      </header>

      <p className="preset-wrong">{preset.wrong}</p>

      {/* The card's payload: what is being tested. Given its own surface rather
          than a row in a definition list, because it is the sentence somebody
          reads their own viewer's behaviour against. */}
      <div className="preset-should">
        <span className="preset-should-label">A conformant receiver should</span>
        <p>{preset.receiverShould}</p>
      </div>

      <dl className="preset-meta">
        <dt>SHLoupe raises</dt>
        <dd>
          {preset.expect.ruleIds.length === 0 ? (
            <span className="preset-gap">Nothing. {preset.expect.gap ?? ''}</span>
          ) : (
            <>
              <span className="preset-rules">
                {preset.expect.ruleIds.map((ruleId) => (
                  <code key={ruleId}>{ruleId}</code>
                ))}
              </span>
              <span className="preset-source">
                checked in <code>{preset.expect.source}</code>
              </span>
            </>
          )}
        </dd>
        {preset.expect.payloadMembers === undefined ||
        preset.expect.payloadMembers.length === 0 ? null : (
          <>
            <dt>Members flagged</dt>
            <dd>
              <span className="preset-rules">
                {preset.expect.payloadMembers.map((member) => (
                  <code key={member}>{member}</code>
                ))}
              </span>
            </dd>
          </>
        )}
        {artefacts?.passcode === undefined ? null : (
          <>
            <dt>Passcode</dt>
            <dd>
              {/* Wrapped the way the rule ids are, so the note after it keeps
                  the same gap rather than butting against the code. */}
              <span className="preset-rules">
                <code>{artefacts.passcode}</code>
              </span>
              <span className="preset-source">
                sent in the manifest POST body, which is the only place one goes
              </span>
            </dd>
          </>
        )}
      </dl>

      {artefacts === undefined ? (
        <p className="preset-waiting">
          <StatusIcon tone="running" /> Building this one…
        </p>
      ) : (
        <>
          <div className="preset-artefact">
            <ArtefactHead title="The link" what="This link" />
            <CodeBlock language="text" maxHeight={120}>
              {artefacts.shlink}
            </CodeBlock>
          </div>
          <div className="preset-actions">
            <Button onClick={() => navigate(hashForLink(artefacts.shlink))}>
              <ExternalLink size={13} aria-hidden />
              <span>Open the link in SHLoupe</span>
            </Button>
            {offline === undefined ? null : (
              <Button onClick={() => navigate(offline)}>
                <WifiOff size={13} aria-hidden />
                <span>Open it offline, bytes supplied</span>
              </Button>
            )}
          </div>
          <p className="preset-reach">{reachSentence(preset.expect.outcome, artefacts)}</p>
          {/* The marker rides the caption INSIDE the figure rather than the
              disclosure head: a QR code leaves this page as a photograph of the
              symbol, and a marker on the row above it is not in that frame. */}
          <Disclosure summary="Show the QR code">
            <QrCode
              value={artefacts.shlink}
              caption={
                <>
                  {preset.title} <NotLive what="This code" />
                </>
              }
            />
          </Disclosure>
          {artefacts.manifest === undefined ? null : (
            <Disclosure
              summary="The manifest a server would serve"
              meta={<NotLive what="This manifest" />}
            >
              <CodeBlock language="json">{JSON.stringify(artefacts.manifest, null, 2)}</CodeBlock>
            </Disclosure>
          )}
          {artefacts.jwe === undefined ? null : (
            <Disclosure
              summary="The encrypted file, as compact JWE"
              meta={<NotLive what="This file" />}
            >
              <CodeBlock language="text">{artefacts.jwe}</CodeBlock>
            </Disclosure>
          )}
        </>
      )}
    </article>
  );
}
