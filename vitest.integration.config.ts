import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: '.',
    include: ['tests/integration/**/*.integration.test.ts', 'tests/contracts/**/*.test.ts'],
    globalSetup: ['tests/integration/globalSetup.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: false,
  },
});
