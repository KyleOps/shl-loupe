/**
 * The overlay a dialog is built from: a backdrop, a focus trap, and Escape.
 *
 * It lives in its own module rather than beside its first caller, which is how it
 * ended up inside the settings sheet and then had to be untangled when settings
 * became a screen. The command palette is the only caller now, and the trap logic
 * is written once on purpose: a second copy is a second chance to let focus
 * escape on the element the two copies disagree about.
 *
 * Its stylesheet is `src/styles/overlay.css`. That file did not exist for a while
 * and nothing complained, so both callers laid out as ordinary block content in
 * the page flow. If a dialog ever appears inline again, look there first.
 */
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { clsx } from 'clsx';

/**
 * Everything that can hold focus. Kept as one selector so the trap and the
 * initial focus agree about what counts; a trap that walks a different set from
 * the one the browser walks lets focus escape on the element they disagree on.
 */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Overlay({
  labelledBy,
  onClose,
  className,
  children,
}: {
  labelledBy: string;
  onClose: () => void;
  className?: string;
  children: ReactNode;
}): ReactNode {
  const surface = useRef<HTMLDivElement | null>(null);

  // Focus returns to whatever opened this. Captured from the DOM at mount
  // rather than passed in as a prop, because a caller opened by a keyboard
  // shortcut has no trigger element to hand over, and the document already
  // knows which one had focus.
  useEffect(() => {
    const opener = document.activeElement;
    return () => {
      if (opener instanceof HTMLElement) opener.focus();
    };
  }, []);

  useEffect(() => {
    const node = surface.current;
    if (!node) return;
    const first = node.querySelector<HTMLElement>(FOCUSABLE);
    (first ?? node).focus();
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const node = surface.current;
    if (!node) return;
    const items = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)];
    const first = items[0];
    const last = items[items.length - 1];
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="overlay" onKeyDown={onKeyDown}>
      {/* Decorative: closing by click is a convenience, and Escape is the
          keyboard path, so this must not become a tab stop of its own. */}
      <div className="overlay-backdrop" aria-hidden="true" onClick={onClose} />
      <div
        ref={surface}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={clsx('sheet', className)}
      >
        {children}
      </div>
    </div>
  );
}
