/**
 * The one input, and the reason there is no mode switch.
 *
 * At an event people paste whatever they were handed: a bare `shlink:/`, a
 * viewer URL with the payload after its `#`, a naked base64url blob out of a
 * chat message, an `shc:/` numeric string off a phone screen, a manifest they
 * already fetched with curl, or a `.json` file a colleague sent. A tool that
 * asks which of those it is has moved the classification job onto the person
 * least able to do it. So there is one field, it accepts all of them, and it
 * says out loud what it thinks it is looking at before anything is submitted.
 *
 * The preview under the field used to print the detector's output verbatim: the
 * kind, then its whole two-sentence description, then every fact joined with
 * middle dots. Three separate registers in one run-on line, and the label
 * collided with the sentence that repeated it. It is now three tiers instead:
 * a chip for the kind, ONE sentence for what happens next, and the facts as
 * discrete labelled items. See {@link consequenceSentence} and
 * {@link detectionFacts} for the two pieces of judgement that needs.
 */
import {
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type SyntheticEvent,
  type ReactNode,
} from 'react';
import { clsx } from 'clsx';
import { ArrowRight, QrCode, X } from 'lucide-react';
import { detectInput, type DetectedInput, type DetectedVariant } from '../core/detect';
import { QrScanner } from '../ui/QrScanner';
import { Chip, StatusIcon, type Tone } from '../ui/primitives';
import { useSession } from './store';

/**
 * A two-to-four word name for each shape, because the detector's own sentence is
 * a sentence and the eye needs something shorter to land on first. Held as a
 * full record rather than a lookup with a fallback so that adding a variant to
 * the detector fails the typecheck here instead of rendering a blank label.
 */
export const VARIANT_LABEL: Record<DetectedVariant, string> = {
  empty: 'Nothing yet',
  'shlink-uri': 'SMART Health Link',
  'shlink-uri-double-slash': 'Health Link, two slashes',
  'viewer-fragment': 'Viewer URL, link in the fragment',
  'viewer-query': 'Viewer URL, link in the query',
  'bare-payload': 'Bare link payload',
  'shc-numeric': 'Health Card, numeric QR',
  'shc-file': 'Health Card file',
  'jws-compact': 'Signed JWS',
  'jwe-compact': 'Encrypted JWE',
  'manifest-json': 'Manifest response',
  'fhir-bundle': 'FHIR Bundle',
  'fhir-resource': 'FHIR resource',
  'hcert-base45': 'HC1 certificate',
  base64url: 'base64url, contents unclear',
  'json-unrecognised': 'JSON, not recognised',
  unrecognised: 'Not recognised',
};

/**
 * The detector's confidence drives the tone, not the kind: "this is certainly a
 * FHIR Bundle" and "this might be a link payload" deserve different faces, and
 * an unrecognised paste is the one case where a warning is the honest answer.
 */
export function toneForDetection(detected: DetectedInput): Tone {
  if (detected.kind === 'unknown') return 'warn';
  switch (detected.confidence) {
    case 'certain':
      return 'pass';
    case 'likely':
      return 'info';
    default:
      return 'warn';
  }
}

// ---------------------------------------------------------------------------
// Shaping the detector's prose
// ---------------------------------------------------------------------------

/**
 * Split prose into sentences without a lookbehind.
 *
 * A naive `split('. ')` is not enough and `[^.!?]+` is worse: `shl.example.org`
 * and `raw.githubusercontent.com` are full of full stops, and a host is exactly
 * what these sentences end on. The signal is a terminator followed by
 * whitespace AND a capital, which a host never has, so the pattern keeps the
 * terminator in a capture group and the split is put back together below.
 * Lookbehind would read better and is deliberately avoided: it is the one
 * regular-expression feature this tool cannot assume on a borrowed laptop.
 */
export function splitSentences(text: string): string[] {
  const pieces = text.split(/([.!?])\s+(?=[A-Z])/);
  const sentences: string[] = [];
  for (let index = 0; index < pieces.length; index += 2) {
    const body = pieces[index] ?? '';
    const terminator = pieces[index + 1] ?? '';
    const sentence = `${body}${terminator}`.trim();
    if (sentence.length > 0) sentences.push(sentence);
  }
  return sentences;
}

/**
 * The one sentence worth the space under the field: what SHLoupe is about to do.
 *
 * The detector writes identity first and consequence second ("A SMART Health
 * Link pointing at shl.example.org. SHLoupe will check every member of the
 * payload, then…"), and the chip beside this already carries the identity, so
 * printing both is what made the preview read as a run-on.
 *
 * The trap is that not every leading sentence is an identity statement: "A
 * numeric SMART Health Card whose digit count is odd (147), so at least one
 * digit is missing" is a finding, and dropping it would lose the only place
 * that fact is stated. The test is a comma: the detector names a thing in a
 * comma-free clause and qualifies it with one. So a leading sentence is dropped
 * only while it has no comma and is short, and the last sentence is always
 * kept.
 */
