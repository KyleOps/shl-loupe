// @ts-check
/**
 * Flat config, type-aware.
 *
 * `npm run lint` runs with `--max-warnings 0`, so there is no such thing here as
 * a warning: anything switched on has to pass. That is deliberate. A lint list
 * with 40 tolerated warnings in it is a list nobody reads, and this project's
 * whole thesis is that a message nobody reads is the same as no message.
 *
 * Two notes on what is NOT here.
 *
 * ESLint 10 no longer pulls `@eslint/js` in as a transitive dependency, so
 * `js.configs.recommended` is not resolvable without adding a devDependency.
 * The core rules this project actually cares about are therefore named
 * explicitly below, which is more honest anyway: every rule in this file was
 * chosen, not inherited. (Adding `@eslint/js` and `globals` would let the first
 * block collapse to two lines, if someone wants that trade.)
 *
 * The two project-specific rules at the bottom are `no-restricted-syntax`
 * selectors rather than a bespoke plugin. A plugin is the right answer once a
 * rule needs to reason about types or scope; these two only need to recognise a
 * shape, and a selector keeps them readable by the next person in the same file
 * as the reason they exist.
 */
import { defineConfig, globalIgnores } from 'eslint/config';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

/**
 * Colours come from `src/styles/tokens.css`, always. A hex literal in a
 * component is invisible to the theme, so it survives the light/dark swap and
 * the Projector token override by simply ignoring both, which is exactly the
 * failure that is hardest to notice in review: it looks right in whichever mode
 * the author had open.
 *
 * The lookbehind is load bearing. Without it this matches the HTML entities in
 * the narrative-sanitiser tests (`&#115;`, `&#169;`), which are not colours.
 * The lengths are enumerated rather than written `{3,8}` for the same reason: a
 * run of five or seven hex digits is not a colour either, and `#160245001` in a
 * SNOMED CT URI must not trip it.
 */
const NO_HARDCODED_COLOUR = [
  {
    selector:
      'Literal[value=/(?<![&\\w])#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})(?![0-9a-fA-F])/]',
    message:
      'Colours come from tokens, never a hex literal. Use var(--tone-fg) / var(--tone-bg) via a tone-* class, or a token from src/styles/tokens.css.',
  },
  {
    selector:
      'TemplateElement[value.raw=/(?<![&\\w])#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})(?![0-9a-fA-F])/]',
    message:
      'Colours come from tokens, never a hex literal. Use var(--tone-fg) / var(--tone-bg) via a tone-* class, or a token from src/styles/tokens.css.',
  },
  {
    selector: 'Literal[value=/(?:rgba?|hsla?)\\s*\\(/]',
    message:
      'Colours come from tokens, never an rgb()/hsl() literal. A status colour and its tinted surface travel together through the tone-* classes.',
  },
  {
    selector: 'TemplateElement[value.raw=/(?:rgba?|hsla?)\\s*\\(/]',
    message:
      'Colours come from tokens, never an rgb()/hsl() literal. A status colour and its tinted surface travel together through the tone-* classes.',
  },
];

/**
 * Every request goes through `Transport` in `src/core/net/`.
 *
 * This is the guarantee the privacy claim rests on: the tool promises that every
 * request it makes appears in the trace, and that promise is structural only
 * while there is exactly one place a request can be made from. A bare `fetch`
 * anywhere else is a request that happened without a trace step, which is both a
 * silent hole in the diagnosis and a claim in the README that is no longer true.
 */
const NO_BARE_FETCH = [
  {
    selector: 'CallExpression[callee.name="fetch"]',
    message:
      'Requests go through Transport in src/core/net, so that every request appears in the trace. Take a Transport rather than calling fetch here.',
  },
  {
    selector: 'CallExpression[callee.property.name="fetch"]',
    message:
      'Requests go through Transport in src/core/net, so that every request appears in the trace. Take a Transport rather than calling window.fetch here.',
  },
];

