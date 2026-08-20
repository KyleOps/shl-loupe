/**
 * The browser pass: the claims only a browser can check.
 *
 * Every assertion here corresponds to something a unit test cannot see, and
 * several correspond to a defect this file caught the first time it ran. Where
 * that is so, the comment says which, because a test whose purpose is forgotten
 * gets deleted the next time it is inconvenient.
 */
import { expect, test, type Page } from '@playwright/test';

/**
 * The link an event participant actually sent, believing it worked, because on
 * their machine it did. Everything about this project starts here.
 */
const LOOPBACK_LINK =
  'shlink:/eyJ1cmwiOiJodHRwczovL2xvY2FsaG9zdDo1MTczL2FwaS9zaGwtbWFuaWZlc3Q_YmlkPTQ4MzY0NzAiLCJrZXkiOiJJR1hkQ0d1Y0ZSQnctb1NWQWo4N01Qdy13eDFHVlhmeWtQQWtwTndIenNrIiwibGFiZWwiOiJQYXRpZW50IFN1bW1hcnkg4oCUIENoYXJpdGEgQWRhbXMiLCJleHAiOjE3ODczNDcyNjMsInYiOjF9';

/** The specification's own example: U flag, CORS open, and it really resolves. */
const WORKING_LINK =
  'shlink:/eyJ1cmwiOiJodHRwczovL3Jhdy5naXRodWJ1c2VyY29udGVudC5jb20vc2Vhbm5vL3NoYy1kZW1vLWRhdGEvbWFpbi9pcHMvSVBTX0lHLWJ1bmRsZS0wMS1lbmMudHh0IiwiZmxhZyI6IkxVIiwia2V5IjoicnhUZ1lsT2FLSlBGdGNFZDBxY2NlTjh3RVU0cDk0U3FBd0lXUWU2dVg3USIsImxhYmVsIjoiRGVtbyBTSEwgZm9yIElQU19JRy1idW5kbGUtMDEifQ';

/** Fail a test on any console error, rather than letting one pass unnoticed. */
async function watchForErrors(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console.error: ${message.text()}`);
  });
  return errors;
}

test.describe('the motivating incident', () => {
  test('is diagnosed from the link alone, with no request', async ({ page }) => {
    const errors = await watchForErrors(page);
    const requests: string[] = [];
    page.on('request', (request) => {
      // Requests for the app's own assets are not the app reaching out.
      if (!request.url().startsWith('http://localhost:4173/')) requests.push(request.url());
    });

    await page.goto(`/#${LOOPBACK_LINK}`);
    const verdict = page.locator('.verdict');
    await expect(verdict).toContainText('own machine');
    await expect(verdict).toContainText('No request was made');
    await expect(verdict).toContainText('localhost:5173');

    // The privacy finding, which is the one nobody had noticed: a sequential id
    // in the manifest URL lets other people's links be enumerated.
    await expect(page.locator('body')).toContainText('SHL-URL-LOW-ENTROPY');

    expect(requests, 'the pipeline must not touch the network').toEqual([]);
    expect(errors).toEqual([]);
  });

  test('shows a fatal verdict as fatal, not as a note', async ({ page }) => {
    // Caught here first: the banner took its whole tone from the outcome, so a
    // fatal finding rendered a calm blue information icon beside the sentence
    // "nobody else can open it".
    await page.goto(`/#${LOOPBACK_LINK}`);
    await expect(page.locator('.verdict')).toHaveClass(/tone-fail/);
    // And the outcome chip keeps its own, gentler reading, because "blocked"
    // describes SHLoupe doing well rather than the link doing badly.
    await expect(page.locator('.verdict-facts')).toContainText('Blocked');
  });
});

test.describe('a link that opens', () => {
  test('fetches, decrypts and renders the specification’s own example', async ({ page }) => {
    const errors = await watchForErrors(page);
    await page.goto(`/#${WORKING_LINK}`);

    await expect(page.locator('.verdict')).toContainText('opens', { timeout: 20_000 });
    // The patient in the IG's example bundle. If this name renders, the whole
    // chain worked: fetch, AES-GCM, JSON, bundle index, renderer.
    await expect(page.locator('body')).toContainText('Martha DeLarosa');
    // Every entry accounted for, which is the promise the incumbent breaks.
    await expect(page.locator('body')).toContainText('20');
    expect(errors).toEqual([]);
  });
});

