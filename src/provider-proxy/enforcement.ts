import {
  reapRecordedContainment,
  type ProcessContainmentEnvironment,
  type RecordedContainmentIdentity,
  type RecordedProcessIdentity,
} from '../infra/process-containment.js';
import { MAX_PROXY_OPERATION_LEDGERS } from '../infra/process-constants.js';
import type { MonotonicClock, MonotonicInstant } from '../infra/monotonic-clock.js';
import {
  PROXY_ENFORCER_MAX_WAKE_LATENCY_MS,
  type GuardianDeadlineStateMachine,
  type ReaperDeadlineStateMachine,
} from './orphan-deadline.js';

/**
 * The subset of the two deadline machines this loop drives. Both roles latch, mark and expose bounds the
 * same way; only their state vocabularies differ, which the loop never inspects.
 */
export type EnforcementDeadlineMachine<Scope extends symbol> = Pick<
  GuardianDeadlineStateMachine<Scope> & ReaperDeadlineStateMachine<Scope>,
  'bounds' | 'latchTeardown' | 'markContainmentAbsent'
>;

/** How the enforcement loop schedules its own wakeups. Injected so the bound is testable. */
export interface EnforcementScheduler {
  schedule(callback: () => void, ms: number): { unref?: () => void };
  cancel(handle: { unref?: () => void }): void;
}

export type EnforcementOutcome =
  | Readonly<{ kind: 'containment-absent'; disappearanceReceipt: string }>
  | Readonly<{ kind: 'reap-failed'; reason: string }>;

export type EnforcementErrorCode = 'provider_root_cap_exceeded' | 'provider_root_conflict';

export class EnforcementError extends Error {
  readonly code: EnforcementErrorCode;

  constructor(code: EnforcementErrorCode, message: string) {
    super(message);
    this.name = 'EnforcementError';
    this.code = code;
    Object.setPrototypeOf(this, EnforcementError.prototype);
  }
}

export type ArmedEnforcerOptions<Scope extends symbol> = Readonly<{
  clock: MonotonicClock<Scope>;
  deadlines: EnforcementDeadlineMachine<Scope>;
  containment: RecordedContainmentIdentity;
  containmentEnvironment: ProcessContainmentEnvironment<Scope>;
  scheduler: EnforcementScheduler;
  /** Called once when teardown completes, so the role can report and exit. */
  onOutcome(outcome: EnforcementOutcome): void;
  /**
   * A wake later than the model's bound. Reported as the detected progress-premise failure it is — but it
   * is a diagnostic, not a terminal state: abandoning teardown here would leave the containment alive on
   * exactly the loaded host the guarantee is about.
   */
  onProgressViolation(observedWakeLatencyMs: number): void;
}>;

export interface ArmedEnforcer<Scope extends symbol> {
  /**
   * Records one provider root before it may execute. Recording is what makes the root reachable by
   * identity-directed signalling, so an unrecorded root is outside the containment claim by construction.
   */
  registerProviderRoot(operationId: string, root: RecordedProcessIdentity): void;
  /** The roots recorded so far, in registration order. */
  recordedRoots(): readonly RecordedProcessIdentity[];
  /** Latches teardown now and reaps, regardless of the deadline. Used by `*.stop-and-reap.v1`. */
  stopAndReap(exitDeadline: MonotonicInstant<Scope>): Promise<EnforcementOutcome>;
  /** Starts the independently scheduled loop. Idempotent. */
  arm(): void;
  /** Stops the loop without reaping. Used when the set retires cleanly. */
  disarm(): void;
}

/**
 * Teardown produces a receipt naming what was confirmed absent, so a caller can tell "the recorded set is
 * gone" from "the leader exited". The group and every root appear, because leader exit alone is never
 * absence evidence.
 */
function disappearanceReceipt(
  containment: RecordedContainmentIdentity,
  roots: readonly RecordedProcessIdentity[],
): string {
  const targets = [
    `group:${containment.processGroupId}`,
    `leader:${containment.pid}@${containment.processStartedAtSeconds}`,
    ...roots.map((root) => `root:${root.pid}@${root.processStartedAtSeconds}`),
  ];
  return targets.join(',');
}

