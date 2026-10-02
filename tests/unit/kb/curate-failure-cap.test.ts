import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyClearCurateRetryState,
  INVARIANT,
  readCurateState,
  writeCurateState,
} from '#src/kb/curate/state/index.js';
import { createCurateScheduler, type CurateHandle } from '#src/kb/curate/scheduler.js';
import type { CurateAssistantPort } from '#src/kb/curate/assistant.js';
import { createRealRuntime } from '#src/runtime/real.js';
import { openKbTestStoreDb } from '#tests/helpers/store-db.js';
import { createTestKbRuntime } from '#tests/fixtures/test-runtime.js';
import { curateDb } from '../../../src/kb/curate/db-access.js';

// S2: per-lane consecutive failure counters cap at INVARIANT.MAX_CONSECUTIVE_FAILURES.
// Once a lane crosses the cap the scheduler stops scheduling it and surfaces
// an operator-visible warning. Reset path: applyClearCurateRetryState resets
// both lanes so an explicit reset can re-enable scheduling.

const noopCurateAssistant: CurateAssistantPort = {
  complete: async () => '[]',
};

describe('curate scheduler failure cap (S2)', () => {
  let tempDir: string;
  let runtime: ReturnType<typeof createTestKbRuntime>;
  let scheduler: CurateHandle;
  let gitSyncRuntime: ReturnType<typeof createRealRuntime>;

  beforeEach(() => {
    vi.useFakeTimers();
    tempDir = mkdtempSync(join(tmpdir(), 'coral-kb-curate-cap-'));
    gitSyncRuntime = createRealRuntime('prod');
    runtime = createTestKbRuntime({
      markdownRoot: tempDir,
      runtimeDir: tempDir,
      db: openKbTestStoreDb(':memory:'),
      runtime: gitSyncRuntime,
      curateAssistant: noopCurateAssistant,
    });
    scheduler = createCurateScheduler({
      kb: runtime,
      curateAssistant: noopCurateAssistant,
      processPort: gitSyncRuntime.process,
      storagePort: gitSyncRuntime.storage,
      envPort: gitSyncRuntime.env,
      usageBudget: { isExhausted: async () => false },
      scheduleDebounceMs: 0,
    });
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('disables both lanes once consecutive failures reach the cap', async () => {
    const trippedAt = '2026-04-29T12:00:00.000Z';
    await runtime.withMutationLock(() => {
      writeCurateState(curateDb(runtime), {
        ...readCurateState(curateDb(runtime)),
        consecutiveClaimFailures: INVARIANT.MAX_CONSECUTIVE_FAILURES,
        consecutiveCommunityBatchFailures: INVARIANT.MAX_CONSECUTIVE_FAILURES,
        claimLaneDisabledAt: trippedAt,
        communityBatchLaneDisabledAt: trippedAt,
        initialized: true,
      });
    });

    try {
      await scheduler.start();
      await vi.advanceTimersByTimeAsync(0);

      const state = readCurateState(curateDb(runtime));
      expect(state.consecutiveClaimFailures).toBe(INVARIANT.MAX_CONSECUTIVE_FAILURES);
      expect(state.consecutiveCommunityBatchFailures).toBe(INVARIANT.MAX_CONSECUTIVE_FAILURES);
      expect(state.claimLaneDisabledAt).toBe(trippedAt);
      expect(state.communityBatchLaneDisabledAt).toBe(trippedAt);
    } finally {
      await scheduler.stop();
    }
  });

  it('applyClearCurateRetryState resets BOTH lane counters and the disabled-at stamps so an operator can re-enable scheduling', () => {
    const seeded = {
      ...readCurateState(curateDb(runtime)),
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
