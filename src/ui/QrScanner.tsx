/**
 * Reading a QR code, by camera, by dropped image, or off the clipboard.
 *
 * The three inputs are not redundancy for its own sake. At a testing event the
 * code you need to read is as often on a colleague's screen (screenshot, paste)
 * or in a chat message (drag the image in) as it is on a phone held up to the
 * laptop, and the camera is the one of the three that is routinely unavailable.
 *
 * That unavailability is the reason this component exists rather than a bare
 * button. **A page served over plain http from a LAN address is not a secure
 * context, so `getUserMedia` does not exist there, while the same page over
 * http on `localhost` is fine.** That single distinction decides whether the
 * tool works after somebody shares their `pnpm dev` port with the laptop next
 * to them, and a browser reports it as a missing API rather than as a policy
 * decision. So the reason is named on screen, with the fix, instead of a dead
 * button or a bare "camera unavailable".
 *
 * One hard rule: the media tracks stop on unmount, every path. A camera light
 * left on after a modal closes is a breach of trust that no feature is worth.
 */
import { useCallback, useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { Camera, CameraOff, ImageUp, ScanLine, SwitchCamera, X } from 'lucide-react';
import { classifyScan, decodeQrFromImage, parseShcQr, QrNotFoundError } from '../core/qr';
import { Button, Callout } from './primitives';

// ---------------------------------------------------------------------------
// Pure logic: why the camera is not available, and what to say about it
// ---------------------------------------------------------------------------

export interface BrowserContext {
  /** `window.isSecureContext`. */
  secureContext: boolean;
  /** `location.protocol`, including the colon. */
  protocol: string;
  /** `location.hostname`, with no brackets stripped from an IPv6 literal. */
  hostname: string;
  /** Whether `navigator.mediaDevices.getUserMedia` is a function. */
  hasGetUserMedia: boolean;
}

export type CameraVerdict =
  | { available: true }
  /** Plain http from something that is not loopback: the LAN-IP case. */
  | { available: false; reason: 'insecure-lan'; hostname: string }
  /** Not a secure context for some other reason (a sandboxed frame, file://). */
  | { available: false; reason: 'insecure-other' }
  /** A secure context, but the browser exposes no camera API at all. */
  | { available: false; reason: 'unsupported' };

/**
 * Loopback is a secure context whatever the scheme, which is exactly the trap:
 * the developer testing on `localhost` never sees the failure their colleague
 * on `http://192.168.1.24:5173` hits immediately.
 */
export function isLoopbackHostname(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/g, '');
  return (
    bare === 'localhost' ||
    bare.endsWith('.localhost') ||
    bare === '::1' ||
    /^127(?:\.\d{1,3}){3}$/.test(bare)
  );
}

export function cameraVerdict(context: BrowserContext): CameraVerdict {
  if (!context.secureContext) {
    if (context.protocol === 'http:' && !isLoopbackHostname(context.hostname)) {
      return { available: false, reason: 'insecure-lan', hostname: context.hostname };
    }
    return { available: false, reason: 'insecure-other' };
  }
  if (!context.hasGetUserMedia) return { available: false, reason: 'unsupported' };
  return { available: true };
}

/**
 * The DOM types say `navigator.mediaDevices` is always there. It is not: a
 * browser omits the whole property outside a secure context, which is the exact
 * case this component exists to explain. Reading it through a function whose
 * return type admits `undefined` is what keeps the guard alive: assigning to an
 * annotated `const` does not, because the assignment immediately narrows back to
 * the platform type and the guard is then reported as dead code.
 */
function optionalMediaDevices(): MediaDevices | undefined {
  return navigator.mediaDevices;
}

export function readBrowserContext(): BrowserContext {
  return {
    secureContext: window.isSecureContext,
    protocol: window.location.protocol,
    hostname: window.location.hostname,
    hasGetUserMedia: typeof optionalMediaDevices()?.getUserMedia === 'function',
  };
}

/**
 * What went wrong once the camera was actually asked for.
 *
 * `DOMException.name` is the only part of a media error that is stable across
 * browsers; the message is not, and Safari's in particular says nothing. So the
 * name is mapped and the browser's own words are appended rather than trusted.
 */
