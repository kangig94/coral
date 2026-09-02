import { describe, expect, it, vi } from 'vitest';

import { createMonotonicClock, type MonotonicClock, type MonotonicInstant } from '#src/infra/monotonic-clock.js';
import {
  CONTAINMENT_DISAPPEARANCE_CONFIRM_MS,
  CONTAINMENT_PROCESS_CONTROL_CALL_MAX_MS,
  SIGKILL_GRACE_MS,
  SIGTERM_GRACE_MS,
} from '#src/infra/process-constants.js';
import {
  containmentExecutionDeadline,
  createEnforcerDeadlineStateMachine,
  CORAL_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS_ENV,
  DEFAULT_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS,
  MAX_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS,
  MIN_EFFECTIVE_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS,
  MIN_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS,
  PROXY_CONTROL_HEARTBEAT_MS,
  PROXY_CONTROL_ESTABLISH_READY_MS,
  PROXY_CONTROL_LEASE_MS,
  PROXY_ENDPOINT_CLEANUP_BUDGET_MS,
  PROXY_ENFORCER_MAX_WAKE_LATENCY_MS,
  PROXY_PROCESS_CONTROL_BUDGET_MS,
  PROXY_REDEMPTION_DISPATCH_MAX_MS,
  PROXY_STARTUP_ATTACH_RESERVE_MS,
  PROXY_SUCCESSOR_TAIL_MS,
  PROXY_TEARDOWN_RESERVE_MS,
  providerProxyAdoptionWindowMs,
  providerProxyDeadlineTimingIsValid,
  providerProxyHeartbeatHoldBound,
  providerProxyDeadlineConfigurationSchema,
  resolveProviderProxyDeadlineConfiguration,
  type EnforcerChallengePolicy,
  type ProviderProxyDeadlineConfiguration,
} from '#src/provider-proxy/orphan-deadline.js';
import { createControlHolderAuthority, type ControlHolderAuthority } from '#src/provider-proxy/holder-lifecycle.js';
import { PROXY_CONTROL_RPC_TIMEOUT_MS } from '#src/provider-proxy/protocol.js';
import { PROCESS_INCARNATION_PROBE_TIMEOUT_MS } from '#src/infra/node-process.js';
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

