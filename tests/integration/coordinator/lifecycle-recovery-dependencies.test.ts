import { expect, it, vi } from 'vitest';
import { createLifecycleRecoveryDependencies } from '#src/coordinator/composition/lifecycle-recovery-dependencies.js';
import { encodeResolvedStoreEpoch, readOrCreateEpochKey } from '#src/store/epoch/index.js';
import { retryUnknownHistoricalEpochs } from '#src/jobs/historical-reader.js';
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
    expect(f.index.unknownLocationHolds().find((hold) => hold.epochKey === 'retired:99')).toBeUndefined();
  } finally {
    f.close();
  }
});

import * as epochs from '#src/store/epoch/index.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { createStartupMintAuthorizer } from '#src/coordinator/services/startup-retirement.js';

it.each(['preserved', 'protected'] as const)(
  'open registers a present %s epoch and preserves an unobservable lineage hold',
  async (role) => {
    const f = createTerminalExportFixture('provider', true);
    const active = createTerminalExportFixture('provider', true);
    const fullKey = encodeResolvedStoreEpoch(f.runtime, f.epoch);
    const lineageKey = readOrCreateEpochKey(f.runtime, f.epoch);
    const entry = {
      role,
      resolved: f.epoch,
      epochKey: lineageKey,
      epochJson: { kind: 'valid', value: { build: { storeFormatFingerprint: currentCoralStoreFormat().fingerprint } } },
    } as never;
    const list = vi.spyOn(epochs, 'listStoreEpochs').mockReturnValue([entry]);
    try {
      f.index.holdUnknownLocations(fullKey, 'former active hold', true);
      const input = {
        runtime: f.runtime,
        identity: { instanceId: 'test', buildSetId: 'test', pluginRoot: f.root },
        jobLocationIndex: f.index,
        providerHostTransfer: {},
        getProgressStore: () => f.store,
        readSuccessionJobs: () => [],
        world: {},
        onOpenedStore: vi.fn(),
      } as unknown as Parameters<typeof createLifecycleRecoveryDependencies>[0];
      const observer = createLifecycleRecoveryDependencies(input).onStoreOpened!;
      observer(active.epoch);
      expect(f.index.unknownLocationHolds().find((hold) => hold.epochKey === fullKey)?.retryScheduled).toBe(true);
      await retryUnknownHistoricalEpochs(f.index);
      expect(f.index.unknownLocationHolds().find((hold) => hold.epochKey === fullKey)).toBeUndefined();
      expect(f.index.readHistorical(fullKey, [f.jobId]).kind).toBe('read');
      list.mockReturnValue([{ ...(entry as object), resolved: null }] as never);
      f.index.holdUnknownLocations(fullKey, 'temporarily unobservable', true);
      observer(active.epoch);
      expect(f.index.unknownLocationHolds().find((hold) => hold.epochKey === fullKey)).toMatchObject({
        retryScheduled: true,
        reason: 'temporarily unobservable',
      });
    } finally {
      list.mockRestore();
      active.close();
      f.close();
    }
  },
);

it('startup authorizer attempts the incumbent seed once', () => {
  const f = createTerminalExportFixture('provider', true);
  const fullKey = encodeResolvedStoreEpoch(f.runtime, f.epoch);
  const lineageKey = readOrCreateEpochKey(f.runtime, f.epoch);
  const list = vi.spyOn(epochs, 'listStoreEpochs').mockReturnValue([
    {
      role: 'protected',
      resolved: f.epoch,
      epochKey: lineageKey,
      epochJson: {
        kind: 'valid',
        value: { build: { storeFormatFingerprint: currentCoralStoreFormat().fingerprint } },
      },
    },
  ] as never);
  const broken = vi.spyOn(f.runtime.storage, 'openSqliteDatabaseSync').mockImplementation(() => {
    throw new Error('unable to open database file');
  });
  try {
    createStartupMintAuthorizer(
      f.runtime,
      f.index,
      'startup',
    )({
      incumbent: f.epoch,
      incumbentEpochKey: fullKey,
      observedEpochCount: 1,
      classification: { kind: 'different', storedFingerprint: currentCoralStoreFormat().fingerprint },
    } as never);
    expect(broken).toHaveBeenCalledTimes(1);
    expect(f.index.unknownLocationHolds().find((hold) => hold.epochKey === fullKey)?.reason).toContain(
      'probe 1 of 3 failed',
    );
  } finally {
    broken.mockRestore();
    list.mockRestore();
    f.close();
  }
});
