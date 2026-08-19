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
import { useMemo, useRef, useState, type DragEvent, type FormEvent, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { ArrowRight, QrCode, X } from 'lucide-react';
import { detectInput } from '../core/detect';
import { QrScanner } from '../ui/QrScanner';
import { StatusIcon, type Tone } from '../ui/primitives';
import { useSession } from './store';

/**
 * How confident to look about each recognised form. Keyed by string rather than
 * by the union, so a kind added to the detector later renders as a plain note
 * instead of crashing the header.
 */
const KIND_TONE: Record<string, Tone> = {
  shlink: 'pass',
  shc: 'pass',
  jwe: 'pass',
  manifest: 'pass',
  fhir: 'pass',
  jws: 'pass',
  hcert: 'info',
  unknown: 'warn',
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

  const submit = (event: FormEvent): void => {
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
          inputMode="text"
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
        <button type="submit" className="btn btn-primary btn-sm" disabled={value.trim().length === 0}>
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
            <StatusIcon tone={KIND_TONE[String(detected.kind)] ?? 'info'} />
            <strong className="link-verdict-label">{detected.label}</strong>
            <span className="link-verdict-detail">{detected.description}</span>
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