test.describe('the chrome renders', () => {
  // Caught here first: the masthead, link field and footer had no stylesheet at
  // all, and a missing stylesheet fails silently.
  test('has a styled masthead and separated navigation', async ({ page }) => {
    await page.goto('/');
    const nav = page.locator('.masthead-nav');
    await expect(nav).toBeVisible();

    // The symptom of the missing stylesheet was "OpenOfflineSandboxLearnChecksAbout".
    const links = nav.locator('a');
    const first = await links.first().boundingBox();
    const second = await links.nth(1).boundingBox();
    expect(first, 'nav links must have layout').not.toBeNull();
    expect(second).not.toBeNull();
    expect(second!.x).toBeGreaterThan(first!.x + first!.width - 2);
  });

  /*
   * Two claims, tested separately, because one of them has nothing to do with
   * timing and was being asserted through something that did.
   *
   * The original test pressed Tab and then waited for the reveal, which flaked
   * about one run in four under six parallel workers. Measurement (30 serial
   * runs) showed focus landing on the skip link every single time, so the tab
   * order was never the problem: what was fragile was pressing a key before the
   * page had settled and then reading a transition mid-flight. Neither claim
   * needs a keystroke to be checked.
   */
  test('the skip link is the first thing in the tab order', async ({ page }) => {
    await page.goto('/');
    // Tab order follows DOM order here, since nothing sets a positive tabindex,
    // so this is a static check with no timing in it at all.
    const first = await page.evaluate(() => {
      const focusable = document.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      const positive = [...document.querySelectorAll<HTMLElement>('[tabindex]')].filter(
        (el) => Number(el.getAttribute('tabindex')) > 0,
      );
      return { className: focusable[0]?.className ?? '', positiveTabindexes: positive.length };
    });
    expect(first.className).toContain('skip-link');
    expect(first.positiveTabindexes, 'a positive tabindex would break DOM order').toBe(0);
  });

  test('the skip link is off screen until focused, and on screen once it is', async ({ page }) => {
    await page.goto('/');
    const skip = page.locator('.skip-link');
    await expect(skip).toBeAttached();
    expect((await skip.boundingBox())!.y, 'off screen at rest').toBeLessThan(0);

    // Focused directly rather than by pressing Tab: the claim under test is that
    // focus reveals it, and going through the keyboard only adds a way to fail
    // for an unrelated reason.
    await skip.focus();
    await expect(skip).toBeFocused();
    await expect
      .poll(async () => Math.round((await skip.boundingBox())!.y), { timeout: 3000 })
      .toBeGreaterThan(0);

    await page.locator('#link-field-input').focus();
    await expect
      .poll(async () => Math.round((await skip.boundingBox())!.y), { timeout: 3000 })
      .toBeLessThan(0);
  });
});

test.describe('the trace', () => {
  test('draws nothing where a collapsed step body would be', async ({ page }) => {
    // Caught here first: `.step-body { display: flex }` beats the `hidden`
    // attribute's user-agent `display: none`, so every collapsed step drew an
    // empty raised panel. The markup and the React state were both correct,
    // which is why nothing else noticed.
    await page.goto(`/#${WORKING_LINK}`);
    await expect(page.locator('.step-head').first()).toBeVisible({ timeout: 20_000 });
    const hidden = page.locator('.step-body[hidden]').first();
    await expect(hidden).toBeHidden();
    expect(await hidden.boundingBox()).toBeNull();
  });

  test('walks with j and k without expanding, and opens on Enter', async ({ page }) => {
    await page.goto(`/#${WORKING_LINK}`);
    await page.locator('.step-head').first().waitFor({ timeout: 20_000 });
    await page.locator('.step-head').first().focus();
    const openBefore = await page.locator('.step-body:not([hidden])').count();
    await page.keyboard.press('j');
    await page.keyboard.press('j');
    expect(await page.locator('.step-body:not([hidden])').count()).toBe(openBefore);
    await page.keyboard.press('Enter');
    expect(await page.locator('.step-body:not([hidden])').count()).toBeGreaterThan(openBefore);
  });
});

