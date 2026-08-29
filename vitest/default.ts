import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { rawSqlPlugin } from './raw-sql-plugin.js';
import { testTempEnv } from './temp-root.js';

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
    env: testTempEnv(),
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
    // On a 2-core CI runner, this I/O-bound suite benefits from oversubscription: measured ~1m11s @2 →
    // ~38s @4. GitHub Actions sets CI=true, so CI uses that measured four-worker setting.
    //
    // On a 24-core WSL2 host, a third of an uncapped run had processes in uninterruptible sleep on the ext4
    // journal. At eight workers, peak stall depth fell by more than half at a 1.9x wall-time cost. Concurrency
    // rather than volume causes the stall: one process fsyncing costs ~5 ms even behind 300 MB of foreign dirty
    // pages. The cap must keep this suite from saturating the shared block device because the live coordinator's
    // time budgets continue advancing while its process is descheduled. See
    // docs/todo/unit-suite-concurrency-and-real-time-tests.md for the measurements and correction history.
    ...(process.env.CI ? { maxWorkers: 4, minWorkers: 4 } : { maxWorkers: 8 }),
  },
});
