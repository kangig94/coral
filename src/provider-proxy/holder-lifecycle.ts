import type { AsyncRecordedProcessObserver } from '../infra/node-process.js';
import type { MonotonicClock, MonotonicInstant } from '../infra/monotonic-clock.js';
import { sameControlTenancyHolder, type ControlEpoch, type ControlTenancyHolder } from './control-endpoint.js';

/**
 * The complete installed holder identity: who currently holds control, and the epoch at which they earned it.
 * Separate from a bare `ControlTenancyHolder` because an epoch names one specific *admission* of that holder
 * — a reattach on the same holder keeps the epoch, a successor admission always advances it — and every
 * capability below is bound to both fields together, never the holder alone.
 */
export type ControlHolderIdentity = Readonly<{ controlEpoch: ControlEpoch; holder: ControlTenancyHolder }>;

/**
 * `acquisition-provisional` until initial three-role publication commits; `published` afterward. The
 * transition is one-way, and no operation result or claim authority may escape a set while any of its three
 * roles is still `acquisition-provisional`.
 */
export type AcquisitionPhase = 'acquisition-provisional' | 'published';

/**
 * The one home for a guardian/reaper/proxy process's own holder identity (§7). `createControlEndpoint`
 * installs it on every admission; a future enforcer reads it to decide what it is observing. Nothing else in
 * either caller may keep a second copy of `{ controlEpoch, holder }` — a comparison that reads one copy while
 * a reattach validates another is exactly the split this authority exists to close.
 *
 * `controlEpoch` here is never a second counter: it is always the exact value `createControlEndpoint` already
 * minted for this admission (its own `nextEpoch`), installed synchronously in the same admission that minted
 * it. This authority never derives or increments an epoch of its own.
 */
export interface ControlHolderAuthority {
  /**
   * Installs the holder that just earned this tenancy — first admission or a successor's. Must be called
   * synchronously, in the same turn the epoch was minted, with no `await` before the caller's own displaced
   * connection is torn down: a successor's install has to be visible to every later read (including a
   * teardown authorization already in flight) before anything reacts to the predecessor's loss.
   */
  install(identity: ControlHolderIdentity): void;
  /** The currently installed holder, or `null` before any admission has ever occurred — the pure clock
   *  bound decides then, and there is nothing yet for this authority to hold. */
  current(): ControlHolderIdentity | null;
  phase(): AcquisitionPhase;
  /** One-way `acquisition-provisional` -> `published`. Idempotent: publishing an already-published authority
   *  changes nothing. */
  publish(): void;
}

/** Exactly one instance per guardian/reaper/proxy process. Every internal composition inside that process
 *  which needs holder identity reads this same instance; none may construct a second one. */
export function createControlHolderAuthority(): ControlHolderAuthority {
  let installed: ControlHolderIdentity | null = null;
  let phase: AcquisitionPhase = 'acquisition-provisional';

  return Object.freeze({
    install(identity: ControlHolderIdentity): void {
      if (installed !== null && identity.controlEpoch <= installed.controlEpoch) {
        throw new Error(
          `A control holder identity must install a strictly greater epoch than the one already installed ` +
            `(${installed.controlEpoch} -> ${identity.controlEpoch}).`,
        );
      }
      installed = identity;
    },
    current: (): ControlHolderIdentity | null => installed,
    phase: (): AcquisitionPhase => phase,
    publish: (): void => {
      phase = 'published';
    },
  });
}

/**
 * The provider-proxy three-answer disposition: what the identity-bound probe below found. `absent` carries
 * the one capability it authorizes; `alive` and `unobservable` carry nothing to authorize, because pid
 * liveness alone — and the inability to observe at all — must never be read as evidence either way (§11).
 */
export type HolderDisposition = 'alive' | 'absent' | 'unobservable';

/**
 * `observedAt` is the instant the identity evidence was actually obtained — when the probe's own liveness
 * and incarnation reads resolved — never the later instant a caller gets around to consuming the result. A
 * caller that renews a schedule from this timestamp cannot silently borrow extra tolerance a queued or
 * not-before-gated consumption never earned.
 */
export type HolderObservation<Scope extends symbol> =
  | Readonly<{ disposition: 'alive'; observedAt: MonotonicInstant<Scope> }>
  | Readonly<{ disposition: 'unobservable'; observedAt: MonotonicInstant<Scope> }>
  | Readonly<{
      disposition: 'absent';
      observedAt: MonotonicInstant<Scope>;
      authorization: ObservedHolderAbsenceAuthorization;
    }>;

/**
 * Unforgeable: the branding symbol below is module-private, so no object literal built from `controlEpoch`
 * and `holder` alone — however exact a match — can be typed as this capability. Only `observeControlHolder`,
 * on a canonical `absent` result, constructs one.
 */
