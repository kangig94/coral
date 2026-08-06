import { describe, expect, it, vi } from 'vitest';

import { createMonotonicClock, type MonotonicClock, type MonotonicInstant } from '#src/infra/monotonic-clock.js';
import {
  PROXY_DISAPPEARANCE_CONFIRM_MS,
  PROXY_PROCESS_CONTROL_CALL_MAX_MS,
  SIGKILL_GRACE_MS,
  SIGTERM_GRACE_MS,
} from '#src/infra/process-constants.js';
import {
  createEnforcerDeadlineStateMachine,
  DEFAULT_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS,
  MAX_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS,
  MIN_EFFECTIVE_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS,
  MIN_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS,
  PROXY_CONTROL_HEARTBEAT_MS,
  PROXY_CONTROL_LEASE_MS,
  PROXY_ENDPOINT_CLEANUP_BUDGET_MS,
  PROXY_ENFORCER_MAX_WAKE_LATENCY_MS,
  PROXY_PROCESS_CONTROL_BUDGET_MS,
  PROXY_REDEMPTION_DISPATCH_MAX_MS,
  PROXY_STARTUP_ATTACH_RESERVE_MS,
  PROXY_TEARDOWN_RESERVE_MS,
  providerProxyDeadlineConfigurationSchema,
  resolveProviderProxyDeadlineConfiguration,
  type EnforcerChallengePolicy,
  type ProviderProxyDeadlineConfiguration,
} from '#src/provider-proxy/orphan-deadline.js';
import { PROXY_CONTROL_RPC_TIMEOUT_MS } from '#src/provider-proxy/protocol.js';

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
  it('derives the exact 14000ms reserve from the imported process constants', () => {
    expect(PROXY_PROCESS_CONTROL_BUDGET_MS).toBe(2 * PROXY_PROCESS_CONTROL_CALL_MAX_MS);
    expect(PROXY_TEARDOWN_RESERVE_MS).toBe(
      SIGTERM_GRACE_MS +
        SIGKILL_GRACE_MS +
        PROXY_DISAPPEARANCE_CONFIRM_MS +
        PROXY_ENDPOINT_CLEANUP_BUDGET_MS +
        PROXY_ENFORCER_MAX_WAKE_LATENCY_MS +
        2 * PROXY_PROCESS_CONTROL_CALL_MAX_MS,
    );
    expect(PROXY_TEARDOWN_RESERVE_MS).toBe(14_000);
  });

  it('publishes the normative fixed durations and default', () => {
    expect(PROXY_CONTROL_HEARTBEAT_MS).toBe(1_000);
    expect(PROXY_CONTROL_LEASE_MS).toBe(5_000);
    expect(PROXY_REDEMPTION_DISPATCH_MAX_MS).toBe(1_000);
    expect(PROXY_CONTROL_RPC_TIMEOUT_MS).toBe(5_000);
    expect(PROXY_STARTUP_ATTACH_RESERVE_MS).toBe(4_000);
    expect(configuration().orphanTimeoutMs).toBe(DEFAULT_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS);
  });

  it('validates only decimal millisecond input', () => {
    for (const raw of [' 30000', '30000 ', '+30000', '30_000', '3e4', '30000.0', '-30000', '']) {
      expect(() => configuration(raw), raw).toThrow();
    }
    expect(configuration('030000').orphanTimeoutMs).toBe(30_000);
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

  it('checks the lease inequality on both sides of its strict boundary', () => {
    const outside = issueMessages(String(PROXY_TEARDOWN_RESERVE_MS + PROXY_CONTROL_LEASE_MS));
    const inside = issueMessages(String(PROXY_TEARDOWN_RESERVE_MS + PROXY_CONTROL_LEASE_MS + 1));

    expect(outside).toContain('must satisfy heartbeat < lease < orphan timeout - teardown reserve');
    expect(inside).not.toContain('must satisfy heartbeat < lease < orphan timeout - teardown reserve');
    expect(inside).toContain('must retain the strict redemption RPC and startup attach margin');
  });

  it('checks the stronger redemption margin on both sides of its strict boundary', () => {
    const boundary =
      PROXY_TEARDOWN_RESERVE_MS +
      PROXY_REDEMPTION_DISPATCH_MAX_MS +
      PROXY_CONTROL_RPC_TIMEOUT_MS +
      PROXY_STARTUP_ATTACH_RESERVE_MS;

    expect(issueMessages(String(boundary))).toContain(
      'must retain the strict redemption RPC and startup attach margin',
    );
    expect(configuration(String(boundary + 1)).orphanTimeoutMs).toBe(boundary + 1);
    expect(MIN_EFFECTIVE_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS).toBe(24_001);
  });

  it('rejects an unvalidated configuration object at the state-machine boundary', () => {
    const fake = createFakeClock(guardianClockScope, 0);
    const unvalidated = {
      orphanTimeoutMs: 30_000,
      heartbeatMs: 1_000,
      leaseMs: 5_000,
      teardownReserveMs: 14_000,
    } as unknown as ProviderProxyDeadlineConfiguration;

    expect(() => createEnforcerDeadlineStateMachine(fake.clock, unvalidated, policy('c'))).toThrow(
      'must be validated before use',
    );
  });
});

