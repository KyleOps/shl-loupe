/**
 * Measure the typography instead of guessing at it.
 *
 * Why this exists, and why it is committed rather than being a throwaway: the
 * app's reading measure was wrong for weeks, by three quarters, and no amount of
 * looking at the screen found it. `--measure` was set to `74ch` in the belief
 * that `ch` is a character. It is the advance of the digit zero, which in this
 * face is about 1.4 times the average letter, so every column in the app was set
 * to roughly 105 characters. Two rounds of fixing individual containers only
 * moved the symptom around, because the number they were all being fixed against
 * was itself the defect.
 *
 * What settled it was measuring: render each screen, find the longest laid-out
 * line in every block of prose, and divide by the average character advance of
 * the font at that block's own size. Both halves matter. Counting in `ch`
 * understates the real line by 40%, and assuming a per-size ratio hides that a
 * 12.5px note inside a card sized for 16px runs 25 characters longer than the
 * card was designed for.
 *
 * It reports two things, which are the two ways a measure goes wrong:
 *
 *   LONGEST LINE, in characters, per screen. Comfortable reading is 45 to 85,
 *   and anything past about 90 is the wall of text a reader loses their place in.
 *
 *   CUT SHORT: a block of prose ending well inside a container that has a
 *   visible edge, with nothing wide in that container to explain the width. That
 *   is the other failure, and it looks like truncation rather than like a column.
 *
 * Run it against a dev server:
 *
 *   pnpm dev --port 5199
 *   pnpm measure                     # or BASE=http://localhost:4173 pnpm measure
 *
 * The permanent guard for the second half lives in test/browser/app.spec.ts, so
 * a regression fails a test rather than waiting for someone to run this. This
 * tool is for the numbers, which a pass/fail cannot give you.
 */
import { chromium } from '@playwright/test';

const BASE = process.env.BASE ?? 'http://localhost:5199';

/** The link an event participant actually sent. Diagnosed with no request. */
const LOOPBACK =
  'shlink:/eyJ1cmwiOiJodHRwczovL2xvY2FsaG9zdDo1MTczL2FwaS9zaGwtbWFuaWZlc3Q_YmlkPTQ4MzY0NzAiLCJrZXkiOiJJR1hkQ0d1Y0ZSQnctb1NWQWo4N01Qdy13eDFHVlhmeWtQQWtwTndIenNrIiwibGFiZWwiOiJQYXRpZW50IFN1bW1hcnkg4oCUIENoYXJpdGEgQWRhbXMiLCJleHAiOjE3ODczNDcyNjMsInYiOjF9';
/** The specification's own example: opens end to end, so the payload renders. */
const WORKING =
  'shlink:/eyJ1cmwiOiJodHRwczovL3Jhdy5naXRodWJ1c2VyY29udGVudC5jb20vc2Vhbm5vL3NoYy1kZW1vLWRhdGEvbWFpbi9pcHMvSVBTX0lHLWJ1bmRsZS0wMS1lbmMudHh0IiwiZmxhZyI6IkxVIiwia2V5IjoicnhUZ1lsT2FLSlBGdGNFZDBxY2NlTjh3RVU0cDk0U3FBd0lXUWU2dVg3USIsImxhYmVsIjoiRGVtbyBTSEwgZm9yIElQU19JRy1idW5kbGUtMDEifQ';

const SCREENS = [
  ['home', ''],
  ['diagnosed', `#${LOOPBACK}`],
  ['opened', `#${WORKING}`],
  ['offline', '#/offline'],
  ['sandbox', '#/sandbox'],
  ['learn', '#/learn'],
  ['checks', '#/rules'],
  ['about', '#/about'],
  ['settings', '#/settings'],
];

/** Comfortable is 45 to 85; this is the line at which a report says so. */
const LONG_LINE = 90;

/**
 * How far apart the right edges of the page's own column may be.
 *
 * Not zero: a heading with `text-wrap: balance` and a list item with a marker
 * legitimately land a few pixels apart. Eighty is comfortably below the point at
 * which a reader sees two columns instead of one.
 */
const COLUMN_SPREAD = 80;

/*
 * Everything below runs inside the page, so it is written as one self-contained
 * function per measurement rather than importing anything.
 */
