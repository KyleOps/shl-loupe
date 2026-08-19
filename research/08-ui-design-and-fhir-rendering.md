# 08 - UI design direction and clinical FHIR rendering

Research note for **shl-loupe**, a fully client-side (static site, no backend) SMART Health Link
viewer, debugger and teaching tool for FHIR connectathons and Sparked testing events.

Everything below was fetched live on 2026-08-20 (specs, source files, npm registry metadata).
Every contrast ratio quoted is computed from the WCAG 2.x relative-luminance formula, not
estimated. Every LOINC display was verified against an Ontoserver `$lookup`, not recalled.

---

# HALF A: visual and interaction design

## A0. The design constraint that everything else follows from

The motivating incident is not a rendering failure, it is a **diagnosis** failure. A manifest URL of
`https://localhost:5173/api/shl-manifest?bid=4836470` produced "type load fail" and a bare fetch
`TypeError`. That is not the existing viewer being lazy: **the browser genuinely cannot tell the app
what went wrong.** A cross-origin `fetch()` that fails CORS preflight, fails DNS, fails TLS, or hits
a closed port all reject with the same opaque `TypeError: Failed to fetch`, and the distinguishing
detail is written to the devtools console where page JavaScript cannot read it.

So the design cannot be "show the error nicely". It must be:

> **Compute everything decidable about the link *before* touching the network, and present the
> opaque network failure as a ranked differential over the finite set of causes, with the
> statically-decidable ones already eliminated or confirmed.**

This single decision drives the whole UI: the trace has **preflight steps that run offline**, and a
failure renders as a *verdict with a cause*, not as an exception string. In the motivating case the
verdict is emitted at step 4 with zero network traffic:

```
FAIL  Manifest host is a loopback address
      https://localhost:5173/api/shl-manifest?bid=4836470
             ^^^^^^^^^
      "localhost" resolves to this machine. This link can only ever open on the
      computer that created it. Nothing you do on your machine will fix it; the
      sender must republish it with a publicly reachable host.
```

That one line is the entire product thesis, so the design system exists to make that line
unmissable on a projector at eight metres.

## A1. Reference products: what each one actually gets right

Facts, not vibes. Each row is something to copy or to deliberately reject.

### Chrome DevTools Network panel

Fetched: <https://developer.chrome.com/docs/devtools/network/reference>. The Timing tab breaks one
request into named, ordered phases, each with a one-sentence definition:

| Phase | Chrome's own definition |
|---|---|
| Queueing | "The browser queues requests before connection start" |
| Stalled | "The request could be stalled after connection start" |
| DNS Lookup | "The browser is resolving the request's IP address" |
| Initial connection | "The browser is establishing a connection, including TCP handshakes" |
| Proxy negotiation | "The browser is negotiating the request with a proxy server" |
| Request sent | "The request is being sent" |
| Waiting (TTFB) | "The browser is waiting for the first byte of a response" |
| Content Download | "The browser is receiving the response" |

Default request-table columns: `Name`, `Status`, `Type`, `Initiator`, `Size`, `Time`, `Waterfall`.
The waterfall renders "lighter portions representing waiting time and darker portions representing
download time".

**Copy**: the named-phase vocabulary, and the light-fill/dark-fill duration bar (it encodes two
numbers in one bar without a legend).
**Reject**: the flat request list. shl-loupe's steps are causally *nested* (decrypt depends on
fetch depends on manifest), so a flat list loses the thing that matters.
**Note honestly**: from a page, `PerformanceResourceTiming` gives you `domainLookupStart`,
`connectStart`, `secureConnectionStart`, `requestStart`, `responseStart`, `responseEnd`, but
cross-origin those are **zeroed unless the server sends `Timing-Allow-Origin`**. So a real
DevTools-grade waterfall is unavailable to us for third-party relays. Show total wall-clock
duration honestly, and label the gap rather than faking phases.

### jwt.io

The canonical "dissect an opaque token in front of an audience" interface: the encoded string is
tinted in **three segments** (header, payload, signature), and each tint maps to a decoded pane
beside it. Selecting a segment highlights its pane and vice versa.

**Copy wholesale.** An SHL is structurally the same problem, one layer deeper:
`shlink:/` prefix, base64url payload, then inside the payload a `url` and a `key`, and inside the
fetched file a compact JWE with five dot-separated parts, and inside *that* possibly a compact JWS
with three. shl-loupe should render **the same segment-tint-to-pane mapping recursively**, three
levels deep. That is the single strongest teaching device available, and no existing FHIR tool does
it.
**Reject**: jwt.io's "paste your secret to verify" affordance sits in the header. For us the
decryption key arrives *inside the link*, so the equivalent field is derived, not entered, and must
be shown as derived (read-only, with a "copy" and a "where this came from" pointer at the payload
segment it was extracted from).

### Stripe Workbench Inspector

Fetched: <https://docs.stripe.com/workbench/overview>, <https://docs.stripe.com/workbench/event-destinations>.
Structure: a left-hand **Data map** showing "a hierarchy of related API objects", then tabs
`Overview` (JSON view of the object), `Logs` (request logs related to the object), `Events`
(recently generated events). For a webhook event you get "the event's details, payload, and
attempted deliveries", and the Event deliveries view lists "Delivery attempts including the HTTP
status code of previous delivery attempts".

**Copy**: the *object graph in a rail, detail in the body* split, and above all the
**attempt-list-per-operation** idea. An SHL manifest POST is frequently retried (wrong passcode,
then right passcode; `embeddedLengthMax` renegotiation), and each attempt has its own status code.
Rendering attempts as siblings under one step, rather than overwriting the step, is what lets a
participant see "your first POST 401'd with remainingAttempts 2, your second 200'd".
**Reject**: tabs. Tabs hide state, and at a connectathon the failure is usually in the tab you are
not looking at. Prefer one scroll with collapsed-by-default disclosure, so `Cmd-F` finds everything.

### Inferno test runner

Read from source: `lib/inferno/entities/result.rb`, `lib/inferno/result_summarizer.rb`,
`lib/inferno/entities/message.rb`, `client/src/components/TestSuite/TestSuiteDetails/ResultIcon.tsx`,
`client/src/styles/theme.tsx` (all `inferno-framework/inferno-core@main`).

The status set is **eight values, in priority order**:

```ruby
RESULT_OPTIONS = ['cancel', 'wait', 'running', 'error', 'fail', 'skip', 'pass', 'omit'].freeze
```

Rollup is a first-match over that array, with two refinements worth stealing verbatim:

```ruby
def summarize
  return 'wait' if results.any? { |result| result.result == 'wait' }
  return 'pass' if optional_results_passing_criteria_met?
  prioritized_result_strings.find { |result_string| unique_result_strings.include? result_string }
end
# and: all_optional_results? && any 'pass' && none waiting/running  =>  'pass'
```

So (a) anything waiting on a human dominates the parent's status, and (b) **optional children never
drag a parent down**. Both are exactly right for shl-loupe: "passcode required, waiting for input"
must dominate, and "SHC issuer JWKS unreachable" on a link that carries no SHC must not.

Message severities are `TYPES = ['error', 'warning', 'info']`. Every result carries `messages`,
`requests`, `input_json`, `output_json`. That four-part payload per step is the right shape.

`ResultIcon.tsx` gives every status **a distinct MUI icon plus a tooltip with the word**:
`pass`→`CheckCircle`, `fail`/`cancel`→`Cancel`, `skip`→`Block`, `omit`→`Circle`,
`error`→`Error`, `wait`→`AccessTime`, none→`RadioButtonUnchecked`, running→`Pending`.
That is textbook WCAG 1.4.1 compliance and we should match it.

**Reject two things.** First, Inferno dims optional results by swapping the colour ramp step:
`result.optional ? green[100] : green[500]`, `red[100] : red[700]`, `orange[200] : orange[800]`.
MUI `green[100]` is `#c8e6c9`, which against white is about **1.4:1**: an optional pass is
effectively invisible, and the distinction is carried by colour alone. Encode optional with a
**dashed outline plus the word "optional"**, never a paler tint. Second, Inferno has
**no dark theme at all** (`client/src/styles/theme.tsx` exports a single `lightTheme`, primary
`#f77a25`, `contrastThreshold: 4.5`, `Roboto Condensed` for `h2`). A conference room with the
lights down needs dark-first.

### Cloudflare trace, Radar

`https://<host>/cdn-cgi/trace` returns plain `key=value` lines (`fl`, `h`, `ip`, `ts`, `visit_scheme`,
`uag`, `colo`, `tls`, `http`, `warp`). Radar's pages wrap the same telemetry in large, sparse,
projector-legible cards.

**Copy**: the `key=value` plain-text escape hatch. shl-loupe should have one keystroke that dumps
the entire trace as flat, greppable, paste-into-Zulip text. At a connectathon the artefact that
actually resolves the issue is the paste into chat, not the screenshot. Design for the paste.

### Kibana APM traces

A vertical waterfall of nested spans, each row `name | duration bar | self-time`, with a
**span-detail flyout** and a hard rule that the parent's bar spans its children's extent.

**Copy**: the nesting-with-extent invariant. If manifest-POST is 900ms and the file GET inside it is
700ms, the visual must make the 200ms of overhead visible.
**Reject**: horizontal-only time axis. Our spans are 3 to 12 in count, not thousands, so a vertical
timeline with a left status rail beats a dense horizontal waterfall.

### Sentry issue detail

Order of the page: **culprit line, then a one-sentence title, then metadata chips, then the
stack trace with the relevant frame pre-expanded and app frames distinguished from library frames.**