const IDENTITY_MAX = 80;

export function consequenceSentence(sentence: string): string {
  const sentences = splitSentences(sentence);
  let first = 0;
  while (first < sentences.length - 1) {
    const candidate = sentences[first];
    if (candidate === undefined) break;
    if (candidate.includes(',') || candidate.length > IDENTITY_MAX) break;
    first += 1;
  }
  return sentences.slice(first).join(' ');
}

export interface DetectionFact {
  /** Present when the fact's own wording names what it is a value of. */
  label: string | undefined;
  value: string;
  /** A value with no spaces is a token, and a token is read in mono. */
  mono: boolean;
}

/**
 * The leading words the detector uses as a label, and what to call each one.
 *
 * This couples to `src/core/detect.ts`'s wording, on purpose and cheaply: the
 * detector produces prose facts ("manifest host shl.example.org") rather than
 * pairs, and a fact whose prefix is not listed here is simply shown whole. So
 * the coupling degrades to "no label", never to a wrong one or a crash, which is
 * the trade that makes it safe to keep the detector free of presentation.
 *
 * Longest first, so a prefix cannot be shadowed by a shorter one.
 */
const FACT_PREFIXES: Array<{ prefix: string; label: string }> = [
  { prefix: 'access-control-allow-origin:', label: 'allow-origin' },
  { prefix: 'manifest host', label: 'host' },
  { prefix: 'resourceType', label: 'resource' },
  { prefix: 'carried as', label: 'carried as' },
  { prefix: 'labelled', label: 'label' },
  { prefix: 'status', label: 'status' },
  { prefix: 'flags', label: 'flags' },
  { prefix: 'HTTP', label: 'HTTP' },
  { prefix: 'type', label: 'type' },
  { prefix: 'alg', label: 'alg' },
  { prefix: 'enc', label: 'enc' },
  { prefix: 'zip', label: 'zip' },
  { prefix: 'kid', label: 'kid' },
];

/** "256 characters of payload" is a labelled fact written back to front. */
const SIZE_OF = /^(\d+ (?:characters|bytes|digits)) of (.+)$/;

function splitFact(detail: string): DetectionFact {
  const size = SIZE_OF.exec(detail);
  if (size?.[1] !== undefined && size[2] !== undefined) {
    return { label: size[2], value: size[1], mono: false };
  }
  for (const { prefix, label } of FACT_PREFIXES) {
    if (!detail.startsWith(`${prefix} `)) continue;
    const value = detail.slice(prefix.length + 1).trim();
    return { label, value, mono: !value.includes(' ') };
  }
  return { label: undefined, value: detail, mono: false };
}

/**
 * The facts, as discrete items rather than as one dot-separated run.
 *
 * The run was the review's complaint and it was not only ugly: five facts in one
 * line with the same weight means the host and the flags, which are what
 * somebody is looking for, sit level with the character count.
 */
export function detectionFacts(details: readonly string[]): DetectionFact[] {
  return details.map(splitFact);
}

/** What the chip's tooltip says, since "certain" and "unsure" are not the same claim. */
const CONFIDENCE_NOTE: Record<DetectedInput['confidence'], string> = {
  certain: 'SHLoupe is certain of this shape.',
  likely: 'SHLoupe is fairly sure of this shape, and says so rather than guessing.',
  unsure: 'SHLoupe is unsure of this shape, and says so rather than guessing.',
};

const DROPPABLE = /\.(txt|json|jose|jwe)$/i;

