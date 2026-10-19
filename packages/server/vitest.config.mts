import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    globalSetup: ['./vitest.global-setup.ts'],
    setupFiles: ['./vitest.setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Vitest 5 no longer excludes dist. The package compiles to CommonJS, and
    // those emitted tests cannot import Vitest.
    exclude: ['**/node_modules/**', '**/dist/**'],
    // All test files share a single Postgres container — run sequentially to
    // prevent concurrent truncate/insert races between test files.
    fileParallelism: false,
    maxWorkers: 1,
  },
});
