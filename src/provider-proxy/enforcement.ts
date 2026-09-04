import { assertNever } from '../infra/error-format.js';
import { PROCESS_INCARNATION_PROBE_TIMEOUT_MS, type AsyncRecordedProcessObserver } from '../infra/node-process.js';
import type { MonotonicClock, MonotonicInstant } from '../infra/monotonic-clock.js';
import {
  ProcessContainmentError,
  reapRecordedContainment,
  type ProcessContainmentEnvironment,
  type RecordedContainmentIdentity,
  type RecordedProcessIdentity,
} from '../infra/process-containment.js';
import {
  containmentExecutionDeadline,
  PROXY_ENFORCER_MAX_WAKE_LATENCY_MS,
  PROXY_TEARDOWN_RESERVE_MS,
  type EnforcerDeadlineStateMachine,
} from './orphan-deadline.js';
import {
  controlHolderAuthorizationIsCurrent,
  controlHolderIdentityIsCurrent,
  observeControlHolder,
  type ControlHolderAuthority,
  type ExplicitTeardownAuthorization,
  type HolderObservation,
  type ObservedHolderAbsenceAuthorization,
} from './holder-lifecycle.js';

/** The subset of the deadline machine this loop drives. */
export type EnforcementDeadlineMachine<Scope extends symbol> = Pick<
  EnforcerDeadlineStateMachine<Scope>,
  'bounds' | 'latchTeardown' | 'markContainmentAbsent' | 'renewHolderCheck'
>;

/** How the enforcement loop schedules its own wakeups. Injected so the bound is testable. */
export interface EnforcementScheduler {
  schedule(callback: () => void, ms: number): { unref?: () => void };
  cancel(handle: { unref?: () => void }): void;
}

export type EnforcementOutcome =
  | Readonly<{ kind: 'containment-absent'; disappearanceReceipt: string }>
  | Readonly<{ kind: 'reap-failed'; reason: string }>
  | Readonly<{ kind: 'recorded-group-unattributable'; reason: string }>;

type SettledEnforcementOutcome = Extract<EnforcementOutcome, { kind: 'containment-absent' }>;
type HoldingEnforcementOutcome = Exclude<EnforcementOutcome, { kind: 'containment-absent' }>;

type PairingLossContainmentObservation = 'absent' | 'present' | 'unobservable';

/** A superseded capability remains in the return value so no consumer can mistake refusal for completion. */
export type EnforcementConsumptionDisposition<Authorization> =
  | Readonly<{ kind: 'settled'; outcome: SettledEnforcementOutcome }>
  | Readonly<{ kind: 'holding'; outcome: HoldingEnforcementOutcome }>
  | Readonly<{ kind: 'authorization-superseded'; authorization: Authorization }>;

/** A local signal can authorize a teardown attempt, but cannot turn unobservable containment into absence. */
export type LocalSignalTeardownDisposition =
  | Readonly<{ kind: 'settled'; outcome: SettledEnforcementOutcome }>
  | Readonly<{ kind: 'holding'; outcome: HoldingEnforcementOutcome }>;

/** How many distinct provider processes one containment may hold as teardown targets. */
export const MAX_PROXY_RECORDED_PROVIDER_ROOTS = 128;

export type EnforcementErrorCode = 'provider_root_cap_exceeded';

export class EnforcementError extends Error {
  readonly code: EnforcementErrorCode;

  constructor(code: EnforcementErrorCode, message: string) {
    super(message);
    this.name = 'EnforcementError';
    this.code = code;
    Object.setPrototypeOf(this, EnforcementError.prototype);
  }
}

declare const localSignalTeardownBrand: unique symbol;
/**
 * Constructible only inside a role's own OS-signal handler. It authorizes attempting teardown, never
 * inferring absence, and is not substitutable for absence or explicit teardown authority.
 */
export type LocalSignalTeardownAuthorization = Readonly<{ readonly [localSignalTeardownBrand]: true }>;

/**
 * Call only from the role's OS-signal handler; no remote peer may mint local signal authority.
 */
export function mintLocalSignalTeardownAuthorization(): LocalSignalTeardownAuthorization {
  return {} as LocalSignalTeardownAuthorization;
}

