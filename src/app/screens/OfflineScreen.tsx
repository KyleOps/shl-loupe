/**
 * Offline mode: the same pipeline, over content that arrived some other way.
 *
 * A browser frequently cannot reach a sharing server at all, either because the
 * server sends no CORS headers or because the host in the link only resolves on
 * the sender's own network. This screen runs the identical pipeline over content
 * you fetched some other way, with the network untouched from the first step to
 * the last.
 *
 * The round trip is the whole feature. Loupe cannot make the request, so it
 * hands over the exact command that can and takes the output back: paste the
 * link, copy the curl, run it in a shell where CORS does not exist, paste what
 * it printed into the manifest box. What comes out is the trace a live run would
 * have produced, minus the hops nobody could make.
 *
 * Three decisions worth knowing before changing anything here.
 *
 * THE DRAFT IS ITS OWN STORE. Everything typed here survives leaving the screen
 * and coming back, because the workflow leaves it by design: you go to a
 * terminal, or to the Learn screen to check a member. Losing a pasted 900-line
 * bundle on the way back would end up meaning nobody uses the screen twice. It
 * is memory-only, like the session store and for the same reason: a decryption
 * key and a decrypted summary do not belong in localStorage on a borrowed
 * laptop.
 *
 * IT WRITES ITS RUN INTO THE SESSION, BUT NEVER CALLS `begin`. `TraceList` reads
 * the secret registry and the selected step out of the session store, so an
 * offline run has to land there or its evidence renders with the key in clear.
 * `begin` is the one action it must not call: that action also owns the header's
 * link field, and dropping a pasted bundle into a one-line field for links is
 * not what anybody asked for.
 *
 * IT SHOWS ONLY ITS OWN RUN. The session is shared with the Open screen, so the
 * results are gated on the run id this screen started. Rendering whatever run
 * happened to be in the store would attribute a live run's network hops to the
 * one screen that makes none.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type ReactNode,
} from 'react';
import { create } from 'zustand';
import {
  ClipboardPaste,
  Eye,
  EyeOff,
  FileUp,
  KeyRound,
  Play,
  Terminal,
  Trash2,
  WifiOff,
} from 'lucide-react';
import { clsx } from 'clsx';
import { detectInput, type DetectedInput } from '../../core/detect';
import { viewerOriginFromLocation } from '../../core/diagnose/context';
import { curlForOfflineHandoff } from '../../core/net/curl';
import { openOffline } from '../../core/offline';
import type { FileKind, OpenedFile } from '../../core/pipeline';
import type { InputKind } from '../../core/trace';
import {
  Button,
  Callout,
  Chip,
  CodeBlock,
  EmptyState,
  FieldTable,
  Panel,
  StatusIcon,
  type FieldRow,
} from '../../ui/primitives';
import { TraceList, VerdictBanner } from '../../ui/trace';
import { PayloadView } from '../../ui/fhir';
import { toneForDetection, VARIANT_LABEL } from '../LinkInput';
import { useSession, useSettings } from '../store';

// ---------------------------------------------------------------------------
// The draft
// ---------------------------------------------------------------------------

export interface OfflineDraft {
  /** The primary paste: a link, a manifest, a JWE, a card, a bundle, curl output. */
  text: string;
  /** The link's `key` member, or a whole link to take it out of. */
  key: string;
  /** A manifest response somebody fetched by hand. */
  manifest: string;
  /** One encrypted file, for a manifest entry that only carried a location. */
  jwe: string;
  /** An issuer key set, so a health card's signature can be checked with no network. */
  jwks: string;
  /**
   * Set when the command palette staged a sample. It is a flag rather than a
   * callback because the palette may stage content while this screen is not
   * mounted, and a callback nobody is holding does not survive the navigation.
   */
  staged: boolean;
  setText(text: string): void;
  setKey(key: string): void;
  setManifest(manifest: string): void;
  setJwe(jwe: string): void;
  setJwks(jwks: string): void;
  /** Fill the box and ask the screen to open it. One `set`, so no render sees a stale pair. */
  stage(text: string): void;
  /** Take the staged flag, before opening, so a re-render cannot open it twice. */
  claim(): void;
  reset(): void;
}

