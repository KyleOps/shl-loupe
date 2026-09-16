/**
 * The one failure that makes the whole tool useless, stated before it happens.
 *
 * SHLoupe decrypts with Web Crypto, and `crypto.subtle` does not merely misbehave
 * outside a secure context: it is **undefined**. Measured in Chromium against
 * this app's own build:
 *
 *   http://localhost:4173      secureContext=true   crypto.subtle=true
 *   http://127.0.0.1:4173      secureContext=true   crypto.subtle=true
 *   http://192.168.50.70:4173  secureContext=false  crypto.subtle=false
 *
 * That is the exact shape of the likely accident. Somebody runs the container on
 * their laptop, where `http://localhost:8080` is perfectly fine. Then somebody at
 * the same table wants a look, the port is republished on `0.0.0.0`, the LAN
 * address is read out, and on that colleague's laptop nothing can be decrypted at
 * all. Without this notice they would meet a stack of baffling failures in the
 * one part of the app that is beyond reproach.
 *
 * So it is a blocking banner rather than a footnote, and it names the fix. The
 * fix it names is the hosted copy rather than a command, because an `https`
 * address works on every device in the room, including the phone the person is
 * more likely to be holding.
 */
import { ShieldAlert } from 'lucide-react';

/** The hosted copy, which is https and therefore a secure context anywhere. */
const HOSTED_URL = 'https://kyleops.github.io/shl-loupe/';

export interface SecureContextState {
  secure: boolean;
  hasSubtleCrypto: boolean;
  hasCamera: boolean;
  origin: string;
}

export function readSecureContext(): SecureContextState {
  /*
   * Probed through an untyped view on purpose.
   *
   * The DOM types declare `crypto.subtle` and `navigator.mediaDevices` as always
   * present, so a type-aware linter calls the guard below dead code. The types
   * are describing a secure context and saying nothing about any other, which is
   * precisely the case this function exists to detect: outside one, both are
   * genuinely `undefined`. Trusting the declaration here would delete the check
   * that stops the app failing incomprehensibly.
   */
  const view = globalThis as unknown as {
    isSecureContext?: unknown;
    crypto?: { subtle?: { decrypt?: unknown } };
    navigator?: { mediaDevices?: unknown };
    location?: { origin?: unknown };
  };
  return {
    secure: typeof view.isSecureContext === 'boolean' ? view.isSecureContext : true,
    hasSubtleCrypto: typeof view.crypto?.subtle?.decrypt === 'function',
    hasCamera: view.navigator?.mediaDevices !== undefined,
    origin: typeof view.location?.origin === 'string' ? view.location.origin : '',
  };
}

export function InsecureContextNotice({ state }: { state: SecureContextState }): React.ReactNode {
  // A secure context with working crypto is the normal case and says nothing.
  if (state.secure && state.hasSubtleCrypto) return null;

  const host = (() => {
    try {
      return new URL(state.origin).hostname;
    } catch {
      return state.origin;
    }
  })();

  return (
    <section className="insecure-notice tone tone-fail" role="alert">
      <div className="insecure-notice-head">
        <ShieldAlert size={22} aria-hidden />
        <h2>This page cannot decrypt anything from where it is being served.</h2>
      </div>

      <p>
        SHLoupe is served from <code>{state.origin}</code>, which the browser does not treat as a
        secure context, so <code>crypto.subtle</code> is not merely restricted here, it is absent.
        Every step up to decryption will work and then every file will fail, which looks like a
        problem with the link and is not.
      </p>

      <p>
        A browser grants a secure context to <code>https://</code> anywhere, and to{' '}
        <code>http://</code> only on <code>localhost</code> and <code>127.0.0.1</code>. A plain{' '}
        <code>http://</code> address on a local network, which is what <code>{host}</code> is, gets
        neither Web Crypto nor the camera for scanning a QR code.
      </p>

      <p>
        If somebody shared this address with you, do not browse to it. Open the hosted copy instead,
        which is served over <code>https</code> and so works fully on any machine:
      </p>

      <p className="insecure-notice-link">
        <a href={HOSTED_URL} target="_blank" rel="noreferrer noopener">
          {HOSTED_URL}
        </a>
      </p>

      <p>
        If this network cannot reach that address, run your own copy on{' '}
        <code>http://localhost</code>, which a browser also treats as a secure context. Building and
        running the container is in <code>deploy/README.md</code>.
      </p>

      <p className="insecure-notice-tail">
        Everything that needs no decryption still works from here: the payload checks, the URL
        analysis, the expiry and flag findings, and every screen under Learn and Checks. Only
        opening a file needs Web Crypto.
      </p>
    </section>
  );
}
