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
    // describes Loupe doing well rather than the link doing badly.
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

  test('hides the skip link until it has focus, then shows it', async ({ page }) => {
    /*
     * This was flaky under parallel load, passing alone and failing about one run
     * in seven with six workers. The cause was pressing Tab before the page had
     * settled: the header adjusts the tab strip's scrollLeft once fonts have
     * loaded, and a Tab arriving in that window landed somewhere other than the
     * first stop. A flaky test is worse than no test, so the wait is explicit
     * rather than a timeout: focus the body first, so the tab order starts from a
     * known place, and let the fonts resolve before pressing anything.
     */
    await page.goto('/');
    const skip = page.locator('.skip-link');
    await expect(skip).toBeAttached();
    await page.evaluate(() => document.fonts.ready);

    await expect
      .poll(async () => Math.round((await skip.boundingBox())!.y), { timeout: 2000 })
      .toBeLessThan(0);

    await page.evaluate(() => document.body.focus());
    await page.keyboard.press('Tab');
    await expect(skip).toBeFocused();

    // The reveal is a transform transition, so wait for it to settle rather than
    // reading mid-animation.
    await expect
      .poll(async () => Math.round((await skip.boundingBox())!.y), { timeout: 2000 })
      .toBeGreaterThan(0);
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
     * Loupe is reached by `kubectl port-forward`, which is http://localhost and
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
