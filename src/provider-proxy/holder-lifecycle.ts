import type { AsyncRecordedProcessObserver } from '../infra/node-process.js';
import type { MonotonicClock, MonotonicInstant } from '../infra/monotonic-clock.js';
import {
  sameControlTenancyHolder,
  type ActiveControlAuthorization,
  type ControlEpoch,
  type ControlTenancyHolder,
} from './control-endpoint.js';

export type ControlHolderIdentity = Readonly<{ controlEpoch: ControlEpoch; holder: ControlTenancyHolder }>;

/** Operation results and claim authority must not escape while acquisition remains provisional. */
export type AcquisitionPhase = 'acquisition-provisional' | 'published';

/** Status reads must not use `absent`; that disposition is reserved for observations that mint authority. */
export type HolderStatusDisposition = 'alive' | 'unobservable' | 'departed';

/** `changedAtMs` must be wall-clock epoch milliseconds, never a process-local monotonic instant. */
export type HolderStatusSnapshot = Readonly<{
  identity: ControlHolderIdentity;
  disposition: HolderStatusDisposition;
  transitionSequence: number;
  changedAtMs: number;
}>;

export type ControlHolderAuthorityOptions = Readonly<{
  wallClockNow?: () => number;
  /** Transition notifications must be synchronous and unbatched; repeated identical observations must not notify. */
  onTransition?: (transition: HolderStatusSnapshot) => void;
}>;

export interface ControlHolderAuthority {
  /** Installs only a holder whose control epoch is strictly greater than the currently installed epoch. */
  install(identity: ControlHolderIdentity): void;
  current(): ControlHolderIdentity | null;
  phase(): AcquisitionPhase;
  /** Publication must be one-way and idempotent. */
  publish(): void;
  /** An observation may change status only while its exact holder admission remains installed. */
  recordObservation(subject: ControlHolderIdentity, disposition: HolderStatusDisposition): void;
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
      // Predecessor evidence must never determine a successor's liveness.
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

export type HolderDisposition = 'alive' | 'absent' | 'unobservable';

/** `observedAt` must name when the identity-bound observation completed, not when its result is consumed. */
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

/** Observed-absence authorization must be minted only from canonical `absent` evidence. */
declare const observedHolderAbsenceBrand: unique symbol;
export type ObservedHolderAbsenceAuthorization = Readonly<{
  readonly [observedHolderAbsenceBrand]: true;
  readonly controlEpoch: ControlEpoch;
  readonly holder: ControlTenancyHolder;
}>;

/** Explicit-teardown and observed-absence authorizations must remain non-substitutable. */
declare const explicitTeardownBrand: unique symbol;
export type ExplicitTeardownAuthorization = Readonly<{
  readonly [explicitTeardownBrand]: true;
  readonly controlEpoch: ControlEpoch;
  readonly holder: ControlTenancyHolder;
}>;

/** The observation and any authorization it mints must bind to the same pre-probe admission. */
export async function observeControlHolder<Scope extends symbol>(
  authority: ControlHolderAuthority,
  observe: AsyncRecordedProcessObserver,
  clock: MonotonicClock<Scope>,
): Promise<HolderObservation<Scope>> {
  const admitted = authority.current();
  if (admitted === null) {
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

export function controlHolderAuthorizationIsCurrent(
  authority: ControlHolderAuthority,
  authorization: ObservedHolderAbsenceAuthorization | ExplicitTeardownAuthorization,
): boolean {
  return controlHolderIdentityIsCurrent(authority, authorization);
}

/** Explicit-teardown authorization must be minted only after active-control revalidation. */
export function mintExplicitTeardownAuthorization(
  authority: ControlHolderAuthority,
  activeControlAuthorization: ActiveControlAuthorization,
  activeControlAuthorizationIsCurrent: (
    authorization: ActiveControlAuthorization,
    subject: ControlHolderIdentity,
  ) => boolean,
): ExplicitTeardownAuthorization | null {
  const current = authority.current();
  if (current === null) return null;
  if (!activeControlAuthorizationIsCurrent(activeControlAuthorization, current)) return null;
  return { controlEpoch: current.controlEpoch, holder: current.holder } as unknown as ExplicitTeardownAuthorization;
}
