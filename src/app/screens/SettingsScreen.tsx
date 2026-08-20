/**
 * Settings, as a screen.
 *
 * It used to be a dialog, and the dialog was broken in a way nothing caught: the
 * overlay layer it rendered into had no stylesheet, so opening it injected a
 * section into the masthead above the tab strip rather than covering the page.
 *
 * The fix is not to write the overlay CSS and carry on. A dialog was the wrong
 * shape here anyway. Every value on this page changes what leaves the tab, so
 * these are decisions to read and think about rather than a quick adjustment
 * over the top of what you were doing, and as a screen it is addressable by URL,
 * survives a reload, needs no focus trap, and works at 320px without becoming a
 * full-height sheet. The command palette keeps the overlay, because a palette
 * genuinely must not navigate.
 *
 * Every setting says what it sends, to whom, and what a person on the other end
 * sees. The trust proposition of this tool is that it makes no request the user
 * did not ask for, and a toggle labelled "DNS probe" with no further words would
 * break that promise while appearing to keep it.
 */
import { type ReactNode } from 'react';
import { KeyRound, Radar, Settings2 } from 'lucide-react';
import { formatBytes } from '../../core/bytes';
import { DOH_RESOLVERS } from '../../core/net/probe';
import { Button, Callout } from '../../ui/primitives';
import { DEFAULT_RECIPIENT, useSettings } from '../store';
import { PageNav, type PageNavItem } from '../PageNav';

const EMBEDDED_PRESETS = [64 * 1024, 1024 * 1024, 4 * 1024 * 1024, 16 * 1024 * 1024];

const NAV_ITEMS: readonly PageNavItem[] = [
  { anchor: 'setting-recipient-section', label: 'Recipient' },
  { anchor: 'setting-embedded-section', label: 'Embedded length' },
  { anchor: 'setting-probes-section', label: 'Probes' },
  { anchor: 'setting-display-section', label: 'Display' },
];

export function SettingsScreen(): ReactNode {
  const settings = useSettings();

  return (
    <div className="settings">
      <div className="page-body">
        <PageNav items={NAV_ITEMS} label="Sections of this page" />

        <div className="page-column">
          <header className="settings-head">
            <h1 className="settings-title">
              <Settings2 size={20} aria-hidden />
              Settings
            </h1>
            <p className="settings-lede prose">
              Three of these change what SHLoupe sends to somebody else&rsquo;s server, so each one
              says what it sends and who reads it. They are kept in this browser and nowhere else.
            </p>
          </header>

          <div className="settings-body">
            <section className="setting" id="setting-recipient-section" tabIndex={-1}>
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
                anything: it exists so the operator of the sharing server can read their log and see
                who called. Because the incumbent viewer sends one hardcoded string, an operator at
                an event cannot tell one participant from another. Put your name or your
                organisation here and they can.
              </p>
              {settings.recipient.trim() === DEFAULT_RECIPIENT ? (
                <p className="setting-note">
                  Still the default, so a server operator will see only that some copy of SHLoupe
                  called.
                </p>
              ) : null}
            </section>

            <section className="setting" id="setting-embedded-section" tabIndex={-1}>
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
                survival strategy, not only a size knob: an embedded file arrives inside the
                manifest response that has already succeeded, so it needs no second cross-origin
                request. A file handed over as a <code>location</code> instead puts a second
                host&rsquo;s CORS configuration in the way, and at an event that second host is
                usually the misconfigured one. Set it small to force the location path deliberately.
              </p>
            </section>

            <section className="setting" id="setting-probes-section" tabIndex={-1}>
              <h3 className="setting-label">Probes</h3>
              <p className="setting-note">
                Both are off until you turn them on. A browser will not say why a cross-origin
                request failed, and these two are the only way to narrow it, so they are offered
                rather than assumed.
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
                    One extra <code>no-cors</code> GET to the host already named in the link. It
                    carries no passcode and no key, and it reaches nowhere else. If it answers where
                    the real request failed, the server is up and simply not sending the headers a
                    browser needs, which is a positive CORS diagnosis rather than a guess.
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
                    DNS-over-HTTPS. Nothing else about the link leaves, and the request appears in
                    the trace like any other, but the host name does reach a company that is not the
                    sender and not you. It separates &ldquo;that name does not exist&rdquo; from
                    &ldquo;that name exists and the request was still refused&rdquo;.
                  </span>
                </span>
              </label>
            </section>

            <section className="setting" id="setting-display-section" tabIndex={-1}>
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
                    appear. It is your own key on your own screen, so this is your call, but it
                    stays masked by default because this screen gets projected. This preference is
                    never saved.
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
                  checked={settings.largeText}
                  onChange={() => settings.toggleLargeText()}
                />
                <span>
                  <span className="setting-toggle-title">Larger text</span>
                  <span className="setting-note">
                    Scales the type up, with thicker separators to match, for reading at a distance
                    or over somebody&rsquo;s shoulder. There is a quick toggle in the header too.
                  </span>
                </span>
              </label>
            </section>

            <Callout tone="info" title="What is stored">
              Only the settings on this page, in this browser. No link, key, passcode or payload is
              ever written to storage, and none of them leaves the tab except in the requests the
              trace lists.
            </Callout>
          </div>
        </div>
      </div>
    </div>
  );
}