test.describe('modes', () => {
  test('larger text scales type, and only type', async ({ page }) => {
    /*
     * This replaced a "projector mode" that swapped colours, widths and type at
     * once. Its colour and width choices were improvements rather than
     * accommodations, so they are the default now and the assertion here is
     * deliberately narrow: what is left must touch the type scale and the things
     * that have to move with it, and nothing else. A second visual identity is
     * the thing this is not.
     */
    await page.goto('/');
    const before = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return {
        max: style.getPropertyValue('--content-max').trim(),
        muted: style.getPropertyValue('--fg-muted').trim(),
        canvas: style.getPropertyValue('--bg-canvas').trim(),
      };
    });

    await page.evaluate(() =>
      localStorage.setItem(
        'loupe.settings',
        JSON.stringify({ state: { theme: 'dark', largeText: true }, version: 0 }),
      ),
    );
    await page.reload();

    const after = await page.evaluate(() => {
      const style = getComputedStyle(document.documentElement);
      return {
        attr: document.documentElement.dataset.textSize,
        base: style.getPropertyValue('--font-size-base').trim(),
        rail: style.getPropertyValue('--rail-width').trim(),
        hairline: style.getPropertyValue('--hairline-width').trim(),
        max: style.getPropertyValue('--content-max').trim(),
        muted: style.getPropertyValue('--fg-muted').trim(),
        canvas: style.getPropertyValue('--bg-canvas').trim(),
      };
    });

    expect(after.attr).toBe('large');
    expect(after.base).toBe('19px');
    expect(after.rail).toBe('5px');
    expect(after.hairline).toBe('2px');
    // Unchanged, which is the point.
    expect(after.max).toBe(before.max);
    expect(after.muted).toBe(before.muted);
    expect(after.canvas).toBe(before.canvas);
  });

  test('bounds the content width so prose never runs edge to edge', async ({ page }) => {
    // The review's words: "the text going all the way to the sides of the screen
    // is kind of ugly". The cap used to apply only in projector mode.
    await page.setViewportSize({ width: 2200, height: 1000 });
    await page.goto('/');
    const shell = await page.locator('.shell').boundingBox();
    expect(shell!.width).toBeLessThanOrEqual(1561);
  });

  test('the light theme paints an explicit background', async ({ page }) => {
    await page.goto('/');
    await page.evaluate(() =>
      localStorage.setItem(
        'loupe.settings',
        JSON.stringify({ state: { theme: 'light' }, version: 0 }),
      ),
    );
    await page.reload();
    await expect(page.locator('body')).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  });
});

test.describe('reflow', () => {
  /*
   * WCAG 1.4.10: usable at 400% zoom on a 1280px viewport, which is a 320px CSS
   * viewport, with no two-dimensional scrolling.
   *
   * Every screen, not just the home screen. The first version of this test
   * loaded the home screen at each width, which is why two real overflows
   * survived it: the Learn screen's contents list ran 240px past the viewport at
   * 320px and the Sandbox verdict row ran 171px past. A reflow test that only
   * visits one screen is a reflow test for one screen.
   */
  const screens: Array<[string, string]> = [
    ['home', ''],
    ['a diagnosed link', `#${LOOPBACK_LINK}`],
    ['offline', '#/offline'],
    ['sandbox', '#/sandbox'],
    ['learn', '#/learn'],
    ['checks', '#/rules'],
    ['about', '#/about'],
  ];

  for (const [label, path] of screens) {
    for (const width of [1560, 900, 390, 320]) {
      test(`${label} does not scroll sideways at ${width}px`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.goto(`/${path}`);
        await expect(page.locator('main')).not.toBeEmpty();
        // Let fonts settle: Geist swapping in widens content, and a measurement
        // taken against the fallback metrics reports an overflow that is not there
        // (or misses one that is).
        await page.evaluate(() => document.fonts.ready);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        expect(overflow, 'wide content must scroll inside its own container').toBeLessThanOrEqual(
          1,
        );
      });
    }
  }
});

