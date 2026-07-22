import { describe, expect, it } from 'vitest';
import { acquireProviderHostPin, releaseProviderHostPin } from '#src/coordinator/live/provider-hosts/lease.js';
import { createEntry, randomSequence } from '#tests/unit/coordinator/live/provider-hosts/helpers.js';

describe('provider host lease properties', () => {
  it('rejects release-before-acquire as a pin ownership defect', () => {
    const entry = createEntry();

    expect(() => releaseProviderHostPin(entry)).toThrow('pin count underflow');
    expect(entry.pinCount).toBe(0);
  });

  it('tracks balanced pin ownership across 100 random sequences of length up to 50', () => {
    for (let seed = 1; seed <= 100; seed += 1) {
      const entry = createEntry();
      const sequence = randomSequence(seed);
      let expectedPins = 0;

      for (const step of sequence) {
        if (step % 2 === 0 || expectedPins === 0) {
          acquireProviderHostPin(entry);
          expectedPins += 1;
        } else {
          releaseProviderHostPin(entry);
          expectedPins -= 1;
        }
        expect(entry.pinCount).toBe(expectedPins);
      }
    }
  });
});
