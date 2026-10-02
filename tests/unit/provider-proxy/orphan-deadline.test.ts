import { describe, expect, it } from 'vitest';

import { createMonotonicClock, type MonotonicClock, type MonotonicInstant } from '#src/infra/monotonic-clock.js';
import {
  createEnforcerDeadlineStateMachine,
  DEFAULT_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS,
  PROXY_CONTROL_LEASE_MS,
  PROXY_TEARDOWN_RESERVE_MS,
  resolveProviderProxyDeadlineConfiguration,
  type EnforcerChallengePolicy,
  type ProviderProxyDeadlineConfiguration,
} from '#src/provider-proxy/orphan-deadline.js';
import { createControlHolderAuthority, type ControlHolderAuthority } from '#src/provider-proxy/holder-lifecycle.js';
import { testIncarnation } from '#tests/helpers/process-incarnation.js';

const guardianClockScope = Symbol('guardian-deadline-test');
const reaperClockScope = Symbol('reaper-deadline-test');

function configuration(raw?: string): ProviderProxyDeadlineConfiguration {
  return resolveProviderProxyDeadlineConfiguration({
    get: () => raw,
  });
}

function createFakeClock<Scope extends symbol>(
  scope: Scope,
  initialMilliseconds: number,
): {
  readonly clock: MonotonicClock<Scope>;
  set(milliseconds: number): void;
} {
  let milliseconds = initialMilliseconds;
  return {
    clock: createMonotonicClock(scope, {
      readMilliseconds: () => BigInt(milliseconds),
      sleep: async (duration) => {
        milliseconds += duration;
      },
    }),
    set: (next) => {
      milliseconds = next;
    },
  };
}

function expectSameInstant<Scope extends symbol>(
  clock: MonotonicClock<Scope>,
  actual: MonotonicInstant<Scope>,
  expected: MonotonicInstant<Scope>,
): void {
  expect(clock.compare(actual, expected)).toBe(0);
}

/** A deterministic, prefix-tagged minter, so distinct machines in the same test never collide by accident. */
function policy(prefix: string): EnforcerChallengePolicy {
  let count = 0;
  return { mintChallenge: () => `${prefix}-${(count += 1)}` };
}

/** Narrows an `{ accepted }`-discriminated result, failing the test loudly instead of silently continuing. */
function mustAccept<T extends { accepted: boolean }>(result: T): Extract<T, { accepted: true }> {
  if (!result.accepted) throw new Error(`Expected acceptance, got ${JSON.stringify(result)}`);
  return result as Extract<T, { accepted: true }>;
}

describe('provider proxy enforcer deadline evidence', () => {
  it('lets the enforcer bootstrap echo win after ordinary loss but never at adoption equality', () => {
    const acceptedFake = createFakeClock(guardianClockScope, 0);
    const accepted = createEnforcerDeadlineStateMachine(
      acceptedFake.clock,
      configuration(),
      policy('accepted'),
      createControlHolderAuthority(),
    );
    acceptedFake.set(PROXY_CONTROL_LEASE_MS + 100);
    const first = mustAccept(accepted.issueFirstChallenge());
    acceptedFake.set(DEFAULT_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS - PROXY_TEARDOWN_RESERVE_MS - 1);

    expect(accepted.echoChallenge(first.challenge)).toEqual({ accepted: true, nextChallenge: 'accepted-2' });
    expectSameInstant(acceptedFake.clock, accepted.bounds().lastRoundTripEvidenceAt, acceptedFake.clock.now());

    const equalityFake = createFakeClock(reaperClockScope, 0);
    const equality = createEnforcerDeadlineStateMachine(
      equalityFake.clock,
      configuration(),
      policy('equality'),
      createControlHolderAuthority(),
    );
    equalityFake.set(PROXY_CONTROL_LEASE_MS + 100);
    const equalityFirst = mustAccept(equality.issueFirstChallenge());
    const beforeEquality = equality.bounds();
    equalityFake.set(DEFAULT_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS - PROXY_TEARDOWN_RESERVE_MS);

    expect(equality.echoChallenge(equalityFirst.challenge)).toEqual({
      accepted: false,
      reason: 'teardown-latched',
    });
    expect(equality.state()).toBe('teardown-latched');
    const afterEquality = equality.bounds();
    expectSameInstant(
      equalityFake.clock,
      afterEquality.lastRoundTripEvidenceAt,
      beforeEquality.lastRoundTripEvidenceAt,
    );
    expect(afterEquality.eofAt).toBe(beforeEquality.eofAt);
    expectSameInstant(equalityFake.clock, afterEquality.controlLossAt, beforeEquality.controlLossAt);
    expectSameInstant(equalityFake.clock, afterEquality.exitDeadline, beforeEquality.exitDeadline);
    expectSameInstant(equalityFake.clock, afterEquality.adoptionDeadline, beforeEquality.adoptionDeadline);
  });

  it('does not move evidence for a stale or already-used challenge', () => {
    const fake = createFakeClock(guardianClockScope, 500);
    const guardian = createEnforcerDeadlineStateMachine(
      fake.clock,
      configuration(),
      policy('c'),
      createControlHolderAuthority(),
    );
    fake.set(1_000);
    const first = mustAccept(guardian.issueFirstChallenge());
    fake.set(1_100);
    guardian.echoChallenge(first.challenge);
    const before = guardian.bounds();
    fake.set(1_200);

    // The already-consumed challenge cannot re-earn evidence.
    expect(guardian.echoChallenge(first.challenge)).toEqual({
      accepted: false,
      reason: 'challenge-mismatch',
      nextChallenge: 'c-3',
    });
    const after = guardian.bounds();
    expectSameInstant(fake.clock, after.lastRoundTripEvidenceAt, before.lastRoundTripEvidenceAt);
    expect(after.eofAt).toBe(before.eofAt);
    expectSameInstant(fake.clock, after.controlLossAt, before.controlLossAt);
    expectSameInstant(fake.clock, after.exitDeadline, before.exitDeadline);
    expectSameInstant(fake.clock, after.adoptionDeadline, before.adoptionDeadline);
    expect(guardian.echoChallenge('c-3')).toEqual({ accepted: true, nextChallenge: 'c-4' });
  });
});