test.describe('every screen renders without throwing', () => {
  for (const path of ['', '/offline', '/sandbox', '/learn', '/rules', '/about']) {
    test(`#${path || ' (home)'}`, async ({ page }) => {
      const errors = await watchForErrors(page);
      await page.goto(`/#${path}`);
      await expect(page.locator('main')).not.toBeEmpty();
      expect(errors).toEqual([]);
    });
  }
});

test.describe('the privacy promise', () => {
  test('puts a submitted link in the fragment, never the query string', async ({ page }) => {
    // The payload carries the decryption key, and a query string reaches the
    // server's access log while a fragment does not. This is the strongest
    // privacy claim the tool makes, so it is checked rather than asserted.
    await page.goto('/');
    await page.locator('#link-field-input').fill(LOOPBACK_LINK);
    await page.locator('button[type="submit"]').click();
    await expect(page.locator('.verdict')).toContainText('own machine');
    const url = new URL(page.url());
    expect(url.search).toBe('');
    expect(url.hash).toContain('shlink:/');
  });

  test('stores no link, key or payload in localStorage', async ({ page }) => {
    await page.goto(`/#${LOOPBACK_LINK}`);
    await expect(page.locator('.verdict')).toBeVisible();
    const stored = await page.evaluate(() => JSON.stringify(localStorage));
    expect(stored).not.toContain('shlink');
    expect(stored).not.toContain('IGXdCGucFRBw');
    expect(stored).not.toContain('localhost:5173');
  });
});

test.describe('the deployment failure most likely to happen at an event', () => {
  test('says so when served from somewhere it cannot decrypt', async ({ page }) => {
    /*
     * SHLoupe is reached by `kubectl port-forward`, which is http://localhost and
     * fine. Then somebody at the same table wants a look, the forward is rebound
     * to 0.0.0.0, the LAN address is read out, and on that laptop `crypto.subtle`
     * is undefined, so every file fails at the last step for a reason that has
     * nothing to do with the link. Measured in this browser:
     *
     *   http://localhost:4173      secureContext=true   crypto.subtle=true
     *   http://127.0.0.1:4173      secureContext=true   crypto.subtle=true
     *   http://192.168.x.x:4173    secureContext=false  crypto.subtle=false
     *
     * The notice is simulated by removing crypto.subtle before the app boots,
     * because a test cannot make a browser distrust its own loopback origin.
     */
    await page.addInitScript(() => {
      Object.defineProperty(globalThis, 'isSecureContext', { value: false, configurable: true });
      Object.defineProperty(globalThis.crypto, 'subtle', { value: undefined, configurable: true });
    });
    await page.goto('/');
    const notice = page.locator('.insecure-notice');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('cannot decrypt anything');
    await expect(notice).toContainText('port-forward');
    // It has to say what still works, or it reads as "the tool is broken".
    await expect(notice).toContainText('still works');
  });

  test('says nothing at all when served from localhost', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.insecure-notice')).toHaveCount(0);
  });
});

