/**
 * The primary screen: paste a link, watch every step, read the payload.
 *
 * The layout is the argument. A fixed three-pane grid puts a large empty
 * payload pane next to a failed trace, and an empty pane reads as the tool
 * having failed rather than as the link having failed, which is precisely the
 * misattribution this whole project exists to stop. So the widths follow the
 * verdict: when nothing opened, the trace is the hero and the payload pane
 * spends its space explaining what it is missing and offering a link that
 * works; when something opened, the payload takes the majority and the trace
 * narrows to a column you can still scan.
 *
 * Everything in the LINK pane is read out of the recorded run rather than out
 * of the finished result, so the pane is populated from the first step onwards
 * instead of staying blank for the fifteen seconds a slow manifest takes.
 */
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { clsx } from 'clsx';
import {
  ArrowRight,
  FileText,
  FileWarning,
  GraduationCap,
  Lightbulb,
  OctagonAlert,
  RotateCcw,
  ShieldCheck,
} from 'lucide-react';
import type { OpenedFile } from '../../core/pipeline';
import type { KvRow, RunOutcome, TraceRun } from '../../core/trace';
import { toneForStatus } from '../../ui/primitives';
import {
  Button,
  Callout,
  Chip,
  CodeBlock,
  Disclosure,
  EmptyState,
  FieldTable,
  Panel,
  Secret,
  type FieldRow,
  type Tone,
} from '../../ui/primitives';
import { TraceList, VerdictBanner } from '../../ui/trace';
import { VariantBadge } from '../../ui/VariantBadge';
import { ProfileChecks } from '../../ui/ProfileChecks';
import type { VariantIdentification } from '../../core/variants';
import type { ProfileConformance } from '../../core/profiles';
/*
 * The FHIR renderers are loaded when something has actually opened.
 *
 * They are the largest thing in the app, they render exactly one thing (a
 * payload), and nothing can be rendered until a fetch and a decryption have both
 * finished, which is orders of magnitude slower than fetching a local chunk. So
 * shipping them in the first bundle only delays the trace, which is the screen a
 * failing link needs.
 */
const PayloadView = lazy(async () => ({
  default: (await import('../../ui/fhir')).PayloadView,
}));
import type { Runner } from '../App';
import { PasscodePrompt } from '../PasscodePrompt';
import { navigate, parseHash } from '../router';
import { useSession, useSettings } from '../store';

// ---------------------------------------------------------------------------
// Samples
// ---------------------------------------------------------------------------

/**
 * What opening a sample ends in. Three samples exist because there are three
 * endings, and the card says which one it is: a reader who cannot tell them
 * apart has no reason to press one rather than another.
 */
export type SampleEnding = 'document' | 'card' | 'diagnosis';

export interface Sample {
  id: string;
  name: string;
  /** One line: what it is and where it came from. */
  blurb: string;
  /** One line: why you would reach for this one rather than the other two. */
  teaches: string;
  /** Where it ends up, which is the difference between the three. */
  ending: SampleEnding;
  /** The words for that ending, on the card. */
  endingWord: string;
  input: string;
}

/**
 * One-click links, because the teaching use is somebody walking a room through
 * a correct link and they need one keystroke to get there.
 *
 * The first is the IG's own `U`-flag example, verbatim. The second is built from
 * the same example page's second entry: its URL and key are the IG's, verified
 * to serve a five-part JWE carrying the same `kid`, and only the label is ours.
 * Both use the specification's public demo key, so nothing behind them is
 * confidential. The third is synthesised, and is the motivating case: a link
 * that can only ever open on the machine that minted it, which SHLoupe says
 * without making a request.
 */