**Copy exactly this order.** shl-loupe's page order must be: the verdict sentence, then the offending
value with the offending substring underlined, then the chips (flags, expiry, file count), then the
trace with the failing step pre-expanded and every prior step collapsed.

### Hoppscotch / Insomnia response panes

Response body pane with `Pretty | Raw | Preview` toggles, a status chip carrying `status + duration +
size`, and headers as a two-column table.

**Copy**: the three-way body toggle (we need `Rendered | JSON | Raw bytes` at every layer), and the
compound status chip. **Reject**: their "send" ergonomics. We are not a general HTTP client and must
not grow into one.

### HashiCorp and Vercel dashboards

The transferable convention is the **status rail**: a 2px to 3px coloured bar on the leading edge of
a row or card, carrying state, so a long list scans as a colour column while each row still holds
its own icon and label. Vercel's deployment log rows are the closest analogue to a trace step.

### FHIR-world tools

- **IG publisher rendered pages**: the differential/snapshot **tree table** with per-element type
  icons, cardinality in its own column, and flags (`S` must-support, `?!` modifier, `Σ` summary,
  `I` invariant) as compact glyphs. Worth copying: **cardinality and flags get their own columns**,
  they are never crammed into the label.
- **fhirpath.dev**: two panes, resource JSON left, expression plus result right, evaluated live.
  Worth copying as a *drawer*, not a mode: a FHIRPath box that evaluates against the currently
  selected resource, so a spec argument at a connectathon table gets settled in ten seconds.
- **Inferno**: covered above.

## A2. Design system

### Typography

Two families, both variable, both SIL OFL 1.1, both self-hosted from npm (verified on the registry
2026-08-20, `@fontsource-variable/*` all at `5.3.0`, published 2026-07-19):

| Role | Family | Package | Unpacked | Why |
|---|---|---|---|---|
| UI + prose | **Geist** | `@fontsource-variable/geist` | 177 KB | Neutral, tall x-height, unambiguous `1lI`, and **one tenth the payload of Inter** (`@fontsource-variable/inter` is 1864 KB) |
| Code, IDs, JSON, base64 | **Geist Mono** | `@fontsource-variable/geist-mono` | 168 KB | Designed as a pair with Geist, so headings and code share skeletons; slashed zero by default |

Self-host, do not link Google Fonts. Connectathon venue wifi is the thing you are debugging;
a static site that renders correctly with the network unplugged is a feature, and it also removes a
third-party origin from a tool whose whole subject is where bytes travel.

Fallback stacks:

```css
--font-sans: "Geist Variable", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
--font-mono: "Geist Mono Variable", ui-monospace, "SF Mono", "Cascadia Mono", Menlo, monospace;
```

If Geist is rejected on taste, the substitutes are **Inter** (sans) and **JetBrains Mono** (mono,
`@fontsource-variable/jetbrains-mono`, 199 KB). Inter's feature set is documented at
<https://rsms.me/inter/> and is worth knowing even if unused: `tnum` tabular figures, `zero` slashed
zero, `ss02` "Disambiguation (with slashed zero)", `cv01` alternate one, `cv05` lower-case l with
tail, `cv08` upper-case i with serif. If you ship Inter, `font-feature-settings: "ss02" 1, "tnum" 1`
is mandatory, not optional: `1`/`l`/`I` collide in default Inter and this tool displays a great many
identifiers. Do **not** reach for Berkeley Mono or similar paid faces: this needs to be forkable.

Type scale, 1.25 ratio off a 15px base (15px, not 16px: the mono column density matters more than
one step of prose comfort, and Projector Mode below raises it):

| Token | Size / line-height | Weight | Tracking | Use |
|---|---|---|---|---|
| `display` | 34 / 40 | 600 | -0.02em | The verdict sentence. One per page. |
| `h1` | 27 / 34 | 600 | -0.015em | Pane titles |
| `h2` | 21 / 28 | 600 | -0.01em | Trace group, Composition section title |
| `h3` | 17 / 24 | 600 | 0 | Step title, resource card title |
| `body` | 15 / 24 | 400 | 0 | Prose, explanations |
| `small` | 13 / 20 | 400 | 0 | Metadata, captions |
| `micro` | 11 / 16 | 600 | 0.06em | Chip and column labels, uppercase |
| `code` | 13.5 / 21 | 400 | 0 | Mono. Always `font-variant-numeric: tabular-nums`. |
| `code-sm` | 12 / 18 | 400 | 0 | Inline mono inside `small` |

Hard rules:
- Every number that can change between renders (durations, byte counts, status codes, remaining
  attempts) is `tabular-nums`, so a re-render does not reflow the column.
- Long opaque strings (base64url payloads, JWE parts, `urn:uuid`) use
  `overflow-wrap: anywhere; word-break: normal` inside a `max-height` clamp with an expander.
  Never `text-overflow: ellipsis` on a value the user needs to copy: a truncated key that *looks*
  complete is worse than one that obviously is not.
- Section headings from clinical content are **prose**, so they take the sans, never the mono.
  Field *names* from FHIR take the mono. That single split is what tells a clinician which parts of
  the screen are for them.

### Palette

Dark-first, with a light counterpart. Base hues are lifted from **Primer** dark/light scales
(fetched from `primer/primitives@main`, `src/tokens/base/color/{dark,light}/*.json5`), because those
ramps are already tuned for exactly this job (code UI, projector, both modes) and are a defensible
citation rather than my taste.

**Dark tokens**

| Token | Hex | Notes |
|---|---|---|
| `bg.canvas` | `#0D1117` | Page |
| `bg.surface` | `#161B22` | Panes, cards |
| `bg.raised` | `#1C2128` | Expanded step body, code blocks |
| `bg.inset` | `#010409` | Deepest well, raw-byte view |
| `border.hairline` | `#30363D` | Decorative separators only |
| `border.meaningful` | `#656D76` | Any border that carries information |
| `fg.default` | `#E6EDF3` | |
| `fg.muted` | `#9198A1` | |
| `fg.subtle` | `#6E7681` | **Only on `bg.canvas` or `bg.surface`** (see ratios) |
| `accent` | `#58A6FF` | Interactive, focus ring, links |
| `status.pass` | `#3FB950` | |
| `status.warn` | `#D29922` | |
| `status.fail` | `#F85149` | |
| `status.exception` | `#D2A8FF` | Tool broke, distinct from "link is wrong" |
| `status.info` | `#79C0FF` | |
| `status.skip` | `#8B949E` | |

Tinted surfaces for badges and callouts (never a mode-flipping text token on a fixed pale shade):

| Pair | Ratio |
|---|---|
| `#3FB950` on `#0D2A14` | 6.09:1 |
| `#D29922` on `#2E2205` | 6.18:1 |
| `#F85149` on `#2E1113` | 5.20:1 |
| `#79C0FF` on `#0B2A4A` | 7.48:1 |
| `#D2A8FF` on `#231442` | 8.63:1 |

**Light tokens**: `bg.canvas #FFFFFF`, `bg.surface #F6F8FA`, `border.hairline #D1D9E0`,
`border.meaningful #818B98`, `fg.default #1F2328`, `fg.muted #59636E`, `accent #0969DA`,
`status.pass #1A7F37`, `status.warn #9A6700`, `status.fail #CF222E`, `status.exception #8250DF`.
Tinted pairs: `#1A7F37` on `#DAFBE1` 4.56:1, `#9A6700` on `#FFF8C5` 4.52:1, `#CF222E` on `#FFEBE9`
4.67:1, `#0969DA` on `#DDF4FF` 4.56:1, `#8250DF` on `#FBEFFF` 4.54:1.

**Verified contrast ratios** (computed, not estimated):

| Foreground | on `#0D1117` | on `#161B22` | on `#1C2128` |
|---|---|---|---|
| `fg.default #E6EDF3` | 16.02 | 14.64 | 13.70 |
| `fg.muted #9198A1` | 6.50 | 5.94 | 5.56 |
| `fg.subtle #6E7681` | 4.12 | 3.77 | **3.52** |
| `accent #58A6FF` | 7.49 | 6.85 | 6.41 |
| `pass #3FB950` | 7.45 | 6.81 | 6.37 |
| `warn #D29922` | 7.50 | 6.85 | 6.41 |
| `fail #F85149` | 5.65 | 5.16 | 4.83 |
| `exception #D2A8FF` | 9.72 | 8.88 | 8.31 |

Light mode on `#FFFFFF` / `#F6F8FA`: `fg.default` 15.80 / 14.84, `fg.muted` 6.11 / 5.74,
`accent` 5.19 / 4.88, `pass` 5.08 / 4.77, `warn` 4.87 / 4.57, `fail` 5.36 / 5.03,
`exception` 5.05 / 4.74. Every status colour clears 4.5:1 in both modes on both backgrounds.

Two consequences that fall straight out of the numbers:

1. **`fg.subtle` is banned on `bg.raised`** (3.52:1, under 4.5). Since `bg.raised` is exactly where
   expanded step bodies live, the rule is: inside an expanded body, metadata steps up to `fg.muted`.
   Enforce it with a lint rule or a token-pair test, because it will be violated otherwise.
2. **Hairlines do not meet 1.4.11.** `#30363D` on `#0D1117` is 1.55:1, and light-mode `#D1D9E0` on
   white is 1.43:1. That is fine for a decorative separator (a purely aesthetic boundary is exempt),
   but it means **no border may be the sole carrier of a status or a boundary the user must
   perceive**. Anything informational uses `border.meaningful` (`#656D76`, 3.61 / 3.30 / 3.08) or the
   status colour at full strength. The focus ring is `accent` (7.49 dark, 5.19 light), never a grey.

