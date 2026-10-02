import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { describe, expect, it, vi } from 'vitest';

import { createMonotonicClock } from '#src/infra/monotonic-clock.js';
import { type AsyncRecordedProcessObserver, type ProcessLiveness } from '#src/infra/node-process.js';
import type { RecordedProcessIdentity } from '#src/infra/process-containment.js';
import type { ActiveControlAuthorization } from '#src/provider-proxy/control-endpoint.js';
import {
  createArmedEnforcer,
  MAX_PROXY_RECORDED_PROVIDER_ROOTS,
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
      const activeControlAuthorization = {} as unknown as ActiveControlAuthorization;
      const authorization = mintExplicitTeardownAuthorization(
        holderAuthority,
        activeControlAuthorization,
        (candidate, subject) => candidate === activeControlAuthorization && subject === holderAuthority.current(),
      );
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

describe('armed provider-proxy enforcer — pre-publication clock bound (unchanged by this batch)', () => {
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
});

describe('stopAndReap / reapAbsentHolder — capability currency (AC2, AC4)', () => {
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
    expect(harness.signalContainment).not.toHaveBeenCalled();
    expect(harness.markContainmentAbsent).not.toHaveBeenCalled();
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
});
