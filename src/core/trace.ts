/**
 * The trace model.
 *
 * Loupe's whole reason to exist is that opening a SMART Health Link is a
 * multi-step pipeline whose failures are, in every other viewer, collapsed into
 * one opaque message. So the pipeline here is a recorded run: every step is a
 * plain, serialisable record carrying its inputs, its evidence, its timing and
 * its verdict.
 *
 * Two rules hold this together, and both are load bearing:
 *
 * 1. A run is DATA, never a stack of closures. It serialises to JSON, which is
 *    what makes "export this diagnosis and paste it in chat" possible, and what
 *    makes a run replayable in a test with no network at all.
 * 2. Secrets are REGISTERED, not stripped. The run holds the truth, because the
 *    person looking at it is holding the link and is entitled to see their own
 *    key. What must never carry the key is anything that leaves the tab: an
 *    exported report, a copied command, a projected screen. So redaction happens
 *    at the export boundary ({@link redactRun}) and masking happens in the UI,
 *    and neither depends on the order steps happened to run in. An earlier
 *    design redacted on write, and it silently leaked the key in the one step
 *    that recorded the payload before the key had been registered.
 */

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

/**
 * Every distinct thing the pipeline does. The list is closed on purpose: a new
 * step kind is a deliberate change to the story the trace tells, and the UI
 * maps each kind to a label, an icon and a spec citation.
 */
export type StepKind =
  | 'input.detect' // classify what was pasted, scanned or deep linked
  | 'shlink.decode' // base64url to payload JSON
  | 'shlink.validate' // per member conformance against the SHL spec
  | 'static.analyse' // everything knowable with no network at all
  | 'net.reachability' // opt in probes that narrow an opaque fetch failure
  | 'net.manifest' // POST the manifest endpoint
  | 'net.direct' // GET the file directly (U flag)
  | 'net.file' // GET one manifest file by location
  | 'net.jwks' // GET an SHC issuer key set
  | 'manifest.validate' // shape and conformance of the manifest response
  | 'jwe.header' // decode and check the JWE protected header
  | 'jwe.decrypt' // AES-256-GCM, alg=dir
  | 'payload.inflate' // zip=DEF raw DEFLATE
  | 'payload.classify' // what did we actually get
  | 'shc.verify' // ES256 signature over a health card
  | 'fhir.parse' // parse and index a bundle
  | 'fhir.resolve'; // resolve references inside the bundle

export type StepStatus =
  | 'pending'
  | 'running'
  | 'ok'
  | 'warn' // completed, but something is off
  | 'fail' // this step could not complete
  | 'blocked' // could not even be attempted, and we know why
  | 'skipped'; // legitimately not applicable

/**
 * A single recorded step. `parentId` lets per-file work nest under the manifest
 * step that discovered it, which is what turns a flat log into the shape of the
 * link's actual path.
 */
export interface TraceStep {
  id: string;
  parentId?: string;
  kind: StepKind;
  /** Short imperative label, sentence case, no trailing full stop. */
  title: string;
  /** One line of what this step is for, shown under the title when expanded. */
  summary?: string;
  status: StepStatus;
  startedAt: number;
  durationMs?: number;
  evidence: Evidence[];
  /** Rule ids raised while this step ran. The findings themselves live on the run. */
  findingIds: string[];
}

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/**
 * What a step observed. A discriminated union rather than a string blob so the
 * UI can render a header table as a table, a request as a copyable curl, and a
 * spec citation as a link.
 */
export type Evidence =
  | { type: 'note'; text: string }
  | { type: 'kv'; rows: KvRow[] }
  | { type: 'json'; label: string; value: unknown; collapsed?: boolean }
  | { type: 'text'; label: string; value: string; language?: 'json' | 'jwt' | 'xml' | 'plain' }
  | { type: 'bytes'; label: string; length: number; preview: string }
  | { type: 'request'; request: HttpRequestRecord }
  | { type: 'response'; response: HttpResponseRecord }
  | { type: 'command'; label: string; shell: 'bash' | 'powershell'; command: string }
  | { type: 'citation'; citation: Citation };