export function cameraErrorMessage(error: unknown): string {
  const name = error instanceof DOMException ? error.name : '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'Camera permission was refused for this page. The browser remembers that answer per origin, so pressing the button again will not prompt: change it in the padlock or camera menu beside the address bar, then reload.';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return 'No camera is attached, so there is nothing to grant. Drop or paste an image of the code instead.';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'The camera exists but something else is holding it, which on a laptop at an event is almost always a video call in another window. Close that and try again.';
    case 'OverconstrainedError':
      return 'No attached camera matched the request. Try the other camera, or drop an image of the code instead.';
    case 'SecurityError':
      return 'The browser blocked camera access for this page. That is a policy decision about the origin, not a hardware problem.';
    case 'AbortError':
      return 'The browser gave up starting the camera without saying why. Reloading the page usually clears it.';
    default:
      return error instanceof Error && error.message.length > 0
        ? error.message
        : 'The camera could not be started, and the browser gave no reason.';
  }
}

// ---------------------------------------------------------------------------
// The component
// ---------------------------------------------------------------------------

export interface QrScannerProps {
  /** Called once, with the decoded text, already narrowed by `classifyScan`. */
  onResult: (text: string) => void;
  onClose: () => void;
}

/** A chunk of a deprecated multi-QR health card, which is not a link. */
interface ChunkedCard {
  index: number;
  total: number;
  value: string;
}

const FRAME_INTERVAL_MS = 280;

