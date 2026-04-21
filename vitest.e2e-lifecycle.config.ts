import { defineConfig } from 'vitest/config';

// E2E lifecycle suite: spawns long-lived backend subprocesses + waits for
// startup / IPC handshake / process death. ~91s wall (mutate-via-ipc 30s +
// flavor-coexistence 61s). Run when touching coordinator boot/shutdown,
// IPC, backend bundle build, or flavor isolation.
export default defineConfig({
  test: {
    include: ['src/**/__tests__/e2e/lifecycle/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 30_000,
    pool: 'forks',
    forks: { singleFork: true },
  },
});
