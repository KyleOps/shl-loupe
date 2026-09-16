# Deploying SHLoupe

SHLoupe is a static bundle. Whatever serves it makes no outbound request of its
own: every SMART Health Link fetch is made by the browser that has the page open.
That single fact decides most of what follows, including why there is no backend
to operate and no secret to hold anywhere in this directory.

It is served two ways, for two different rooms.

- **GitHub Pages** is the deployment: a public `https` address anyone can be
  given, published from `main`. Everything in the next section.
- **The container image** in this directory is for a room the Pages URL cannot
  reach: an air-gapped venue, a network that blocks `github.io`, or a laptop that
  needs the tool sitting next to the servers under test. It is a local artefact
  you build and run, not something deployed to a cluster.

## GitHub Pages

<https://kyleops.github.io/shl-loupe/>, published by
[`../.github/workflows/pages.yml`](../.github/workflows/pages.yml). There is
nothing to operate: the workflow builds `dist/` and hands it to
`actions/deploy-pages`, which holds no secret because the credential is an OIDC
exchange. It runs on CI finishing successfully for a commit on `main`, so the
published bundle is always one that passed typecheck, lint and test, and a
`workflow_dispatch` republishes the current `main` by hand.

Two properties of the bundle are what make this work at all, and both are load
bearing rather than incidental:

- **`base: './'`** in `vite.config.ts`. A project Pages site is mounted under
  `/shl-loupe/`, and an absolute `/assets/...` would 404 against the user site at
  the domain root.
- **The hash router.** Every route SHLoupe has lives in the fragment, so there is
  no path for Pages to 404 on and no `404.html` fallback to maintain. Add a real
  path route and this breaks in the way `nginx.conf` describes under _routing_,
  except that on Pages there is no configuration to fix it with.

### What Pages cannot do, and what was done about it

A static host sends no response headers you control, so the entire header set in
`nginx.conf` is simply absent there. The parts that could be recovered were:

| Header                         | On Pages                                                                                                                                                                                                                                                                      |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Content-Security-Policy`      | Recovered. `vite.config.ts` writes the same policy into a `<meta http-equiv>` at build time, minus `frame-ancestors`, which a user agent ignores in a meta element.                                                                                                           |
| `Referrer-Policy: no-referrer` | Recovered, as `<meta name="referrer">` in `index.html`.                                                                                                                                                                                                                       |
| `X-Frame-Options: DENY`        | **Absent**, and with `frame-ancestors` unavailable too, the hosted site can be framed. Nothing in SHLoupe holds a credential or a cookie, so the exposure is a passcode prompt rendered inside somebody else's page rather than a session to steal. The container keeps both. |
| `Permissions-Policy`           | Absent. It only ever narrowed a top-level document's own defaults, and `camera=(self)` was the permissive entry in it, so QR scanning is unaffected.                                                                                                                          |
| `X-Content-Type-Options`       | Absent as a header. Pages serves correct content types, including `application/wasm`, which is what the QR decoder's `instantiateStreaming` needs.                                                                                                                            |
| `Cache-Control`                | Pages sets its own `max-age=600` on everything. A redeploy is therefore visible within ten minutes rather than on the next load; the container's `no-cache` on `index.html` is the better behaviour for a demo and is a reason to keep using it in the room.                  |

The policy itself is not new and is not Pages-specific: it is the one the
container enforces as a header, and `vite.config.ts` says so at the point of
duplication. Change one and change the other in the same commit.

## The container image

- `Dockerfile` builds the bundle with pnpm and serves it from
  `nginxinc/nginx-unprivileged`, non-root on port 8080.
- `nginx.conf` becomes `/etc/nginx/conf.d/default.conf`: SPA fallback, immutable
  caching for hashed assets, gzip, and the security header set (read the
  Content-Security-Policy comments before changing it).

Built from the repo root, because the build context needs `package.json`, `src/`
and `index.html`:

```sh
docker build -f deploy/Dockerfile -t shl-loupe .
docker run --rm -p 8080:8080 shl-loupe
```

Then open **http://localhost:8080**, which is a secure context for the reasons
below. Add `--platform linux/amd64` to the build only when the machine that will
run the image is amd64 and you are building on Apple Silicon; a plain build there
produces arm64 only, which lands on the other machine as `exec format error`.

The image is deliberately self-contained and stateless: no volume, no
environment variable, no configuration file to mount. Anything that would need
one has been decided at build time instead.

## `http://localhost:8080` is a secure context. `http://<LAN-IP>:8080` is not.

This decides how the tool gets used in a room, so it is worth stating precisely.

W3C _Secure Contexts_, section 3.1 _Is origin potentially trustworthy?_, returns
"Potentially Trustworthy" when the host matches `127.0.0.0/8` or `::1/128`, and
again when the host is `localhost` (or ends in `.localhost`) on a user agent that
follows the localhost name-resolution rules. The section closes with a note that
settles the obvious worry:

> Neither origin's domain nor port has any effect on whether or not it is
> considered to be a secure context.

So on a container published to `localhost`:

- **WebCrypto works.** The Web Cryptography API declares
  `[SecureContext] readonly attribute SubtleCrypto subtle`, which is why
  `crypto.subtle` is `undefined` outside a secure context rather than throwing.
  SHLoupe needs it for the `A256GCM` JWE decrypt and the `ES256` health-card
  verify, so this is load bearing.
- **QR scanning works**, same reason, given the `Permissions-Policy` in
  `nginx.conf` allows `camera=(self)`.

`docker run -p 0.0.0.0:8080:8080` will happily bind every interface so a
colleague can reach `http://192.168.1.42:8080`. **Do not do that at an event.**
`192.168.1.42` is neither in `127.0.0.0/8` nor `localhost`, so section 3.1 falls
through to "Not Trustworthy": on their laptop `crypto.subtle` is `undefined`,
`navigator.mediaDevices` is `undefined`, and a debugger that cannot decrypt or
scan looks like a broken debugger rather than a browser rule.

Three ways to share, best first:

1. **Send them the Pages URL.** <https://kyleops.github.io/shl-loupe/> is `https`
   from any machine, so it is a secure context on every device in the room
   including phones. This is the answer unless the network will not reach it, and
   it is the reason the Pages deployment exists.
2. **They run their own container**, or `ssh -L 8080:localhost:8080
you@your-laptop` from their machine while yours runs. Either way the page is
   `localhost` on their machine, so the secure context is preserved.
3. **Last resort, their browser, their risk.** Chrome's
   `--unsafely-treat-insecure-origin-as-secure` (spec section 3.1's "configured
   as a trustworthy origin" step). Never offer this first: it teaches exactly the
   wrong lesson at an interoperability event.

One useful corollary. Section 3.1 also makes `file:` potentially trustworthy, and
Chrome and Firefox both implement that, so `pnpm build` and a zipped `dist/` is a
credible "here, run it yourself" handout. It works only while `base: './'` stays
and there are no path routes, which is another reason the router keeps everything
in the fragment.

## When someone says decryption is broken

Ask which URL they opened, before anyone opens devtools. The answer is already
in the run: `viewerOriginFromLocation` records the viewer's own protocol, host,
port and `isSecureContext`, and hands them to every static rule, so a trace taken
on a LAN IP says so itself. It is usually a one-line conversation: a LAN IP, not a
broken browser.
