import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: [
      'ref/**',
      'node_modules/**',
      'src/coordinator/**/__tests__/integration/**/*.test.ts',
      'src/workflow/**/__tests__/integration/**/*.test.ts',
      'src/__tests__/integration/agent-wire-contract.test.ts',
      'src/**/__tests__/e2e/**/*.test.ts',
      // `npm test` runs simulation in a single-fork batch via scripts/test.mjs.
      'tests/simulation/**',
    ],
    setupFiles: ['vitest.setup.ts'],
  },
});