export const SAMPLES: Sample[] = [
  {
    id: 'ips',
    name: 'IPS document',
    blurb:
      'The first working example on the implementation guide’s own page, unmodified. Its LU flags mean one file fetched by GET, with no manifest requested.',
    teaches:
      'The happy path end to end over a real network, finishing in a 20-entry patient summary.',
    ending: 'document',
    endingWord: 'Opens a document',
    input:
      'https://viewer.tcpdev.org/shlink.html#shlink:/eyJ1cmwiOiJodHRwczovL3Jhdy5naXRodWJ1c2VyY29udGVudC5jb20vc2Vhbm5vL3NoYy1kZW1vLWRhdGEvbWFpbi9pcHMvSVBTX0lHLWJ1bmRsZS0wMS1lbmMudHh0IiwiZmxhZyI6IkxVIiwia2V5IjoicnhUZ1lsT2FLSlBGdGNFZDBxY2NlTjh3RVU0cDk0U3FBd0lXUWU2dVg3USIsImxhYmVsIjoiRGVtbyBTSEwgZm9yIElQU19JRy1idW5kbGUtMDEifQ',
  },
  {
    id: 'shc',
    name: 'Signed health card',
    blurb:
      'The guide’s second example, a CARIN insurance card. After decryption there is a compact JWS, so its signature is checked against the issuer’s key set.',
    teaches:
      'That a link, a card and a signature are three separate things, and which of them a failure belongs to.',
    ending: 'card',
    endingWord: 'Opens a card, checks its signature',
    input:
      'shlink:/eyJ1cmwiOiJodHRwczovL3Jhdy5naXRodWJ1c2VyY29udGVudC5jb20vc2Vhbm5vL3NoYy1kZW1vLWRhdGEvbWFpbi9jYXJkcy9jYXJpbi1pbnN1cmFuY2UtZXhhbXBsZS9qd3MudHh0IiwiZmxhZyI6IkxVIiwia2V5IjoicnhUZ1lsT2FLSlBGdGNFZDBxY2NlTjh3RVU0cDk0U3FBd0lXUWU2dVg3USIsImxhYmVsIjoiRGVtbyBTSEwgZm9yIGNhcmluLWluc3VyYW5jZS1leGFtcGxlIn0',
  },
  {
    id: 'localhost',
    name: 'A link that cannot work',
    blurb:
      'Synthesised, and the case this tool exists for: the manifest URL points at the sender’s own laptop, so it opened for them and can open for nobody else.',
    teaches:
      'What SHLoupe settles from the link alone, naming the rule it breaks before any request is made.',
    ending: 'diagnosis',
    endingWord: 'Diagnosed, no request made',
    input:
      'shlink:/eyJ1cmwiOiJodHRwczovL2xvY2FsaG9zdDo1MTczL2FwaS9zaGwtbWFuaWZlc3Q_YmlkPTQ4MzY0NzAiLCJrZXkiOiJyeFRnWWxPYUtKUEZ0Y0VkMHFjY2VOOHdFVTRwOTRTcUF3SVdRZTZ1WDdRIiwiZmxhZyI6IkxQIiwibGFiZWwiOiJNaWEncyBzdW1tYXJ5IiwiZXhwIjoxNzg3Nzg4ODAwfQ',
  },
];

// ---------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------

export type PaneLayout = 'trace-first' | 'payload-first';

/** Which pane earns the space. A run still in flight is a trace to watch. */
export function paneLayoutFor(outcome: RunOutcome): PaneLayout {
  return outcome === 'opened' || outcome === 'partial' ? 'payload-first' : 'trace-first';
}

export type LayoutMode = 'wide' | 'tabs' | 'stack';

/**
 * The two breakpoints, and they are duplicated in screens.css because CSS
 * cannot read a constant out of TypeScript. Change one, change the other: a
 * tab bar rendered while the grid is still three columns wide is the failure.
 */
export function layoutModeForWidth(width: number): LayoutMode {
  if (width < 700) return 'stack';
  if (width < 1100) return 'tabs';
  return 'wide';
}

export interface StopPoint {
  number: number;
  title: string;
}

/** The first step that could not complete, numbered as the trace numbers it. */
export function stoppedAt(run: TraceRun): StopPoint | undefined {
  const index = run.steps.findIndex((step) => step.status === 'fail' || step.status === 'blocked');
  const step = run.steps[index];
  return step === undefined ? undefined : { number: index + 1, title: step.title };
}

export interface LinkFacts {
  /** The decoded payload, as recorded by the decode step. */
  payload?: Record<string, unknown>;
  /** The per-member conformance table, as recorded by the validate step. */
  memberRows: KvRow[];
  /** The URL taken apart, as recorded by the static analysis step. */
  urlRows: KvRow[];
}

/**
 * Read the link facts back out of the run.
 *
 * Deliberately sourced from the trace rather than from `PipelineResult.link`:
 * the result exists only once the whole run has finished, and a pane that stays
 * empty until the last hop returns is a pane that is blank exactly when
 * somebody is waiting and wants something to read.
 */
