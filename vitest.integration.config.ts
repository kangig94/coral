import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const alias = {
  '#src': fileURLToPath(new URL('./src', import.meta.url)),
  '#tests': fileURLToPath(new URL('./tests', import.meta.url)),
  '#tools': fileURLToPath(new URL('./tools', import.meta.url)),
};

export default defineConfig({
  resolve: { alias },
  test: {
    include: ['tests/integration/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 30_000,
    pool: 'forks',
    forks: { singleFork: true },
  },
});