### Space, radius, elevation

4px base grid. Spacing scale: `2, 4, 6, 8, 12, 16, 20, 24, 32, 40, 56, 72`. Never an off-scale
value; a 5px gap is the visual signature of a tool nobody cared about.

Radii: `2` (chips, inline code), `6` (buttons, inputs, badges), `10` (cards, step bodies),
`14` (panes, modals), `999` (status dots, pills). Nothing above 14 except pills.

**Elevation is hairlines and background steps, never shadows.** Two reasons, both practical:
projectors crush a soft shadow into a grey smear, and dark-mode shadows are physically meaningless.
The ladder is `bg.canvas` → `bg.surface` + 1px `border.hairline` → `bg.raised` + 1px
`border.hairline` → `bg.inset`. Exactly one shadow is permitted in the whole app, on the command
palette overlay, and only because a floating layer over arbitrary content needs a boundary that a
hairline cannot guarantee.

Hairline width is `1px` at `1x`, and `max(1px, 0.5px)` via a `transform: scaleY(0.5)` pseudo-element
is **not** worth it here: on a projector, sub-pixel hairlines disappear entirely.

## A3. Verdict rendering

There are exactly five verdict states, and the vocabulary is fixed once, in code, as a union type.
Do not let a sixth appear.

| Verdict | Icon | Colour | Means | Example |
|---|---|---|---|---|
| `pass` | filled circle-check | `status.pass` | This link opens, for anyone, now | manifest 200, all files decrypted |
| `warn` | filled triangle-alert | `status.warn` | Opens, but something is non-conformant or fragile | `exp` inside 24h, missing `label`, `Content-Type: application/json` on a JWE file |
| `fail` | filled circle-x | `status.fail` | This link cannot open, and here is why | loopback host, expired, wrong key length |
| `blocked` | clock | `status.info` | Cannot proceed without a human | passcode required (`P` flag), and none entered |
| `exception` | filled octagon-bang | `status.exception` | **shl-loupe** broke, not the link | unhandled decrypt path, parser crash |

`exception` being visually distinct from `fail` is not decoration. At a connectathon the most
expensive failure mode is a participant spending twenty minutes fixing a link that was fine, because
the tool blamed them. Steal Inferno's separation of `error` (purple) from `fail` (red) verbatim.

Rollup follows Inferno's summariser, ported:

```ts
// priority order, first match wins
const ORDER = ['exception', 'blocked', 'fail', 'warn', 'pass', 'skip'] as const;

export function rollup(children: readonly Step[]): Verdict {
  if (children.some(c => c.verdict === 'blocked')) return 'blocked';   // human-gated dominates
  const required = children.filter(c => c.required);
  const pool = required.length ? required : children;                   // optional never drags down
  const present = new Set(pool.map(c => c.verdict));
  return ORDER.find(v => present.has(v)) ?? 'skip';
}
```

The verdict banner, at the top of the page, is the only `display`-size type in the app:

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ ●  FAIL   Manifest host is a loopback address                                    │
│           This link can only ever open on the machine that created it.           │
│                                                                                  │
│    https://localhost:5173/api/shl-manifest?bid=4836470                           │
│            ─────────                                                             │
│                                                                                  │
│    [ Copy diagnosis ]  [ Explain to the sender ▸ ]  [ Jump to step 4 ]           │
└──────────────────────────────────────────────────────────────────────────────────┘
```

Three non-obvious requirements:

- **Underline the offending substring in the offending value.** Not "the host is wrong": point at
  `localhost` inside the actual URL, in mono, with a caret rule beneath it. This is what turns a
  message into evidence.
- **"Explain to the sender" produces prose addressed to a third party.** The participant's next
  action is a Zulip message, not a code change. Generating that message is the feature.
- **The banner is `role="status"` with `aria-live="polite"`**, and the verdict word is in the
  accessible name, so a screen reader announces "Fail, manifest host is a loopback address" without
  the user hunting.

Every step also carries a **finding** list with the Inferno severity triple (`error`, `warning`,
`info`), and each finding carries a stable machine id (`SHL-MANIFEST-LOOPBACK`,
`SHL-JWE-ALG-NOT-DIR`, `IPS-SECTION-MISSING-TEXT`). Stable ids are what let a Sparked test plan cite
a specific diagnosis, and what let the paste-into-Zulip text stay greppable across releases.

## A4. Trace rendering

The trace is the SHL open sequence, as a vertical timeline. Steps are the real ones, so the tool
teaches the spec by being a faithful transcript of it:

| # | Step | Network | Catches |
|---|---|---|---|
| 1 | Recognise and split the link | no | `shlink:/` vs `#shlink:/` in a viewer URL, stray whitespace, a URL-encoded payload |
| 2 | base64url-decode the payload | no | wrong padding, base64 (`+/`) instead of base64url (`-_`) |
| 3 | Read payload fields (`url`, `key`, `exp`, `flag`, `label`, `v`) | no | key not 43 chars, `flag` letters unknown, `exp` in the past |
| 4 | **Preflight the manifest URL** | no | **loopback, `http:`, RFC1918, `.local`, non-default port, IP literal** |
| 5 | POST the manifest | yes | 401 with `remainingAttempts`, 404, 429, non-JSON body, missing CORS |
| 6 | Read the manifest `files[]` | no | `embedded` and `location` both absent, unexpected `contentType` |
| 7 | GET each `location` | yes | 403 on a single-use URL already spent, CORS on the *file* host (a distinct host from the manifest, and frequently the one that is misconfigured) |
| 8 | JWE decrypt (`alg: dir`, `enc: A256GCM`) | no | five-part structure, `alg`/`enc` mismatch, auth-tag failure meaning wrong key |
| 9 | Classify and parse payload by `contentType` | no | `application/fhir+json`, `application/smart-health-card`, `application/smart-api-access` |
| 10 | Verify SHC JWS (ES256) if present | yes (JWKS) | `.well-known/jwks.json` unreachable, `kid` not in the set, DEFLATE inflate failure |
| 11 | Render the FHIR payload | no | Half B |

Steps 1 to 4, 6, 8, 9 run with the network unplugged. **That is the differentiator**: an
unopenable link gets a full, specific verdict before a single packet leaves.

### Trace step component

Collapsed (the default for `pass`, auto-expanded for anything else):

```
  │
  ├─┬─────────────────────────────────────────────────────────────────────────┐
  │ │ ●  5  POST the manifest                        200   412 ms   1.4 KB  ▸ │
  │ └─────────────────────────────────────────────────────────────────────────┘
  │
```

Expanded:

```
  │
  ├─┬─────────────────────────────────────────────────────────────────────────┐
  ┃ │ ●  5  POST the manifest                        200   412 ms   1.4 KB  ▾ │
  ┃ ├─────────────────────────────────────────────────────────────────────────┤
  ┃ │ Sends the recipient string and, if the P flag is set, the passcode.     │
  ┃ │ A 401 here means the passcode was wrong and the body carries            │
  ┃ │ remainingAttempts. Spec: SMART Health Links, "Manifest Request".        │
  ┃ │                                                                         │
  ┃ │ ATTEMPT 2 OF 2                                     ⧉ copy as curl       │
  ┃ │ ┌ REQUEST ──────────────────────────────────────────────────────┬─────┐ │
  ┃ │ │ POST https://shl.example.org/manifest/xR3q                    │  ⧉  │ │
  ┃ │ │ content-type: application/json                                │     │ │
  ┃ │ │                                                               │     │ │
  ┃ │ │ { "recipient": "shl-loupe", "passcode": "••••",               │     │ │
  ┃ │ │   "embeddedLengthMax": 16384 }                                │     │ │
  ┃ │ └───────────────────────────────────────────────────────────────┴─────┘ │
  ┃ │ ┌ RESPONSE ─ 200 ─ 412 ms ──────────────────────────────────────┬─────┐ │
  ┃ │ │ Pretty │ JSON │ Raw                                           │  ⧉  │ │
  ┃ │ │ files: 1                                                      │     │ │
  ┃ │ │   [0] application/smart-health-card   location  (3.1 KB)      │     │ │
  ┃ │ └───────────────────────────────────────────────────────────────┴─────┘ │
  ┃ │ ⚠  warning  SHL-MANIFEST-NO-CACHE-HEADER                                │
  ┃ │    No Cache-Control on the manifest response. Not fatal; a caching      │
  ┃ │    proxy may serve a stale single-use file URL.                         │
  ┃ └─────────────────────────────────────────────────────────────────────────┘
  │
```

Anatomy, in order, and every element is load-bearing:

1. **Status rail** on the leading edge, 3px, in the step's verdict colour. Thickens to 4px and
   becomes the `┃` glyph above when the step is expanded, so the eye can find its way back after
   scrolling a long body.
2. **Status dot plus icon**, distinct glyph per verdict. Colour is never the only signal.
3. **Step number**, mono, tabular. Stable across runs, so "step 7 failed" is a usable sentence
   across two machines.
4. **Title**, sans, `h3`. Written as a *thing the software does*, imperative-neutral, never
   "Manifest fetch": "POST the manifest".
5. **Right-aligned metric cluster**: status code, duration, size. Mono, tabular, fixed column
   widths so the numbers form columns down the trace. `--` for a step with no network, never a `0`.
6. **Disclosure chevron**, and the whole header row is the button (`<button>` wrapping the row, not
   a chevron-only hit target).