test.describe('the overlay layer', () => {
  /*
   * Two failures here shipped unnoticed, both of the same kind: a stylesheet that
   * did not exist. `Overlay` rendered a backdrop and a `role="dialog"` surface
   * with no rules behind them, so it laid out as ordinary block content in the
   * page flow. The settings dialog injected a section into the masthead above the
   * tab strip, and Cmd-K added a 640px block to the middle of the page. Nothing
   * errored, no test failed, and the markup and the React state were both right.
   *
   * These assert the properties that make an overlay an overlay, rather than
   * asserting a screenshot, because the failure mode is structural.
   */
  test('the command palette covers the page rather than joining it', async ({ page }) => {
    await page.goto('/');
    // Both measurements have to come from a settled page. Reading the height
    // before the web fonts swap in and again afterwards compares two different
    // layouts, which flaked under parallel load for a reason that had nothing to
    // do with the overlay.
    await page.evaluate(() => document.fonts.ready);
    await expect(page.locator('.nav-tab').first()).toBeVisible();
    const heightBefore = await page.evaluate(() => document.documentElement.scrollHeight);

    await page.keyboard.press('ControlOrMeta+k');
    const overlay = page.locator('.overlay');
    await expect(overlay).toBeVisible();

    // Fixed and full-viewport: the two things it was not.
    await expect(overlay).toHaveCSS('position', 'fixed');
    const box = await overlay.boundingBox();
    const viewport = page.viewportSize();
    expect(box!.height).toBeCloseTo(viewport!.height, 0);
    expect(Math.round(box!.y)).toBe(0);

    // A layer that covers does not lengthen the document beneath it.
    const heightAfter = await page.evaluate(() => document.documentElement.scrollHeight);
    expect(heightAfter).toBe(heightBefore);

    await page.keyboard.press('Escape');
    await expect(overlay).toBeHidden();
  });

  test('the palette is in sentence case, not capitals', async ({ page }) => {
    // `text-transform` inherits, and the uppercase micro-label styling was on the
    // wrapper that holds a group's options rather than on the group's label, so
    // every command and every hint rendered in capitals.
    await page.goto('/');
    await page.keyboard.press('ControlOrMeta+k');
    await expect(page.locator('.palette-option-label').first()).toHaveCSS('text-transform', 'none');
    await expect(page.locator('.palette-group').first()).toHaveCSS('text-transform', 'uppercase');
  });
});

test.describe('the masthead is the same height on every screen', () => {
  // Settings used to render its dialog inside the header, so opening it injected a
  // section above the tab strip and shifted the whole page. It is a screen now,
  // and this is the guard: no screen may add anything to the masthead.
  test('no screen changes the header', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.masthead')).toBeVisible();
    const baseline = (await page.locator('.masthead').boundingBox())!.height;

    for (const path of ['/settings', '/offline', '/sandbox', '/learn', '/rules', '/about']) {
      await page.goto(`/#${path}`);
      await expect(page.locator('main')).not.toBeEmpty();
      const height = (await page.locator('.masthead').boundingBox())!.height;
      expect(height, `#${path} changed the masthead height`).toBeCloseTo(baseline, 0);
    }
  });

  test('settings is a screen with its own URL', async ({ page }) => {
    await page.goto('/#/settings');
    await expect(page.locator('.settings-title')).toContainText('Settings');
    // Reachable, reloadable and linkable, which a dialog is not.
    await page.reload();
    await expect(page.locator('.settings-title')).toContainText('Settings');
    // And it did not land inside the header.
    expect(await page.locator('header .settings').count()).toBe(0);
  });
});

