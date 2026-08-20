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
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { FileWarning, Lightbulb, ShieldCheck, Sparkles } from 'lucide-react';
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
import { PayloadView } from '../../ui/fhir';
import type { Runner } from '../App';
import { PasscodePrompt } from '../PasscodePrompt';
import { useSession, useSettings } from '../store';

// ---------------------------------------------------------------------------
// Samples
// ---------------------------------------------------------------------------

export interface Sample {
  id: string;
  name: string;
  blurb: string;
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
 * that can only ever open on the machine that minted it, which Loupe says
 * without making a request.
 */
export const SAMPLES: Sample[] = [
  {
    id: 'ips',
    name: 'IPS document',
    blurb: 'The IG example: a 20-entry patient summary Bundle, fetched with no manifest.',
    input:
      'https://viewer.tcpdev.org/shlink.html#shlink:/eyJ1cmwiOiJodHRwczovL3Jhdy5naXRodWJ1c2VyY29udGVudC5jb20vc2Vhbm5vL3NoYy1kZW1vLWRhdGEvbWFpbi9pcHMvSVBTX0lHLWJ1bmRsZS0wMS1lbmMudHh0IiwiZmxhZyI6IkxVIiwia2V5IjoicnhUZ1lsT2FLSlBGdGNFZDBxY2NlTjh3RVU0cDk0U3FBd0lXUWU2dVg3USIsImxhYmVsIjoiRGVtbyBTSEwgZm9yIElQU19JRy1idW5kbGUtMDEifQ',
  },
  {
    id: 'shc',
    name: 'Health Card',
    blurb: 'The IG example that carries a signed card, so the JWS and its key set are checked too.',
    input:
      'shlink:/eyJ1cmwiOiJodHRwczovL3Jhdy5naXRodWJ1c2VyY29udGVudC5jb20vc2Vhbm5vL3NoYy1kZW1vLWRhdGEvbWFpbi9jYXJkcy9jYXJpbi1pbnN1cmFuY2UtZXhhbXBsZS9qd3MudHh0IiwiZmxhZyI6IkxVIiwia2V5IjoicnhUZ1lsT2FLSlBGdGNFZDBxY2NlTjh3RVU0cDk0U3FBd0lXUWU2dVg3USIsImxhYmVsIjoiRGVtbyBTSEwgZm9yIGNhcmluLWluc3VyYW5jZS1leGFtcGxlIn0',
  },
  {
    id: 'localhost',
    name: 'Broken: a loopback host',
    blurb: 'Points at the sender’s own laptop. Diagnosed with no request made.',
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
            'The specification requires a receiver to ignore a flag letter it does not recognise, so Loupe shows it and carries on.',
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
    return `Flags are concatenated in alphabetical order, so this reads as "${[...flag].sort().join('')}". Loupe accepts either; a strict receiver may not.`;
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
  const layout = useLayoutMode();
  const [tab, setTab] = useState<'trace' | 'payload'>('trace');

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

  const linkPane = <LinkPane run={run} />;
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
        <PayloadView file={file} />
      ) : (
        <NoPayload run={run} running={running} file={file} onRun={onRun} />
      )}
    </Panel>
  );

  return (
    <div className="workbench" data-layout={paneLayout} data-mode={layout}>
      <div className="workbench-top">
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

function LinkPane({ run }: { run: TraceRun }): ReactNode {
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
 * The decryption key: the user's own, on the user's own screen, so it is shown
 * rather than hidden. Masked by default all the same, and in projector mode a
 * reveal takes a second press, because the audience is looking at the same
 * screen and a key on a projector is a key in the room.
 */
function KeyRow({ value }: { value: string }): ReactNode {
  const revealDefault = useSettings((settings) => settings.revealSecrets);
  const projector = useSettings((settings) => settings.projector);
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
          if (next && projector && !revealed) {
            setConfirming(true);
            return;
          }
          setConfirming(false);
          setRevealed(next);
        }}
      />
      {confirming ? (
        <Callout tone="warn" title="Projector mode is on.">
          This is the key that decrypts the shared record. Anyone reading the screen can copy it.
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
          : 'No request was made at all: the reason was visible in the link itself, so Loupe stopped rather than spending a request to confirm it.'}
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

function IdleSurface({ onRun }: { onRun: Runner }): ReactNode {
  return (
    <div className="idle">
      <section className="idle-lede">
        <h1>Open a SMART Health Link and see every step of it.</h1>
        <p>
          Paste a link, a payload, a scanned code or a file into the field above and Loupe walks the
          whole path: decode, judge the payload against the specification, inspect the URL, request
          the manifest, fetch each file, decrypt, parse and render. Everything runs in this tab, so
          the only requests made are the ones the trace lists.
        </p>
      </section>

      <section className="idle-samples" aria-label="Sample links">
        <h2>Start with one of these</h2>
        <div className="sample-row">
          {SAMPLES.map((sample) => (
            <button
              key={sample.id}
              type="button"
              className="sample"
              onClick={() => void onRun(sample.input)}
            >
              <span className="sample-name">
                <Sparkles size={14} aria-hidden />
                {sample.name}
              </span>
              <span className="sample-blurb">{sample.blurb}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="idle-claims" aria-label="What this does differently">
        <h2>Three things this does that the usual viewer does not</h2>
        <ol className="claims">
          <li>
            <h3>
              <Lightbulb size={15} aria-hidden />
              It answers before it asks
            </h3>
            <p>
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
            <p>
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
            <p>
              Every finding says whether it is yours, the sender&rsquo;s or the server
              operator&rsquo;s, carries a stable id such as <code>SHL-URL-LOCALHOST</code>, and
              quotes the sentence of the specification it rests on. That is the part you paste into
              the thread where somebody is saying it works for them.
            </p>
          </li>
        </ol>
      </section>

      <Callout tone="info" title="What it never does">
        <p>
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
