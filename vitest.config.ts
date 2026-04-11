import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['ref/**', 'node_modules/**', 'src/**/__tests__/integration/**/*.test.ts'],
    setupFiles: ['vitest.setup.ts'],
  },
});