describe('provider proxy pairing loss', () => {
  it('collapses adoption to the pairing-loss instant, leaves exit and control-loss evidence untouched', () => {
    const fake = createFakeClock(reaperClockScope, 1_000);
    const reaper = createEnforcerDeadlineStateMachine(
      fake.clock,
      configuration(),
      policy('c'),
      createControlHolderAuthority(),
    );
    const before = reaper.bounds();
    fake.set(5_000);
    const pairingLossAt = fake.clock.now();

    reaper.observePairingLoss();
    const after = reaper.bounds();

    expectSameInstant(fake.clock, after.adoptionDeadline, pairingLossAt);
    expectSameInstant(fake.clock, after.exitDeadline, before.exitDeadline);
    expect(after.eofAt).toBeNull();
    expectSameInstant(fake.clock, after.controlLossAt, before.controlLossAt);
    expect(reaper.controlIsLive()).toBe(true);
  });
});

function installedHolder(): ControlHolderAuthority {
  const authority = createControlHolderAuthority();
  authority.install({
    controlEpoch: 1,
    holder: { instanceId: 'coordinator', pid: 4_000, incarnation: testIncarnation('coordinator') },
  });
  return authority;
}

describe('AC5 — a late heartbeat from a recovering coordinator is accepted once a holder is published', () => {
  it('stops latching teardown from elapsed time once the holder authority is published', () => {
    const fake = createFakeClock(guardianClockScope, 0);
    const authority = installedHolder();
    authority.publish();
    const guardian = createEnforcerDeadlineStateMachine(fake.clock, configuration(), policy('c'), authority);
    const first = mustAccept(guardian.issueFirstChallenge());
    // A published holder must not latch teardown without enforcement authorization.
    fake.set(DEFAULT_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS - PROXY_TEARDOWN_RESERVE_MS + 5_000);

    const echoed = guardian.echoChallenge(first.challenge);

    expect(echoed).toEqual({ accepted: true, nextChallenge: expect.any(String) });
    expect(guardian.state()).toBe('accepting-control');
  });

  it('still latches from elapsed time before publication (AC3’s provisional bootstrap window)', () => {
    const fake = createFakeClock(guardianClockScope, 0);
    const authority = installedHolder();
    const guardian = createEnforcerDeadlineStateMachine(fake.clock, configuration(), policy('c'), authority);
    const first = mustAccept(guardian.issueFirstChallenge());
    fake.set(DEFAULT_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS - PROXY_TEARDOWN_RESERVE_MS + 5_000);

    const echoed = guardian.echoChallenge(first.challenge);

    expect(echoed).toEqual({ accepted: false, reason: 'teardown-latched' });
    expect(guardian.state()).toBe('teardown-latched');
  });
});
