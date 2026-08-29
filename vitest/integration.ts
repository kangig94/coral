import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { rawSqlPlugin } from './raw-sql-plugin.js';
import { testEnv } from './tiers.js';

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
    env: testEnv('integration'),
    include: ['tests/integration/**/*.test.ts'],
    setupFiles: ['vitest/setup.ts'],
    testTimeout: 120_000,
    hookTimeout: 30_000,
    pool: 'forks',
    maxWorkers: 1,
    globalSetup: ['vitest/no-real-coral-leak.ts'],
  },
});
