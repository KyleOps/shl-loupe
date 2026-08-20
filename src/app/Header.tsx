/**
 * The masthead.
 *
 * One rule shapes it: the input is the product, so nothing else in here is
 * allowed to compete with it. The wordmark is small, the screen links are
 * quiet, and every control on the right is an icon button with an accessible
 * name rather than a labelled button jostling for the same attention. The
 * arrangement is from the wireframe in the design notes: mark, then the field
 * centre-weighted, then a tool cluster.
 */
import { useState, type ReactNode } from 'react';
import { Command, Moon, Projector, Settings, Sun } from 'lucide-react';
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
  const projector = useSettings((state) => state.projector);
  const toggleProjector = useSettings((state) => state.toggleProjector);
  const [settingsOpen, setSettingsOpen] = useState(false);

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

        <button
          type="button"
          className={clsxProjector(projector)}
          aria-pressed={projector}
          onClick={toggleProjector}
        >
          <Projector size={15} aria-hidden />
          <span className="tool-word">Projector</span>
          <span className="visually-hidden">
            {projector ? 'Turn projector mode off' : 'Turn projector mode on'}
          </span>
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

      <nav className="masthead-nav" aria-label="Screens">
        {SCREENS.map((entry) => (
          <a
            key={entry.name}
            href={`#${entry.path}`}
            title={entry.blurb}
            {...(entry.name === screen ? { 'aria-current': 'page' as const } : {})}
          >
            {entry.label}
          </a>
        ))}
      </nav>

      {settingsOpen ? <SettingsSheet onClose={() => setSettingsOpen(false)} /> : null}
    </header>
  );
}

/** Projector mode is a state worth seeing at a glance, so the button holds it. */
function clsxProjector(on: boolean): string {
  return on ? 'btn btn-sm projector-toggle is-on' : 'btn btn-ghost btn-sm projector-toggle';
}
