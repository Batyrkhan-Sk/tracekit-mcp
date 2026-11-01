import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Browser integration tests launch Chromium; keep file-level parallelism modest.
    maxWorkers: 2,
  },
});
