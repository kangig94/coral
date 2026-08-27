import type {
  ContainmentRequiredControlCallPolicy,
  ProviderProxyHeartbeatMethod,
  ProviderProxyHeartbeatTerminalReason,
  ProviderProxyRole,
  RetrySafeControlCallPolicy,
} from '../provider-proxy-authority-fault.js';
import { providerProxySetReference, type ProviderProxySetIdentity } from './identity.js';

type FaultlessDecisionFields = Readonly<{
  fault?: never;
  role?: never;
  method?: never;
  policy?: never;
  error?: never;
}>;

export type ProviderProxySetRetirementReason = 'graceful_idle' | 'excess_capacity' | 'unclaimed_discovery';
export type ProviderProxySetClaimBearingRetirementReason = Exclude<
  ProviderProxySetRetirementReason,
  'unclaimed_discovery'
>;

export type ProviderProxySetPreserveDecision =
  | Readonly<{
      action: 'preserve';
      reason: 'retry_safe_operation_control_failure';
      fault: 'operation-control-failed';
      policy: RetrySafeControlCallPolicy;
      role?: never;
      method?: never;
      incidentReason?: never;
      error: string;
      liveClaims: number;
      setIdentity: ProviderProxySetIdentity;
    }>
  | Readonly<{
      action: 'preserve';
      reason: 'heartbeat_echo_indeterminate';
      fault: 'heartbeat-indeterminate';
      role: ProviderProxyRole;
      method: ProviderProxyHeartbeatMethod;
      /** A rendered label derived after the owner-classified observation has transitioned the evidence window. */
      incidentReason: 'unanswered' | 'unclassified';
      schedulerLatenessMs: number;
      policy?: never;
      error: string;
      liveClaims: number;
      setIdentity: ProviderProxySetIdentity;
    }>;

export type ProviderProxySetOperationFaultStopDecision = Readonly<{
  action: 'stop-and-reap';
  reason: 'provider_authority_lost';
  fault: 'operation-control-failed';
  policy: ContainmentRequiredControlCallPolicy;
  role?: never;
  method?: never;
  error: string;
  liveClaims: number;
  setIdentity: ProviderProxySetIdentity;
}>;

export type ProviderProxySetControlChannelFaultStopDecision = Readonly<{
  action: 'stop-and-reap';
  reason: 'provider_authority_lost';
  fault: 'control-channel-fault';
  role: ProviderProxyRole;
  method?: never;
  policy?: never;
  error: string;
  liveClaims: number;
  setIdentity: ProviderProxySetIdentity;
}>;

export type ProviderProxySetHeartbeatFaultStopDecision = Readonly<{
  action: 'stop-and-reap';
  reason: 'provider_authority_lost';
  fault: 'heartbeat-failed';
  role: ProviderProxyRole;
  method: ProviderProxyHeartbeatMethod;
  terminalReason: ProviderProxyHeartbeatTerminalReason;
  policy?: never;
  error: string;
  liveClaims: number;
  setIdentity: ProviderProxySetIdentity;
}>;

/**
 * This decision requires a continuous window with no peer answer and without material scheduler lateness.
 * It starts containment but must not itself settle peer disappearance.
 */
export type ProviderProxySetHeartbeatHoldExhaustedStopDecision = Readonly<{
  action: 'stop-and-reap';
  reason: 'heartbeat_hold_exhausted';
  fault: 'heartbeat-hold-exhausted';
  role: ProviderProxyRole;
  method: ProviderProxyHeartbeatMethod;
  lastIncidentReason: 'unanswered';
  attempts: number;
  elapsedMs: number;
  schedulerLatenessMs: number;
  policy?: never;
  error: string;
  liveClaims: number;
  setIdentity: ProviderProxySetIdentity;
}>;

type ProviderProxySetHeartbeatDispositionFields = Readonly<{
  role: ProviderProxyRole;
  method: ProviderProxyHeartbeatMethod;
  policy?: never;
  error: string;
  liveClaims: number;
  setIdentity: ProviderProxySetIdentity;
}>;

type ProviderProxySetHeartbeatAnswerUnusableFields = ProviderProxySetHeartbeatDispositionFields &
  Readonly<{
    reason: 'heartbeat_answer_unusable_hold_exhausted';
    fault: 'heartbeat-answer-unusable-hold-exhausted';
    lastIncidentReason: 'unclassified';
    attempts: number;
    elapsedMs: number;
    schedulerLatenessMs: number;
  }>;

type ProviderProxySetHeartbeatProtocolFields = ProviderProxySetHeartbeatDispositionFields &
  Readonly<{
    reason: 'heartbeat_protocol_incompatible';
    fault: 'heartbeat-method-not-found';
    incidentReason: 'method-not-found';
  }>;

