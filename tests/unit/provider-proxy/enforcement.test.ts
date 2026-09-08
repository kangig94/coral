import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { describe, expect, it, vi } from 'vitest';

import { createMonotonicClock } from '#src/infra/monotonic-clock.js';
import {
  PROCESS_INCARNATION_PROBE_TIMEOUT_MS,
  type AsyncRecordedProcessObserver,
  type ProcessLiveness,
} from '#src/infra/node-process.js';
import type { RecordedProcessIdentity } from '#src/infra/process-containment.js';
import {
  createArmedEnforcer,
  EnforcementError,
  MAX_PROXY_RECORDED_PROVIDER_ROOTS,
  mintLocalSignalTeardownAuthorization,
  type EnforcementOutcome,
  type EnforcementScheduler,
} from '#src/provider-proxy/enforcement.js';
import {
  controlHolderAuthorizationIsCurrent,
  createControlHolderAuthority,
  mintExplicitTeardownAuthorization,
  observeControlHolder,
  type ExplicitTeardownAuthorization,
  type ObservedHolderAbsenceAuthorization,
} from '#src/provider-proxy/holder-lifecycle.js';
import {
  createEnforcerDeadlineStateMachine,
  DEFAULT_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS,
  PROXY_ENFORCER_MAX_WAKE_LATENCY_MS,
  PROXY_TEARDOWN_RESERVE_MS,
  providerProxyAdoptionWindowMs,
  resolveProviderProxyDeadlineConfiguration,
  type EnforcerChallengePolicy,
} from '#src/provider-proxy/orphan-deadline.js';
import type { MonotonicInstant } from '#src/infra/monotonic-clock.js';

const CONTAINMENT = { pid: 4_242, incarnation: testIncarnation(1_000), processGroupId: 4_242 } as const;
const HOLDER = { instanceId: 'coordinator', pid: 4_000, incarnation: testIncarnation('coordinator') } as const;
const enforcementClockScope: unique symbol = Symbol('enforcement-clock');

function root(pid: number): RecordedProcessIdentity {
  return { pid, incarnation: testIncarnation(2_000) };
}

/** A scheduler whose queued callbacks only run when the test says so. */
function createManualScheduler(): EnforcementScheduler & { runDue(): void; pending(): number } {
  const queued: Array<{ callback: () => void }> = [];
  return {
    schedule(callback) {
      const entry = { callback };
      queued.push(entry);
      return entry as unknown as { unref?: () => void };
    },
    cancel(handle) {
      const index = queued.indexOf(handle as unknown as { callback: () => void });
      if (index !== -1) queued.splice(index, 1);
    },
    runDue() {
      for (const entry of queued.splice(0)) entry.callback();
    },
    pending() {
      return queued.length;
    },
  };
}

