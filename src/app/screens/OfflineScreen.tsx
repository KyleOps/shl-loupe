/**
 * Offline mode: the same pipeline, over content that arrived some other way.
 *
 * A browser frequently cannot reach a sharing server at all. The specification
 * never mentions CORS, so plenty of perfectly conformant servers do not send the
 * headers a browser needs before it will hand a response to a page; a manifest
 * URL may name a host that only resolves on the sender's own network; a venue or
 * corporate network may block it outright. In every one of those cases the link
 * is fine and the browser is the wrong tool, so this screen runs the identical
 * pipeline over bytes fetched some other way, with the network untouched from
 * the first step to the last.
 *
 * The round trip is the whole feature. Loupe cannot make the request, so it
 * hands over the exact command that can and takes the output back: paste the
 * link, copy the curl, run it in a shell where CORS does not exist, paste what
 * it printed into the manifest box. What comes out is the trace a live run would
 * have produced, minus the hops nobody could make.
 *
 * Five decisions worth knowing before changing anything here.
 *
 * THE FLOW IS ON SCREEN, NOT INFERRED FROM A TEXTAREA. A reviewer looking at the
 * running app could not tell what the screen was for, and the cause was that the
 * sequence (copy, run, paste, read) existed only in the head of whoever built
 * it. {@link guideSteps} makes it a numbered ladder and marks the step the user
 * is on. It is derived from observable facts ONLY: whether a command exists,
 * whether a box has content, whether a run happened. "Did you copy it?" and "did
 * you run it?" are not observable, so no step claims to know them, and the
 * evidence for the terminal round trip is the paste that comes back from it.
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
 *
 * IT CAN BE HANDED A WHOLE JOB IN THE FRAGMENT. See
 * {@link parseOfflineHandoff} for the contract, and for the trap that shape has
 * to dodge: the router matches a bare `shlink:/` anywhere in the fragment and
 * routes it to the Open screen, so a hand-off must percent-encode its values.
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
  Check,
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
  /**
   * Take a whole job from somewhere else: every box at once, from a hand-off in
   * the fragment. It REPLACES all five boxes rather than merging, so what the
   * screen shows is exactly what was handed over and never half of it beside a
   * leftover from ten minutes ago.
   */
  receive(fields: OfflineHandoff): void;
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
  receive: (fields) =>
    set({
      text: fields.text,
      key: fields.key,
      manifest: fields.manifest,
      jwe: fields.jwe,
      jwks: fields.jwks,
      staged: fields.open,
    }),
  claim: () => set({ staged: false }),
  reset: () => set({ text: '', key: '', manifest: '', jwe: '', jwks: '', staged: false }),
}));

// ---------------------------------------------------------------------------
// The hand-off contract
// ---------------------------------------------------------------------------

export interface OfflineHandoff {
  /** The primary box: a link, a manifest, a JWE, a card, a bundle, curl output. */
  text: string;
  key: string;
  manifest: string;
  jwe: string;
  jwks: string;
  /** Run it on arrival, rather than only filling the boxes. */
  open: boolean;
}

/**
 * Read a hand-off out of the fragment.
 *
 * The contract, which anything wanting to open this screen pre-loaded should use:
 *
 *     #/offline?input=…&key=…&manifest=…&jwe=…&jwks=…&open=1
 *
 * `input` is the primary box (`link` is accepted as a synonym, because a caller
 * handing over a minted link reaches for that word first). Every value is
 * percent-encoded: build the query with `URLSearchParams`, or run each value
 * through `encodeURIComponent`. `open=1` runs it on arrival; anything else, or
 * absent, fills the boxes and waits for the button.
 *
 * Two traps, both of which the obvious version walks into.
 *
 * The values MUST be encoded. `parseHash` in the router matches `shlink:/…`
 * anywhere in the fragment and treats the whole fragment as a link to open, so
 * an unencoded link in this query never reaches this screen at all: it lands on
 * the Open screen and tries to fetch. Encoding turns the colon into `%3A` and
 * the pattern no longer matches.
 *
 * A manifest carries `application/fhir+json`, and `+` in a query string decodes
 * as a space. `encodeURIComponent` and `URLSearchParams` both write it as `%2B`;
 * hand-concatenating the query does not, and silently corrupts every content
 * type in the paste.
 *
 * The fragment is never sent to a server, which is the same reason the rest of
 * the app carries a link (key included) there rather than in the query string.
 */
