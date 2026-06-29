import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Property-based tests (fast-check) live alongside unit tests.
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    environment: 'node',
    globals: true,
  },
});
