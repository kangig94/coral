import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { rawSqlPlugin } from './raw-sql-plugin.js';

const alias = {
  '#src': fileURLToPath(new URL('../src', import.meta.url)),
  '#tests': fileURLToPath(new URL('../tests', import.meta.url)),
  '#tools': fileURLToPath(new URL('../tools', import.meta.url)),
};

export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  plugins: [rawSqlPlugin()],
  resolve: { alias },
  test: {
    include: ['tests/simulation/**/*.test.ts'],
    setupFiles: ['vitest/setup.ts'],
    pool: 'forks',
    forks: { singleFork: true },
  },
});
