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

it.each(['preserved', 'garbage'] as const)('pre-bind startup registers %s history without seeding it', async (role) => {
  const f = createTerminalExportFixture('provider', true);
  const list = vi.spyOn(epochs, 'listStoreEpochs').mockReturnValue([
    {
      role,
      resolved: f.epoch,
      epochKey: f.epochKey,
      epochJson: { kind: 'valid', value: { build: { storeFormatFingerprint: currentCoralStoreFormat().fingerprint } } },
    },
  ] as never);
  const open = vi.spyOn(f.runtime.storage, 'openSqliteDatabaseSync');
  try {
    createStartupMintAuthorizer(
      f.runtime,
      f.index,
      'startup',
    )({ incumbent: null, incumbentEpochKey: null, observedEpochCount: 1, classification: { kind: 'absent' } } as never);
    expect(open.mock.calls.filter(([path]) => path === f.epoch.path)).toEqual([]);
    await retryUnknownHistoricalEpochs(f.index, { remaining: 0 });
    expect(open.mock.calls.some(([path]) => path === f.epoch.path)).toBe(true);
  } finally {
    open.mockRestore();
    list.mockRestore();
    f.close();
  }
});

it.each(['{damaged', '\0\0\0'])('isolates damaged preserved epoch identity %j at store open', (marker) => {
  const historical = createTerminalExportFixture('provider', true);
  const active = createTerminalExportFixture('provider', true);
  const list = vi.spyOn(epochs, 'listStoreEpochs').mockReturnValue([
    {
      resolved: historical.epoch,
      epochKey: null,
      role: 'preserved',
      epochJson: {
        kind: 'valid',
        value: { build: { storeFormatFingerprint: currentCoralStoreFormat().fingerprint } },
      },
    },
  ] as never);
  try {
    const directory = historical.epoch.path.slice(0, historical.epoch.path.lastIndexOf('/'));
    historical.runtime.storage.writeFileSync(directory + '/.coral-lineage.v1.json', marker);
    historical.index.holdUnknownLocations(historical.epochKey, 'owned retry', true);
    const observer = createLifecycleRecoveryDependencies({
      runtime: historical.runtime,
      identity: { instanceId: 'test', buildSetId: 'test', pluginRoot: historical.root },
      jobLocationIndex: historical.index,
      providerHostTransfer: {},
      getProgressStore: () => historical.store,
      readSuccessionJobs: () => [],
      world: {},
      onOpenedStore: vi.fn(),
    } as unknown as Parameters<typeof createLifecycleRecoveryDependencies>[0]).onStoreOpened!;
    expect(() => observer(active.epoch)).not.toThrow();
    expect(historical.index.unknownLocationHolds().some((hold) => hold.retryScheduled)).toBe(true);
    expect(historical.runtime.storage.readFileSync(directory + '/.coral-lineage.v1.json', 'utf-8')).toBe(marker);
  } finally {
    list.mockRestore();
    active.close();
    historical.close();
  }
});

it.each(['inventory', 'registration', 'reconciliation'] as const)(
  'store-open recovery isolates a failed %s observation',
  async (step) => {
    const f = createTerminalExportFixture('provider', true);
    const historical = await import('#src/jobs/historical-reader.js');
    try {
      if (step === 'inventory')
        vi.spyOn(epochs, 'listStoreEpochs').mockImplementation(() => {
          throw new Error('inventory unavailable');
        });
      if (step === 'registration')
        vi.spyOn(historical, 'registerPresentHistoricalEpochs').mockImplementation(() => {
          throw new Error('registration unavailable');
        });
      if (step === 'reconciliation')
        vi.spyOn(f.index, 'reconcileUnknownLocationHolds').mockImplementation(() => {
          throw new Error('held certificate unavailable');
        });
      const opened = vi.fn();
      const input = {
        runtime: f.runtime,
        identity: { instanceId: 'test', buildSetId: 'test', pluginRoot: f.root },
        jobLocationIndex: f.index,
        providerHostTransfer: {},
        getProgressStore: () => f.store,
        readSuccessionJobs: () => [],
        world: {},
        onOpenedStore: opened,
      } as unknown as Parameters<typeof createLifecycleRecoveryDependencies>[0];
      expect(() => createLifecycleRecoveryDependencies(input).onStoreOpened?.(f.epoch)).not.toThrow();
      expect(opened).toHaveBeenCalledExactlyOnceWith(f.epoch);
      expect(f.store.readStatus(f.jobId)?.jobId).toBe(f.jobId);
    } finally {
      vi.restoreAllMocks();
      f.close();
    }
  },
);
