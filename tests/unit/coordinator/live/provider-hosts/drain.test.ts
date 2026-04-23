import { describe, expect, it } from 'vitest';
import { acquireSharedProviderServerLease, releaseSharedProviderServerLease } from '#src/coordinator/live/provider-hosts/lease.js';
import { closeProviderServerEntry } from '#src/coordinator/live/provider-hosts/drain.js';
import { createEntry, randomSequence, runtime } from '#tests/unit/coordinator/live/provider-hosts/helpers.js';

describe('provider host drain properties', () => {
  it('balances acquired and released leases at drain completion across 100 random sequences', async () => {
    for (let seed = 1; seed <= 100; seed += 1) {
      const entry = createEntry();
      const entries = new Map([[entry.hostKey, entry]]);
      let acquiredLeaseCount = 0;
      let releasedLeaseCount = 0;

      for (const step of randomSequence(seed)) {
        if (step % 2 === 0) {
          acquireSharedProviderServerLease(entry);
          acquiredLeaseCount += 1;
        } else {
          const before = entry.sharedLeaseCount;
          releaseSharedProviderServerLease(entry, () => {});
          if (before > entry.sharedLeaseCount) {
            releasedLeaseCount += 1;
          }
        }
      }

      const outstandingBeforeDrain = entry.sharedLeaseCount;
      await closeProviderServerEntry(entry, 'drained', {
        runtime,
        entries,
        shutdownHandle: async () => {},
      });

      expect(entry.sharedLeaseCount).toBe(0);
      expect(acquiredLeaseCount).toBe(releasedLeaseCount + outstandingBeforeDrain);
    }
  });
});