7. **One-paragraph explanation, always present, even on pass.** This is the teaching tool half. It
   says what the step is for, what the common failures are, and cites the spec clause. On `pass` it
   is the only content, which means expanding a green step is *rewarding*, which is what makes people
   read the spec.
8. **Attempt blocks**, siblings, newest last, labelled `ATTEMPT n OF m`.
9. **Request and response panes**, each with a copy button and each with the `Pretty | JSON | Raw`
   toggle. `Raw` shows bytes, hex-and-ASCII, for the case where the body is a JWE or a `DEFLATE`
   stream. Secrets (passcode, `key`) are masked by default with a per-field reveal, because this
   screen gets projected.
10. **Findings**, severity icon plus stable id plus one sentence plus one sentence of consequence.

Copy affordances, all of them, because the artefact is the paste:
`⧉ copy as curl`, `⧉ copy request`, `⧉ copy response`, `⧉ copy this step`, and one global
`⧉ copy whole trace as text`. The curl reproduction is the highest-value button on the page: it
converts a browser-only, CORS-bound failure into something the sender can run in a terminal, and
**a curl that succeeds where the browser failed is a positive CORS diagnosis**, which is otherwise
undecidable from a page.

### Durations

Bars, not just numbers, and only for steps that made a network call. A single scale across the
trace, normalised to the longest step, minimum bar width 2px so a 3ms step is still visibly a bar.
Follow DevTools' two-tone fill: light for waiting, dark for transfer, when
`PerformanceResourceTiming` gives us `responseStart` (same-origin or `Timing-Allow-Origin`), and a
single flat tone with a `?` affordance explaining *why* the breakdown is unavailable when it does
not. Explaining the absence is more useful than a fabricated split.

## A5. Layout

Three panes, but with a hard rule: **on failure the trace is the hero, on success the payload is.**
The layout responds to the verdict rather than being a fixed grid, because a fixed grid means the
common case (a broken link) shows a large empty payload pane, which reads as the tool having failed.

```
┌───────────────────────────────────────────────────────────────────────────────────────────────┐
│  ◎ shl-loupe            ┌──────────────────────────────────────────┐   ⌘K   ☾  ⛭  Projector  │
│                         │ shlink:/eyJ1cmwiOiJodHRwczovL2xvY2FsaG9  │                          │
│                         └──────────────────────────────────────────┘                          │
├───────────────────────────────────────────────────────────────────────────────────────────────┤
│  ●  FAIL   Manifest host is a loopback address                                                │
│            https://localhost:5173/api/shl-manifest?bid=4836470                                │
│                    ─────────                                                                  │
│            [ Copy diagnosis ]  [ Explain to the sender ▸ ]  [ Jump to step 4 ]                │
├──────────────────────┬──────────────────────────────────────┬─────────────────────────────────┤
│ LINK                 │ TRACE                                │ PAYLOAD                         │
│                      │                                      │                                 │
│ shlink:/ ▪▪▪▪▪▪▪▪▪▪  │  ● 1  Recognise the link      ✓      │                                 │
│          └ payload   │  ● 2  Decode base64url        ✓      │      (no payload retrieved)     │
│                      │  ● 3  Read payload fields     ✓      │                                 │
│ DECODED PAYLOAD      │  ● 4  Preflight manifest URL  ✗   ▾  │      The trace stopped at       │
│ url   https://loc…⧉  │      ┌───────────────────────────┐   │      step 4. Nothing was         │
│ key   rxTa…9Qw    ⧉  │      │ Hosts that only resolve   │   │      fetched, so there is        │
│ exp   2026-08-27     │      │ on the sender's machine   │   │      nothing to render.          │
│ flag  LP             │      │ …                         │   │                                 │
│ label Mia's summary  │      │ ⧉ copy as curl            │   │      [ Load a sample payload ]  │
│ v     1              │      └───────────────────────────┘   │                                 │
│                      │  ○ 5  POST the manifest    skipped   │                                 │
│ FLAGS                │  ○ 6  Read files[]         skipped   │                                 │
│ L long-term          │  ○ 7  GET each file        skipped   │                                 │
│ P passcode required  │  ○ 8  JWE decrypt          skipped   │                                 │
│                      │  ○ 9  Classify payload     skipped   │                                 │
│ ▸ Raw payload JSON   │  ○ 10 Verify SHC JWS       skipped   │                                 │
│ ▸ Segment map        │  ○ 11 Render               skipped   │                                 │
└──────────────────────┴──────────────────────────────────────┴─────────────────────────────────┘
   320px fixed              flex, min 480px                       flex, min 420px
```

On `pass`, the same three columns, but the widths swap: `LINK` collapses to a 44px icon rail with a
hover-out, `TRACE` narrows to a 280px summary column (dots and titles, no bodies), and `PAYLOAD`
takes the remaining ~60% with the clinical renderer. One click on any trace step re-expands the
trace to 50% as an overlay-free split, and the payload keeps its scroll position.

Below 1100px: the three panes become a two-tab shell (`Trace` / `Payload`) with the verdict banner
and link input persistent. Below 700px (a phone at a table, which does happen): single column,
verdict, then trace, then payload, no tabs, because tabs on a phone hide the thing you were sent to
look at.

Chrome details:
- The **link input is the only thing in the header**, centre-weighted, and it accepts a `shlink:/`,
  a full viewer URL with a `#shlink:/` fragment, a bare base64url payload, a raw JSON payload, or a
  dropped `.txt`/`.json` file. Accepting all five without a mode switch is a real feature: at an
  event people paste whatever they have.
- **`⌘K` command palette**: `Load sample: IPS`, `Load sample: AU PS`, `Load sample: broken localhost`,
  `Copy whole trace`, `Toggle Projector Mode`, `Evaluate FHIRPath`, `Clear`. The samples matter: the
  teaching-tool use is someone walking a room through a *correct* link, and they need one keystroke
  to get there.
- **Nothing persists to a server, and the UI says so.** A single line in the footer:
  "Everything runs in this tab. No payload is uploaded." Put it in the footer, not a modal.
  For a tool handling clinical payloads at an event, that sentence is load-bearing trust.
- **URL state**: the link goes in the fragment (`#shlink:/...`), never the query string, so it is
  not sent to the host on navigation, and a colleague can be handed a reproducible URL.

## A6. Accessibility rules

Non-negotiable, and each is testable:

1. **Never colour alone** (WCAG 2.2 SC 1.4.1). Every verdict carries a distinct icon *shape*
   (circle-check, triangle-alert, circle-x, clock, octagon-bang) plus the word, in the accessible
   name. The Inferno `ResultIcon.tsx` pattern (icon plus tooltip plus `aria-hidden="false"`) is the
   reference implementation. Shapes must differ in silhouette, not just glyph interior, so they
   survive a projector's colour cast.
2. **Text contrast**: 4.5:1 for body, 3:1 for text at 18.66px+ bold or 24px+ (SC 1.4.3). Verified
   above for every token pair. `fg.subtle` on `bg.raised` (3.52:1) is the one failing pair and is
   banned.
3. **Non-text contrast** (SC 1.4.11, Level AA): "The visual presentation of the following have a
   contrast ratio of at least 3:1 against adjacent color(s): User Interface Components, Graphical
   Objects." Consequences: hairlines at 1.55:1 may only be decorative; the focus ring is `accent`
   (7.49:1); duration bars use status/`#8B949E` at ≥5.6:1 on `bg.surface`; the status rail carries
   the full-strength status colour.
4. **Keyboard paths**, complete and documented in a `?` overlay:
   - `Tab` walks: link input → verdict actions → each step header → each copy button inside an
     expanded step → payload tree.
   - `j` / `k` move between steps without expanding (roving `tabindex`, one tab stop for the whole
     trace list, `aria-activedescendant`).
   - `Enter` / `Space` toggles the focused step. `→` expands, `←` collapses, matching `tree` widget
     conventions.
   - `Shift+Enter` expands all, `Shift+Backspace` collapses all.
   - `c` copies the focused step. `⌘K` palette. `?` shortcuts. `Escape` closes any overlay and
     returns focus to its trigger.
   - Focus is **never** trapped except in the palette, which returns focus on close.
5. **Semantics**: the trace is `<ol>`; each step is an `<li>` whose header is a `<button
   aria-expanded aria-controls>`; the body is a region labelled by the header. The verdict banner is
   `role="status" aria-live="polite"`. The payload tree is `role="tree"` with `aria-level`,
   `aria-expanded`, `aria-selected`. Do not build a custom accordion: use the disclosure pattern,
   which is one button and one region, and which works.
6. **`prefers-reduced-motion: reduce`**: no exceptions. Expand/collapse becomes an instant
   `display` change (no height animation), the running-step pulse becomes a static "running" label
   plus icon, the duration bars appear at full length rather than growing, and every `transition`
   drops to `0ms`. Do this with one media query overriding a `--motion-duration` custom property, so
   a new component inherits it rather than needing to remember.
7. **Motion budget even without the media query**: 120ms for state, 180ms for disclosure,
   `cubic-bezier(0.2, 0, 0, 1)`. Nothing loops except a genuinely-in-flight step, and it stops when
   the work does.
8. **Zoom and reflow** (SC 1.4.10): usable at 400% zoom at 1280px wide, which the two-tab shell
   handles. No horizontal page scroll ever; wide content (JSON, base64, tables) scrolls inside its
   own `overflow-x: auto` container.
9. **Do not rely on hover.** Every copy button is present in the DOM and focusable, not
   hover-revealed. Hover-reveal is a touch-device and screen-reader trap, and it is also
   unusable when someone else is driving the laptop.

## A7. Projector Mode

