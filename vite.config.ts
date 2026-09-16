import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

/**
 * The Content-Security-Policy, repeated here as a <meta> element for built
 * output only.
 *
 * `deploy/nginx.conf` sends this same policy as a response header and carries
 * the reasoning for every directive; that file is its home, and a change to one
 * is a change to both. It is duplicated here because GitHub Pages serves a
 * static bundle and offers no way to set a response header at all, so on Pages
 * the meta element is the only copy of the policy that exists. Both copies are
 * enforced on the container deployment, which is harmless: they are the same
 * policy, and a user agent applies the intersection.
 *
 * Two deliberate differences from the header form:
 *
 *   - `frame-ancestors` is omitted, because a user agent ignores it in a meta
 *     element (as it does `report-uri` and `sandbox`). Nothing replaces it on
 *     Pages, which cannot send `X-Frame-Options` either, so the clickjacking
 *     protection the container gets is genuinely absent there.
 *   - `http:` in `connect-src` is inert on an https page, where mixed-content
 *     blocking refuses the fetch before CSP is consulted. It stays so that one
 *     string covers both deployments; on the port-forward, where the page is
 *     itself http://localhost:8080, it is what lets a link pointing at a
 *     development server report a real network error rather than a CSP
 *     violation that looks like a different bug.
 *
 * Build only. In dev, @vitejs/plugin-react injects an inline preamble script and
 * HMR opens a websocket, neither of which `script-src 'self'` and this
 * `connect-src` permit, so injecting it there would break `pnpm dev`.
 */
const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self' https: http: data: blob:",
  "worker-src 'self' blob:",
  'frame-src blob:',
  "manifest-src 'self'",
  "base-uri 'self'",
  "form-action 'none'",
  "object-src 'none'",
].join('; ');

/**
 * Spliced in by hand rather than through Vite's tag-injection list, for two
 * reasons. `head-prepend` would put the policy above <meta charset>, which has
 * to stay inside the first 1024 bytes of the document; and the injector escapes
 * the attribute value, turning every `'self'` into `&#39;self&#39;`. Both parse
 * correctly, but a policy is read by people during an incident and it should
 * look like the one in nginx.conf.
 */
const CHARSET_META = '<meta charset="utf-8" />';

function contentSecurityPolicyMeta(): Plugin {
  return {
    name: 'shloupe-csp-meta',
    apply: 'build',
    transformIndexHtml: {
      order: 'pre',
      handler: (html) => {
        // Fail the build rather than publish a bundle that silently lost its
        // policy because index.html was reworded.
        if (!html.includes(CHARSET_META)) {
          throw new Error(
            `shloupe-csp-meta: could not find ${CHARSET_META} in index.html, so the ` +
              'Content-Security-Policy has nowhere to anchor. Update CHARSET_META in ' +
              'vite.config.ts to match.',
          );
        }
        const meta = `<meta http-equiv="Content-Security-Policy" content="${CONTENT_SECURITY_POLICY}" />`;
        // Directly after the charset declaration, and so ahead of every tag the
        // policy is meant to govern: a policy applies from where it is parsed.
        return html.replace(CHARSET_META, `${CHARSET_META}\n    ${meta}`);
      },
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), contentSecurityPolicyMeta()],
  // Served from a bare port-forward with no domain, and from a GitHub Pages
  // project site under a /shl-loupe/ prefix, so every asset reference is
  // relative. An absolute "/assets/..." breaks the moment the app is mounted
  // under a path prefix by an ingress.
  base: './',
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    target: 'es2023',
    sourcemap: true,
  },
});