export function linkFactsFromRun(run: TraceRun | undefined): LinkFacts {
  const facts: LinkFacts = { memberRows: [], urlRows: [] };
  if (!run) return facts;
  for (const step of run.steps) {
    for (const evidence of step.evidence) {
      if (
        step.kind === 'shlink.decode' &&
        evidence.type === 'json' &&
        typeof evidence.value === 'object' &&
        evidence.value !== null
      ) {
        facts.payload = evidence.value as Record<string, unknown>;
      }
      if (step.kind === 'shlink.validate' && evidence.type === 'kv') {
        facts.memberRows = evidence.rows;
      }
      if (step.kind === 'static.analyse' && evidence.type === 'kv') {
        facts.urlRows = evidence.rows;
      }
    }
  }
  return facts;
}

export interface FlagNote {
  letter: string;
  name: string;
  meaning: string;
  recognised: boolean;
}

const FLAGS: Record<string, { name: string; meaning: string }> = {
  L: {
    name: 'Long-term',
    meaning:
      'The manifest may change over time, so a receiver may poll it. Nothing about opening the link changes.',
  },
  P: {
    name: 'Passcode required',
    meaning:
      'The server rejects a manifest request that carries no passcode. This flag cannot be ignored, and every wrong attempt is counted for the life of the link.',
  },
  U: {
    name: 'One file, no manifest',
    meaning:
      'The url is the encrypted file itself, fetched with GET and a recipient query parameter. A receiver must not request a manifest.',
  },
};

/** Every letter in the flag string, named. An unknown letter is shown, not failed. */
export function describeFlags(flag: string | undefined): FlagNote[] {
  if (flag === undefined || flag.length === 0) return [];
  return [...flag].map((letter) => {
    const known = FLAGS[letter];
    return known === undefined
      ? {
          letter,
          name: 'Not a defined flag',
          meaning:
            'The specification requires a receiver to ignore a flag letter it does not recognise, so SHLoupe shows it and carries on.',
          recognised: false,
        }
      : { letter, name: known.name, meaning: known.meaning, recognised: true };
  });
}

/**
 * The one flag combination the specification forbids outright. Worth its own
 * sentence because there is nowhere to put a passcode on a GET, so the sender
 * has to drop one of the two rather than reorder anything.
 */
export function flagConflict(flag: string | undefined): string | undefined {
  if (flag === undefined) return undefined;
  if (flag.includes('P') && flag.includes('U')) {
    return 'P and U cannot both be set. U says the url is fetched with GET, and a GET has nowhere to carry a passcode. The sender has to choose one.';
  }
  if (flag !== [...flag].sort().join('')) {
    return `Flags are concatenated in alphabetical order, so this reads as "${[...flag].sort().join('')}". SHLoupe accepts either; a strict receiver may not.`;
  }
  return undefined;
}

export function kvRowsToFieldRows(rows: readonly KvRow[]): FieldRow[] {
  return rows.map((row) => ({
    key: row.key,
    value: row.value,
    ...(row.mono === undefined ? {} : { mono: row.mono }),
    ...(row.status === undefined ? {} : { tone: toneForStatus(row.status) }),
    ...(row.note === undefined ? {} : { note: row.note }),
  }));
}

export interface FileLabel {
  label: string;
  tone: Tone;
}

