import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['ref/**', 'node_modules/**'],
    setupFiles: ['vitest.setup.ts'],
  },
});