export function parseOfflineHandoff(hash: string): OfflineHandoff | undefined {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  const mark = raw.indexOf('?');
  if (mark === -1) return undefined;
  const params = new URLSearchParams(raw.slice(mark + 1));
  const fields: OfflineHandoff = {
    text: (params.get('input') ?? params.get('link') ?? '').trim(),
    key: (params.get('key') ?? '').trim(),
    manifest: (params.get('manifest') ?? '').trim(),
    jwe: (params.get('jwe') ?? '').trim(),
    jwks: (params.get('jwks') ?? '').trim(),
    open: params.get('open') === '1' || params.get('open') === 'true',
  };
  const carriesContent =
    fields.text.length > 0 ||
    fields.key.length > 0 ||
    fields.manifest.length > 0 ||
    fields.jwe.length > 0 ||
    fields.jwks.length > 0;
  // A bare `#/offline` and a query of unrelated members are both "no hand-off",
  // so the boxes are left alone rather than being cleared by a navigation.
  return carriesContent ? fields : undefined;
}

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

/**
 * Everything this box accepts, with what each one still needs beside it.
 *
 * The screen takes six quite different things and a reader had no way to know
 * that, so the list is on screen rather than in the placeholder. `matches` ties
 * each row to the live detection, which is what stops the list and the verdict
 * disagreeing about what was pasted. More than one row can match at once, and
 * that is accurate: curl output holding a manifest really is both.
 */
export interface AcceptedInput {
  id: string;
  /** What you have, including whatever has to come with it. */
  what: string;
  /** One line: what Loupe does with it. */
  does: string;
  matches(detected: DetectedInput): boolean;
}

export const ACCEPTED_INPUTS: readonly AcceptedInput[] = [
  {
    id: 'shlink',
    what: 'A SMART Health Link, plus the manifest you fetched for it',
    does: "Every member of the payload is judged against the specification, then the manifest you paste is read and its files decrypted with the link's own key.",
    matches: (detected) => detected.kind === 'shlink',
  },
  {
    id: 'manifest',
    what: "A manifest response, plus the link's key",
    does: 'Everything embedded in it is decrypted, decompressed and identified. A file the manifest only located needs the encrypted-file box as well.',
    matches: (detected) => detected.kind === 'manifest',
  },
  {
    id: 'jwe',
    what: 'One encrypted file, plus the key',
    does: 'The protected header is checked, then the five-part JWE is decrypted on its own, with no manifest and no link in sight.',
    matches: (detected) => detected.kind === 'jwe',
  },
  {
    id: 'fhir',
    what: 'An already-decrypted bundle or resource',
    does: 'Nothing to decode and no key to supply: it is indexed and rendered.',
    matches: (detected) => detected.kind === 'fhir',
  },
  {
    id: 'shc',
    what: 'A health card, plus the issuer key set if you have it',
    does: 'shc:/ digits, a health-card file or a bare signed JWS. Without the key set the signature is reported as not checked, which is the honest answer rather than a failure.',
    matches: (detected) => detected.kind === 'shc' || detected.kind === 'jws',
  },
  {
    id: 'curl',
    what: 'The raw output of curl, headers and all',
    does: 'The status line and the headers a browser hid are reported, and the body is opened as whichever of the above it turns out to be.',
    matches: (detected) => detected.httpResponse !== undefined,
  },
];

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

// ---------------------------------------------------------------------------
// The numbered flow
// ---------------------------------------------------------------------------

export type GuideState = 'done' | 'now' | 'todo';

export interface GuideStep {
  /** 1-based, and the number the marker shows. */
  n: number;
  title: string;
  detail: string;
  state: GuideState;
}