test.describe('the workbench lays out as three panes', () => {
  /*
   * The layout `OpenScreen` computes is the layout that renders.
   *
   * `workbench.css` did not exist for the first weeks of this project, so every
   * one of those class names matched nothing and the screen rendered as a single
   * column of full-width panels on every display. The class-coverage unit test
   * (src/styles/styles-cover-markup.test.ts) now catches a missing stylesheet,
   * but it can only prove that somebody wrote a rule. This proves the rule does
   * what the screen was designed around: two columns wide, one column narrow, and
   * the pane that earns the space getting it.
   */
  test('puts the link beside the trace, with the payload below both', async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 1000 });
    await page.goto(`/#${WORKING_LINK}`);
    // The payload pane exists from the first frame (it explains what it is
    // waiting for), and while the run is in flight the trace is still the hero.
    // Measuring before the run settles measures the wrong layout.
    await expect(page.locator('.workbench[data-layout="payload-first"]')).toBeVisible({
      timeout: 30_000,
    });

    const link = await page.locator('.pane-link').boundingBox();
    const trace = await page.locator('.pane-trace').boundingBox();
    const payload = await page.locator('.pane-payload').boundingBox();
    if (link === null || trace === null || payload === null) {
      throw new Error('a pane did not render');
    }

    // The link and the trace share the top row: both are about the request.
    expect(trace.x).toBeGreaterThan(link.x + link.width - 1);
    expect(trace.y).toBeCloseTo(link.y, 0);

    // The document has the next row to itself, and all of it. A page of clinical
    // content in half a row is the thing this layout exists to stop.
    expect(payload.y).toBeGreaterThan(link.y + link.height - 1);
    expect(payload.x).toBeCloseTo(link.x, 0);
    expect(payload.width).toBeGreaterThan(trace.x + trace.width - link.x - 4);
  });

  test('gives the trace the wider half while nothing has opened', async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 1000 });
    await page.goto(`/#${LOOPBACK_LINK}`);
    await expect(page.locator('.pane-trace')).toBeVisible({ timeout: 20_000 });

    const link = await page.locator('.pane-link').boundingBox();
    const trace = await page.locator('.pane-trace').boundingBox();
    if (link === null || trace === null) throw new Error('a pane did not render');
    // Nothing opened, so the trace is what is being read.
    expect(trace.width).toBeGreaterThan(link.width);
  });

  test('collapses to one pane at a time between 700 and 1100', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 1000 });
    await page.goto(`/#${WORKING_LINK}`);
    await expect(page.locator('.pane-tabs')).toBeVisible({ timeout: 20_000 });

    // Wait for the run to settle before touching the tabs. Opening a payload
    // switches the tab once, per run, from an effect: clicking Trace while that
    // is still pending gets undone a frame later. It only shows up when the
    // machine is loaded and the fetch is slow, which is how it passed alone and
    // failed in the parallel pass.
    await expect(page.locator('.workbench[data-layout="payload-first"]')).toBeVisible({
      timeout: 30_000,
    });

    // One of the two, never both, and the tab bar says which.
    expect(await page.locator('.pane-trace, .pane-payload').count()).toBe(1);
    await expect(page.locator('.pane-payload')).toBeVisible();

    await page.getByRole('tab', { name: 'Trace' }).click();
    await expect(page.locator('.pane-trace')).toBeVisible();
    await expect(page.locator('.pane-payload')).toHaveCount(0);
  });
});

