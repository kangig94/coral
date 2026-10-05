import { expect, it, vi } from 'vitest';
import { createLifecycleRecoveryDependencies } from '#src/coordinator/composition/lifecycle-recovery-dependencies.js';
import { encodeResolvedStoreEpoch, readOrCreateEpochKey } from '#src/store/epoch/index.js';
import { createTerminalExportFixture } from '#tests/helpers/terminal-export.js';

it('reconciles orphan holds at store open without stealing the active owner hold', () => {
  const f = createTerminalExportFixture('provider', true);
  try {
    const activeKey = encodeResolvedStoreEpoch(f.runtime, f.epoch);
    const activeLineageKey = readOrCreateEpochKey(f.runtime, f.epoch);
    f.index.holdUnknownLocations(activeKey, 'active recovery retry', true);
    f.index.holdUnknownLocations(activeLineageKey, 'active lineage recovery retry', true);
    f.index.holdUnknownLocations('retired:99', 'old scheduled retry', true);
    const input = {
      runtime: f.runtime,
      identity: { instanceId: 'active-instance', buildSetId: 'test-build', pluginRoot: f.root },
      jobLocationIndex: f.index,
      providerHostTransfer: {},
      getProgressStore: () => f.store,
      readSuccessionJobs: () => [],
      world: {},
      onOpenedStore: vi.fn(),
    } as unknown as Parameters<typeof createLifecycleRecoveryDependencies>[0];
    createLifecycleRecoveryDependencies(input).onStoreOpened?.(f.epoch);
    expect(f.index.unknownLocationHolds().find((hold) => hold.epochKey === activeKey)).toMatchObject({
      retryScheduled: true,
      reason: 'active recovery retry',
    });
    expect(f.index.unknownLocationHolds().find((hold) => hold.epochKey === activeLineageKey)).toMatchObject({
      retryScheduled: true,
    });
    expect(f.index.unknownLocationHolds().find((hold) => hold.epochKey === 'retired:99')).toMatchObject({
      retryScheduled: false,
      reason: expect.stringContaining('next start'),
    });
  } finally {
    f.close();
  }
});
