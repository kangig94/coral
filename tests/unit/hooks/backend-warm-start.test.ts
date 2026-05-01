import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  BACKEND_WARM_START_HOOK,
  cleanupFixtures,
  createFixture,
  runHookAsync,
  waitForFile,
} from '#tests/unit/hooks/_helpers.js';

afterEach(cleanupFixtures);

const WARM_START_TIMEOUT_MS = 15_000;

/**
 * The warm-start hook unconditionally spawns the bundled coral-backend.
 * Staleness/incumbent detection is the daemon's job (`acquireLock` ->
 * `inspectIncumbent`): a healthy same-bundle peer makes the new daemon
 * throw `BackendAlreadyRunningError` and exit, while a mismatching peer
 * triggers `requestHandoff`. The hook stays free of bundle/flavor
 * comparison so the contention contract has one canonical home.
 */
describe('backend-warm-start.mjs', () => {
  function setupWarmStartFixture() {
    const fixture = createFixture();
    const markerPath = join(fixture.pluginRoot, 'spawned.txt');

    mkdirSync(join(fixture.pluginRoot, 'bridge'), { recursive: true });
    writeFileSync(
      join(fixture.pluginRoot, 'bridge', 'manifest.json'),
      JSON.stringify({ bundleHash: 'test-hash', flavor: 'prod' }),
      'utf-8',
    );
    writeFileSync(
      join(fixture.pluginRoot, 'bridge', 'coral-backend.cjs'),
      `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'spawned')\n`,
      'utf-8',
    );

    return { fixture, markerPath };
  }

  it(
    'spawns the bundled backend on every invocation',
    async () => {
      const { fixture, markerPath } = setupWarmStartFixture();

      const result = await runHookAsync(
        BACKEND_WARM_START_HOOK,
        {},
        {
          HOME: fixture.root,
          CLAUDE_PLUGIN_ROOT: fixture.pluginRoot,
        },
      );

      expect(result.status).toBe(0);
      expect(await waitForFile(markerPath)).toBe(true);
    },
    WARM_START_TIMEOUT_MS,
  );

  it(
    'does not consult backend.json or call /admin/shutdown',
    async () => {
      const { fixture, markerPath } = setupWarmStartFixture();
      const installDir = join(fixture.root, '.claude', 'coral', 'installations');
      mkdirSync(installDir, { recursive: true });

      // Stale backend.json with a live PID would have made the old hook
      // probe /health and request shutdown. The new hook ignores it.
      writeFileSync(
        join(fixture.pluginRoot, 'sentinel.txt'),
        'no shutdown server is running; if the hook called /admin/shutdown it would error out',
        'utf-8',
      );

      const result = await runHookAsync(
        BACKEND_WARM_START_HOOK,
        {},
        {
          HOME: fixture.root,
          CLAUDE_PLUGIN_ROOT: fixture.pluginRoot,
        },
      );

      expect(result.status).toBe(0);
      expect(await waitForFile(markerPath)).toBe(true);
    },
    WARM_START_TIMEOUT_MS,
  );

  it(
    'is a no-op when CORAL_CHILD=1 (recursive guard)',
    async () => {
      const { fixture, markerPath } = setupWarmStartFixture();

      const result = await runHookAsync(
        BACKEND_WARM_START_HOOK,
        {},
        {
          HOME: fixture.root,
          CLAUDE_PLUGIN_ROOT: fixture.pluginRoot,
          CORAL_CHILD: '1',
        },
      );

      expect(result.status).toBe(0);
      expect(await waitForFile(markerPath, 500)).toBe(false);
    },
    WARM_START_TIMEOUT_MS,
  );
});
