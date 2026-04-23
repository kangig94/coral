import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const alias = {
  '#src': fileURLToPath(new URL('./src', import.meta.url)),
  '#tests': fileURLToPath(new URL('./tests', import.meta.url)),
  '#tools': fileURLToPath(new URL('./tools', import.meta.url)),
};

// E2E suite: spawns real coral-cli / coral-backend bundle subprocesses.
// `library-direct-reads` is fast (~900ms, no lifecycle wait); `mutate-via-ipc`
// (~30s) and `flavor-coexistence` (~61s) wait for backend startup + IPC
// handshake + process death. Run when touching coordinator boot/shutdown,
// IPC, backend bundle build, CLI commands, or flavor isolation.
export default defineConfig({
  resolve: { alias },
  test: {
    include: ['tests/e2e/**/*.test.ts'],
    exclude: ['tests/e2e/lifecycle/**', 'tests/e2e/**/lifecycle/**'],
    testTimeout: 120_000,
    hookTimeout: 30_000,
    pool: 'forks',
    forks: { singleFork: true },
  },
});