/**
 * The facts the ladder is allowed to reason from. Every one of them is something
 * the screen can actually see: no member here stands for "the user has probably
 * done that by now".
 */
export interface GuideFacts {
  /** The detector recognised something openable in the primary box. */
  recognised: boolean;
  /** The flow includes the terminal round trip: a link, or a box not filled in yet. */
  viaTerminal: boolean;
  /** A manifest URL is known, so there is a command to copy. */
  hasCommand: boolean;
  /** Something came back from the shell and was pasted in. */
  handoffFilled: boolean;
  /** The content cannot open without a decryption key. */
  needsKey: boolean;
  /** A key is to hand, whether typed or taken out of a pasted link. */
  hasKey: boolean;
  /** This screen has a run of its own. */
  hasRun: boolean;
}

/**
 * The sequence, as steps with a state each.
 *
 * Two shapes, because the terminal round trip is not part of every job: a bundle
 * somebody already decrypted needs no command and no shell, and a ladder telling
 * them to run one would be inventing work.
 *
 * "Now" is the earliest step with no evidence behind it. A later step that IS
 * done still says so, rather than being relabelled "to do" to keep the ladder
 * tidy: pasting a manifest before its link is a real order to work in, and the
 * screen can see that it happened.
 *
 * Steps 2 and 3 of the terminal flow share their evidence, and that is the
 * honest answer rather than a bug. Loupe cannot see a terminal. What it can see
 * is the paste that only exists because somebody ran the command, so both steps
 * complete on it, and while the box is empty step 2 is where you are and step 3
 * is genuinely still ahead of you.
 */
export function guideSteps(facts: GuideFacts): GuideStep[] {
  const planned: Array<{ title: string; detail: string; done: boolean }> = facts.viaTerminal
    ? [
        {
          title: 'Copy the command',
          detail:
            'Put your link in the box below and Loupe fills the command in for you: the manifest URL, the POST body and the recipient, ready to run.',
          done: facts.hasCommand,
        },
        {
          title: 'Run it in a terminal',
          detail:
            'A shell has no CORS, no preflight and no page sandbox, so the request this tab is refused usually just works there.',
          done: facts.handoffFilled,
        },
        {
          title: 'Paste what came back',
          detail:
            'Into the manifest box, headers and all. Loupe splits the headers off and reports what the server said to the shell.',
          done: facts.handoffFilled,
        },
      ]
    : [
        {
          title: 'Paste what you have',
          detail:
            'A manifest, an encrypted file, a health card or an already-decrypted bundle. Loupe says what it thinks it is before anything runs.',
          done: facts.recognised,
        },
        ...(facts.needsKey
          ? [
              {
                title: 'Add the key from its link',
                detail:
                  'The key member of the SMART Health Link this content came from. It decrypts here in the tab and is sent nowhere.',
                done: facts.hasKey,
              },
            ]
          : []),
      ];

  planned.push({
    title: 'Open it, and read the trace',
    detail:
      'The trace is the one a live run produces, minus the hops nobody could make from this tab.',
    done: facts.hasRun,
  });

  const now = planned.findIndex((step) => !step.done);
  return planned.map((step, index) => ({
    n: index + 1,
    title: step.title,
    detail: step.detail,
    state: step.done ? 'done' : index === now ? 'now' : 'todo',
  }));
}

const GUIDE_STATE_WORD: Record<GuideState, string> = {
  done: 'Done',
  now: 'You are here',
  todo: 'To do',
};