An explicit toggle in the header, persisted, and the single highest-leverage thing in this document
for the stated use case. Conference projectors crush blacks, wash mid-greys, and lose 1px lines.
Projector Mode is not "bigger fonts", it is a token override set:

| Token | Normal | Projector | Why |
|---|---|---|---|
| base font | 15px | 17px | Legible at eight metres |
| `bg.canvas` | `#0D1117` | `#161B22` | Avoid black crush; keeps shadow detail |
| `fg.muted` | `#9198A1` | `#C9D1D9` | Mid-greys wash out first |
| `fg.subtle` | `#6E7681` | (aliased to `fg.muted`) | Retire the tier entirely |
| hairline width | 1px | 2px | 1px vanishes |
| `border.hairline` | `#30363D` | `#484F58` | Raise separator contrast |
| status rail | 3px | 5px | The colour column must read from the back row |
| `micro` tracking | 0.06em | 0.08em | Uppercase tightens up under projection |
| max content width | none | 1600px | Stop a 4K panel becoming unreadable line lengths |

Also in Projector Mode: masked secrets stay masked and the reveal control requires a second
confirm, because the audience is looking at a passcode. And **the trace collapses to titles by
default** with a "walk through" control that expands one step at a time, forward and back with
`→`/`←`, which turns the tool into a presentation without a deck.

---

# HALF B: rendering a clinical FHIR payload

## B1. The IPS section set, verified

