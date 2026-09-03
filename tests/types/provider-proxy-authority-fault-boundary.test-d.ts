import type { z } from 'zod';

import type { ContainmentCommitOutcome } from '#src/coordinator/live/provider-proxy/authority.js';
import type {
  ContainmentRequiredControlCallPolicy,
  ControlCallPolicy,
  ProviderProxyAuthorityFault,
  ProviderProxyAuthorityFaultLatch,
  ProviderProxyAuthorityIncident,
  RetrySafeControlCallPolicy,
} from '#src/coordinator/services/provider-proxy-authority-fault.js';
import type {
  ProviderProxySetContainmentRefusedDecision,
  ProviderProxySetDecision,
  ProviderProxySetNonAuthorizingContainmentDecision,
  ProviderProxySetOperatorAbandonmentDecision,
  ProviderProxySetOperatorContainmentDecision,
} from '#src/coordinator/services/provider-proxy-set/decisions.js';
import type { ProviderProxySetIdentity } from '#src/coordinator/services/provider-proxy-set/identity.js';
import type {
  ProcessContainmentEvidence,
  ProviderProxySetDischarge,
  ProviderProxySetOperatorExitCapability,
} from '#src/coordinator/services/provider-proxy-set/index.js';
import type { ControlClientError, ControlExchange } from '#src/provider-proxy/control-client.js';
import {
  applyNoResponse,
  heartbeatObservationFromExchange,
  type HeartbeatObservation,
  type HeartbeatReplyObservation,
} from '#src/provider-proxy/heartbeat-observation.js';
import type { ProviderProxyHeartbeatHoldBound } from '#src/provider-proxy/orphan-deadline.js';
import type { guardianContainmentCommitResultSchema } from '#src/provider-proxy/protocol.js';

declare const setIdentity: ProviderProxySetIdentity;
declare const retrySafePolicy: RetrySafeControlCallPolicy;
declare const containmentPolicy: ContainmentRequiredControlCallPolicy;
declare const latch: ProviderProxyAuthorityFaultLatch;
declare const channelIncident: Extract<ProviderProxyAuthorityIncident, { kind: 'control-channel-fault' }>;

declare const operatorContainment: ProviderProxySetOperatorContainmentDecision;
declare const operatorAbandonment: ProviderProxySetOperatorAbandonmentDecision;

type GuardianContainmentCommitResult = z.output<typeof guardianContainmentCommitResultSchema>;
declare const postLatchContainmentResult: Extract<
  GuardianContainmentCommitResult,
  { state: 'teardown-latched-absence-unconfirmed' }
>;

const validPostLatchContainmentOutcome: Extract<ContainmentCommitOutcome, { kind: 'outcome-unknown' }> = {
  kind: 'outcome-unknown',
  error: postLatchContainmentResult.reason,
};

// @ts-expect-error a post-latch result cannot inhabit the decisive pre-latch `not-sent` disposition.
const invalidPostLatchNotSent: Extract<ContainmentCommitOutcome, { kind: 'not-sent' }> = postLatchContainmentResult;
void [validPostLatchContainmentOutcome, invalidPostLatchNotSent];

// @ts-expect-error exact-set containment is a faultless operator action, never a stop-and-reap decision.
const operatorContainmentCannotStop: Extract<ProviderProxySetDecision, { action: 'stop-and-reap' }> =
  operatorContainment;
void operatorContainmentCannotStop;

// @ts-expect-error abandonment is outside the destructive stop-and-reap action set.
const abandonmentCannotStop: Extract<ProviderProxySetDecision, { action: 'stop-and-reap' }> = operatorAbandonment;
void abandonmentCannotStop;

// @ts-expect-error the deadline and held-state checks are the only mint for this opaque capability.
const forgedOperatorExitCapability: ProviderProxySetOperatorExitCapability = { setIdentity };
void forgedOperatorExitCapability;

// @ts-expect-error a channel ending is an incident and cannot enter the terminal authority latch.
const channelIncidentCannotBeTerminal: ProviderProxyAuthorityFault = channelIncident;
void channelIncidentCannotBeTerminal;

// @ts-expect-error the latch accepts only terminal authority faults, never channel-loss observations.
latch.latch(channelIncident);

const channelIncidentCannotStopAndReap: Extract<ProviderProxySetDecision, { action: 'stop-and-reap' }> = {
  action: 'stop-and-reap',
  reason: 'provider_authority_lost',
  // @ts-expect-error no destructive provider-proxy set decision admits control-channel-fault as its evidence.
  fault: 'control-channel-fault',
  role: 'proxy',
  error: 'closed',
  liveClaims: 1,
  setIdentity,
};
void channelIncidentCannotStopAndReap;

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

declare const forgedControlExchange: Readonly<{
  kind: 'no-response';
  cause: 'timeout';
  error: ControlClientError;
}>;

// @ts-expect-error only the transport owner can mint the exchange brand; matching fields are insufficient.
const invalidForgedControlExchange: ControlExchange = forgedControlExchange;
void invalidForgedControlExchange;