function createHarness(options: {
  adoptionInMs: number;
  alive?: Set<number>;
  stubborn?: ReadonlySet<number>;
  published?: boolean;
  observeHolder?: AsyncRecordedProcessObserver;
  acceleratedCheckMayAuthorizeAbsence?: boolean;
  pairingLossObserved?: () => boolean;
  accelerated?: boolean;
  observeContainmentLiveness?(pid: number): ProcessLiveness;
  readContainmentIncarnation?(pid: number): RecordedProcessIdentity['incarnation'] | null;
}) {
  let elapsedMs = 0n;
  const clock = createMonotonicClock(enforcementClockScope, {
    readMilliseconds: () => elapsedMs,
    // Sleeping advances this clock, so a grace or confirmation wait actually consumes its budget instead
    // of spinning against a frozen reading.
    sleep: (milliseconds: number) => {
      elapsedMs += BigInt(milliseconds);
      return Promise.resolve();
    },
  });
  const advance = (ms: number): void => {
    elapsedMs += BigInt(ms);
  };
  const start = clock.now();
  const bounds = {
    lastRoundTripEvidenceAt: start,
    eofAt: null,
    controlLossAt: start,
    adoptionDeadline: clock.shiftMilliseconds(start, options.adoptionInMs),
    exitDeadline: clock.shiftMilliseconds(start, options.adoptionInMs + 14_000),
    holderCheckAt: clock.shiftMilliseconds(start, options.adoptionInMs),
    holderCheckAccelerated: options.accelerated ?? false,
  };
  const latchTeardown = vi.fn();
  const markContainmentAbsent = vi.fn();
  const renewHolderCheck = vi.fn();
  const alive = options.alive ?? new Set<number>();
  const stubborn = options.stubborn ?? new Set<number>();
  const scheduler = createManualScheduler();
  const outcomes: EnforcementOutcome[] = [];
  const violations: number[] = [];
  const observeContainmentLiveness = vi.fn(
    options.observeContainmentLiveness ??
      ((pid: number) => ((pid < 0 ? alive.has(-pid) : alive.has(pid)) ? 'alive' : 'absent')),
  );
  const readContainmentIncarnation =
    options.readContainmentIncarnation ??
    ((pid: number) => {
      if (!alive.has(pid)) return null;
      return pid === CONTAINMENT.pid ? CONTAINMENT.incarnation : testIncarnation(2_000);
    });
  const signalContainment = vi.fn((pid: number) => {
    const targets = pid < 0 ? [...alive] : [pid];
    for (const target of targets) {
      if (stubborn.has(target)) continue;
      alive.delete(target);
    }
    return true;
  });

  const holderAuthority = createControlHolderAuthority();
  holderAuthority.install({ controlEpoch: 1, holder: HOLDER });
  if (options.published ?? false) holderAuthority.publish();

  const observeHolder = options.observeHolder ?? ((): Promise<ProcessLiveness> => Promise.resolve('unknown'));

  const enforcer = createArmedEnforcer({
    clock,
    deadlines: { bounds: () => bounds, latchTeardown, markContainmentAbsent, renewHolderCheck },
    containment: CONTAINMENT,
    containmentEnvironment: {
      clock,
      process: {
        kill: signalContainment,
        observeLiveness: observeContainmentLiveness,
        observeRecordedProcessAsync: async (identity) => {
          const liveness = observeContainmentLiveness(identity.pid);
          if (liveness !== 'alive') return liveness;
          const observed = readContainmentIncarnation(identity.pid);
          return observed === null ? 'unknown' : observed === identity.incarnation ? 'alive' : 'absent';
        },
      },
      platform: 'linux',
      maxRecordedRoots: MAX_PROXY_RECORDED_PROVIDER_ROOTS,
      // A incarnation is only readable while the process exists, which is what makes it identity evidence.
      readProcessIncarnation: readContainmentIncarnation,
    },
    scheduler,
    holderAuthority,
    observeHolder,
    acceleratedCheckMayAuthorizeAbsence: options.acceleratedCheckMayAuthorizeAbsence ?? false,
    pairingLossObserved: options.pairingLossObserved,
    onOutcome: (outcome) => outcomes.push(outcome),
    onProgressViolation: (lateness) => violations.push(lateness),
  });

  return {
    clock,
    advance,
    enforcer,
    scheduler,
    outcomes,
    violations,
    signalContainment,
    observeContainmentLiveness,
    latchTeardown,
    markContainmentAbsent,
    renewHolderCheck,
    holderCheckAt: bounds.holderCheckAt,
    alive,
    holderAuthority,
    mintExplicit(): ExplicitTeardownAuthorization {
      const authorization = mintExplicitTeardownAuthorization(holderAuthority);
      if (authorization === null) throw new Error('harness holder authority has nothing installed');
      return authorization;
    },
    async observeAbsence(): Promise<ObservedHolderAbsenceAuthorization> {
      const observation = await observeControlHolder(holderAuthority, () => Promise.resolve('absent'), clock);
      if (observation.disposition !== 'absent') throw new Error('expected an absent disposition');
      return observation.authorization;
    },
  };
}

async function runPublishedHolderCheck(harness: Pick<ReturnType<typeof createHarness>, 'scheduler'>): Promise<void> {
  harness.scheduler.runDue();
  await Promise.resolve();
  harness.scheduler.runDue();
  for (let flush = 0; flush < 10; flush += 1) await Promise.resolve();
}

async function pump(
  harness: Pick<ReturnType<typeof createHarness>, 'advance' | 'scheduler' | 'outcomes'>,
  stepMs: number,
  maxSteps = 80,
): Promise<void> {
  for (let step = 0; step < maxSteps; step += 1) {
    harness.scheduler.runDue();
    await Promise.resolve();
    await Promise.resolve();
    if (harness.outcomes.length > 0 && harness.scheduler.pending() === 0) return;
    harness.advance(stepMs);
  }
}