export interface KvRow {
  key: string;
  value: string;
  /** Renders the value in mono. Default true for anything wire level. */
  mono?: boolean;
  /** A per row verdict, for field level conformance tables. */
  status?: Exclude<StepStatus, 'pending' | 'running'>;
  /** Why this row has the status it has. */
  note?: string;
}

export interface HttpRequestRecord {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string;
  /** True when the body or URL had secret material removed before recording. */
  redacted?: boolean;
}

export interface HttpResponseRecord {
  /** 0 when the browser gave us an opaque or failed response. */
  status: number;
  statusText?: string;
  /**
   * Headers the browser let script read. Cross origin, that is only the CORS
   * safelist plus whatever Access-Control-Expose-Headers names, so this is
   * routinely a subset of what the server sent. The UI says so rather than
   * implying the server sent nothing else.
   */
  headers: Record<string, string>;
  /** `type` from the Fetch spec: 'basic' | 'cors' | 'opaque' | 'opaqueredirect' | 'error'. */
  responseType?: string;
  /** True when fetch followed at least one redirect. Intermediate hops are not observable. */
  redirected?: boolean;
  /** The URL the response actually came from, after any redirects. */
  finalUrl?: string;
  bodyPreview?: string;
  bodyBytes?: number;
  durationMs?: number;
  /** Set when the fetch rejected. The browser message, verbatim. */
  networkError?: string;
}

export interface Citation {
  /** Human readable spec name, for example "SHL spec". */
  spec: string;
  /** Section heading as printed in the spec. */
  section: string;
  url: string;
  /** The normative sentence, quoted verbatim. */
  quote?: string;
}

// ---------------------------------------------------------------------------
// Findings
// ---------------------------------------------------------------------------

export type Severity = 'fatal' | 'error' | 'warning' | 'info' | 'good';

/**
 * Who has to act. This distinction is the point of the whole tool: at an event
 * the argument is always "it works for me", and a finding that names the
 * responsible side ends that argument in one line.
 */
export type Audience =
  | 'you' // the person holding this viewer
  | 'sender' // whoever minted the link
  | 'server' // the sharing server's operator
  | 'nobody'; // informational

