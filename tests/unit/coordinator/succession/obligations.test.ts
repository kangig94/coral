import { describe, expect, it, vi } from 'vitest';

import { prepareOwnerObligations, type SuccessionOwner } from '#src/coordinator/succession/obligations.js';
import type { SuccessionCapabilities } from '#src/coordinator/succession/protocol.js';

const capabilities: SuccessionCapabilities = {
  version: 'v1',
  buildSetId: 'build',
  bundleHash: 'hash',
  protocols: ['prepare'],
  accepts: [{ owner: 'launch-admission', generation: 1 }],
};

describe('succession owner preparation', () => {
  it('allows a completed owner without declaring a transfer contract', async () => {
    const classify = vi.fn(async () => ({ kind: 'completed' as const, reason: 'settled' }));
    const owner: SuccessionOwner = { id: 'launch-admission', classify };

    const result = await prepareOwnerObligations([owner], 'attempt', { ...capabilities, accepts: [] }, [owner.id]);

    expect(result).toEqual({ kind: 'prepared', receipts: [] });
    expect(classify).toHaveBeenCalledOnce();
  });

  it('requires a matching receipt and an attempt-scoped recovery grant', async () => {
    const owner: SuccessionOwner = {
      id: 'launch-admission',
      classify: async () => ({
        kind: 'transferable',
        reason: 'carrier survives',
        receipt: {
          owner: 'launch-admission',
          generation: 1,
          attemptId: 'attempt',
          receiptId: 'receipt',
          recoveryGrantId: 'grant',
          payload: {},
        },
      }),
    };

    expect(await prepareOwnerObligations([owner], 'attempt', capabilities, [owner.id])).toMatchObject({
      kind: 'prepared',
      receipts: [{ receiptId: 'receipt', recoveryGrantId: 'grant' }],
    });
    expect(
      await prepareOwnerObligations(
        [owner],
        'attempt',
        {
          ...capabilities,
          accepts: [{ owner: owner.id, generation: 2 }],
        },
        [owner.id],
      ),
    ).toMatchObject({
      kind: 'blocking',
      blockers: [{ owner: owner.id, reason: 'transfer receipt or recovery grant does not match the attempt' }],
    });
    expect(await prepareOwnerObligations([owner], 'other-attempt', capabilities, [owner.id])).toMatchObject({
      kind: 'blocking',
    });
    expect(await prepareOwnerObligations([], 'attempt', capabilities, [owner.id])).toEqual({
      kind: 'blocking',
      blockers: [{ owner: owner.id, reason: 'owner disposition unavailable' }],
    });
  });

  it('blocks a non-terminal job without exactly one owner claim', async () => {
    const owner: SuccessionOwner = {
      id: 'launch-admission',
      classify: async () => ({ kind: 'completed', reason: 'no pending launch' }),
    };

    expect(await prepareOwnerObligations([owner], 'attempt', capabilities, [owner.id], () => ['live-job'])).toEqual({
      kind: 'blocking',
      blockers: [{ owner: 'jobs', reason: 'unclaimed: live-job' }],
    });
  });

  it('requires a transferable owner receipt for an external carrier without a status row', async () => {
    const owner: SuccessionOwner = {
      id: 'provider-hosts',
      classify: async (attemptId) => ({
        kind: 'transferable',
        reason: 'external carrier accepted',
        jobIds: ['external-job'],
        receipt: {
          owner: 'provider-hosts',
          generation: 1,
          attemptId,
          receiptId: 'external-receipt',
          recoveryGrantId: 'external-grant',
          payload: { jobId: 'external-job' },
        },
      }),
    };
    const accepts = [{ owner: owner.id, generation: 1 }];

    expect(
      await prepareOwnerObligations([owner], 'attempt', { ...capabilities, accepts }, [owner.id], () => [
        'external-job',
      ]),
    ).toMatchObject({ kind: 'prepared', receipts: [{ receiptId: 'external-receipt' }] });
    expect(
      await prepareOwnerObligations([owner], 'attempt', { ...capabilities, accepts: [] }, [owner.id], () => [
        'external-job',
      ]),
    ).toMatchObject({ kind: 'blocking' });
  });

  it('blocks when an owner cannot answer or another owner also claims the job', async () => {
    const launch: SuccessionOwner = {
      id: 'launch-admission',
      classify: async () => ({ kind: 'blocking', reason: 'carrier acquisition', jobIds: ['job'] }),
    };
    const durable: SuccessionOwner = {
      id: 'durable-cli',
      classify: async () => ({ kind: 'blocking', reason: 'carrier running', jobIds: ['job'] }),
    };
    const accepts = [...capabilities.accepts, { owner: durable.id, generation: 1 }];

    expect(
      await prepareOwnerObligations(
        [launch, durable],
        'attempt',
        { ...capabilities, accepts },
        [launch.id, durable.id],
        () => ['job'],
      ),
    ).toMatchObject({
      kind: 'blocking',
      blockers: expect.arrayContaining([
        { owner: 'launch-admission', reason: 'carrier acquisition' },
        { owner: 'durable-cli', reason: 'carrier running' },
        { owner: 'jobs', reason: 'multiply claimed: job' },
      ]),
    });

    const unavailable: SuccessionOwner = {
      id: 'launch-admission',
      classify: async () => {
        throw new Error('lost');
      },
    };
    expect(await prepareOwnerObligations([unavailable], 'attempt', capabilities, [unavailable.id])).toEqual({
      kind: 'blocking',
      blockers: [{ owner: unavailable.id, reason: 'owner disposition unavailable' }],
    });
  });

  it('records a skipped grant owner’s read-only blocker without classifying it', async () => {
    const classify = vi.fn(async () => ({ kind: 'completed' as const, reason: 'no live sets' }));
    const owners: SuccessionOwner[] = [
      {
        id: 'provider-operations',
        recordsGrants: true,
        classify: async () => ({ kind: 'blocking', reason: 'successor does not accept host control generation 1' }),
      },
      {
        id: 'provider-proxy-sets',
        recordsGrants: true,
        inspectBlocker: () => 'successor does not accept host control generation 1',
        classify,
      },
    ];

    expect(
      await prepareOwnerObligations(
        owners,
        'attempt',
        capabilities,
        owners.map((owner) => owner.id),
      ),
    ).toEqual({
      kind: 'blocking',
      blockers: [
        { owner: 'provider-operations', reason: 'successor does not accept host control generation 1' },
        { owner: 'provider-proxy-sets', reason: 'successor does not accept host control generation 1' },
      ],
    });
    expect(classify).not.toHaveBeenCalled();
  });
});