/** Done and current wear a tone; a step still ahead is dimmed by a text tier. */
const GUIDE_TONE: Record<GuideState, string> = {
  done: 'tone tone-pass',
  now: 'tone tone-running',
  todo: '',
};

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
  const receive = useOfflineDraft((state) => state.receive);
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

  const steps = useMemo(
    () =>
      guideSteps({
        recognised: detected.kind !== 'unknown' && detected.content.trim().length > 0,
        viaTerminal: needs.manifest,
        hasCommand: detected.link?.url !== undefined,
        handoffFilled: manifest.trim().length > 0 || jwe.trim().length > 0,
        needsKey: detected.needsKey,
        hasKey: keyResolution.key !== undefined,
        hasRun: ownRun !== undefined,
      }),
    [
      detected.content,
      detected.kind,
      detected.link?.url,
      detected.needsKey,
      jwe,
      keyResolution.key,
      manifest,
      needs.manifest,
      ownRun,
    ],
  );

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
   * A hand-off in the fragment fills the boxes on arrival.
   *
   * Keyed on the whole hash rather than on a parsed member, so re-reading the
   * same fragment (a re-render, a hashchange to the same value) cannot overwrite
   * boxes the user has since edited, while a genuinely different hand-off does
   * land. Navigating to a plain `#/offline` parses to nothing and is therefore
   * not a hand-off, which is what keeps the nav link from wiping the draft.
   */
  const handedOff = useRef<string | undefined>(undefined);
  useEffect(() => {
    const apply = (): void => {
      const hash = window.location.hash;
      if (handedOff.current === hash) return;
      const fields = parseOfflineHandoff(hash);
      if (fields === undefined) return;
      handedOff.current = hash;
      receive(fields);
    };
    apply();
    window.addEventListener('hashchange', apply);
    return () => window.removeEventListener('hashchange', apply);
  }, [receive]);

  /*
   * A sample staged from the command palette, or a hand-off asking to be run,
   * opens on arrival.
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

  // The handoff's "this needs a link first" callout offers the field rather than
  // describing where it is. The box is one panel up, so this is a caret move
  // rather than a scroll on most screens, which is exactly why it is a button
  // and not a second link field: two fields for one value is how they drift.
  const inputField = useRef<HTMLTextAreaElement | null>(null);
  const focusInput = useCallback(() => {
    inputField.current?.focus();
    inputField.current?.scrollIntoView({ block: 'nearest' });
  }, []);

  return (
    <div className="offline">
      <section className="offline-lede prose">
        <h1>Open a link the browser cannot reach.</h1>
        <p>
          The specification never mentions CORS, so plenty of conformant sharing servers do not send
          the headers a browser needs before it will hand a response to a page, and plenty of
          manifest URLs name a host that only resolves on the sender&rsquo;s own network or sits
          behind a venue firewall.
        </p>
        <p>
          In every one of those cases the link is fine and the browser is the wrong tool: fetch the
          bytes some other way, bring them here, and the identical pipeline runs over them with no
          network at all.
        </p>
        <p className="offline-lede-badge">
          <WifiOff size={14} aria-hidden /> Nothing on this screen issues a request, at any step.
        </p>
      </section>

      <Guide steps={steps} />

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
                ref={inputField}
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

          <Panel title="What you can paste here">
            <Accepts detected={detected} />
          </Panel>

          {detected.needsKey ? <KeyPanel resolution={keyResolution} /> : null}

          {needs.manifest || needs.jwe || needs.jwks ? (
            <Handoff
              detected={detected}
              recipient={recipient}
              needs={needs}
              onFocusInput={focusInput}
            />
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
            <Panel title="Result" actions={<Chip tone="info">{`Step ${steps.length}`}</Chip>}>
              <EmptyState icon={<WifiOff size={20} aria-hidden />} title="Nothing has run here yet">
                <p>
                  Work down the steps above and press Open. The trace that comes out is the same one
                  a live run produces, minus the hops nobody could make from this tab.
                </p>
              </EmptyState>
            </Panel>
          ) : (
            <>
              <VerdictBanner run={ownRun} />
              <Panel title="Trace" actions={<Chip tone="info">{`Step ${steps.length}`}</Chip>}>
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
// The guide
// ---------------------------------------------------------------------------

/**
 * The sequence, on screen.
 *
 * An ordered list, so the numbering is real to a screen reader rather than
 * painted on, and the step in progress carries `aria-current="step"`. The state
 * is never colour alone: a done step's marker is a tick where the others are a
 * digit, and both done and current say so in a word.
 */
