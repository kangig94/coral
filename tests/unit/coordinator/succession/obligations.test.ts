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
  it('blocks owners missing from the target declaration without asking them to transfer', async () => {
    const classify = vi.fn(async () => ({ kind: 'completed' as const, reason: 'settled' }));
    const owner: SuccessionOwner = { id: 'launch-admission', classify };

    const result = await prepareOwnerObligations([owner], 'attempt', { ...capabilities, accepts: [] }, [owner.id]);

    expect(result).toEqual({
      kind: 'blocking',
      blockers: [{ owner: owner.id, reason: 'target does not declare this owner contract' }],
    });
    expect(classify).not.toHaveBeenCalled();
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
    expect(await prepareOwnerObligations([owner], 'other-attempt', capabilities, [owner.id])).toMatchObject({
      kind: 'blocking',
    });
    expect(await prepareOwnerObligations([], 'attempt', capabilities, [owner.id])).toEqual({
      kind: 'blocking',
      blockers: [{ owner: owner.id, reason: 'owner disposition unavailable' }],
    });
  });
});
