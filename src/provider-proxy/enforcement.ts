import {
  reapRecordedContainment,
  type ProcessContainmentEnvironment,
  type RecordedContainmentIdentity,
  type RecordedProcessIdentity,
} from '../infra/process-containment.js';

import { PROCESS_INCARNATION_PROBE_TIMEOUT_MS, type AsyncRecordedProcessObserver } from '../infra/node-process.js';
import type { MonotonicClock, MonotonicInstant } from '../infra/monotonic-clock.js';
import {
  containmentExecutionDeadline,
  PROXY_ENFORCER_MAX_WAKE_LATENCY_MS,
  PROXY_TEARDOWN_RESERVE_MS,
  type EnforcerDeadlineStateMachine,
} from './orphan-deadline.js';
import {
  controlHolderAuthorizationIsCurrent,
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
  | Readonly<{ kind: 'reap-failed'; reason: string }>;

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
 * Constructible only inside a role's own OS-signal handler: its sole precondition is that this process was
 * signalled, which no remote peer and no autonomous observation can construct. Not substitutable for
 * `ObservedHolderAbsenceAuthorization` or `ExplicitTeardownAuthorization` (holder-lifecycle.ts) despite
 * carrying no public fields either — the branding symbols differ, so a value typed as one can never stand in
 * for another. The three meet only inside this module's private `runTeardown`.
 */
export type LocalSignalTeardownAuthorization = Readonly<{ readonly [localSignalTeardownBrand]: true }>;

/**
 * Mints the capability a role's own SIGTERM/SIGINT handler presents to `ArmedEnforcer.giveUp`. Call this only
 * from within that handler — the precondition it documents, that this process was signalled, is not checked
 * here because there is nothing to check it against; it is true by construction of where this is called from.
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
  /** The one home for this process's holder identity (§7) — the same instance already shared with
   *  `createControlEndpoint` and the deadline machine. This module only reads it: it never installs. */
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
  /** Called once when teardown completes, so the role can report and exit. */
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
  /**
   * Consumes an autonomously observed holder-absence capability. `null` when the capability no longer names
   * the authority's current holder/epoch — a successor was installed after it was minted — in which case
   * nothing was torn down and the caller's own loop continues under the new state. This is not a failure: a
   * revoked capability and a genuine reap failure are different answers and must not share a return shape.
   */
  reapAbsentHolder(authorization: ObservedHolderAbsenceAuthorization): Promise<EnforcementOutcome | null>;
  /** Consumes an explicit teardown capability from a credentialled active-control peer. Same `null`-on-stale
   *  contract as `reapAbsentHolder`. */
  stopAndReap(authorization: ExplicitTeardownAuthorization): Promise<EnforcementOutcome | null>;
  /**
   * Consumes a local-signal capability. Unconditional: an OS signal delivered to this process is not a claim
   * any successor's epoch can revoke, so there is no currency check and no `null` outcome — this always
   * proceeds to teardown.
   */
  giveUp(authorization: LocalSignalTeardownAuthorization): Promise<EnforcementOutcome>;
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
  let teardownInFlight: Promise<EnforcementOutcome> | null = null;
  let settledOutcome: EnforcementOutcome | null = null;
  // The published-holder observation flow's own in-flight probe. A probe is bounded evidence-gathering, not
  // a destructive act, so it is safe to hold across ticks and safe to discard if a renewal supersedes it.
  let holderProbe: { forCheckAt: MonotonicInstant<Scope>; promise: Promise<HolderObservation<Scope>> } | null = null;
  // True only from the instant `tick()` commits to consuming a settled probe until that consumption has
  // decided what to do next. Its sole purpose is stopping a second, concurrently scheduled `tick()` from
  // consuming the same probe a second time; it is reset before any scheduling decision is made, so it never
  // blocks a legitimate `schedule()`.
  let consuming = false;

  const orderedRecordedRoots = (): readonly RecordedProcessIdentity[] => [...roots.values()];
  const wouldExceedRootCap = (root: RecordedProcessIdentity): boolean =>
    !roots.has(rootKey(root)) && roots.size >= MAX_PROXY_RECORDED_PROVIDER_ROOTS;

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
      const outcome = await reapRecordedContainment(
        containment,
        orderedRecordedRoots(),
        exitDeadline,
        containmentEnvironment,
      );
      if (outcome.kind === 'recorded-group-unattributable') {
        return settle({
          kind: 'reap-failed',
          reason: 'The recorded leader identity is gone, but the surviving process group cannot be attributed.',
        });
      }
    } catch (error: unknown) {
      return settle({ kind: 'reap-failed', reason: error instanceof Error ? error.message : 'reap failed' });
    }
    deadlines.markContainmentAbsent();
    return settle({
      kind: 'containment-absent',
      disappearanceReceipt: providerProxyDisappearanceReceipt(containment, orderedRecordedRoots()),
    });
  };

  /**
   * Teardown is idempotent by construction: a repeat returns the settled outcome and a concurrent call
   * joins the one in flight. Two overlapping reaps would signal the same targets twice and let two callers
   * disagree about a single set's fate. Every entry point converges here, so a pending wake is cancelled
   * from this one place rather than by each caller separately.
   */
  const teardown = (exitDeadline: MonotonicInstant<Scope>): Promise<EnforcementOutcome> => {
    if (handle !== null) {
      scheduler.cancel(handle);
      handle = null;
    }
    if (settledOutcome !== null) return Promise.resolve(settledOutcome);
    teardownInFlight ??= runTeardown(exitDeadline);
    return teardownInFlight;
  };

  const consumeAbsence = async (
    authorization: ObservedHolderAbsenceAuthorization,
  ): Promise<EnforcementOutcome | null> => {
    if (!controlHolderAuthorizationIsCurrent(holderAuthority, authorization)) return null;
    return teardown(containmentExecutionDeadline(clock, clock.now()));
  };

  const consumeExplicit = async (authorization: ExplicitTeardownAuthorization): Promise<EnforcementOutcome | null> => {
    if (!controlHolderAuthorizationIsCurrent(holderAuthority, authorization)) return null;
    return teardown(containmentExecutionDeadline(clock, clock.now()));
  };

  const consumeLocalSignal = async (_authorization: LocalSignalTeardownAuthorization): Promise<EnforcementOutcome> => {
    // A fresh full reserve from the signal instant, not the reduced post-wake reserve the not-before-gated
    // capabilities above receive — there is no wake to have already spent: an actual OS signal is delivered
    // directly, not queued behind a not-before gate.
    return teardown(clock.shiftMilliseconds(clock.now(), PROXY_TEARDOWN_RESERVE_MS));
  };

  const observationStartAt = (holderCheckAtInstant: MonotonicInstant<Scope>): MonotonicInstant<Scope> =>
    clock.shiftMilliseconds(
      holderCheckAtInstant,
      -(PROCESS_INCARNATION_PROBE_TIMEOUT_MS + PROXY_ENFORCER_MAX_WAKE_LATENCY_MS),
    );

  /**
   * What a settled probe does next. `alive`/`unobservable` never authorize anything and always renew the
   * schedule so the loop keeps checking; only a consumable `absent` proceeds to teardown. Resets `consuming`
   * as its first act, before making any scheduling decision, so a `schedule()` call below (or a concurrent
   * `arm()`) is judged against current state rather than blocked by a flag whose only job was guarding the
   * wait for this very result.
   */
  const consumeHolderObservation = (
    observation: HolderObservation<Scope>,
    checkedAt: MonotonicInstant<Scope>,
  ): void => {
    consuming = false;
    if (teardownInFlight !== null || settledOutcome !== null) return;
    if (observation.disposition === 'absent') {
      if (deadlines.bounds().holderCheckAccelerated && !acceleratedCheckMayAuthorizeAbsence) {
        // This role may prefetch an accelerated observation but may not consume an incumbent-absence result
        // before the ordinary unaccelerated check: its own pairing peer's loss does not by itself prove the
        // redemption linearizer is gone, and a successor may still be in flight. Advance the schedule past
        // the acceleration and retry at the ordinary cadence, exactly as an inconclusive result would.
        deadlines.renewHolderCheck(checkedAt);
        schedule();
        return;
      }
      void consumeAbsence(observation.authorization);
      return;
    }
    // Neither disposition authorizes anything; both renew, so the loop retries rather than stalling forever
    // (a hold must name what ends it). `alive` renews from the evidence's own `observedAt`; `unobservable`
    // has no positive evidence to anchor to, so it renews from the instant this check was performed —
    // clearing any spent acceleration and avoiding a hot loop without inventing a second, unnamed cadence.
    deadlines.renewHolderCheck(observation.disposition === 'alive' ? observation.observedAt : checkedAt);
    schedule();
  };

  const tick = (): void => {
    handle = null;
    if (teardownInFlight !== null || settledOutcome !== null || consuming) return;

    if (holderAuthority.phase() === 'acquisition-provisional') {
      // No holder has been published: the pure clock bound decides. No operation authority or claim exists
      // yet, so there is nothing for a holder-check schedule to protect.
      const bounds = deadlines.bounds();
      const now = clock.now();
      if (clock.compare(now, bounds.adoptionDeadline) < 0) {
        schedule();
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
        schedule();
        return;
      }
      holderProbe = {
        forCheckAt: holderCheckAtInstant,
        promise: observeControlHolder(holderAuthority, observeHolder, clock),
      };
      schedule();
      return;
    }

    if (clock.compare(now, holderCheckAtInstant) < 0) {
      // The probe may already be settled, but its result cannot be consumed before the not-before gate.
      schedule();
      return;
    }

    const lateness = clock.millisecondsBetween(holderCheckAtInstant, now);
    if (lateness > PROXY_ENFORCER_MAX_WAKE_LATENCY_MS) {
      options.onProgressViolation(lateness);
    }

    consuming = true;
    const probe = holderProbe;
    holderProbe = null;
    void probe.promise.then((observation) => consumeHolderObservation(observation, holderCheckAtInstant));
  };

  const nextWakeTarget = (): MonotonicInstant<Scope> => {
    if (holderAuthority.phase() === 'acquisition-provisional') return deadlines.bounds().adoptionDeadline;
    const holderCheckAtInstant = deadlines.bounds().holderCheckAt;
    return holderProbe === null ? observationStartAt(holderCheckAtInstant) : holderCheckAtInstant;
  };

  const schedule = (): void => {
    if (handle !== null || teardownInFlight !== null || settledOutcome !== null) return;
    const target = nextWakeTarget();
    const remaining = clock.millisecondsBetween(clock.now(), target);
    // Never sleep past the wake bound: a long remaining window still gets checked often enough that a
    // deadline moved earlier by control loss cannot be missed.
    const delay = Math.max(0, Math.min(remaining, PROXY_ENFORCER_MAX_WAKE_LATENCY_MS));
    handle = scheduler.schedule(tick, delay);
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