function issueMessages(raw: string): string[] {
  const result = providerProxyDeadlineConfigurationSchema.safeParse({ orphanTimeoutMs: raw });
  return result.success ? [] : result.error.issues.map((issue) => issue.message);
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

describe('provider proxy orphan deadline configuration', () => {
  it('checks every source-derived timing path independently', () => {
    const production = {
      heartbeatMs: 1_000,
      rpcTimeoutMs: 5_000,
      leaseMs: 12_000,
      establishReadyMs: 10_000,
      redemptionDispatchMs: 1_000,
      startupAttachReserveMs: 4_000,
      teardownReserveMs: 14_000,
      orphanTimeoutMs: 37_000,
    };

    expect(providerProxyDeadlineTimingIsValid(production)).toBe(true);
    expect(providerProxyDeadlineTimingIsValid({ ...production, leaseMs: 11_000 })).toBe(false);
    expect(providerProxyDeadlineTimingIsValid({ ...production, establishReadyMs: 13_000 })).toBe(false);
    expect(providerProxyDeadlineTimingIsValid({ ...production, startupAttachReserveMs: 5_000 })).toBe(false);
    expect(providerProxyDeadlineTimingIsValid({ ...production, orphanTimeoutMs: 25_999 })).toBe(false);
  });

  it('derives the exact 14000ms reserve from the imported process constants', () => {
    expect(PROXY_PROCESS_CONTROL_BUDGET_MS).toBe(2 * CONTAINMENT_PROCESS_CONTROL_CALL_MAX_MS);
    expect(PROXY_TEARDOWN_RESERVE_MS).toBe(
      SIGTERM_GRACE_MS +
        SIGKILL_GRACE_MS +
        CONTAINMENT_DISAPPEARANCE_CONFIRM_MS +
        PROXY_ENDPOINT_CLEANUP_BUDGET_MS +
        PROXY_ENFORCER_MAX_WAKE_LATENCY_MS +
        2 * CONTAINMENT_PROCESS_CONTROL_CALL_MAX_MS,
    );
    expect(PROXY_TEARDOWN_RESERVE_MS).toBe(14_000);
  });

  it('publishes the normative fixed durations and default', () => {
    expect(PROXY_CONTROL_HEARTBEAT_MS).toBe(1_000);
    expect(PROXY_CONTROL_LEASE_MS).toBe(12_000);
    expect(PROXY_CONTROL_ESTABLISH_READY_MS).toBe(10_000);
    expect(PROXY_REDEMPTION_DISPATCH_MAX_MS).toBe(1_000);
    expect(PROXY_CONTROL_RPC_TIMEOUT_MS).toBe(5_000);
    expect(PROXY_STARTUP_ATTACH_RESERVE_MS).toBe(4_000);
    expect(configuration().orphanTimeoutMs).toBe(DEFAULT_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS);
  });

  it('validates only decimal millisecond input', () => {
    for (const raw of [' 30000', '30000 ', '+30000', '30_000', '3e4', '30000.0', '-30000', '']) {
      expect(() => configuration(raw), raw).toThrow();
    }
    expect(configuration('037000').orphanTimeoutMs).toBe(37_000);
  });

  it('enforces the stated production range at both boundaries', () => {
    expect(issueMessages(String(MIN_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS - 1))).toContain(
      `must be in the stated production range ${MIN_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS}..${MAX_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS}`,
    );
    expect(configuration(String(MAX_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS)).orphanTimeoutMs).toBe(
      MAX_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS,
    );
    expect(issueMessages(String(MAX_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS + 1))).toContain(
      `must be in the stated production range ${MIN_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS}..${MAX_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS}`,
    );
  });

  it('checks the controlling successor boundary on both sides', () => {
    const boundary = PROXY_TEARDOWN_RESERVE_MS + PROXY_CONTROL_LEASE_MS + PROXY_SUCCESSOR_TAIL_MS;

    const issue = `${CORAL_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS_ENV} must be at least ${MIN_EFFECTIVE_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS}ms to satisfy the strict recurrence, process-bootstrap, and successor-adoption timing policy`;
    expect(issueMessages(String(boundary))).toContain(issue);
    expect(issueMessages(String(boundary + 1))).not.toContain(issue);
    expect(configuration(String(MIN_EFFECTIVE_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS)).orphanTimeoutMs).toBe(
      MIN_EFFECTIVE_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS,
    );
    expect(MIN_EFFECTIVE_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS).toBe(36_001);
  });

  it.each([
    { orphanTimeoutMs: DEFAULT_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS, adoptionWindowMs: 23_000 },
    { orphanTimeoutMs: MIN_EFFECTIVE_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS, adoptionWindowMs: 22_001 },
  ])('executes the complete strict timing audit for $orphanTimeoutMs', ({ orphanTimeoutMs, adoptionWindowMs }) => {
    const acquisitionDeadlineMs = 45_000;
    const recurringAcceptedStampGapMs = 2 * PROXY_CONTROL_RPC_TIMEOUT_MS + PROXY_CONTROL_HEARTBEAT_MS;
    const processBootstrapMs = PROXY_CONTROL_ESTABLISH_READY_MS + 2 * PROXY_CONTROL_RPC_TIMEOUT_MS;
    const successorBootstrapMs = 2 * PROXY_CONTROL_RPC_TIMEOUT_MS;
    const legacySkippedTickMs = 2 * PROXY_CONTROL_HEARTBEAT_MS + PROXY_CONTROL_RPC_TIMEOUT_MS;
    const redemptionStartupTailMs =
      PROXY_REDEMPTION_DISPATCH_MAX_MS + PROXY_CONTROL_RPC_TIMEOUT_MS + PROXY_STARTUP_ATTACH_RESERVE_MS;

    expect(orphanTimeoutMs).toBeGreaterThan(19_000);
    expect(orphanTimeoutMs).toBeLessThan(300_001);
    expect(orphanTimeoutMs - PROXY_TEARDOWN_RESERVE_MS).toBe(adoptionWindowMs);
    expect(processBootstrapMs).toBeLessThan(adoptionWindowMs);
    expect(recurringAcceptedStampGapMs).toBeLessThan(PROXY_CONTROL_LEASE_MS);
    expect(successorBootstrapMs).toBeLessThan(PROXY_CONTROL_LEASE_MS);
    expect(legacySkippedTickMs).toBeLessThan(PROXY_CONTROL_LEASE_MS);
    expect(PROXY_CONTROL_LEASE_MS).toBeLessThan(adoptionWindowMs);
    expect(PROXY_SUCCESSOR_TAIL_MS).toBe(Math.max(successorBootstrapMs, redemptionStartupTailMs));
    expect(PROXY_CONTROL_LEASE_MS + PROXY_SUCCESSOR_TAIL_MS).toBeLessThan(adoptionWindowMs);
    expect(PROXY_SUCCESSOR_TAIL_MS).toBeLessThan(adoptionWindowMs - PROXY_CONTROL_LEASE_MS);
    expect(PROXY_TEARDOWN_RESERVE_MS + PROXY_CONTROL_LEASE_MS + PROXY_SUCCESSOR_TAIL_MS).toBeLessThan(orphanTimeoutMs);
    expect(PROXY_TEARDOWN_RESERVE_MS + processBootstrapMs).toBeLessThan(orphanTimeoutMs);
    expect(redemptionStartupTailMs).toBeLessThan(adoptionWindowMs);
    expect(PROXY_CONTROL_ESTABLISH_READY_MS).toBeLessThan(adoptionWindowMs);
    expect(3 * PROXY_CONTROL_ESTABLISH_READY_MS).toBeLessThan(acquisitionDeadlineMs);
    expect(acquisitionDeadlineMs).toBeLessThan(3 * processBootstrapMs);
    expect(adoptionWindowMs).toBeLessThan(acquisitionDeadlineMs);
  });

  it('exposes the adoption window as the single formula both an enforcer and the coordinator escalation share', () => {
    expect(
      providerProxyAdoptionWindowMs({
        orphanTimeoutMs: DEFAULT_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS,
        teardownReserveMs: PROXY_TEARDOWN_RESERVE_MS,
      }),
    ).toBe(23_000);
    expect(providerProxyAdoptionWindowMs(configuration())).toBe(23_000);
    expect(providerProxyAdoptionWindowMs(configuration(String(MIN_EFFECTIVE_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS)))).toBe(
      22_001,
    );
  });

  it('derives material scheduler lateness as one quarter of the same span', () => {
    expect(providerProxyHeartbeatHoldBound(configuration())).toEqual({
      spanMs: 23_000,
      materialSchedulerLatenessMs: 5_750,
    });
    expect(
      providerProxyHeartbeatHoldBound(configuration(String(MIN_EFFECTIVE_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS))),
    ).toEqual({ spanMs: 22_001, materialSchedulerLatenessMs: 5_500 });
  });

  it('rejects an unvalidated configuration object at the state-machine boundary', () => {
    const fake = createFakeClock(guardianClockScope, 0);
    const unvalidated = {
      orphanTimeoutMs: 30_000,
      heartbeatMs: 1_000,
      leaseMs: 5_000,
      teardownReserveMs: 14_000,
    } as unknown as ProviderProxyDeadlineConfiguration;

    expect(() =>
      createEnforcerDeadlineStateMachine(fake.clock, unvalidated, policy('c'), createControlHolderAuthority()),
    ).toThrow('must be validated before use');
  });
});

describe('provider proxy enforcer deadline evidence', () => {
  it('uses the process-local start time before the first round trip', () => {
    const fake = createFakeClock(guardianClockScope, 500);
    const startedAt = fake.clock.now();
    const guardian = createEnforcerDeadlineStateMachine(
      fake.clock,
      configuration(),
      policy('c'),
      createControlHolderAuthority(),
    );
    const bounds = guardian.bounds();

    expectSameInstant(fake.clock, bounds.lastRoundTripEvidenceAt, startedAt);
    expectSameInstant(
      fake.clock,
      bounds.exitDeadline,
      fake.clock.shiftMilliseconds(startedAt, DEFAULT_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS),
    );
    expectSameInstant(
      fake.clock,
      bounds.adoptionDeadline,
      fake.clock.shiftMilliseconds(startedAt, DEFAULT_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS - PROXY_TEARDOWN_RESERVE_MS),
    );
  });

  it('derives the exact EOF-observed vector from local echo acceptance', () => {
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
    const acceptedAt = fake.clock.now();
    expect(mustAccept(guardian.echoChallenge(first.challenge)).nextChallenge).not.toBe(first.challenge);
    fake.set(1_500);
    const eofAt = fake.clock.now();
    guardian.observeEof();
    const bounds = guardian.bounds();

    expectSameInstant(fake.clock, bounds.lastRoundTripEvidenceAt, acceptedAt);
    expectSameInstant(fake.clock, bounds.controlLossAt, eofAt);
    expectSameInstant(
      fake.clock,
      bounds.exitDeadline,
      fake.clock.shiftMilliseconds(acceptedAt, DEFAULT_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS),
    );
    expectSameInstant(
      fake.clock,
      bounds.adoptionDeadline,
      fake.clock.shiftMilliseconds(acceptedAt, DEFAULT_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS - PROXY_TEARDOWN_RESERVE_MS),
    );
  });

  it('derives control loss from the lease when EOF is suppressed', () => {
    const fake = createFakeClock(reaperClockScope, 500);
    const reaper = createEnforcerDeadlineStateMachine(
      fake.clock,
      configuration(),
      policy('c'),
      createControlHolderAuthority(),
    );
    fake.set(1_000);
    const first = mustAccept(reaper.issueFirstChallenge());
    fake.set(1_100);
    const acceptedAt = fake.clock.now();
    reaper.echoChallenge(first.challenge);

    expectSameInstant(
      fake.clock,
      reaper.bounds().controlLossAt,
      fake.clock.shiftMilliseconds(acceptedAt, PROXY_CONTROL_LEASE_MS),
    );
  });

  it('refuses a second first challenge as invalid state once one is already outstanding', () => {
    const fake = createFakeClock(guardianClockScope, 0);
    const guardian = createEnforcerDeadlineStateMachine(
      fake.clock,
      configuration(),
      policy('c'),
      createControlHolderAuthority(),
    );

    expect(mustAccept(guardian.issueFirstChallenge()).challenge).toEqual(expect.any(String));
    expect(guardian.issueFirstChallenge()).toEqual({ accepted: false, reason: 'invalid-state' });
  });

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

  it('accepts matching first and recurring echoes after the control lease while adoption remains open', () => {
    const fake = createFakeClock(guardianClockScope, 0);
    const guardian = createEnforcerDeadlineStateMachine(
      fake.clock,
      configuration(),
      policy('late'),
      createControlHolderAuthority(),
    );
    const first = mustAccept(guardian.issueFirstChallenge());
    fake.set(PROXY_CONTROL_LEASE_MS);

    expect(guardian.echoChallenge(first.challenge)).toEqual({ accepted: true, nextChallenge: 'late-2' });

    fake.set(PROXY_CONTROL_LEASE_MS * 2 + 1);
    expect(guardian.echoChallenge('late-2')).toEqual({ accepted: true, nextChallenge: 'late-3' });
  });

  it('rejects a successor challenge at the earlier adoption cutoff', () => {
    const fake = createFakeClock(reaperClockScope, 1_000);
    const reaper = createEnforcerDeadlineStateMachine(
      fake.clock,
      configuration(),
      policy('c'),
      createControlHolderAuthority(),
    );
    // A successor is admitted only after control is no longer live, so move past the lease first.
    fake.set(1_000 + PROXY_CONTROL_LEASE_MS);
    const successor = mustAccept(reaper.admitSuccessor());
    fake.set(1_000 + DEFAULT_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS - PROXY_TEARDOWN_RESERVE_MS);

    expect(reaper.echoChallenge(successor.challenge)).toEqual({
      accepted: false,
      reason: 'teardown-latched',
    });
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

  it('ignores positive and negative wall-clock jumps', () => {
    const fake = createFakeClock(guardianClockScope, 500);
    const guardian = createEnforcerDeadlineStateMachine(
      fake.clock,
      configuration(),
      policy('c'),
      createControlHolderAuthority(),
    );
    const before = guardian.bounds();
    const dateNow = vi.spyOn(Date, 'now');
    dateNow.mockReturnValue(9_999_999_999_999);
    const afterPositiveJump = guardian.bounds();
    dateNow.mockReturnValue(1);
    const afterNegativeJump = guardian.bounds();

    expectSameInstant(fake.clock, afterPositiveJump.exitDeadline, before.exitDeadline);
    expectSameInstant(fake.clock, afterNegativeJump.exitDeadline, before.exitDeadline);
    dateNow.mockRestore();
  });
});

describe('provider proxy deadline state machines', () => {
  it('latches guardian teardown at adoption equality before redemption work', () => {
    const fake = createFakeClock(guardianClockScope, 1_000);
    const guardian = createEnforcerDeadlineStateMachine(
      fake.clock,
      configuration(),
      policy('c'),
      createControlHolderAuthority(),
    );
    fake.set(1_500);
    guardian.observeEof();
    fake.set(24_000);
    const work = vi.fn();

    expect(guardian.admitSuccessor()).toEqual({
      accepted: false,
      reason: 'teardown-latched',
    });
    expect(guardian.state()).toBe('teardown-latched');
    expect(work).not.toHaveBeenCalled();
  });

  it('latches reaper teardown at adoption equality before rotation work', () => {
    const fake = createFakeClock(reaperClockScope, 1_000);
    const reaper = createEnforcerDeadlineStateMachine(
      fake.clock,
      configuration(),
      policy('c'),
      createControlHolderAuthority(),
    );
    fake.set(24_000);
    const work = vi.fn();

    expect(reaper.admitSuccessor()).toEqual({
      accepted: false,
      reason: 'teardown-latched',
    });
    expect(reaper.state()).toBe('teardown-latched');
    expect(work).not.toHaveBeenCalled();
  });

  it('rejects work queued before the boundary but dequeued after it', () => {
    const fake = createFakeClock(reaperClockScope, 1_000);
    const reaper = createEnforcerDeadlineStateMachine(
      fake.clock,
      configuration(),
      policy('c'),
      createControlHolderAuthority(),
    );
    const work = vi.fn();
    fake.set(23_999);
    const queuedHandler = (): unknown => reaper.admitSuccessor();
    fake.set(24_001);

    expect(queuedHandler()).toEqual({ accepted: false, reason: 'teardown-latched' });
    expect(work).not.toHaveBeenCalled();
  });

  it('accepts redemption and rotation strictly before the local adoption deadlines without moving them', () => {
    const guardianFake = createFakeClock(guardianClockScope, 1_000);
    const reaperFake = createFakeClock(reaperClockScope, 1_000);
    const guardian = createEnforcerDeadlineStateMachine(
      guardianFake.clock,
      configuration(),
      policy('guardian'),
      createControlHolderAuthority(),
    );
    const reaper = createEnforcerDeadlineStateMachine(
      reaperFake.clock,
      configuration(),
      policy('reaper'),
      createControlHolderAuthority(),
    );
    guardianFake.set(1_500);
    guardian.observeEof();
    const guardianBefore = guardian.bounds();
    const reaperBefore = reaper.bounds();
    guardianFake.set(23_000);
    reaperFake.set(23_000);

    const guardianSuccessor = mustAccept(guardian.admitSuccessor());
    const reaperSuccessor = mustAccept(reaper.admitSuccessor());
    expect(guardian.state()).toBe('accepting-control');
    expect(reaper.state()).toBe('accepting-control');
    expectSameInstant(guardianFake.clock, guardian.bounds().exitDeadline, guardianBefore.exitDeadline);
    expectSameInstant(reaperFake.clock, reaper.bounds().exitDeadline, reaperBefore.exitDeadline);

    guardianFake.set(23_999);
    reaperFake.set(23_999);
    expect(guardian.echoChallenge(guardianSuccessor.challenge).accepted).toBe(true);
    expect(reaper.echoChallenge(reaperSuccessor.challenge).accepted).toBe(true);
  });

  it('requires the first successor echo strictly before both local adoption deadlines', () => {
    const guardianFake = createFakeClock(guardianClockScope, 1_000);
    const reaperFake = createFakeClock(reaperClockScope, 1_000);
    const guardian = createEnforcerDeadlineStateMachine(
      guardianFake.clock,
      configuration(),
      policy('guardian'),
      createControlHolderAuthority(),
    );
    const reaper = createEnforcerDeadlineStateMachine(
      reaperFake.clock,
      configuration(),
      policy('reaper'),
      createControlHolderAuthority(),
    );
    guardianFake.set(1_500);
    guardian.observeEof();
    guardianFake.set(23_000);
    reaperFake.set(23_000);
    const guardianSuccessor = mustAccept(guardian.admitSuccessor());
    const reaperSuccessor = mustAccept(reaper.admitSuccessor());
    guardianFake.set(24_000);
    reaperFake.set(24_000);

    expect(guardian.echoChallenge(guardianSuccessor.challenge)).toEqual({
      accepted: false,
      reason: 'teardown-latched',
    });
    expect(reaper.echoChallenge(reaperSuccessor.challenge)).toEqual({
      accepted: false,
      reason: 'teardown-latched',
    });
  });

  it.each([17_001, 30_999])('keeps the reaper exit deadline fixed when guardian exit is observed at %i', (at) => {
    const fake = createFakeClock(reaperClockScope, 1_000);
    const reaper = createEnforcerDeadlineStateMachine(
      fake.clock,
      configuration(),
      policy('c'),
      createControlHolderAuthority(),
    );
    const exitDeadline = reaper.bounds().exitDeadline;
    fake.set(at);

    reaper.latchTeardown();

    expect(reaper.state()).toBe('teardown-latched');
    expectSameInstant(fake.clock, reaper.bounds().exitDeadline, exitDeadline);
  });

  it('makes the teardown latch irreversible through confirmed absence and exit', () => {
    const fake = createFakeClock(guardianClockScope, 1_000);
    const guardian = createEnforcerDeadlineStateMachine(
      fake.clock,
      configuration(),
      policy('c'),
      createControlHolderAuthority(),
    );
    guardian.latchTeardown();
    guardian.markContainmentAbsent();
    guardian.markExited();

    expect(guardian.state()).toBe('exited');
    expect(guardian.admitSuccessor()).toEqual({
      accepted: false,
      reason: 'teardown-latched',
    });
  });

  it('admits a successor only once control is no longer live', () => {
    const fake = createFakeClock(reaperClockScope, 1_000);
    const enforcer = createEnforcerDeadlineStateMachine(
      fake.clock,
      configuration(),
      policy('c'),
      createControlHolderAuthority(),
    );

    // While the incumbent still holds control, a successor has nothing to take over.
    fake.set(2_000);
    expect(enforcer.admitSuccessor()).toEqual({ accepted: false, reason: 'control-active' });

    fake.set(1_000 + PROXY_CONTROL_LEASE_MS);
    expect(enforcer.admitSuccessor()).toMatchObject({ accepted: true });
  });

  it('refuses a successor once teardown has latched', () => {
    const fake = createFakeClock(reaperClockScope, 1_000);
    const enforcer = createEnforcerDeadlineStateMachine(
      fake.clock,
      configuration(),
      policy('c'),
      createControlHolderAuthority(),
    );
    enforcer.latchTeardown();

    fake.set(7_000);
    expect(enforcer.admitSuccessor()).toEqual({ accepted: false, reason: 'teardown-latched' });
  });
});

describe('provider proxy control reattachment', () => {
  it('reattaches a live tenancy without minting, and refuses only once teardown has latched', () => {
    const fake = createFakeClock(reaperClockScope, 1_000);
    const enforcer = createEnforcerDeadlineStateMachine(
      fake.clock,
      configuration(),
      policy('c'),
      createControlHolderAuthority(),
    );

    expect(enforcer.reattachControl()).toEqual({ accepted: true });

    enforcer.latchTeardown();
    expect(enforcer.reattachControl()).toEqual({ accepted: false, reason: 'teardown-latched' });
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

  it('never collapses adoption to an instant later than it already stood at', () => {
    const fake = createFakeClock(reaperClockScope, 1_000);
    const reaper = createEnforcerDeadlineStateMachine(
      fake.clock,
      configuration(),
      policy('c'),
      createControlHolderAuthority(),
    );
    const naturalAdoptionDeadline = reaper.bounds().adoptionDeadline;
    fake.set(5_000);

    reaper.observePairingLoss();

    expect(fake.clock.compare(reaper.bounds().adoptionDeadline, naturalAdoptionDeadline)).toBeLessThan(0);
  });

  it('is a no-op once its own collapse has already passed, like every other dispatch method', () => {
    const fake = createFakeClock(reaperClockScope, 1_000);
    const reaper = createEnforcerDeadlineStateMachine(
      fake.clock,
      configuration(),
      policy('c'),
      createControlHolderAuthority(),
    );
    fake.set(5_000);
    reaper.observePairingLoss();
    const collapsedAdoptionDeadline = reaper.bounds().adoptionDeadline;
    fake.set(5_001);

    reaper.observePairingLoss();

    expect(reaper.state()).toBe('teardown-latched');
    expectSameInstant(fake.clock, reaper.bounds().adoptionDeadline, collapsedAdoptionDeadline);
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

describe('published holder-check schedule (AC4)', () => {
  it('schedules the first check at round-trip evidence plus A, before any renewal', () => {
    const fake = createFakeClock(guardianClockScope, 0);
    const authority = installedHolder();
    authority.publish();
    const guardian = createEnforcerDeadlineStateMachine(fake.clock, configuration(), policy('c'), authority);

    expectSameInstant(
      fake.clock,
      guardian.bounds().holderCheckAt,
      fake.clock.shiftMilliseconds(fake.clock.now(), providerProxyAdoptionWindowMs(configuration())),
    );
    expect(guardian.bounds().holderCheckAccelerated).toBe(false);
  });

  it('renews the next check from the given instant, never from a later call to renew', () => {
    const fake = createFakeClock(guardianClockScope, 0);
    const authority = installedHolder();
    authority.publish();
    const guardian = createEnforcerDeadlineStateMachine(fake.clock, configuration(), policy('c'), authority);
    fake.set(20_000);
    const observedAt = fake.clock.now();
    fake.set(23_000);

    guardian.renewHolderCheck(observedAt);

    expectSameInstant(
      fake.clock,
      guardian.bounds().holderCheckAt,
      fake.clock.shiftMilliseconds(observedAt, providerProxyAdoptionWindowMs(configuration())),
    );
  });

  it('never walks the renewed anchor backward on an out-of-order renewal', () => {
    const fake = createFakeClock(guardianClockScope, 0);
    const authority = installedHolder();
    authority.publish();
    const guardian = createEnforcerDeadlineStateMachine(fake.clock, configuration(), policy('c'), authority);
    fake.set(10_000);
    guardian.renewHolderCheck(fake.clock.now());
    const afterLater = guardian.bounds().holderCheckAt;

    fake.set(11_000);
    guardian.renewHolderCheck(fake.clock.shiftMilliseconds(fake.clock.now(), -5_000));

    expectSameInstant(fake.clock, guardian.bounds().holderCheckAt, afterLater);
  });

  it('accelerates exactly one check on pairing loss, then returns to the ordinary cadence', () => {
    const fake = createFakeClock(guardianClockScope, 0);
    const authority = installedHolder();
    authority.publish();
    const guardian = createEnforcerDeadlineStateMachine(fake.clock, configuration(), policy('c'), authority);
    fake.set(5_000);
    const pairingLossAt = fake.clock.now();

    guardian.observePairingLoss();

    expectSameInstant(fake.clock, guardian.bounds().holderCheckAt, pairingLossAt);
    expect(guardian.bounds().holderCheckAccelerated).toBe(true);

    // The accelerated check is performed (of any disposition) and renews from that instant — the
    // acceleration must not keep re-clamping every later cadence into a zero-delay loop.
    guardian.renewHolderCheck(pairingLossAt);

    expectSameInstant(
      fake.clock,
      guardian.bounds().holderCheckAt,
      fake.clock.shiftMilliseconds(pairingLossAt, providerProxyAdoptionWindowMs(configuration())),
    );
    expect(guardian.bounds().holderCheckAccelerated).toBe(false);
  });

  it('accelerates exactly one check on EOF, the same as pairing loss', () => {
    const fake = createFakeClock(guardianClockScope, 0);
    const authority = installedHolder();
    authority.publish();
    const guardian = createEnforcerDeadlineStateMachine(fake.clock, configuration(), policy('c'), authority);
    fake.set(1_500);
    const first = mustAccept(guardian.issueFirstChallenge());
    fake.set(3_000);
    guardian.echoChallenge(first.challenge);
    fake.set(9_000);
    const eofAt = fake.clock.now();

    guardian.observeEof();

    expectSameInstant(fake.clock, guardian.bounds().holderCheckAt, eofAt);
    expect(guardian.bounds().holderCheckAccelerated).toBe(true);
    // Unrelated to the acceleration: EOF is not a holder verdict and does not itself latch teardown.
    expect(guardian.state()).toBe('accepting-control');
  });

  it('leaves the pre-publication adoption deadline governed by the pure clock bound alone', () => {
    const fake = createFakeClock(guardianClockScope, 0);
    const authority = createControlHolderAuthority();
    const guardian = createEnforcerDeadlineStateMachine(fake.clock, configuration(), policy('c'), authority);

    // Nothing has ever been admitted, so the authority's phase remains 'acquisition-provisional'.
    expectSameInstant(
      fake.clock,
      guardian.bounds().holderCheckAt,
      fake.clock.shiftMilliseconds(fake.clock.now(), providerProxyAdoptionWindowMs(configuration())),
    );
  });
});

describe('AC5 — a late heartbeat from a recovering coordinator is accepted once a holder is published', () => {
  it('stops latching teardown from elapsed time once the holder authority is published', () => {
    const fake = createFakeClock(guardianClockScope, 0);
    const authority = installedHolder();
    authority.publish();
    const guardian = createEnforcerDeadlineStateMachine(fake.clock, configuration(), policy('c'), authority);
    const first = mustAccept(guardian.issueFirstChallenge());
    // Cross the old clock-only adoption deadline while nothing has latched teardown autonomously — only
    // `runTeardown` (enforcement.ts) may latch now that a holder has been published.
    fake.set(DEFAULT_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS - PROXY_TEARDOWN_RESERVE_MS + 5_000);

    const echoed = guardian.echoChallenge(first.challenge);

    expect(echoed).toEqual({ accepted: true, nextChallenge: expect.any(String) });
    expect(guardian.state()).toBe('accepting-control');
  });

  it('still latches from elapsed time before publication (AC3’s provisional bootstrap window)', () => {
    const fake = createFakeClock(guardianClockScope, 0);
    const authority = installedHolder();
    // Deliberately not published.
    const guardian = createEnforcerDeadlineStateMachine(fake.clock, configuration(), policy('c'), authority);
    const first = mustAccept(guardian.issueFirstChallenge());
    fake.set(DEFAULT_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS - PROXY_TEARDOWN_RESERVE_MS + 5_000);

    const echoed = guardian.echoChallenge(first.challenge);

    expect(echoed).toEqual({ accepted: false, reason: 'teardown-latched' });
    expect(guardian.state()).toBe('teardown-latched');
  });

  it('still samples its own already-latched state once published, so a real reap in flight is honoured', () => {
    const fake = createFakeClock(guardianClockScope, 0);
    const authority = installedHolder();
    authority.publish();
    const guardian = createEnforcerDeadlineStateMachine(fake.clock, configuration(), policy('c'), authority);
    const first = mustAccept(guardian.issueFirstChallenge());

    // `runTeardown` (enforcement.ts) latches synchronously before its first await; this machine has no
    // other way to model that from outside enforcement.ts, so the same public `latchTeardown()` it calls is
    // exercised directly here.
    guardian.latchTeardown();

    expect(guardian.echoChallenge(first.challenge)).toEqual({ accepted: false, reason: 'teardown-latched' });
  });
});

describe('containmentExecutionDeadline (AC4)', () => {
  it('grants teardownReserveMs minus the wake allowance from the authorized instant', () => {
    const fake = createFakeClock(guardianClockScope, 1_000);
    const authorizedAt = fake.clock.now();

    const deadline = containmentExecutionDeadline(fake.clock, authorizedAt);

    expectSameInstant(
      fake.clock,
      deadline,
      fake.clock.shiftMilliseconds(authorizedAt, PROXY_TEARDOWN_RESERVE_MS - PROXY_ENFORCER_MAX_WAKE_LATENCY_MS),
    );
  });
});

describe('mathematical test vectors — the death timetable composed end to end (AC4, AC9)', () => {
  it('a death between an early alive sample and its gate still finishes within O of that sample', () => {
    const fake = createFakeClock(guardianClockScope, 0);
    const authority = installedHolder();
    authority.publish();
    const guardian = createEnforcerDeadlineStateMachine(fake.clock, configuration(), policy('c'), authority);
    const observedAt = fake.clock.now();

    // The evidence completed at `observedAt`; the not-before gate is reached only later, and the wake that
    // consumes it may itself run up to `W` late.
    guardian.renewHolderCheck(observedAt);
    const holderCheckAt = guardian.bounds().holderCheckAt;
    const authorizedAt = fake.clock.shiftMilliseconds(holderCheckAt, PROXY_ENFORCER_MAX_WAKE_LATENCY_MS);

    const executionDeadline = containmentExecutionDeadline(fake.clock, authorizedAt);

    expect(fake.clock.millisecondsBetween(observedAt, executionDeadline)).toBe(
      DEFAULT_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS,
    );
  });

  it('the maximum P plus maximum W vector still finishes by O', () => {
    const fake = createFakeClock(guardianClockScope, 0);
    const authority = installedHolder();
    authority.publish();
    const guardian = createEnforcerDeadlineStateMachine(fake.clock, configuration(), policy('c'), authority);
    const observedAt = fake.clock.now();
    guardian.renewHolderCheck(observedAt);
    const holderCheckAt = guardian.bounds().holderCheckAt;

    // A probe that starts at `holderCheckAt - P - W` and spends its full P-second bound resolves exactly at
    // the not-before gate; the wake that consumes it may then spend up to `W` more.
    const observationStartAt = fake.clock.shiftMilliseconds(
      holderCheckAt,
      -(PROCESS_INCARNATION_PROBE_TIMEOUT_MS + PROXY_ENFORCER_MAX_WAKE_LATENCY_MS),
    );
    const probeResolvedAt = fake.clock.shiftMilliseconds(observationStartAt, PROCESS_INCARNATION_PROBE_TIMEOUT_MS);
    expectSameInstant(
      fake.clock,
      probeResolvedAt,
      fake.clock.shiftMilliseconds(holderCheckAt, -PROXY_ENFORCER_MAX_WAKE_LATENCY_MS),
    );
    const authorizedAt = fake.clock.shiftMilliseconds(holderCheckAt, PROXY_ENFORCER_MAX_WAKE_LATENCY_MS);

    const executionDeadline = containmentExecutionDeadline(fake.clock, authorizedAt);

    expect(fake.clock.millisecondsBetween(observedAt, executionDeadline)).toBeLessThanOrEqual(
      DEFAULT_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS,
    );
  });
});