export const useOfflineDraft = create<OfflineDraft>()((set) => ({
  text: '',
  key: '',
  manifest: '',
  jwe: '',
  jwks: '',
  staged: false,
  setText: (text) => set({ text }),
  setKey: (key) => set({ key }),
  setManifest: (manifest) => set({ manifest }),
  setJwe: (jwe) => set({ jwe }),
  setJwks: (jwks) => set({ jwks }),
  stage: (text) => set({ text, staged: true }),
  claim: () => set({ staged: false }),
  reset: () => set({ text: '', key: '', manifest: '', jwe: '', jwks: '', staged: false }),
}));

// ---------------------------------------------------------------------------
// Pure logic
// ---------------------------------------------------------------------------

/**
 * What pressing Open will actually do, per detected kind.
 *
 * The detector's own sentence says what the content is and gestures at what
 * happens next; this is the promise stated as a promise, in the same words the
 * pipeline's steps use. Held as a total record rather than a lookup with a
 * fallback, so adding a kind to the detector fails the typecheck here instead of
 * rendering a blank line.
 */
export const PLAN: Record<InputKind, string> = {
  shlink:
    'Judge every payload member against the specification, inspect the manifest URL, then open the manifest response you paste below. No request is made.',
  manifest:
    'Read the manifest, then decrypt, decompress and identify every file embedded in it. A file it only located needs the encrypted-file box.',
  jwe: 'Check the protected header, decrypt with the key you supply, decompress and identify what is inside.',
  fhir: 'Index it and render it. Nothing to decode, no key needed.',
  shc: 'Decode the card back to its signed token, read its payload, and check the signature if you paste the issuer key set.',
  jws: 'Read the protected header and the payload, and check the signature if you paste the issuer key set.',
  hcert:
    'Name it and stop. Loupe reads SMART Health Links and Cards; HC1 is base45 CBOR inside COSE, which is a different stack end to end.',
  unknown:
    'Say what it saw and stop, rather than guessing. The verdict above is the whole answer in that case.',
};

/** Which extra boxes are worth showing, per detected kind. */
export interface Needs {
  /** A manifest fetched by hand, which only a link can be short of. */
  manifest: boolean;
  /** A single encrypted file, for the entry a manifest only located. */
  jwe: boolean;
  /** An issuer key set, which only a signed card can use. */
  jwks: boolean;
}

export function needsFor(kind: InputKind, empty: boolean): Needs {
  // An empty box still gets the handoff. The round trip is what the screen is
  // for, and a command that appears only once somebody has already worked out
  // that a link goes in the box is a command nobody finds.
  if (empty) return { manifest: true, jwe: false, jwks: false };
  return {
    manifest: kind === 'shlink',
    jwe: kind === 'shlink' || kind === 'manifest',
    jwks: kind === 'shc' || kind === 'jws',
  };
}

export interface KeyResolution {
  /** The 43 characters to hand the pipeline, once a link has been peeled off. */
  key?: string;
  /** Shown under the field when the box held something other than a bare key. */
  note?: string;
}

/**
 * The key box accepts a whole link as well as a bare key.
 *
 * The pipeline's own remedy for a missing key says "paste the link, or just its
 * key", so the box has to honour both: making somebody find 43 characters inside
 * a 400-character link is exactly the kind of manual step this screen exists to
 * remove.
 */
export function resolveKeyField(value: string): KeyResolution {
  const trimmed = value.trim();
  if (trimmed.length === 0) return {};
  const detected = detectInput(trimmed);
  if (detected.link === undefined) return { key: trimmed };
  if (detected.link.key !== undefined) {
    return { key: detected.link.key, note: 'Taken out of the link you pasted.' };
  }
  return {
    note: 'That is a link, but it carries no key member, so there is nothing in it to decrypt with.',
  };
}

