import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { rawSqlPlugin } from './raw-sql-plugin.js';
import { testEnv, UNIT_TIER_INCLUDES } from './tiers.js';

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
    env: testEnv('unit'),
    include: UNIT_TIER_INCLUDES,
    exclude: ['ref/**', 'node_modules/**'],
    setupFiles: ['vitest/setup.ts'],
    globalSetup: ['vitest/isolated-unit-home.ts'],
    // Deliberate budget, not vitest's 5s default: a case that resets the module registry to swap module
    // doubles re-executes a large module graph inside its own budget, so the budget must clear that cost by
    // a wide margin while staying short enough to fail a genuinely hung case promptly. A case that comes
    // close to whatever budget it ends up with fails on a green run; see casesWithoutHeadroom in
    // scripts/test-report.mjs.
    testTimeout: 15_000,
    // A hook budget must exceed `testTimeout`: the cheapest fix for that cold-transform cost is a
    // beforeAll that warms the module graph once, which moves the cost out of a case's budget and into the
    // hook's. Vitest's 10s hook default does not clear it.
    hookTimeout: 30_000,
    // Workers may not exceed the runner's cores under CI. GitHub gives a public repository's `ubuntu-latest`
    // job 4 vCPU (GitHub Actions runner specification, read 2026-09-17) and sets CI=true, so CI gets exactly
    // that core count.
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
