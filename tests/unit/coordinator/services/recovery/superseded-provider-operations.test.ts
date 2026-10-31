import { describe, expect, it, vi } from 'vitest';

import {
  createSupersededProviderOperationMaintenance,
  type CoordinatorJobRecoveryStatus,
} from '#src/coordinator/services/recovery/superseded-provider-operations.js';
import type { ProviderOperationRecord } from '#src/store/provider-operation-record.js';
import { VirtualTime } from '#tools/simulation/core/virtual-time.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';

const ROW = 'provider_operation_saga.v4:record:row';
const READABLE = 'provider_operation_saga.v5:record:readable';
const JOB = '00000000-0000-4000-8000-000000000001';

function world(
  options: Readonly<{ rowAlive?: boolean; readable?: ProviderOperationRecord; ownership?: 'undecided' }> = {},
) {
  const state = {
    rowAlive: options.rowAlive ?? false,
    rowPresent: true,
    ownership: options.ownership ?? ('unowned' as 'undecided' | 'unowned'),
    recoveryStatus: 'none' as CoordinatorJobRecoveryStatus,
  };
  const time = new VirtualTime();
  const retire = vi.fn(() => {
    if (!state.rowPresent) return { retiredKeys: [], retained: 0 };
    if (state.rowAlive) return { retiredKeys: [], retained: 1 };
    state.rowPresent = false;
    return { retiredKeys: [ROW], retained: 0 };
  });
  const recoverJob = vi.fn(async () => undefined);
  const retryRecovery = vi.fn(async () => {
    state.recoveryStatus = 'none';
    return 'advanced' as const;
  });
  const adoptReadable = vi.fn(async () => 'accepted' as 'accepted' | 'refused');
  const onObligationChange = vi.fn();
  const maintenance = createSupersededProviderOperationMaintenance({
    time,
    retire,
    releaseOwnership: () =>
      options.readable === undefined
        ? { released: 1, releasedJobIds: [JOB], readableRecords: [] }
        : { released: 0, releasedJobIds: [], readableRecords: [{ recordKey: READABLE, record: options.readable }] },
    resolveRetiredStatus: async () => true,
    adoptReadable,
    ownership: () => state.ownership,
    recoveryStatus: () => state.recoveryStatus,
    recoverJob,
    retryRecovery,
    completeRecovery: () => {},
    onObligationChange,
    log: () => {},
  });
  return { state, time, retire, recoverJob, retryRecovery, adoptReadable, onObligationChange, maintenance };
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
}

describe('superseded provider operation maintenance', () => {
  it('should recover the job a superseded row fenced once its processes die after startup', async () => {
    const { state, time, recoverJob, onObligationChange, maintenance } = world({ rowAlive: true });

    maintenance.start();
    await settle();
    expect(recoverJob).not.toHaveBeenCalled();

    state.rowAlive = false;
    time.tick(5_000);
    await settle();

    expect(recoverJob).toHaveBeenCalledWith(JOB, expect.any(AbortSignal));
    expect(onObligationChange).toHaveBeenCalledOnce();
    await expect(maintenance.pass()).resolves.toEqual({ kind: 'settled' });
  });

  it('should retry a recovery that settled into quarantine after the row naming the job was retired', async () => {
    const { state, recoverJob, retryRecovery, maintenance } = world();
    recoverJob.mockImplementationOnce(async () => {
      state.recoveryStatus = 'active';
    });

    await expect(maintenance.pass()).resolves.toMatchObject({ kind: 'holding', pendingJobIds: [JOB] });
    expect(retryRecovery).not.toHaveBeenCalled();

    await expect(maintenance.pass()).resolves.toEqual({ kind: 'settled' });
    expect(retryRecovery).toHaveBeenCalledWith(JOB, expect.any(AbortSignal));
  });

  it('should retry a recovery that threw after the row naming the job was retired', async () => {
    const { recoverJob, maintenance } = world();
    recoverJob.mockRejectedValueOnce(new Error('journal busy'));

    await expect(maintenance.pass()).resolves.toMatchObject({ kind: 'holding', pendingJobIds: [JOB] });
    await expect(maintenance.pass()).resolves.toEqual({ kind: 'settled' });
    expect(recoverJob).toHaveBeenCalledTimes(2);
  });

  it('should keep a readable operation the retired row exposed until its owner accepts it', async () => {
    const readable = providerOperationRecord('executing');
    const { adoptReadable, maintenance } = world({ readable });
    adoptReadable.mockResolvedValueOnce('refused');

    await expect(maintenance.pass()).resolves.toMatchObject({ kind: 'holding', unadoptedRecords: [READABLE] });
    await expect(maintenance.pass()).resolves.toEqual({ kind: 'settled' });
    expect(adoptReadable).toHaveBeenLastCalledWith(readable, READABLE);
  });

  it('should hold a job an unattributable row may still name without recovering it', async () => {
    const { recoverJob, maintenance } = world({ ownership: 'undecided' });

    await expect(maintenance.pass()).resolves.toMatchObject({ kind: 'holding', pendingJobIds: [JOB] });
    expect(recoverJob).not.toHaveBeenCalled();
  });

  it('should leave no pass scheduled once quiesced, even when the pass it joined was still holding', async () => {
    const { state, time, retire, recoverJob, maintenance } = world();
    let finishRecovery!: () => void;
    recoverJob.mockImplementationOnce(
      () =>
        new Promise<undefined>((resolve) => {
          finishRecovery = () => {
            state.recoveryStatus = 'active';
            resolve(undefined);
          };
        }),
    );

    maintenance.start();
    await settle();
    const quiesced = maintenance.quiesce();
    finishRecovery();
    await quiesced;
    time.tick(120_000);
    await settle();

    expect(retire).toHaveBeenCalledOnce();
  });

  it('should not touch the journal once stopped', async () => {
    const { state, time, retire, maintenance } = world({ rowAlive: true });

    maintenance.start();
    await settle();
    await maintenance.stop();
    state.rowAlive = false;
    time.tick(120_000);
    await settle();

    expect(retire).toHaveBeenCalledOnce();
    expect(state.rowPresent).toBe(true);
  });
});
