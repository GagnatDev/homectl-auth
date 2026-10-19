import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    testTimeout: 15_000,
    // Vitest 5 no longer excludes dist. The package compiles to CommonJS, and
    // those emitted tests cannot import Vitest.
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