describe('armed provider-proxy enforcer — pre-publication clock bound (unchanged by this batch)', () => {
  it('reaps the recorded set once the adoption deadline arrives', async () => {
    const alive = new Set([CONTAINMENT.pid, 7_001]);
    const harness = createHarness({ adoptionInMs: 0, alive });
    harness.enforcer.registerProviderRoot(root(7_001));

    harness.enforcer.arm();
    harness.scheduler.runDue();
    await vi.waitFor(() => expect(harness.outcomes).toHaveLength(1));

    expect(harness.outcomes[0]?.kind).toBe('containment-absent');
    expect(harness.latchTeardown).toHaveBeenCalledOnce();
    expect(harness.markContainmentAbsent).toHaveBeenCalledOnce();
    expect(alive.size).toBe(0);
  });

  it('names the group, the leader and every recorded root in the disappearance receipt', async () => {
    const harness = createHarness({ adoptionInMs: 0 });
    harness.enforcer.registerProviderRoot(root(7_001));
    harness.enforcer.registerProviderRoot(root(7_002));

    const outcome = await harness.enforcer.stopAndReap(harness.mintExplicit());

    expect(outcome.kind).toBe('settled');
    // Leader exit alone is never absence evidence, so the receipt must account for each target separately.
    expect(outcome).toMatchObject({
      outcome: {
        kind: 'containment-absent',
        disappearanceReceipt: `group:4242,leader:4242@linux:00000000-0000-4000-8000-000000000000:1000,root:7001@linux:00000000-0000-4000-8000-000000000000:2000,root:7002@linux:00000000-0000-4000-8000-000000000000:2000`,
      },
    });
  });

  it('keeps waiting while the adoption deadline is in the future', () => {
    const harness = createHarness({ adoptionInMs: 60_000 });

    harness.enforcer.arm();
    harness.scheduler.runDue();

    expect(harness.outcomes).toHaveLength(0);
    expect(harness.latchTeardown).not.toHaveBeenCalled();
    // It rescheduled rather than settling, so a deadline moved earlier later on is still observed.
    expect(harness.scheduler.pending()).toBe(1);
  });

  it('reports a late wake as a progress-premise violation and still tears the containment down', async () => {
    const harness = createHarness({ adoptionInMs: 0 });
    harness.advance(1_001);

    harness.enforcer.arm();
    harness.scheduler.runDue();
    await vi.waitFor(() => expect(harness.outcomes).toHaveLength(1));

    // Reporting the violation must not abandon teardown: the loaded host that made the wake late is
    // exactly the case where an abandoned containment survives indefinitely.
    expect(harness.violations).toEqual([1_001]);
    expect(harness.outcomes[0]?.kind).toBe('containment-absent');
    expect(harness.latchTeardown).toHaveBeenCalledOnce();
  });

  it('is idempotent across a repeat and a concurrent stop-and-reap', async () => {
    const harness = createHarness({ adoptionInMs: 0 });
    const authorization = harness.mintExplicit();

    const [first, second] = await Promise.all([
      harness.enforcer.stopAndReap(authorization),
      harness.enforcer.stopAndReap(authorization),
    ]);
    const third = await harness.enforcer.stopAndReap(authorization);

    // A retry after a successful reap must report that success, not throw — the shutdown step that
    // retries would otherwise record a failure for work that completed.
    expect(first).toEqual(second);
    expect(third).toEqual(first);
    expect(harness.markContainmentAbsent).toHaveBeenCalledOnce();
    expect(harness.outcomes).toHaveLength(1);
  });

  it('still reaps at exactly the model bound', async () => {
    const harness = createHarness({ adoptionInMs: 0 });
    harness.advance(1_000);

    harness.enforcer.arm();
    harness.scheduler.runDue();
    await vi.waitFor(() => expect(harness.outcomes).toHaveLength(1));

    expect(harness.outcomes[0]?.kind).toBe('containment-absent');
  });

  it('latches teardown before the awaited reap so no concurrent path sees an adoptable set', async () => {
    const harness = createHarness({ adoptionInMs: 0 });

    const pending = harness.enforcer.stopAndReap(harness.mintExplicit());

    expect(harness.latchTeardown).toHaveBeenCalledOnce();
    expect(harness.markContainmentAbsent).not.toHaveBeenCalled();
    await pending;
    expect(harness.markContainmentAbsent).toHaveBeenCalledOnce();
  });

  it('refuses a root count over the recorded cap', () => {
    const harness = createHarness({ adoptionInMs: 60_000 });
    for (let index = 0; index < 128; index += 1) {
      harness.enforcer.registerProviderRoot(root(9_000 + index));
    }

    expect(() => harness.enforcer.registerProviderRoot(root(9_128))).toThrow(EnforcementError);
    expect(harness.enforcer.recordedRoots()).toHaveLength(128);
  });

  it('treats a different incarnation on the same pid as a different target', () => {
    const harness = createHarness({ adoptionInMs: 60_000 });
    harness.enforcer.registerProviderRoot(root(7_001));

    // A recycled pid is not the process that was recorded, so it is a separate target rather than a clash.
    harness.enforcer.registerProviderRoot({ pid: 7_001, incarnation: testIncarnation(3_000) });

    expect(harness.enforcer.recordedRoots()).toHaveLength(2);
  });

  it('holds a reap failure rather than claiming absence', async () => {
    // A recorded root that ignores both signals must not be reported as absent.
    const harness = createHarness({
      adoptionInMs: 0,
      alive: new Set([CONTAINMENT.pid, 7_001]),
      stubborn: new Set([7_001]),
    });
    harness.enforcer.registerProviderRoot(root(7_001));

    const outcome = await harness.enforcer.stopAndReap(harness.mintExplicit());

    expect(outcome).toMatchObject({ kind: 'holding', outcome: { kind: 'reap-failed' } });
    expect(harness.markContainmentAbsent).not.toHaveBeenCalled();
  });

  it('stops waking after disarm', () => {
    const harness = createHarness({ adoptionInMs: 60_000 });
    harness.enforcer.arm();

    harness.enforcer.disarm();
    harness.scheduler.runDue();

    expect(harness.scheduler.pending()).toBe(0);
    expect(harness.outcomes).toHaveLength(0);
  });
});

