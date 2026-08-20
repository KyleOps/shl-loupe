/**
 * The command palette.
 *
 * It exists for one situation above all others. The teaching use of this tool is
 * somebody standing at a stranger's laptop with about ninety seconds of their
 * attention, walking them through a link that WORKS before showing them the one
 * that does not. If getting to a known-good link takes any navigating, it does
 * not happen, so the samples are the first group here and each one carries the
 * sentence saying what it is for.
 *
 * Two structural notes.
 *
 * THE OVERLAY IS NOT REIMPLEMENTED. Focus trapping, focus return and Escape all
 * come from `Overlay` in SettingsSheet, which was written to be shared. A second
 * copy of trap logic is a second chance to get it wrong, and this is the one
 * place in the app where trapping focus is correct: a palette that lets Tab walk
 * out into the page behind it has lost the keyboard.
 *
 * NAVIGATION IS THE RUNNER FOR A LINK. A link lives in the fragment, and the
 * shell opens a fragment link exactly once per value. So a sample link is opened
 * by navigating, not by calling the runner: doing both would issue the same
 * request twice, which matters because one of the samples is somebody else's
 * server. The runner is used only to re-run the link already in the fragment,
 * where navigation would be a no-op.
 */
import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from 'react';
import { clsx } from 'clsx';
import {
  Braces,
  Eraser,
  Keyboard,
  Moon,
  Projector,
  Search,
  Send,
  Sparkles,
  Sun,
  Waypoints,
} from 'lucide-react';
import { SAMPLES } from '../fixtures';
import { buildDiagnosisReport, buildSenderExplanation } from '../core/report';
import { redactRun } from '../core/trace';
import { Button } from '../ui/primitives';
import type { Runner } from './App';
import { hashForLink, hashForScreen, navigate, parseHash, SCREENS } from './router';
import { Overlay } from './SettingsSheet';
import { useOfflineDraft } from './screens/OfflineScreen';
import { useSession, useSettings } from './store';

// ---------------------------------------------------------------------------
// The action model
// ---------------------------------------------------------------------------

export type PaletteGroup = 'Samples' | 'Copy' | 'View' | 'Go' | 'Session';

export interface PaletteAction {
  /** Stable and DOM-id safe: it becomes the option's element id. */
  id: string;
  group: PaletteGroup;
  label: string;
  /** One line: why you would reach for this. Searched along with the label. */
  hint?: string | undefined;
  /** Extra words to match on that are not worth showing. */
  keywords?: string | undefined;
  icon?: ReactNode;
  /** Present when the action cannot run right now, and says why in plain words. */
  unavailable?: string | undefined;
  /** True for an action whose result appears in the palette itself. */
  keepOpen?: boolean | undefined;
  perform: () => void;
}

/**
 * All terms must appear somewhere in the action's own words.
 *
 * Deliberately substring matching rather than fuzzy: a palette of about twenty
 * actions does not need scoring, and a fuzzy matcher that puts "Clear the
 * session" second when you typed "clear" is worse than no ranking at all.
 */
