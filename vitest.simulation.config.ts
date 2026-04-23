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
    include: ['tests/simulation/**/*.test.ts'],
    setupFiles: ['vitest.setup.ts'],
    pool: 'forks',
    forks: { singleFork: true },
  },
});