describe('provider proxy enforcer deadline evidence', () => {
  it('uses the process-local start time before the first round trip', () => {
    const fake = createFakeClock(guardianClockScope, 500);
    const startedAt = fake.clock.now();
    const guardian = createEnforcerDeadlineStateMachine(fake.clock, configuration(), policy('c'));
    const bounds = guardian.bounds();

    expectSameInstant(fake.clock, bounds.lastRoundTripEvidenceAt, startedAt);
    expectSameInstant(fake.clock, bounds.exitDeadline, fake.clock.shiftMilliseconds(startedAt, 30_000));
    expectSameInstant(fake.clock, bounds.adoptionDeadline, fake.clock.shiftMilliseconds(startedAt, 16_000));
  });

  it('derives the exact EOF-observed vector from challenge issuance, not receive time', () => {
    const fake = createFakeClock(guardianClockScope, 500);
    const guardian = createEnforcerDeadlineStateMachine(fake.clock, configuration(), policy('c'));
    fake.set(1_000);
    const issuedAt = fake.clock.now();
    const first = mustAccept(guardian.issueFirstChallenge());
    fake.set(1_100);
    expect(mustAccept(guardian.echoChallenge(first.challenge)).nextChallenge).not.toBe(first.challenge);
    fake.set(1_500);
    const eofAt = fake.clock.now();
    guardian.observeEof();
    const bounds = guardian.bounds();

    expectSameInstant(fake.clock, bounds.lastRoundTripEvidenceAt, issuedAt);
    expectSameInstant(fake.clock, bounds.controlLossAt, eofAt);
    expectSameInstant(fake.clock, bounds.exitDeadline, fake.clock.shiftMilliseconds(issuedAt, 30_000));
    expectSameInstant(fake.clock, bounds.adoptionDeadline, fake.clock.shiftMilliseconds(issuedAt, 16_000));
  });

  it('derives control loss from the lease when EOF is suppressed', () => {
    const fake = createFakeClock(reaperClockScope, 500);
    const reaper = createEnforcerDeadlineStateMachine(fake.clock, configuration(), policy('c'));
    fake.set(1_000);
    const issuedAt = fake.clock.now();
    const first = mustAccept(reaper.issueFirstChallenge());
    fake.set(1_100);
    reaper.echoChallenge(first.challenge);

    expectSameInstant(
      fake.clock,
      reaper.bounds().controlLossAt,
      fake.clock.shiftMilliseconds(issuedAt, PROXY_CONTROL_LEASE_MS),
    );
  });

  it('refuses a second first challenge as invalid state once one is already outstanding', () => {
    const fake = createFakeClock(guardianClockScope, 0);
    const guardian = createEnforcerDeadlineStateMachine(fake.clock, configuration(), policy('c'));

    expect(mustAccept(guardian.issueFirstChallenge()).challenge).toEqual(expect.any(String));
    expect(guardian.issueFirstChallenge()).toEqual({ accepted: false, reason: 'invalid-state' });
  });

  it('caps the first challenge at the adoption deadline', () => {
    const fake = createFakeClock(guardianClockScope, 0);
    const guardian = createEnforcerDeadlineStateMachine(fake.clock, configuration(), policy('c'));
    const adoptionDeadline = guardian.bounds().adoptionDeadline;
    fake.set(12_000);
    guardian.issueFirstChallenge();

    // Change 2 must not lose this clamp: the enforcer's challenge may not outlive its adoption window.
    expectSameInstant(fake.clock, guardian.bounds().firstChallengeExpiresAt!, adoptionDeadline);
  });

  it('rejects a successor challenge at its strict lease expiry', () => {
    const fake = createFakeClock(reaperClockScope, 1_000);
    const reaper = createEnforcerDeadlineStateMachine(fake.clock, configuration(), policy('c'));
    // A successor is admitted only after control is no longer live, so move past the lease first.
    fake.set(7_000);
    const successor = mustAccept(reaper.admitSuccessor());
    fake.set(12_001);

    expect(reaper.echoChallenge(successor.challenge)).toEqual({
      accepted: false,
      reason: 'challenge-expired',
    });
  });

  it('does not move evidence for a stale or already-used challenge', () => {
    const fake = createFakeClock(guardianClockScope, 500);
    const guardian = createEnforcerDeadlineStateMachine(fake.clock, configuration(), policy('c'));
    fake.set(1_000);
    const first = mustAccept(guardian.issueFirstChallenge());
    fake.set(1_100);
    guardian.echoChallenge(first.challenge);
    const evidenceAt = guardian.bounds().lastRoundTripEvidenceAt;
    fake.set(1_200);

    // The already-consumed challenge cannot re-earn evidence.
    expect(guardian.echoChallenge(first.challenge)).toEqual({
      accepted: false,
      reason: 'challenge-mismatch',
    });
    expectSameInstant(fake.clock, guardian.bounds().lastRoundTripEvidenceAt, evidenceAt);
  });

  it('does not move either deadline for proxy heartbeats or ordinary authenticated frames', () => {
    const fake = createFakeClock(guardianClockScope, 500);
    const guardian = createEnforcerDeadlineStateMachine(fake.clock, configuration(), policy('c'));
    fake.set(1_000);
    const first = mustAccept(guardian.issueFirstChallenge());
    fake.set(1_100);
    guardian.echoChallenge(first.challenge);
    const before = guardian.bounds();
    const work = vi.fn();
    fake.set(1_200);

    expect(guardian.dispatchOrdinaryFrame('proxy-heartbeat', work)).toEqual({ accepted: true });
    expect(guardian.dispatchOrdinaryFrame('authenticated-frame', work)).toEqual({ accepted: true });
    const after = guardian.bounds();
    expectSameInstant(fake.clock, after.exitDeadline, before.exitDeadline);
    expectSameInstant(fake.clock, after.adoptionDeadline, before.adoptionDeadline);
    expect(work).toHaveBeenCalledTimes(2);
  });

  it('ignores positive and negative wall-clock jumps', () => {
    const fake = createFakeClock(guardianClockScope, 500);
    const guardian = createEnforcerDeadlineStateMachine(fake.clock, configuration(), policy('c'));
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
    const guardian = createEnforcerDeadlineStateMachine(fake.clock, configuration(), policy('c'));
    fake.set(1_500);
    guardian.observeEof();
    fake.set(17_000);
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
    const reaper = createEnforcerDeadlineStateMachine(fake.clock, configuration(), policy('c'));
    fake.set(17_000);
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
    const reaper = createEnforcerDeadlineStateMachine(fake.clock, configuration(), policy('c'));
    const work = vi.fn();
    fake.set(16_999);
    const queuedHandler = (): unknown => reaper.admitSuccessor();
    fake.set(17_001);

    expect(queuedHandler()).toEqual({ accepted: false, reason: 'teardown-latched' });
    expect(work).not.toHaveBeenCalled();
  });

  it('accepts redemption and rotation strictly before the local adoption deadlines without moving them', () => {
    const guardianFake = createFakeClock(guardianClockScope, 1_000);
    const reaperFake = createFakeClock(reaperClockScope, 1_000);
    const guardian = createEnforcerDeadlineStateMachine(guardianFake.clock, configuration(), policy('guardian'));
    const reaper = createEnforcerDeadlineStateMachine(reaperFake.clock, configuration(), policy('reaper'));
    guardianFake.set(1_500);
    guardian.observeEof();
    const guardianBefore = guardian.bounds();
    const reaperBefore = reaper.bounds();
    guardianFake.set(16_000);
    reaperFake.set(16_000);

    const guardianSuccessor = mustAccept(guardian.admitSuccessor());
    const reaperSuccessor = mustAccept(reaper.admitSuccessor());
    expect(guardian.state()).toBe('accepting-control');
    expect(reaper.state()).toBe('accepting-control');
    expectSameInstant(guardianFake.clock, guardian.bounds().exitDeadline, guardianBefore.exitDeadline);
    expectSameInstant(reaperFake.clock, reaper.bounds().exitDeadline, reaperBefore.exitDeadline);

    guardianFake.set(16_999);
    reaperFake.set(16_999);
    expect(guardian.echoChallenge(guardianSuccessor.challenge).accepted).toBe(true);
    expect(reaper.echoChallenge(reaperSuccessor.challenge).accepted).toBe(true);
  });

  it('requires the first successor echo strictly before both local adoption deadlines', () => {
    const guardianFake = createFakeClock(guardianClockScope, 1_000);
    const reaperFake = createFakeClock(reaperClockScope, 1_000);
    const guardian = createEnforcerDeadlineStateMachine(guardianFake.clock, configuration(), policy('guardian'));
    const reaper = createEnforcerDeadlineStateMachine(reaperFake.clock, configuration(), policy('reaper'));
    guardianFake.set(1_500);
    guardian.observeEof();
    guardianFake.set(16_000);
    reaperFake.set(16_000);
    const guardianSuccessor = mustAccept(guardian.admitSuccessor());
    const reaperSuccessor = mustAccept(reaper.admitSuccessor());
    guardianFake.set(17_000);
    reaperFake.set(17_000);

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
    const reaper = createEnforcerDeadlineStateMachine(fake.clock, configuration(), policy('c'));
    const exitDeadline = reaper.bounds().exitDeadline;
    fake.set(at);

    reaper.latchTeardown();

    expect(reaper.state()).toBe('teardown-latched');
    expectSameInstant(fake.clock, reaper.bounds().exitDeadline, exitDeadline);
  });

  it('makes the teardown latch irreversible through confirmed absence and exit', () => {
    const fake = createFakeClock(guardianClockScope, 1_000);
    const guardian = createEnforcerDeadlineStateMachine(fake.clock, configuration(), policy('c'));
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
    const enforcer = createEnforcerDeadlineStateMachine(fake.clock, configuration(), policy('c'));

    // While the incumbent still holds control, a successor has nothing to take over.
    fake.set(2_000);
    expect(enforcer.admitSuccessor()).toEqual({ accepted: false, reason: 'control-active' });

    fake.set(7_000);
    expect(enforcer.admitSuccessor()).toMatchObject({ accepted: true });
  });

  it('refuses a successor once teardown has latched', () => {
    const fake = createFakeClock(reaperClockScope, 1_000);
    const enforcer = createEnforcerDeadlineStateMachine(fake.clock, configuration(), policy('c'));
    enforcer.latchTeardown();

    fake.set(7_000);
    expect(enforcer.admitSuccessor()).toEqual({ accepted: false, reason: 'teardown-latched' });
  });
});

