/**
 * The shared vocabulary. Every screen and component builds from these, so the
 * app reads as one system rather than as a pile of screens.
 *
 * Three rules are enforced here rather than left to each caller:
 *
 *  - Status is never colour alone. A verdict carries a distinct icon silhouette
 *    and a word, so it survives both a colour-blind reader and a projector's
 *    colour cast (WCAG 1.4.1).
 *  - A copy button is in the DOM and focusable, never revealed on hover. Hover
 *    reveal is a trap for touch and screen readers, and it is also unusable when
 *    somebody else is driving the laptop.
 *  - Wide content scrolls inside its own container. The page never scrolls
 *    sideways, at any zoom level (WCAG 1.4.10).
 *
 * A note on the prop types: presentational optional props are declared
 * `T | undefined` rather than `?: T`. Under `exactOptionalPropertyTypes` the
 * short form refuses an explicitly-undefined value, so every caller ends up
 * writing a conditional spread to pass a field that might be absent. For a prop
 * where "absent" and "undefined" mean the same thing on screen, that is friction
 * with no safety in return.
 */
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleSlash,
  Clock,
  Copy,
  Eye,
  EyeOff,
  Info,
  Loader2,
  OctagonAlert,
  XCircle,
} from 'lucide-react';
import { clsx } from 'clsx';
import type { Severity, StepStatus } from '../core/trace';

// ---------------------------------------------------------------------------
// Status vocabulary
// ---------------------------------------------------------------------------

export type Tone = 'pass' | 'warn' | 'fail' | 'info' | 'skip' | 'exception' | 'running';

export function toneForStatus(status: StepStatus): Tone {
  switch (status) {
    case 'ok':
      return 'pass';
    case 'warn':
      return 'warn';
    case 'fail':
      return 'fail';
    case 'blocked':
      return 'exception';
    case 'skipped':
      return 'skip';
    case 'running':
      return 'running';
    default:
      return 'skip';
  }
}

export function toneForSeverity(severity: Severity): Tone {
  switch (severity) {
    case 'fatal':
    case 'error':
      return 'fail';
    case 'warning':
      return 'warn';
    case 'good':
      return 'pass';
    default:
      return 'info';
  }
}

/** The word that goes with the icon. Never an icon on its own. */
export const TONE_WORD: Record<Tone, string> = {
  pass: 'Pass',
  warn: 'Warning',
  fail: 'Fail',
  info: 'Note',
  skip: 'Not run',
  exception: 'Stopped',
  running: 'Running',
};

/**
 * Silhouettes chosen to differ in outline, not only in the glyph inside them, so
 * they read on a washed-out projection: a circle-tick, a triangle, a circle-x, a
 * slashed circle, an octagon, a clock.
 */
export function StatusIcon({ tone, size = 16 }: { tone: Tone; size?: number }): ReactNode {
  const common = { size, 'aria-hidden': true, strokeWidth: 2.25 };
  const style = { color: `var(--tone-fg)` };
  const icon = (() => {
    switch (tone) {
      case 'pass':
        return <CheckCircle2 {...common} />;
      case 'warn':
        return <AlertTriangle {...common} />;
      case 'fail':
        return <XCircle {...common} />;
      case 'exception':
        return <OctagonAlert {...common} />;
      case 'skip':
        return <CircleSlash {...common} />;
      case 'running':
        return <Loader2 {...common} className="spin" />;
      default:
        return <Info {...common} />;
    }
  })();
  return (
    <span className={`tone tone-${tone} status-icon`} style={style}>
      {icon}
      <span className="visually-hidden">{TONE_WORD[tone]}</span>
    </span>
  );
}

export function Chip({
  tone = 'info',
  children,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  title?: string | undefined;
}): ReactNode {
  return (
    <span className={`chip tone tone-${tone}`} {...(title === undefined ? {} : { title })}>
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

export function CopyButton({
  value,
  label = 'Copy',
  className,
}: {
  value: string | (() => string);
  label?: string;
  className?: string | undefined;
}): ReactNode {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = useCallback(() => {
    const text = typeof value === 'function' ? value() : value;
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1600);
    });
  }, [value]);

  return (
    <button type="button" className={clsx('btn btn-ghost btn-sm', className)} onClick={copy}>
      {copied ? <Check size={13} aria-hidden /> : <Copy size={13} aria-hidden />}
      <span>{copied ? 'Copied' : label}</span>
    </button>
  );
}

