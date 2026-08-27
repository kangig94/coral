import { defineConfig } from 'vitest/config';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { rawSqlPlugin } from './raw-sql-plugin.js';
import { testTempEnv } from './temp-root.js';

const packageVersion = (
  JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf-8')) as { version: string }
).version;

const alias = {
  '#src': fileURLToPath(new URL('../src', import.meta.url)),
  '#tests': fileURLToPath(new URL('../tests', import.meta.url)),
  '#tools': fileURLToPath(new URL('../tools', import.meta.url)),
};

// E2E lifecycle suite: spawns long-lived backend subprocesses + waits for
// startup / IPC handshake / process death. ~91s wall (mutate-via-ipc 30s +
// namespace-coexistence 61s). Run when touching coordinator boot/shutdown,
// IPC, backend bundle build, or namespace isolation.
export default defineConfig({
  root: fileURLToPath(new URL('..', import.meta.url)),
  plugins: [rawSqlPlugin()],
  define: { __VERSION__: JSON.stringify(packageVersion) },
  resolve: { alias },
  test: {
    env: testTempEnv(),
    include: ['tests/e2e/lifecycle/**/*.test.ts', 'tests/e2e/**/lifecycle/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 30_000,
    pool: 'forks',
    forks: { singleFork: true },
    globalSetup: ['vitest/no-real-coral-leak.ts'],
  },
});