describe('reaper lifetime after pairing loss', () => {
  it('settles after independently confirming that the recorded containment is absent', async () => {
    const harness = createHarness({
      adoptionInMs: 0,
      published: true,
      observeHolder: () => Promise.resolve('alive'),
      pairingLossObserved: () => true,
    });

    harness.enforcer.arm();
    await runPublishedHolderCheck(harness);
    await vi.waitFor(() => expect(harness.outcomes).toHaveLength(1));

    expect(harness.outcomes[0]?.kind).toBe('containment-absent');
    expect(harness.latchTeardown).toHaveBeenCalledOnce();
    expect(harness.markContainmentAbsent).toHaveBeenCalledOnce();
    expect(harness.signalContainment).not.toHaveBeenCalled();
  });

  it('stays armed and keeps checking while the recorded containment is alive', async () => {
    const harness = createHarness({
      adoptionInMs: 0,
      published: true,
      alive: new Set([CONTAINMENT.pid]),
      observeHolder: () => Promise.resolve('alive'),
      pairingLossObserved: () => true,
    });

    harness.enforcer.arm();
    await runPublishedHolderCheck(harness);
    await vi.waitFor(() => expect(harness.scheduler.pending()).toBe(1));

    expect(harness.observeContainmentLiveness).toHaveBeenCalled();
    expect(harness.outcomes).toHaveLength(0);
    expect(harness.markContainmentAbsent).not.toHaveBeenCalled();
    expect(harness.signalContainment).not.toHaveBeenCalled();
  });

  it('stays armed when the recorded containment is unobservable', async () => {
    const harness = createHarness({
      adoptionInMs: 0,
      published: true,
      alive: new Set([CONTAINMENT.pid]),
      observeHolder: () => Promise.resolve('alive'),
      pairingLossObserved: () => true,
      observeContainmentLiveness: (pid) => (pid < 0 ? 'unknown' : 'alive'),
    });

    harness.enforcer.arm();
    await runPublishedHolderCheck(harness);
    await vi.waitFor(() => expect(harness.scheduler.pending()).toBe(1));

    expect(harness.observeContainmentLiveness).toHaveBeenCalledWith(-CONTAINMENT.processGroupId);
    expect(harness.outcomes).toHaveLength(0);
    expect(harness.markContainmentAbsent).not.toHaveBeenCalled();
    expect(harness.signalContainment).not.toHaveBeenCalled();
  });

  it('does not probe the recorded containment while pairing remains intact', async () => {
    const harness = createHarness({
      adoptionInMs: 0,
      published: true,
      observeHolder: () => Promise.resolve('alive'),
      pairingLossObserved: () => false,
    });

    harness.enforcer.arm();
    await runPublishedHolderCheck(harness);

    expect(harness.observeContainmentLiveness).not.toHaveBeenCalled();
    expect(harness.outcomes).toHaveLength(0);
    expect(harness.scheduler.pending()).toBe(1);
  });
});

describe('stopAndReap / reapAbsentHolder — capability currency (AC2, AC4)', () => {
  it('stopAndReap returns the superseded authorization, and reaps nothing, once it is no longer current', async () => {
    const harness = createHarness({ adoptionInMs: 60_000 });
    const stale = harness.mintExplicit();
    harness.holderAuthority.install({
      controlEpoch: 2,
      holder: { instanceId: 'successor', pid: 4_001, incarnation: testIncarnation('successor') },
    });

    const outcome = await harness.enforcer.stopAndReap(stale);

    expect(outcome).toEqual({ kind: 'authorization-superseded', authorization: stale });
    expect(harness.latchTeardown).not.toHaveBeenCalled();
    expect(harness.outcomes).toHaveLength(0);
  });

  it('reapAbsentHolder returns the superseded authorization, and reaps nothing, once a successor is installed', async () => {
    const harness = createHarness({ adoptionInMs: 60_000, published: true });
    const absence = await harness.observeAbsence();
    harness.holderAuthority.install({
      controlEpoch: 2,
      holder: { instanceId: 'successor', pid: 4_001, incarnation: testIncarnation('successor') },
    });

    const outcome = await harness.enforcer.reapAbsentHolder(absence);

    expect(outcome).toEqual({ kind: 'authorization-superseded', authorization: absence });
    expect(harness.latchTeardown).not.toHaveBeenCalled();
  });

  it('reapAbsentHolder reaps when the capability still names the current holder and epoch', async () => {
    const alive = new Set([CONTAINMENT.pid]);
    const harness = createHarness({ adoptionInMs: 60_000, published: true, alive });
    const absence = await harness.observeAbsence();
    expect(controlHolderAuthorizationIsCurrent(harness.holderAuthority, absence)).toBe(true);

    const outcome = await harness.enforcer.reapAbsentHolder(absence);

    expect(outcome).toMatchObject({ kind: 'settled', outcome: { kind: 'containment-absent' } });
    expect(harness.markContainmentAbsent).toHaveBeenCalledOnce();
  });

  it('returns an unattributable hold separately and permits a later absence-confirming retry', async () => {
    let groupIsAlive = true;
    const harness = createHarness({
      adoptionInMs: 60_000,
      observeContainmentLiveness: (pid) => (pid < 0 && groupIsAlive ? 'alive' : 'absent'),
      readContainmentIncarnation: () => testIncarnation(2_000),
    });

    const first = await harness.enforcer.stopAndReap(harness.mintExplicit());

    expect(first).toMatchObject({
      kind: 'holding',
      outcome: { kind: 'recorded-group-unattributable' },
    });
    expect(first).not.toHaveProperty('outcome.disappearanceReceipt');
    expect(harness.markContainmentAbsent).not.toHaveBeenCalled();
    expect(harness.outcomes).toEqual([
      {
        kind: 'recorded-group-unattributable',
        reason: 'The recorded leader identity is gone, but the surviving process group cannot be attributed.',
      },
    ]);

    groupIsAlive = false;
    const retried = await harness.enforcer.retryUnattributable();

    expect(retried?.kind).toBe('containment-absent');
    expect(harness.markContainmentAbsent).toHaveBeenCalledOnce();
    expect(harness.outcomes.at(-1)?.kind).toBe('containment-absent');
  });
});

