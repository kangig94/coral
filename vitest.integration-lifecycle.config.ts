import { defineConfig } from 'vitest/config';

// Lifecycle integration tests: real backend subprocess spawn + IPC handshake +
// process death waits. Slow (~91s for the two cases). Run when touching
// coordinator boot/shutdown, IPC, backend bundle, or flavor isolation.
export default defineConfig({
  test: {
    include: ['src/**/__tests__/integration/lifecycle/**/*.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 30_000,
    pool: 'forks',
    forks: { singleFork: true },
  },
});
