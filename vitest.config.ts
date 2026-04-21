import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: [
      'ref/**',
      'node_modules/**',
      'src/**/__tests__/integration/**/*.test.ts',
      'src/**/__tests__/e2e/**/*.test.ts',
      'src/simulation/__tests__/simulation*.test.ts',
      'src/simulation/__tests__/simulation-runner.test.ts',
      'src/cli/__tests__/main-routing.test.ts',
      'src/cli/__tests__/main.test.ts',
    ],
    setupFiles: ['vitest.setup.ts'],
  },
});