export function Button({
  variant = 'default',
  size = 'md',
  children,
  className,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
}): ReactNode {
  return (
    <button
      type="button"
      className={clsx('btn', `btn-${variant}`, size === 'sm' && 'btn-sm', className)}
      {...rest}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------

export function Panel({
  title,
  actions,
  children,
  className,
  bare,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string | undefined;
  bare?: boolean | undefined;
}): ReactNode {
  return (
    <section className={clsx('panel', bare && 'panel-bare', className)}>
      {(title !== undefined || actions !== undefined) && (
        <header className="panel-head">
          <h2 className="panel-title">{title}</h2>
          {actions !== undefined && <div className="panel-actions">{actions}</div>}
        </header>
      )}
      <div className="panel-body">{children}</div>
    </section>
  );
}

/**
 * The disclosure pattern: one button, one region. Deliberately not a custom
 * accordion, because a button plus aria-expanded plus aria-controls is the thing
 * screen readers already understand.
 */
export function Disclosure({
  summary,
  children,
  defaultOpen = false,
  open: controlled,
  onToggle,
  meta,
}: {
  summary: ReactNode;
  children: ReactNode;
  defaultOpen?: boolean;
  open?: boolean | undefined;
  onToggle?: ((open: boolean) => void) | undefined;
  meta?: ReactNode;
}): ReactNode {
  const [internal, setInternal] = useState(defaultOpen);
  const open = controlled ?? internal;
  const id = useId();
  return (
    <div className={clsx('disclosure', open && 'is-open')}>
      <div className="disclosure-head">
        <button
          type="button"
          className="disclosure-toggle"
          aria-expanded={open}
          aria-controls={id}
          onClick={() => {
            const next = !open;
            setInternal(next);
            onToggle?.(next);
          }}
        >
          <ChevronRight size={14} aria-hidden className="disclosure-chevron" />
          <span className="disclosure-summary">{summary}</span>
        </button>
        {meta !== undefined && <div className="disclosure-meta">{meta}</div>}
      </div>
      <div id={id} role="region" hidden={!open} className="disclosure-body">
        {open && children}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Data display
// ---------------------------------------------------------------------------

export interface FieldRow {
  key: string;
  value: ReactNode;
  mono?: boolean | undefined;
  tone?: Tone | undefined;
  note?: ReactNode;
}

/**
 * The workhorse table. Cardinality and status get their own column rather than
 * being crammed into the label, which is the one presentation lesson worth
 * taking from the FHIR IG publisher's element tables.
 */
export function FieldTable({
  rows,
  dense,
}: {
  rows: readonly FieldRow[];
  dense?: boolean | undefined;
}): ReactNode {
  return (
    <div className="field-table scroll-x">
      <table className={clsx('fields', dense && 'is-dense')}>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.key}-${index}`}>
              <th scope="row">{row.key}</th>
              <td>
                <div className={clsx('field-value', row.mono !== false && 'opaque-value')}>
                  {row.value}
                </div>
                {row.note !== undefined && <p className="field-note">{row.note}</p>}
              </td>
              <td className="field-status">
                {row.tone !== undefined && row.tone !== 'info' && <StatusIcon tone={row.tone} />}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * A value that must be shown but should not be readable over someone's
 * shoulder. Masked by default with an explicit reveal, and in projector mode the
 * caller is expected to require a second confirmation, because the audience is
 * looking at a decryption key.
 */
export function Secret({
  value,
  label,
  revealed,
  onReveal,
}: {
  value: string;
  label?: string | undefined;
  revealed: boolean;
  onReveal: (revealed: boolean) => void;
}): ReactNode {
  const masked = `${value.slice(0, 4)}${'•'.repeat(Math.max(0, Math.min(24, value.length - 8)))}${value.slice(-4)}`;
  return (
    <span className="secret">
      <span className="opaque-value">{revealed ? value : masked}</span>
      <button
        type="button"
        className="btn btn-ghost btn-sm"
        aria-pressed={revealed}
        onClick={() => onReveal(!revealed)}
      >
        {revealed ? <EyeOff size={13} aria-hidden /> : <Eye size={13} aria-hidden />}
        <span className="visually-hidden">
          {revealed ? `Hide ${label ?? 'value'}` : `Reveal ${label ?? 'value'}`}
        </span>
      </button>
      <CopyButton value={value} label="Copy" />
    </span>
  );
}

export function CodeBlock({
  children,
  language,
  copy,
  maxHeight = 280,
}: {
  children: string;
  language?: string | undefined;
  copy?: boolean | undefined;
  maxHeight?: number | undefined;
}): ReactNode {
  return (
    <div className="code-block">
      {copy !== false && (
        <div className="code-actions">
          <CopyButton value={children} />
        </div>
      )}
      <pre className="scroll-x" style={{ maxHeight }} data-language={language}>
        <code>{children}</code>
      </pre>
    </div>
  );
}

export function Duration({ ms }: { ms: number | undefined }): ReactNode {
  if (ms === undefined) return null;
  return (
    <span className="duration mono" title={`${ms} milliseconds`}>
      {ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`}
    </span>
  );
}

export function EmptyState({
  icon,
  title,
  children,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
}): ReactNode {
  return (
    <div className="empty-state">
      {icon ?? <Clock size={20} aria-hidden />}
      <h3>{title}</h3>
      {children}
    </div>
  );
}

export function Callout({
  tone = 'info',
  title,
  children,
}: {
  tone?: Tone | undefined;
  title?: ReactNode;
  children: ReactNode;
}): ReactNode {
  return (
    <div className={`callout tone tone-${tone}`}>
      <StatusIcon tone={tone} />
      <div>
        {title !== undefined && <strong>{title}</strong>}
        <div>{children}</div>
      </div>
    </div>
  );
}
