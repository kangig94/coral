import type { PrincipalWire } from '../../security/principal-wire.js';
import type { LaunchPermit, LaunchPool } from './admission.js';

export type ProviderOperationChildAuthorization = Readonly<{
  principalWire: PrincipalWire;
  namespace: string;
  expiresAtMs: number;
}>;

export type ProviderOperationProtectedEnvironment = Readonly<{
  env: Readonly<Record<string, string>>;
  childAuthorization: ProviderOperationChildAuthorization;
}>;

export type ProviderOperationEnvironmentInput =
  | Readonly<Record<string, string>>
  | ProviderOperationProtectedEnvironment;

export type ProviderOperationCleanupIdentity =
  | Readonly<{
      kind: 'job-local';
      jobId: string;
      pool: LaunchPool;
    }>
  | Readonly<{
      kind: 'proxy-binding';
      jobId: string;
      operationId: string;
      pool: LaunchPool;
    }>;

export interface ProviderOperationCleanupOwner {
  releaseProviderOperationLocalState(identity: ProviderOperationCleanupIdentity): boolean;
}

export interface ProviderOperationCleanupRegistrar {
  register(owner: ProviderOperationCleanupOwner): void;
}

export interface ProviderOperationCleanupPort {
  release(identity: ProviderOperationCleanupIdentity): void;
}

/** Both fields must come from the same provider-operation record and must never be recombined across records. */
export type ProviderOperationBindingIdentity = Readonly<{
  jobId: string;
  operationId: string;
}>;

/** `unknown` must never authorize an absence-dependent binding transition. */
export type ProviderOperationJournalProbeResult =
  | Readonly<{ kind: 'present' }>
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'unknown'; reason: string }>;

export type ProviderOperationBindingRefusal = Readonly<{ kind: 'refused'; reason: string }>;

export type ProviderOperationPrepareResult =
  | Readonly<{ kind: 'prepared' }>
  | Readonly<{ kind: 'bound'; successorPermit: LaunchPermit }>
  | Readonly<{ kind: 'already-settled' }>
  | ProviderOperationBindingRefusal;

export type ProviderOperationCancellationResult = Readonly<{ kind: 'cancelled' }> | ProviderOperationBindingRefusal;

export type ProviderOperationCommitResult =
  | Readonly<{ kind: 'bound'; successorPermit: LaunchPermit }>
  | Readonly<{ kind: 'already-settled' }>
  | ProviderOperationBindingRefusal;

/** `settled-unbound` must remain a live recovery obligation; it is not evidence that no launch reservation exists. */
export type ProviderOperationSettlementResult =
  | Readonly<{ kind: 'settled-unbound' }>
  | Readonly<{ kind: 'settled'; reservationId: string }>
  | Readonly<{ kind: 'already-settled' }>
  | ProviderOperationBindingRefusal;

export type SettledUnboundStatusHydrationResult =
  | Readonly<{ kind: 'settled-unbound' }>
  | Readonly<{ kind: 'already-settled' }>
  | ProviderOperationBindingRefusal;

declare const settledUnboundStatusOwnershipBrand: unique symbol;

export type SettledUnboundStatusSubject = Readonly<{
  boundary: string;
  key: string;
  revision: string;
  state: 'active';
}>;

/** Only the settled-unbound status port may mint this token, and clearing requires the exact token it returned. */
export type SettledUnboundStatusOwnership = Readonly<{
  identity: ProviderOperationBindingIdentity;
  subjects: readonly SettledUnboundStatusSubject[];
  [settledUnboundStatusOwnershipBrand]: true;
}>;

declare const settledUnboundStatusAbsenceBrand: unique symbol;

/** Only an exact journal-absence observation may mint this token; consumers must match its recovery owner before release. */
export type SettledUnboundStatusAbsence = Readonly<{
  identity: ProviderOperationBindingIdentity;
  subject: SettledUnboundStatusSubject;
  [settledUnboundStatusAbsenceBrand]: true;
}>;

export type SettledUnboundStatusResult =
  | Readonly<{ kind: 'recorded'; ownership: SettledUnboundStatusOwnership }>
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'refused'; reason: string }>;

/** Clearing recorded status must reject ownership that does not match both the identity and the current subjects. */
export interface SettledUnboundStatusPort {
  record(identity: ProviderOperationBindingIdentity): SettledUnboundStatusResult;
  rebind(subject: SettledUnboundStatusSubject): SettledUnboundStatusOwnership | null;
  clear(identity: ProviderOperationBindingIdentity, ownership: SettledUnboundStatusOwnership): boolean;
  clearAbsent(identity: ProviderOperationBindingIdentity): boolean;
  clearRefusal(identity: ProviderOperationBindingIdentity): void;
}

/** `settled-unbound` may be returned only after the durable subject has been rebound into local ownership. */
export interface SettledUnboundStatusHydrationPort {
  hydrateSettledUnboundStatus(subject: SettledUnboundStatusSubject): SettledUnboundStatusHydrationResult;
}

export type ProviderOperationBindingRetirementDisposition =
  | Readonly<{ kind: 'retired' }>
  | Readonly<{ kind: 'nothing-to-retire' }>
  | Readonly<{ kind: 'refused'; reason: string }>;

/** Binding transitions must preserve one reservation generation; after binding, only the returned successor permit may release it. */
export interface ProviderOperationBindingPort {
  prepareProviderOperationBinding(
    permit: LaunchPermit,
    identity: ProviderOperationBindingIdentity,
  ): ProviderOperationPrepareResult;
  cancelProviderOperationBinding(
    permit: LaunchPermit,
    identity: ProviderOperationBindingIdentity,
  ): ProviderOperationCancellationResult;
  commitProviderOperationBinding(identity: ProviderOperationBindingIdentity): ProviderOperationCommitResult;
  settleProviderOperationBinding(identity: ProviderOperationBindingIdentity): ProviderOperationSettlementResult;
  retireProviderOperationBinding(
    identity: ProviderOperationBindingIdentity,
  ): ProviderOperationBindingRetirementDisposition;
}
