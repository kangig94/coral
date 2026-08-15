import { testIncarnation } from '#tests/helpers/process-incarnation.js';
import { describe, expect, it, vi } from 'vitest';

import { createMonotonicClock } from '#src/infra/monotonic-clock.js';
import type { RecordedProcessIdentity } from '#src/infra/process-containment.js';
import {
  createArmedEnforcer,
  EnforcementError,
  MAX_PROXY_RECORDED_PROVIDER_ROOTS,
  type EnforcementOutcome,
  type EnforcementScheduler,
} from '#src/provider-proxy/enforcement.js';

const CONTAINMENT = { pid: 4_242, incarnation: testIncarnation(1_000), processGroupId: 4_242 } as const;
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

function createHarness(options: { adoptionInMs: number; alive?: Set<number>; stubborn?: ReadonlySet<number> }) {
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
    firstChallengeExpiresAt: null,
  };
  const latchTeardown = vi.fn();
  const markContainmentAbsent = vi.fn();
  const alive = options.alive ?? new Set<number>();
  const stubborn = options.stubborn ?? new Set<number>();
  const scheduler = createManualScheduler();
  const outcomes: EnforcementOutcome[] = [];
  const violations: number[] = [];

  const enforcer = createArmedEnforcer({
    clock,
    deadlines: { bounds: () => bounds, latchTeardown, markContainmentAbsent },
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
        isAlive: (pid) => (pid < 0 ? alive.has(-pid) : alive.has(pid)),
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
    onOutcome: (outcome) => outcomes.push(outcome),
    onProgressViolation: (lateness) => violations.push(lateness),
  });

  return { clock, advance, enforcer, scheduler, outcomes, violations, latchTeardown, markContainmentAbsent, alive };
}

describe('armed provider-proxy enforcer', () => {
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

    const outcome = await harness.enforcer.stopAndReap(harness.clock.shiftMilliseconds(harness.clock.now(), 14_000));

    expect(outcome.kind).toBe('containment-absent');
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
    const deadline = harness.clock.shiftMilliseconds(harness.clock.now(), 14_000);

    const [first, second] = await Promise.all([
      harness.enforcer.stopAndReap(deadline),
      harness.enforcer.stopAndReap(deadline),
    ]);
    const third = await harness.enforcer.stopAndReap(deadline);

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

    const pending = harness.enforcer.stopAndReap(harness.clock.shiftMilliseconds(harness.clock.now(), 14_000));

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

    const outcome = await harness.enforcer.stopAndReap(harness.clock.shiftMilliseconds(harness.clock.now(), 14_000));

    expect(outcome.kind).toBe('reap-failed');
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
