/**
 * A hand-written hash router, and the reason is not minimalism.
 *
 * A SMART Health Link travels as `#shlink:/eyJ...`, because a fragment is never
 * sent to a server and the payload contains the decryption key. Any router that
 * owns the hash (React Router's hash history included) will parse that fragment
 * as a route, fail to match it, and in the process the app has to fight its own
 * router for the one piece of state that matters most. So the fragment stays
 * ours: a link in the hash IS the app's primary state, and a screen name is the
 * exception rather than the rule.
 *
 * The rules:
 *   #shlink:/...          open this link (also the form other viewers publish)
 *   #/learn, #/sandbox…   a named screen
 *   #                     the home screen
 * A link and a screen never coexist in the hash, because opening a link is what
 * the home screen does.
 */

export type ScreenName = 'open' | 'offline' | 'sandbox' | 'learn' | 'rules' | 'about' | 'settings';

export const SCREENS: Array<{ name: ScreenName; path: string; label: string; blurb: string }> = [
  {
    name: 'open',
    path: '',
    label: 'Open',
    blurb: 'Paste, scan or drop a link and watch every step of it.',
  },
  {
    name: 'offline',
    path: '/offline',
    label: 'Offline',
    blurb: 'Run the same pipeline over a manifest, a JWE or a bundle you already have.',
  },
  {
    name: 'sandbox',
    path: '/sandbox',
    label: 'Sandbox',
    blurb: 'Mint links, including deliberately broken ones, to test another viewer.',
  },
  {
    name: 'learn',
    path: '/learn',
    label: 'Learn',
    blurb: 'What each field means, quoted from the specification.',
  },
  {
    name: 'rules',
    path: '/rules',
    label: 'Checks',
    blurb: 'Every check Loupe runs, and what each one is looking for.',
  },
  { name: 'about', path: '/about', label: 'About', blurb: 'What this is, and what it never does.' },
  {
    name: 'settings',
    path: '/settings',
    label: 'Settings',
    blurb: 'What gets sent with a request, and which optional checks are on.',
  },
];

export interface Route {
  screen: ScreenName;
  /** Present when the hash carries a link rather than a screen path. */
  link?: string;
}

const SHLINK = /(shlink:\/{1,2}[A-Za-z0-9_-]+)/;
const SHC = /(shc:\/[\d/]+)/;

export function parseHash(hash: string): Route {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;

  // A link in the fragment wins over everything: it is why someone opened the
  // page. Both the shlink and the numeric health-card forms are accepted, and a
  // bare payload is left to the input box, since a base64url blob in the hash is
  // ambiguous with a route.
  const link = SHLINK.exec(raw)?.[1] ?? SHC.exec(raw)?.[1];
  if (link !== undefined) return { screen: 'open', link };

  const path = raw.split('?')[0] ?? '';
  const match = SCREENS.find((screen) => screen.path === path || screen.path === `/${path}`);
  return { screen: match?.name ?? 'open' };
}

export function hashForScreen(screen: ScreenName): string {
  const found = SCREENS.find((s) => s.name === screen);
  return `#${found?.path ?? ''}`;
}

/** Put a link in the fragment, which is where it belongs and where it stays. */
export function hashForLink(link: string): string {
  return `#${link}`;
}

export function navigate(target: string): void {
  if (window.location.hash === target) return;
  window.location.hash = target;
}
