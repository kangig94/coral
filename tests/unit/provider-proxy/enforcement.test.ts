import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { describe, expect, it, vi } from 'vitest';

import { createMonotonicClock } from '#src/infra/monotonic-clock.js';
import type { ProcessLiveness } from '#src/infra/node-process.js';
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
  /** `false` (the default) leaves the holder authority unpublished, so the tick decides from the pure
   *  clock bound alone. */
  published?: boolean;
  observeHolder?: () => Promise<ProcessLiveness>;
  acceleratedCheckMayAuthorizeAbsence?: boolean;
  /** Forces the fake `bounds().holderCheckAccelerated` this test observes, independent of `adoptionInMs`. */
  accelerated?: boolean;
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
        kill: (pid) => {
          // A negative pid is a group signal, so it reaches every member rather than one process.
          const targets = pid < 0 ? [...alive] : [pid];
          for (const target of targets) {
            if (stubborn.has(target)) continue;
            alive.delete(target);
          }
          return true;
        },
        observeLiveness: (pid) => ((pid < 0 ? alive.has(-pid) : alive.has(pid)) ? 'alive' : 'absent'),
      },
      platform: 'linux',
      maxRecordedRoots: MAX_PROXY_RECORDED_PROVIDER_ROOTS,
      // A incarnation is only readable while the process exists, which is what makes it identity evidence.
      readProcessIncarnation: (pid) => {
        if (!alive.has(pid)) return null;
        return pid === CONTAINMENT.pid ? CONTAINMENT.incarnation : testIncarnation(2_000);
      },
    },
    scheduler,
    holderAuthority,
    observeHolder,
    acceleratedCheckMayAuthorizeAbsence: options.acceleratedCheckMayAuthorizeAbsence ?? false,
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
    latchTeardown,
    markContainmentAbsent,
    renewHolderCheck,
    alive,
    holderAuthority,
    /** Mints a fresh `ExplicitTeardownAuthorization` from this harness's own current holder. */
    mintExplicit(): ExplicitTeardownAuthorization {
      const authorization = mintExplicitTeardownAuthorization(holderAuthority);
      if (authorization === null) throw new Error('harness holder authority has nothing installed');
      return authorization;
    },
    /** Observes the harness's own holder through `observeControlHolder`, the only real constructor of
     *  `ObservedHolderAbsenceAuthorization`. */
    async observeAbsence(): Promise<ObservedHolderAbsenceAuthorization> {
      const observation = await observeControlHolder(holderAuthority, () => Promise.resolve('absent'), clock);
      if (observation.disposition !== 'absent') throw new Error('expected an absent disposition');
      return observation.authorization;
    },
  };
}

