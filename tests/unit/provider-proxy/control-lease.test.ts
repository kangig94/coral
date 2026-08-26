import { describe, expect, it } from 'vitest';

import { createMonotonicClock, type MonotonicClock } from '#src/infra/monotonic-clock.js';
import { ControlLeaseEvidence, RECENT_CHALLENGE_HISTORY } from '#src/provider-proxy/control-lease.js';

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
  it('accepts a matching echo after lease expiry and records the acceptance instant', () => {
    const fake = createFakeClock(scope, 0);
    const evidence = new ControlLeaseEvidence(fake.clock, 5_000, fake.clock.now());
    expect(evidence.issueFirstChallenge('c1')).toBe(true);
    fake.set(20_000);
    expect(evidence.isControlLive(fake.clock.now())).toBe(false);

    expect(evidence.echoChallenge(fake.clock.now(), 'c1', 'c2')).toEqual({ accepted: true });

    expect(evidence.isControlLive(fake.clock.now())).toBe(true);
    expect(fake.clock.compare(evidence.lastRoundTripEvidenceAt(), fake.clock.now())).toBe(0);
  });

  it('accepts a matching successor echo and every later matching echo after ordinary control loss', () => {
    const fake = createFakeClock(scope, 0);
    const evidence = new ControlLeaseEvidence(fake.clock, 5_000, fake.clock.now());
    evidence.issueFirstChallenge('incumbent-1');
    fake.set(20_000);
    evidence.beginSuccessorControl('successor-1');

    expect(evidence.echoChallenge(fake.clock.now(), 'successor-1', 'successor-2')).toEqual({ accepted: true });

    fake.set(30_000);
    expect(evidence.isControlLive(fake.clock.now())).toBe(false);
    expect(evidence.echoChallenge(fake.clock.now(), 'successor-2', 'successor-3')).toEqual({ accepted: true });
  });

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

  it('evicts the oldest remembered challenge once history exceeds its bound, freeing it for reuse', () => {
    const fake = createFakeClock(scope, 0);
    const evidence = new ControlLeaseEvidence(fake.clock, 1_000_000, fake.clock.now());
    evidence.issueFirstChallenge('c0');

    let previous = 'c0';
    for (let index = 1; index <= RECENT_CHALLENGE_HISTORY; index += 1) {
      const next = `c${index}`;
      expect(evidence.echoChallenge(fake.clock.now(), previous, next)).toEqual({ accepted: true });
      previous = next;
    }

    expect(evidence.echoChallenge(fake.clock.now(), previous, 'c0')).toEqual({ accepted: true });
    expect(() => evidence.echoChallenge(fake.clock.now(), 'c0', 'c2')).toThrow(/non-empty and one-use/u);
  });

  it('refuses a second first challenge once one is already outstanding', () => {
    const fake = createFakeClock(scope, 0);
    const evidence = new ControlLeaseEvidence(fake.clock, 5_000, fake.clock.now());

    expect(evidence.issueFirstChallenge('c1')).toBe(true);
    expect(evidence.issueFirstChallenge('c2')).toBe(false);
  });

  it('clears an observed EOF when a live connection carries the tenancy forward again', () => {
    const fake = createFakeClock(scope, 0);
    const evidence = new ControlLeaseEvidence(fake.clock, 5_000, fake.clock.now());
    evidence.issueFirstChallenge('c1');
    fake.set(1_500);
    evidence.observeEof(fake.clock.now());
    expect(evidence.eofAt()).not.toBeNull();

    evidence.reattachControl();

    expect(evidence.eofAt()).toBeNull();
    fake.set(1_600);
    expect(evidence.echoChallenge(fake.clock.now(), 'c1', 'c2')).toEqual({ accepted: true });
  });
});
