/**
 * The shell: theme, routing, and the one place a pipeline run is started.
 *
 * "One place" matters. A wrong passcode is charged against a lifetime limit that
 * permanently disables the patient's link, so a run must never be a side effect
 * of rendering. It is started by an explicit submit, or exactly once for a link
 * that arrived in the fragment, guarded so React's development double-invoke
 * cannot spend two of somebody's attempts on one guess.
 */
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { openShl } from '../core/pipeline';
import { viewerOriginFromLocation } from '../core/diagnose/context';
import { parseHash, SCREENS, navigate, hashForLink, type Route } from './router';
import { useSession, useSettings } from './store';
import { Header } from './Header';
import { OpenScreen } from './screens/OpenScreen';
import { CommandPalette } from './CommandPalette';
import { InsecureContextNotice, readSecureContext } from './InsecureContextNotice';

/*
 * Every screen but Open is loaded on demand.
 *
 * Open is what a link opens to, so it ships in the first chunk. The other six
 * are a teaching guide, a minting sandbox, a conformance runner and a spec
 * index, and between them they were most of a one-megabyte bundle that somebody
 * at an event downloads over venue wifi before they can look at their link. The
 * ones they never visit should not be in the way of the one they came for.
 *
 * The fallback is `null` rather than a spinner, for two reasons. A local chunk
 * arrives in a frame or two, so a spinner would be a flash of furniture rather
 * than information. And it keeps the browser tests honest: they wait for `main`
 * to stop being empty, which with a spinner would be satisfied by the spinner,
 * and every measurement after it would be of the wrong thing.
 */
const OfflineScreen = lazy(async () => ({
  default: (await import('./screens/OfflineScreen')).OfflineScreen,
}));
const SandboxScreen = lazy(async () => ({
  default: (await import('./screens/SandboxScreen')).SandboxScreen,
}));
const LearnScreen = lazy(async () => ({
  default: (await import('./screens/LearnScreen')).LearnScreen,
}));
const RulesScreen = lazy(async () => ({
  default: (await import('./screens/RulesScreen')).RulesScreen,
}));
const AboutScreen = lazy(async () => ({
  default: (await import('./screens/AboutScreen')).AboutScreen,
}));
const SettingsScreen = lazy(async () => ({
  default: (await import('./screens/SettingsScreen')).SettingsScreen,
}));

export function App(): React.ReactNode {
  const [route, setRoute] = useState<Route>(() => parseHash(window.location.hash));
  const theme = useSettings((s) => s.theme);
  const largeText = useSettings((s) => s.largeText);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Read once: an origin does not change without a navigation, and a navigation
  // remounts the app.
  const [secureContext] = useState(readSecureContext);

  useEffect(() => {
    const onHashChange = (): void => setRoute(parseHash(window.location.hash));
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    if (largeText) document.documentElement.dataset.textSize = 'large';
    else delete document.documentElement.dataset.textSize;
  }, [theme, largeText]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const run = useRunner();

  // A link that arrived in the fragment is opened once, ever. The ref survives
  // React's development remount, which a plain effect dependency would not.
  const opened = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (route.link === undefined || opened.current === route.link) return;
    opened.current = route.link;
    void run(route.link);
  }, [route.link, run]);

  return (
    <div className="shell">
      <Header
        screen={route.screen}
        onSubmitLink={(value: string) => {
          // The link lives in the fragment, never the query string: a fragment
          // is not sent to a server, and this payload carries a decryption key.
          navigate(hashForLink(value.trim()));
          opened.current = value.trim();
          void run(value);
        }}
        onOpenPalette={() => setPaletteOpen(true)}
      />
      <main id="main" className="main">
        <InsecureContextNotice state={secureContext} />
        {route.screen === 'open' && <OpenScreen onRun={run} />}
        <Suspense fallback={null}>
          {route.screen === 'offline' && <OfflineScreen />}
          {route.screen === 'sandbox' && <SandboxScreen />}
          {route.screen === 'learn' && <LearnScreen />}
          {route.screen === 'rules' && <RulesScreen scrollTo={route.section} />}
          {route.screen === 'about' && <AboutScreen />}
          {route.screen === 'settings' && <SettingsScreen />}
        </Suspense>
      </main>
      <footer className="footer">
        <span>
          Everything runs in this tab. No link, key or payload is uploaded anywhere, and the trace
          above lists every request that was made.
        </span>
        <nav aria-label="Screens">
          {SCREENS.map((screen) => (
            <a key={screen.name} href={`#${screen.path}`}>
              {screen.label}
            </a>
          ))}
        </nav>
      </footer>
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} onRun={run} />}
    </div>
  );
}

export type Runner = (input: string, options?: { passcode?: string }) => Promise<void>;

/**
 * Starts a run and streams it into the session store.
 *
 * The settings are read at call time rather than captured, so a recipient or
 * probe toggle changed between runs takes effect on the next one without this
 * hook re-creating itself and re-triggering the fragment effect above.
 */
export function useRunner(): Runner {
  const begin = useSession((s) => s.begin);
  const progress = useSession((s) => s.progress);
  const complete = useSession((s) => s.complete);
  const countPasscodeAttempt = useSession((s) => s.countPasscodeAttempt);

  return useCallback(
    async (input, options) => {
      const settings = useSettings.getState();
      begin(input);
      if (options?.passcode !== undefined) countPasscodeAttempt();
      const result = await openShl({
        input,
        viewer: viewerOriginFromLocation(window.location),
        recipient: settings.recipient,
        embeddedLengthMax: settings.embeddedLengthMax,
        probes: { dns: settings.dnsProbe, reachability: settings.reachabilityProbe },
        ...(options?.passcode === undefined ? {} : { passcode: options.passcode }),
        onProgress: progress,
      });
      complete(result);
    },
    [begin, progress, complete, countPasscodeAttempt],
  );
}