/** Advances the fake clock and pumps the manual scheduler until either it settles or `maxSteps` is spent. */
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

    expect(outcome?.kind).toBe('containment-absent');
    // Leader exit alone is never absence evidence, so the receipt must account for each target separately.
    expect(outcome).toMatchObject({
      disappearanceReceipt: `group:4242,leader:4242@linux:00000000-0000-4000-8000-000000000000:1000,root:7001@linux:00000000-0000-4000-8000-000000000000:2000,root:7002@linux:00000000-0000-4000-8000-000000000000:2000`,
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

  it('reports a reap failure rather than claiming absence', async () => {
    // A recorded root that ignores both signals must not be reported as absent.
    const harness = createHarness({
      adoptionInMs: 0,
      alive: new Set([CONTAINMENT.pid, 7_001]),
      stubborn: new Set([7_001]),
    });
    harness.enforcer.registerProviderRoot(root(7_001));

    const outcome = await harness.enforcer.stopAndReap(harness.mintExplicit());

    expect(outcome?.kind).toBe('reap-failed');
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

describe('stopAndReap / reapAbsentHolder — capability currency (AC2, AC4)', () => {
  it('stopAndReap returns null, and reaps nothing, once the authorization no longer names the current holder', async () => {
    const harness = createHarness({ adoptionInMs: 60_000 });
    const stale = harness.mintExplicit();
    harness.holderAuthority.install({
      controlEpoch: 2,
      holder: { instanceId: 'successor', pid: 4_001, incarnation: testIncarnation('successor') },
    });

    const outcome = await harness.enforcer.stopAndReap(stale);

    expect(outcome).toBeNull();
    expect(harness.latchTeardown).not.toHaveBeenCalled();
    expect(harness.outcomes).toHaveLength(0);
  });

  it('reapAbsentHolder returns null, and reaps nothing, once a successor has been installed', async () => {
    const harness = createHarness({ adoptionInMs: 60_000, published: true });
    const absence = await harness.observeAbsence();
    harness.holderAuthority.install({
      controlEpoch: 2,
      holder: { instanceId: 'successor', pid: 4_001, incarnation: testIncarnation('successor') },
    });

    const outcome = await harness.enforcer.reapAbsentHolder(absence);

    expect(outcome).toBeNull();
    expect(harness.latchTeardown).not.toHaveBeenCalled();
  });

  it('reapAbsentHolder reaps when the capability still names the current holder and epoch', async () => {
    const alive = new Set([CONTAINMENT.pid]);
    const harness = createHarness({ adoptionInMs: 60_000, published: true, alive });
    const absence = await harness.observeAbsence();
    expect(controlHolderAuthorizationIsCurrent(harness.holderAuthority, absence)).toBe(true);

    const outcome = await harness.enforcer.reapAbsentHolder(absence);

    expect(outcome?.kind).toBe('containment-absent');
    expect(harness.markContainmentAbsent).toHaveBeenCalledOnce();
  });
});

describe('giveUp — the local-signal capability (AC2, Phase 3)', () => {
  it('tears down unconditionally, regardless of holder phase or disposition', async () => {
    const alive = new Set([CONTAINMENT.pid]);
    // Deliberately unpublished and with no observer wired to say anything useful: an OS signal to this
    // process is not a claim any holder observation can refuse.
    const harness = createHarness({ adoptionInMs: 60_000, alive, published: false });

    const outcome = await harness.enforcer.giveUp(mintLocalSignalTeardownAuthorization());

    expect(outcome.kind).toBe('containment-absent');
    expect(harness.markContainmentAbsent).toHaveBeenCalledOnce();
  });

  it('never returns null: it is not a capability a successor’s epoch can revoke', async () => {
    const harness = createHarness({ adoptionInMs: 60_000 });
    harness.holderAuthority.install({
      controlEpoch: 2,
      holder: { instanceId: 'successor', pid: 4_001, incarnation: testIncarnation('successor') },
    });

    const outcome = await harness.enforcer.giveUp(mintLocalSignalTeardownAuthorization());

    expect(outcome.kind).toBe('containment-absent');
  });
});

describe('published holder observation — the enforcer tick (AC3, AC4)', () => {
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
    // The loop is still alive — it did not park forever with nothing scheduled.
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

  it('a successor installed while the probe is in flight revokes the absence result before consumption', async () => {
    let resolveObserve!: (liveness: ProcessLiveness) => void;
    const observeHolder = (): Promise<ProcessLiveness> =>
      new Promise((resolve) => {
        resolveObserve = resolve;
      });
    const harness = createHarness({ adoptionInMs: 5_000, published: true, observeHolder });

    harness.enforcer.arm();
    // First wake: still before `observationStartAt` (holderCheckAt(5000) - P(2000) - W(1000) = 2000), so it
    // only reschedules.
    harness.scheduler.runDue();
    harness.advance(20_000);
    // Second wake: past `observationStartAt` — starts the probe (unresolved) and reschedules once more.
    harness.scheduler.runDue();
    await Promise.resolve();

    // A successor is admitted before the probe (of the incumbent) ever resolves.
    harness.holderAuthority.install({
      controlEpoch: 2,
      holder: { instanceId: 'successor', pid: 4_001, incarnation: testIncarnation('successor') },
    });
    resolveObserve('absent');
    // Third wake: past `holderCheckAt` — commits to consuming the (already-resolved) probe.
    harness.scheduler.runDue();
    // Every hop from here is a microtask (the fake clock's own `sleep` resolves via `Promise.resolve()`,
    // never a real timer), so draining a generous number of turns is deterministic, not a race.
    for (let flush = 0; flush < 10; flush += 1) {
      await Promise.resolve();
    }

    expect(harness.outcomes).toHaveLength(0);
    expect(harness.latchTeardown).not.toHaveBeenCalled();
  });

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

    // Deferred, not reaped: the accelerated result is treated like an inconclusive one and the schedule is
    // renewed rather than authorizing absence.
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

  /** Wires the real deadline machine to the real armed enforcer — production defaults, no manual `bounds`
   *  stand-in — so a settled outcome's elapsed time is the timetable this criterion asserts, not a mock's. */
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
        // Captured at the instant the probe is *called*, matching what `observeControlHolder` itself reads:
        // this fake resolves through a bare microtask with no `sleep`, so no fake-clock time separates the
        // two reads.
        firstAliveObservedAt = harness.clock.now();
        return Promise.resolve('alive');
      }
      return Promise.resolve('absent');
    });

    harness.enforcer.arm();
    // Run only far enough for the first (alive) observation to settle and renew the schedule; nothing may
    // reap yet.
    await pump(harness, PROXY_ENFORCER_MAX_WAKE_LATENCY_MS, 30);
    expect(harness.outcomes).toHaveLength(0);
    if (firstAliveObservedAt === null) throw new Error('the first observation never settled');

    // The holder dies sometime before the renewed gate; the next check finds it absent.
    await pump(harness, PROXY_ENFORCER_MAX_WAKE_LATENCY_MS, 80);
    await vi.waitFor(() => expect(harness.outcomes).toHaveLength(1));

    expect(harness.outcomes[0]?.kind).toBe('containment-absent');
    const elapsedFromSample = harness.clock.millisecondsBetween(firstAliveObservedAt, harness.clock.now());
    expect(elapsedFromSample).toBeLessThanOrEqual(DEFAULT_PROVIDER_PROXY_ORPHAN_TIMEOUT_MS);
  });
});