function Guide({ steps }: { steps: readonly GuideStep[] }): ReactNode {
  return (
    <ol className="offline-guide" aria-label="How this screen is used">
      {steps.map((step) => (
        <li
          key={step.n}
          className={clsx('offline-guide-step', `is-${step.state}`)}
          aria-current={step.state === 'now' ? 'step' : undefined}
        >
          <span className={clsx('offline-guide-marker', GUIDE_TONE[step.state])} aria-hidden>
            {step.state === 'done' ? <Check size={14} strokeWidth={2.5} /> : step.n}
          </span>
          <span className="offline-guide-body">
            <span className="offline-guide-title">
              {step.title}
              {step.state === 'todo' ? null : (
                <span className="offline-guide-state">{GUIDE_STATE_WORD[step.state]}</span>
              )}
            </span>
            <span className="offline-guide-detail">{step.detail}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

/** What the box takes, and which row the live detection landed on. */
function Accepts({ detected }: { detected: DetectedInput }): ReactNode {
  return (
    <dl className="offline-accepts">
      {ACCEPTED_INPUTS.map((row) => {
        const current = row.matches(detected);
        return (
          <div key={row.id} className={clsx('offline-accepts-row', current && 'is-current')}>
            <dt>
              <span>{row.what}</span>
              {current ? <Chip tone="info">Detected</Chip> : null}
            </dt>
            <dd>{row.does}</dd>
          </div>
        );
      })}
    </dl>
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
  onFocusInput,
}: {
  detected: DetectedInput;
  recipient: string;
  needs: Needs;
  onFocusInput: () => void;
}): ReactNode {
  const manifest = useOfflineDraft((state) => state.manifest);
  const setManifest = useOfflineDraft((state) => state.setManifest);
  const jwe = useOfflineDraft((state) => state.jwe);
  const setJwe = useOfflineDraft((state) => state.setJwe);
  const jwks = useOfflineDraft((state) => state.jwks);
  const setJwks = useOfflineDraft((state) => state.setJwks);
  const url = detected.link?.url;
  // Only a link that resolved a URL has a command, so the two notes below hang
  // off that rather than off the flag alone: reassuring somebody that a command
  // carries no passcode before any command exists reads as noise.
  const passcodeFlagged = url !== undefined && (detected.link?.flag ?? '').includes('P');

  return (
    <Panel
      title="Fetched by hand"
      // Numbered only for the flow that has those steps: a manifest paste shows
      // this panel for its located files, and calling that "steps 1 to 3" would
      // put a terminal round trip in front of somebody who needs none.
      actions={needs.manifest ? <Chip tone="info">Steps 1 to 3</Chip> : undefined}
    >
      {needs.manifest ? (
        <div className="offline-handoff">
          <p className="offline-handoff-lede">
            <Terminal size={14} aria-hidden />
            Loupe cannot request the manifest from here, so run this where CORS does not exist, then
            paste what it prints into the manifest box below.
          </p>
          {url === undefined ? (
            <Callout tone="info" title="The command needs the link first.">
              <p className="offline-handoff-callout">
                Put the link in the box above and the exact command appears here, with its URL and
                recipient already filled in.
              </p>
              <Button size="sm" onClick={onFocusInput}>
                <span>Put the cursor in that box</span>
              </Button>
            </Callout>
          ) : (
            <CodeBlock language="bash">{curlForOfflineHandoff({ url, recipient })}</CodeBlock>
          )}

          {passcodeFlagged ? (
            <Callout tone="warn" title="This link needs a passcode.">
              The <code>P</code> flag means the server rejects a manifest request that carries none,
              so add <code>&quot;passcode&quot;:&quot;…&quot;</code> to the JSON after{' '}
              <code>-d</code> before you run it. Type it rather than guessing: every wrong attempt
              is counted for the life of the link, and enough of them disable it for the patient
              permanently.
            </Callout>
          ) : null}

          {url !== undefined && !passcodeFlagged ? (
            <p className="offline-field-note">
              The command carries no key and no passcode, so it is safe to paste into a group chat:
              a key decrypts the files rather than granting access, and Loupe never puts one in a
              command.
            </p>
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
