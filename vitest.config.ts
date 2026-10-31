import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    globals: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    reporters: ['dot'],
  },
});