declare const observedHolderAbsenceBrand: unique symbol;
export type ObservedHolderAbsenceAuthorization = Readonly<{
  readonly [observedHolderAbsenceBrand]: true;
  readonly controlEpoch: ControlEpoch;
  readonly holder: ControlTenancyHolder;
}>;

/**
 * Unforgeable the same way `ObservedHolderAbsenceAuthorization` is, and not substitutable for it despite
 * carrying the identical two public fields: the branding symbols differ, so a value typed as one can never be
 * assigned where the other is expected. The two meet only inside the enforcer's own private idempotent reap;
 * neither may authorize the other's path.
 */
declare const explicitTeardownBrand: unique symbol;
export type ExplicitTeardownAuthorization = Readonly<{
  readonly [explicitTeardownBrand]: true;
  readonly controlEpoch: ControlEpoch;
  readonly holder: ControlTenancyHolder;
}>;

/**
 * The coordinator's exact-set operator override, minted only at the direct force boundary.
 * Deliberately carries no `{ controlEpoch, holder }` binding: unlike the two capabilities above, the operator
 * override must still function while the holder is observed `alive` or `unobservable`, so it cannot be the
 * kind of capability a successor's epoch change silently revokes. It cannot be passed to either enforcer
 * method above, and neither of those two can authorize the operator path — the three are mutually
 * non-substitutable, not a hierarchy.
 */
declare const operatorTeardownBrand: unique symbol;
export type OperatorTeardownAuthorization = Readonly<{ readonly [operatorTeardownBrand]: true }>;

/**
 * Observes the authority's currently admitted holder through `observe` and maps its stricter
 * `alive | absent | unknown` onto this module's `alive | absent | unobservable`, minting
 * `ObservedHolderAbsenceAuthorization` only on canonical `absent`.
 *
 * The identity handed to `observe`, and the identity the capability is bound to, is `admitted` — read once,
 * before `observe` runs — never a later re-read of `authority.current()`. A successor installed while the
 * probe is in flight must not make this mint a capability naming a holder nobody just observed absent;
 * `controlHolderAuthorizationIsCurrent` is the separate, later check that catches exactly that race (and any
 * later one) at consumption time.
 */
export async function observeControlHolder<Scope extends symbol>(
  authority: ControlHolderAuthority,
  observe: AsyncRecordedProcessObserver,
  clock: MonotonicClock<Scope>,
): Promise<HolderObservation<Scope>> {
  const admitted = authority.current();
  if (admitted === null) {
    // Nothing has ever been admitted: a caller that asks anyway gets the answer that authorizes nothing,
    // not a throw.
    return { disposition: 'unobservable', observedAt: clock.now() };
  }
  const liveness = await observe({ pid: admitted.holder.pid, incarnation: admitted.holder.incarnation });
  const observedAt = clock.now();
  if (liveness === 'alive') return { disposition: 'alive', observedAt };
  if (liveness === 'unknown') return { disposition: 'unobservable', observedAt };
  return {
    disposition: 'absent',
    observedAt,
    authorization: {
      controlEpoch: admitted.controlEpoch,
      holder: admitted.holder,
    } as unknown as ObservedHolderAbsenceAuthorization,
  };
}

/**
 * Whether an `ObservedHolderAbsenceAuthorization` or `ExplicitTeardownAuthorization` still names the holder
 * and epoch this authority currently has installed. `install()`'s synchronous, no-`await` admission is what
 * makes this check race-free: a successor accepted after a capability was minted is visible to this check the
 * instant it is accepted, before any teardown built on the stale capability can act on it.
 */
export function controlHolderAuthorizationIsCurrent(
  authority: ControlHolderAuthority,
  authorization: ObservedHolderAbsenceAuthorization | ExplicitTeardownAuthorization,
): boolean {
  const current = authority.current();
  return (
    current !== null &&
    current.controlEpoch === authorization.controlEpoch &&
    sameControlTenancyHolder(current.holder, authorization.holder)
  );
}

/**
 * Mints `ExplicitTeardownAuthorization` from this authority's own current holder — never from a
 * caller-supplied identity, so a forged identity cannot be laundered into a real capability through this
 * function. `null` when nothing is currently admitted: there is no holder to explicitly tear down.
 *
 * This does not itself prove the caller was authorized to request explicit containment; active-control
 * revalidation must precede calling this — the active-control boundary, not this function, decides when
 * explicit containment may be minted at all.
 */
export function mintExplicitTeardownAuthorization(
  authority: ControlHolderAuthority,
): ExplicitTeardownAuthorization | null {
  const current = authority.current();
  if (current === null) return null;
  return { controlEpoch: current.controlEpoch, holder: current.holder } as unknown as ExplicitTeardownAuthorization;
}
