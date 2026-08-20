/**
 * Application state.
 *
 * Two stores, split by lifetime rather than by feature:
 *
 *  - `useSettings` is preference state and is the only thing persisted. It holds
 *    nothing derived from a link.
 *  - `useSession` is the current run. It is memory-only, deliberately: this tool
 *    handles clinical payloads on borrowed laptops at events, and a decryption
 *    key or a decrypted summary sitting in localStorage after the tab closes is
 *    not a tradeoff worth making for the convenience of restoring a session.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { OpenedFile, PipelineResult } from '../core/pipeline';
import type { Redactor, TraceRun } from '../core/trace';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type ThemeChoice = 'dark' | 'light';

export interface Settings {
  theme: ThemeChoice;
  /**
   * Scales type for reading at a distance, in a room, over a shoulder.
   *
   * This replaced a "projector mode" that also swapped colours and widths. Those
   * turned out to be improvements rather than accommodations, so they are the
   * default now and this is the one axis left. See tokens.css.
   */
  largeText: boolean;
  /**
   * Sent as the manifest request's `recipient`. Editable because a server
   * operator reading their log should be able to tell which engineer called,
   * which the incumbent viewer's hardcoded string makes impossible.
   */
  recipient: string;
  /**
   * Sent as `embeddedLengthMax`. Large by default: an embedded file needs no
   * second cross-origin hop, so preferring embedded content is a CORS survival
   * strategy at an event, not only a size optimisation.
   */
  embeddedLengthMax: number;
  /** Opt-in, because it reaches a third-party DNS-over-HTTPS resolver. */
  dnsProbe: boolean;
  /** Opt-in, because it issues an extra request to the sharing server. */
  reachabilityProbe: boolean;
  /** Reveal registered secrets in the UI instead of masking them. */
  revealSecrets: boolean;
  setTheme(theme: ThemeChoice): void;
  toggleLargeText(): void;
  setRecipient(recipient: string): void;
  setEmbeddedLengthMax(value: number): void;
  setProbe(which: 'dns' | 'reachability', enabled: boolean): void;
  setRevealSecrets(reveal: boolean): void;
}

export const DEFAULT_RECIPIENT = 'SHLoupe (SMART Health Link debugger)';

export const useSettings = create<Settings>()(
  persist(
    (set) => ({
      theme: 'dark',
      largeText: false,
      recipient: DEFAULT_RECIPIENT,
      embeddedLengthMax: 4 * 1024 * 1024,
      dnsProbe: false,
      reachabilityProbe: false,
      revealSecrets: false,
      setTheme: (theme) => set({ theme }),
      toggleLargeText: () => set((state) => ({ largeText: !state.largeText })),
      setRecipient: (recipient) => set({ recipient }),
      setEmbeddedLengthMax: (embeddedLengthMax) => set({ embeddedLengthMax }),
      setProbe: (which, enabled) =>
        set(which === 'dns' ? { dnsProbe: enabled } : { reachabilityProbe: enabled }),
      setRevealSecrets: (revealSecrets) => set({ revealSecrets }),
    }),
    {
      name: 'loupe.settings',
      // Only preferences. Never a link, a key, a passcode or a payload.
      partialize: (state) => ({
        theme: state.theme,
        largeText: state.largeText,
        recipient: state.recipient,
        embeddedLengthMax: state.embeddedLengthMax,
        dnsProbe: state.dnsProbe,
        reachabilityProbe: state.reachabilityProbe,
      }),
    },
  ),
);

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export type SessionStatus = 'idle' | 'running' | 'done';

export interface Session {
  status: SessionStatus;
  /** What the user typed, scanned or arrived with. */
  input: string;
  run: TraceRun | undefined;
  result: PipelineResult | undefined;
  redactor: Redactor | undefined;
  /** The file the payload pane is showing. */
  selectedFile: number;
  /** The trace step expanded in the UI, if any. */
  expandedStep: string | undefined;
  /**
   * Set once a passcode has been supplied for the current input. Guards against
   * a second submission of the same attempt, because every wrong passcode is
   * charged against a lifetime limit that permanently disables the link. A
   * component that fires its request twice under StrictMode would otherwise
   * spend two of the patient's attempts on one guess.
   */
  passcodeAttempts: number;
  setInput(input: string): void;
  begin(input: string): void;
  progress(run: TraceRun): void;
  complete(result: PipelineResult): void;
  selectFile(index: number): void;
  expandStep(id: string | undefined): void;
  countPasscodeAttempt(): void;
  reset(): void;
}

export const useSession = create<Session>()((set) => ({
  status: 'idle',
  input: '',
  run: undefined,
  result: undefined,
  redactor: undefined,
  expandedStep: undefined,
  selectedFile: 0,
  passcodeAttempts: 0,
  setInput: (input) => set({ input }),
  begin: (input) =>
    set({ status: 'running', input, run: undefined, result: undefined, selectedFile: 0 }),
  progress: (run) => set({ run }),
  complete: (result) =>
    set({
      status: 'done',
      run: result.run,
      result,
      redactor: result.redactor,
      selectedFile: firstOpenFile(result.files),
    }),
  selectFile: (selectedFile) => set({ selectedFile }),
  expandStep: (expandedStep) => set({ expandedStep }),
  countPasscodeAttempt: () => set((state) => ({ passcodeAttempts: state.passcodeAttempts + 1 })),
  reset: () =>
    set({
      status: 'idle',
      input: '',
      run: undefined,
      result: undefined,
      redactor: undefined,
      selectedFile: 0,
      expandedStep: undefined,
      passcodeAttempts: 0,
    }),
}));

function firstOpenFile(files: readonly OpenedFile[]): number {
  const index = files.findIndex((file) => file.content !== undefined);
  return index === -1 ? 0 : index;
}