function measureInPage() {
  const SAMPLE = 'the quick brown fox jumps over the lazy dog, and every good boy deserves fudge.';

  /** Average character advance for a font, measured in the page that uses it. */
  const advance = (size, family) => {
    const probe = document.createElement('span');
    probe.textContent = SAMPLE;
    // `white-space: pre` matters: without it a long probe wraps at the viewport
    // and the average comes out 20% too small, which is a wrong answer that
    // looks plausible. This cost a round of wrong conclusions.
    probe.style.cssText = `position:absolute;visibility:hidden;white-space:pre;left:-9999px;font-size:${size}px;font-family:${family}`;
    document.body.append(probe);
    const width = probe.getBoundingClientRect().width / SAMPLE.length;
    probe.remove();
    return width;
  };

  const cache = new Map();
  const advanceFor = (style) => {
    const key = `${style.fontSize}|${style.fontFamily}`;
    if (!cache.has(key)) cache.set(key, advance(parseFloat(style.fontSize), style.fontFamily));
    return cache.get(key);
  };

  // Block-level spans included: the sample cards set their text in
  // `<span class="sample-blurb">`, and a selector listing only paragraph-ish tags
  // missed a 134-character line sitting on the landing page.
  const PROSE = 'main p, main li, main dd, main dt, main blockquote, main figcaption, main span';

  // Inside this function on purpose: `page.evaluate` ships one function to the
  // page, so a helper declared outside it is simply not there at run time.
  const describe = (el) => {
    if (!el) return '';
    const cls = (el.className || '').toString().split(' ')[0];
    return `${el.tagName.toLowerCase()}${cls ? '.' + cls : ''} @${getComputedStyle(el).fontSize}`;
  };
  const range = document.createRange();
  const lines = [];
  const short = [];

  for (const el of document.querySelectorAll(PROSE)) {
    const style = getComputedStyle(el);
    if (style.fontFamily.includes('Mono')) continue;
    // An inline span is part of a line rather than a line of its own.
    if (el.tagName === 'SPAN' && !style.display.startsWith('block')) continue;
    const text = (el.textContent ?? '').trim();
    if (text.length < 40) continue;

    let widest = 0;
    for (const node of el.childNodes) {
      if (node.nodeType !== Node.TEXT_NODE || !node.textContent.trim()) continue;
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) widest = Math.max(widest, rect.width);
    }
    if (widest > 0) {
      lines.push({
        chars: Math.round(widest / advanceFor(style)),
        px: Math.round(widest),
        size: style.fontSize,
        what: (el.className || el.tagName.toLowerCase()).toString().split(' ')[0],
      });
    }

    // The other direction: prose ending well inside a container the reader can
    // see the edge of. Same rule as the browser guard, and deliberately so.
    if (text.length < 120) continue;
    const parent = el.parentElement;
    if (parent === null) continue;
    const parentStyle = getComputedStyle(parent);
    const bounded =
      parentStyle.borderLeftWidth !== '0px' ||
      parentStyle.borderRightWidth !== '0px' ||
      !['rgba(0, 0, 0, 0)', 'transparent'].includes(parentStyle.backgroundColor);
    if (!bounded) continue;
    const across =
      (parentStyle.display === 'flex' || parentStyle.display === 'inline-flex') &&
      parentStyle.flexDirection.startsWith('row');
    const grid =
      (parentStyle.display === 'grid' || parentStyle.display === 'inline-grid') &&
      parentStyle.gridTemplateColumns.split(' ').filter(Boolean).length > 1;
    if (across || grid) continue;
    const own = el.getBoundingClientRect().width;
    const wide = [...parent.querySelectorAll('table, pre, code, svg, img, canvas, .scroll-x')].some(
      (node) => node.getBoundingClientRect().width > own + 80,
    );
    if (wide) continue;
    const available =
      parent.getBoundingClientRect().width -
      parseFloat(parentStyle.paddingLeft) -
      parseFloat(parentStyle.paddingRight);
    if (available > 0 && own / available < 0.8 && available - own > 120) {
      short.push({
        what: (el.className || el.tagName.toLowerCase()).toString().split(' ')[0],
        own: Math.round(own),
        available: Math.round(available),
        parent: (parent.className || parent.tagName.toLowerCase()).toString().split(' ')[0],
      });
    }
  }

  lines.sort((a, b) => b.chars - a.chars);

  /*
   * The third question, and the one the eye actually asks first: is there a
   * column at all?
   *
   * Every block that starts at the page's own left edge is in the one column, so
   * their right edges should agree. When they do not, the page reads as text that
   * has been cut short even though every individual line is a comfortable length,
   * which is what happened when the measure was in `em`: a 28px heading resolved
   * 35em to 1244px and the 15px standfirst under it to 451px. Same rule, same
   * column, two edges 800px apart.
   */
  // Headings and paragraphs only. A list ITEM is often a row rather than prose (a
  // trace step, a card in a guide), and it is legitimately as wide as its
  // container, so including `li` here reported a column where there was none.
  // Page-level prose only: no card, panel or figure between it and `main`. Text
  // inside a box is bounded by the box, which is the other measurement.
  const onPageGround = (el) => {
    for (let node = el.parentElement; node !== null; node = node.parentElement) {
      if (node.tagName === 'MAIN') return true;
      const style = getComputedStyle(node);
      const painted =
        !['rgba(0, 0, 0, 0)', 'transparent'].includes(style.backgroundColor) ||
        style.borderLeftWidth !== '0px' ||
        style.borderRightWidth !== '0px';
      if (painted) return false;
    }
    return false;
  };
  const inColumn = [
    ...document.querySelectorAll('main h1, main h2, main h3, main p, main dd'),
  ].filter(
    (el) =>
      (el.textContent ?? '').trim().length >= 40 &&
      el.getBoundingClientRect().width > 0 &&
      onPageGround(el) &&
      // Body prose only. A 12.5px annotation inside a diagram is not what
      // sets the column, and nothing that is a sentence is set below 14px.
      parseFloat(getComputedStyle(el).fontSize) >= 14 &&
      // A heading with a rule under it is a divider as well as a heading, so it
      // spans the content it introduces on purpose. Everything else in the
      // column still has to agree.
      getComputedStyle(el).borderBottomWidth === '0px',
  );
  const lefts = inColumn.map((el) => Math.round(el.getBoundingClientRect().left));
  const pageLeft = Math.min(...lefts);
  const column = inColumn.filter((el) => Math.abs(el.getBoundingClientRect().left - pageLeft) <= 4);
  const rights = column.map((el) => Math.round(el.getBoundingClientRect().right));
  const edges =
    rights.length < 2
      ? { spread: 0, widest: '', narrowest: '' }
      : {
          spread: Math.max(...rights) - Math.min(...rights),
          widest: describe(column[rights.indexOf(Math.max(...rights))]),
          narrowest: describe(column[rights.indexOf(Math.min(...rights))]),
        };

  return { lines: lines.slice(0, 5), short, edges };
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1800, height: 1000 } });
let worst = 0;
let offenders = 0;
let misaligned = 0;

