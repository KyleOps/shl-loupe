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
import { StatusIcon, type Tone } from '../ui/primitives';
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

      <p className="link-verdict" id="link-field-verdict" aria-live="polite">
        {detected === undefined ? (
          <span className="link-verdict-idle">
            Paste a link, a payload, an <code>shc:/</code> string or JSON. A <code>.txt</code> or{' '}
            <code>.json</code> file can be dropped here too.
          </span>
        ) : (
          <>
            <StatusIcon tone={toneForDetection(detected)} />
            <strong className="link-verdict-label">{VARIANT_LABEL[detected.variant]}</strong>
            <span className="link-verdict-detail">{detected.sentence}</span>
            {detected.details.length > 0 ? (
              <span className="link-verdict-facts">{detected.details.join(' · ')}</span>
            ) : null}
            {detected.kind !== 'shlink' && detected.kind !== 'unknown' ? (
              <a className="link-verdict-elsewhere" href="#/offline">
                This screen opens links. Run this one through Offline mode instead.
              </a>
            ) : null}
          </>
        )}
      </p>

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