export function createArmedEnforcer<Scope extends symbol>(options: ArmedEnforcerOptions<Scope>): ArmedEnforcer<Scope> {
  const { clock, deadlines, containment, containmentEnvironment, scheduler, onOutcome } = options;
  const roots = new Map<string, RecordedProcessIdentity>();
  let handle: { unref?: () => void } | null = null;
  let teardownInFlight: Promise<EnforcementOutcome> | null = null;
  let settledOutcome: EnforcementOutcome | null = null;

  const orderedRoots = (): readonly RecordedProcessIdentity[] => [...roots.values()];

  const settle = (outcome: EnforcementOutcome): EnforcementOutcome => {
    if (settledOutcome === null) {
      settledOutcome = outcome;
      onOutcome(outcome);
    }
    return settledOutcome;
  };

  const runTeardown = async (exitDeadline: MonotonicInstant<Scope>): Promise<EnforcementOutcome> => {
    // Latch before any awaited work so a concurrent path cannot observe an un-latched machine and act as if
    // the set were still adoptable.
    deadlines.latchTeardown();
    try {
      await reapRecordedContainment(containment, orderedRoots(), exitDeadline, containmentEnvironment);
    } catch (error: unknown) {
      return settle({ kind: 'reap-failed', reason: error instanceof Error ? error.message : 'reap failed' });
    }
    deadlines.markContainmentAbsent();
    return settle({
      kind: 'containment-absent',
      disappearanceReceipt: disappearanceReceipt(containment, orderedRoots()),
    });
  };

  /**
   * Teardown is idempotent by construction: a repeat returns the settled outcome and a concurrent call
   * joins the one in flight. Two overlapping reaps would signal the same targets twice and let two callers
   * disagree about a single set's fate.
   */
  const teardown = (exitDeadline: MonotonicInstant<Scope>): Promise<EnforcementOutcome> => {
    if (settledOutcome !== null) return Promise.resolve(settledOutcome);
    teardownInFlight ??= runTeardown(exitDeadline);
    return teardownInFlight;
  };

  const tick = (): void => {
    handle = null;
    if (teardownInFlight !== null || settledOutcome !== null) return;
    const bounds = deadlines.bounds();
    const now = clock.now();
    if (clock.compare(now, bounds.adoptionDeadline) < 0) {
      schedule();
      return;
    }
    // A wake later than the model's bound is a detected progress-premise failure, not an execution that
    // silently counts as satisfying the guarantee.
    const lateness = clock.millisecondsBetween(bounds.adoptionDeadline, now);
    if (lateness > PROXY_ENFORCER_MAX_WAKE_LATENCY_MS) {
      options.onProgressViolation(lateness);
    }
    void teardown(bounds.exitDeadline);
  };

  const schedule = (): void => {
    if (handle !== null || teardownInFlight !== null || settledOutcome !== null) return;
    const bounds = deadlines.bounds();
    const remaining = clock.millisecondsBetween(clock.now(), bounds.adoptionDeadline);
    // Never sleep past the wake bound: a long remaining window still gets checked often enough that a
    // deadline moved earlier by control loss cannot be missed.
    const delay = Math.max(0, Math.min(remaining, PROXY_ENFORCER_MAX_WAKE_LATENCY_MS));
    handle = scheduler.schedule(tick, delay);
    handle.unref?.();
  };

  return {
    registerProviderRoot(operationId: string, root: RecordedProcessIdentity): void {
      const existing = roots.get(operationId);
      if (existing !== undefined) {
        if (existing.pid !== root.pid || existing.processStartedAtSeconds !== root.processStartedAtSeconds) {
          throw new EnforcementError(
            'provider_root_conflict',
            `Operation ${operationId} already recorded a different provider root.`,
          );
        }
        return;
      }
      if (roots.size >= MAX_PROXY_OPERATION_LEDGERS) {
        throw new EnforcementError(
          'provider_root_cap_exceeded',
          `Recorded provider roots would exceed the ${MAX_PROXY_OPERATION_LEDGERS} cap.`,
        );
      }
      roots.set(operationId, root);
    },
    recordedRoots(): readonly RecordedProcessIdentity[] {
      return orderedRoots();
    },
    stopAndReap(exitDeadline: MonotonicInstant<Scope>): Promise<EnforcementOutcome> {
      if (handle !== null) {
        scheduler.cancel(handle);
        handle = null;
      }
      return teardown(exitDeadline);
    },
    arm(): void {
      schedule();
    },
    disarm(): void {
      if (handle === null) return;
      scheduler.cancel(handle);
      handle = null;
    },
  };
}