for (const [label, path] of SCREENS) {
  await page.goto(`${BASE}/${path}`);
  await page.waitForSelector('main *');
  if (path.startsWith('#shlink')) {
    await page.waitForSelector('.verdict', { timeout: 30_000 });
    // Every step open, or the bodies are measured collapsed and read as clean.
    for (const head of await page.locator('.step-head[aria-expanded="false"]').all()) {
      await head.click().catch(() => {});
    }
    await page.waitForTimeout(400);
  }
  await page.evaluate(() => document.fonts.ready);

  const { lines, short, edges } = await page.evaluate(measureInPage);
  const longest = lines[0]?.chars ?? 0;
  worst = Math.max(worst, longest);
  offenders += short.length;

  console.log(
    `\n${label}  longest line ${longest} characters${longest > LONG_LINE ? '  <-- long' : ''}`,
  );
  for (const line of lines) {
    console.log(
      `    ${String(line.chars).padStart(4)} chars  ${String(line.px).padStart(5)}px @${line.size.padEnd(7)} ${line.what}`,
    );
  }
  for (const cut of short) {
    console.log(`    CUT SHORT  ${cut.what}: ${cut.own}px of ${cut.available}px in .${cut.parent}`);
  }
  if (edges.spread > COLUMN_SPREAD) {
    misaligned += 1;
    console.log(
      `    NO COLUMN  right edges differ by ${edges.spread}px: ${edges.widest} is widest, ${edges.narrowest} narrowest`,
    );
  }
}

console.log(
  `\nWorst line on any screen: ${worst} characters. Blocks cut short: ${offenders}. ` +
    `Screens with no single column: ${misaligned}.\n` +
    `Comfortable reading is 45 to 85 characters; past about ${LONG_LINE} a reader loses the line.`,
);
await browser.close();
process.exitCode = worst > LONG_LINE || offenders > 0 || misaligned > 0 ? 1 : 0;
