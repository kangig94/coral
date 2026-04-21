import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/simulation/__tests__/simulation*.test.ts',
      'src/simulation/__tests__/simulation-runner.test.ts',
      'src/cli/__tests__/main-routing.test.ts',
    ],
    setupFiles: ['vitest.setup.ts'],
    pool: 'forks',
    forks: { singleFork: true },
  },
});