Parsed from the snapshot of `StructureDefinition-Composition-uv-ips`
(<https://hl7.org/fhir/uv/ips/StructureDefinition-Composition-uv-ips.json>). Sixteen slices, in the
profile's own order, which is the order to render in. **Every one is `mustSupport`, and every one
has `section.text` at `1..1` `mustSupport`.**

| # | Slice | LOINC | Card. | Entry target profiles |
|---|---|---|---|---|
| 1 | `sectionProblems` | `11450-4` | **1..1** | `Condition`, `DocumentReference` |
| 2 | `sectionAllergies` | `48765-2` | **1..1** | `AllergyIntolerance`, `DocumentReference` |
| 3 | `sectionMedications` | `10160-0` | **1..1** | `MedicationStatement`, `MedicationRequest`, `MedicationAdministration`, `MedicationDispense`, `DocumentReference` |
| 4 | `sectionImmunizations` | `11369-6` | 0..1 | `Immunization`, `DocumentReference` |
| 5 | `sectionResults` | `30954-2` | 0..1 | `Observation`, `DiagnosticReport`, `DocumentReference` |
| 6 | `sectionProceduresHx` | `47519-4` | 0..1 | `Procedure`, `DocumentReference` |
| 7 | `sectionMedicalDevices` | `46264-8` | 0..1 | `DeviceUseStatement`, `DocumentReference` |
| 8 | `sectionAdvanceDirectives` | `42348-3` | 0..1 | `Consent`, `DocumentReference` |
| 9 | `sectionAlerts` | `104605-1` | 0..1 | `Flag`, `DocumentReference` |
| 10 | `sectionFunctionalStatus` | `47420-5` | 0..1 | `Condition`, `ClinicalImpression`, `DocumentReference` |
| 11 | `sectionPastProblems` | `11348-0` | 0..1 | `Condition`, `DocumentReference` |
| 12 | `sectionPregnancyHx` | `10162-6` | 0..1 | `Observation`, `DocumentReference` |
| 13 | `sectionPatientStory` | `81338-6` | 0..1 | `Resource` (any) |
| 14 | `sectionPlanOfCare` | `18776-5` | 0..1 | `CarePlan`, `ImmunizationRecommendation`, `DocumentReference` |
| 15 | `sectionSocialHistory` | `29762-2` | 0..1 | `Observation`, `DocumentReference` |
| 16 | `sectionVitalSigns` | `8716-3` | 0..1 | `Observation`, `DocumentReference` |

Note that **`DocumentReference` is an allowed entry in fifteen of sixteen sections.** A renderer that
handles only the "expected" clinical type per section will silently drop content. The
`DocumentReference` renderer is therefore not a nice-to-have, it is the second most important
component after `Observation`.

### The LOINC display trap, verified against Ontoserver

The IPS profile pins `section.code` as a pattern with **the code only, no `display`**. Tools then
invent a display, and get it wrong. Verified `$lookup` results (Ontoserver, 2026-08-20):

| Code | Actual LOINC display | Commonly (wrongly) written as |
|---|---|---|
| `11450-4` | `Problem list - Reported` | "Problem list" |
| `48765-2` | `Allergies and adverse reactions Document` | "Allergies and Intolerances" |
| `10160-0` | `History of Medication use Narrative` | "Medication Summary" |
| `30954-2` | **`Relevant diagnostic tests/laboratory data note`** | "…/laboratory data Narrative" |
| `11369-6` | **`History of Immunization note`** | "History of Immunization Narrative" |
| `47519-4` | `History of Procedures Document` | "History of Procedures" |
| `8716-3` | **`Vital signs note`** | "Vital signs" |
| `104605-1` | **`Alert`** | "Alerts" |

Three of these are outright wrong in the wild, and they are all in the same shape: the LOINC display
is a *lab-style* name, not a human section heading.

**The rule that follows: render `Composition.section.title` as the heading, always. Never the LOINC
display.** `section.title` is what the author wrote for a human, it carries the correct local
spelling (Australian "Immunisation" in an AU PS), and it is `1..1 mustSupport` in AU PS. Surface the
LOINC `code` beside it as a small mono chip (`LOINC 8716-3`), with the *verified* display in the
tooltip, and mark a divergence between an asserted `coding.display` and the code system's own
display as an `info` finding, since that is a real conformance smell worth teaching.

## B2. AU PS: the deltas that matter to a renderer

Parsed from `StructureDefinition-au-ps-composition` (`hl7.org.au/fhir/ps`, version `1.0.1-ci-build`,
via <https://build.fhir.org/ig/hl7au/au-fhir-ps/StructureDefinition-au-ps-composition.json>).
`baseDefinition` is `http://hl7.org.au/fhir/StructureDefinition/au-composition`, and the IG states
"A valid AU PS document IS a valid IPS document" and that "Required (Mandatory) sections are
Problems, Allergies and Intolerances, and Medication Summary" with "Recommended sections are
Immunizations, Results (Diagnostics), History of Procedures, and Medical Devices"
(<https://hl7.org.au/fhir/ps/0.4.0-draft/the-aups.html>).

Same sixteen slices, same LOINC codes. The renderer-relevant differences:

- **`Composition.section` is `3..*`** (IPS leaves the base cardinality). A payload with two sections
  is AU PS invalid, so a section count is worth showing as a chip.
- **`Composition.section.section` is `..0`.** AU PS forbids subsections outright. A renderer can
  therefore be flat, but should emit a `fail` finding if it meets a nested section in a payload
  claiming the AU PS profile.
- **`title`, `code` and `text` are each `1..` and `mustSupport` on every slice.** So in AU PS the
  narrative fallback is guaranteed, and a missing `section.text` is a hard finding, not a shrug.
- **A `section-note` extension** exists on `Composition.section`, described as "Additional notes
  that apply to the section (but not to specific resource)". Render it as a section-level callout
  above the entries, not as an entry.
- **`sectionResults` slices its entries three ways**: `results-observation-laboratory-pathology`,
  `results-observation-radiology`, `results-diagnosticReport`. So the Results section needs
  sub-grouping by discriminator, not one flat list.
- **`sectionSocialHistory` entries are capped at `0..1` each**: `smokingTobaccoUse` and
  `alcoholUse`. A payload carrying two smoking-status Observations is invalid, and this is exactly
  the kind of slice cap a viewer should surface, because it is invisible to a generic validator run
  without the IG loaded.
- `sectionFunctionalStatus` splits into `disability` and `functionalAssessment`;
  `sectionPregnancyHx` into `pregnancyStatus` and `pregnancyOutcome`.

### The Bundle-level facts a renderer can rely on

From `StructureDefinition-Bundle-uv-ips` (differential):

- `Bundle.type` **fixed** `document`
- `Bundle.identifier` `1..1` mustSupport, `Bundle.timestamp` `1..1` mustSupport
- `Bundle.entry` `2..*`
- **`Bundle.entry.fullUrl` `1..1`**
- `Bundle.entry.search`, `.request`, `.response` all `..0`
- `Bundle.entry:composition` `1..1` mustSupport, `Bundle.entry:patient` `1..1`, and each slice's
  `.resource` is `1..` (so no reference-only entries)

`fullUrl` being mandatory is the single most useful fact for a renderer: **in a conformant IPS or
AU PS every entry is addressable, so intra-bundle reference resolution always has a target to find,
and a dangling reference is unambiguously a defect rather than an ambiguity.**

The entry slice list is also the complete resource-type inventory to support: `Composition`,
`Patient`, `AllergyIntolerance`, `CarePlan`, `ClinicalImpression`, `Condition`, `Consent`, `Device`,
`DeviceUseStatement`, `DiagnosticReport`, `DocumentReference`, `Flag`, `ImagingStudy`,
`Immunization`, `ImmunizationRecommendation`, `Medication`, `MedicationRequest`,
`MedicationStatement`, `Practitioner`, `PractitionerRole`, `Procedure`, `Organization`, `Specimen`,
plus seven `Observation` slices (pregnancy EDD / outcome / status, alcohol use, tobacco use,
laboratory-pathology results, radiology results, vital signs). Twenty-four distinct types, which is
what makes the ~15-renderer inventory in B7 achievable.

## B3. What a Composition document renderer must do

Six obligations, in order.

### 1. Resolve references inside the bundle, by the spec's own algorithm

FHIR R4 §2.36.4.1 "Resolving references in Bundles" (<https://hl7.org/fhir/R4/bundle.html>), quoted:

> "Applications reading a Bundle should always look for a resource by its identity in the bundle
> first before trying to access it by its URL externally."

The algorithm, verbatim:

> "If the reference is not an absolute reference, convert it to an absolute URL:
> if the reference has the format `[type]/[id]`, and if the `fullUrl` for the bundle entry containing
> the resource is a RESTful one (see the RESTful URL regex), extract the `[root]` from the `fullUrl`,
> and append the reference (`type/id`) to it, then try to resolve within the bundle as for a RESTful
> URL reference. If no resolution is possible, then the reference has no defined meaning within this
> specification. […] else Look for an entry with a `fullUrl` that matches the URI in the reference; if
> no match is found, and the URI is a URL that can be resolved (e.g. if an `http:` URL), try accessing
> it directly."

And two rules people miss:

> "If the reference is version specific (either relative or absolute), then remove the version from
> the URL before matching `fullUrl`, and then match the version based on `Resource.meta.versionId`."

> "If multiple matches are found, it is ambiguous which is correct. Applications MAY return an error
> or take some other action as they deem appropriate."

**The `urn:uuid` trap, stated precisely.** A `urn:uuid:` `fullUrl` is not a RESTful URL, so it has no
`[root]`. Per the algorithm, a relative reference such as `Patient/123` inside an entry whose
`fullUrl` is `urn:uuid:...` **has no defined meaning**: there is nothing to make it absolute
against. This is not a viewer bug to work around, it is a defect in the payload, and it is
extremely common because a summary is often assembled by copying resources off a REST server (which
wrote relative references) into a bundle with generated `urn:uuid` `fullUrl`s. `references.html`
confirms the same from the other side: a relative URL is "relative to the Service Base URL, or, if
processing a resource from a bundle, which is relative to the base URL implied by the
`Bundle.entry.fullUrl`" (and a `urn:uuid` implies none).

So the resolver must be a **three-outcome** function, and the UI must show all three:

```ts
type Resolution =
  | { kind: 'resolved'; entryIndex: number; resource: FhirResource }
  | { kind: 'contained'; resource: FhirResource }               // '#id' within the same resource
  | { kind: 'external'; url: string }                           // absolute, not in the bundle
  | { kind: 'undefined-meaning'; reason: 'relative-against-urn-uuid' | 'no-match' | 'ambiguous' };
```

Render `resolved` as a clickable chip with the target's display name. Render `contained` the same but
with a distinguishing marker. Render `external` as a chip with an outbound-link glyph and **do not
fetch it** (a viewer that silently dereferences a URL out of an untrusted payload is a beacon; make
it a deliberate, labelled click, and say what will be sent). Render `undefined-meaning` as an amber
chip with the exact reason, plus `Reference.display` if present (per `references.html`, `display`
exists precisely for "applications unable to resolve references"), and record a finding. Never fall
back to "point at something plausible": a positive-signal-only resolver is the only honest one.

### 2. Prefer structured entries, but always keep narrative reachable

`Composition.section.text` is `1..1 mustSupport` in both IPS and AU PS, so the narrative is always
there and is the author's own rendering. The right default is: **render the structured entries, and
offer the narrative as a one-click alternative view per section** (a `Structured | Narrative` toggle
on the section header). Two reasons: the narrative is what the sender's clinicians actually signed
off on, and a divergence between the two is a genuine, teachable finding. Compute a cheap
divergence signal (entry count versus the count of rows in the narrative table) and flag a mismatch
as `info`.

### 3. Sanitise the narrative properly

`Narrative.div` invariants, from <https://hl7.org/fhir/R4/narrative.html>:

> txt-1: "The narrative SHALL contain only the basic html formatting elements and attributes
> described in chapters 7-11 (except section 4 of chapter 9) and 15 of the HTML 4.0 standard, `<a>`
> elements (either name or href), images and internally contained style attributes"

> txt-2: "The narrative SHALL have some non-whitespace content"

And the exclusion list, verbatim: the XHTML "SHALL NOT contain … external stylesheet references,
deprecated elements, scripts, forms, base/link/xlink, frames, iframes, objects or event related
attributes." The spec's stated reason, worth quoting in the tool's own explanation panel:

> "This is to ensure that the content of the narrative is contained within the resource and that
> there is no active content. Such content would introduce security issues and potentially safety
> issues with regard to extracting text from the XHTML."

and the honest caveat, also in the spec:

> "there are still several important security risks associated with displaying the narrative."

Concretely: **sanitise with DOMPurify** (`dompurify@3.4.14`, published 2026-08-19, zero
dependencies, MPL-2.0 OR Apache-2.0), configured as an allowlist that matches txt-1 rather than
DOMPurify's generous defaults, and render into a container with its own style scope. Also validate
`xmlns="http://www.w3.org/1999/xhtml"` on the `div` and report its absence, and report
`Narrative.status` (`generated` = "entirely created from defined data or extensions", `extensions`,
`additional` = "includes human-authored content beyond structured data", `empty`) as a chip, because
`additional` means the narrative carries information the entries do not, and a structured-only
renderer would be **losing clinical content**. That is a finding worth shouting about.

Do **not** render narrative in an `<iframe srcdoc>` thinking it is safer: it is not (same-origin
`srcdoc` inherits the origin), it breaks text selection and printing across the boundary, and it
kills `Cmd-F`. Sanitise and inline.

### 4. Show what the payload claims, and check the claim's shape

Render `meta.profile` for the Bundle and the Composition as chips, resolved to a human name
(`http://hl7.org/fhir/uv/ips/StructureDefinition/Bundle-uv-ips` → "IPS Bundle"). Then run the
*structural* checks a client can do without a terminology server or an IG package: section
cardinalities, `section.text` presence, `Bundle.entry.fullUrl` presence, `type = document`,
Composition first, `section.section` absence for AU PS, the `0..1` social-history slice caps.

**Be scrupulously honest about the limit.** A browser-side tool cannot do profile validation:
no slicing by code-based discriminator without an expansion, no SNOMED CT-AU without a `-sct au`
edition, no `mustSupport` semantics without the IG package. Label the panel
"Structural checks (not profile validation)" and link out to the real thing. A tool that implies
conformance it did not check is worse than one that stays quiet, and this specific overclaim is a
recurring pattern in FHIR tooling.

### 5. Order sections by the profile, not by the document

Render in the IPS slice order from B1, not `Composition.section` document order, and put any section
whose `code` is not one of the sixteen at the end under "Additional sections". Two payloads from
different vendors then look the same, which is the entire point of a comparison tool at a
connectathon. Offer a "document order" toggle for people who care about the wire.

### 6. Handle `emptyReason` as a positive statement

`Composition.section.emptyReason` is mustSupport in AU PS. An empty section with an `emptyReason` of
`nilknown` or `notasked` is a *statement*, and it must not render as blank space. Render it as an
explicit, styled row: "No known allergies (stated by the source)" versus "Not asked". An empty
section with no `emptyReason` and no entries and no narrative is a different thing again, and should
render as a `warn`.

## B4. DocumentReference, Attachment, Binary

### Attachment, the datatype under everything

From `Attachment.profile.json` (R4), the complete element set with definitions:

| Element | Type | Card. | Definition (verbatim, abridged) |
|---|---|---|---|
| `contentType` | `code` | 0..1 | "Mime type of the content, with charset etc." |
| `language` | `code` | 0..1 | "Human language of the content (BCP-47)" |
| `data` | `base64Binary` | 0..1 | "The actual data of the attachment - a sequence of bytes, base64 encoded." |
| `url` | `url` | 0..1 | "A location where the data can be accessed." |
| `size` | `unsignedInt` | 0..1 | "The number of bytes of data that make up this attachment (before base64 encoding, if that is done)." |
| `hash` | `base64Binary` | 0..1 | "The calculated hash of the data using SHA-1. Represented using base64." |
| `title` | `string` | 0..1 | "Label to display in place of the data" |
| `creation` | `dateTime` | 0..1 | "Date attachment was first created" |

The one invariant, and it is a free finding:

```
att-1  error  "If the Attachment has data, it SHALL have a contentType"
              expression: data.empty() or contentType.exists()
```

Four checks a client-side viewer can run for free and should:

1. `att-1`: `data` present, `contentType` absent → `fail`.
2. `size` versus reality: decode `data` and compare byte length to `size`. Note the definition says
   *before* base64 encoding, so compare against the decoded length, not the string length. A
   mismatch is a `warn` and is a very common bug (people write the base64 string length).
3. `hash` verification: it is **SHA-1, base64**, not hex and not SHA-256. Compute
   `btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-1', bytes))))` and
   compare. `crypto.subtle.digest('SHA-1', …)` is available in browsers (SHA-1 is deprecated for
   *signing*, not for digesting, and the spec mandates it here). A mismatch is a `fail`, and it is
   the only integrity check the payload offers.
4. Sniff the actual bytes and compare to the declared `contentType`: `%PDF-` → `application/pdf`,
   `<?xml` plus a `ClinicalDocument` root → `application/xml` CDA, `\x89PNG`, `\xFF\xD8\xFF` JPEG,
   `PK\x03\x04` zip. A declared/actual mismatch is a `warn` and is exactly the class of bug that
   makes a receiver fail mysteriously.

### `data` versus `url`

Both are `0..1`, so four states, and each needs its own rendering:

| `data` | `url` | Render |
|---|---|---|
| yes | no | Fully self-contained. Decode to a `Blob`, preview inline. This is the good case and the only one a fully client-side tool can always handle. |
| no | yes | External. **Never auto-fetch.** Show the URL, run the same preflight checks as trace step 4 (loopback, `http:`, RFC1918), and offer an explicit "Fetch this attachment" button that says what will be sent where. A `localhost` attachment URL inside an otherwise-working link is the same bug as the motivating incident, one layer down, and is worth catching. |
| yes | yes | Both. Render `data`, note the `url` as provenance, and if the user fetches, compare hashes. |
| no | no | Metadata only. Render `title` (its definition is literally "Label to display in place of the data") and `contentType`, and emit a `warn`: a `DocumentReference` with neither is usually a broken export. |

### Previewing, and offering a download that actually works

- **PDF**: create `URL.createObjectURL(blob)` and render in `<embed type="application/pdf">` or
  `<object>`. This uses the browser's own viewer, costs zero bundle, and works for the majority
  case. Only reach for `pdfjs-dist` if you need in-page text extraction or search; it is **33.7 MB
  unpacked** (`6.2.108`, 2026-07-28) with a separate worker, so it must be a lazy dynamic
  `import()` behind an explicit "Open advanced PDF view", never in the main chunk.
- **Images**: `<img src={objectUrl}>` with `max-width: 100%`, and always show the declared
  `contentType` beside it so a mis-declared image is visible.
- **CDA** (`application/xml`, `application/cda+xml`, or a `<ClinicalDocument>` root): transform with
  the browser's own `XSLTProcessor` and the HL7 informative stylesheet from
  <https://github.com/HL7/CDA-core-xsl> (`CDA.xsl`, XSLT 1.0, described as "tested to work with
  Saxon-PE and major browsers", with accessibility work "based on the American Foundation for the
  Blind Section 508"). Browser `XSLTProcessor` implements XSLT 1.0, which is exactly what `CDA.xsl`
  targets, so this genuinely works client-side. Two caveats to design for: `CDA.xsl` is large
  (lazy-load it), and its output is a full HTML document that must be **sanitised and style-scoped**
  before insertion, the same treatment as FHIR narrative. HL7 itself calls it "a sample rendering …
  without warranty", so label the pane "HL7 sample CDA stylesheet", not "CDA".
- **Anything else**: hex-and-ASCII first 1 KB, plus size, plus sniffed type.
- **Download**: `<a href={objectUrl} download={title ?? derivedName}>`. Derive the filename from
  `title`, sanitised, with an extension from the sniffed (not declared) `contentType`, and revoke
  the object URL on unmount. Cap inline decode at a threshold (say 8 MB) and require an explicit
  click above it, or a large embedded attachment will hang the tab mid-demo.

### `DocumentReference` itself

Element facts from <https://hl7.org/fhir/R4/documentreference.html> and the R4 profile:
`status` `1..1` (`current | superseded | entered-in-error`), `docStatus` `0..1`
(`preliminary | final | amended | entered-in-error`), `type` `0..1`, `category` `0..*`,
`subject`, `date` (`instant`), `author` `0..*`, `custodian`, `description`
("Human-readable description of the source document"), `relatesTo` `0..*`
(`code`: `replaces | transforms | signs | appends`, plus a `target` Reference),
`content` **`1..*`** with `content.attachment` `1..1`, and `context` `0..1`
(`encounter`, `event`, `period`, `facilityType`, `practiceSetting`, `sourcePatientInfo`, `related`).

Two things the render must get right:

- **`content` is `1..*`**, not `1..1`. Multiple `content` entries are *the same document in
  different formats* (a PDF and a CDA of the same discharge summary). Render them as a format
  switcher on one card, not as two documents. Getting this wrong doubles every document in the list.
- **`content.format`** is defined as "An identifier of the document encoding, structure, and
  template that the document conforms to beyond the base format indicated in the mimeType", bound
  `preferred` to `http://hl7.org/fhir/ValueSet/formatcodes` (binding name `DocumentFormat`). In the
  wild it is usually an IHE format code. Render it as a chip with the raw
  `system|code` in the tooltip, and never suppress it: `format` is what tells a receiver that an
  `application/xml` attachment is a CDA CCD rather than arbitrary XML, and a missing `format` on an
  XML attachment is a legitimate `info` finding.

Card layout: `type.text` (or the coding display) as the title, `description` as the subtitle,
then chips for `status`, `docStatus`, `date`, `custodian`, then the attachment strip
(one chip per `content`, showing `contentType` + `format` + size), then the preview, then
`context` and `relatesTo` in a collapsed detail block. `relatesTo` must render as a resolved chip
through the same three-outcome resolver as everything else: a `replaces` pointing at a document not
in the bundle is normal and should say so, not error.

### `Binary`

Elements (R4): `contentType` (`1..1`, "MimeType of the binary content"), `securityContext` (`0..1`,
a "Reference to another resource for access control proxy"), `data` (`0..1`, base64).

The behaviour a viewer must understand, from <https://hl7.org/fhir/R4/binary.html>:

> "When a read request is made with a FHIR type in the Accept header … the Binary resource is
> returned in the requested FHIR format."

> "The Binary resource is always represented in the native FHIR format when wrapped in a Bundle."

> "This specification does not support searching on Binary resources"

Two consequences. First, **inside an SHL payload a `Binary` is always the JSON form**, so `data` is
there and no fetch is required: render it exactly like an `Attachment` with `contentType` + `data`,
reusing the same preview component. Second, if a `DocumentReference.content.attachment.url` points
at a `Binary/[id]` endpoint, an explicit fetch must set `Accept` to the *content* type, not
`application/fhir+json`, or the server returns the JSON wrapper and the preview shows a base64
string. Surface `securityContext` when present, because it is the resource whose access rules govern
the bytes, and a `Binary` shipped in an SHL with a `securityContext` pointing outside the bundle is
worth an `info` note.

## B5. The unknown-resource fallback

Every payload contains a type nobody planned for, and the fallback is what separates a tool people
trust from a demo. The requirement: **generic, but not a `<pre>{JSON.stringify(r, null, 2)}</pre>`.**

Design: a **typed key/value tree**, driven by the shape of the data, with FHIR-aware value
formatters. No StructureDefinition needed, no schema download, works offline.

```
┌ ServiceRequest ──────────────────────── urn:uuid:8f3a…c21 ⧉ ── JSON ▸ ─┐
│  status              active                                            │
│  intent              order                                             │
│  category            ▸ CodeableConcept  Imaging (SNOMED 363679005)     │
│  code                ▸ CodeableConcept  Chest X-ray (LOINC 36643-5)    │
│  subject             → Patient/mia-banks  "Mia Banks"          [resolved]
│  authoredOn          14 Aug 2026                     (2026-08-14)      │
│  requester           → urn:uuid:1c2d…    "Dr A. Chen"          [resolved]
│  reasonCode          ▸ 1 item                                          │
│  note                ▸ 1 Annotation                                    │
│  ▸ meta                                                                │
│  ▸ 2 extensions                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

Rules that make it not-ugly:

1. **Order is derived, not alphabetical, and not JSON order.** A fixed priority list first
   (`status`, `code`, `category`, `subject`/`patient`, the `effective[x]`/`onset[x]`/`performed[x]`
   date family, `value[x]`, `performer`, `note`), then everything else in JSON order, then
   `meta`/`text`/`extension`/`modifierExtension`/`id` last, always collapsed. Alphabetical order puts
   `abatementDateTime` above `code`, which is how every generic FHIR renderer ends up looking
   machine-generated.
2. **Datatype-aware leaf formatters, about twenty of them**, and this is the whole trick:
   - `CodeableConcept` → `text` if present, else the first coding's `display`, else `system|code`.
     Show the code as a mono chip. Never show a bare code as the primary text.
   - `Coding` → same, single.
   - `Reference` → resolved chip via B3's three-outcome resolver, with `display` as fallback.
   - `Quantity` / `Ratio` / `Range` → `value unit` with the UCUM code in a tooltip when `unit`
     differs from `code`.
   - `Period` → "14 Aug 2026 to 20 Aug 2026", or "from 14 Aug 2026" when `end` is absent.
   - `dateTime` / `date` / `instant` → localised human form, with the **raw ISO string in a tooltip
     and in the copy value**. Never destroy the wire format: this is a debugger.
   - `HumanName` → `text`, else `given` + `family` with `use` as a chip.
   - `Identifier` → `system|value` with `type` and `use` chips; recognise IHI
     (`http://ns.electronichealth.net.au/id/hi/ihi/1.0`) and Medicare and label them.
   - `Annotation` → the text as prose, with author and time as a caption.
   - `Attachment` → the B4 component, recursively.
   - `boolean` → "Yes"/"No" plus the raw, never a bare checkbox.
   - `code` → the code in mono, plus a friendly-cased version when it is a known enum.
   - Arrays → collapsed with a count ("▸ 3 items"), auto-expanded when count is 1.
   - `extension` → grouped, each keyed by its `url`'s last segment, with the full URL on hover.
     Never render `extension` inline in the main list.
3. **`urn:uuid` handling.** Show a shortened form (`urn:uuid:8f3a…c21`) with a copy button for the
   full value. Full UUIDs in a key/value list destroy the column rhythm; truncating without a copy
   affordance destroys the tool's usefulness.
4. **Empty and absent are different.** Render `dataAbsentReason` and `_element.extension`
   primitive extensions explicitly ("Unknown (data absent: unknown)"), never as blank. This matters
   for AU PS, which mandates elements AU Core leaves optional, so a data-absent-reason is the
   conformant answer and must not look like a gap.
5. **The JSON escape hatch is always one click away**, top-right of every card, and it opens the
   *scoped* JSON for that resource with a copy button, not the whole bundle.
6. **The card header carries the type and the identity**: `ResourceType` in `h3` sans, then the
   `fullUrl` or `id` in mono `small` with a copy button. That header is what someone reads out loud
   across a table.

This same component *is* the debug view for known types too. Every specific renderer gets a
`Rendered | Fields | JSON` toggle where `Fields` is this tree. That is one component doing double
duty and it removes any temptation to leave a type unhandled.

## B6. Libraries: use, avoid, and why

All versions, sizes and dates read from the npm registry on 2026-08-20.

| Package | Latest | Published | Unpacked | Verdict |
|---|---|---|---|---|
| `@types/fhir` | `0.0.44` | (MIT) | small, types only | **Use.** 246k weekly downloads, the de facto R4 typing. Zero runtime cost. |
| `@medplum/fhirtypes` | `5.1.30` | 2026-08-13 | 2679 KB | **Alternative.** Apache-2.0, no deps, actively versioned, 148k weekly. Types only, so the unpacked size never ships. Pick this if you want per-release type churn tracked; pick `@types/fhir` if you want the ecosystem default. |
| `dompurify` | `3.4.14` | 2026-08-19 | 1760 KB | **Use, mandatory.** Zero dependencies, MPL-2.0 OR Apache-2.0, 50M weekly. Narrative and CDA sanitisation. There is no defensible alternative. |
| `fhirpath` | `5.1.1` | 2026-08-05 | 4337 KB | **Use, but lazy-loaded only.** The HL7 reference engine. Pulls `antlr4`, `decimal.js`, `js-yaml`, `commander`, `@lhncbc/ucum-lhc`. Needs the model file (`fhirpath/fhir-context/r4`) or choice types and `ofType()` break: `evaluate(resource, expr, envVars, model, options)`. Put it behind a dynamic `import()` for the FHIRPath drawer; never in the initial chunk. |
| `pdfjs-dist` | `6.2.108` | 2026-07-28 | 33689 KB | **Avoid by default.** Use `<embed type="application/pdf">` with an object URL. Only lazy-load pdf.js behind an explicit "advanced PDF view" if text extraction is genuinely wanted. |
| `@aehrc/smart-forms-renderer` | `1.4.0` | 2026-07-03 | 3196 KB | **Use only for `Questionnaire` / `QuestionnaireResponse`, lazy-loaded.** It bundles `@mui/icons-material`, `@emotion/react`, `@emotion/styled`, `@fontsource/inter`, `@fontsource/roboto`, `@fontsource/material-icons`, so importing it drops a second design system and three font families into your bundle. Isolate it behind a dynamic import and a route, or do not use it. For an SHL viewer a QuestionnaireResponse is more honestly rendered by the B5 generic tree plus item-linkId grouping. |
| `fhir-kit-client` | `2.0.3` | 2026-07-27 | 132 KB | **Avoid.** Depends on `agentkeepalive`, a Node HTTP agent. It is a server-side client, and we are a static site making one POST and N GETs. Use `fetch` directly: the trace *is* the HTTP layer, so wrapping it in a client library is actively counterproductive. |
| `fhir-react` | `2.1.1` | 2026-04-20 | 3108 KB | **Avoid.** Dependencies include `bootstrap`, `marked`, `@nivo/core` and `@nivo/pie`. A whole CSS framework and a charting library, and the visual language is not ours. Read it for ideas on per-type field selection, do not ship it. |
| `@medplum/react` | `5.1.30` | 2026-08-13 | 4591 KB | **Avoid unless you adopt Mantine.** Peer-depends on `@mantine/core`, `@mantine/hooks`, `@mantine/notifications`, `@mantine/spotlight`. Its `ResourceTable` and `ResourcePropertyDisplay` are the best open-source prior art for B5's generic tree and are worth studying closely; taking the dependency means taking Mantine and losing the design system in A2. |
| `fhir` (the bare name) | `4.12.0` | **2023-08-07** | 8548 KB | **Avoid.** Three years stale, depends on `q`, `randomatic` and a `path` shim. Do not introduce it. |
| `jsonata` | `2.2.2` | n/a | n/a | **Avoid for FHIR paths.** 1.3M weekly downloads and a fine language, but the FHIR ecosystem's path language is FHIRPath, connectathon participants speak FHIRPath, and a teaching tool must speak the room's language. `jsonata` earns a place only if you add a payload-transformation playground, which is a different product. |
| `marked` | `18.0.10` | 2026-08-18 | 459 KB | **Optional.** Only if you author the per-step explanation prose in Markdown, which is a good idea. Render at build time, not runtime, and sanitise anyway. |

Non-library primitives that replace dependencies: `crypto.subtle` for SHA-1 attachment hashes,
SHA-256, ECDSA P-256 verification (SHC JWS) and AES-GCM decryption (the JWE); `DecompressionStream('deflate-raw')`
for the SHC payload; `XSLTProcessor` for CDA; `URL.createObjectURL` for previews and downloads. A
fully client-side SHL viewer needs remarkably little beyond the platform, and every dependency
avoided is one less thing to explain when someone asks what the tool sends where.

## B7. Component inventory

Fifteen renderers, plus the generic fallback, cover the twenty-four IPS/AU PS entry types and the
Platypus payload shapes. Each entry lists the types it owns and the one thing it must get right.

| # | Component | Owns | The thing it must get right |
|---|---|---|---|
| 1 | `DocumentShell` | `Composition`, `Bundle` | Profile-order sections (B1), `section.title` as heading, per-section `Structured \| Narrative` toggle, `emptyReason` as a statement |
| 2 | `PatientBanner` | `Patient` | Name, DOB with computed age, sex/gender distinction, identifiers with IHI/Medicare labelled, address. This is the only always-present card and the one clinicians look at first |
| 3 | `ConditionRow` | `Condition` (problems, past problems, functional status) | `clinicalStatus` and `verificationStatus` as separate chips, the `onset[x]`/`abatement[x]` choice, and `category` distinguishing problem-list-item from encounter-diagnosis |
| 4 | `AllergyRow` | `AllergyIntolerance` | `criticality` versus `clinicalStatus` versus `type` versus `category` (four different axes people conflate), and `reaction[].manifestation` as a nested list |
| 5 | `MedicationRow` | `MedicationStatement`, `MedicationRequest`, `MedicationAdministration`, `MedicationDispense`, `Medication` | The `medication[x]` choice (`medicationCodeableConcept` versus `medicationReference` to a contained or bundled `Medication`) resolved in **one** place, plus `dosage`/`dosageInstruction` rendered as readable text |
| 6 | `ObservationRow` | `Observation`, all seven IPS slices | The `value[x]` choice across `Quantity`/`CodeableConcept`/`string`/`boolean`/`Ratio`/`SampledData`, plus `component[]` for BP, plus `referenceRange` and `interpretation`, plus the vital-signs-versus-lab presentation split |
| 7 | `DiagnosticReportCard` | `DiagnosticReport` | `result[]` resolved to `ObservationRow`s nested inside the report, `conclusion`, `presentedForm` as an `Attachment` (a report whose real content is a PDF is common and must not render as empty) |
| 8 | `ProcedureRow` | `Procedure` | The `performed[x]` choice, `status`, `bodySite`, and `outcome` |
| 9 | `ImmunisationRow` | `Immunization`, `ImmunizationRecommendation` | `vaccineCode`, `occurrence[x]`, `protocolApplied.doseNumber[x]`, `lotNumber`, and Australian spelling in the label |
| 10 | `DeviceRow` | `DeviceUseStatement`, `Device` | Resolving `device` to the bundled `Device`, and `timing[x]` |
| 11 | `DocumentCard` | `DocumentReference` | Everything in B4: `content` as `1..*` format switcher, `format` chip, `data`/`url` four-state, preview, verified download |
| 12 | `AttachmentPreview` | `Attachment`, `Binary` | Sniff-versus-declared type, `att-1`, SHA-1 `hash` verification, size check, PDF/image/CDA/hex routing, object-URL lifecycle |
| 13 | `ActorChip` | `Practitioner`, `PractitionerRole`, `Organization`, `RelatedPerson` | One chip shape for every "who", resolved through the B3 resolver, degrading to `Reference.display` and then to "not in this payload" |
| 14 | `PlanCard` | `CarePlan`, `Consent`, `Flag`, `ClinicalImpression`, `Goal`, `CareTeam` | Rendering `activity`/`provision`/`finding` as linked items through the resolver rather than as raw references, and never inventing a tap-through to a record the payload does not carry |
| 15 | `SpecimenChip` | `Specimen`, `ImagingStudy` | Collection time and body site; these appear as supporting detail inside 6 and 7, not as top-level cards |
| 16 | `ResourceTree` | anything unmatched, and the `Fields` tab of all fifteen above | Everything in B5: derived order, twenty datatype formatters, three-outcome references, `urn:uuid` truncation with copy, data-absent-reason rendering |

Notes on the shape of this list. Numbers 6 and 11 are where the effort goes: `Observation` is over
half the entries in a typical summary, and `DocumentReference` is legal in fifteen of sixteen
sections. Number 13 exists because "who" appears in a dozen different elements across a dozen types,
and building it once is what keeps the other fourteen small. Number 16 is not a fallback in the
apologetic sense: it is a first-class component that every other component uses as its own debug
view, which is why it must be beautiful.
