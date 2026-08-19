import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

/**
 * The tests that talk to a real server, kept out of the default run.
 *
 * A suite that goes red when the venue wifi is down is a suite people learn to
 * ignore, and this tool is used precisely where the network is unreliable. Run
 * it deliberately: `npm run test:live`.
 */
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.integration.test.ts'],
    testTimeout: 30_000,
  },
});