export function QrScanner({ onResult, onClose }: QrScannerProps): ReactNode {
  const dialog = useRef<HTMLDialogElement | null>(null);
  const video = useRef<HTMLVideoElement | null>(null);
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const busy = useRef(false);
  const settled = useRef(false);

  const [verdict] = useState<CameraVerdict>(() => cameraVerdict(readBrowserContext()));
  const [live, setLive] = useState(false);
  const [facing, setFacing] = useState<'environment' | 'user'>('environment');
  const [problem, setProblem] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState('Nothing scanned yet.');
  const [chunked, setChunked] = useState<ChunkedCard | undefined>(undefined);
  const [multipleCameras, setMultipleCameras] = useState(false);

  const stopCamera = useCallback((): void => {
    for (const track of stream.current?.getTracks() ?? []) track.stop();
    stream.current = null;
    const element = video.current;
    if (element !== null) element.srcObject = null;
    setLive(false);
  }, []);

  // Every exit runs through here, including the browser's own Escape handling,
  // so there is one place that guarantees the tracks are released.
  useEffect(() => () => stopCamera(), [stopCamera]);

  useEffect(() => {
    dialog.current?.showModal();
  }, []);

  const finish = useCallback(
    (text: string): void => {
      if (settled.current) return;
      settled.current = true;
      stopCamera();
      // Narrowed rather than passed verbatim: a QR often carries a sentence
      // around the link ("Patient summary for J. Argonaut https://…#shlink:/…")
      // and the surrounding prose is not something the detector should have to
      // survive. classifyScan returns the trimmed text unchanged when there is
      // no link in it, so nothing is lost for the other kinds.
      onResult(classifyScan(text).value);
    },
    [onResult, stopCamera],
  );

  /**
   * A decoded code is not always something to accept. A chunked `shc:/` set is
   * several codes carrying one card, and handing the first chunk onwards would
   * produce a decode failure two screens later with no hint of the cause.
   */
  const accept = useCallback(
    (text: string): void => {
      const classified = classifyScan(text);
      if (classified.kind === 'shc') {
        try {
          const chunk = parseShcQr(classified.value);
          if (chunk.total > 1) {
            setChunked({ index: chunk.index, total: chunk.total, value: classified.value });
            setStatus(`Read chunk ${chunk.index} of ${chunk.total} of a chunked health card.`);
            return;
          }
        } catch {
          // Not parseable as a chunk set, so it is an ordinary shc:/ payload
          // and the code below handles it. The parse error is not worth
          // reporting: the pipeline will say the same thing with more detail.
        }
      }
      finish(text);
    },
    [finish],
  );

  const decodeBlob = useCallback(
    async (blob: Blob): Promise<void> => {
      setProblem(undefined);
      setStatus('Reading the image…');
      try {
        const result = await decodeQrFromImage(blob);
        setStatus(`Found a ${result.format} code.`);
        accept(result.text);
      } catch (error) {
        setStatus('Nothing scanned yet.');
        setProblem(
          error instanceof QrNotFoundError
            ? 'No barcode was found in that image. A screenshot cropped tight to the code, at its original scale, reads far more reliably than a photo of a screen.'
            : error instanceof Error
              ? error.message
              : 'That image could not be read.',
        );
      }
    },
    [accept],
  );

  const startCamera = useCallback(
    async (which: 'environment' | 'user'): Promise<void> => {
      if (!verdict.available) return;
      setProblem(undefined);
      setStatus('Starting the camera…');
      stopCamera();
      try {
        // audio is explicitly false. Asking for a microphone we do not use
        // would put a second permission in the prompt and a second indicator
        // in the tab, for nothing.
        const media = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: which },
          audio: false,
        });
        if (settled.current) {
          for (const track of media.getTracks()) track.stop();
          return;
        }
        stream.current = media;
        const element = video.current;
        if (element !== null) {
          element.srcObject = media;
          await element.play().catch(() => undefined);
        }
        setLive(true);
        setStatus('Camera running. Hold the code steady and fill the frame.');

        // Device labels are empty until a permission has been granted, so this
        // is only worth asking after the stream exists.
        const devices = await navigator.mediaDevices.enumerateDevices();
        setMultipleCameras(devices.filter((device) => device.kind === 'videoinput').length > 1);
      } catch (error) {
        stopCamera();
        setStatus('Nothing scanned yet.');
        setProblem(cameraErrorMessage(error));
      }
    },
    [stopCamera, verdict.available],
  );

  // The scanning loop. A frame with no code in it is the normal case, not an
  // error, so QrNotFoundError is swallowed here and nowhere else.
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => {
      if (busy.current || settled.current) return;
      const element = video.current;
      const surface = canvas.current;
      if (element === null || surface === null) return;
      const width = element.videoWidth;
      const height = element.videoHeight;
      if (width === 0 || height === 0 || element.readyState < 2) return;
      busy.current = true;
      void (async () => {
        try {
          surface.width = width;
          surface.height = height;
          const context = surface.getContext('2d', { willReadFrequently: true });
          if (context === null) return;
          context.drawImage(element, 0, 0, width, height);
          const frame = context.getImageData(0, 0, width, height);
          const result = await decodeQrFromImage(frame);
          setStatus(`Found a ${result.format} code.`);
          accept(result.text);
        } catch (error) {
          if (!(error instanceof QrNotFoundError)) {
            setProblem(error instanceof Error ? error.message : 'The frame could not be read.');
          }
        } finally {
          busy.current = false;
        }
      })();
    }, FRAME_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [live, accept]);

  // Paste is a window listener rather than a handler on a target, because
  // nobody focuses a drop zone before pressing Cmd+V. Both an image and the
  // link text are accepted: people paste whichever they happen to have.
  useEffect(() => {
    const onPaste = (event: ClipboardEvent): void => {
      const items = event.clipboardData?.items ?? [];
      for (const item of items) {
        if (item.kind !== 'file' || !item.type.startsWith('image/')) continue;
        const file = item.getAsFile();
        if (file === null) continue;
        event.preventDefault();
        void decodeBlob(file);
        return;
      }
      const text = event.clipboardData?.getData('text').trim() ?? '';
      if (text.length > 0) {
        event.preventDefault();
        setStatus('Took the text from the clipboard.');
        accept(text);
      }
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [decodeBlob, accept]);

  const onDrop = (event: DragEvent<HTMLDivElement>): void => {
    // stopPropagation matters: this dialog is nested inside the form that owns
    // the link field, and that form has its own drop handler. Without this, one
    // dropped image is handled twice, once as an image and once as pasted text.
    event.preventDefault();
    event.stopPropagation();
    const file = event.dataTransfer.files.item(0);
    if (file !== null) {
      void decodeBlob(file);
      return;
    }
    const text = event.dataTransfer.getData('text').trim();
    if (text.length > 0) accept(text);
  };

  return (
    <dialog
      ref={dialog}
      className="scanner"
      aria-labelledby="scanner-title"
      onClose={onClose}
      onClick={(event) => {
        // A modal dialog's backdrop is part of the dialog element itself, so a
        // click landing on the element and not on its contents is a backdrop
        // click. This is the only way to get click-outside-to-close natively.
        if (event.target === dialog.current) onClose();
      }}
    >
      <div className="scanner-panel">
        <header className="scanner-head">
          <h2 id="scanner-title">
            <ScanLine size={16} aria-hidden /> Scan a code
          </h2>
          <Button variant="ghost" size="sm" onClick={onClose}>
            <X size={14} aria-hidden />
            <span>Close</span>
          </Button>
        </header>

        <div className="scanner-body">
          {verdict.available ? (
            <div className="scanner-camera">
              <div className="scanner-stage" data-live={live ? 'yes' : 'no'}>
                <video ref={video} className="scanner-video" playsInline muted autoPlay />
                {live ? null : (
                  <div className="scanner-stage-idle">
                    <Camera size={22} aria-hidden />
                    <p>The camera is off until you start it, and stops when this closes.</p>
                  </div>
                )}
              </div>
              <div className="scanner-controls">
                {live ? (
                  <Button onClick={stopCamera}>
                    <CameraOff size={14} aria-hidden />
                    <span>Stop the camera</span>
                  </Button>
                ) : (
                  <Button variant="primary" onClick={() => void startCamera(facing)}>
                    <Camera size={14} aria-hidden />
                    <span>Start the camera</span>
                  </Button>
                )}
                {multipleCameras ? (
                  <Button
                    onClick={() => {
                      const next = facing === 'environment' ? 'user' : 'environment';
                      setFacing(next);
                      void startCamera(next);
                    }}
                  >
                    <SwitchCamera size={14} aria-hidden />
                    <span>{facing === 'environment' ? 'Front camera' : 'Rear camera'}</span>
                  </Button>
                ) : null}
              </div>
            </div>
          ) : (
            <CameraUnavailable verdict={verdict} />
          )}

          <div
            className="scanner-drop"
            onDragOver={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            onDrop={onDrop}
          >
            <ImageUp size={20} aria-hidden />
            <p>
              Drop an image of the code here, or press <kbd>Cmd</kbd>/<kbd>Ctrl</kbd> + <kbd>V</kbd>{' '}
              to read one from the clipboard. Pasted link text is accepted too.
            </p>
            {/* A drop zone alone is unreachable by keyboard and by touch, so
                the file input is always present rather than a hover extra. */}
            <label className="scanner-file btn">
              <input
                className="visually-hidden"
                type="file"
                accept="image/*"
                onChange={(event) => {
                  const input = event.target;
                  const file = input.files?.item(0);
                  // Clearing the value matters: without it, choosing the same
                  // file again fires no change event, so a retry after a failed
                  // decode does nothing at all and looks like a broken button.
                  input.value = '';
                  if (file !== null && file !== undefined) void decodeBlob(file);
                }}
              />
              <span>Choose an image…</span>
            </label>
          </div>

          <p className="scanner-status" aria-live="polite">
            {status}
          </p>

          {chunked === undefined ? null : (
            <Callout tone="warn" title={`Chunk ${chunked.index} of ${chunked.total}`}>
              <p>
                This is one code of {chunked.total} carrying a single SMART Health Card. Chunked QRs
                were deprecated in December 2022, and a card that needs them is one the issuer
                should be sharing as a health link instead. Loupe reads one code at a time here, so
                the other {chunked.total - 1} would have nowhere to go.
              </p>
              <p>
                <Button size="sm" onClick={() => finish(chunked.value)}>
                  Use this chunk anyway
                </Button>{' '}
                It will decode as far as the missing chunks allow, which is a useful thing to see
                stated rather than guessed at.
              </p>
            </Callout>
          )}

          {problem === undefined ? null : (
            <Callout tone="fail" title="That did not work">
              {problem}
            </Callout>
          )}
        </div>
      </div>
      {/* Off-screen rather than hidden: a display:none canvas still has a
          drawing surface, but keeping it in the layout-free corner avoids any
          browser bug around zero-sized backing stores. */}
      <canvas ref={canvas} className="scanner-canvas" aria-hidden />
    </dialog>
  );
}

function CameraUnavailable({ verdict }: { verdict: CameraVerdict }): ReactNode {
  if (verdict.available) return null;
  if (verdict.reason === 'insecure-lan') {
    return (
      <Callout tone="warn" title="The camera is blocked, and not by a permission">
        <p>
          This page is served over plain http from <code>{verdict.hostname}</code>. A browser only
          treats http as a secure context on <code>localhost</code>, and <code>getUserMedia</code>{' '}
          does not exist outside a secure context, so there is nothing here to grant permission to.
        </p>
        <p>
          This is the shape the problem takes when somebody shares their dev server with the laptop
          next to them: the camera works for the person running it and vanishes for everyone else on
          the same URL. Serve the page over https, or open it as <code>http://localhost</code> on
          the machine running the server. Dropping or pasting an image works either way.
        </p>
      </Callout>
    );
  }
  if (verdict.reason === 'insecure-other') {
    return (
      <Callout tone="warn" title="This page is not a secure context">
        <p>
          The camera API is only exposed to a secure context, which is https, or http on{' '}
          <code>localhost</code>. A <code>file://</code> page or a sandboxed frame is not one. Drop
          or paste an image of the code instead.
        </p>
      </Callout>
    );
  }
  return (
    <Callout tone="warn" title="This browser exposes no camera API">
      <p>
        <code>navigator.mediaDevices.getUserMedia</code> is missing even though the page is a secure
        context, which usually means an enterprise policy or a stripped-down browser build. Drop or
        paste an image of the code instead.
      </p>
    </Callout>
  );
}
