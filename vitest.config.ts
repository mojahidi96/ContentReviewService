import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/helpers/global-setup.ts'],
    testTimeout: 20_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
});
