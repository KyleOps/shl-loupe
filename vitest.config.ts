import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    // The core pipeline is DOM-free apart from WebCrypto, which Node has as
    // globalThis.crypto. Screen tests get their own environment when they land.
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'test/**/*.test.ts'],
    // test/browser/* is Playwright's, run by `pnpm test:browser`.
    exclude: ['test/browser/**', 'node_modules/**', 'dist/**'],
  },
});
