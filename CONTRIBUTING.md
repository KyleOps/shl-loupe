# Contributing to SHLoupe

## Running it

```sh
pnpm install
pnpm dev              # http://localhost:5173
```

Four gates, and all four have to pass before a change is done:

```sh
pnpm typecheck        # tsc --noEmit, strict, exactOptionalPropertyTypes, noUncheckedIndexedAccess
pnpm lint             # eslint, --max-warnings 0
pnpm test             # vitest run, offline only
pnpm build            # typecheck, then a static bundle in dist/
```

`pnpm run test:live` is separate on purpose. It talks to the implementation
guide's own example links over the real network, so it fails when the venue wifi
does, and a suite that goes red for reasons outside the change under review is a
suite people learn to ignore. Run it deliberately, before a release.

The two type settings in that first command shape how you write. Under
`exactOptionalPropertyTypes`, passing a maybe-absent value to a `?: T` prop needs
a conditional spread (`...(x === undefined ? {} : { x })`); under
`noUncheckedIndexedAccess`, an indexed read needs a guard or a cast. Presentational
props in `src/ui/primitives.tsx` are declared `T | undefined` rather than `?: T`
precisely so callers do not have to do the first of those for a prop where
"absent" and "undefined" mean the same thing on screen.

## The rules that matter

**The trace is data, not closures.** A `TraceRun` is a plain serialisable record:
steps, evidence, findings, timings. That is what makes "copy this diagnosis into
chat" possible and a run replayable in a test with no network. So a step records
what it saw by calling `note`/`kv`/`request`/`response`/`cite` on its
`StepHandle`, never by holding a callback the UI later invokes, and never by
stringifying an exception as its primary message.

**Nothing reaches the network without a trace step.** Every request goes through
`Transport` (`src/core/net/transport.ts`). Offline mode and the tests supply a
different `Transport` and take the same code path as a real fetch, which is the
whole reason the pipeline is testable. A lint rule fails a bare `fetch(` written
anywhere outside `src/core/net`, because the privacy claim in the README is only
structural while there is exactly one place a request can be made from.

**Redaction happens at the export boundary, once.** Secrets are _registered_ with
the `Redactor`, not stripped on the way in: the run holds the truth, because the
person looking at it is holding the link and is entitled to see their own key.
`redactRun` is what "Copy diagnosis" and "Share report" serialise, and the UI
masks with `Secret`. An earlier design redacted on write and leaked the key in the
one step that recorded a payload before the key had been registered, which is the
failure this shape exists to make impossible.

**No request the user did not ask for.** Not on mount, not to warm a cache, not to
resolve a code. The reachability and DNS probes are opt-in, and the DNS one
specifically because it reaches a third-party resolver. A wrong passcode is
charged against a lifetime limit that permanently disables somebody's link, so a
run is never a side effect of rendering: `useRunner` is called from an explicit
submit, or exactly once for a link that arrived in the fragment.

**Colours come from tokens.** Read them from `src/styles/tokens.css`, and take a
status colour together with its tinted surface through a `tone-*` class
(`var(--tone-fg)` / `var(--tone-bg)`). A hex literal in a component survives the
light/dark swap and the Projector override by ignoring both, which is the hardest
kind of mistake to see in review: it looks right in whichever mode the author had
open. Lint fails one in `src/ui` or `src/app`. Status is never colour alone
either: an icon whose silhouette differs, plus a word, both of which
`StatusIcon` gives you.

Two more, briefly. Wide content scrolls in its own `.scroll-x` container, never
the page. Copy buttons are in the DOM and focusable, never revealed on hover,
because hover reveal is unusable on touch, with a screen reader, and when somebody
else is driving the laptop.

## Adding a rule

`src/core/diagnose/rules.ts`, as an entry in `STATIC_RULES`: a pure function of a
`DiagnosisContext`, returning a `Finding` or `undefined`. The `ruleId` is stable
and quotable because reports cite it. `severity: 'fatal'` stops the run, so use it
only when nothing further can usefully be attempted. `audience` names who has to
act, which is the point of the whole tool. Then assert the specific input in
`src/core/diagnose/rules.test.ts`.

If the rule needs a network observation, it is not a static rule. Put the
observation in the step that made it and raise the finding from there.

## Adding a renderer

Purpose-built FHIR renderers live in `src/ui/fhir/renderers/`, take
`RendererProps` (declared in `src/ui/fhir/ResourceCard.tsx`), and go into
`RESOURCE_RENDERERS` in `src/ui/fhir/registry.tsx`, keyed by `resourceType`. The
props type lives with the card rather than with the registry so that a renderer
never imports the registry that registers it, which is what keeps the module graph
a tree.

Build rows with `DetailTable`, not `FieldTable` directly: it flips the monospace
default, which is right for a JWE segment and wrong for a medicine name. Read
values through the helpers in `src/ui/fhir/display.ts` (`strField`, `pickChoice`,
`renderableDate`, `codeableConcept`) rather than indexing raw JSON, because those
already handle FHIR's date precision and choice-element messes.

Never silently drop a resource. A type with no purpose-built renderer falls
through to `UnknownResource`, which shows it as fields and raw JSON. That is
deliberate: "we did not render this" and "there was nothing here" are different
facts, and the incumbent viewer conflates them.

## Adding a fixture or a broken preset

**A fixture** is a sample the tool can open with no network: add it to the
catalogue in `src/fixtures/index.ts`. Say what it is in `description` and what it
is _for_ in `teaches`, and set `kind` from the pipeline's own `FileKind`
vocabulary, so the test suite can check the claim against `classifyContent`
instead of trusting a label. Nothing in there may be confidential: these get
projected onto a wall.

**A broken preset** is a deliberately invalid link, for testing somebody else's
viewer. Add it to `BROKEN_PRESETS` in `src/core/mint.ts`. A preset is not just a
bad payload: `wrong` says what is wrong with it, `receiverShould` says what a
conformant receiver ought to do about it, and `expect` names the `ruleIds` SHLoupe
itself must raise, which file the check lives in, and the outcome. That last part
is what stops the catalogue drifting away from the diagnosis engine, so fill it in
even when it is obvious, and use `gap` when SHLoupe does not yet catch its own
preset. `build` returns canned `responses` you can hand to `OfflineTransport`, so
every preset is reproducible with no server at all.

## Prose

Australian English. No em dashes or en dashes. Plain and specific, and it names
who has to act: this tool exists because the incumbent renders "TypeLoad failed"
and the sender concludes their link is fine. A capability is never dressed up as a
verdict, either. "SHLoupe cannot finish this" and "this link is broken" are
different sentences, and conflating them is the bug we are here to fix.

Comments explain _why_. A comment restating the line above it is noise; one
recording the trap the obvious implementation walks into is why the file is
readable in six months.
