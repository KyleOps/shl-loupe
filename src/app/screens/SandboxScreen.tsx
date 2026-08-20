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
 * The honest caveat lives on this screen and not in a footnote: a minted link's
 * `url` points at a host that serves nothing, so opening it here gets every
 * check that happens before the network and then a failed fetch. That is stated
 * where the expectation forms, next to the minted link, rather than left for
 * somebody to discover.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Beaker, ExternalLink, RefreshCw, Wand } from 'lucide-react';
import { formatBytes } from '../../core/bytes';
import {
  BROKEN_PRESETS,
  generateLinkKey,
  mintShl,
  SAMPLE_PAYLOADS,
  SHL_CONTENT_TYPES,
  type BrokenArtefacts,
  type BrokenPreset,
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
  Disclosure,
  FieldTable,
  Panel,
  Secret,
  StatusIcon,
  type FieldRow,
  type Tone,
} from '../../ui/primitives';
import { hashForLink, navigate } from '../router';
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
 * What "Open in Loupe" will actually show for a given preset, which is not the
 * same question for all nineteen of them.
 *
 * Two independent facts decide it. A preset whose expected outcome is `blocked`
 * is answered from the link alone, so no request is issued and the demonstration
 * is complete; that is the product thesis and worth saying out loud. Separately,
 * a preset carrying a manifest or a file has its fault in bytes a server would
 * have served, and Loupe has no server, so the fault is only reachable by
 * pasting those bytes into the Offline screen.
 *
 * Getting this wrong in either direction wastes somebody's minute: promising a
 * clean diagnosis that ends in a fetch error, or sending them to Offline mode
 * for a link that needed no server at all.
 */
