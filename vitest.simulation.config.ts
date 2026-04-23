import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/simulation/**/*.test.ts'],
    setupFiles: ['vitest.setup.ts'],
    pool: 'forks',
    forks: { singleFork: true },
  },
});