/** How a file reads in a switcher: what it is, where it came from, whether it opened. */
export function describeFile(file: OpenedFile): FileLabel {
  const kind =
    file.kind === 'smart-health-card'
      ? 'Health Card'
      : file.kind === 'fhir'
        ? 'FHIR'
        : file.kind === 'smart-api-access'
          ? 'API access'
          : 'Unrecognised';
  return {
    label: `${file.index + 1}. ${kind} (${file.source})`,
    tone: file.failure !== undefined ? 'fail' : file.content === undefined ? 'warn' : 'pass',
  };
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

export function OpenScreen({ onRun }: { onRun: Runner }): ReactNode {
  const status = useSession((state) => state.status);
  const run = useSession((state) => state.run);
  const result = useSession((state) => state.result);
  const input = useSession((state) => state.input);
  const selectedFile = useSession((state) => state.selectedFile);
  const selectFile = useSession((state) => state.selectFile);
  const reset = useSession((state) => state.reset);
  const layout = useLayoutMode();
  const [tab, setTab] = useState<'trace' | 'payload'>('trace');
  const startOver = useStartOver(reset, onRun);

  // Move to the payload once, per run, and only when there is one. Doing it on
  // every render of an opened run would drag the user back out of the trace
  // every time they went to read it.
  const switchedFor = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (run === undefined) return;
    if (paneLayoutFor(run.outcome) !== 'payload-first') return;
    if (switchedFor.current === run.id) return;
    switchedFor.current = run.id;
    setTab('payload');
  }, [run]);

  if (run === undefined) return <IdleSurface onRun={onRun} />;

  const running = status === 'running';
  const paneLayout = paneLayoutFor(run.outcome);
  const files = result?.files ?? [];
  const file = files[selectedFile] ?? files[0];

  const linkPane = <LinkPane run={run} variant={result?.variant} profiles={result?.profiles} />;
  const tracePane = (
    <Panel title="Trace" className="pane pane-trace">
      <TraceList run={run} />
    </Panel>
  );
  const payloadPane = (
    <Panel
      title="Payload"
      className="pane pane-payload"
      actions={
        files.length > 1 ? (
          <div className="file-switcher" role="group" aria-label="Files in this manifest">
            {files.map((entry, index) => {
              const described = describeFile(entry);
              return (
                <Button
                  key={entry.index}
                  size="sm"
                  variant={index === selectedFile ? 'primary' : 'default'}
                  onClick={() => selectFile(index)}
                >
                  {described.label}
                </Button>
              );
            })}
          </div>
        ) : undefined
      }
    >
      {file !== undefined && file.content !== undefined ? (
        <Suspense fallback={<p className="pane-waiting">Rendering the payload…</p>}>
          <PayloadView file={file} />
        </Suspense>
      ) : (
        <NoPayload run={run} running={running} file={file} onRun={onRun} />
      )}
    </Panel>
  );

  return (
    <div className="workbench" data-layout={paneLayout} data-mode={layout}>
      <div className="workbench-top">
        {/* Above the verdict rather than below it: this is the way out of the
            run, and a way out placed after a long trace is a way out nobody
            finds. */}
        <div className="restart-row">
          <Button
            size="sm"
            onClick={startOver}
            title="Clear this run and go back to the samples and the explanation"
          >
            <RotateCcw size={13} aria-hidden />
            <span>Start over</span>
          </Button>
        </div>
        <VerdictBanner run={run} />
        <PasscodePrompt
          run={run}
          running={running}
          onSubmit={(passcode) => void onRun(input, { passcode })}
        />
      </div>

      {layout === 'wide' ? (
        <div className="workbench-panes">
          {linkPane}
          {tracePane}
          {payloadPane}
        </div>
      ) : layout === 'tabs' ? (
        <div className="workbench-panes">
          {linkPane}
          <div className="pane-tabs" role="tablist" aria-label="Trace and payload">
            <button
              type="button"
              role="tab"
              id="tab-trace"
              aria-selected={tab === 'trace'}
              aria-controls="panel-trace"
              className="pane-tab"
              onClick={() => setTab('trace')}
            >
              Trace
            </button>
            <button
              type="button"
              role="tab"
              id="tab-payload"
              aria-selected={tab === 'payload'}
              aria-controls="panel-payload"
              className="pane-tab"
              onClick={() => setTab('payload')}
            >
              Payload
            </button>
          </div>
          {tab === 'trace' ? (
            <div role="tabpanel" id="panel-trace" aria-labelledby="tab-trace">
              {tracePane}
            </div>
          ) : (
            <div role="tabpanel" id="panel-payload" aria-labelledby="tab-payload">
              {payloadPane}
            </div>
          )}
        </div>
      ) : (
        // A phone at a table. Tabs here would hide the thing somebody was sent
        // to look at, so everything is in the one column, verdict first.
        <div className="workbench-panes">
          {linkPane}
          {tracePane}
          {payloadPane}
        </div>
      )}
    </div>
  );
}

