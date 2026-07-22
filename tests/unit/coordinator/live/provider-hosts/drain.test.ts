import { describe, expect, it } from 'vitest';
import { acquireProviderHostPin, releaseProviderHostPin } from '#src/coordinator/live/provider-hosts/lease.js';
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
        if (step % 2 === 0 || entry.pinCount === 0) {
          acquireProviderHostPin(entry);
          acquiredLeaseCount += 1;
        } else {
          releaseProviderHostPin(entry);
          releasedLeaseCount += 1;
        }
      }

      const outstandingBeforeDrain = entry.pinCount;
      await closeProviderServerEntry(entry, 'drained', {
        runtime,
        entries,
        shutdownHandle: async () => {},
      });

      expect(entry.pinCount).toBe(outstandingBeforeDrain);
      expect(acquiredLeaseCount).toBe(releasedLeaseCount + outstandingBeforeDrain);
      for (let remaining = outstandingBeforeDrain; remaining > 0; remaining -= 1) {
        releaseProviderHostPin(entry);
      }
      expect(entry.pinCount).toBe(0);
    }
  });
});
