/**
 * Settings, and the overlay both overlays are built from.
 *
 * Every setting here changes what leaves the tab, so none of them is presented
 * as a preference. Each one says what it sends, to whom, and what a person on
 * the other end sees, because the whole trust proposition of this tool is that
 * it makes no request the user did not ask for. A toggle labelled "DNS probe"
 * with no further words would break that promise while appearing to keep it.
 *
 * The overlay lives in this file rather than in the primitives, which are
 * frozen, and rather than being written twice: the command palette needs the
 * same focus trap, and a second copy of trap logic is a second chance to get it
 * wrong.
 */
import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { KeyRound, Radar, Settings2, X } from 'lucide-react';
import { formatBytes } from '../core/bytes';
import { DOH_RESOLVERS } from '../core/net/probe';
import { Button, Callout } from '../ui/primitives';
import { DEFAULT_RECIPIENT, useSettings } from './store';

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

const EMBEDDED_PRESETS = [64 * 1024, 1024 * 1024, 4 * 1024 * 1024, 16 * 1024 * 1024];

export function SettingsSheet({ onClose }: { onClose: () => void }): ReactNode {
  const titleId = useId();
  const settings = useSettings();

  return (
    <Overlay labelledBy={titleId} onClose={onClose} className="sheet-settings">
      <header className="sheet-head">
        <h2 id={titleId} className="sheet-title">
          <Settings2 size={16} aria-hidden />
          Settings
        </h2>
        <Button variant="ghost" onClick={onClose} aria-label="Close settings">
          <X size={15} aria-hidden />
        </Button>
      </header>

      <div className="sheet-body">
        <section className="setting">
          <label className="setting-label" htmlFor="setting-recipient">
            Recipient
          </label>
          <input
            id="setting-recipient"
            className="text-field"
            type="text"
            value={settings.recipient}
            onChange={(event) => settings.setRecipient(event.target.value)}
          />
          <p className="setting-note">
            Sent with every manifest request. It is not authenticated and it is not parsed by
            anything: it exists so the operator of the sharing server can read their log and see who
            called. Because the incumbent viewer sends one hardcoded string, an operator at an event
            cannot tell one participant from another. Put your name or your organisation here and
            they can.
          </p>
          {settings.recipient.trim() === DEFAULT_RECIPIENT ? (
            <p className="setting-note">
              Still the default, so a server operator will see only that some copy of Loupe called.
            </p>
          ) : null}
        </section>

        <section className="setting">
          <label className="setting-label" htmlFor="setting-embedded">
            Embedded length maximum
          </label>
          <div className="setting-row">
            <input
              id="setting-embedded"
              className="text-field text-field-number"
              type="number"
              min={0}
              step={1024}
              value={settings.embeddedLengthMax}
              onChange={(event) => {
                const next = Number.parseInt(event.target.value, 10);
                if (Number.isFinite(next) && next >= 0) settings.setEmbeddedLengthMax(next);
              }}
            />
            <span className="setting-hint mono">{formatBytes(settings.embeddedLengthMax)}</span>
          </div>
          <div className="setting-presets">
            {EMBEDDED_PRESETS.map((preset) => (
              <Button
                key={preset}
                size="sm"
                variant={settings.embeddedLengthMax === preset ? 'primary' : 'default'}
                onClick={() => settings.setEmbeddedLengthMax(preset)}
              >
                {formatBytes(preset)}
              </Button>
            ))}
          </div>
          <p className="setting-note">
            Sent as an upper bound on how long an embedded file may be. A large value is a CORS
            survival strategy, not only a size knob: an embedded file arrives inside the manifest
            response that has already succeeded, so it needs no second cross-origin request. A file
            handed over as a <code>location</code> instead puts a second host&rsquo;s CORS
            configuration in the way, and at an event that second host is usually the misconfigured
            one. Set it small to force the location path deliberately.
          </p>
        </section>

        <section className="setting">
          <h3 className="setting-label">Probes</h3>
          <p className="setting-note">
            Both are off until you turn them on. A browser will not say why a cross-origin request
            failed, and these two are the only way to narrow it, so they are offered rather than
            assumed.
          </p>

          <label className="setting-toggle">
            <input
              type="checkbox"
              checked={settings.reachabilityProbe}
              onChange={(event) => settings.setProbe('reachability', event.target.checked)}
            />
            <span>
              <span className="setting-toggle-title">
                <Radar size={14} aria-hidden />
                Reachability probe
              </span>
              <span className="setting-note">
                One extra <code>no-cors</code> GET to the host already named in the link. It carries
                no passcode and no key, and it reaches nowhere else. If it answers where the real
                request failed, the server is up and simply not sending the headers a browser needs,
                which is a positive CORS diagnosis rather than a guess.
              </span>
            </span>
          </label>

          <label className="setting-toggle">
            <input
              type="checkbox"
              checked={settings.dnsProbe}
              onChange={(event) => settings.setProbe('dns', event.target.checked)}
            />
            <span>
              <span className="setting-toggle-title">
                <Radar size={14} aria-hidden />
                DNS lookup
              </span>
              <span className="setting-note">
                This one sends the link&rsquo;s host name to a third party:{' '}
                {DOH_RESOLVERS.cloudflare.label} at <code>cloudflare-dns.com</code>, over
                DNS-over-HTTPS. Nothing else about the link leaves, and the request appears in the
                trace like any other, but the host name does reach a company that is not the sender
                and not you. It separates &ldquo;that name does not exist&rdquo; from &ldquo;that
                name exists and the request was still refused&rdquo;.
              </span>
            </span>
          </label>
        </section>

        <section className="setting">
          <h3 className="setting-label">Display</h3>

          <label className="setting-toggle">
            <input
              type="checkbox"
              checked={settings.revealSecrets}
              onChange={(event) => settings.setRevealSecrets(event.target.checked)}
            />
            <span>
              <span className="setting-toggle-title">
                <KeyRound size={14} aria-hidden />
                Reveal secrets by default
              </span>
              <span className="setting-note">
                Shows the link&rsquo;s decryption key and any passcode unmasked wherever they
                appear. It is your own key on your own screen, so this is your call, but it stays
                masked by default because this screen gets projected. This preference is never
                saved.
              </span>
            </span>
          </label>

          <label className="setting-toggle">
            <input
              type="checkbox"
              checked={settings.theme === 'light'}
              onChange={(event) => settings.setTheme(event.target.checked ? 'light' : 'dark')}
            />
            <span>
              <span className="setting-toggle-title">Light theme</span>
              <span className="setting-note">
                Dark is the default. Both are tuned for the same contrast ratios.
              </span>
            </span>
          </label>

          <label className="setting-toggle">
            <input
              type="checkbox"
              checked={settings.projector}
              onChange={() => settings.toggleProjector()}
            />
            <span>
              <span className="setting-toggle-title">Projector mode</span>
              <span className="setting-note">
                Larger text, thicker separators, lighter mid-greys and a capped line length, because
                a conference projector crushes blacks and loses one-pixel lines. It also requires a
                second confirmation before a masked key is revealed, since the audience is looking
                at the same screen.
              </span>
            </span>
          </label>
        </section>

        <Callout tone="info" title="What is stored">
          Only the settings on this page, in this browser. No link, key, passcode or payload is ever
          written to storage, and none of them leaves the tab except in the requests the trace
          lists.
        </Callout>
      </div>
    </Overlay>
  );
}