/**
 * Getting back to the landing page, from either of the two doors to it.
 *
 * Opening a link puts it in the fragment, and this screen renders whatever the
 * session holds, so before this there was no way back: the samples and the
 * explanation became unreachable for the rest of the tab's life. Starting over
 * has to clear BOTH halves of that state. Clearing the store alone leaves the
 * link in the hash, where the next reload re-opens it; clearing the hash alone
 * leaves the run on screen.
 *
 * The second door is the masthead, whose wordmark and Open tab are plain
 * anchors pointing at `#`. This screen never sees their clicks, only the hash
 * losing its link, and that is signal enough: a hash naming the Open screen
 * with no link in it is a request for the landing page.
 *
 * Three traps, each of which is why a line here looks the way it does.
 *
 * Navigating to ANOTHER screen must not clear the run. Somebody reads the
 * checks list to interpret their trace and comes back to it, and finding it
 * gone would read as the tool having thrown their work away. Hence the
 * `screen !== 'open'` bail rather than "the hash has no link".
 *
 * Going BACK to a link has to re-open it. App's fragment effect opens each link
 * once ever, by design, so after a reset it will not fire again for the same
 * one. The re-open therefore lives here, and it is guarded on the session being
 * idle: a submit navigates and starts its own run, and running that link again
 * from the hashchange would make two requests out of one paste. The status is
 * read at event time rather than captured, because `begin` has already set it
 * to running by the time the hash change is delivered.
 *
 * And nothing here can spend a passcode attempt: the re-opened run carries no
 * passcode, so it stops at the manifest step exactly as a fresh paste does.
 */
