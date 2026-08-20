/**
 * Every class name the markup writes has a rule behind it.
 *
 * This test exists because the same defect has now happened three times, and it
 * is the quietest one in the app: a component is written with a full set of class
 * names, the stylesheet for it is never added, and nothing goes wrong. No error,
 * no warning, no red. The markup is correct, the state is correct, the
 * accessibility tree is correct, and the screen is just wrong in a way that reads
 * as bad design rather than as a missing file.
 *
 * The three:
 *  - `overlay.css` was missing, so the command palette laid out as a 640px block
 *    in the middle of the page instead of covering it, and the settings dialog
 *    injected a section into the masthead.
 *  - `chrome.css` was missing, so the masthead, the link field and the tab strip
 *    rendered as a stack of unstyled inline content.
 *  - `workbench.css` was missing, which cost the most: the entire three-pane
 *    layout of the main screen, including both breakpoints and the
 *    widths-follow-the-verdict rule, was computed in TypeScript and thrown away.
 *    A trace step's metrics sat a thousand pixels from the step they measured,
 *    and no payload was ever beside a trace. That is the layout the screen was
 *    designed around, and it had never once rendered.
 *
 * A browser test cannot catch this class of defect in general: it can only assert
 * about the screens it thinks to look at, and an unstyled block looks like a
 * design choice unless you already know what it should have been. Reading the
 * markup for names that no stylesheet knows about does catch it, everywhere, in
 * milliseconds.
 *
 * Scope, deliberately narrow so it stays honest:
 *  - Only literal class names, from `className="..."` and from the string
 *    arguments to `clsx(...)`. A name built at runtime (`pane-${id}`) is out of
 *    reach and is not worth a parser.
 *  - A name counts as covered if any stylesheet mentions it as a class anywhere,
 *    in any selector. This is not a check that the rule is CORRECT, only that
 *    somebody wrote one. A wrong rule is what the browser pass and the eye are
 *    for.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('../..', import.meta.url).pathname;
const SOURCE = join(ROOT, 'src');
const STYLES = join(SOURCE, 'styles');

/**
 * Names that are in the markup on purpose with no rule of their own.
 *
 * Each entry needs a reason. "It looked fine" is not one: if a name needs no
 * rule, the usual answer is that it needs no name either.
 */
const UNSTYLED_ON_PURPOSE = new Map<string, string>([
  [
    'prose',
    'Marks a block of reading text for the sibling-spacing rule in app.css, which is written as `.prose > * + *` and so does not mention `.prose` as a plain class.',
  ],
]);

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? walk(path) : [path];
  });
}

function stylesheetText(): string {
  return readdirSync(STYLES)
    .filter((file) => file.endsWith('.css'))
    .map((file) => readFileSync(join(STYLES, file), 'utf8'))
    .join('\n');
}

/** Every literal class name written in the components, with where it came from. */
function classNamesInMarkup(): Map<string, Set<string>> {
  const found = new Map<string, Set<string>>();
  const record = (name: string, file: string): void => {
    if (!/^[a-z][a-z0-9-]*$/.test(name)) return;
    const where = found.get(name) ?? new Set<string>();
    where.add(file.slice(ROOT.length));
    found.set(name, where);
  };

  for (const file of walk(SOURCE)) {
    if (!file.endsWith('.tsx')) continue;
    if (file.endsWith('.test.tsx')) continue;
    const source = readFileSync(file, 'utf8');

    // className="a b c" and className={'a b c'}
    for (const match of source.matchAll(/className=\{?['"`]([^'"`{}]+)['"`]/g)) {
      for (const name of (match[1] ?? '').split(/\s+/)) record(name, file);
    }
    // clsx('a', condition && 'b', ...): take every quoted string inside the call,
    // minus the operands of a comparison. `size === 'sm' && 'btn-sm'` contributes
    // `btn-sm` and not `sm`, and reading both was this test's own first false
    // positive.
    for (const call of source.matchAll(/clsx\(([\s\S]*?)\)/g)) {
      const body = (call[1] ?? '').replace(/[=!]==?\s*'[^']*'/g, '');
      for (const literal of body.matchAll(/'([^']+)'/g)) {
        for (const name of (literal[1] ?? '').split(/\s+/)) record(name, file);
      }
    }
  }
  return found;
}

describe('the stylesheets cover the markup', () => {
  it('has a rule for every class name a component writes', () => {
    const css = stylesheetText();
    const orphans: string[] = [];

    for (const [name, files] of [...classNamesInMarkup()].sort()) {
      if (UNSTYLED_ON_PURPOSE.has(name)) continue;
      // Any selector mentioning it counts: `.name`, `.a .name`, `.name[attr]`,
      // `.name:hover`, `.parent > .name`.
      if (new RegExp(`\\.${name}(?![\\w-])`).test(css)) continue;
      orphans.push(`${name} (used in ${[...files].join(', ')})`);
    }

    expect(
      orphans,
      'these class names have no rule in any stylesheet: either style them, or drop the name',
    ).toEqual([]);
  });

  it('keeps the deliberate exceptions honest', () => {
    // An entry that is no longer used in the markup is stale, and a stale
    // allowlist is how the next missing stylesheet gets waved through.
    const used = classNamesInMarkup();
    for (const name of UNSTYLED_ON_PURPOSE.keys()) {
      expect(used.has(name), `${name} is allowlisted but no longer in the markup`).toBe(true);
    }
  });

  it('finds the markup at all', () => {
    // A path change that quietly stopped the walk from matching anything would
    // make this whole file pass while checking nothing.
    const found = classNamesInMarkup();
    expect(found.size).toBeGreaterThan(200);
    expect(found.has('workbench')).toBe(true);
    expect(stylesheetText().length).toBeGreaterThan(50_000);
  });
});