export type ArmedEnforcerOptions<Scope extends symbol> = Readonly<{
  clock: MonotonicClock<Scope>;
  deadlines: EnforcementDeadlineMachine<Scope>;
  containment: RecordedContainmentIdentity;
  containmentEnvironment: ProcessContainmentEnvironment<Scope>;
  scheduler: EnforcementScheduler;
  /** The canonical holder identity authority. This module may read it but must never install an identity. */
  holderAuthority: ControlHolderAuthority;
  /** The non-blocking, identity-bound observer a published holder's checks are scheduled through. */
  observeHolder: AsyncRecordedProcessObserver;
  /**
   * Whether an absence result observed at a pairing-loss/EOF-accelerated check may be consumed immediately.
   * `true` for the reaper: its pairing peer is the guardian, the redemption linearizer, so that peer's loss
   * means no successor can still be in flight. `false` for the guardian: its pairing peer is the proxy, and
   * the guardian itself still linearizes redemption and may be installing a valid successor, so an
   * accelerated absence result waits for the next ordinary, unaccelerated check before it may be consumed.
   */
  acceleratedCheckMayAuthorizeAbsence: boolean;
  /** Only a permanent pairing loss may enable the independent containment-absence observation. */
  pairingLossObserved?(): boolean;
  /** Any outcome without confirmed absence is non-terminal and may be reported again after a later probe. */
  onOutcome(outcome: EnforcementOutcome): void;
  /**
   * A wake later than the model's bound. Reported as the detected progress-premise failure it is — but it
   * is a diagnostic, not a terminal state: abandoning teardown here would leave the containment alive on
   * exactly the loaded host the guarantee is about.
   */
  onProgressViolation(observedWakeLatencyMs: number): void;
}>;

export interface ArmedEnforcer {
  /**
   * Records one provider root before it may execute. Recording is what makes the root reachable by
   * identity-directed signalling, so an unrecorded root is outside the containment claim by construction.
   * Roots are keyed by process identity: one shared app-server root serving many operations is one target,
   * which is what the reaper's own set-agreement check already assumes.
   */
  registerProviderRoot(root: RecordedProcessIdentity): void;
  /**
   * Whether recording `root` would hit the cap `registerProviderRoot` enforces, without recording anything.
   * A caller that stages the same root on a peer authority before recording it here needs to know it will
   * be accepted *before* committing to that round trip — finding out only afterward would leave the two
   * authorities disagreeing about what this containment holds.
   */
  wouldExceedProviderRootCap(root: RecordedProcessIdentity): boolean;
  /** The roots recorded so far, in registration order. */
  recordedRoots(): readonly RecordedProcessIdentity[];
  reapAbsentHolder(
    authorization: ObservedHolderAbsenceAuthorization,
  ): Promise<EnforcementConsumptionDisposition<ObservedHolderAbsenceAuthorization>>;
  stopAndReap(
    authorization: ExplicitTeardownAuthorization,
  ): Promise<EnforcementConsumptionDisposition<ExplicitTeardownAuthorization>>;
  /** A local signal is irrevocable authority to attempt teardown, not to settle an unattributable result. */
  giveUp(authorization: LocalSignalTeardownAuthorization): Promise<LocalSignalTeardownDisposition>;
  /** Re-observes a teardown-latched group only while an unconfirmed hold remains current. */
  retryUnattributable(): Promise<EnforcementOutcome> | null;
  /** Starts the independently scheduled loop. Idempotent. */
  arm(): void;
  /** Stops the loop without reaping. Used when the set retires cleanly. */
  disarm(): void;
}

/** The only key under which a root can be signalled. */
function rootKey(root: RecordedProcessIdentity): string {
  return `${root.pid}@${root.incarnation}`;
}

/**
 * Teardown produces a receipt naming what was confirmed absent, so a caller can tell "the recorded set is
 * gone" from "the leader exited". The group and every root appear, because leader exit alone is never
 * absence evidence.
 */
export function providerProxyDisappearanceReceipt(
  containment: RecordedContainmentIdentity,
  roots: readonly RecordedProcessIdentity[],
): string {
  const targets = [
    `group:${containment.processGroupId}`,
    `leader:${containment.pid}@${containment.incarnation}`,
    ...roots.map((root) => `root:${root.pid}@${root.incarnation}`),
  ];
  return targets.join(',');
}