describe('provider proxy control reattachment', () => {
  it('reattaches a live tenancy without minting, and refuses only once teardown has latched', () => {
    const fake = createFakeClock(reaperClockScope, 1_000);
    const enforcer = createEnforcerDeadlineStateMachine(fake.clock, configuration(), policy('c'));

    expect(enforcer.reattachControl()).toEqual({ accepted: true });

    enforcer.latchTeardown();
    expect(enforcer.reattachControl()).toEqual({ accepted: false, reason: 'teardown-latched' });
  });
});

describe('provider proxy pairing loss', () => {
  it('collapses adoption to the pairing-loss instant, leaves exit and control-loss evidence untouched', () => {
    const fake = createFakeClock(reaperClockScope, 1_000);
    const reaper = createEnforcerDeadlineStateMachine(fake.clock, configuration(), policy('c'));
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
    const reaper = createEnforcerDeadlineStateMachine(fake.clock, configuration(), policy('c'));
    const naturalAdoptionDeadline = reaper.bounds().adoptionDeadline;
    fake.set(5_000);

    reaper.observePairingLoss();

    expect(fake.clock.compare(reaper.bounds().adoptionDeadline, naturalAdoptionDeadline)).toBeLessThan(0);
  });

  it('makes a heartbeat past the collapsed deadline latch teardown, proving the acceleration is real', () => {
    const fake = createFakeClock(reaperClockScope, 1_000);
    const reaper = createEnforcerDeadlineStateMachine(fake.clock, configuration(), policy('c'));
    fake.set(5_000);
    reaper.observePairingLoss();
    fake.set(5_001);
    const work = vi.fn();

    expect(reaper.dispatchOrdinaryFrame('authenticated-frame', work)).toEqual({
      accepted: false,
      reason: 'teardown-latched',
    });

    expect(work).not.toHaveBeenCalled();
    expect(reaper.state()).toBe('teardown-latched');
  });

  it('is a no-op once its own collapse has already passed, like every other dispatch method', () => {
    const fake = createFakeClock(reaperClockScope, 1_000);
    const reaper = createEnforcerDeadlineStateMachine(fake.clock, configuration(), policy('c'));
    fake.set(5_000);
    reaper.observePairingLoss();
    const collapsedAdoptionDeadline = reaper.bounds().adoptionDeadline;
    fake.set(5_001);

    reaper.observePairingLoss();

    expect(reaper.state()).toBe('teardown-latched');
    expectSameInstant(fake.clock, reaper.bounds().adoptionDeadline, collapsedAdoptionDeadline);
  });
});
