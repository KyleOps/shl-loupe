/**
 * The masthead.
 *
 * One rule shapes it: the input is the product, so nothing else in here is
 * allowed to compete with it. The wordmark is small, every control on the right
 * is an icon button with an accessible name rather than a labelled button
 * jostling for the same attention, and the arrangement is from the wireframe in
 * the design notes: mark, then the field centre-weighted, then a tool cluster.
 *
 * The exception is the section navigation on the second row. It used to be a row
 * of 13px muted links, which the review read as a set of secondary utilities
 * rather than as the parts of the app. Six sections is few enough to be
 * generous, so they are tabs: real type, real padding, and the current one
 * showing the sentence saying what it is for. That reads as "these are the
 * places you can be" instead of "here are some more links".
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AArrowUp, ALargeSmall, Command, Moon, Settings, Sun } from 'lucide-react';
import { SCREENS, type ScreenName } from './router';
import { useSettings } from './store';
import { LinkInput } from './LinkInput';
import { SettingsSheet } from './SettingsSheet';

/**
 * Read at render rather than at module load: a test importing anything from this
 * module runs in Node, where `navigator` may not exist, and a header that
 * cannot be imported is a header that cannot be tested around.
 */
function modifierLabel(): string {
  if (typeof navigator === 'undefined') return 'Ctrl';
  return /Mac|iPhone|iPad|iPod/.test(navigator.userAgent) ? '⌘' : 'Ctrl';
}

export function Header({
  screen,
  onSubmitLink,
  onOpenPalette,
}: {
  screen: ScreenName;
  onSubmitLink: (value: string) => void;
  onOpenPalette: () => void;
}): ReactNode {
  const theme = useSettings((state) => state.theme);
  const setTheme = useSettings((state) => state.setTheme);
  const largeText = useSettings((state) => state.largeText);
  const toggleLargeText = useSettings((state) => state.toggleLargeText);
  const [settingsOpen, setSettingsOpen] = useState(false);

  /**
   * The strip scrolls at narrow widths and the browser does not scroll it for us,
   * so arriving on a section whose tab sits off to the right shows no active tab
   * at all: the clearest active state in the world is no help off screen.
   *
   * `scrollIntoView` is the obvious way to do this and it is the wrong one. Blink
   * sets the sequential focus navigation starting point to whatever was scrolled
   * into view, so the first Tab after load went to the tab AFTER the current one
   * instead of to the skip link. That is the app's first accessibility
   * affordance, silently lost to a cosmetic scroll. Moving `scrollLeft` by hand
   * scrolls the same distance and touches nothing to do with focus.
   */
  const currentTab = useRef<HTMLAnchorElement | null>(null);
  useEffect(() => {
    const show = (): void => {
      const tab = currentTab.current;
      const strip = tab?.parentElement;
      if (!tab || !strip) return;
      const t = tab.getBoundingClientRect();
      const s = strip.getBoundingClientRect();
      if (t.left < s.left) strip.scrollLeft -= s.left - t.left;
      else if (t.right > s.right) strip.scrollLeft += t.right - s.right;
    };
    show();
    /*
     * And again once the web font has swapped in. The tabs get wider when it
     * does, so a scroll worked out against the fallback metrics leaves the tab
     * hanging off the edge by exactly the difference: on first load at 390px this
     * stopped 76px short, which reads as the thing not working rather than as a
     * font-loading race. `fonts.ready` is already resolved on every navigation
     * after the first, so this is one extra measurement, not a second scroll
     * anybody sees.
     */
    let cancelled = false;
    void document.fonts.ready.then(() => {
      if (!cancelled) show();
    });
    return () => {
      cancelled = true;
    };
  }, [screen]);

  return (
    <header className="masthead">
      <a className="skip-link" href="#main">
        Skip to the trace
      </a>

      <a className="wordmark" href="#" aria-label="Loupe, home">
        <svg viewBox="0 0 32 32" width="22" height="22" aria-hidden focusable="false">
          <circle cx="13" cy="13" r="8.5" fill="none" stroke="currentColor" strokeWidth="2.5" />
          <path d="M19.5 19.5 L27 27" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
        </svg>
        <span className="wordmark-text">loupe</span>
      </a>

      <div className="masthead-input">
        <LinkInput onSubmit={onSubmitLink} />
      </div>

      <div className="masthead-tools">
        <button type="button" className="btn btn-ghost btn-sm palette-hint" onClick={onOpenPalette}>
          <Command size={13} aria-hidden />
          <span className="mono">{modifierLabel()}K</span>
          <span className="visually-hidden">Open the command palette</span>
        </button>

        <button
          type="button"
          className="btn btn-ghost btn-sm"
          aria-pressed={theme === 'light'}
          onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
        >
          {theme === 'light' ? <Sun size={15} aria-hidden /> : <Moon size={15} aria-hidden />}
          <span className="visually-hidden">
            {theme === 'light' ? 'Switch to the dark theme' : 'Switch to the light theme'}
          </span>
        </button>

        {/*
         * The quick text-size toggle stays in the header, because the moment you
         * want it is the moment somebody leans in to look, and hunting through a
         * sheet then is the wrong shape. It is icon-only like everything else in
         * this cluster: it used to carry a visible "Larger text" word, which made
         * the one preference in the app louder than the link field.
         *
         * The accessible name is fixed and `aria-pressed` carries the state,
         * which is the toggle-button pattern; a name that changes with the state
         * makes a screen reader announce the action and the state as if they were
         * one thing. The icon changes silhouette too, so "on" is not carried by
         * the tinted background alone.
         */}
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          aria-pressed={largeText}
          onClick={toggleLargeText}
          title="Scale the type up for reading at a distance"
        >
          {largeText ? <AArrowUp size={16} aria-hidden /> : <ALargeSmall size={16} aria-hidden />}
          <span className="visually-hidden">Larger text</span>
        </button>

        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setSettingsOpen(true)}
        >
          <Settings size={15} aria-hidden />
          <span className="visually-hidden">Open settings</span>
        </button>
      </div>

      {/*
       * One row that scrolls, never a wrapping set of links: a nav that reflows
       * to two rows at some widths and one at others stops reading as a fixed set
       * of places. The blurb is rendered for every tab and shown by CSS for the
       * current one only, where there is room for it. Six blurbs at once would be
       * several thousand pixels wide, and hiding five of them in the markup
       * instead would mean the strip changed height as you moved between
       * sections.
       */}
      <nav className="masthead-nav scroll-x" aria-label="Sections">
        {SCREENS.map((entry) => {
          const current = entry.name === screen;
          return (
            <a
              key={entry.name}
              className="nav-tab"
              href={`#${entry.path}`}
              // Every tab carries its description on hover, the current one
              // included: no blurb is shown in the strip any more, so there is
              // nothing for the tooltip to repeat.
              title={entry.blurb}
              {...(current ? { 'aria-current': 'page' as const, ref: currentTab } : {})}
            >
              <span className="nav-tab-label">{entry.label}</span>
              <span className="nav-tab-blurb">{entry.blurb}</span>
            </a>
          );
        })}
      </nav>

      {settingsOpen ? <SettingsSheet onClose={() => setSettingsOpen(false)} /> : null}
    </header>
  );
}
