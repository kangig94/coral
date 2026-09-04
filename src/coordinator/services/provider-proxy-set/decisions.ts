import type {
  ContainmentRequiredControlCallPolicy,
  ProviderProxyControlChannelCause,
  ProviderProxyHeartbeatMethod,
  ProviderProxyHeartbeatTerminalReason,
  ProviderProxyRole,
  RetrySafeControlCallPolicy,
} from '../provider-proxy-authority-fault.js';
import type { ProviderProxyRoleOpenMethod } from '../../live/provider-proxy/role-control.js';
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
      reason: 'control_channel_reattaching';
      fault: 'control-channel-fault';
      role: ProviderProxyRole;
      cause: ProviderProxyControlChannelCause;
      method?: never;
      policy?: never;
      attempts: number;
      elapsedMs: number;
      boundMs: number;
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
    }>
  | ProviderProxySetContainmentRefusedDecision;

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

export type ProviderProxySetControlReattachmentAwaitAbsenceDecision = Readonly<{
  action: 'await-containment-absence';
  reason: 'control_reattachment_refused' | 'control_reattachment_bound_expired';
  fault: 'control-channel-fault';
  role: ProviderProxyRole;
  cause: ProviderProxyControlChannelCause;
  method?: never;
  policy?: never;
  attempts: number;
  elapsedMs: number;
  boundMs: number;
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

export type ProviderProxySetRedemptionTeardownLatchedStopDecision = Readonly<{
  action: 'stop-and-reap';
  reason: 'provider_authority_lost';
  fault: 'control-redemption-refused';
  role: ProviderProxyRole;
  stage: 'open' | 'heartbeat';
  method: ProviderProxyRoleOpenMethod | ProviderProxyHeartbeatMethod;
  terminalReason: 'teardown-latched';
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

/**
 * This decision requires a continuous window with no peer answer and without material scheduler lateness.
 * With live claims present it is not itself authorized to settle peer disappearance — see
 * `ProviderProxySetHeartbeatBoundRefusalDecision`, its non-authorizing counterpart.
 */
type ProviderProxySetHeartbeatHoldExhaustedFields = ProviderProxySetHeartbeatDispositionFields &
  Readonly<{
    reason: 'heartbeat_hold_exhausted';
    fault: 'heartbeat-hold-exhausted';
    lastIncidentReason: 'unanswered';
    attempts: number;
    elapsedMs: number;
    schedulerLatenessMs: number;
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
  | (ProviderProxySetHeartbeatHoldExhaustedFields & ProviderProxySetHeartbeatAwaitAbsenceFields)
  | (ProviderProxySetHeartbeatAnswerUnusableFields & ProviderProxySetHeartbeatAwaitAbsenceFields)
  | (ProviderProxySetHeartbeatProtocolFields & ProviderProxySetHeartbeatAwaitAbsenceFields);

/**
 * The reattachment window's own trigger proved only that a peer answered, or that this coordinator never
 * reached one at all — neither is the peer's decisive `teardown-latched` refusal. Carries the same fields
 * `ProviderProxySetControlReattachmentAwaitAbsenceDecision` does, minus `action`/`liveClaims`/`setIdentity`,
 * which the `ProviderProxySetContainmentRefusedDecision` wrapper supplies once.
 */
export type ProviderProxySetControlReattachmentRefusalDecision = Readonly<{
  reason: 'control_reattachment_bound_expired' | 'control_reattachment_refused';
  fault: 'control-channel-fault';
  role: ProviderProxyRole;
  cause: ProviderProxyControlChannelCause;
  attempts: number;
  elapsedMs: number;
  boundMs: number;
  error: string;
}>;

/** This process could not construct or send a heartbeat call at all — its own failure to reach the peer,
 *  never a disposition about the peer, so it joins the reattachment lifecycle rather than committing. */
export type ProviderProxySetHeartbeatLocalFailureRefusalDecision = Readonly<{
  reason: 'heartbeat_local_failure';
  fault: 'heartbeat-failed';
  role: ProviderProxyRole;
  method: ProviderProxyHeartbeatMethod;
  terminalReason: 'local-failure';
  error: string;
}>;

type ProviderProxySetHeartbeatBoundRefusalFields = Readonly<{
  role: ProviderProxyRole;
  method: ProviderProxyHeartbeatMethod;
  attempts: number;
  elapsedMs: number;
  schedulerLatenessMs: number;
  error: string;
}>;

export type ProviderProxySetHeartbeatBoundRefusalDecision =
  | (ProviderProxySetHeartbeatBoundRefusalFields &
      Readonly<{
        reason: 'heartbeat_hold_exhausted';
        fault: 'heartbeat-hold-exhausted';
        lastIncidentReason: 'unanswered';
      }>)
  | (ProviderProxySetHeartbeatBoundRefusalFields &
      Readonly<{
        reason: 'heartbeat_answer_unusable_hold_exhausted';
        fault: 'heartbeat-answer-unusable-hold-exhausted';
        lastIncidentReason: 'unclassified';
      }>);

export type ProviderProxySetHeartbeatProtocolRefusalDecision = Readonly<{
  reason: 'heartbeat_protocol_incompatible';
  fault: 'heartbeat-method-not-found';
  role: ProviderProxyRole;
  method: ProviderProxyHeartbeatMethod;
  incidentReason: 'method-not-found';
  error: string;
}>;

/** `ProviderProxyAuthorityFault`'s `operation-control-failed` member is always this containment-required
 *  policy shape — a retry-safe mutation failure never reaches this union, it stays on the preserve channel. */
export type ProviderProxySetOperationControlRefusalDecision = Readonly<{
  reason: 'operation_control_indeterminate';
  fault: 'operation-control-failed';
  policy: ContainmentRequiredControlCallPolicy;
  error: string;
}>;

/**
 * Every source this gate declined to treat as decisive, preserved with its own field shape rather than
 * flattened into one. `#recordOperatorDisposition`/`renderProviderProxySetDecision` branch on `reason`
 * within this union instead of reading a wrapper-level field that would collide across sources.
 */
export type ProviderProxySetNonAuthorizingContainmentDecision =
  | ProviderProxySetControlReattachmentRefusalDecision
  | ProviderProxySetHeartbeatLocalFailureRefusalDecision
  | ProviderProxySetHeartbeatBoundRefusalDecision
  | ProviderProxySetHeartbeatProtocolRefusalDecision
  | ProviderProxySetOperationControlRefusalDecision;

/**
 * The claim-bearing counterpart of `stop-and-reap`/`await-containment-absence`: evidence that would have
 * authorized destruction with zero live claims present instead holds, because live claims are present.
 * `action: 'preserve'` reuses the existing rate-limited reporting lifecycle rather than a bespoke one.
 */
export type ProviderProxySetContainmentRefusedDecision = FaultlessDecisionFields &
  Readonly<{
    action: 'preserve';
    reason: 'containment_refused_live_claims';
    liveClaims: number;
    setIdentity: ProviderProxySetIdentity;
    refusedDecision: ProviderProxySetNonAuthorizingContainmentDecision;
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

export type ProviderProxySetOperatorContainmentDecision = FaultlessDecisionFields &
  Readonly<{
    action: 'operator-contain';
    reason: 'operator_exact_set_containment';
    liveClaims: number;
    setIdentity: ProviderProxySetIdentity;
  }>;

export type ProviderProxySetOperatorAbandonmentDecision = FaultlessDecisionFields &
  Readonly<{
    action: 'abandon';
    reason: 'operator_exact_set_abandonment';
    liveClaims: number;
    setIdentity: ProviderProxySetIdentity;
  }>;

export type ProviderProxySetOperatorDecision =
  | ProviderProxySetOperatorContainmentDecision
  | ProviderProxySetOperatorAbandonmentDecision;

export type ProviderProxySetAuthorityStopDecision =
  | ProviderProxySetOperationFaultStopDecision
  | ProviderProxySetHeartbeatFaultStopDecision
  | ProviderProxySetRedemptionTeardownLatchedStopDecision;

export type ProviderProxySetContainmentDecision =
  | ProviderProxySetAuthorityStopDecision
  | ProviderProxySetRetirementStopDecision
  | ProviderProxySetHeartbeatAwaitAbsenceDecision
  | ProviderProxySetControlReattachmentAwaitAbsenceDecision;

export type ProviderProxySetDecision =
  | ProviderProxySetPreserveDecision
  | ProviderProxySetContainmentDecision
  | ProviderProxySetDrainDecision
  | ProviderProxySetOperatorDecision;

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
    decision.reason === 'containment_refused_live_claims' ||
    decision.action === 'await-containment-absence' ||
    decision.action === 'operator-contain' ||
    decision.action === 'abandon'
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
    case 'control_channel_reattaching':
    case 'control_reattachment_refused':
    case 'control_reattachment_bound_expired':
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
    case 'operator_exact_set_containment':
      fault = 'none';
      subject = 'operator';
      error = 'none';
      break;
    case 'operator_exact_set_abandonment':
      fault = 'none';
      subject = 'operator';
      error = 'process absence was not observed';
      break;
    case 'containment_refused_live_claims': {
      const refused = decision.refusedDecision;
      fault = refused.fault;
      subject = refused.reason === 'operation_control_indeterminate' ? refused.policy.method : refused.role;
      error = refused.error;
      break;
    }
  }
  return {
    severity,
    message: `Provider proxy set action=${decision.action} reason=${decision.reason} fault=${fault} subject=${subject} liveClaims=${decision.liveClaims} set=${providerProxySetReference(decision.setIdentity)} error=${error}${decision.fault === 'control-channel-fault' ? ` cause=${decision.cause} attempts=${decision.attempts} elapsedMs=${decision.elapsedMs} boundMs=${decision.boundMs}` : ''}${decision.fault === 'heartbeat-failed' ? ` terminalReason=${decision.terminalReason}` : ''}${decision.fault === 'control-redemption-refused' ? ` stage=${decision.stage} method=${decision.method} terminalReason=${decision.terminalReason}` : ''}${decision.fault === 'heartbeat-indeterminate' ? ` incidentReason=${decision.incidentReason}` : ''}${decision.fault === 'heartbeat-hold-exhausted' || decision.fault === 'heartbeat-answer-unusable-hold-exhausted' ? ` attempts=${decision.attempts} elapsedMs=${decision.elapsedMs} schedulerLatenessMs=${decision.schedulerLatenessMs} lastIncidentReason=${decision.lastIncidentReason}` : ''}${decision.fault === 'heartbeat-method-not-found' ? ` incidentReason=${decision.incidentReason}` : ''}${decision.reason === 'containment_refused_live_claims' ? refusedDecisionDetail(decision.refusedDecision) : ''}${summary === undefined ? '' : ` ${summary}`}`,
  };
}

function refusedDecisionDetail(refused: ProviderProxySetNonAuthorizingContainmentDecision): string {
  switch (refused.reason) {
    case 'control_reattachment_bound_expired':
    case 'control_reattachment_refused':
      return ` cause=${refused.cause} attempts=${refused.attempts} elapsedMs=${refused.elapsedMs} boundMs=${refused.boundMs}`;
    case 'heartbeat_local_failure':
      return ` terminalReason=${refused.terminalReason}`;
    case 'heartbeat_hold_exhausted':
    case 'heartbeat_answer_unusable_hold_exhausted':
      return ` attempts=${refused.attempts} elapsedMs=${refused.elapsedMs} schedulerLatenessMs=${refused.schedulerLatenessMs} lastIncidentReason=${refused.lastIncidentReason}`;
    case 'heartbeat_protocol_incompatible':
      return ` incidentReason=${refused.incidentReason}`;
    case 'operation_control_indeterminate':
      return '';
  }
}
