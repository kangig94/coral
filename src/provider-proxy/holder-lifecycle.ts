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
 * The starvation-readable disposition `*.holder-status.v1` serves — deliberately not this module's own
 * `HolderDisposition`: `absent` is the word an observation spends to construct teardown authority, and a
 * status read must never carry a word that could be mistaken for that capability. `departed` names the same
 * canonical evidence without minting anything.
 */
export type HolderStatusDisposition = 'alive' | 'unobservable' | 'departed';

/** The identity and disposition share one snapshot so a reader cannot combine different holder admissions.
 *  `changedAtMs` is wall-clock epoch milliseconds, never a process-local monotonic instant. */
export type HolderStatusSnapshot = Readonly<{
  identity: ControlHolderIdentity;
  disposition: HolderStatusDisposition;
  transitionSequence: number;
  changedAtMs: number;
}>;

export type ControlHolderAuthorityOptions = Readonly<{
  /** Wall-clock source for `changedAtMs`. Defaults to `Date.now`, matching `createMonotonicClock`'s own
   *  default ambient reader — production composition (`role-main.ts`) supplies the runtime's own port. */
  wallClockNow?: () => number;
  /** Fired synchronously, exactly once per recorded transition — never on a repeated identical observation,
   *  and never batched. */
  onTransition?: (transition: HolderStatusSnapshot) => void;
}>;

export interface ControlHolderAuthority {
  /** Installs only a holder whose control epoch is strictly greater than the currently installed epoch. */
  install(identity: ControlHolderIdentity): void;
  /** Returns `null` until a holder has been installed. */
  current(): ControlHolderIdentity | null;
  phase(): AcquisitionPhase;
  /** One-way `acquisition-provisional` -> `published`. Idempotent: publishing an already-published authority
   *  changes nothing. */
  publish(): void;
  /** An observation may change status only while its exact holder admission remains installed. */
  recordObservation(subject: ControlHolderIdentity, disposition: HolderStatusDisposition): void;
  /** Returns `null` until a holder has been installed. */
  status(): HolderStatusSnapshot | null;
}

export function createControlHolderAuthority(options: ControlHolderAuthorityOptions = {}): ControlHolderAuthority {
  const wallClockNow = options.wallClockNow ?? Date.now;
  let installed: ControlHolderIdentity | null = null;
  let phase: AcquisitionPhase = 'acquisition-provisional';
  let transitionSequence = 0;
  let status: HolderStatusSnapshot | null = null;

  const transitionTo = (identity: ControlHolderIdentity, disposition: HolderStatusDisposition): void => {
    transitionSequence += 1;
    status = { identity, disposition, transitionSequence, changedAtMs: wallClockNow() };
    options.onTransition?.(status);
  };

  return Object.freeze({
    install(identity: ControlHolderIdentity): void {
      if (installed !== null && identity.controlEpoch <= installed.controlEpoch) {
        throw new Error(
          `A control holder identity must install a strictly greater epoch than the one already installed ` +
            `(${installed.controlEpoch} -> ${identity.controlEpoch}).`,
        );
      }
      installed = identity;
      // A successor's own liveness is unobserved until this authority's own next check confirms it — never
      // inherited from the predecessor's last recorded disposition.
      transitionTo(identity, 'unobservable');
    },
    current: (): ControlHolderIdentity | null => installed,
    phase: (): AcquisitionPhase => phase,
    publish: (): void => {
      phase = 'published';
    },
    recordObservation(subject: ControlHolderIdentity, disposition: HolderStatusDisposition): void {
      if (
        installed === null ||
        installed.controlEpoch !== subject.controlEpoch ||
        !sameControlTenancyHolder(installed.holder, subject.holder)
      ) {
        return;
      }
      if (status !== null && status.disposition === disposition) return;
      transitionTo(installed, disposition);
    },
    status: (): HolderStatusSnapshot | null => status,
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
  | Readonly<{
      disposition: 'alive';
      subject: ControlHolderIdentity;
      observedAt: MonotonicInstant<Scope>;
    }>
  | Readonly<{
      disposition: 'unobservable';
      subject: ControlHolderIdentity | null;
      observedAt: MonotonicInstant<Scope>;
    }>
  | Readonly<{
      disposition: 'absent';
      subject: ControlHolderIdentity;
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
    return { disposition: 'unobservable', subject: null, observedAt: clock.now() };
  }
  const liveness = await observe({ pid: admitted.holder.pid, incarnation: admitted.holder.incarnation });
  const observedAt = clock.now();
  if (liveness === 'alive') {
    authority.recordObservation(admitted, 'alive');
    return { disposition: 'alive', subject: admitted, observedAt };
  }
  if (liveness === 'unknown') {
    authority.recordObservation(admitted, 'unobservable');
    return { disposition: 'unobservable', subject: admitted, observedAt };
  }
  authority.recordObservation(admitted, 'departed');
  return {
    disposition: 'absent',
    subject: admitted,
    observedAt,
    authorization: {
      controlEpoch: admitted.controlEpoch,
      holder: admitted.holder,
    } as unknown as ObservedHolderAbsenceAuthorization,
  };
}

/** A current-subject decision must compare both the admission epoch and the complete process identity. */
export function controlHolderIdentityIsCurrent(
  authority: ControlHolderAuthority,
  subject: ControlHolderIdentity | null,
): boolean {
  const current = authority.current();
  return (
    subject !== null &&
    current !== null &&
    current.controlEpoch === subject.controlEpoch &&
    sameControlTenancyHolder(current.holder, subject.holder)
  );
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
  return controlHolderIdentityIsCurrent(authority, authorization);
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
