import type { PrincipalWire } from '../../security/principal-wire.js';
import type { LaunchPool } from './admission.js';

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

export type ProviderOperationCleanupIdentity = Readonly<{
  jobId: string;
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
