/**
 * The one failure that makes the whole tool useless, stated before it happens.
 *
 * Loupe decrypts with Web Crypto, and `crypto.subtle` does not merely misbehave
 * outside a secure context: it is **undefined**. Measured in Chromium against
 * this app's own build:
 *
 *   http://localhost:4173      secureContext=true   crypto.subtle=true
 *   http://127.0.0.1:4173      secureContext=true   crypto.subtle=true
 *   http://192.168.50.70:4173  secureContext=false  crypto.subtle=false
 *
 * That is the exact shape of the likely accident. The deployment is reached by
 * `kubectl port-forward`, which is `http://localhost:PORT` and perfectly fine.
 * Then somebody at the same table wants a look, the port-forward is rebound to
 * `0.0.0.0`, the LAN address is read out, and on that colleague's laptop nothing
 * can be decrypted at all. Without this notice they would meet a stack of
 * baffling failures in the one part of the app that is beyond reproach.
 *
 * So it is a blocking banner rather than a footnote, and it names the fix.
 */
import { ShieldAlert } from 'lucide-react';
import { CodeBlock } from '../ui/primitives';

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
        Loupe is served from <code>{state.origin}</code>, which the browser does not treat as a
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
        If somebody shared this address with you, do not browse to it. Run the port-forward on your
        own machine instead, which puts the same page on <code>localhost</code> and works fully:
      </p>

      <CodeBlock language="bash" maxHeight={120}>
        {
          'kubectl -n shl-loupe port-forward svc/shl-loupe 8080:80\n# then open http://localhost:8080'
        }
      </CodeBlock>

      <p className="insecure-notice-tail">
        Everything that needs no decryption still works from here: the payload checks, the URL
        analysis, the expiry and flag findings, and every screen under Learn and Checks. Only
        opening a file needs Web Crypto.
      </p>
    </section>
  );
}