export function LinkInput({ onSubmit }: { onSubmit: (value: string) => void }): ReactNode {
  const value = useSession((state) => state.input);
  const setInput = useSession((state) => state.setInput);
  const [dragging, setDragging] = useState(false);
  const [scanning, setScanning] = useState(false);
  const field = useRef<HTMLInputElement | null>(null);

  const detected = useMemo(() => {
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : detectInput(trimmed);
  }, [value]);

  const submit = (event: SyntheticEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const trimmed = value.trim();
    if (trimmed.length > 0) onSubmit(trimmed);
  };

  const accept = (text: string): void => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    setInput(trimmed);
    onSubmit(trimmed);
  };

  // A dropped file and a scanned code both arrive complete, so they open
  // straight away. Nothing here can spend a passcode attempt: a link needing
  // one stops at the manifest step until somebody types it.
  const onDrop = (event: DragEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files.item(0);
    if (file && (DROPPABLE.test(file.name) || file.type === '' || file.type.startsWith('text/'))) {
      void file.text().then(accept);
      return;
    }
    const text = event.dataTransfer.getData('text');
    if (text.length > 0) accept(text);
  };

  return (
    <form
      className={clsx('link-input', dragging && 'is-dragging')}
      onSubmit={submit}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <div className="link-field">
        <label className="visually-hidden" htmlFor="link-field-input">
          A SMART Health Link, a viewer URL, a payload, an shc:/ string, or pasted JSON
        </label>
        <input
          id="link-field-input"
          ref={field}
          className="link-field-input opaque-value"
          type="text"
          autoComplete="off"
          spellCheck={false}
          placeholder="shlink:/eyJ1cmwiOi… or a viewer URL, a payload, shc:/, or pasted JSON"
          value={value}
          onChange={(event) => setInput(event.target.value)}
          aria-describedby="link-field-verdict"
        />
        {value.length > 0 ? (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              setInput('');
              field.current?.focus();
            }}
          >
            <X size={13} aria-hidden />
            <span className="visually-hidden">Clear the field</span>
          </button>
        ) : null}
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setScanning(true)}
          title="Scan a QR code with the camera"
        >
          <QrCode size={14} aria-hidden />
          <span className="visually-hidden">Scan a QR code</span>
        </button>
        <button
          type="submit"
          className="btn btn-primary btn-sm"
          disabled={value.trim().length === 0}
        >
          <span>Open</span>
          <ArrowRight size={13} aria-hidden />
        </button>
      </div>

      <DetectionPreview detected={detected} />

      {scanning ? (
        <QrScanner
          onResult={(text: string) => {
            setScanning(false);
            accept(text);
          }}
          onClose={() => setScanning(false)}
        />
      ) : null}
    </form>
  );
}

/**
 * The preview under the field.
 *
 * It sits inside the masthead, so its height is a shared resource: every state
 * has to fit the SAME box, or the whole page below jumps as somebody types. Two
 * things hold it still, and both are in `screens.css` beside the reason: the
 * block reserves the height of its tallest ordinary state, and the sentence is
 * clamped to two lines. The full sentence stays in the DOM, so a screen reader
 * reads all of it and the title attribute carries the identity clause that
 * {@link consequenceSentence} drops.
 */
function DetectionPreview({ detected }: { detected: DetectedInput | undefined }): ReactNode {
  if (detected === undefined) {
    return (
      <div className="detect" id="link-field-verdict" aria-live="polite" data-state="idle">
        {/*
          One short line, not three sentences.
          
          What this field accepts is already in the placeholder, and the screen
          below already explains the whole path, so spelling it out a third time
          in the masthead pushed the tab strip down the page for no gain. What is
          left is the one fact neither of those carries and that a first-time
          reader wants before typing: nothing is sent until they ask.
        */}
        <p className="detect-idle">
          Nothing is requested until you press Open. A file can be dropped here, and the icon scans
          a QR code.
        </p>
      </div>
    );
  }

  const tone = toneForDetection(detected);
  const facts = detectionFacts(detected.details);
  const elsewhere = detected.kind !== 'shlink' && detected.kind !== 'unknown';

  return (
    <div className="detect" id="link-field-verdict" aria-live="polite" data-state="detected">
      <div className="detect-head">
        <Chip tone={tone} title={CONFIDENCE_NOTE[detected.confidence]}>
          <StatusIcon tone={tone} size={12} />
          <span>{VARIANT_LABEL[detected.variant]}</span>
          {/* The word, not the colour, carries the doubt. A tone alone would say
              this to nobody who cannot see the difference between blue and
              green. */}
          {detected.confidence === 'certain' ? null : (
            <span className="detect-confidence">{detected.confidence}</span>
          )}
        </Chip>
        <p className="detect-next" title={detected.sentence}>
          {consequenceSentence(detected.sentence)}
        </p>
      </div>

      {facts.length > 0 ? (
        <ul className="detect-facts">
          {facts.map((fact, index) => (
            <li className="detect-fact" key={`${fact.label ?? ''}-${index}`}>
              {fact.label === undefined ? null : (
                <span className="detect-fact-label">{fact.label}</span>
              )}
              {/* `is-token`, not the shared `.mono`: that utility carries its own
                  font size, which is larger than this block's and would make one
                  pill taller than its neighbours. */}
              <span className={clsx('detect-fact-value', fact.mono && 'is-token')}>
                {fact.value}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {elsewhere ? (
        <a className="detect-elsewhere" href="#/offline">
          This screen opens links. Run this one through Offline mode instead.
        </a>
      ) : null}
    </div>
  );
}