export function reachSentence(outcome: RunOutcome, artefacts: BrokenArtefacts): string {
  if (outcome === 'blocked') {
    return 'Loupe answers this one from the link alone, with no request issued at all. That is the whole demonstration: a receiver that has to make a request to find this out is a receiver spending a round trip on a question it could already answer.';
  }
  if (artefacts.manifest === undefined && artefacts.jwe === undefined) {
    return 'The fault is in the link, so it is reported before the fetch. The fetch then fails too, because the host serves nothing; both appear in the trace, in that order.';
  }
  return 'The fault is in bytes a server would have served, and Loupe has no server, so opening the link alone stops at the failed fetch. Copy the manifest or the file below into the Offline screen to reach it.';
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

export function SandboxScreen(): ReactNode {
  return (
    <div className="sandbox">
      <section className="sandbox-lede">
        <h1>Make links, correct and broken, to test something else.</h1>
        <p>
          Everything here is produced in this tab, by the same encrypter Loupe uses to read a link,
          so a defect in one direction shows up in the other rather than cancelling itself out.
          Nothing is uploaded, and nothing is stored.
        </p>
      </section>
      <MintSection />
      <CatalogueSection />
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
  const [label, setLabel] = useState('Minted by Loupe');
  const [flags, setFlags] = useState<FlagChoices>({ L: true, P: false, U: false });
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
              <code>example.org</code> is reserved and serves nothing, which is deliberate: see the
              caveat under the minted link. The path should be long and unguessable, and the whole
              URL should stay under 128 characters.
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
                A U link is fetched with GET, and a GET has nowhere to carry a passcode. Loupe will
                still mint it, because a vector for exactly this exists in the catalogue below, but
                a sender has to drop one of the two.
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
            disabled={working || 'error' in parsed}
          >
            <Wand size={14} aria-hidden />
            <span>{working ? 'Minting…' : 'Mint the link'}</span>
          </Button>
          <span className="mint-note">
            Encrypted here in the tab, with Web Crypto. Nothing leaves the page.
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

  return (
    <div className="mint-output">
      <h3>The minted link</h3>
      <CodeBlock language="text" maxHeight={160}>
        {minted.shlink}
      </CodeBlock>
      {minted.viewerLink === undefined ? null : (
        <>
          <h4>With the viewer prefix</h4>
          <CodeBlock language="text" maxHeight={160}>
            {minted.viewerLink}
          </CodeBlock>
        </>
      )}

      <div className="mint-output-split">
        <div className="mint-output-facts">
          <FieldTable rows={rows} dense />
          <div className="mint-output-actions">
            <Button variant="primary" onClick={() => navigate(hashForLink(minted.shlink))}>
              <ExternalLink size={14} aria-hidden />
              <span>Open this in Loupe</span>
            </Button>
          </div>
        </div>
        <QrCode
          value={qrValue}
          caption={
            minted.viewerLink === undefined
              ? 'The bare shlink, which is what a QR normally carries.'
              : 'The viewer-prefixed form, since that is what you supplied a prefix for.'
          }
        />
      </div>

      <Callout tone="warn" title="This link points at a host that serves nothing">
        <p>
          Loupe has no server. The <code>url</code> above is a real, parseable address that nothing
          is listening on, so opening the link here runs every check that happens before the network
          (decoding, each payload member, the URL, the flags, the expiry) and then reports a failed
          fetch. That failure is true, and it is not the link being wrong.
        </p>
        <p>Two ways to see the whole path instead:</p>
        <ul>
          <li>
            Paste the link into the <a href="#/offline">Offline screen</a> along with the manifest
            or the file below. It runs the same pipeline over bytes you supply, with the network
            untouched.
          </li>
          <li>
            Put the encrypted file somewhere real that sends{' '}
            <code>Access-Control-Allow-Origin</code>, and mint with the U flag pointing at it. A U
            link is one GET with no manifest and no preflight, which is why the implementation
            guide&rsquo;s own examples are the only links a browser-only viewer can rely on.
          </li>
        </ul>
        <p>
          Opening the link leaves this screen, and the mint is not kept when you come back, so copy
          anything you still need first.
        </p>
      </Callout>

      {minted.manifest === undefined ? (
        <Callout tone="info" title="A U link has no manifest">
          The <code>url</code> is the encrypted file itself. There is one GET, a{' '}
          <code>recipient</code> query parameter on it, and no manifest to serve.
        </Callout>
      ) : (
        <Disclosure summary="The manifest a server would serve">
          <CodeBlock language="json">{JSON.stringify(minted.manifest, null, 2)}</CodeBlock>
        </Disclosure>
      )}

      <Disclosure summary="The encrypted file, as compact JWE">
        <CodeBlock language="text">{minted.file.jwe}</CodeBlock>
      </Disclosure>
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
        <Callout tone="info" title="A red result here is a pass">
          <p>
            These exist to test somebody else&rsquo;s viewer. Each link breaks exactly one rule and
            says which, so you can hand one over and see whether the receiver notices. The vector
            worked if the receiver refused the link and named the reason; a viewer that opens one of
            these, or that reports something unrelated, is the finding you came for.
          </p>
          <p>
            Loupe&rsquo;s own reading of every entry is run through the real pipeline by{' '}
            <code>mint.test.ts</code>, so the rule ids below are what actually fires. Where Loupe
            raises nothing, that is recorded as a gap with the reason, not dressed up as a check.
          </p>
          <p>
            The outcome on each card is what Loupe reaches with the bytes a server would have served
            supplied, which is how that test runs them. Pressing <strong>Open in Loupe</strong>{' '}
            navigates to the link and nothing else, so each card also says what the link alone will
            show.
          </p>
        </Callout>

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
  return (
    <article className="preset">
      <header className="preset-head">
        <h3>
          <Beaker size={15} aria-hidden />
          {preset.title}
        </h3>
        {/* Labelled, because "Opens" on its own reads as a prediction about
            the button below it. It is not: it is what Loupe reaches when the
            bytes a server would have served are supplied, which is how
            mint.test.ts runs every one of these. */}
        <div className="preset-verdict">
          <span className="preset-verdict-label">Loupe reaches</span>
          <StatusIcon tone={outcome.tone} />
          <Chip tone={outcome.tone}>{outcome.word}</Chip>
        </div>
      </header>

      <dl className="preset-facts">
        <dt>What is wrong</dt>
        <dd>{preset.wrong}</dd>
        <dt>A conformant receiver should</dt>
        <dd>{preset.receiverShould}</dd>
        <dt>Loupe raises</dt>
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
            <dt>Members the table must flag</dt>
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
              <code>{artefacts.passcode}</code>
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
          <CodeBlock language="text" maxHeight={120}>
            {artefacts.shlink}
          </CodeBlock>
          <div className="preset-actions">
            <Button onClick={() => navigate(hashForLink(artefacts.shlink))}>
              <ExternalLink size={13} aria-hidden />
              <span>Open in Loupe</span>
            </Button>
          </div>
          <p className="preset-reach">{reachSentence(preset.expect.outcome, artefacts)}</p>
          <Disclosure summary="Show the QR code">
            <QrCode value={artefacts.shlink} caption={preset.title} />
          </Disclosure>
          {artefacts.manifest === undefined ? null : (
            <Disclosure summary="The manifest a server would serve">
              <CodeBlock language="json">{JSON.stringify(artefacts.manifest, null, 2)}</CodeBlock>
            </Disclosure>
          )}
          {artefacts.jwe === undefined ? null : (
            <Disclosure summary="The encrypted file, as compact JWE">
              <CodeBlock language="text">{artefacts.jwe}</CodeBlock>
            </Disclosure>
          )}
        </>
      )}
    </article>
  );
}