export interface Finding {
  id: string;
  /** Stable rule identifier, for example SHL-URL-LOCALHOST. Quoted in reports. */
  ruleId: string;
  severity: Severity;
  audience: Audience;
  /** One line, plain words, states the fact. No hedging, no jargon. */
  title: string;
  /** Two to four sentences: what this means and how we know. */
  detail: string;
  /** The concrete next action, if there is one. */
  remedy?: string;
  citation?: Citation;
  /** The step that raised it. */
  stepId?: string;
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export type InputKind =
  | 'shlink' // shlink:/... or a viewer URL carrying one
  | 'shc' // shc:/ numeric health card
  | 'jwe' // a bare JWE compact serialisation
  | 'manifest' // a pasted manifest JSON response
  | 'fhir' // a pasted FHIR resource or bundle
  | 'jws' // a bare compact JWS
  | 'hcert' // HC1: base45 COSE, the EU DCC and WHO DDCC family
  | 'unknown';

export type RunOutcome =
  | 'running'
  | 'opened' // we have content to show
  | 'partial' // some files opened, some did not
  | 'blocked' // we know it cannot work and did not waste a request
  | 'failed'; // we tried and it did not work

export interface TraceRun {
  id: string;
  startedAt: number;
  finishedAt?: number;
  outcome: RunOutcome;
  /**
   * The input verbatim. Secrets inside it are masked by {@link redactRun} at the
   * export boundary rather than here, so the live view can show the user their
   * own link in full.
   */
  input: { kind: InputKind; label?: string; source: string };
  steps: TraceStep[];
  findings: Finding[];
  /** Whether any network request was issued at all. Drives the "offline" badge. */
  networkUsed: boolean;
}

export type RunListener = (run: TraceRun) => void;

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * The registry of values that must not leave the tab.
 *
 * Registration is by exact string, not by pattern, because the secrets here are
 * known exactly (the link's symmetric key, a passcode the user typed) and a
 * pattern wide enough to catch a 43-character base64url key would also eat the
 * JWE ciphertext, which is the thing a debugger most wants to show.
 */
export class Redactor {
  private readonly secrets = new Map<string, string>();

  register(secret: string, label: string): void {
    if (secret.length >= 8) this.secrets.set(secret, `[${label} redacted]`);
  }

  /** Every registered secret, so the UI can mask a value it is about to render. */
  entries(): Array<[string, string]> {
    return [...this.secrets];
  }

  text(value: string): string {
    let out = value;
    for (const [secret, mask] of this.secrets) out = out.split(secret).join(mask);
    return out;
  }

  json<T>(value: T): T {
    if (this.secrets.size === 0) return value;
    return JSON.parse(this.text(JSON.stringify(value))) as T;
  }

  get isActive(): boolean {
    return this.secrets.size > 0;
  }
}

/**
 * An export-safe copy of a run: the same structure, with every registered
 * secret replaced. This is what "Copy diagnosis" and "Share report" serialise,
 * and the one place the guarantee is made, so it cannot be forgotten per call
 * site.
 */
export function redactRun(run: TraceRun, redactor: Redactor): TraceRun {
  if (!redactor.isActive) return run;
  return redactor.json(run);
}

// ---------------------------------------------------------------------------
// Recorder
// ---------------------------------------------------------------------------

let counter = 0;
const nextId = (prefix: string): string => `${prefix}${(++counter).toString(36)}`;

export interface StepSpec {
  kind: StepKind;
  title: string;
  summary?: string;
  parentId?: string;
}

/** The handle a step body uses to record what it saw. */
export interface StepHandle {
  readonly id: string;
  note(text: string): void;
  kv(rows: KvRow[]): void;
  json(label: string, value: unknown, collapsed?: boolean): void;
  text(label: string, value: string, language?: 'json' | 'jwt' | 'xml' | 'plain'): void;
  bytes(label: string, data: Uint8Array): void;
  request(request: HttpRequestRecord): void;
  response(response: HttpResponseRecord): void;
  command(label: string, shell: 'bash' | 'powershell', command: string): void;
  cite(citation: Citation): void;
  /** Raise a finding against this step. Returns the finding id. */
  find(finding: Omit<Finding, 'id' | 'stepId'>): string;
  /** Nest a child step under this one. */
  child(spec: Omit<StepSpec, 'parentId'>): StepHandle;
  /** Close the step. Called for you by `Recorder.run`; explicit for manual steps. */
  end(status: StepStatus): void;
}

/**
 * Owns one {@link TraceRun}, notifies subscribers on every mutation so the UI
 * streams the trace as it happens, and routes all evidence through the
 * {@link Redactor}.
 */
export class Recorder {
  readonly redactor = new Redactor();
  private readonly listeners = new Set<RunListener>();
  private readonly current: TraceRun;
  private readonly now: () => number;

  constructor(input: TraceRun['input'], now: () => number = () => Date.now()) {
    this.now = now;
    this.current = {
      id: nextId('run-'),
      startedAt: now(),
      outcome: 'running',
      input,
      steps: [],
      findings: [],
      networkUsed: false,
    };
  }

  subscribe(listener: RunListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  snapshot(): TraceRun {
    // A shallow clone per level is enough: steps and findings are only ever
    // appended to or status-flipped, and the UI treats them as immutable rows.
    return {
      ...this.current,
      steps: [...this.current.steps],
      findings: [...this.current.findings],
    };
  }

  private emit(): void {
    const snap = this.snapshot();
    for (const listener of this.listeners) listener(snap);
  }

  markNetworkUsed(): void {
    if (!this.current.networkUsed) {
      this.current.networkUsed = true;
      this.emit();
    }
  }

  finish(outcome: RunOutcome): TraceRun {
    this.current.outcome = outcome;
    this.current.finishedAt = this.now();
    this.emit();
    return this.snapshot();
  }

  /** Raise a finding not attributable to a single step. */
  find(finding: Omit<Finding, 'id'>): string {
    const id = nextId('f-');
    this.current.findings.push({ ...finding, id });
    this.emit();
    return id;
  }

  open(spec: StepSpec): StepHandle {
    const step: TraceStep = {
      id: nextId('s-'),
      ...(spec.parentId === undefined ? {} : { parentId: spec.parentId }),
      kind: spec.kind,
      title: spec.title,
      ...(spec.summary === undefined ? {} : { summary: spec.summary }),
      status: 'running',
      startedAt: this.now(),
      evidence: [],
      findingIds: [],
    };
    this.current.steps.push(step);
    this.emit();
    return this.handleFor(step);
  }

  /**
   * Run `body` as one step, timing it and setting its status from the outcome.
   * A thrown {@link StepFailure} sets the status it carries; any other throw is
   * a fail with the error recorded as a note, because an unexpected exception
   * inside the pipeline is itself a finding worth showing rather than a blank
   * screen.
   */
  async run<T>(spec: StepSpec, body: (step: StepHandle) => Promise<T> | T): Promise<T> {
    const handle = this.open(spec);
    try {
      const result = await body(handle);
      const step = this.stepById(handle.id);
      // A body may set warn/fail itself via `end`; only default when it did not.
      if (step && step.status === 'running') handle.end('ok');
      return result;
    } catch (error) {
      const status = error instanceof StepFailure ? error.status : 'fail';
      if (!(error instanceof StepFailure)) {
        handle.note(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
      }
      handle.end(status);
      throw error;
    }
  }

  private stepById(id: string): TraceStep | undefined {
    return this.current.steps.find((s) => s.id === id);
  }

  private handleFor(step: TraceStep): StepHandle {
    const push = (evidence: Evidence): void => {
      step.evidence.push(evidence);
      this.emit();
    };
    return {
      id: step.id,
      note: (text) => push({ type: 'note', text }),
      kv: (rows) => push({ type: 'kv', rows }),
      json: (label, value, collapsed) =>
        push({
          type: 'json',
          label,
          value,
          ...(collapsed === undefined ? {} : { collapsed }),
        }),
      text: (label, value, language) =>
        push({
          type: 'text',
          label,
          value,
          ...(language === undefined ? {} : { language }),
        }),
      bytes: (label, data) =>
        push({ type: 'bytes', label, length: data.byteLength, preview: hexPreview(data) }),
      request: (request) => push({ type: 'request', request }),
      response: (response) => push({ type: 'response', response }),
      command: (label, shell, command) => push({ type: 'command', label, shell, command }),
      cite: (citation) => push({ type: 'citation', citation }),
      find: (finding) => {
        const id = nextId('f-');
        this.current.findings.push({ ...finding, id, stepId: step.id });
        step.findingIds.push(id);
        this.emit();
        return id;
      },
      child: (spec) => this.open({ ...spec, parentId: step.id }),
      end: (status) => {
        step.status = status;
        step.durationMs = this.now() - step.startedAt;
        this.emit();
      },
    };
  }
}

/** Thrown by a step body to end its step with a specific non-ok status. */
export class StepFailure extends Error {
  constructor(
    message: string,
    readonly status: Extract<StepStatus, 'fail' | 'blocked' | 'warn'> = 'fail',
  ) {
    super(message);
    this.name = 'StepFailure';
  }
}

function hexPreview(data: Uint8Array, limit = 32): string {
  const head = Array.from(data.slice(0, limit))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ');
  return data.byteLength > limit ? `${head} …` : head;
}

/** Highest severity present, for a run level verdict chip. */
export function worstSeverity(findings: readonly Finding[]): Severity | undefined {
  const order: Severity[] = ['fatal', 'error', 'warning', 'info', 'good'];
  for (const severity of order) if (findings.some((f) => f.severity === severity)) return severity;
  return undefined;
}