export function filterActions(actions: readonly PaletteAction[], query: string): PaletteAction[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);
  if (terms.length === 0) return [...actions];
  return actions.filter((action) => {
    const haystack =
      `${action.group} ${action.label} ${action.hint ?? ''} ${action.keywords ?? ''}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

/** Group order is fixed, so the samples are always first and always in one block. */
const GROUP_ORDER: PaletteGroup[] = ['Samples', 'Copy', 'View', 'Go', 'Session'];

export function groupActions(
  actions: readonly PaletteAction[],
): Array<{ group: PaletteGroup; actions: PaletteAction[] }> {
  return GROUP_ORDER.map((group) => ({
    group,
    actions: actions.filter((action) => action.group === group),
  })).filter((entry) => entry.actions.length > 0);
}

const optionDomId = (id: string): string => `palette-option-${id}`;

// ---------------------------------------------------------------------------
// The keyboard map
// ---------------------------------------------------------------------------

/**
 * Every key the app actually binds, and nothing else.
 *
 * A shortcut list is a promise. An earlier draft of this carried `?` for the
 * shortcuts overlay and `Shift+/` for search, because the design notes proposed
 * them; neither is bound anywhere in the code, and a documented key that does
 * nothing costs more trust than an undocumented one that works.
 */
export const KEY_MAP: Array<{ keys: string[]; what: string; where: string }> = [
  { keys: ['⌘K', 'Ctrl+K'], what: 'Open or close this palette', where: 'Anywhere' },
  {
    keys: ['Escape'],
    what: 'Close the palette or a sheet, and put focus back',
    where: 'Any overlay',
  },
  {
    keys: ['↑', '↓'],
    what: 'Move through this list. Enter runs the highlighted command',
    where: 'This palette',
  },
  {
    keys: ['j', 'k'],
    what: 'Move between steps without opening them',
    where: 'A focused trace step',
  },
  { keys: ['Enter', 'Space'], what: 'Open or close that step', where: 'A focused trace step' },
  { keys: ['→', '←'], what: 'Open that step, close that step', where: 'A focused trace step' },
  { keys: ['Shift+Enter'], what: 'Open every step', where: 'A focused trace step' },
  { keys: ['Shift+Backspace'], what: 'Close every step', where: 'A focused trace step' },
  {
    keys: ['c'],
    what: 'Copy that step, with its evidence and its findings',
    where: 'A focused trace step',
  },
];

// ---------------------------------------------------------------------------
// The palette
// ---------------------------------------------------------------------------

export function CommandPalette({
  onClose,
  onRun,
}: {
  onClose: () => void;
  onRun: Runner;
}): ReactNode {
  const [query, setQuery] = useState('');
  const [activeId, setActiveId] = useState<string | undefined>(undefined);
  const [notice, setNotice] = useState('');
  const [showKeys, setShowKeys] = useState(false);

  const theme = useSettings((state) => state.theme);
  const setTheme = useSettings((state) => state.setTheme);
  const projector = useSettings((state) => state.projector);
  const toggleProjector = useSettings((state) => state.toggleProjector);

  const run = useSession((state) => state.run);
  const redactor = useSession((state) => state.redactor);
  const resetSession = useSession((state) => state.reset);

  const stageOffline = useOfflineDraft((state) => state.stage);
  const resetDraft = useOfflineDraft((state) => state.reset);

  const actions = useMemo<PaletteAction[]>(() => {
    const copied = (what: string, text: string): void => {
      void navigator.clipboard.writeText(text).then(
        () => setNotice(`${what} copied: ${text.length.toLocaleString('en-AU')} characters.`),
        () =>
          setNotice('The browser refused the clipboard. Use the copy button in the trace instead.'),
      );
    };
    const noRun = run === undefined ? 'Nothing has run yet.' : undefined;
    /**
     * A report leaves the tab, so it is built from a redacted copy of the run.
     * `buildDiagnosisReport` takes the registry and does that itself;
     * `buildSenderExplanation` takes only a run, so the copy is made here.
     */
    const safeRun =
      run === undefined ? undefined : redactor === undefined ? run : redactRun(run, redactor);

    return [
      ...SAMPLES.map<PaletteAction>((sample) => ({
        id: `sample-${sample.id}`,
        group: 'Samples',
        label: sample.title,
        hint: sample.teaches,
        keywords: `sample example ${sample.kind}`,
        icon: <Sparkles size={14} aria-hidden />,
        perform: () => {
          if (sample.link !== undefined) {
            const target = hashForLink(sample.link);
            const inFragment = parseHash(window.location.hash).link;
            // Already the open link: navigating would change nothing, so the
            // runner is the only way to run it again.
            if (inFragment !== undefined && target.includes(inFragment)) {
              void onRun(sample.link);
            } else {
              navigate(target);
            }
            return;
          }
          if (sample.content !== undefined) {
            // Already-decrypted content has no link to open, so it goes where
            // content without a link belongs, and opens itself on arrival.
            stageOffline(`${JSON.stringify(sample.content, null, 2)}\n`);
            navigate(hashForScreen('offline'));
            return;
          }
          navigate(hashForScreen('sandbox'));
        },
      })),

      {
        id: 'copy-report',
        group: 'Copy',
        label: 'Copy the whole trace as a report',
        hint: 'Every step, every finding with its rule id and who has to act, and the commands to reproduce it. Markdown, for a chat thread.',
        keywords: 'diagnosis markdown paste zulip share',
        icon: <Braces size={14} aria-hidden />,
        unavailable: noRun,
        keepOpen: true,
        perform: () => {
          if (run === undefined) return;
          copied('The report', buildDiagnosisReport(run, redactor));
        },
      },
      {
        id: 'copy-json',
        group: 'Copy',
        label: 'Copy the run as JSON',
        hint: 'The trace as data, for a bug report or a test fixture. Replayable with no network.',
        keywords: 'export data fixture',
        icon: <Braces size={14} aria-hidden />,
        unavailable: noRun,
        keepOpen: true,
        perform: () => {
          if (run === undefined) return;
          copied('The run', buildDiagnosisReport(run, redactor, { format: 'json' }));
        },
      },
      {
        id: 'copy-sender',
        group: 'Copy',
        label: 'Copy the message for whoever sent the link',
        hint: 'Second person, no rule ids, no trace. The message nobody wants to write.',
        keywords: 'explain sender email tell them',
        icon: <Send size={14} aria-hidden />,
        unavailable: noRun,
        keepOpen: true,
        perform: () => {
          if (safeRun === undefined) return;
          copied('The message', buildSenderExplanation(safeRun));
        },
      },

      {
        id: 'view-projector',
        group: 'View',
        label: projector ? 'Turn Projector Mode off' : 'Turn Projector Mode on',
        hint: 'Bigger type, stronger hairlines, no dim tier and no step opens itself, for a room reading over your shoulder.',
        keywords: 'presentation demo room audience',
        icon: <Projector size={14} aria-hidden />,
        perform: toggleProjector,
      },
      {
        id: 'view-theme',
        group: 'View',
        label: theme === 'light' ? 'Switch to the dark theme' : 'Switch to the light theme',
        hint: 'The identity survives either way. Only the surfaces and the text tiers swap.',
        keywords: 'dark light appearance',
        icon: theme === 'light' ? <Moon size={14} aria-hidden /> : <Sun size={14} aria-hidden />,
        perform: () => setTheme(theme === 'light' ? 'dark' : 'light'),
      },
      {
        id: 'view-keys',
        group: 'View',
        label: showKeys ? 'Hide the keyboard map' : 'Show the keyboard map',
        hint: 'Every key this app binds, and only the ones it binds.',
        keywords: 'shortcuts help keys',
        icon: <Keyboard size={14} aria-hidden />,
        keepOpen: true,
        perform: () => setShowKeys(!showKeys),
      },

      ...SCREENS.map<PaletteAction>((screen) => ({
        id: `go-${screen.name}`,
        group: 'Go',
        label: `Go to ${screen.label}`,
        hint: screen.blurb,
        keywords: `screen navigate ${screen.name}`,
        icon: <Waypoints size={14} aria-hidden />,
        perform: () => navigate(hashForScreen(screen.name)),
      })),

      {
        id: 'session-clear',
        group: 'Session',
        label: 'Clear the session',
        hint: 'Drops the run, the payload, the key registry and everything typed into Offline mode. Nothing was written to storage in the first place.',
        keywords: 'reset forget wipe start again',
        icon: <Eraser size={14} aria-hidden />,
        perform: () => {
          resetSession();
          resetDraft();
          // The address bar would otherwise still claim a link is open, which is
          // a lie the next person to look at the screen will believe.
          if (parseHash(window.location.hash).link !== undefined) navigate('#');
        },
      },
    ];
  }, [
    onRun,
    projector,
    redactor,
    resetDraft,
    resetSession,
    run,
    setTheme,
    showKeys,
    stageOffline,
    theme,
    toggleProjector,
  ]);

  const filtered = useMemo(() => filterActions(actions, query), [actions, query]);
  const groups = useMemo(() => groupActions(filtered), [filtered]);
  const runnable = useMemo(
    () => filtered.filter((action) => action.unavailable === undefined),
    [filtered],
  );

  // Derived rather than stored, so a query that filters the highlighted action
  // away cannot leave the list with nothing highlighted and Enter doing nothing.
  const active = runnable.find((action) => action.id === activeId) ?? runnable[0];

  // Keyed on the id rather than the action, which is rebuilt on every render:
  // the highlight has to stay visible when the arrows walk past the fold, and
  // `nearest` with the default instant behaviour needs no reduced-motion branch.
  const activeOptionId = active?.id;
  useEffect(() => {
    if (activeOptionId === undefined) return;
    document.getElementById(optionDomId(activeOptionId))?.scrollIntoView({ block: 'nearest' });
  }, [activeOptionId]);

  const perform = (action: PaletteAction): void => {
    if (action.unavailable !== undefined) return;
    action.perform();
    if (action.keepOpen !== true) onClose();
  };

  const move = (delta: number): void => {
    if (runnable.length === 0) return;
    const index = active === undefined ? -1 : runnable.findIndex((item) => item.id === active.id);
    const next = runnable[Math.min(runnable.length - 1, Math.max(0, index + delta))];
    if (next !== undefined) setActiveId(next.id);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        move(1);
        return;
      case 'ArrowUp':
        event.preventDefault();
        move(-1);
        return;
      case 'Home':
        event.preventDefault();
        setActiveId(runnable[0]?.id);
        return;
      case 'End':
        event.preventDefault();
        setActiveId(runnable[runnable.length - 1]?.id);
        return;
      case 'Enter':
        event.preventDefault();
        if (active !== undefined) perform(active);
        return;
      default:
        return;
    }
  };

  return (
    <Overlay labelledBy="palette-title" onClose={onClose} className="sheet-palette">
      <div className="palette">
        <h2 id="palette-title" className="visually-hidden">
          Commands
        </h2>

        <div className="palette-field">
          <Search size={15} aria-hidden className="palette-search-icon" />
          <label className="visually-hidden" htmlFor="palette-input">
            Filter commands
          </label>
          <input
            id="palette-input"
            className="palette-input"
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={active === undefined ? undefined : optionDomId(active.id)}
            autoComplete="off"
            spellCheck={false}
            placeholder="Load a sample, copy the trace, go somewhere…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>

        {showKeys ? (
          <section className="palette-keys" aria-label="Keyboard map">
            <table>
              <tbody>
                {KEY_MAP.map((entry) => (
                  <tr key={entry.what}>
                    <th scope="row">
                      {entry.keys.map((key, index) => (
                        <span key={key}>
                          {index > 0 ? <span className="palette-keys-or"> or </span> : null}
                          <kbd>{key}</kbd>
                        </span>
                      ))}
                    </th>
                    <td>{entry.what}</td>
                    <td className="palette-keys-where">{entry.where}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ) : null}

        <ul className="palette-list" id="palette-list" role="listbox" aria-label="Commands">
          {groups.map((entry) => (
            <li key={entry.group} className="palette-section" role="presentation">
              {/* Decorative: the option's own words carry the meaning, and a
                  listbox may not contain a heading. */}
              <span className="palette-group" aria-hidden="true">
                {entry.group}
              </span>
              {entry.actions.map((action) => {
                const selected = active !== undefined && action.id === active.id;
                return (
                  <div
                    key={action.id}
                    id={optionDomId(action.id)}
                    role="option"
                    aria-selected={selected}
                    aria-disabled={action.unavailable !== undefined}
                    className={clsx(
                      'palette-option',
                      selected && 'is-active',
                      action.unavailable !== undefined && 'is-unavailable',
                    )}
                    onMouseMove={() => {
                      if (action.unavailable === undefined) setActiveId(action.id);
                    }}
                    onClick={() => perform(action)}
                  >
                    <span className="palette-option-icon">{action.icon}</span>
                    <span className="palette-option-body">
                      <span className="palette-option-label">{action.label}</span>
                      {action.hint !== undefined ? (
                        <span className="palette-option-hint">{action.hint}</span>
                      ) : null}
                      {action.unavailable !== undefined ? (
                        <span className="palette-option-blocked">{action.unavailable}</span>
                      ) : null}
                    </span>
                  </div>
                );
              })}
            </li>
          ))}

          {filtered.length === 0 ? (
            <li className="palette-empty" role="presentation">
              Nothing matches &ldquo;{query}&rdquo;. Everything here is a sample, a copy, a view
              switch, a screen or a clear.
            </li>
          ) : null}
        </ul>

        <p className="palette-notice" role="status" aria-live="polite">
          {notice}
        </p>

        <div className="palette-footer">
          <p>
            <kbd>↑</kbd> <kbd>↓</kbd> move, <kbd>Enter</kbd> runs, <kbd>Escape</kbd> closes.
          </p>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </Overlay>
  );
}