// @ts-expect-error the heartbeat mint accepts only transport-minted exchanges, not a matching object literal.
heartbeatObservationFromExchange({
  kind: 'no-response',
  cause: 'timeout',
  error: {} as ControlClientError,
});

declare const forgedSetDischarge: Readonly<{
  process: Readonly<{ kind: 'containment-absent'; receipt: string }>;
  claims: Readonly<{ kind: 'claims-discharged'; operations: readonly [] }>;
}>;

// @ts-expect-error slot removal requires both owner-minted discharge brands; matching literals carry no authority.
const invalidForgedSetDischarge: ProviderProxySetDischarge = forgedSetDischarge;
void invalidForgedSetDischarge;

declare const roleAcknowledgement: Readonly<{ disappearanceReceipt: string }>;

// @ts-expect-error a role acknowledgement cannot mint the containment owner's discharge capability.
const invalidAcknowledgementDischarge: ProcessContainmentEvidence = {
  kind: 'containment-absent',
  receipt: roleAcknowledgement.disappearanceReceipt,
};
void invalidAcknowledgementDischarge;

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

// @ts-expect-error heartbeat_hold_exhausted no longer authorizes stop-and-reap: it joins its two siblings on
// the non-destructive await-containment-absence action instead.
const invalidHeartbeatHoldExhaustedStopAndReap: ProviderProxySetDecision = {
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
void invalidHeartbeatHoldExhaustedStopAndReap;

const validHeartbeatHoldExhaustedAwaitAbsence: ProviderProxySetDecision = {
  action: 'await-containment-absence',
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
  validHeartbeatHoldExhaustedAwaitAbsence,
];

// Each of the five non-authorizing sources keeps its own field shape rather than a flattened wrapper shape —
// `ProviderProxySetContainmentRefusedDecision.refusedDecision` is the only place they are read back from.
const boundExpiryRefusal: ProviderProxySetNonAuthorizingContainmentDecision = {
  reason: 'control_reattachment_bound_expired',
  fault: 'control-channel-fault',
  role: 'guardian',
  cause: 'closed',
  attempts: 3,
  elapsedMs: 23_000,
  boundMs: 23_000,
  error: 'bound expired',
};
const localFailureRefusal: ProviderProxySetNonAuthorizingContainmentDecision = {
  reason: 'heartbeat_local_failure',
  fault: 'heartbeat-failed',
  role: 'guardian',
  method: 'guardian.heartbeat.v1',
  terminalReason: 'local-failure',
  error: 'cannot encode heartbeat',
};
const heartbeatBoundRefusal: ProviderProxySetNonAuthorizingContainmentDecision = {
  reason: 'heartbeat_hold_exhausted',
  fault: 'heartbeat-hold-exhausted',
  role: 'guardian',
  method: 'guardian.heartbeat.v1',
  lastIncidentReason: 'unanswered',
  attempts: 3,
  elapsedMs: 23_000,
  schedulerLatenessMs: 0,
  error: 'heartbeat timed out',
};
const heartbeatProtocolRefusal: ProviderProxySetNonAuthorizingContainmentDecision = {
  reason: 'heartbeat_protocol_incompatible',
  fault: 'heartbeat-method-not-found',
  role: 'guardian',
  method: 'guardian.heartbeat.v1',
  incidentReason: 'method-not-found',
  error: 'method not found',
};
const operationControlRefusal: ProviderProxySetNonAuthorizingContainmentDecision = {
  reason: 'operation_control_indeterminate',
  fault: 'operation-control-failed',
  policy: containmentPolicy,
  error: 'mutation outcome unknown',
};

const heldWithLiveClaims: ProviderProxySetDecision = {
  action: 'preserve',
  reason: 'containment_refused_live_claims',
  liveClaims: 1,
  setIdentity,
  refusedDecision: heartbeatBoundRefusal,
};

declare const flattenedContainmentRefusalShape: Readonly<{
  action: 'preserve';
  reason: 'containment_refused_live_claims';
  liveClaims: number;
  setIdentity: ProviderProxySetIdentity;
  role: 'guardian';
  method: 'guardian.heartbeat.v1';
}>;

// @ts-expect-error the wrapper carries its source in `refusedDecision`, never flattened onto its own fields.
const flattenedContainmentRefusal: ProviderProxySetContainmentRefusedDecision = flattenedContainmentRefusalShape;

// @ts-expect-error a bare `stop-and-reap` decision cannot be built from a non-authorizing source directly —
// only the peer's exact `teardown-latched` refusal or zero live claims may reach `stop-and-reap`.
const nonAuthorizingCannotStop: Extract<ProviderProxySetDecision, { action: 'stop-and-reap' }> = localFailureRefusal;
void nonAuthorizingCannotStop;

void [boundExpiryRefusal, localFailureRefusal, heartbeatProtocolRefusal, operationControlRefusal, heldWithLiveClaims];
void flattenedContainmentRefusal;