export default defineConfig(
  globalIgnores([
    'dist/**',
    'coverage/**',
    'node_modules/**',
    // Captured evidence and one-off probe scripts. They are Node programs kept
    // verbatim as the record of what a browser actually did, so reformatting
    // them to this project's rules would falsify them.
    'research/**',
  ]),

  // Type-aware from the start. `strictTypeChecked` is the point of using
  // typescript-eslint at all: the rules that need types (floating promises,
  // unnecessary conditions, unsafe any flow) are the ones a reviewer cannot
  // reliably catch by reading.
  //
  // `stylisticTypeChecked` is deliberately NOT extended. Prettier owns
  // formatting, and the four rules in that set which fire here all contradict a
  // deliberate convention: `non-nullable-type-assertion-style` wants `!` where
  // this codebase writes an explicit cast under noUncheckedIndexedAccess,
  // `dot-notation` wants `payload.url` where the brackets quote a spec member
  // name, and `array-type` has an opinion about `Array<T>` that nothing here
  // shares. Enabling it produced 117 errors, none of which were defects.
  tseslint.configs.strictTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        // projectService reads tsconfig.json rather than a hand-maintained
        // list, so a new directory is linted the moment tsc sees it.
        projectService: {
          // Two files tsconfig cannot supply a program for, and they fail as a
          // parse error rather than as a missing-types warning, so they have to
          // be named. vitest.integration.config.ts is outside tsconfig's
          // `include` on purpose (it is not part of the app). This file is
          // inside it, but `allowJs` is off, so TypeScript never picks it up.
          allowDefaultProject: ['vitest.integration.config.ts', 'eslint.config.js'],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Named explicitly rather than inherited: see the header note.
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error',
      'object-shorthand': ['error', 'always'],
      'no-else-return': ['error', { allowElseIf: false }],
      'no-implicit-coercion': ['error', { boolean: false }],
      'no-debugger': 'error',
      'no-alert': 'error',
      // console.warn/error are how a browser quirk gets reported to whoever has
      // devtools open; console.log is left-behind debugging.
      'no-console': ['error', { allow: ['warn', 'error'] }],

      /**
       * Spreading a string is allowed on purpose.
       *
       * The rule's concern is that `[...text]` iterates code points and so splits
       * a composed emoji or an Indic cluster. Every string spread in this
       * codebase iterates a protocol token whose characters the specifications
       * define as ASCII: an SHL flag string ("single-character flags in
       * alphabetical order"), a base64url payload, the digits of a numeric health
       * card QR. Rewriting those as indexed loops would obscure the intent and
       * buy nothing, and where the distinction genuinely mattered (the SHC
       * numeric encoder, which is defined over UTF-16 code units) the code says
       * so and uses charCodeAt.
       *
       * Displaying a hostile flag string that does contain an emoji is a feature:
       * the tool should show what arrived, and code-point iteration keeps the
       * character whole while doing it.
       */
      '@typescript-eslint/no-misused-spread': ['error', { allow: ['string'] }],

      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      // Worth its noise: a `?? fallback` on something that can never be nullish
      // is usually a defensive habit left over from a shape that has since been
      // narrowed, and reading it costs the next person a trip to the type. The
      // option only exempts the `while (true)` form.
      '@typescript-eslint/no-unnecessary-condition': [
        'error',
        { allowConstantLoopConditions: true },
      ],
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],
      // `onClick={() => setOpen(true)}` is the React idiom, and the rule's real
      // target (a function whose caller reads a value that is actually void) is
      // still caught in the non-shorthand form.
      '@typescript-eslint/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true }],
      // A step body is declared `async` for signature uniformity with the ones
      // that do await: `Recorder.run` accepts `Promise<T> | T`, and a body that
      // changes its own signature when its last await is removed is a worse
      // seam than an async function with nothing to wait for.
      '@typescript-eslint/require-await': 'off',
      // The stores' actions are closures on a plain object, not methods on a
      // class, so `this` never applies to them. `useSettings((s) => s.setTheme)`
      // is the zustand idiom and this rule cannot tell it apart from pulling a
      // method off a prototype.
      '@typescript-eslint/unbound-method': 'off',
    },
  },

  // React: the compiler-era rule set, which catches the mutation-during-render
  // and set-state-in-effect classes that a hooks-only config never saw.
  {
    files: ['src/**/*.tsx'],
    // `configs.flat[...]`, not `configs[...]`: the top-level names in this
    // plugin are still eslintrc-shaped (a `plugins` array), and flat config
    // rejects them with a migration-guide wall of text rather than a hint.
    extends: [reactHooks.configs.flat['recommended-latest']],
    rules: {
      // Shipped as a warning upstream. Under --max-warnings 0 a warning is a
      // failure anyway, so calling it a warning here would only mislead.
      'react-hooks/exhaustive-deps': 'error',
    },
  },

  // Project rule 1: every request goes through Transport.
  //
  // The seam is exempted with `ignores` on this object rather than with a later
  // override, because ESLint merges `no-restricted-syntax` options positionally:
  // a later `['error']` with no selectors keeps the ones already there, so the
  // override reads as an exemption and silently is not one. Verified with
  // `eslint --print-config src/core/net/transport.ts`.
  {
    files: ['src/**/*.{ts,tsx}', 'test/**/*.ts'],
    ignores: ['src/core/net/**'],
    rules: { 'no-restricted-syntax': ['error', ...NO_BARE_FETCH] },
  },

  // Project rule 2: colours come from tokens. Scoped to the layers that render,
  // because those are the files where a hex literal is plausible.
  {
    files: ['src/ui/**/*.{ts,tsx}', 'src/app/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-syntax': ['error', ...NO_BARE_FETCH, ...NO_HARDCODED_COLOUR],
    },
  },

  // Tests assert on shapes that are `unknown` by design (a decoded payload, a
  // parsed manifest), and a test that has to satisfy the unsafe-any rules ends
  // up asserting less than it should.
  {
    files: ['**/*.test.ts', '**/*.test.tsx', 'test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unnecessary-condition': 'off',
    },
  },

  // Build and lint configuration run in Node, not in the browser bundle.
  {
    files: ['*.config.ts', 'eslint.config.js'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },
);
