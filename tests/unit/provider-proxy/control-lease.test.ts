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
  it('clamps the outstanding challenge expiry to the given ceiling, and applies none when null', () => {
    const fake = createFakeClock(scope, 0);
    const evidence = new ControlLeaseEvidence(fake.clock, 5_000);
    fake.set(1_000);
    const issuedAt = fake.clock.now();
    evidence.issueFirstChallenge('c1', issuedAt);
    const leaseExpiry = fake.clock.shiftMilliseconds(issuedAt, 5_000);
    const earlyCeiling = fake.clock.shiftMilliseconds(issuedAt, 2_000);
    const lateCeiling = fake.clock.shiftMilliseconds(issuedAt, 9_000);

    // A ceiling earlier than the lease wins.
    expect(
      fake.clock.compare(
        evidence.challengeExpiresAt({ coordinatorIsLive: true, expiryCeiling: earlyCeiling })!,
        earlyCeiling,
      ),
    ).toBe(0);
    // A ceiling later than the lease never pushes expiry out past the lease itself.
    expect(
      fake.clock.compare(
        evidence.challengeExpiresAt({ coordinatorIsLive: true, expiryCeiling: lateCeiling })!,
        leaseExpiry,
      ),
    ).toBe(0);
    // No ceiling at all is the plain lease expiry.
    expect(
      fake.clock.compare(evidence.challengeExpiresAt({ coordinatorIsLive: true, expiryCeiling: null })!, leaseExpiry),
    ).toBe(0);
  });

  it('refuses an echo past a clamped ceiling even though the lease itself has not expired', () => {
    const fake = createFakeClock(scope, 0);
    const evidence = new ControlLeaseEvidence(fake.clock, 5_000);
    fake.set(1_000);
    evidence.issueFirstChallenge('c1', fake.clock.now());
    const earlyCeiling = fake.clock.shiftMilliseconds(fake.clock.now(), 2_000);
    fake.set(3_001);

    expect(
      evidence.echoChallenge(fake.clock.now(), 'c1', 'c2', { coordinatorIsLive: true, expiryCeiling: earlyCeiling }),
    ).toEqual({ accepted: false, reason: 'challenge-expired' });
  });

  it('allows exactly the first successor echo after control loss, then enforces liveness again', () => {
    const fake = createFakeClock(scope, 0);
    const evidence = new ControlLeaseEvidence(fake.clock, 5_000);
    fake.set(1_000);
    evidence.issueFirstChallenge('c1', fake.clock.now());
    fake.set(1_100);
    evidence.echoChallenge(fake.clock.now(), 'c1', 'c2', { coordinatorIsLive: true, expiryCeiling: null });
    fake.set(20_000);
    expect(evidence.isControlLive(fake.clock.now())).toBe(false);

    evidence.beginSuccessorControl('successor-1', fake.clock.now());
    // The successor's bootstrap echo is allowed despite control being lost — that loss is the precondition
    // for the successor existing at all.
    expect(
      evidence.echoChallenge(fake.clock.now(), 'successor-1', 'successor-2', {
        coordinatorIsLive: true,
        expiryCeiling: null,
      }),
    ).toEqual({ accepted: true });

    // The bypass does not carry forward: once the lease it just re-established lapses again, the very next
    // challenge is refused like any ordinary one.
    fake.set(26_000);
    expect(
      evidence.echoChallenge(fake.clock.now(), 'successor-2', 'successor-3', {
        coordinatorIsLive: true,
        expiryCeiling: null,
      }),
    ).toEqual({ accepted: false, reason: 'control-lost' });
  });

  it('evicts the oldest remembered challenge once history exceeds its bound, freeing it for reuse', () => {
    const fake = createFakeClock(scope, 0);
    // A lease this long keeps every round trip in this test well inside it, so only the history bound is
    // under test, not expiry.
    const evidence = new ControlLeaseEvidence(fake.clock, 1_000_000);
    evidence.issueFirstChallenge('c0', fake.clock.now());

    let previous = 'c0';
    for (let index = 1; index <= RECENT_CHALLENGE_HISTORY; index += 1) {
      const next = `c${index}`;
      expect(
        evidence.echoChallenge(fake.clock.now(), previous, next, { coordinatorIsLive: true, expiryCeiling: null }),
      ).toEqual({ accepted: true });
      previous = next;
    }

    // Installing the RECENT_CHALLENGE_HISTORY-th successor pushed the set past its bound, evicting the very
    // first challenge — so it is free to reuse as a value.
    expect(
      evidence.echoChallenge(fake.clock.now(), previous, 'c0', { coordinatorIsLive: true, expiryCeiling: null }),
    ).toEqual({ accepted: true });

    // A value still inside the retained window is not free: reusing one throws the one-use invariant.
    expect(() =>
      evidence.echoChallenge(fake.clock.now(), 'c0', 'c2', { coordinatorIsLive: true, expiryCeiling: null }),
    ).toThrow(/non-empty and one-use/u);
  });

  it('refuses a second first challenge once one is already outstanding', () => {
    const fake = createFakeClock(scope, 0);
    const evidence = new ControlLeaseEvidence(fake.clock, 5_000);

    expect(evidence.issueFirstChallenge('c1', fake.clock.now())).toBe(true);
    expect(evidence.issueFirstChallenge('c2', fake.clock.now())).toBe(false);
  });
});