function useStartOver(reset: () => void, onRun: Runner): () => void {
  useEffect(() => {
    const onHashChange = (): void => {
      const next = parseHash(window.location.hash);
      if (next.screen !== 'open') return;
      if (next.link === undefined) {
        if (useSession.getState().status !== 'idle') reset();
        return;
      }
      if (useSession.getState().status === 'idle') void onRun(next.link);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, [onRun, reset]);

  return useCallback(() => {
    reset();
    // '#' is the Open screen's own path, so this is "go home" and not a second
    // route. See router.ts: a link and a screen never coexist in the hash.
    navigate('#');
  }, [reset]);
}

function useLayoutMode(): LayoutMode {
  const [mode, setMode] = useState<LayoutMode>(() =>
    typeof window === 'undefined' ? 'wide' : layoutModeForWidth(window.innerWidth),
  );
  useEffect(() => {
    const update = (): void => setMode(layoutModeForWidth(window.innerWidth));
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);
  return mode;
}

// ---------------------------------------------------------------------------
// Panes
// ---------------------------------------------------------------------------

function LinkPane({
  run,
  variant,
  profiles,
}: {
  run: TraceRun;
  variant?: VariantIdentification | undefined;
  profiles?: readonly ProfileConformance[] | undefined;
}): ReactNode {
  const facts = linkFactsFromRun(run);
  const key = typeof facts.payload?.['key'] === 'string' ? facts.payload['key'] : undefined;
  const flag = typeof facts.payload?.['flag'] === 'string' ? facts.payload['flag'] : undefined;
  const flags = describeFlags(flag);
  const conflict = flagConflict(flag);

  return (
    <Panel title="Link" className="pane pane-link">
      {key === undefined && facts.memberRows.length === 0 ? (
        <p className="pane-waiting">Reading the link…</p>
      ) : null}

      {key !== undefined ? <KeyRow value={key} /> : null}

      {facts.memberRows.length > 0 ? (
        <FieldTable rows={kvRowsToFieldRows(facts.memberRows)} dense />
      ) : null}

      {flags.length > 0 ? (
        <div className="flag-list">
          {flags.map((note) => (
            <div key={note.letter} className="flag">
              <Chip tone={note.recognised ? 'info' : 'warn'}>{note.letter}</Chip>
              <div>
                <strong>{note.name}</strong>
                <p>{note.meaning}</p>
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {conflict !== undefined ? <Callout tone="fail">{conflict}</Callout> : null}

      {/* What kind of link this is, before anything is retrieved. Open by
          default for anything that is not the plain HL7 baseline, because that
          is precisely when a reader needs to know why the retrieval is about to
          look different. */}
      {variant !== undefined ? (
        <VariantBadge
          identification={variant}
          defaultOpen={variant.variant.id !== 'shl-baseline'}
        />
      ) : null}

      {/* And whose added requirements it meets. Separate from the member table
          above on purpose: that table answers "is this a valid link", this
          answers "is it the profile somebody is expecting", and running the two
          together is how a valid link gets reported as broken. */}
      {profiles !== undefined && profiles.length > 0 ? (
        <ProfileChecks conformances={profiles} />
      ) : null}

      {facts.urlRows.length > 0 ? (
        <Disclosure summary="The URL, taken apart">
          <FieldTable rows={kvRowsToFieldRows(facts.urlRows)} dense />
        </Disclosure>
      ) : null}

      {facts.payload !== undefined ? (
        <Disclosure summary="Raw payload JSON">
          <CodeBlock language="json">{JSON.stringify(facts.payload, null, 2)}</CodeBlock>
        </Disclosure>
      ) : null}

      <Disclosure summary="The link exactly as it arrived">
        <CodeBlock>{run.input.source}</CodeBlock>
      </Disclosure>
    </Panel>
  );
}

/**
 * The decryption key: the user's own, on the user's own screen, so it is
 * available rather than hidden. Masked by default, and revealing always takes a
 * second press.
 *
 * The confirm used to be conditional on a "projector mode" setting, on the
 * theory that only an audience made it matter. That was the wrong test: this
 * tool is used on borrowed laptops at shared tables, and the person driving is
 * usually not the person the record belongs to. A shoulder is as good as a
 * projector, and the cost of always asking is one press.
 */
function KeyRow({ value }: { value: string }): ReactNode {
  const revealDefault = useSettings((settings) => settings.revealSecrets);
  const [revealed, setRevealed] = useState(revealDefault);
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="key-row">
      <span className="key-row-label">key</span>
      <Secret
        value={value}
        label="the decryption key"
        revealed={revealed}
        onReveal={(next) => {
          if (next && !revealed) {
            setConfirming(true);
            return;
          }
          setConfirming(false);
          setRevealed(next);
        }}
      />
      {confirming ? (
        <Callout tone="warn" title="This puts the decryption key on screen.">
          Anyone who can read the screen can copy it, and it opens the whole shared record.
          <div className="key-row-confirm">
            <Button
              variant="danger"
              size="sm"
              onClick={() => {
                setRevealed(true);
                setConfirming(false);
              }}
            >
              Show it anyway
            </Button>
            <Button size="sm" onClick={() => setConfirming(false)}>
              Keep it masked
            </Button>
          </div>
        </Callout>
      ) : null}
    </div>
  );
}

function NoPayload({
  run,
  running,
  file,
  onRun,
}: {
  run: TraceRun;
  running: boolean;
  file: OpenedFile | undefined;
  onRun: Runner;
}): ReactNode {
  if (running) {
    return (
      <EmptyState title="Still working">
        {/* No `.prose` here: an empty state is a centred column and carries its
            own, narrower measure. */}
        <p>
          The trace on the left is live. Nothing is rendered here until a file has been fetched,
          decrypted and parsed.
        </p>
      </EmptyState>
    );
  }

  if (file?.failure !== undefined) {
    return (
      <EmptyState icon={<FileWarning size={20} aria-hidden />} title="This file did not open">
        <p>{file.failure.message}</p>
        {file.failure.hint !== undefined ? <p>{file.failure.hint}</p> : null}
      </EmptyState>
    );
  }

  const stop = stoppedAt(run);
  const sample = SAMPLES[0];
  return (
    <EmptyState icon={<FileWarning size={20} aria-hidden />} title="Nothing was retrieved">
      <p>
        {stop === undefined
          ? 'No file was fetched, so there is nothing to render here. The trace says where the run stopped.'
          : `The run stopped at step ${stop.number}, ${lowerFirst(stop.title)}. No file was fetched, so there is nothing to render here.`}
      </p>
      <p>
        {run.networkUsed
          ? 'A request was made and did not give us a file. The trace holds its status, the headers a browser let us read, and a curl that reproduces it outside the browser.'
          : 'No request was made at all: the reason was visible in the link itself, so SHLoupe stopped rather than spending a request to confirm it.'}
      </p>
      {sample !== undefined ? (
        <Button variant="primary" onClick={() => void onRun(sample.input)}>
          Open a link that works instead
        </Button>
      ) : null}
    </EmptyState>
  );
}

function lowerFirst(text: string): string {
  return text.length === 0 ? text : `${text[0]?.toLowerCase() ?? ''}${text.slice(1)}`;
}

// ---------------------------------------------------------------------------
// First run
// ---------------------------------------------------------------------------

/**
 * The icon per ending. Three silhouettes that differ in outline, because the
 * third card is the one that fails and a reader must not need the colour to see
 * which one that is.
 */
const ENDING_ICON = {
  document: FileText,
  card: ShieldCheck,
  diagnosis: OctagonAlert,
} as const;

function IdleSurface({ onRun }: { onRun: Runner }): ReactNode {
  return (
    <div className="idle">
      <section className="idle-lede">
        <h1>Open a SMART Health Link and see every step of it.</h1>
        <p className="prose">
          Paste a link, a payload, a scanned code or a file into the field above and SHLoupe walks
          the whole path: decode, judge the payload against the specification, inspect the URL,
          request the manifest, fetch each file, decrypt, parse and render. Everything runs in this
          tab, so the only requests made are the ones the trace lists.
        </p>
      </section>

      <section className="idle-samples" aria-labelledby="idle-samples-title">
        <h2 id="idle-samples-title">Start with one of these</h2>
        {/* The review's question, and it was fair: why start with one of these,
            and what is the difference? Both answers belong above the cards, not
            in the cards, because the reason to press any of them is the same. */}
        <p className="idle-samples-lede prose">
          Because they cost nothing and they prove the tool rather than describing it. The first two
          are the implementation guide’s own examples: they really resolve, over the real network,
          and they carry the key the specification publishes, so there is nothing confidential
          behind either. The third is synthesised and cannot work at all. Each one ends somewhere
          different, which is the whole reason there are three.
        </p>
        <ul className="sample-grid">
          {SAMPLES.map((sample) => {
            const Icon = ENDING_ICON[sample.ending];
            return (
              <li key={sample.id}>
                <button type="button" className="sample" onClick={() => void onRun(sample.input)}>
                  <span className="sample-head">
                    <Icon size={15} aria-hidden className="sample-icon" />
                    <span className="sample-name">{sample.name}</span>
                    <ArrowRight size={14} aria-hidden className="sample-go" />
                  </span>
                  <span className="sample-blurb">{sample.blurb}</span>
                  {/* The one card that ends in a diagnosis is tinted as well as
                      iconed: tone-* keeps the colour and its surface together,
                      and the words say it too, so nothing here rests on colour. */}
                  <span
                    className={clsx(
                      'sample-ending',
                      sample.ending === 'diagnosis' && 'tone tone-warn',
                    )}
                  >
                    {sample.endingWord}
                  </span>
                  <span className="sample-teaches">
                    <GraduationCap size={13} aria-hidden />
                    <span>{sample.teaches}</span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </section>

      <section className="idle-claims" aria-label="What this does differently">
        <h2>Three things this does that the usual viewer does not</h2>
        <ol className="claims">
          <li>
            <h3>
              <Lightbulb size={15} aria-hidden />
              It answers before it asks
            </h3>
            <p className="prose">
              Recognising the link, decoding it, judging every payload member and inspecting the
              manifest URL all happen with the network untouched. A link whose URL is{' '}
              <code>https://localhost:5173/api/shl-manifest</code> gets a named verdict, the
              offending substring pointed at, and the clause of the specification it breaks, without
              a single packet leaving. The common viewer issues the request first and reports the
              browser&rsquo;s own <code>TypeError</code> as the diagnosis, which is how a sender
              ends up sure their link is fine.
            </p>
          </li>
          <li>
            <h3>
              <Lightbulb size={15} aria-hidden />
              It shows the whole path, and hands you a curl for the hop that broke
            </h3>
            <p className="prose">
              Every hop keeps its request, its response, the headers a browser actually let script
              read, and its timing. A cross-origin failure gives JavaScript one word and no cause,
              so the trace gives you the equivalent <code>curl</code> instead. A curl that succeeds
              where the browser failed is a positive diagnosis of a CORS misconfiguration, and
              nothing observable inside the page can prove that on its own.
            </p>
          </li>
          <li>
            <h3>
              <Lightbulb size={15} aria-hidden />
              It names who has to act
            </h3>
            <p className="prose">
              Every finding says whether it is yours, the sender&rsquo;s or the server
              operator&rsquo;s, carries a stable id such as <code>SHL-URL-LOCALHOST</code>, and
              quotes the sentence of the specification it rests on. That is the part you paste into
              the thread where somebody is saying it works for them.
            </p>
          </li>
        </ol>
      </section>

      <Callout tone="info" title="What it never does">
        <p className="prose">
          No link, key, passcode or payload is uploaded anywhere, and none is written to storage.
          Only your settings persist. Two probes can reach a third party, they are off until you
          turn them on in settings, and each says there what it discloses.
        </p>
        <p className="idle-offline">
          <ShieldCheck size={14} aria-hidden /> Nothing is fetched to render this page, so it works
          with the network unplugged, which matters when the venue wifi is the thing under
          investigation.
        </p>
      </Callout>
    </div>
  );
}
