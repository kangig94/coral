import { describe, expect, it } from 'vitest';

import { createMonotonicClock, type MonotonicClock } from '#src/infra/monotonic-clock.js';
import { ControlLeaseEvidence } from '#src/provider-proxy/control-lease.js';

const scope = Symbol('control-lease-test');

function createFakeClock<Scope extends symbol>(
  clockScope: Scope,
  initialMilliseconds: number,
): {
  readonly clock: MonotonicClock<Scope>;
  set(milliseconds: number): void;
} {
  let milliseconds = initialMilliseconds;
  return {
    clock: createMonotonicClock(clockScope, { readMilliseconds: () => BigInt(milliseconds) }),
    set: (next) => {
      milliseconds = next;
    },
  };
}

describe('ControlLeaseEvidence', () => {
  it('rotates a mismatched challenge without moving round-trip evidence or control bounds', () => {
    const fake = createFakeClock(scope, 0);
    const evidence = new ControlLeaseEvidence(fake.clock, 5_000, fake.clock.now());
    evidence.issueFirstChallenge('c1');
    fake.set(1_000);
    expect(evidence.echoChallenge(fake.clock.now(), 'c1', 'c2')).toEqual({ accepted: true });
    const evidenceAt = evidence.lastRoundTripEvidenceAt();
    const controlLossAt = evidence.controlLossAt();
    fake.set(2_000);

    expect(evidence.echoChallenge(fake.clock.now(), 'c1', 'c3')).toEqual({
      accepted: false,
      reason: 'challenge-mismatch',
      nextChallenge: 'c3',
    });
    expect(fake.clock.compare(evidence.lastRoundTripEvidenceAt(), evidenceAt)).toBe(0);
    expect(fake.clock.compare(evidence.controlLossAt(), controlLossAt)).toBe(0);

    expect(evidence.echoChallenge(fake.clock.now(), 'c3', 'c4')).toEqual({ accepted: true });
  });
});