const FILE_KIND_WORD: Record<FileKind, string> = {
  'smart-health-card': 'Health Card',
  fhir: 'FHIR',
  'smart-api-access': 'API access',
  unknown: 'Unrecognised',
};

/** How one file reads in the switcher: which one it is, and whether it opened. */
export function fileLabel(file: OpenedFile): string {
  const state =
    file.failure !== undefined
      ? 'did not open'
      : file.content === undefined
        ? 'empty'
        : file.source;
  return `${file.index + 1}. ${FILE_KIND_WORD[file.kind]} (${state})`;
}

/** Rows for a pasted HTTP response, which is the one paste that carries its own headers. */
export function httpRows(detected: DetectedInput): FieldRow[] {
  const response = detected.httpResponse;
  if (response === undefined) return [];
  const cors = response.headers['access-control-allow-origin'];
  return [
    {
      key: 'status',
      value: `${response.status}${response.statusText === undefined ? '' : ` ${response.statusText}`}`,
      tone: response.status >= 200 && response.status < 300 ? 'pass' : 'warn',
    },
    {
      key: 'access-control-allow-origin',
      value: cors ?? 'absent',
      tone: cors === undefined ? 'warn' : 'pass',
      note:
        cors === undefined
          ? 'This is the header a browser needs before it will hand the response to a page. A shell does not need it, which is why the command worked and Loupe did not.'
          : 'A browser would have been allowed to read this response.',
    },
    ...Object.entries(response.headers)
      .filter(([name]) => name !== 'access-control-allow-origin')
      .map(([name, value]) => ({ key: name, value })),
  ];
}

// ---------------------------------------------------------------------------
// The screen
// ---------------------------------------------------------------------------

/**
 * Extensions worth reading as text. A dropped file with no extension is read
 * too: the output of `curl -o` routinely has none, and refusing it would refuse
 * the exact artefact this screen asks people to produce.
 */
const READABLE = /\.(txt|json|jose|jwe|jws|ndjson)$/i;

