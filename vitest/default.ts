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
    include: ['tests/unit/**/*.test.ts', 'tests/invariants/**/*.test.ts'],
    exclude: ['ref/**', 'node_modules/**'],
    setupFiles: ['vitest/setup.ts'],
    globalSetup: ['vitest/no-real-coral-leak.ts'],
    // Deliberate budget, not vitest's 5s default. This suite is I/O-bound with workers oversubscribed (see
    // below), and cases that reset the module registry to swap module doubles re-execute a large graph inside
    // their own budget — measured ~0.7-1.5s idle and roughly 2x that under contention. 5s left as little as a
    // 1.6x margin, which surfaced as intermittent "timed out in 5000ms" failures in tests/unit/cli. Still
    // short enough to fail a genuinely hung test promptly.
    testTimeout: 15_000,
    // Matches the integration/e2e configs. Needed because the cheapest fix for the cold-transform problem
    // above is a beforeAll that warms the module graph once, which moves that ~1s (much more under a slow or
    // contended filesystem) out of a case's budget and into the hook's — vitest's hook default is only 10s.
    hookTimeout: 30_000,
    // This suite is I/O-bound (IPC sockets, subprocess spawns, timers), so on a
    // 2-core CI runner it is worker-bound rather than core-bound: oversubscribing
    // workers overlaps the I/O waits (measured ~1m11s @2 → ~38s @4). GitHub Actions
    // sets CI=true.
    //
    // A cap is also needed where cores are plentiful, for the opposite reason. 92 of
    // these files spawn child processes, so an unbounded fork pool on a many-core box
    // reaches ~108 node processes all creating temp dirs, opening SQLite with
    // `synchronous=FULL`, and unlinking. Measured on a 24-core WSL2 host: a third of
    // the run had processes stuck in uninterruptible sleep on the ext4 journal, which
    // is enough to push a live coordinator past its 5s provider heartbeat budget and
    // have the reaper terminate unrelated jobs. Concurrency is what does this rather
    // than total bytes: one process fsyncing costs ~5ms even behind 300MB of foreign
    // dirty pages.
    ...(process.env.CI ? { maxWorkers: 4, minWorkers: 4 } : { maxWorkers: 8 }),
  },
});
