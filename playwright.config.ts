import { defineConfig, devices } from '@playwright/test';

/**
 * Browser tests, and why this project has them.
 *
 * Loupe's central claims are claims about browser behaviour: that a cross-origin
 * failure is opaque, that a fragment never reaches a server, that a page on
 * https cannot fetch http, that WebCrypto and the camera need a secure context.
 * A unit test in Node cannot check any of that, and a jsdom environment would
 * pretend to.
 *
 * The pass earns its keep. On its first run against the assembled app it found
 * four real defects that every other gate had passed: an entire stylesheet
 * missing (nothing errors, nothing goes red, the page just renders as inline
 * text), an empty panel under every collapsed trace step because a `display`
 * declaration beats the `hidden` attribute, a fatal verdict rendering a calm
 * blue information icon, and a copy button letting content show through it.
 *
 * Kept out of `pnpm test` on purpose: it needs a build and a browser download,
 * and a suite that cannot run on a plane is a suite people stop running. Run it
 * with `pnpm test:browser`, which builds and serves first.
 */
export default defineConfig({
  testDir: './test/browser',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: 'http://localhost:4173/',
    trace: 'retain-on-failure',
  },
  // Serves the BUILT bundle rather than the dev server: the production build is
  // what gets deployed, and it is where a missing stylesheet import or a broken
  // dynamic chunk would actually show up.
  webServer: {
    command: 'pnpm build && pnpm exec vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173/',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
