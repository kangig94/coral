import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { backendLog } from '#src/infra/backend-log.js';
import {
  applyClearCurateRetryState,
  readCurateState,
  writeCurateState,
} from '#src/kb/curate/state/index.js';
import {
  INVARIANT,
  createCurateScheduler,
  type CurateHandle,
} from '#src/kb/curate/scheduler.js';
import type { SpawnCliFn } from '#src/kb/curate/pipeline-types.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { createKbTestDb } from '#tests/unit/kb/runtime-test-helpers.js';
import { createTestKbRuntime } from '#tests/fixtures/test-runtime.js';

// S2: per-lane consecutive failure counters cap at INVARIANT.MAX_CONSECUTIVE_FAILURES.
// Once a lane crosses the cap the scheduler stops scheduling it and surfaces
// an operator-visible warning. Reset path: applyClearCurateRetryState resets
// both lanes so an explicit reset can re-enable scheduling.

const noopSpawnCli: SpawnCliFn = () =>
  Promise.resolve({
    stdout: '[]',
    stderr: '',
    code: 0,
    aborted: false,
  });

describe('curate scheduler failure cap (S2)', () => {
  let tempDir: string;
  let runtime: ReturnType<typeof createTestKbRuntime>;
  let scheduler: CurateHandle;
  let gitSyncRuntime: ReturnType<typeof createRealRuntime>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'coral-kb-curate-cap-'));
    gitSyncRuntime = createRealRuntime('prod');
    runtime = createTestKbRuntime({
      markdownRoot: tempDir,
      runtimeDir: tempDir,
      db: createKbTestDb(tempDir),
      runtime: gitSyncRuntime,
      spawnCli: noopSpawnCli,
    });
    scheduler = createCurateScheduler({
      kb: runtime,
      spawnCli: noopSpawnCli,
      processPort: gitSyncRuntime.process,
      storagePort: gitSyncRuntime.storage,
      envPort: gitSyncRuntime.env,
      // Bypass the 60s production debounce so the launch is observable in-test;
      // the cap-trip warning we want to assert fires inside launchQueuedRun.
      scheduleDebounceMs: 0,
    });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('exposes the documented cap value', () => {
    expect(INVARIANT.MAX_CONSECUTIVE_FAILURES).toBe(10);
    void scheduler; // ensure setup ran without throwing
  });

  it('disables both lanes once consecutive failures reach the cap', async () => {
    // Seed scheduler state at the cap so the next run is a permanent skip.
    const trippedAt = '2026-04-29T12:00:00.000Z';
    await runtime.withMutationLock(() => {
      writeCurateState(runtime, {
        ...readCurateState(runtime),
        consecutiveClaimFailures: INVARIANT.MAX_CONSECUTIVE_FAILURES,
        consecutiveCommunityBatchFailures: INVARIANT.MAX_CONSECUTIVE_FAILURES,
        claimLaneDisabledAt: trippedAt,
        communityBatchLaneDisabledAt: trippedAt,
        initialized: true,
      });
    });

    const warnSpy = vi.spyOn(backendLog, 'warn').mockImplementation(() => {});

    try {
      await scheduler.start();
      // Wait long enough for the debounced launch to fire.
      await new Promise((resolve) => setTimeout(resolve, 100));

      const state = readCurateState(runtime);
      // Counters stayed at the cap — scheduler did not increment further or
      // mutate the lane. The warning surfaces the disabled state and the
      // disabledAt timestamps survive across the skip.
      expect(state.consecutiveClaimFailures).toBe(INVARIANT.MAX_CONSECUTIVE_FAILURES);
      expect(state.consecutiveCommunityBatchFailures).toBe(INVARIANT.MAX_CONSECUTIVE_FAILURES);
      expect(state.claimLaneDisabledAt).toBe(trippedAt);
      expect(state.communityBatchLaneDisabledAt).toBe(trippedAt);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/permanently disabled.*consecutive failures/),
      );
    } finally {
      warnSpy.mockRestore();
      await scheduler.stop();
    }
  });

  it('applyClearCurateRetryState resets BOTH lane counters and the disabled-at stamps so an operator can re-enable scheduling', () => {
    const seeded = {
      ...readCurateState(runtime),
      consecutiveClaimFailures: INVARIANT.MAX_CONSECUTIVE_FAILURES,
      consecutiveCommunityBatchFailures: INVARIANT.MAX_CONSECUTIVE_FAILURES,
      claimLaneDisabledAt: '2026-04-25T00:00:00.000Z',
      communityBatchLaneDisabledAt: '2026-04-25T00:00:00.000Z',
      retryNotBefore: '2026-04-25T00:00:00.000Z',
    };
    const cleared = applyClearCurateRetryState(seeded);
    expect(cleared).not.toBeNull();
    expect(cleared!.consecutiveClaimFailures).toBe(0);
    expect(cleared!.consecutiveCommunityBatchFailures).toBe(0);
    expect(cleared!.claimLaneDisabledAt).toBeNull();
    expect(cleared!.communityBatchLaneDisabledAt).toBeNull();
    expect(cleared!.retryNotBefore).toBeNull();
  });
});
