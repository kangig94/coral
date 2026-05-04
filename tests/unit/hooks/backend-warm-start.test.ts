import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  SESSION_START_HOOK,
  cleanupFixtures,
  createFixture,
  runHookAsync,
  waitForFile,
} from '#tests/unit/hooks/_helpers.js';

afterEach(cleanupFixtures);

const WARM_START_TIMEOUT_MS = 15_000;

/**
 * The session-start hook absorbs the daemon spawn (previously a separate
 * `backend-warm-start.mjs`). The same staleness/incumbent contract still
 * lives entirely in the daemon's `bindWithHandoff`: a healthy same-bundle
 * peer makes the new daemon throw `BackendAlreadyRunningError` and exit;
 * a mismatching peer triggers IPC `transport.shutdown`. The hook stays
 * free of bundle/flavor comparison so the contention contract has one
 * canonical home.
 */
describe('session-start.mjs daemon spawn', () => {
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
        SESSION_START_HOOK,
        { session_id: 'test-session-spawn' },
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
        SESSION_START_HOOK,
        { session_id: 'test-session-child' },
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
