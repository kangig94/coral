import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  SESSION_START_HOOK,
  cleanupFixtures,
  createFixture,
  expectHookOutput,
  runHookAsync,
  waitForFile,
  writeInjectBundle,
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

/**
 * The spawn above is detached, so a failed start used to be completely silent:
 * the daemon wrote a diagnostic and exited, the hook failed open, and the session
 * proceeded as if Coral were healthy. Nothing ever deletes the diagnostic, so the
 * notice is gated on both recency and no daemon currently answering.
 */
describe('session-start.mjs startup failure notice', () => {
  function setupFixture() {
    const fixture = createFixture();
    mkdirSync(join(fixture.pluginRoot, 'bridge'), { recursive: true });
    writeFileSync(
      join(fixture.pluginRoot, 'bridge', 'manifest.json'),
      JSON.stringify({ bundleHash: 'test-hash', flavor: 'prod' }),
      'utf-8',
    );
    writeFileSync(join(fixture.pluginRoot, 'bridge', 'coral-backend.cjs'), '', 'utf-8');
    // Without an inject bundle the hook exits before emitting hookSpecificOutput.
    writeInjectBundle(fixture.pluginRoot, 'inject-fixture');
    return fixture;
  }

  function writeDiagnostic(fixture: ReturnType<typeof createFixture>, diagnostic: unknown): void {
    const runDir = join(fixture.root, '.coral', 'gen2', 'run');
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'startup-diagnostic.json'), JSON.stringify(diagnostic), 'utf-8');
  }

  function documentedFailure(recordedAt: string): Record<string, unknown> {
    return {
      schemaVersion: 1,
      phase: 'startup_failed',
      state: 'stopped_with_diagnostic',
      retryable: false,
      pid: 4242,
      recordedAt,
      exitCode: 1,
      error: {
        kind: 'coral_setup_error',
        code: 'store_newer_incompatible',
        userMessage:
          'The current-generation store was written by newer Coral 0.11.0 and is incompatible with this build.',
        remediation:
          "Use Coral 0.11.0 to read this store, or run 'coral-cli backend store-reset discard --target gen2 --flavor prod'.",
      },
    };
  }

  async function contextFor(fixture: ReturnType<typeof createFixture>, sessionId: string): Promise<string> {
    const result = await runHookAsync(
      SESSION_START_HOOK,
      { session_id: sessionId },
      { HOME: fixture.root, CLAUDE_PLUGIN_ROOT: fixture.pluginRoot },
    );
    expect(result.status).toBe(0);
    return expectHookOutput(result).hookSpecificOutput.additionalContext ?? '';
  }

  it(
    'reports a recent non-retryable failure with its documented remediation',
    async () => {
      const fixture = setupFixture();
      writeDiagnostic(fixture, documentedFailure(new Date().toISOString()));

      const context = await contextFor(fixture, 'test-session-notice');

      expect(context).toContain('the most recent start attempt failed');
      expect(context).toContain('written by newer Coral 0.11.0');
      expect(context).toContain('coral-cli backend store-reset discard --target gen2 --flavor prod');
    },
    WARM_START_TIMEOUT_MS,
  );

  it(
    'stays silent once the diagnostic is no longer recent',
    async () => {
      const fixture = setupFixture();
      writeDiagnostic(fixture, documentedFailure(new Date(Date.now() - 60 * 60 * 1000).toISOString()));

      const context = await contextFor(fixture, 'test-session-stale');

      expect(context).not.toContain('the most recent start attempt failed');
    },
    WARM_START_TIMEOUT_MS,
  );

  it(
    'stays silent for an undocumented failure, whose raw message is not user-safe',
    async () => {
      const fixture = setupFixture();
      writeDiagnostic(fixture, {
        ...documentedFailure(new Date().toISOString()),
        error: { kind: 'error', name: 'Error', message: 'token=super-secret', stack: 'not printed' },
      });

      const context = await contextFor(fixture, 'test-session-undocumented');

      expect(context).not.toContain('the most recent start attempt failed');
      expect(context).not.toContain('super-secret');
    },
    WARM_START_TIMEOUT_MS,
  );
});
