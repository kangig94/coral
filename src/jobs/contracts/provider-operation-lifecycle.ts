import type { PrincipalWire } from '../../security/principal-wire.js';
import type { LaunchPermit, LaunchPool, OperationBindingResult } from './admission.js';

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

export type ProviderOperationBindingIdentity = Readonly<{
  jobId: string;
  operationId: string;
}>;

export type ProviderOperationJournalProbeResult =
  | Readonly<{ kind: 'present' }>
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'unknown'; reason: string }>;

declare const settledUnboundStatusOwnershipBrand: unique symbol;

export type SettledUnboundStatusSubject = Readonly<{
  boundary: string;
  key: string;
  revision: string;
  state: 'active';
}>;

export type SettledUnboundStatusOwnership = Readonly<{
  identity: ProviderOperationBindingIdentity;
  subjects: readonly SettledUnboundStatusSubject[];
  [settledUnboundStatusOwnershipBrand]: true;
}>;

export type SettledUnboundStatusResult =
  | Readonly<{ kind: 'recorded'; ownership: SettledUnboundStatusOwnership }>
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'refused'; reason: string }>;

export interface SettledUnboundStatusPort {
  record(identity: ProviderOperationBindingIdentity): SettledUnboundStatusResult;
  clear(identity: ProviderOperationBindingIdentity, ownership: SettledUnboundStatusOwnership): boolean;
  clearAbsent(identity: ProviderOperationBindingIdentity): boolean;
  clearRefusal(identity: ProviderOperationBindingIdentity): void;
}

export type ProviderOperationBindingState =
  | Readonly<{
      kind: 'settled-unbound';
      identity: ProviderOperationBindingIdentity;
      unknownObservations: number;
      successor:
        | Readonly<{ kind: 'mailbox' }>
        | Readonly<{ kind: 'provider-operation-journal' }>
        | Readonly<{ kind: 'recovery-quarantine'; ownership: SettledUnboundStatusOwnership }>
        | Readonly<{ kind: 'status-recording-refused' }>;
    }>
  | Readonly<{ kind: 'prepared'; sourcePermit: LaunchPermit }>
  | Readonly<{ kind: 'bound'; proxyPermit: LaunchPermit }>
  | Readonly<{ kind: 'settled'; reservationId: string }>;

export interface ProviderOperationBindingPort {
  prepareProviderOperationBinding(
    permit: LaunchPermit,
    identity: ProviderOperationBindingIdentity,
  ): OperationBindingResult;
  cancelProviderOperationBinding(
    permit: LaunchPermit,
    identity: ProviderOperationBindingIdentity,
  ): OperationBindingResult;
  commitProviderOperationBinding(identity: ProviderOperationBindingIdentity): OperationBindingResult;
  settleProviderOperationBinding(identity: ProviderOperationBindingIdentity): OperationBindingResult;
  retireProviderOperationBinding(identity: ProviderOperationBindingIdentity): boolean;
}