export function createArmedEnforcer<Scope extends symbol>(options: ArmedEnforcerOptions<Scope>): ArmedEnforcer {
  const {
    clock,
    deadlines,
    containment,
    containmentEnvironment,
    scheduler,
    holderAuthority,
    observeHolder,
    acceleratedCheckMayAuthorizeAbsence,
    onOutcome,
  } = options;
  const roots = new Map<string, RecordedProcessIdentity>();
  let handle: { unref?: () => void } | null = null;
  let armedGeneration: symbol | null = null;
  let teardownInFlight: Promise<EnforcementOutcome> | null = null;
  let settledOutcome: SettledEnforcementOutcome | null = null;
  let holdingUnconfirmed = false;
  // The published-holder observation flow's own in-flight probe. A probe is bounded evidence-gathering, not
  // a destructive act, so it is safe to hold across ticks and safe to discard if a renewal supersedes it.
  let holderProbe: { forCheckAt: MonotonicInstant<Scope>; promise: Promise<HolderObservation<Scope>> } | null = null;
  let consuming = false;

  const orderedRecordedRoots = (): readonly RecordedProcessIdentity[] => [...roots.values()];
  const wouldExceedRootCap = (root: RecordedProcessIdentity): boolean =>
    !roots.has(rootKey(root)) && roots.size >= MAX_PROXY_RECORDED_PROVIDER_ROOTS;

  const confirmedContainmentAbsentOutcome = (): Extract<EnforcementOutcome, { kind: 'containment-absent' }> => {
    deadlines.markContainmentAbsent();
    return {
      kind: 'containment-absent',
      disappearanceReceipt: providerProxyDisappearanceReceipt(containment, orderedRecordedRoots()),
    };
  };

  const settle = (outcome: SettledEnforcementOutcome): SettledEnforcementOutcome => {
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
      const outcome = await reapRecordedContainment(
        containment,
        orderedRecordedRoots(),
        exitDeadline,
        containmentEnvironment,
      );
      if (outcome.kind === 'recorded-group-unattributable') {
        return {
          kind: 'recorded-group-unattributable',
          reason: 'The recorded leader identity is gone, but the surviving process group cannot be attributed.',
        };
      }
    } catch (error: unknown) {
      return { kind: 'reap-failed', reason: error instanceof Error ? error.message : 'reap failed' };
    }
    return confirmedContainmentAbsentOutcome();
  };

  /** Pairing loss authorizes observation only; this path must never deliver a process-control signal. */
  const probeContainmentAfterPairingLoss = async (): Promise<PairingLossContainmentObservation> => {
    const containmentPresent = new ProcessContainmentError(
      'process_containment_reap_failed',
      'The recorded containment is still present.',
    );
    try {
      const outcome = await reapRecordedContainment(
        containment,
        orderedRecordedRoots(),
        containmentExecutionDeadline(clock, clock.now()),
        {
          ...containmentEnvironment,
          process: {
            ...containmentEnvironment.process,
            kill: () => {
              throw containmentPresent;
            },
          },
        },
      );
      return outcome.kind === 'containment-absent' ? 'absent' : 'unobservable';
    } catch (error: unknown) {
      return error === containmentPresent ? 'present' : 'unobservable';
    }
  };

  /** Concurrent teardown callers must join one reap; only confirmed absence may prevent a later reap. */
  const teardown = (exitDeadline: MonotonicInstant<Scope>): Promise<EnforcementOutcome> => {
    if (handle !== null) {
      scheduler.cancel(handle);
      handle = null;
    }
    if (settledOutcome !== null) return Promise.resolve(settledOutcome);
    if (teardownInFlight === null) {
      holdingUnconfirmed = false;
      teardownInFlight = runTeardown(exitDeadline).then((outcome) => {
        if (outcome.kind !== 'containment-absent') {
          holdingUnconfirmed = true;
          teardownInFlight = null;
          onOutcome(outcome);
          return outcome;
        }
        return settle(outcome);
      });
    }
    return teardownInFlight;
  };

  const consumeAbsence = async (
    authorization: ObservedHolderAbsenceAuthorization,
  ): Promise<EnforcementConsumptionDisposition<ObservedHolderAbsenceAuthorization>> => {
    if (!controlHolderAuthorizationIsCurrent(holderAuthority, authorization)) {
      return { kind: 'authorization-superseded', authorization };
    }
    const outcome = await teardown(containmentExecutionDeadline(clock, clock.now()));
    return outcome.kind === 'containment-absent' ? { kind: 'settled', outcome } : { kind: 'holding', outcome };
  };

  const consumeExplicit = async (
    authorization: ExplicitTeardownAuthorization,
  ): Promise<EnforcementConsumptionDisposition<ExplicitTeardownAuthorization>> => {
    if (!controlHolderAuthorizationIsCurrent(holderAuthority, authorization)) {
      return { kind: 'authorization-superseded', authorization };
    }
    const outcome = await teardown(containmentExecutionDeadline(clock, clock.now()));
    return outcome.kind === 'containment-absent' ? { kind: 'settled', outcome } : { kind: 'holding', outcome };
  };

  const consumeLocalSignal = async (
    _authorization: LocalSignalTeardownAuthorization,
  ): Promise<LocalSignalTeardownDisposition> => {
    // A fresh full reserve from the signal instant, not the reduced post-wake reserve the not-before-gated
    // capabilities above receive — there is no wake to have already spent: an actual OS signal is delivered
    // directly, not queued behind a not-before gate.
    const outcome = await teardown(clock.shiftMilliseconds(clock.now(), PROXY_TEARDOWN_RESERVE_MS));
    return outcome.kind === 'containment-absent' ? { kind: 'settled', outcome } : { kind: 'holding', outcome };
  };

  const observationStartAt = (holderCheckAtInstant: MonotonicInstant<Scope>): MonotonicInstant<Scope> =>
    clock.shiftMilliseconds(
      holderCheckAtInstant,
      -(PROCESS_INCARNATION_PROBE_TIMEOUT_MS + PROXY_ENFORCER_MAX_WAKE_LATENCY_MS),
    );

  const consumeHolderObservation = (
    generation: symbol,
    observation: HolderObservation<Scope>,
    checkedAt: MonotonicInstant<Scope>,
  ): void => {
    if (armedGeneration !== generation) return;
    consuming = false;
    const lateness = clock.millisecondsBetween(checkedAt, clock.now());
    if (lateness > PROXY_ENFORCER_MAX_WAKE_LATENCY_MS) {
      options.onProgressViolation(lateness);
    }
    if (teardownInFlight !== null || settledOutcome !== null) return;
    if (!controlHolderIdentityIsCurrent(holderAuthority, observation.subject)) {
      deadlines.renewHolderCheck(checkedAt);
      schedule(generation);
      return;
    }
    if (observation.disposition === 'absent') {
      if (deadlines.bounds().holderCheckAccelerated && !acceleratedCheckMayAuthorizeAbsence) {
        // This role may prefetch an accelerated observation but may not consume an incumbent-absence result
        // before the ordinary unaccelerated check: its own pairing peer's loss does not by itself prove the
        // redemption linearizer is gone, and a successor may still be in flight. Advance the schedule past
        // the acceleration and retry at the ordinary cadence, exactly as an inconclusive result would.
        deadlines.renewHolderCheck(checkedAt);
        schedule(generation);
        return;
      }
      void consumeAbsence(observation.authorization).then((disposition) => {
        if (armedGeneration !== generation) return;
        switch (disposition.kind) {
          case 'settled':
          case 'holding':
            return;
          case 'authorization-superseded':
            deadlines.renewHolderCheck(checkedAt);
            schedule(generation);
            return;
          default:
            return assertNever(disposition);
        }
      });
      return;
    }
    // Neither disposition authorizes anything; both renew, so the loop retries rather than stalling forever
    // (a hold must name what ends it). `alive` renews from the evidence's own `observedAt`; `unobservable`
    // has no positive evidence to anchor to, so it renews from the instant this check was performed —
    // clearing any spent acceleration and avoiding a hot loop without inventing a second, unnamed cadence.
    deadlines.renewHolderCheck(observation.disposition === 'alive' ? observation.observedAt : checkedAt);
    schedule(generation);
  };

  const tick = (generation: symbol): void => {
    if (armedGeneration !== generation) return;
    handle = null;
    if (teardownInFlight !== null || settledOutcome !== null || consuming) return;

    if (holderAuthority.phase() === 'acquisition-provisional') {
      // No holder has been published: the pure clock bound decides. No operation authority or claim exists
      // yet, so there is nothing for a holder-check schedule to protect.
      const bounds = deadlines.bounds();
      const now = clock.now();
      if (clock.compare(now, bounds.adoptionDeadline) < 0) {
        schedule(generation);
        return;
      }
      const lateness = clock.millisecondsBetween(bounds.adoptionDeadline, now);
      if (lateness > PROXY_ENFORCER_MAX_WAKE_LATENCY_MS) {
        options.onProgressViolation(lateness);
      }
      void teardown(bounds.exitDeadline);
      return;
    }

    const bounds = deadlines.bounds();
    const holderCheckAtInstant = bounds.holderCheckAt;
    const now = clock.now();

    if (holderProbe !== null && clock.compare(holderProbe.forCheckAt, holderCheckAtInstant) !== 0) {
      // A renewal moved the schedule while this probe was still in flight; its eventual resolution is left
      // unconsumed rather than judged against a check it no longer answers.
      holderProbe = null;
    }

    if (holderProbe === null) {
      const startAt = observationStartAt(holderCheckAtInstant);
      if (clock.compare(now, startAt) < 0) {
        schedule(generation);
        return;
      }
      holderProbe = {
        forCheckAt: holderCheckAtInstant,
        promise: observeControlHolder(holderAuthority, observeHolder, clock),
      };
      schedule(generation);
      return;
    }

    if (clock.compare(now, holderCheckAtInstant) < 0) {
      // The probe may already be settled, but its result cannot be consumed before the not-before gate.
      schedule(generation);
      return;
    }

    consuming = true;
    const probe = holderProbe;
    holderProbe = null;
    void probe.promise.then((observation) => {
      if (armedGeneration !== generation) return;
      if (options.pairingLossObserved?.() !== true) {
        consumeHolderObservation(generation, observation, holderCheckAtInstant);
        return;
      }
      void probeContainmentAfterPairingLoss().then((containmentObservation) => {
        if (armedGeneration !== generation) return;
        if (containmentObservation !== 'absent') {
          consumeHolderObservation(generation, observation, holderCheckAtInstant);
          return;
        }
        consuming = false;
        if (teardownInFlight !== null || settledOutcome !== null) return;
        deadlines.latchTeardown();
        settle(confirmedContainmentAbsentOutcome());
      });
    });
  };

  const nextWakeTarget = (): MonotonicInstant<Scope> => {
    if (holderAuthority.phase() === 'acquisition-provisional') return deadlines.bounds().adoptionDeadline;
    const holderCheckAtInstant = deadlines.bounds().holderCheckAt;
    return holderProbe === null ? observationStartAt(holderCheckAtInstant) : holderCheckAtInstant;
  };

  const schedule = (generation: symbol): void => {
    if (armedGeneration !== generation || handle !== null || teardownInFlight !== null || settledOutcome !== null) {
      return;
    }
    const target = nextWakeTarget();
    const remaining = clock.millisecondsBetween(clock.now(), target);
    // Never sleep past the wake bound: a long remaining window still gets checked often enough that a
    // deadline moved earlier by control loss cannot be missed.
    const delay = Math.max(0, Math.min(remaining, PROXY_ENFORCER_MAX_WAKE_LATENCY_MS));
    handle = scheduler.schedule(() => tick(generation), delay);
    handle.unref?.();
  };

  return {
    registerProviderRoot(root: RecordedProcessIdentity): void {
      const key = rootKey(root);
      // Nothing is ever removed: entries are indexed by the process that must die, so dropping one would
      // assert it is gone — and only teardown may conclude that.
      if (roots.has(key)) return;
      if (wouldExceedRootCap(root)) {
        throw new EnforcementError(
          'provider_root_cap_exceeded',
          `Recorded provider roots would exceed the ${MAX_PROXY_RECORDED_PROVIDER_ROOTS} cap.`,
        );
      }
      roots.set(key, root);
    },
    wouldExceedProviderRootCap: wouldExceedRootCap,
    recordedRoots(): readonly RecordedProcessIdentity[] {
      return orderedRecordedRoots();
    },
    reapAbsentHolder: consumeAbsence,
    stopAndReap: consumeExplicit,
    giveUp: consumeLocalSignal,
    retryUnattributable(): Promise<EnforcementOutcome> | null {
      if (!holdingUnconfirmed) return null;
      return teardown(containmentExecutionDeadline(clock, clock.now()));
    },
    arm(): void {
      if (armedGeneration !== null) return;
      const generation = Symbol('armed-enforcer-generation');
      armedGeneration = generation;
      schedule(generation);
    },
    disarm(): void {
      if (armedGeneration === null) return;
      armedGeneration = null;
      consuming = false;
      holderProbe = null;
      if (handle !== null) {
        scheduler.cancel(handle);
        handle = null;
      }
    },
  };
}