test.describe('every screen has one column', () => {
  /*
   * The complaint this guards, in the maintainer's words: "still has the
   * wordwrap/column length limit issue", with a screenshot of a page whose
   * heading ran the width of the display and whose paragraphs stopped a third of
   * the way across.
   *
   * Both were "correct" by the previous rule: every line was a comfortable
   * length. The measure was in `em`, so it resolved against each element's own
   * size, and a 28px heading capped at 35em came out 1244px wide while the 15px
   * standfirst under it came out 451px. Nothing on the page agreed where the
   * column was, and a reader sees that as text that has been cut off long before
   * they count characters on a line.
   *
   * So the check is alignment, not length: every heading and paragraph starting
   * at the page's own left edge is in the one column, and their right edges have
   * to agree. `li` is excluded because a list item is often a ROW (a trace step,
   * a card in a guide) and is legitimately as wide as its container.
   */
  const screens: Array<[string, string]> = [
    ['home', ''],
    ['a diagnosed link', `#${LOOPBACK_LINK}`],
    ['offline', '#/offline'],
    ['sandbox', '#/sandbox'],
    ['learn', '#/learn'],
    ['checks', '#/rules'],
    ['about', '#/about'],
    ['settings', '#/settings'],
  ];

  for (const [label, path] of screens) {
    test(`${label} keeps one right edge`, async ({ page }) => {
      await page.setViewportSize({ width: 1800, height: 1000 });
      await page.goto(`/${path}`);
      await expect(page.locator('main')).not.toBeEmpty();
      await page.evaluate(() => document.fonts.ready);
      if (path.startsWith('#shlink')) {
        await expect(page.locator('.verdict')).toBeVisible({ timeout: 20_000 });
      }

      const report = await page.evaluate(() => {
        // Page-level prose only: a block sitting on the page's own ground, with
        // no card, panel or figure between it and `main`.
        //
        // That is what defines the column. Text inside a box is bounded by the
        // box, which is the other guard's business, and using every descendant
        // here produced two false positives worth remembering: the workbench's
        // two panes have their own widths on purpose and share a left edge
        // without sharing a column, and a 12.5px annotation inside the segment
        // diagram is not a paragraph in the column at all.
        const onPageGround = (el: HTMLElement): boolean => {
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
        const blocks = [
          ...document.querySelectorAll<HTMLElement>('main h1, main h2, main h3, main p, main dd'),
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
        if (blocks.length < 2) return { spread: 0, widest: '', narrowest: '' };
        const pageLeft = Math.min(...blocks.map((el) => el.getBoundingClientRect().left));
        const column = blocks.filter(
          (el) => Math.abs(el.getBoundingClientRect().left - pageLeft) <= 4,
        );
        if (column.length < 2) return { spread: 0, widest: '', narrowest: '' };
        const rights = column.map((el) => Math.round(el.getBoundingClientRect().right));
        const name = (el: HTMLElement | undefined): string =>
          el === undefined
            ? ''
            : `${el.tagName.toLowerCase()}.${el.className.split(' ')[0] ?? ''} @${getComputedStyle(el).fontSize}`;
        return {
          spread: Math.max(...rights) - Math.min(...rights),
          widest: name(column[rights.indexOf(Math.max(...rights))]),
          narrowest: name(column[rights.indexOf(Math.min(...rights))]),
        };
      });

      // Not zero: a balanced heading and a list marker land a few pixels apart.
      // Eighty is well below where a reader starts seeing two columns.
      expect(
        report.spread,
        `${report.widest} is widest, ${report.narrowest} narrowest: state the column in rem, not em`,
      ).toBeLessThanOrEqual(80);
    });
  }
});

test.describe('no paragraph is cut short inside a wider box', () => {
  /*
   * The defect this guards, in the maintainer's words: "a lot of textboxes look
   * weird and seem to be cut short to a new line".
   *
   * The cause was a rule I had written and applied backwards. A measure belongs to
   * a CONTAINER: cap the container, and let the text fill it, so the text's edge
   * and the container's edge are the same edge. Capping the PARAGRAPH instead
   * leaves it short of a box three times its width, and the reader sees
   * truncation rather than a column. It was guaranteed to happen wherever the
   * text was set below the base size, because `ch` resolves against the element's
   * own font size, so a 14px note capped at 74ch stops well inside a card that
   * was sized for 16px.
   *
   * The check is the audit that found it: any long block of text filling less than
   * four fifths of the room it is given, with more than 120px going spare.
   *
   * Two exclusions, both deliberate rather than convenient:
   *  - A standfirst (`.learn-lede`, `.rules-lede`, `.about-lede`) is MEANT to be a
   *    tighter column than the prose beneath it. It is the one case where ending
   *    early is a choice.
   *  - A container laid out ACROSS the inline axis sizes its items by their track
   *    rather than by its own box, so comparing the two measures nothing.
   *
   * That second exclusion was written as "any grid or flex parent", and it is why
   * this test passed for a fortnight while the defect it was written for sat on
   * the busiest screen in the app. Almost every container here is a flex COLUMN,
   * and in a column the item's width IS the parent's content width, so the
   * comparison is exactly valid. Excluding by `display` instead of by axis skipped
   * the whole trace area: the verdict, every step body, every finding, every
   * citation. The finding boxes were 662px of text in a 1432px tinted box, which
   * is the screenshot that reopened this.
   *
   * Two further conditions, which together are the rule as it is actually written
   * in tokens.css rather than an approximation of it:
   *  - The container has to have a VISIBLE edge (a border, or a background of its
   *    own). A paragraph taking the measure inside a transparent section is a
   *    column, not a truncation; there is no edge for it to disagree with.
   *  - The container must not hold anything WIDER than the prose. A table, a code
   *    block or a row of cards is what set that width, and prose beside one is
   *    entitled to stop at the measure.
   * What is never allowed is the case this was reported for: a box whose only
   * content is prose, three times the width of the prose, so that the box's own
   * edge is the thing contradicting the text.
   */
  const screens: Array<[string, string]> = [
    ['home', ''],
    ['a diagnosed link', `#${LOOPBACK_LINK}`],
    ['an opened link', `#${WORKING_LINK}`],
    ['offline', '#/offline'],
    ['sandbox', '#/sandbox'],
    ['learn', '#/learn'],
    ['checks', '#/rules'],
    ['about', '#/about'],
    ['settings', '#/settings'],
  ];

  for (const [label, path] of screens) {
    test(`${label} fills the width it is given`, async ({ page }) => {
      // Wide on purpose: the defect is invisible at laptop widths and glaring on a
      // large display, which is where it was reported from.
      await page.setViewportSize({ width: 1800, height: 1000 });
      await page.goto(`/${path}`);
      await expect(page.locator('main')).not.toBeEmpty();
      await page.evaluate(() => document.fonts.ready);
      if (path.startsWith('#shlink')) {
        await expect(page.locator('.verdict')).toBeVisible({ timeout: 20_000 });
      }

      const short = await page.evaluate(() => {
        const STANDFIRST = ['learn-lede', 'rules-lede', 'about-lede'];
        const out: string[] = [];
        for (const el of document.querySelectorAll<HTMLElement>(
          'main p, main dd, main .setting-note',
        )) {
          if ((el.textContent ?? '').trim().length < 120) continue;
          if (STANDFIRST.some((name) => el.classList.contains(name))) continue;
          const parent = el.parentElement;
          if (!parent) continue;
          const style = getComputedStyle(parent);
          // The defect is a paragraph contradicting an edge the reader can SEE.
          // A transparent, borderless section is not an edge: prose taking the
          // measure inside one is a column, which is the whole point.
          //
          // A background, or a LEFT or RIGHT border. Not a top one: `.evidence +
          // .evidence` draws a separator rule above each block after the first,
          // and counting that as a box reported a note as cut short when the
          // thing it supposedly fell short of was a horizontal line.
          const bounded =
            style.borderLeftWidth !== '0px' ||
            style.borderRightWidth !== '0px' ||
            !['rgba(0, 0, 0, 0)', 'transparent'].includes(style.backgroundColor);
          if (!bounded) continue;
          // Across the inline axis, the track sizes the item. Down a column, the
          // parent's content width does, and that is the case worth checking.
          const laidOutAcross =
            (style.display === 'flex' || style.display === 'inline-flex'
              ? style.flexDirection.startsWith('row')
              : false) ||
            (style.display === 'grid' || style.display === 'inline-grid'
              ? style.gridTemplateColumns.split(' ').filter(Boolean).length > 1
              : false);
          if (laidOutAcross) continue;
          // Something intrinsically wide is setting this container's width, so
          // the prose in it is entitled to be narrower than the box.
          //
          // "Wider sibling" is NOT the test, and the first version of this line
          // used it: a block-level sibling stretches to the container by
          // default, so a finding's own title row made every finding look
          // justified and the mutation test walked straight through. What
          // counts is content that is wide in itself.
          const proseWidth = el.getBoundingClientRect().width;
          const holdsWideContent = [
            ...parent.querySelectorAll<HTMLElement>(
              'table, pre, code, svg, img, canvas, .scroll-x',
            ),
          ].some((wide) => wide.getBoundingClientRect().width > proseWidth + 80);
          if (holdsWideContent) continue;
          const available =
            parent.getBoundingClientRect().width -
            parseFloat(style.paddingLeft) -
            parseFloat(style.paddingRight);
          const own = el.getBoundingClientRect().width;
          if (available <= 0) continue;
          if (own / available < 0.8 && available - own > 120) {
            out.push(
              `${el.className || el.tagName.toLowerCase()}: ${Math.round(own)}px of ${Math.round(available)}px`,
            );
          }
        }
        return out;
      });

      expect(short, 'cap the container, not the paragraph').toEqual([]);
    });
  }
});
