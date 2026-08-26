import type {
  ContainmentRequiredControlCallPolicy,
  ProviderProxyHeartbeatIncidentReason,
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
      incidentReason: ProviderProxyHeartbeatIncidentReason;
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
 * The coordinator's own bounded exit from a heartbeat hold, distinct from `heartbeat-failed`: nothing the
 * endpoint said authorized this — the coordinator observed indeterminate heartbeat incidents continuously for
 * `elapsedMs` with no accepted echo in between and is invoking containment itself, so the decision names what
 * it observed rather than a verdict about the peer.
 */
export type ProviderProxySetHeartbeatHoldExhaustedStopDecision = Readonly<{
  action: 'stop-and-reap';
  reason: 'heartbeat_hold_exhausted';
  fault: 'heartbeat-hold-exhausted';
  role: ProviderProxyRole;
  method: ProviderProxyHeartbeatMethod;
  lastIncidentReason: ProviderProxyHeartbeatIncidentReason;
  attempts: number;
  elapsedMs: number;
  policy?: never;
  error: string;
  liveClaims: number;
  setIdentity: ProviderProxySetIdentity;
}>;

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
  | ProviderProxySetRetirementStopDecision;

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
    decision.reason === 'provider_authority_lost' || decision.reason === 'heartbeat_hold_exhausted' ? 'warn' : 'info';
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
    message: `Provider proxy set action=${decision.action} reason=${decision.reason} fault=${fault} subject=${subject} liveClaims=${decision.liveClaims} set=${providerProxySetReference(decision.setIdentity)} error=${error}${decision.fault === 'heartbeat-failed' ? ` terminalReason=${decision.terminalReason}` : ''}${decision.fault === 'heartbeat-indeterminate' ? ` incidentReason=${decision.incidentReason}` : ''}${decision.fault === 'heartbeat-hold-exhausted' ? ` attempts=${decision.attempts} elapsedMs=${decision.elapsedMs} lastIncidentReason=${decision.lastIncidentReason}` : ''}${summary === undefined ? '' : ` ${summary}`}`,
  };
}