describe('giveUp — the local-signal capability (AC2, Phase 3)', () => {
  it('tears down unconditionally, regardless of holder phase or disposition', async () => {
    const alive = new Set([CONTAINMENT.pid]);
    // OS signalling alone must not authorize holder absence.
    const harness = createHarness({ adoptionInMs: 60_000, alive, published: false });

    const disposition = await harness.enforcer.giveUp(mintLocalSignalTeardownAuthorization());

    expect(disposition).toMatchObject({ kind: 'settled', outcome: { kind: 'containment-absent' } });
    expect(harness.markContainmentAbsent).toHaveBeenCalledOnce();
  });

  it('never returns null: it is not a capability a successor’s epoch can revoke', async () => {
    const harness = createHarness({ adoptionInMs: 60_000 });
    harness.holderAuthority.install({
      controlEpoch: 2,
      holder: { instanceId: 'successor', pid: 4_001, incarnation: testIncarnation('successor') },
    });

    const disposition = await harness.enforcer.giveUp(mintLocalSignalTeardownAuthorization());

    expect(disposition).toMatchObject({ kind: 'settled', outcome: { kind: 'containment-absent' } });
  });

  it('returns an unattributable local-signal result as a holding disposition', async () => {
    const harness = createHarness({
      adoptionInMs: 60_000,
      observeContainmentLiveness: (pid) => (pid < 0 ? 'alive' : 'absent'),
      readContainmentIncarnation: () => testIncarnation(2_000),
    });

    const disposition = await harness.enforcer.giveUp(mintLocalSignalTeardownAuthorization());

    expect(disposition).toMatchObject({
      kind: 'holding',
      outcome: { kind: 'recorded-group-unattributable' },
    });
  });
});

