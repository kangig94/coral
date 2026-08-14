import type {
  ContainmentRequiredControlCallPolicy,
  ControlCallPolicy,
  ProviderProxyAuthorityFaultLatch,
  ProviderProxyOperationIncident,
  ProviderProxySetDecision,
  RetrySafeControlCallPolicy,
} from '#src/coordinator/services/provider-proxy-authority-fault.js';
import type { ProviderProxySetIdentity } from '#src/coordinator/services/provider-proxy-set-identity.js';

declare const setIdentity: ProviderProxySetIdentity;
declare const retrySafePolicy: RetrySafeControlCallPolicy;
declare const containmentPolicy: ContainmentRequiredControlCallPolicy;
declare const latch: ProviderProxyAuthorityFaultLatch;

declare const mutationWithoutDisposition: Readonly<{
  method: string;
  phase: 'executing';
  effect: 'mutation';
  preEffectProtocolCodes: ReadonlySet<never>;
}>;

// @ts-expect-error every mutation must state whether an indeterminate outcome is retry-safe or requires containment.
const invalidMutationPolicy: ControlCallPolicy = mutationWithoutDisposition;
void invalidMutationPolicy;

declare const observationWithDisposition: Readonly<{
  method: string;
  phase: 'executing';
  effect: 'observation';
  indeterminate: 'retry-safe';
  preEffectProtocolCodes: ReadonlySet<never>;
}>;

// @ts-expect-error observation policies do not have an indeterminate mutation disposition.
const invalidObservationPolicy: ControlCallPolicy = observationWithDisposition;
void invalidObservationPolicy;

declare const claimBearingRetirement: Readonly<{
  action: 'stop-and-reap';
  reason: 'graceful_idle';
  liveClaims: 1;
  setIdentity: ProviderProxySetIdentity;
}>;

// @ts-expect-error faultless retirement cannot cross the destructive boundary while claims remain live.
const invalidRetirementDecision: ProviderProxySetDecision = claimBearingRetirement;
void invalidRetirementDecision;

declare const retrySafeOperationFault: Readonly<{
  kind: 'operation-control-failed';
  policy: RetrySafeControlCallPolicy;
  error: unknown;
}>;

// @ts-expect-error retry-safe operation failures cannot consume the terminal authority-fault latch.
latch.latch(retrySafeOperationFault);

declare const retrySafeContainmentDecision: Readonly<{
  action: 'stop-and-reap';
  reason: 'provider_authority_lost';
  fault: 'operation-control-failed';
  policy: RetrySafeControlCallPolicy;
  error: string;
  liveClaims: number;
  setIdentity: ProviderProxySetIdentity;
}>;

// @ts-expect-error operation-fault containment requires a requires-containment mutation policy.
const invalidContainmentDecision: ProviderProxySetDecision = retrySafeContainmentDecision;
void invalidContainmentDecision;

declare const containmentOperationIncident: Readonly<{
  kind: 'operation-control-failed';
  policy: ContainmentRequiredControlCallPolicy;
  error: unknown;
}>;

// @ts-expect-error the non-consuming incident channel accepts only retry-safe mutations.
const invalidIncident: ProviderProxyOperationIncident = containmentOperationIncident;
void invalidIncident;

const validRetirementDecision: ProviderProxySetDecision = {
  action: 'stop-and-reap',
  reason: 'graceful_idle',
  liveClaims: 0,
  setIdentity,
};
const validIncident: ProviderProxyOperationIncident = {
  kind: 'operation-control-failed',
  policy: retrySafePolicy,
  error: 'retry later',
};
void [validRetirementDecision, validIncident, containmentPolicy];