type ProviderProxySetHeartbeatAwaitAbsenceFields = Readonly<{
  action: 'await-containment-absence';
  liveClaims: number;
}>;

export type ProviderProxySetHeartbeatAwaitAbsenceDecision =
  | (ProviderProxySetHeartbeatAnswerUnusableFields & ProviderProxySetHeartbeatAwaitAbsenceFields)
  | (ProviderProxySetHeartbeatProtocolFields & ProviderProxySetHeartbeatAwaitAbsenceFields);

export type ProviderProxySetDrainDecision = FaultlessDecisionFields &
  Readonly<{
    action: 'drain';
    // Discovery may already have live durable claims, so it must remain available instead of being retired.
    reason: ProviderProxySetClaimBearingRetirementReason;
    liveClaims: number;
    setIdentity: ProviderProxySetIdentity;
  }>;

export type ProviderProxySetRetirementStopDecision = FaultlessDecisionFields &
  Readonly<{
    action: 'stop-and-reap';
    // Faultless destruction is safe only after every durable claim has left the set.
    reason: ProviderProxySetRetirementReason;
    liveClaims: 0;
    setIdentity: ProviderProxySetIdentity;
  }>;

export type ProviderProxySetAuthorityStopDecision =
  | ProviderProxySetOperationFaultStopDecision
  | ProviderProxySetControlChannelFaultStopDecision
  | ProviderProxySetHeartbeatFaultStopDecision
  | ProviderProxySetHeartbeatHoldExhaustedStopDecision;

export type ProviderProxySetContainmentDecision =
  | ProviderProxySetAuthorityStopDecision
  | ProviderProxySetRetirementStopDecision
  | ProviderProxySetHeartbeatAwaitAbsenceDecision;

export type ProviderProxySetDecision =
  | ProviderProxySetPreserveDecision
  | ProviderProxySetContainmentDecision
  | ProviderProxySetDrainDecision;

export type ProviderProxySetLogSeverity = 'info' | 'warn';

export type ProviderProxySetDecisionLog = Readonly<{
  severity: ProviderProxySetLogSeverity;
  message: string;
}>;

export function renderProviderProxySetDecision(
  decision: ProviderProxySetDecision,
  summary?: string,
): ProviderProxySetDecisionLog {
  const severity: ProviderProxySetLogSeverity =
    decision.reason === 'provider_authority_lost' ||
    decision.reason === 'heartbeat_hold_exhausted' ||
    decision.action === 'await-containment-absence'
      ? 'warn'
      : 'info';
  let fault: string;
  let subject: string;
  let error: string;
  switch (decision.reason) {
    case 'retry_safe_operation_control_failure':
      fault = decision.fault;
      subject = decision.policy.method;
      error = decision.error;
      break;
    case 'heartbeat_echo_indeterminate':
      fault = decision.fault;
      subject = decision.role;
      error = decision.error;
      break;
    case 'provider_authority_lost':
      fault = decision.fault;
      subject = decision.fault === 'operation-control-failed' ? decision.policy.method : decision.role;
      error = decision.error;
      break;
    case 'heartbeat_hold_exhausted':
      fault = decision.fault;
      subject = decision.role;
      error = decision.error;
      break;
    case 'heartbeat_answer_unusable_hold_exhausted':
    case 'heartbeat_protocol_incompatible':
      fault = decision.fault;
      subject = decision.role;
      error = decision.error;
      break;
    case 'graceful_idle':
    case 'excess_capacity':
    case 'unclaimed_discovery':
      fault = 'none';
      subject = 'retirement';
      error = 'none';
      break;
  }
  return {
    severity,
    message: `Provider proxy set action=${decision.action} reason=${decision.reason} fault=${fault} subject=${subject} liveClaims=${decision.liveClaims} set=${providerProxySetReference(decision.setIdentity)} error=${error}${decision.fault === 'heartbeat-failed' ? ` terminalReason=${decision.terminalReason}` : ''}${decision.fault === 'heartbeat-indeterminate' ? ` incidentReason=${decision.incidentReason}` : ''}${decision.fault === 'heartbeat-hold-exhausted' || decision.fault === 'heartbeat-answer-unusable-hold-exhausted' ? ` attempts=${decision.attempts} elapsedMs=${decision.elapsedMs} schedulerLatenessMs=${decision.schedulerLatenessMs} lastIncidentReason=${decision.lastIncidentReason}` : ''}${decision.fault === 'heartbeat-method-not-found' ? ` incidentReason=${decision.incidentReason}` : ''}${summary === undefined ? '' : ` ${summary}`}`,
  };
}