describe('published holder observation — the enforcer tick (AC3, AC4)', () => {
  it('starts the observation one end-to-end probe bound plus one wake allowance before the holder gate', () => {
    const observeHolder = vi.fn(() => Promise.resolve<ProcessLiveness>('alive'));
    const observationStartInMs = 1_000;
    const harness = createHarness({
      adoptionInMs: observationStartInMs + PROCESS_INCARNATION_PROBE_TIMEOUT_MS + PROXY_ENFORCER_MAX_WAKE_LATENCY_MS,
      published: true,
      observeHolder,
    });

    harness.enforcer.arm();
    harness.advance(observationStartInMs - 1);
    harness.scheduler.runDue();
    expect(observeHolder).not.toHaveBeenCalled();

    harness.advance(1);
    harness.scheduler.runDue();
    expect(observeHolder).toHaveBeenCalledOnce();
    harness.enforcer.disarm();
  });

  it('an alive result renews the schedule and never reaps, across repeated cycles', async () => {
    const harness = createHarness({
      adoptionInMs: 5_000,
      published: true,
      observeHolder: () => Promise.resolve('alive'),
    });

    harness.enforcer.arm();
    await pump(harness, PROXY_ENFORCER_MAX_WAKE_LATENCY_MS, 40);

    expect(harness.outcomes).toHaveLength(0);
    expect(harness.latchTeardown).not.toHaveBeenCalled();
    expect(harness.renewHolderCheck).toHaveBeenCalled();
  });

  it('an unobservable result holds — retries, authorizes nothing, and never stalls forever', async () => {
    const harness = createHarness({
      adoptionInMs: 5_000,
      published: true,
      observeHolder: () => Promise.resolve('unknown'),
    });

    harness.enforcer.arm();
    await pump(harness, PROXY_ENFORCER_MAX_WAKE_LATENCY_MS, 40);

    expect(harness.outcomes).toHaveLength(0);
    expect(harness.latchTeardown).not.toHaveBeenCalled();
    expect(harness.renewHolderCheck).toHaveBeenCalled();
    expect(harness.scheduler.pending()).toBeGreaterThan(0);
  });

  it('an absent result mints a current-epoch absence authorization and reaps', async () => {
    const alive = new Set([CONTAINMENT.pid]);
    const harness = createHarness({
      adoptionInMs: 5_000,
      published: true,
      alive,
      observeHolder: () => Promise.resolve('absent'),
    });

    harness.enforcer.arm();
    await pump(harness, PROXY_ENFORCER_MAX_WAKE_LATENCY_MS, 40);
    await vi.waitFor(() => expect(harness.outcomes).toHaveLength(1));

    expect(harness.outcomes[0]?.kind).toBe('containment-absent');
  });

  it('disarm invalidates a probe already committed for consumption', async () => {
    let settleProbe!: (liveness: ProcessLiveness) => void;
    const alive = new Set([CONTAINMENT.pid]);
    const harness = createHarness({
      adoptionInMs: 0,
      published: true,
      alive,
      observeHolder: () =>
        new Promise((resolve) => {
          settleProbe = resolve;
        }),
    });

    harness.enforcer.arm();
    harness.scheduler.runDue();
    harness.scheduler.runDue();
    expect(harness.scheduler.pending()).toBe(0);

    harness.enforcer.disarm();
    settleProbe('absent');
    for (let flush = 0; flush < 5; flush += 1) {
      await Promise.resolve();
    }

    expect(harness.signalContainment).not.toHaveBeenCalled();
    expect(alive.has(CONTAINMENT.pid)).toBe(true);
    expect(harness.scheduler.pending()).toBe(0);
    expect(harness.outcomes).toHaveLength(0);
  });

  it('reports lateness measured when a consumed probe settles', async () => {
    let settleProbe!: (liveness: ProcessLiveness) => void;
    const harness = createHarness({
      adoptionInMs: 0,
      published: true,
      observeHolder: () =>
        new Promise((resolve) => {
          settleProbe = resolve;
        }),
    });

    harness.enforcer.arm();
    harness.scheduler.runDue();
    harness.scheduler.runDue();
    harness.advance(PROXY_ENFORCER_MAX_WAKE_LATENCY_MS + 1);
    settleProbe('alive');
    for (let flush = 0; flush < 5; flush += 1) {
      await Promise.resolve();
    }

    expect(harness.violations).toEqual([PROXY_ENFORCER_MAX_WAKE_LATENCY_MS + 1]);
    harness.enforcer.disarm();
  });

  it('a superseded absence renews the loop, observes the successor, and reaps after the successor dies', async () => {
    let resolveObserve!: (liveness: ProcessLiveness) => void;
    let successorIsAlive = true;
    const observed: RecordedProcessIdentity[] = [];
    const observeHolder: AsyncRecordedProcessObserver = (identity) => {
      observed.push(identity);
      if (observed.length === 1) {
        return new Promise((resolve) => {
          resolveObserve = resolve;
        });
      }
      return Promise.resolve(successorIsAlive ? 'alive' : 'absent');
    };
    const harness = createHarness({ adoptionInMs: 5_000, published: true, observeHolder });
    const successor = { instanceId: 'successor', pid: 4_001, incarnation: testIncarnation('successor') } as const;

    harness.enforcer.arm();
    harness.scheduler.runDue();
    harness.advance(20_000);
    harness.scheduler.runDue();
    await Promise.resolve();

    harness.holderAuthority.install({ controlEpoch: 2, holder: successor });
    resolveObserve('absent');
    harness.scheduler.runDue();
    for (let flush = 0; flush < 10; flush += 1) {
      await Promise.resolve();
    }

    expect(harness.outcomes).toHaveLength(0);
    expect(harness.latchTeardown).not.toHaveBeenCalled();
    expect(harness.renewHolderCheck).toHaveBeenCalledWith(harness.holderCheckAt);

    harness.advance(PROXY_ENFORCER_MAX_WAKE_LATENCY_MS);
    await pump(harness, PROXY_ENFORCER_MAX_WAKE_LATENCY_MS, 10);

    expect(observed[1]).toEqual({ pid: successor.pid, incarnation: successor.incarnation });
    expect(harness.outcomes).toHaveLength(0);

    successorIsAlive = false;
    harness.advance(PROXY_ENFORCER_MAX_WAKE_LATENCY_MS);
    await pump(harness, PROXY_ENFORCER_MAX_WAKE_LATENCY_MS, 10);
    await vi.waitFor(() => expect(harness.outcomes).toHaveLength(1));

    expect(harness.outcomes[0]?.kind).toBe('containment-absent');
    expect(harness.markContainmentAbsent).toHaveBeenCalledOnce();
  });

  it.each(['alive', 'unknown'] as const)(
    'a stale %s result renews from the check instant and makes the next probe target the successor',
    async (staleResult) => {
      let resolveObserve!: (liveness: ProcessLiveness) => void;
      const observed: RecordedProcessIdentity[] = [];
      const observeHolder: AsyncRecordedProcessObserver = (subject) => {
        observed.push(subject);
        if (observed.length === 1) {
          return new Promise((resolve) => {
            resolveObserve = resolve;
          });
        }
        return Promise.resolve('alive');
      };
      const harness = createHarness({ adoptionInMs: 5_000, published: true, observeHolder });
      const successor = { instanceId: 'successor', pid: 4_001, incarnation: testIncarnation('successor') } as const;

      harness.enforcer.arm();
      harness.scheduler.runDue();
      harness.advance(20_000);
      harness.scheduler.runDue();
      await Promise.resolve();

      harness.holderAuthority.install({ controlEpoch: 2, holder: successor });
      resolveObserve(staleResult);
      harness.scheduler.runDue();
      for (let flush = 0; flush < 10; flush += 1) {
        await Promise.resolve();
      }

      expect(harness.renewHolderCheck).toHaveBeenCalledWith(harness.holderCheckAt);

      harness.advance(PROXY_ENFORCER_MAX_WAKE_LATENCY_MS);
      await pump(harness, PROXY_ENFORCER_MAX_WAKE_LATENCY_MS, 10);

      expect(observed[1]).toEqual({ pid: successor.pid, incarnation: successor.incarnation });
      expect(harness.outcomes).toHaveLength(0);
      harness.enforcer.disarm();
    },
  );

  it('guardian-mode: an accelerated check may not consume an incumbent absence result', async () => {
    const harness = createHarness({
      adoptionInMs: 5_000,
      published: true,
      accelerated: true,
      observeHolder: () => Promise.resolve('absent'),
      acceleratedCheckMayAuthorizeAbsence: false,
    });

    harness.enforcer.arm();
    await pump(harness, PROXY_ENFORCER_MAX_WAKE_LATENCY_MS, 20);

    // Accelerated absence evidence must defer rather than authorize reaping.
    expect(harness.outcomes).toHaveLength(0);
    expect(harness.renewHolderCheck).toHaveBeenCalled();
  });

  it('reaper-mode: an accelerated check may consume a decisive absence result', async () => {
    const alive = new Set([CONTAINMENT.pid]);
    const harness = createHarness({
      adoptionInMs: 5_000,
      published: true,
      accelerated: true,
      alive,
      observeHolder: () => Promise.resolve('absent'),
      acceleratedCheckMayAuthorizeAbsence: true,
    });

    harness.enforcer.arm();
    await pump(harness, PROXY_ENFORCER_MAX_WAKE_LATENCY_MS, 20);
    await vi.waitFor(() => expect(harness.outcomes).toHaveLength(1));

    expect(harness.outcomes[0]?.kind).toBe('containment-absent');
  });

  it(
    'guardian mode, proxy pairing loss during redemption: the accelerated absent result is deferred, and a ' +
      'successor installed before the ordinary check is what the next observation targets — the incumbent ' +
      'absence is never consumed (AC4)',
    async () => {
      let elapsedMs = 0n;
      const clock = createMonotonicClock(enforcementClockScope, {
        readMilliseconds: () => elapsedMs,
        sleep: (ms: number) => {
          elapsedMs += BigInt(ms);
          return Promise.resolve();
        },
      });
      const advance = (ms: number): void => {
        elapsedMs += BigInt(ms);
      };

      const holderAuthority = createControlHolderAuthority();
      holderAuthority.install({ controlEpoch: 1, holder: HOLDER });
      holderAuthority.publish();
      let challengeCount = 0;
      const deadlines = createEnforcerDeadlineStateMachine(
        clock,
        resolveProviderProxyDeadlineConfiguration({ get: () => undefined }),
        { mintChallenge: () => `pairing-loss-${(challengeCount += 1)}` },
        holderAuthority,
      );

      const successor = { instanceId: 'successor', pid: 4_001, incarnation: testIncarnation('successor') } as const;
      const observed: RecordedProcessIdentity[] = [];
      const observeHolder = (recorded: RecordedProcessIdentity): Promise<ProcessLiveness> => {
        observed.push(recorded);
        return Promise.resolve(observed.length === 1 ? 'absent' : 'alive');
      };

      const alive = new Set<number>([CONTAINMENT.pid]);
      const scheduler = createManualScheduler();
      const outcomes: EnforcementOutcome[] = [];

      const enforcer = createArmedEnforcer({
        clock,
        deadlines,
        containment: CONTAINMENT,
        containmentEnvironment: {
          clock,
          process: {
            kill: (pid) => {
              const targets = pid < 0 ? [...alive] : [pid];
              for (const target of targets) alive.delete(target);
              return true;
            },
            observeLiveness: (pid) => ((pid < 0 ? alive.has(-pid) : alive.has(pid)) ? 'alive' : 'absent'),
            observeRecordedProcessAsync: async (identity) =>
              alive.has(identity.pid) && identity.incarnation === CONTAINMENT.incarnation ? 'alive' : 'absent',
          },
          platform: 'linux',
          maxRecordedRoots: MAX_PROXY_RECORDED_PROVIDER_ROOTS,
          readProcessIncarnation: (pid) => (alive.has(pid) ? CONTAINMENT.incarnation : null),
        },
        scheduler,
        holderAuthority,
        observeHolder,
        // Guardian mode must not independently spend pairing-loss-accelerated absence evidence.
        acceleratedCheckMayAuthorizeAbsence: false,
        onOutcome: (outcome) => outcomes.push(outcome),
        onProgressViolation: () => {},
      });

      enforcer.arm();

      advance(10_000);
      deadlines.observePairingLoss();

      await pump({ advance, scheduler, outcomes }, PROXY_ENFORCER_MAX_WAKE_LATENCY_MS, 10);

      expect(observed).toHaveLength(1);
      expect(observed[0]).toEqual({ pid: HOLDER.pid, incarnation: HOLDER.incarnation });
      expect(outcomes).toHaveLength(0);

      holderAuthority.install({ controlEpoch: 2, holder: successor });

      await pump({ advance, scheduler, outcomes }, PROXY_ENFORCER_MAX_WAKE_LATENCY_MS, 80);

      expect(outcomes).toHaveLength(0);
      expect(observed.length).toBeGreaterThanOrEqual(2);
      expect(observed[1]).toEqual({ pid: successor.pid, incarnation: successor.incarnation });
    },
  );
});

