import type {
  ContainmentRequiredControlCallPolicy,
  ControlCallPolicy,
  ProviderProxyAuthorityFault,
  ProviderProxyAuthorityFaultLatch,
  ProviderProxyAuthorityIncident,
  RetrySafeControlCallPolicy,
} from '#src/coordinator/services/provider-proxy-authority-fault.js';
import type { ProviderProxySetDecision } from '#src/coordinator/services/provider-proxy-set/decisions.js';
import type { ProviderProxySetIdentity } from '#src/coordinator/services/provider-proxy-set/identity.js';
import type { ControlClientError, ControlExchange } from '#src/provider-proxy/control-client.js';
import {
  applyNoResponse,
  heartbeatObservationFromExchange,
  type HeartbeatObservation,
  type HeartbeatReplyObservation,
} from '#src/provider-proxy/heartbeat-observation.js';
import type { ProviderProxyHeartbeatHoldBound } from '#src/provider-proxy/orphan-deadline.js';

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

declare const fakeFaultRetirement: Readonly<{
  action: 'drain';
  reason: 'graceful_idle';
  fault: 'heartbeat-failed';
  role: 'proxy';
  method: 'control.heartbeat.v1';
  error: string;
  liveClaims: 1;
  setIdentity: ProviderProxySetIdentity;
}>;

// @ts-expect-error faultless retirement forbids fault-only evidence so it cannot be logged as authority loss.
const invalidFakeFaultRetirement: ProviderProxySetDecision = fakeFaultRetirement;
void invalidFakeFaultRetirement;

declare const liveClaimUnclaimedDiscoveryDrain: Readonly<{
  action: 'drain';
  reason: 'unclaimed_discovery';
  liveClaims: 3;
  setIdentity: ProviderProxySetIdentity;
}>;

// @ts-expect-error discovered sets with durable claims must remain available instead of entering retirement.
const invalidUnclaimedDiscoveryDrain: ProviderProxySetDecision = liveClaimUnclaimedDiscoveryDrain;
void invalidUnclaimedDiscoveryDrain;

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
const invalidIncident: ProviderProxyAuthorityIncident = containmentOperationIncident;
void invalidIncident;

declare const forgedHeartbeatObservation: Readonly<{
  kind: 'no-response-before-deadline';
  error: ControlClientError;
}>;

// @ts-expect-error only the heartbeat owner can mint the provenance brand; matching fields are insufficient.
const invalidForgedHeartbeatObservation: HeartbeatObservation = forgedHeartbeatObservation;
void invalidForgedHeartbeatObservation;

declare const controlExchange: ControlExchange;
const ownerClassifiedObservation = heartbeatObservationFromExchange(controlExchange);
const heartbeatAuthorityObservation = {
  kind: 'heartbeat-observation' as const,
  role: 'guardian' as const,
  method: 'guardian.heartbeat.v1' as const,
  observation: ownerClassifiedObservation,
  schedulerLatenessMs: 0,
};

// @ts-expect-error heartbeat observations cannot consume the terminal authority-fault latch.
latch.latch(heartbeatAuthorityObservation);

declare const replyObservation: HeartbeatReplyObservation;
declare const heartbeatHoldBound: ProviderProxyHeartbeatHoldBound;
const heartbeatTiming = { nowMonotonicMs: 0n, schedulerLatenessMs: 0, bound: heartbeatHoldBound };
// @ts-expect-error a reply observation cannot enter the no-response reducer.
applyNoResponse({ kind: 'clear' }, replyObservation, heartbeatTiming);

declare const nonDecisiveHeartbeatFault: Readonly<{
  kind: 'heartbeat-failed';
  role: 'guardian';
  method: 'guardian.heartbeat.v1';
  terminalReason: 'unanswered';
  error: 'retry later';
}>;

// @ts-expect-error terminal heartbeat faults accept only decisive refusal reasons.
latch.latch(nonDecisiveHeartbeatFault);

declare const unqualifiedHeartbeatReap: Readonly<{
  action: 'stop-and-reap';
  reason: 'provider_authority_lost';
  fault: 'heartbeat-failed';
  role: 'guardian';
  method: 'guardian.heartbeat.v1';
  error: string;
  liveClaims: number;
  setIdentity: ProviderProxySetIdentity;
}>;

// @ts-expect-error heartbeat containment must name the decisive refusal that authorized it.
const invalidHeartbeatReap: ProviderProxySetDecision = unqualifiedHeartbeatReap;
void invalidHeartbeatReap;

declare const unqualifiedHeartbeatHoldReap: Readonly<{
  action: 'stop-and-reap';
  reason: 'heartbeat_hold_exhausted';
  fault: 'heartbeat-hold-exhausted';
  role: 'guardian';
  method: 'guardian.heartbeat.v1';
  error: string;
  liveClaims: number;
  setIdentity: ProviderProxySetIdentity;
}>;

// @ts-expect-error the coordinator's own bounded escalation must name what it observed: attempts, elapsed span, and the last incident reason — not a bare "exhausted".
const invalidHeartbeatHoldReap: ProviderProxySetDecision = unqualifiedHeartbeatHoldReap;
void invalidHeartbeatHoldReap;

const validHeartbeatHoldReap: ProviderProxySetDecision = {
  action: 'stop-and-reap',
  reason: 'heartbeat_hold_exhausted',
  fault: 'heartbeat-hold-exhausted',
  role: 'guardian',
  method: 'guardian.heartbeat.v1',
  lastIncidentReason: 'unanswered',
  attempts: 3,
  elapsedMs: 23_000,
  schedulerLatenessMs: 0,
  error: 'heartbeat timed out',
  liveClaims: 1,
  setIdentity,
};

const validRetirementDecision: ProviderProxySetDecision = {
  action: 'stop-and-reap',
  reason: 'graceful_idle',
  liveClaims: 0,
  setIdentity,
};
const validIncident: ProviderProxyAuthorityIncident = {
  kind: 'operation-control-failed',
  policy: retrySafePolicy,
  error: 'retry later',
};
const validHeartbeatIncident: ProviderProxyAuthorityIncident = {
  kind: 'heartbeat-observation',
  role: 'guardian',
  method: 'guardian.heartbeat.v1',
  observation: ownerClassifiedObservation,
  schedulerLatenessMs: 0,
};
// A local failure (this process could not construct or send the call at all) is a second decisive
// terminal reason alongside `teardown-latched` — not a disposition about the peer, but still terminal.
const validLocalFailureHeartbeatFault: ProviderProxyAuthorityFault = {
  kind: 'heartbeat-failed',
  role: 'guardian',
  method: 'guardian.heartbeat.v1',
  terminalReason: 'local-failure',
  error: 'cannot encode heartbeat',
};
void [
  validRetirementDecision,
  validIncident,
  validHeartbeatIncident,
  containmentPolicy,
  validLocalFailureHeartbeatFault,
  validHeartbeatHoldReap,
];
