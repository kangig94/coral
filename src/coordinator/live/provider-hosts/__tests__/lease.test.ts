import { describe, expect, it } from 'vitest';
import { acquireSharedProviderServerLease, releaseSharedProviderServerLease } from '../lease.js';
import { createEntry, randomSequence } from './helpers.js';

describe('provider host lease properties', () => {
  it('keeps sharedLeaseCount non-negative across 100 random sequences of length up to 50', () => {
    for (let seed = 1; seed <= 100; seed += 1) {
      const entry = createEntry();
      const sequence = randomSequence(seed);

      for (const step of sequence) {
        if (step % 2 === 0) {
          acquireSharedProviderServerLease(entry);
        } else {
          releaseSharedProviderServerLease(entry, () => {});
        }
        expect(entry.sharedLeaseCount).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