describe('holder-teardown-authorization type currency (AC2)', () => {
  it('controlHolderAuthorizationIsCurrent is false once a successor has been installed', async () => {
    const authority = createControlHolderAuthority();
    authority.install({ controlEpoch: 1, holder: HOLDER });
    const clock = createMonotonicClock(enforcementClockScope, { readMilliseconds: () => 0n });
    const observation = await observeControlHolder(authority, () => Promise.resolve('absent'), clock);
    if (observation.disposition !== 'absent') throw new Error('expected an absent disposition');

    authority.install({
      controlEpoch: 2,
      holder: { instanceId: 'successor', pid: 4_001, incarnation: testIncarnation('successor') },
    });

    expect(controlHolderAuthorizationIsCurrent(authority, observation.authorization)).toBe(false);
  });
});

describe('the killed-coordinator death timetable (AC9)', () => {
  function deadlineConfiguration() {
    return resolveProviderProxyDeadlineConfiguration({ get: () => undefined });
  }

  function challengePolicy(): EnforcerChallengePolicy {
    let count = 0;
    return { mintChallenge: () => `ac9-${(count += 1)}` };
  }

  /** Timetable assertions must exercise the real deadline and enforcer logic. */
  function createTimetableHarness(observe: () => Promise<ProcessLiveness>) {
    let elapsedMs = 0n;
    const clock = createMonotonicClock(enforcementClockScope, {
      readMilliseconds: () => elapsedMs,
      sleep: (ms: number) => {
        elapsedMs += BigInt(ms);
        return Promise.resolve();
      },
    });
    const advance = (ms: number): void => {
      elapsedMs += BigInt(ms);
    };
    const start = clock.now();

    const holderAuthority = createControlHolderAuthority();
    holderAuthority.install({ controlEpoch: 1, holder: HOLDER });
    holderAuthority.publish();
    const deadlines = createEnforcerDeadlineStateMachine(
      clock,
      deadlineConfiguration(),
      challengePolicy(),
      holderAuthority,
    );

    const alive = new Set<number>([CONTAINMENT.pid]);
    const scheduler = createManualScheduler();
    const outcomes: EnforcementOutcome[] = [];

    const enforcer = createArmedEnforcer({
      clock,
      deadlines,
      containment: CONTAINMENT,
      containmentEnvironment: {
        clock,
        process: {
          kill: (pid) => {
            const targets = pid < 0 ? [...alive] : [pid];
            for (const target of targets) alive.delete(target);
            return true;
          },
          observeLiveness: (pid) => ((pid < 0 ? alive.has(-pid) : alive.has(pid)) ? 'alive' : 'absent'),
          observeRecordedProcessAsync: async (identity) =>
            alive.has(identity.pid) && identity.incarnation === CONTAINMENT.incarnation ? 'alive' : 'absent',
        },
        platform: 'linux',
        maxRecordedRoots: MAX_PROXY_RECORDED_PROVIDER_ROOTS,
        readProcessIncarnation: (pid) => (alive.has(pid) ? CONTAINMENT.incarnation : null),
      },
      scheduler,
      holderAuthority,
      observeHolder: observe,
      acceleratedCheckMayAuthorizeAbsence: false,
      onOutcome: (outcome) => outcomes.push(outcome),
      onProgressViolation: () => {},
    });

    return { clock, advance, start, enforcer, scheduler, outcomes };
  }

  it('absent at the first check is reaped within adoptionWindow + teardownReserve, unchanged', async () => {
    const harness = createTimetableHarness(() => Promise.resolve('absent'));

    harness.enforcer.arm();
    await pump(harness, PROXY_ENFORCER_MAX_WAKE_LATENCY_MS, 80);
    await vi.waitFor(() => expect(harness.outcomes).toHaveLength(1));

    expect(harness.outcomes[0]?.kind).toBe('containment-absent');
    const totalMs = harness.clock.millisecondsBetween(harness.start, harness.clock.now());
    const bound =
      providerProxyAdoptionWindowMs({
        orphanTimeoutMs: DEFAULT_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS,
        teardownReserveMs: PROXY_TEARDOWN_RESERVE_MS,
      }) + PROXY_TEARDOWN_RESERVE_MS;
    expect(bound).toBe(DEFAULT_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS);
    expect(totalMs).toBeLessThanOrEqual(bound);
  });

  it('a holder seen alive and then killed — including one seen alive by an early-completing probe — is gone within O of that sample’s own observedAt, never from when it was consumed', async () => {
    let calls = 0;
    let firstAliveObservedAt: MonotonicInstant<typeof enforcementClockScope> | null = null;
    const harness = createTimetableHarness(() => {
      calls += 1;
      if (calls === 1) {
        firstAliveObservedAt = harness.clock.now();
        return Promise.resolve('alive');
      }
      return Promise.resolve('absent');
    });

    harness.enforcer.arm();
    await pump(harness, PROXY_ENFORCER_MAX_WAKE_LATENCY_MS, 30);
    expect(harness.outcomes).toHaveLength(0);
    if (firstAliveObservedAt === null) throw new Error('the first observation never settled');

    await pump(harness, PROXY_ENFORCER_MAX_WAKE_LATENCY_MS, 80);
    await vi.waitFor(() => expect(harness.outcomes).toHaveLength(1));

    expect(harness.outcomes[0]?.kind).toBe('containment-absent');
    const elapsedFromSample = harness.clock.millisecondsBetween(firstAliveObservedAt, harness.clock.now());
    expect(elapsedFromSample).toBeLessThanOrEqual(DEFAULT_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS);
  });
});
