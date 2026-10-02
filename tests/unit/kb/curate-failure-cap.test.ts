import { describe, expect, it } from 'vitest';
import { applyClearCurateRetryState, INVARIANT, readCurateState } from '#src/kb/curate/state/index.js';
import { openKbTestStoreDb } from '#tests/helpers/store-db.js';

describe('curate scheduler failure cap (S2)', () => {
  it('applyClearCurateRetryState resets BOTH lane counters and the disabled-at stamps so an operator can re-enable scheduling', () => {
    const db = openKbTestStoreDb(':memory:');
    try {
      const seeded = {
        ...readCurateState(db),
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
    } finally {
      db.close();
    }
  });
});