export function OfflineScreen(): ReactNode {
  const text = useOfflineDraft((state) => state.text);
  const keyField = useOfflineDraft((state) => state.key);
  const manifest = useOfflineDraft((state) => state.manifest);
  const jwe = useOfflineDraft((state) => state.jwe);
  const jwks = useOfflineDraft((state) => state.jwks);
  const staged = useOfflineDraft((state) => state.staged);
  const setText = useOfflineDraft((state) => state.setText);
  const claim = useOfflineDraft((state) => state.claim);
  const reset = useOfflineDraft((state) => state.reset);

  const recipient = useSettings((state) => state.recipient);
  const progress = useSession((state) => state.progress);
  const complete = useSession((state) => state.complete);
  const run = useSession((state) => state.run);
  const result = useSession((state) => state.result);
  const selectedFile = useSession((state) => state.selectedFile);
  const selectFile = useSession((state) => state.selectFile);

  const [ownRunId, setOwnRunId] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  // Only this screen's own run is shown. The session store is shared with the
  // Open screen, and rendering whatever run happened to be in it would attribute
  // a live run's network hops to the one screen that makes none.
  const ownRun = run !== undefined && run.id === ownRunId ? run : undefined;
  // Read off the run rather than kept as a second flag: the recorder emits its
  // first snapshot synchronously, and a `running` boolean beside a run that
  // already carries its own outcome is two sources of truth for one fact.
  const running = ownRun?.outcome === 'running';

  const detected = useMemo(() => detectInput(text), [text]);
  const keyResolution = useMemo(() => resolveKeyField(keyField), [keyField]);
  const needs = needsFor(detected.kind, detected.variant === 'empty');
  const ready = detected.content.trim().length > 0;

  const open = useCallback(async () => {
    const content = detected.content.trim();
    if (content.length === 0) return;
    setError(undefined);
    try {
      const outcome = await openOffline({
        kind: detected.kind,
        text: content,
        ...(keyResolution.key === undefined ? {} : { key: keyResolution.key }),
        ...(manifest.trim() === '' ? {} : { manifest: manifest.trim() }),
        ...(jwe.trim() === '' ? {} : { jwe: jwe.trim() }),
        ...(jwks.trim() === '' ? {} : { jwks: jwks.trim() }),
        viewer: viewerOriginFromLocation(window.location),
        recipient,
        onProgress: (snapshot) => {
          setOwnRunId(snapshot.id);
          progress(snapshot);
        },
      });
      complete(outcome);
    } catch (thrown) {
      // openOffline records its own failures as findings, so reaching here means
      // the tool itself broke before a recorder existed. Say so rather than
      // leaving the button looking like it did nothing.
      setError(thrown instanceof Error ? thrown.message : String(thrown));
    }
  }, [complete, detected, jwe, jwks, keyResolution.key, manifest, progress, recipient]);

  /*
   * A sample staged from the command palette opens on arrival.
   *
   * Opening it unasked is safe here in a way it is not on the Open screen: an
   * offline run issues no request and cannot spend one of the patient's counted
   * passcode attempts.
   *
   * Two things about the shape, both of which the obvious version gets wrong.
   * The run starts on the next turn rather than inside the effect body, because
   * the recorder emits its first snapshot synchronously and pushing that into
   * React state during the same commit cascades a render. And the guard is a
   * ref, like the shell's fragment guard, rather than a cleanup that clears the
   * timer: claiming the flag re-renders immediately, and a cleanup would cancel
   * the very run it was scheduled for.
   */
  const staging = useRef(false);
  useEffect(() => {
    if (!staged || staging.current) return;
    staging.current = true;
    claim();
    window.setTimeout(() => {
      staging.current = false;
      void open();
    }, 0);
  }, [claim, open, staged]);

  // Gated on the run for the same reason the trace is: a result left in the
  // session by a live run would otherwise render under this screen's own trace,
  // and the payload pane would be showing a file this screen never opened.
  const files = ownRun !== undefined && result?.run.id === ownRun.id ? result.files : [];
  const file = files[selectedFile] ?? files[0];

  const acceptFile = useCallback(
    (dropped: File | null | undefined): void => {
      if (!dropped) return;
      if (
        !READABLE.test(dropped.name) &&
        dropped.type !== '' &&
        !dropped.type.startsWith('text/')
      ) {
        setError(`Loupe reads text here, and "${dropped.name}" does not look like text.`);
        return;
      }
      setError(undefined);
      void dropped.text().then(setText);
    },
    [setText],
  );

  const [dragging, setDragging] = useState(false);

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault();
    setDragging(false);
    const dropped = event.dataTransfer.files.item(0);
    if (dropped) {
      acceptFile(dropped);
      return;
    }
    const dragged = event.dataTransfer.getData('text');
    if (dragged.length > 0) setText(dragged);
  };

  return (
    <div className="offline">
      <section className="offline-lede">
        <h1>Open what you already have, with nothing on the network.</h1>
        <p>
          A browser often cannot reach a sharing server at all: it sends no CORS headers, or its
          host only resolves on the sender&rsquo;s own network. This screen runs the identical
          pipeline over content you fetched some other way, and issues no request at any step.
        </p>
        <p className="offline-lede-badge">
          <WifiOff size={14} aria-hidden /> Everything below is decided from what you paste.
        </p>
      </section>

      <div className="offline-columns">
        <div className="offline-form">
          <Panel
            title="What you have"
            actions={
              <>
                <label className="btn btn-ghost btn-sm offline-file-button">
                  <FileUp size={13} aria-hidden />
                  <span>Load a file</span>
                  {/* The keyboard path to the same job as the drop zone: a drop
                      target cannot be reached without a pointer. */}
                  <input
                    type="file"
                    className="visually-hidden"
                    accept=".txt,.json,.jose,.jwe,.jws,text/plain,application/json"
                    onChange={(event: ChangeEvent<HTMLInputElement>) => {
                      acceptFile(event.target.files?.item(0));
                      event.target.value = '';
                    }}
                  />
                </label>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    void navigator.clipboard
                      .readText()
                      .then((clip) => setText(clip))
                      .catch(() =>
                        setError(
                          'The browser would not hand over the clipboard. Paste into the box with the keyboard instead.',
                        ),
                      );
                  }}
                >
                  <ClipboardPaste size={13} aria-hidden />
                  <span>Paste</span>
                </Button>
              </>
            }
          >
            <div
              className={clsx('offline-drop', dragging && 'is-dragging')}
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
            >
              <label className="visually-hidden" htmlFor="offline-text">
                A link, a manifest response, an encrypted file, a health card, a FHIR resource, or
                the raw output of a curl command
              </label>
              <textarea
                id="offline-text"
                className="offline-textarea opaque-value"
                spellCheck={false}
                autoComplete="off"
                rows={10}
                value={text}
                onChange={(event) => setText(event.target.value)}
                placeholder={
                  'Paste anything: shlink:/eyJ1cmwiOi…, {"files":[…]}, eyJhbGci….., shc:/5676…, {"resourceType":"Bundle"…}, or the whole output of curl -D -\n\nA .txt or .json file can be dropped here too.'
                }
                aria-describedby="offline-verdict"
              />
            </div>

            <Verdict detected={detected} />
          </Panel>

          {detected.needsKey ? <KeyPanel resolution={keyResolution} /> : null}

          {needs.manifest || needs.jwe || needs.jwks ? (
            <Handoff detected={detected} recipient={recipient} needs={needs} />
          ) : null}

          {error !== undefined ? (
            <Callout tone="fail" title="That did not work.">
              {error}
            </Callout>
          ) : null}

          <div className="offline-actions">
            <Button variant="primary" disabled={!ready || running} onClick={() => void open()}>
              <Play size={13} aria-hidden />
              <span>{running ? 'Working…' : 'Open it, offline'}</span>
            </Button>
            <Button
              variant="ghost"
              onClick={() => {
                reset();
                setError(undefined);
                setOwnRunId(undefined);
              }}
            >
              <Trash2 size={13} aria-hidden />
              <span>Clear every box</span>
            </Button>
          </div>
        </div>

        <div className="offline-results">
          {ownRun === undefined ? (
            <Panel title="Result">
              <EmptyState icon={<WifiOff size={20} aria-hidden />} title="Nothing has run here yet">
                <p>
                  Paste something on the left and press Open. The trace that comes out is the same
                  one a live run produces, minus the hops nobody could make from this tab.
                </p>
              </EmptyState>
            </Panel>
          ) : (
            <>
              <VerdictBanner run={ownRun} />
              <Panel title="Trace">
                <TraceList run={ownRun} />
              </Panel>
              <Panel
                title="Payload"
                actions={
                  files.length > 1 ? (
                    <div className="offline-files" role="group" aria-label="Files in this manifest">
                      {files.map((entry, index) => (
                        <Button
                          key={entry.index}
                          size="sm"
                          variant={index === selectedFile ? 'primary' : 'default'}
                          onClick={() => selectFile(index)}
                        >
                          {fileLabel(entry)}
                        </Button>
                      ))}
                    </div>
                  ) : undefined
                }
              >
                {file !== undefined && file.content !== undefined ? (
                  <PayloadView file={file} />
                ) : (
                  <EmptyState title={running ? 'Still working' : 'No file opened'}>
                    <p>
                      {running
                        ? 'The trace above is live. Nothing is rendered here until a file has been decrypted, decompressed and parsed.'
                        : (file?.failure?.message ??
                          'Nothing was decrypted, so there is nothing to render. The trace above says which step stopped and what it was short of.')}
                    </p>
                    {!running && file?.failure?.hint !== undefined ? (
                      <p>{file.failure.hint}</p>
                    ) : null}
                  </EmptyState>
                )}
              </Panel>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The verdict, live
// ---------------------------------------------------------------------------

function Verdict({ detected }: { detected: DetectedInput }): ReactNode {
  const rows = httpRows(detected);
  return (
    <div className="offline-verdict" id="offline-verdict">
      {/*
        The live region carries the label and the sentence only. The facts below
        it hold a character count that changes on every keystroke, and announcing
        that to a screen reader while somebody pastes a bundle would be noise
        rather than help.
      */}
      <p className="offline-verdict-head" aria-live="polite">
        <StatusIcon tone={toneForDetection(detected)} />
        <strong>{VARIANT_LABEL[detected.variant]}</strong>
        <Chip tone={detected.confidence === 'certain' ? 'info' : 'warn'}>
          {detected.confidence}
        </Chip>
        <span className="offline-verdict-sentence">{detected.sentence}</span>
      </p>

      {detected.details.length > 0 ? (
        <p className="offline-facts">{detected.details.join(' · ')}</p>
      ) : null}

      {detected.variant === 'empty' ? null : (
        <p className="offline-plan">
          <span className="offline-plan-label">Pressing Open will</span> {PLAN[detected.kind]}
        </p>
      )}

      {rows.length > 0 ? (
        <div className="offline-http">
          <p className="offline-http-note">
            You pasted an HTTP response with its headers, so Loupe can also report what the server
            said to the shell.
          </p>
          <FieldTable rows={rows} dense />
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The key
// ---------------------------------------------------------------------------

/**
 * The key field, shown only when the detected content cannot open without one.
 *
 * Masked by default, unless the user has asked globally for secrets to be
 * visible. This is the one field where somebody is typing the secret in rather
 * than reading it back, so it is also the field most likely to be looked at by
 * whoever is standing behind them.
 */
function KeyPanel({ resolution }: { resolution: KeyResolution }): ReactNode {
  const revealDefault = useSettings((state) => state.revealSecrets);
  const value = useOfflineDraft((state) => state.key);
  const setKey = useOfflineDraft((state) => state.setKey);
  const [revealed, setRevealed] = useState(revealDefault);

  return (
    <Panel title="The key">
      <div className="offline-key">
        <label className="offline-field-label" htmlFor="offline-key">
          <KeyRound size={13} aria-hidden />
          Decryption key
        </label>
        <div className="offline-key-row">
          <input
            id="offline-key"
            className="offline-input opaque-value"
            type={revealed ? 'text' : 'password'}
            spellCheck={false}
            autoComplete="off"
            value={value}
            onChange={(event) => setKey(event.target.value)}
            placeholder="rxTgYlOaKJPFtcEd0qcceN8wEU4p94SqAwIWQe6uX7Q"
            aria-describedby="offline-key-note"
          />
          <Button
            size="sm"
            variant="ghost"
            aria-pressed={revealed}
            onClick={() => setRevealed(!revealed)}
          >
            {revealed ? <EyeOff size={13} aria-hidden /> : <Eye size={13} aria-hidden />}
            <span className="visually-hidden">{revealed ? 'Hide the key' : 'Show the key'}</span>
          </Button>
        </div>
        <p className="offline-field-note" id="offline-key-note">
          The key is the <code>key</code> member of the SMART Health Link this content belongs to:
          43 characters of base64url, being 32 random bytes. Decryption happens in this tab, and the
          key is never sent anywhere. A whole link works here too, and Loupe will take the key out
          of it.
        </p>
        {resolution.note !== undefined ? (
          <p className="offline-field-note offline-field-note-strong">{resolution.note}</p>
        ) : null}
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------------
// The handoff
// ---------------------------------------------------------------------------

/**
 * The curl handoff, and the boxes its output comes back into.
 *
 * This is the point of the screen rather than a footnote on it, so the command
 * is exact and copyable: at an event nobody has patience for a command that has
 * to be edited first. The key is deliberately not in it, because a manifest
 * request does not need one, which is what makes the command safe to paste into
 * a group chat.
 */
function Handoff({
  detected,
  recipient,
  needs,
}: {
  detected: DetectedInput;
  recipient: string;
  needs: Needs;
}): ReactNode {
  const manifest = useOfflineDraft((state) => state.manifest);
  const setManifest = useOfflineDraft((state) => state.setManifest);
  const jwe = useOfflineDraft((state) => state.jwe);
  const setJwe = useOfflineDraft((state) => state.setJwe);
  const jwks = useOfflineDraft((state) => state.jwks);
  const setJwks = useOfflineDraft((state) => state.setJwks);
  const url = detected.link?.url;

  return (
    <Panel title="Fetched by hand">
      {needs.manifest ? (
        <div className="offline-handoff">
          <p className="offline-handoff-lede">
            <Terminal size={14} aria-hidden />
            Loupe cannot request the manifest from here, so run this where CORS does not exist, then
            paste what it prints into the manifest box below.
          </p>
          {url === undefined ? (
            <Callout tone="info" title="The command needs the link first.">
              Paste the link into the box above and the exact command appears here, with its URL and
              recipient already filled in.
            </Callout>
          ) : (
            <CodeBlock language="bash">{curlForOfflineHandoff({ url, recipient })}</CodeBlock>
          )}

          {url !== undefined && (detected.link?.flag ?? '').includes('P') ? (
            <Callout tone="warn" title="This link needs a passcode.">
              The <code>P</code> flag means the server rejects a manifest request that carries none,
              so add <code>&quot;passcode&quot;:&quot;…&quot;</code> to the JSON after{' '}
              <code>-d</code> before you run it. Type it rather than guessing: every wrong attempt
              is counted for the life of the link, and enough of them disable it for the patient
              permanently.
            </Callout>
          ) : null}
          <Field
            id="offline-manifest"
            label="Manifest response"
            note="The JSON the command printed. Headers and all is fine: Loupe splits them off and reports what the server said to the shell."
            value={manifest}
            onChange={setManifest}
            placeholder='{"files":[{"contentType":"application/fhir+json","embedded":"eyJhbGciOi…"}]}'
          />
        </div>
      ) : null}

      {needs.jwe ? (
        <Field
          id="offline-jwe"
          label="One encrypted file"
          note="For a manifest entry that carried a location rather than embedded content. Fetch that URL with curl, then paste the five-part JWE here; it stands in for the first located file."
          value={jwe}
          onChange={setJwe}
          placeholder="eyJhbGciOiJkaXIiLCJlbmMiOiJBMjU2R0NNIn0..pQ7…..…"
        />
      ) : null}

      {needs.jwks ? (
        <Field
          id="offline-jwks"
          label="Issuer key set"
          note="The JSON Web Key Set from the issuer's /.well-known/jwks.json. Without it the signature is reported as not checked, which is the honest answer rather than a failure."
          value={jwks}
          onChange={setJwks}
          placeholder='{"keys":[{"kty":"EC","crv":"P-256","alg":"ES256","kid":"…","x":"…","y":"…"}]}'
        />
      ) : null}
    </Panel>
  );
}

function Field({
  id,
  label,
  note,
  value,
  onChange,
  placeholder,
}: {
  id: string;
  label: string;
  note: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}): ReactNode {
  return (
    <div className="offline-field">
      <label className="offline-field-label" htmlFor={id}>
        {label}
      </label>
      <textarea
        id={id}
        className="offline-textarea offline-textarea-small opaque-value"
        spellCheck={false}
        autoComplete="off"
        rows={4}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-describedby={`${id}-note`}
      />
      <p className="offline-field-note" id={`${id}-note`}>
        {note}
      </p>
    </div>
  );
}
