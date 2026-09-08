import { encodeProviderProxySetAddress, type ProviderProxySetAddress } from '../../../provider-proxy/set-address.js';
import type { TimePort, TimerHandle } from '../../../infra/port-types.js';
import type { ProcessIncarnation, RecordedProcessObserver } from '../../../infra/node-process.js';
import { assertNever, errorMessage } from '../../../infra/error-format.js';
import type { OperationIdentity } from '../../../provider-proxy/protocol.js';
import {
  applyAnswer,
  applyNoResponse,
  type HeartbeatEvidenceWindow,
} from '../../../provider-proxy/heartbeat-observation.js';
import { type HandoffCapsule, type HandoffCapsuleV3 } from '../../../provider-proxy/handoff-capsule.js';
import {
  providerProxySetEnforcerVerdict,
  type ProviderProxySetContainmentEvidence,
  type ProviderProxySetEnforcerObservations,
} from '../../../provider-proxy/containment-proof-contract.js';
import type { ProviderProxySetLifecycleState } from '../../../provider-proxy/set-lifecycle-state-vocabulary.js';
import type { ProviderOperationMutationSetFence } from '../../../store/provider-operation-journal.js';
import {
  holdProviderProxyOperationControl,
  type DurableProviderProxyOperationAuthority,
} from '../../live/provider-proxy/operation-route.js';
import type { PublicationReceipt } from '../../live/provider-proxy/set-publication.js';
import type {
  ProviderProxyAcquisitionHeld,
  ProviderProxyAcquisitionHoldAcceptance,
} from '../../live/provider-proxy/index.js';
import type {
  ProviderProxySetAcquisitionCleanupDisposition,
  ProviderProxySetAcquisitionCleanupHold,
  ProviderProxySetAcquisitionCleanupOutcome,
} from '../../live/provider-hosts/proxy-set-acquisition.js';
import {
  closeProviderProxyAcquisitionSession,
  establishProviderProxyAcquisitionSession,
  handOverProviderProxyAcquisitionControlSession,
  onProviderProxyAcquisitionSessionFault,
  providerProxyAcquisitionSessionDescriptor,
  providerProxyControlSessionOwner,
  retryProviderProxyAcquisitionPublication,
  type OwnedProviderProxyAcquisitionControlSession,
  type ProviderProxyAcquisitionSessionHandedOver,
} from '../../live/provider-proxy/control-session.js';
import type {
  ContainmentCommitOutcome,
  ProviderProxyContainmentAuthority,
} from '../../live/provider-proxy/authority.js';
import {
  closeRedeemedProviderProxyControl,
  type ProviderProxyControlRedemptionOutcome,
  type ProviderProxyControlRedemptionRefusal,
  type RedeemedProviderProxyControl,
} from '../../live/provider-proxy/control-redemption.js';
import type { ProviderProxyRoleControlRemoteError } from '../../live/provider-proxy/role-control.js';
import type { ProviderHandoffCapsuleRetirementOutcome } from '../provider-proxy-capsule-discovery.js';
import { classifyProviderProxySetInheritance, type ProviderProxySetRedemptionOutcome } from './inheritance.js';
import {
  authorizeProviderProxySetContainmentProof,
  providerProxySetContainmentEvidenceFor,
  releaseProviderProxySetContainmentProofFence,
  verifyProviderProxySetContainmentProofCurrent,
  type ProviderProxySetContainmentProof,
  type ProviderProxySetFencedContainmentProof,
  type ProviderProxySetFencedContainmentProofAuthorization,
} from './containment-proof.js';
import type {
  ProviderProxySetContainmentSignal,
  ProviderProxySetRecordedContainmentReaper,
  ProviderProxySetRecordedContainmentReapResult,
} from './recorded-containment-reaper.js';
import { reobserveDurableProviderProxySetContainment } from './recorded-containment-reaper.js';
import type {
  ContainmentDisappearanceNotice,
  DisappearanceDeliveryAttemptOutcome,
} from '../provider-containment-disappearance.js';
import type {
  ProviderRepresentationAbandonmentNotice,
  RepresentationAbandonmentDeliveryAttemptOutcome,
} from '../provider-representation-abandonment.js';
import type { ProviderProxySetClaimMirror } from './claim-mirror.js';
import type {
  ProviderProxySetOperatorDisposition,
  ProviderProxySetOperatorExit,
  ProviderProxySetOperatorStatus,
} from '../../../provider-proxy/operator-disposition-vocabulary.js';
import type {
  ProviderProxyAuthorityFault,
  ProviderProxyAuthorityObservation,
  ProviderProxyControlChannelCause,
  ProviderProxyControlChannelIncident,
  ProviderProxyHeartbeatMethod,
  ProviderProxyHeartbeatObservation,
  ProviderProxyRole,
} from '../provider-proxy-authority-fault.js';
import type {
  ProviderProxyForeignCapsuleRetirementRetryIncident,
  ProviderProxyRecoveryDispatcher,
  ProviderProxyRecoveryTurnSinks,
  ProviderProxySetLifecycleFatalError,
} from '../provider-proxy-recovery-policy.js';
import {
  renderProviderProxySetDecision,
  type ProviderProxySetAuthorityStopDecision,
  type ProviderProxySetClaimBearingRetirementReason,
  type ProviderProxySetContainmentDecision,
  type ProviderProxySetContainmentRefusedDecision,
  type ProviderProxySetControlReattachmentAwaitAbsenceDecision,
  type ProviderProxySetControlReattachmentRefusalDecision,
  type ProviderProxySetDecision,
  type ProviderProxySetDrainDecision,
  type ProviderProxySetHeartbeatAwaitAbsenceDecision,
  type ProviderProxySetHeartbeatLocalFailureRefusalDecision,
  type ProviderProxySetLogSeverity,
  type ProviderProxySetNonAuthorizingContainmentDecision,
  type ProviderProxySetOperatorAbandonmentDecision,
  type ProviderProxySetOperatorContainmentDecision,
  type ProviderProxySetPreserveDecision,
  type ProviderProxySetRetirementReason,
  type ProviderProxySetRetirementStopDecision,
} from './decisions.js';
import {
  ProviderProxySetIdentityIndex,
  providerProxySetAddress,
  providerProxySetAddressKey,
  providerProxySetCapsuleMatchesIdentity,
  providerProxySetIdentitiesEqual,
  providerProxySetIdentityFromCapsule,
  providerProxySetKey,
  providerProxySetReference,
  type ProviderProxySetIdentity,
  type ProviderProxySetKey,
  type ProviderProxySetProtection,
} from './identity.js';
import {
  durableProviderProxySetAcquisitionDispositionKey,
  durableProviderProxySetOperatorDispositionRecord,
  PROVIDER_PROXY_SET_OPERATOR_DISPOSITION_GENERATION,
  type DurableProviderProxySetAcquisitionDispositionRecord,
  type DurableProviderProxySetContainmentHoldOutcome,
  type DurableProviderProxySetOperatorDispositionRecord,
  type DurableProviderProxySetOperatorDispositionSkip,
  type DurableProviderProxySetOperatorDispositionWriteResult,
  type ProviderProxySetOperatorDispositionStore,
} from './operator-disposition-store.js';
import {
  reobserveDurableProviderProxyAcquisitionDisposition,
  reobserveDurableProviderProxySetDisposition,
  settleDurableOperatorDispositionReconciliation,
  type DurableOperatorDispositionReconciliationSettlement,
} from './operator-disposition-reconciliation.js';
import {
  isProviderProxyAcquisitionAbsenceEvidenceFor,
  type ProviderProxyAcquisitionAbsenceEvidence,
} from '../../live/provider-proxy/spawn-undo.js';

export const MAX_COORDINATOR_PROXY_SET_SLOTS = 4;
const CONTAINMENT_ATTEMPT_MS = 30_000;
const OPERATOR_EXIT_OBSERVATION_MS = 1_000;
const ACQUISITION_PUBLICATION_ATTEMPT_LIMIT = 5;
const REATTACHMENT_HOLD_RETRY_MS = 60_000;

declare const processContainmentEvidenceBrand: unique symbol;
declare const durableClaimDischargeBrand: unique symbol;
declare const providerProxySetDischargeBrand: unique symbol;
const operatorAbandonmentEvidenceBrand: unique symbol = Symbol('provider-proxy-set-operator-abandonment-evidence');
const operatorExitCapabilityBrand = Symbol('provider-proxy-set-operator-exit-capability');
export type ProcessContainmentEvidence = Readonly<{
  kind: 'containment-absent';
  receipt: string;
}> &
  Readonly<{ [processContainmentEvidenceBrand]: true }>;

export type DurableClaimDischarge = Readonly<{
  kind: 'claims-discharged';
  operations: readonly OperationIdentity[];
}> &
  Readonly<{ [durableClaimDischargeBrand]: true }>;

export type OperatorAbandonmentEvidence = Readonly<
  | {
      kind: 'operator-abandoned';
      basis: 'enforcer-observations';
      enforcerObservations: ProviderProxySetEnforcerObservations;
    }
  | {
      kind: 'operator-abandoned';
      basis: 'recorded-group-unattributable';
    }
> &
  Readonly<{ [operatorAbandonmentEvidenceBrand]: true }>;

export type ProviderProxySetDischarge =
  | (Readonly<{
      kind: 'evidence-backed';
      process: ProcessContainmentEvidence;
      claims: DurableClaimDischarge;
    }> &
      Readonly<{ [providerProxySetDischargeBrand]: true }>)
  | (Readonly<{
      kind: 'operator-abandoned';
      abandonment: OperatorAbandonmentEvidence;
      claims: DurableClaimDischarge;
    }> &
      Readonly<{ [providerProxySetDischargeBrand]: true }>);

export type ProviderProxySetOperatorExitCapability = Readonly<{
  setIdentity: ProviderProxySetIdentity;
  containmentProofAuthorization: ProviderProxySetFencedContainmentProofAuthorization;
  notBeforeMonotonicMs: bigint;
  operatorExitGeneration: number;
  attemptToken: number;
  priorDestructiveAttemptsSettled: Promise<void>;
  [operatorExitCapabilityBrand]: ProviderProxySetLifecycle;
}>;

type CapacityClass = 'retained' | 'excess';
type EstablishmentIntent = 'serve' | 'contain-unclaimed-discovery';

type PreserveReportState = {
  decision: ProviderProxySetPreserveDecision;
  lastReportedAtMs: number;
  suppressed: number;
  recoveryTimer: TimerHandle | null;
};

type ControlReattachmentWindow = {
  returnKind: 'available' | 'draining';
  lastObservedAtMonotonicMs: bigint;
  observedElapsedMs: number;
  trigger: Readonly<{
    role: ProviderProxyRole;
    cause: ProviderProxyControlChannelCause | 'heartbeat-local-failure';
    error: unknown;
  }>;
  attempts: number;
  boundMs: number;
  attemptToken: number;
  attemptAbort: AbortController | null;
  deadlineTimer: TimerHandle | null;
};

type OperatorExitObservedGate = {
  boundMs: number;
  observedElapsedMs: number;
  lastObservedAtMonotonicMs: bigint;
};

type EstablishedSlot = {
  kind: 'available' | 'draining' | 'reattaching' | 'reattachment-hold' | 'containing' | 'containment-wait';
  operationControlState: 'operational' | 'operator-fenced' | 'outcome-unknown';
  key: ProviderProxySetKey;
  identity: ProviderProxySetIdentity;
  address: ProviderProxySetAddress;
  capacityClass: CapacityClass;
  authority: DurableProviderProxyOperationAuthority;
  routeKey: string | null;
  capsulePath: string | null;
  completedAttempts: number;
  attemptToken: number;
  containmentAttemptAbort: AbortController | null;
  containmentAuthority: ProviderProxyContainmentAuthority | null;
  retryTimer: TimerHandle | null;
  retirementDecision: ProviderProxySetDrainDecision | null;
  preserveReports: Map<string, PreserveReportState>;
  heartbeatEvidenceWindows: Map<string, HeartbeatEvidenceWindow>;
  heartbeatHoldBound: DurableProviderProxyOperationAuthority['autonomousDeadline']['heartbeatHoldBound'];
  controlReattachmentBoundMs: number;
  controlReattachmentWindow: ControlReattachmentWindow | null;
  operatorExitNotBeforeMonotonicMs: bigint | null;
  operatorExitObservedGate: OperatorExitObservedGate | null;
  operatorExitGeneration: number;
  protection: ProviderProxySetProtection;
  /** Set only while this slot is `containing`/`containment-wait` for a `stop-and-reap` decision, and cleared
   *  once containment absence is confirmed. Distinguishes the two AC3 holds for status reporting; the retry
   *  cadence itself is the same `#runContainmentAttempt` loop for both. */
  containmentCommitStatus: 'not-sent' | 'outcome-unknown' | null;
};

type PendingReleaseSlot = {
  key: ProviderProxySetKey;
  identity: ProviderProxySetIdentity;
  address: ProviderProxySetAddress;
  capacityClass: CapacityClass;
  authority: DurableProviderProxyOperationAuthority | null;
  claimOperations: readonly OperationIdentity[];
  claimDischarge: DurableClaimDischarge | null;
  pendingOperations: Map<string, OperationIdentity>;
  initialDeliveries: Map<string, AbsenceDeliveryState>;
  deliveryRetryTimers: Map<string, TimerHandle>;
  capsulePath: string | null;
  routeKey: string | null;
  retirementState: 'not-ready' | 'initial-pending' | 'retry-owned' | 'fatal' | 'retired';
  retirementTimer: TimerHandle | null;
  initialDisposition: InitialDispositionLatch;
  representationReleaseSettlement: Promise<ProviderProxyRepresentationReleaseSettlement>;
  settleRepresentationRelease(disposition: ProviderProxyRepresentationReleaseSettlement): void;
  fatalSettlement: ProviderProxyRepresentationReleaseFatalSettlement | null;
  operatorExitNotBeforeMonotonicMs: bigint | null;
  operatorExitGeneration: number;
  attemptToken: number;
  mutationProof: ProviderProxySetFencedContainmentProof | null;
} & (
  | { kind: 'absence-delivery-pending'; releaseEvidence: ProcessContainmentEvidence }
  | { kind: 'abandonment-delivery-pending'; releaseEvidence: OperatorAbandonmentEvidence }
);

/** Abandonment must be able to abort a destructive attempt and wait for it, not merely ignore its result. */
type ProviderProxySetCleanupAttempt = Readonly<{ abort: AbortController; settlement: Promise<void> }>;

type ProviderProxySetSlot =
  | {
      kind: 'acquiring';
      slotId: string;
      routeKey: string;
      address: ProviderProxySetAddress | null;
      binding: Readonly<{ buildSetId: string; hostFingerprint: string }> | null;
      cleanupHold: ProviderProxySetAcquisitionCleanupHold | null;
      cleanupRetryTimer: TimerHandle | null;
      cleanupAttemptToken: number;
      cleanupAttempt: ProviderProxySetCleanupAttempt | null;
    }
  | {
      kind: 'capsule-recovering';
      key: ProviderProxySetKey;
      identity: ProviderProxySetIdentity;
      capsulePath: string;
      capsuleBinding: HandoffCapsuleV3;
      address: ProviderProxySetAddress;
      capacityClass: CapacityClass;
      completedAttempts: number;
      retryTimer: TimerHandle | null;
      attemptToken: number;
      attemptAbort: AbortController | null;
      recoveryPhase: 'redemption' | 'containment-wait';
      routeKey: string | null;
      acquisitionCleanupHold: ProviderProxySetAcquisitionCleanupHold | null;
      operatorExitNotBeforeMonotonicMs: bigint | null;
      operatorExitObservedGate: OperatorExitObservedGate | null;
      operatorExitGeneration: number;
    }
  /**
   * A capsule this build must not dial. It holds an address and nothing else — no timer, no attempt, no
   * authority — because every action available here is one this build is not entitled to take.
   */
  | {
      kind: 'capsule-foreign';
      slotId: string;
      capsulePath: string;
      address: ProviderProxySetAddress;
      capacityClass: CapacityClass;
      reason: 'other-build' | 'unreadable-identity';
    }
  | {
      kind: 'recovering';
      recoveryKind: 'claim';
      key: ProviderProxySetKey;
      identity: ProviderProxySetIdentity;
      address: ProviderProxySetAddress;
      capacityClass: CapacityClass;
      capsulePath: string | null;
    }
  | {
      kind: 'recovering';
      recoveryKind: 'acquisition-publication';
      key: ProviderProxySetKey;
      identity: ProviderProxySetIdentity;
      address: ProviderProxySetAddress;
      capacityClass: CapacityClass;
      capsulePath: string;
      capsuleBinding: HandoffCapsuleV3;
      routeKey: string;
      session: OwnedProviderProxyAcquisitionControlSession<'provider-proxy-set-lifecycle'>;
      acquisitionCleanupHold: ProviderProxySetAcquisitionCleanupHold | null;
      decorateAuthority(authority: DurableProviderProxyOperationAuthority): DurableProviderProxyOperationAuthority;
      completedAttempts: number;
      retryTimer: TimerHandle | null;
      attemptToken: number;
      unsubscribeFault: (() => void) | null;
    }
  | EstablishedSlot
  | PendingReleaseSlot;

type ProviderProxySetSlotKind = ProviderProxySetSlot['kind'];

const providerProxySetSlotIsLive = {
  acquiring: false,
  'capsule-recovering': false,
  'capsule-foreign': false,
  recovering: false,
  available: true,
  draining: true,
  reattaching: true,
  'reattachment-hold': true,
  containing: true,
  'containment-wait': true,
  'absence-delivery-pending': true,
  'abandonment-delivery-pending': true,
} satisfies Record<ProviderProxySetSlotKind, boolean>;

type CapsuleRecoveringSlot = Extract<ProviderProxySetSlot, { kind: 'capsule-recovering' }>;
type AbsenceDeliveryPendingSlot = Extract<ProviderProxySetSlot, { kind: 'absence-delivery-pending' }>;
type ReleaseDeliveryPendingSlot = Extract<
  ProviderProxySetSlot,
  { kind: 'absence-delivery-pending' | 'abandonment-delivery-pending' }
>;

/**
 * A retirement this build is attempting against a capsule it may not dial, keyed by the only thing it owns:
 * the canonical path. Not the set identity — a foreign V2 has none this build can name — and not a slot,
 * because a claim-matched capsule creates none.
 *
 * The hold this represents ends retired, or abandoned with the conservative representation left standing —
 * at `FOREIGN_CAPSULE_RETIREMENT_ATTEMPT_LIMIT` failures, or on a fatal the turn could not settle. While the
 * owner exists it is the only thing entitled to release this path's representation.
 */
type ForeignCapsuleRetirementOwner = {
  readonly capsulePath: string;
  /** The `#capsuleAddresses` and `#capsuleGrants` keys this capsule installed. */
  readonly addressKey: string;
  readonly grantId: string;
  readonly foreignSlotId: string | null;
  /** Absent until an attempt fails. The count and the incident that produced it are never separately valid. */
  failures: Readonly<{ count: number; lastIncident: ProviderProxyForeignCapsuleRetirementRetryIncident }> | null;
  retryTimer: TimerHandle | null;
};

/**
 * What ended a foreign retirement hold short of retirement, carried as facts: a call site that hands this
 * sink a finished sentence becomes a second renderer of the one line an operator has to act on.
 */
type ForeignCapsuleRetirementAbandonment =
  | Readonly<{
      kind: 'attempt-limit';
      attempts: number;
      incident: ProviderProxyForeignCapsuleRetirementRetryIncident;
    }>
  | Readonly<{ kind: 'forwarded-fatal'; error: unknown }>;

function renderForeignRetirementAbandonment(abandonment: ForeignCapsuleRetirementAbandonment): string {
  if (abandonment.kind === 'forwarded-fatal') {
    return `after a fatal it could not settle (${singleLineErrorSummary(abandonment.error)})`;
  }
  const observedCode =
    'errorCode' in abandonment.incident && abandonment.incident.errorCode !== null
      ? ` code=${abandonment.incident.errorCode}`
      : '';
  return `after ${abandonment.attempts} attempts (${abandonment.incident.kind}${observedCode})`;
}

/**
 * Whether a discovered capsule is one this build may act on. Returned as a variant rather than a boolean so
 * the inheritable branch carries the narrowed capsule: every path that reads a process identity out of one is
 * then unreachable for any generation this build cannot name a set from, by type rather than by discipline.
 */
type CapsuleInheritance =
  | Readonly<{ kind: 'inheritable'; capsule: HandoffCapsuleV3 }>
  | Readonly<{ kind: 'uninheritable'; reason: 'other-build' | 'unreadable-identity' }>;

type ContainmentAbsenceCommit =
  | Readonly<{ kind: 'unchanged'; pending: AbsenceDeliveryPendingSlot }>
  | Readonly<{
      kind: 'committed';
      pending: AbsenceDeliveryPendingSlot;
      authoritiesToClose: readonly ProviderProxyContainmentAuthority[];
    }>;

export type ProviderProxySetLifecycleSnapshot = Readonly<{
  startupDiscoveryCompleted: boolean;
  represented: number;
  available: number;
  states: readonly ProviderProxySetLifecycleState[];
  pendingOperationCounts: readonly number[];
  operatorDispositions: readonly ProviderProxySetOperatorDisposition[];
  operatorSets: readonly ProviderProxySetOperatorStatus[];
  skippedDurableOperatorDispositions: readonly DurableProviderProxySetOperatorDispositionSkip[];
}>;

export type ProviderProxySetLifecycleProgressViolation = Readonly<{
  stage: 'acquisition-publication-retry' | 'containment-attempt-deadline' | 'containment-retry';
  requestedWakeMs: number;
  observedWakeMs: number;
  latenessMs: number;
}>;

export type CapsuleRetirementAttemptOutcome = ProviderHandoffCapsuleRetirementOutcome;

type ContainmentAbsenceOperationalIncidentDetail = Readonly<{
  reason: string;
  nextAttemptAtMs: number;
}>;

export type ContainmentAbsenceOperationalIncident =
  | (Readonly<{
      stage: 'disappearance-delivery';
      operation: OperationIdentity;
      code: 'disappearance_consumer_unavailable';
    }> &
      ContainmentAbsenceOperationalIncidentDetail)
  | (Readonly<{
      stage: 'representation-abandonment-delivery';
      operation: OperationIdentity;
      code: 'representation_abandonment_consumer_unavailable';
    }> &
      ContainmentAbsenceOperationalIncidentDetail)
  | (Readonly<{
      stage: 'capsule-retirement';
      code: 'capsule_retirement_unavailable';
    }> &
      ContainmentAbsenceOperationalIncidentDetail);

export type ContainmentAbsenceInitialDisposition =
  | Readonly<{ kind: 'completed' }>
  | Readonly<{
      kind: 'operational-retry-owned';
      exit: 'provider-proxy-set-release-retry';
      incidents: readonly [ContainmentAbsenceOperationalIncident, ...ContainmentAbsenceOperationalIncident[]];
    }>;

export type ProviderProxySetOperatorDispositionRecording =
  | Readonly<{ kind: 'recorded' }>
  | Readonly<{
      kind: 'held';
      reason: string;
      waitingFor: 'store-repair';
      exit: 'provider-proxy-set-operator-disposition-store-retry';
    }>;

export type ProviderProxySetDurableAcquisitionAbandonment =
  | Readonly<{ kind: 'retired' }>
  | Readonly<{ kind: 'not-found' }>
  | Readonly<{
      kind: 'live-exit-unavailable';
      reason: string;
      exit: 'acquisition-cleanup-retry';
    }>
  | Readonly<{
      kind: 'transfer-pending';
      reason: string;
      waitingFor: 'cleanup-attempt-settlement';
      exit: 'provider-proxy-set-operator-abandonment-retry';
    }>
  | Readonly<{
      kind: 'held';
      reason: string;
      waitingFor: 'store-repair';
      exit: 'provider-proxy-set-operator-disposition-store-retry';
    }>;

export type ProviderProxyRepresentationReleaseSuccessor = Readonly<{
  owner: 'operator-command';
  acceptance: 'pending';
  inspectCommand: 'coral-cli backend status';
  actionCommand: string;
}>;

export type ProviderProxyRepresentationReleaseSettlement =
  | Readonly<{ kind: 'released' }>
  | Readonly<{
      kind: 'fatal-successor-pending';
      error: ProviderProxySetLifecycleFatalError;
      successor: ProviderProxyRepresentationReleaseSuccessor;
      operatorDispositionRecording: ProviderProxySetOperatorDispositionRecording;
    }>;

type ProviderProxyRepresentationReleaseFatalSettlement = Exclude<
  ProviderProxyRepresentationReleaseSettlement,
  Readonly<{ kind: 'released' }>
>;

export type ProviderProxyRepresentationReleaseDisposition =
  | Readonly<{ kind: 'in-progress' }>
  | Readonly<{ kind: 'operational-retry-owned'; exit: 'provider-proxy-set-release-retry' }>
  | Readonly<{
      kind: 'fatal-successor-pending';
      exit: 'provider-proxy-set-operator-abandonment';
      error: ProviderProxySetLifecycleFatalError;
      successor: ProviderProxyRepresentationReleaseSuccessor;
      operatorDispositionRecording: ProviderProxySetOperatorDispositionRecording;
    }>;

type InitialDispositionState = 'pending' | 'resolved' | 'rejected';

export type ContainmentAbsenceAcceptance = Readonly<{
  kind: 'accepted';
  disappearanceReceipt: string;
  initialDisposition: Promise<ContainmentAbsenceInitialDisposition>;
  initialDispositionState: InitialDispositionState;
}>;

type ProviderProxySetOperatorClaimDischarge =
  | ContainmentAbsenceInitialDisposition
  | Readonly<{ kind: 'initial-disposition-pending'; exit: 'initial-disposition-settlement' }>;

type ProviderProxySetOperatorClaimDischargeObservation =
  | ProviderProxySetOperatorClaimDischarge
  | ProviderProxyRepresentationReleaseFatalSettlement;

export type ProviderProxySetOperatorExitEffect = Readonly<{
  signalsSent: readonly ProviderProxySetContainmentSignal[];
  containmentAbsent: boolean;
  representationAction: 'none' | 'absence-release-started' | 'abandonment-release-started' | 'fatal-release-abandoned';
}>;

export type ProviderProxySetOperatorExitAuthorization =
  | Readonly<{ kind: 'authorized'; capability: ProviderProxySetOperatorExitCapability }>
  | Readonly<{ kind: 'set-not-found' }>
  | Readonly<{ kind: 'not-held'; state: ProviderProxySetLifecycleState }>
  | Readonly<{ kind: 'deadline-pending'; remainingMs: number }>;

export type ProviderProxySetBooleanOperatorExitAuthorization =
  | ProviderProxySetOperatorExitAuthorization
  | Readonly<{ kind: 'unsupported-contract' }>;

export type ProviderProxySetOperatorExitResult = (
  | Readonly<{
      kind: 'contained';
      setIdentity: ProviderProxySetAddress;
      disappearanceReceipt: string;
      claimDischarge: ProviderProxySetOperatorClaimDischarge;
    }>
  | Readonly<{
      kind: 'abandoned';
      setIdentity: ProviderProxySetAddress;
      enforcerObservations: ProviderProxySetEnforcerObservations;
      claimDischarge: ProviderProxySetOperatorClaimDischarge;
    }>
  | Readonly<{
      kind: 'representation-release-abandoned';
      setIdentity: ProviderProxySetAddress;
      successor: Readonly<{ owner: 'operator-command'; acceptance: 'accepted' }>;
    }>
  | Readonly<{
      kind: 'representation-release-abandonment-required';
      setIdentity: ProviderProxySetAddress;
    }>
  | Readonly<{ kind: 'set-not-found'; setIdentity: ProviderProxySetAddress }>
  | Readonly<{ kind: 'not-held'; setIdentity: ProviderProxySetAddress; state: ProviderProxySetLifecycleState }>
  | Readonly<{ kind: 'deadline-pending'; setIdentity: ProviderProxySetAddress; remainingMs: number }>
  | Readonly<{ kind: 'authorization-stale'; setIdentity: ProviderProxySetAddress }>
  | Readonly<{
      kind: 'enforcer-alive' | 'enforcer-unobservable';
      setIdentity: ProviderProxySetAddress;
      enforcerObservations: ProviderProxySetEnforcerObservations;
    }>
  | Readonly<{ kind: 'recorded-group-unattributable'; setIdentity: ProviderProxySetAddress }>
  | Readonly<{ kind: 'signal-authorization-refused'; setIdentity: ProviderProxySetAddress }>
  | Readonly<{ kind: 'identity-unobservable'; setIdentity: ProviderProxySetAddress }>
  | Readonly<{ kind: 'store-unreadable'; setIdentity: ProviderProxySetAddress }>
  | Readonly<{
      kind: 'containment-unconfirmed';
      setIdentity: ProviderProxySetAddress;
      recoveryAction: Readonly<{ kind: 'retry-exact-set-containment' }>;
    }>
) &
  Readonly<{ effect: ProviderProxySetOperatorExitEffect }>;

export type ProviderProxySetBooleanOperatorExitResult =
  | ProviderProxySetOperatorExitResult
  | (Readonly<{
      kind: 'unattributable-group-abandoned';
      setIdentity: ProviderProxySetAddress;
      claimDischarge: ProviderProxySetOperatorClaimDischarge;
    }> &
      Readonly<{ effect: ProviderProxySetOperatorExitEffect }>);

type ProviderProxySetCurrentOperatorExitRequest =
  | Readonly<{ contract: 'current'; behavior: 'contain'; signal: AbortSignal }>
  | Readonly<{ contract: 'current'; behavior: 'abandon'; signal: AbortSignal }>;

type ProviderProxySetBooleanOperatorExitRequest =
  | Readonly<{ contract: 'boolean'; behavior: 'contain'; signal: AbortSignal }>
  | Readonly<{ contract: 'boolean'; behavior: 'boolean-abandon'; signal: AbortSignal }>;

type ProviderProxySetOperatorExitRequest =
  | ProviderProxySetCurrentOperatorExitRequest
  | ProviderProxySetBooleanOperatorExitRequest;

type InitialDispositionLatch = {
  readonly state: InitialDispositionState;
  settlement:
    | Readonly<{ kind: 'pending' }>
    | Readonly<{ kind: 'resolved'; disposition: ContainmentAbsenceInitialDisposition }>
    | Readonly<{
        kind: 'rejected';
        disposition: ProviderProxyRepresentationReleaseFatalSettlement;
      }>;
  readonly promise: Promise<ContainmentAbsenceInitialDisposition>;
  resolve(value: ContainmentAbsenceInitialDisposition): void;
  reject(disposition: ProviderProxyRepresentationReleaseFatalSettlement): void;
};

type AbsenceDeliveryState =
  | Readonly<{ kind: 'initial-pending' }>
  | Readonly<{ kind: 'accepted' }>
  | Readonly<{ kind: 'retry-owned'; incident: ContainmentAbsenceOperationalIncident }>
  | Readonly<{ kind: 'fatal'; error: ProviderProxySetLifecycleFatalError }>;

export type ProviderProxySetLifecycleDeps = Readonly<{
  /**
   * This coordinator's own build set. Discovery needs it to tell a capsule it may redeem from one it may
   * only represent: redemption is build-bound at the role (`assertNamedCoordinatorBuild`), so dialing a
   * foreign set is not a failed attempt but a fatal one.
   */
  buildSetId: string;
  claims: ProviderProxySetClaimMirror;
  controlEstablished(authority: DurableProviderProxyOperationAuthority): void;
  /**
   * `monotonicNow` is authority for the heartbeat-hold span (`#advanceHeartbeatHold`): a wall-clock step must
   * not be able to move a claim-bearing escalation. `now` stays wall-clock for logging and retry scheduling,
   * neither of which is authority.
   */
  time: Pick<TimePort, 'now' | 'monotonicNow' | 'setTimeout' | 'clearTimeout'>;
  recoveryDispatcher: ProviderProxyRecoveryDispatcher;
  reapRecordedContainment: ProviderProxySetRecordedContainmentReaper;
  operatorDispositionStore: ProviderProxySetOperatorDispositionStore;
  writerIncarnation: string;
  collectOperatorDispositionContainmentProof(
    identity: ProviderProxySetIdentity,
    signal: AbortSignal,
  ): Promise<ProviderProxySetFencedContainmentProof>;
  reobserveAcquisitionContainment(
    subject: DurableProviderProxySetAcquisitionDispositionRecord['recoverySubject'],
    signal: AbortSignal,
  ): Promise<
    | Readonly<{ kind: 'containment-absent'; evidence: ProviderProxyAcquisitionAbsenceEvidence }>
    | Readonly<{ kind: 'held'; observation: 'alive' | 'unknown'; reason: string }>
  >;
  fenceProviderOperationMutations?(identity: ProviderProxySetIdentity): ProviderOperationMutationSetFence;
  onProgressPremiseViolation?: (violation: ProviderProxySetLifecycleProgressViolation) => void;
  reportLifecycle(severity: ProviderProxySetLogSeverity, message: string): void;
  onError?: (message: string) => void;
  onSlotReleased?: (routeKey: string) => void;
}>;

export type FreshProxySetAdmission =
  | Readonly<{ kind: 'accepted'; slotId: string }>
  | Readonly<{ kind: 'already-represented' }>
  | Readonly<{ kind: 'capacity'; code: 'provider_proxy_set_capacity' }>
  | Readonly<{ kind: 'startup-discovery-pending'; code: 'provider_proxy_set_startup_discovery_pending' }>;

function operationKey(operation: OperationIdentity): string {
  return JSON.stringify([operation.jobId, operation.operationId, operation.proxyInstanceId, operation.buildSetId]);
}

function singleLineErrorSummary(error: unknown): string {
  return JSON.stringify(errorMessage(error)).slice(1, -1);
}

function errorIdentityField(value: unknown): string | number | null {
  return typeof value === 'string' || typeof value === 'number' ? value : null;
}

function preserveErrorIdentity(error: unknown): string {
  if (typeof error !== 'object' || error === null) return typeof error;
  const details = error as Record<string, unknown>;
  const remoteFailure =
    typeof details.remoteFailure === 'object' && details.remoteFailure !== null
      ? (details.remoteFailure as Record<string, unknown>)
      : {};
  const heartbeatRefusal =
    typeof remoteFailure.heartbeatRefusal === 'object' && remoteFailure.heartbeatRefusal !== null
      ? (remoteFailure.heartbeatRefusal as Record<string, unknown>)
      : {};
  return JSON.stringify([
    error instanceof Error ? error.name : 'object',
    errorIdentityField(details.kind),
    errorIdentityField(details.code),
    errorIdentityField(details.origin),
    errorIdentityField(remoteFailure.kind),
    errorIdentityField(remoteFailure.jsonRpcCode),
    errorIdentityField(remoteFailure.protocolCode),
    errorIdentityField(remoteFailure.admissionReason),
    errorIdentityField(heartbeatRefusal.reason),
  ]);
}

function refusedDecisionSubjectKey(refused: ProviderProxySetNonAuthorizingContainmentDecision): string {
  switch (refused.reason) {
    case 'control_reattachment_bound_expired':
    case 'control_reattachment_refused':
      return `${refused.role}:${refused.cause}`;
    case 'heartbeat_local_failure':
      return `${refused.role}:${refused.method}`;
    case 'heartbeat_hold_exhausted':
    case 'heartbeat_answer_unusable_hold_exhausted':
    case 'heartbeat_protocol_incompatible':
      return refused.method;
    case 'operation_control_indeterminate':
      return refused.policy.method;
  }
}

/**
 * Whether every process a capsule recorded is provably gone.
 *
 * `absent` is the only answer that may retire anything. An `alive` pid may be a stranger wearing a recycled
 * number, and `unknown` is a question that could not be asked — neither is proof, so neither may finalize. A
 * V1 records no process at all, which is not evidence of absence but the absence of evidence. Retirement
 * needs all three answers, so one that is not `absent` settles the question on its own.
 */
function recordedProcessesAllAbsent(capsule: HandoffCapsule, observe: RecordedProcessObserver): boolean {
  if (capsule.version === 1) return false;
  const recorded: readonly Readonly<{ pid: number; incarnation?: ProcessIncarnation }>[] =
    capsule.version === 3
      ? [
          { pid: capsule.guardianPid, incarnation: capsule.guardianIncarnation },
          { pid: capsule.reaperPid, incarnation: capsule.reaperIncarnation },
          { pid: capsule.proxyPid, incarnation: capsule.proxyIncarnation },
        ]
      : [{ pid: capsule.guardianPid }, { pid: capsule.reaperPid }, { pid: capsule.proxyPid }];
  return recorded.every((role) => observe(role) === 'absent');
}

function retryDelayMs(completedAttempts: number): number {
  return Math.min(1_000 * 2 ** Math.min(Math.max(completedAttempts - 1, 0), 5), 30_000);
}

function acquisitionHoldTarget(hold: ProviderProxyAcquisitionHeld<string>): string {
  if ('guardianIdentity' in hold) return `guardianPid=${hold.guardianIdentity.pid}`;
  return hold.recoverySubject.kind === 'spawned-process-group'
    ? `processGroupId=${hold.recoverySubject.processGroupId}`
    : 'processGroupId=unattributable';
}

function acquisitionHoldWaitingFor(
  hold: ProviderProxyAcquisitionHeld<string>,
): ProviderProxySetOperatorDisposition['waitingFor'] {
  return 'kind' in hold.recoverySubject && hold.recoverySubject.kind === 'unattributable-process-group'
    ? 'operator-abandonment'
    : 'independent-containment-absence';
}

/** Active bounded reattachment accepts only control-channel causes. */
function controlChannelCause(cause: ControlReattachmentWindow['trigger']['cause']): ProviderProxyControlChannelCause {
  if (cause === 'heartbeat-local-failure') {
    throw new Error('provider_proxy_control_reattachment_active_window_cause_invalid');
  }
  return cause;
}

function isProviderProxyHeartbeatMethod(value: unknown): value is ProviderProxyHeartbeatMethod {
  return value === 'control.heartbeat.v1' || value === 'guardian.heartbeat.v1' || value === 'reaper.heartbeat.v1';
}

/** Decisiveness requires a structured teardown latch and verified guardian containment ownership. */
function decisiveTeardownLatchedRefusal(refusal: ProviderProxyControlRedemptionRefusal): Readonly<{
  role: ProviderProxyRole;
  stage: 'open' | 'heartbeat';
  method: NonNullable<ProviderProxyRoleControlRemoteError['method']>;
  error: ProviderProxyRoleControlRemoteError;
  authority: ProviderProxyContainmentAuthority;
}> | null {
  if (refusal.kind !== 'downstream-role-refused') return null;
  const { error } = refusal;
  const { remoteFailure } = error;
  if (remoteFailure.kind !== 'json-rpc-error') return null;
  if (error.stage === 'open') {
    if (remoteFailure.admissionReason !== 'teardown-latched' || error.method === null) return null;
    return {
      role: error.role,
      stage: error.stage,
      method: error.method,
      error,
      authority: refusal.guardianAuthority,
    };
  }
  if (error.stage !== 'heartbeat') return null;
  if (remoteFailure.heartbeatRefusal?.reason !== 'teardown-latched') return null;
  if (!isProviderProxyHeartbeatMethod(error.method)) return null;
  return {
    role: error.role,
    stage: error.stage,
    method: error.method,
    error,
    authority: refusal.guardianAuthority,
  };
}

const PRESERVE_REPORT_INTERVAL_MS = 60_000;
const MAX_PRESERVE_REPORTS_PER_SET = 32;
const OPERATOR_DISPOSITION_STORE_RETRY_MS = 1_000;

function operatorDispositionSubjectKey(subject?: string, method?: string): string {
  return JSON.stringify([subject ?? null, method ?? null]);
}

const OPERATOR_DISPOSITION_STORE_REPAIR_SUBJECT = operatorDispositionSubjectKey('operator-disposition-store');

type DurableOperatorDispositionWriteStatus =
  | Readonly<{ kind: 'current-writer'; recordedAtMs: number }>
  | Readonly<{
      kind: 'successor-observed';
      observedByIncarnation: string;
      observedAtMs: number;
      evidence: ProviderProxySetContainmentEvidence | Readonly<{ kind: 'canonical-hold-observation' }>;
    }>;

type PendingOperatorDispositionWrite = Readonly<{ timer: TimerHandle }>;

/**
 * The named end of a foreign retirement hold: after this many failed attempts the owner is dropped and the
 * capsule's conservative representation stands for the rest of the boot. Bounding a hold this way is only
 * sound while the owner holds nothing else — an owner that also held acquisition capacity, a claim, or an
 * absence slot would strand it, and must not be abandoned on a count.
 */
const FOREIGN_CAPSULE_RETIREMENT_ATTEMPT_LIMIT = 5;

function createInitialDispositionLatch(): InitialDispositionLatch {
  let accept!: (value: ContainmentAbsenceInitialDisposition) => void;
  let refuse!: (error: ProviderProxySetLifecycleFatalError) => void;
  const promise = new Promise<ContainmentAbsenceInitialDisposition>((resolve, reject) => {
    accept = resolve;
    refuse = reject;
  });
  void promise.catch(() => undefined);
  const latch: InitialDispositionLatch = {
    get state() {
      return latch.settlement.kind;
    },
    settlement: { kind: 'pending' },
    promise,
    resolve: (value) => {
      if (latch.state !== 'pending') return;
      latch.settlement = { kind: 'resolved', disposition: value };
      accept(value);
    },
    reject: (disposition) => {
      if (latch.state !== 'pending') return;
      latch.settlement = { kind: 'rejected', disposition };
      refuse(disposition.error);
    },
  };
  return latch;
}

function snapshotOperatorExitClaimDischarge(
  source: InitialDispositionLatch,
): Promise<ProviderProxySetOperatorClaimDischarge> {
  if (source.state === 'pending') {
    return Promise.resolve({ kind: 'initial-disposition-pending', exit: 'initial-disposition-settlement' });
  }
  return source.promise;
}

function predecessorClaimDischargeBeforeRelease(
  contract: 'current' | 'boolean',
  release: ReleaseDeliveryPendingSlot,
): Promise<ProviderProxySetOperatorClaimDischarge> | null {
  if (contract !== 'boolean' || (release.pendingOperations.size === 0 && release.capsulePath === null)) return null;
  return snapshotOperatorExitClaimDischarge(release.initialDisposition);
}

async function operatorExitClaimDischarge(
  source: ContainmentAbsenceAcceptance | InitialDispositionLatch,
  release: ReleaseDeliveryPendingSlot,
): Promise<ProviderProxySetOperatorClaimDischargeObservation> {
  const observedState = 'initialDispositionState' in source ? source.initialDispositionState : source.state;
  await Promise.resolve();
  if (observedState === 'pending') {
    const settlement = release.initialDisposition.settlement;
    if (settlement.kind === 'rejected') return settlement.disposition;
    return { kind: 'initial-disposition-pending', exit: 'initial-disposition-settlement' };
  }
  if (observedState === 'rejected') {
    const settlement = release.initialDisposition.settlement;
    return settlement.kind === 'rejected'
      ? settlement.disposition
      : { kind: 'initial-disposition-pending', exit: 'initial-disposition-settlement' };
  }
  return 'initialDisposition' in source ? source.initialDisposition : source.promise;
}

function operatorExitClaimDischargeAfterRelease(
  contract: 'current' | 'boolean',
  predecessor: Promise<ProviderProxySetOperatorClaimDischarge> | null,
  source: ContainmentAbsenceAcceptance | InitialDispositionLatch,
  release: ReleaseDeliveryPendingSlot,
): Promise<ProviderProxySetOperatorClaimDischargeObservation> {
  if (predecessor !== null) return predecessor;
  return contract === 'boolean'
    ? snapshotOperatorExitClaimDischarge(release.initialDisposition)
    : operatorExitClaimDischarge(source, release);
}

export class ProviderProxySetLifecycle {
  readonly #deps: ProviderProxySetLifecycleDeps;
  readonly #identityIndex = new ProviderProxySetIdentityIndex();
  readonly #slots = new Map<string, ProviderProxySetSlot>();
  readonly #destructiveAttemptSettlements = new WeakMap<object, Set<Promise<void>>>();
  readonly #routeIndex = new Map<string, ProviderProxySetKey>();
  readonly #capsuleAddresses = new Map<string, string>();
  readonly #capsuleGrants = new Map<string, string>();
  readonly #foreignRetirementOwners = new Map<string, ForeignCapsuleRetirementOwner>();
  readonly #operatorDispositions = new Map<ProviderProxySetKey, Map<string, ProviderProxySetOperatorDisposition>>();
  readonly #pendingOperatorDispositionWrites = new Map<ProviderProxySetKey, PendingOperatorDispositionWrite>();
  readonly #durableOperatorDispositions = new Map<string, DurableProviderProxySetOperatorDispositionRecord>();
  readonly #durableAcquisitionDispositions = new Map<string, DurableProviderProxySetAcquisitionDispositionRecord>();
  readonly #heldDurableSetDispositionWrites = new Map<
    ProviderProxySetKey,
    Readonly<{ identity: ProviderProxySetIdentity; reason: string }>
  >();
  readonly #heldAcquisitionDispositionWrites = new Set<string>();
  readonly #skippedDurableOperatorDispositions: readonly DurableProviderProxySetOperatorDispositionSkip[];
  #durableReobservationTimer: TimerHandle | null = null;
  #durableOperatorDispositionsActivated = false;
  readonly #durablePredecessorRecordsNeedStaleWrite: boolean;
  readonly #operatorExitFenceAuthorizations = new Map<
    ProviderProxySetKey,
    ProviderProxySetFencedContainmentProofAuthorization
  >();
  #nextSlotId = 1;
  #startupDiscoveryCompleted = false;

  #trackDestructiveAttempt<Outcome>(slot: object, operation: Promise<Outcome>): Promise<Outcome> {
    const settlement = operation.then(
      () => undefined,
      () => undefined,
    );
    const active = this.#destructiveAttemptSettlements.get(slot) ?? new Set<Promise<void>>();
    active.add(settlement);
    this.#destructiveAttemptSettlements.set(slot, active);
    void settlement.finally(() => {
      active.delete(settlement);
      if (active.size === 0) this.#destructiveAttemptSettlements.delete(slot);
    });
    return operation;
  }

  #destructiveAttemptsSettled(slot: object): Promise<void> {
    let joined = Promise.resolve();
    for (const settlement of this.#destructiveAttemptSettlements.get(slot) ?? []) {
      joined = joined.then(() => settlement);
    }
    return joined;
  }

  constructor(deps: ProviderProxySetLifecycleDeps) {
    this.#deps = deps;
    const durable = deps.operatorDispositionStore.read();
    this.#skippedDurableOperatorDispositions = durable.skipped;
    const writerIncarnation = deps.writerIncarnation;
    const staleRecords = durable.records.map((record) =>
      record.writerIncarnation === writerIncarnation
        ? record
        : {
            ...record,
            status: {
              kind: 'stale' as const,
              markedByIncarnation: writerIncarnation,
              markedAtMs: deps.time.now(),
            },
          },
    );
    for (const record of staleRecords) this.#durableOperatorDispositions.set(record.key, record);
    const staleAcquisitionRecords = durable.acquisitionRecords.map((record) =>
      record.writerIncarnation === writerIncarnation
        ? record
        : {
            ...record,
            status: {
              kind: 'stale' as const,
              markedByIncarnation: writerIncarnation,
              markedAtMs: deps.time.now(),
            },
          },
    );
    for (const record of staleAcquisitionRecords) this.#durableAcquisitionDispositions.set(record.key, record);
    this.#durablePredecessorRecordsNeedStaleWrite =
      staleRecords.some((record, index) => record !== durable.records[index]) ||
      staleAcquisitionRecords.some((record, index) => record !== durable.acquisitionRecords[index]);
    for (const skipped of durable.skipped) {
      deps.reportLifecycle(
        'warn',
        `Skipped durable provider proxy set disposition key=${skipped.key}; reconciliation and retirement will not be performed by this build.`,
      );
    }
  }

  activateDurableOperatorDispositions(): ProviderProxySetOperatorDispositionRecording {
    if (this.#durableOperatorDispositionsActivated) return { kind: 'recorded' };
    let recording: ProviderProxySetOperatorDispositionRecording = { kind: 'recorded' };
    if (this.#durablePredecessorRecordsNeedStaleWrite) {
      recording = this.#replaceOperatorDispositionRecords([
        ...this.#durableOperatorDispositions.values(),
        ...this.#durableAcquisitionDispositions.values(),
      ]);
      const setIdentities = new Map(
        [...this.#durableOperatorDispositions.values()].map((record) => [
          providerProxySetKey(record.setIdentity),
          record.setIdentity,
        ]),
      );
      for (const identity of setIdentities.values()) {
        this.#trackDurableSetDispositionWrite(identity, recording);
      }
      for (const record of this.#durableAcquisitionDispositions.values()) {
        if (recording.kind === 'held') this.#heldAcquisitionDispositionWrites.add(record.key);
        else this.#heldAcquisitionDispositionWrites.delete(record.key);
      }
    }
    this.#durableOperatorDispositionsActivated = true;
    if (recording.kind === 'held') this.#scheduleDurableOperatorDispositionReconciliation();
    return recording;
  }

  #trackDurableSetDispositionWrite(
    identity: ProviderProxySetIdentity,
    recording: ProviderProxySetOperatorDispositionRecording,
  ): void {
    const setKey = providerProxySetKey(identity);
    if (recording.kind === 'recorded') {
      this.#heldDurableSetDispositionWrites.delete(setKey);
      return;
    }
    this.#heldDurableSetDispositionWrites.set(setKey, { identity, reason: recording.reason });
  }

  #assertDurableOperatorDispositionAuthority(): void {
    if (!this.#durableOperatorDispositionsActivated) {
      throw new Error('provider_proxy_set_operator_disposition_authority_not_activated');
    }
  }

  #replaceDurableOperatorDispositions(
    identity: ProviderProxySetIdentity,
    dispositions: ReadonlyMap<string, ProviderProxySetOperatorDisposition>,
    status: DurableOperatorDispositionWriteStatus = { kind: 'current-writer', recordedAtMs: this.#deps.time.now() },
    retiredSubjectKeys: ReadonlySet<string> = new Set(),
  ): ProviderProxySetOperatorDispositionRecording {
    this.#assertDurableOperatorDispositionAuthority();
    const writerIncarnation = this.#deps.writerIncarnation;
    const setKey = providerProxySetKey(identity);
    const existingRecords = [...this.#durableOperatorDispositions.values()].filter(
      (record) => providerProxySetKey(record.setIdentity) === setKey,
    );
    const preservedStaleRecords = existingRecords.filter(
      (record) =>
        record.status.kind !== 'current-writer' &&
        !dispositions.has(record.subjectKey) &&
        !retiredSubjectKeys.has(record.subjectKey),
    );
    const preservedStaleKeys = new Set(preservedStaleRecords.map((record) => record.key));
    const retiredKeys = existingRecords
      .filter((record) => !preservedStaleKeys.has(record.key))
      .map((record) => record.key);
    const records = [...dispositions].map(([subjectKey, disposition]) => {
      const predecessor = [...this.#durableOperatorDispositions.values()].find(
        (record) =>
          providerProxySetKey(record.setIdentity) === setKey &&
          record.subjectKey === subjectKey &&
          record.status.kind !== 'current-writer',
      );
      return durableProviderProxySetOperatorDispositionRecord({
        writerIncarnation: predecessor?.writerIncarnation ?? writerIncarnation,
        setIdentity: identity,
        subjectKey,
        disposition,
        status:
          predecessor === undefined
            ? status
            : {
                kind: 'successor-observed' as const,
                observedByIncarnation: writerIncarnation,
                observedAtMs: this.#deps.time.now(),
                evidence: { kind: 'canonical-hold-observation' as const },
              },
      });
    });
    const recording = this.#replaceOperatorDispositionRecords(records, retiredKeys);
    if (recording.kind === 'held') return recording;
    for (const key of retiredKeys) this.#durableOperatorDispositions.delete(key);
    for (const record of records) this.#durableOperatorDispositions.set(record.key, record);
    return recording;
  }

  #replaceOperatorDispositionRecords(
    records: readonly (
      | DurableProviderProxySetOperatorDispositionRecord
      | DurableProviderProxySetAcquisitionDispositionRecord
    )[],
    retiredKeys: readonly string[] = [],
  ): ProviderProxySetOperatorDispositionRecording {
    const result: DurableProviderProxySetOperatorDispositionWriteResult = this.#deps.operatorDispositionStore.replace(
      records,
      retiredKeys,
    );
    return result.disposition === 'recorded'
      ? { kind: 'recorded' }
      : {
          kind: 'held',
          reason: singleLineErrorSummary(result.reason),
          waitingFor: result.waitingFor,
          exit: result.exit,
        };
  }

  #setOperatorDispositions(
    identity: ProviderProxySetIdentity,
    dispositions: Map<string, ProviderProxySetOperatorDisposition>,
    status: DurableOperatorDispositionWriteStatus = { kind: 'current-writer', recordedAtMs: this.#deps.time.now() },
    retiredSubjectKeys: ReadonlySet<string> = new Set(),
  ): ProviderProxySetOperatorDispositionRecording {
    const setKey = providerProxySetKey(identity);
    const pending = this.#pendingOperatorDispositionWrites.get(setKey);
    if (pending !== undefined) this.#deps.time.clearTimeout(pending.timer);
    this.#pendingOperatorDispositionWrites.delete(setKey);
    const desired = new Map(dispositions);
    desired.delete(OPERATOR_DISPOSITION_STORE_REPAIR_SUBJECT);
    if (desired.size === 0) this.#operatorDispositions.delete(setKey);
    else this.#operatorDispositions.set(setKey, desired);
    const recording = this.#replaceDurableOperatorDispositions(identity, desired, status, retiredSubjectKeys);
    if (recording.kind === 'recorded') {
      this.#heldDurableSetDispositionWrites.delete(setKey);
      return recording;
    }
    const held = new Map(desired);
    held.set(OPERATOR_DISPOSITION_STORE_REPAIR_SUBJECT, {
      disposition: 'held',
      incidentReason: recording.reason,
      waitingFor: recording.waitingFor,
    });
    this.#operatorDispositions.set(setKey, held);
    this.#report(
      'warn',
      `Provider proxy set operator disposition remains held in memory pending store repair set=${providerProxySetReference(identity)} error=${recording.reason}`,
    );
    const timer = this.#deps.time.setTimeout(() => {
      if (this.#pendingOperatorDispositionWrites.get(setKey)?.timer !== timer) return;
      this.#pendingOperatorDispositionWrites.delete(setKey);
      this.#setOperatorDispositions(identity, new Map(desired), status, retiredSubjectKeys);
    }, OPERATOR_DISPOSITION_STORE_RETRY_MS);
    timer.unref?.();
    this.#pendingOperatorDispositionWrites.set(setKey, { timer });
    return recording;
  }

  #deleteOperatorDispositions(identity: ProviderProxySetIdentity): ProviderProxySetOperatorDispositionRecording {
    return this.#setOperatorDispositions(identity, new Map());
  }

  #clearLocalOperatorDispositions(identity: ProviderProxySetIdentity): void {
    this.#operatorDispositions.delete(providerProxySetKey(identity));
  }

  #recordDurableAcquisitionDisposition(
    routeKey: string,
    hold: ProviderProxyAcquisitionHeld<string>,
    disposition: ProviderProxySetOperatorDisposition,
  ): ProviderProxySetOperatorDispositionRecording {
    this.#assertDurableOperatorDispositionAuthority();
    const writerIncarnation = this.#deps.writerIncarnation;
    const key = durableProviderProxySetAcquisitionDispositionKey(hold.setAddress, writerIncarnation);
    const retiredKeys = [...this.#durableAcquisitionDispositions.values()]
      .filter(
        (record) =>
          record.setAddress.buildSetId === hold.setAddress.buildSetId &&
          record.setAddress.hostFingerprint === hold.setAddress.hostFingerprint &&
          record.setAddress.proxyInstanceId === hold.setAddress.proxyInstanceId &&
          record.status.kind === 'current-writer',
      )
      .map((record) => record.key);
    const record: DurableProviderProxySetAcquisitionDispositionRecord = {
      generation: PROVIDER_PROXY_SET_OPERATOR_DISPOSITION_GENERATION,
      scope: 'acquisition',
      key,
      writerIncarnation,
      setAddress: hold.setAddress,
      recoverySubject: hold.recoverySubject,
      routeKey,
      disposition,
      status: { kind: 'current-writer', recordedAtMs: this.#deps.time.now() },
    };
    for (const retired of retiredKeys) this.#durableAcquisitionDispositions.delete(retired);
    this.#durableAcquisitionDispositions.set(record.key, record);
    const recording = this.#replaceOperatorDispositionRecords([record], retiredKeys);
    for (const retired of retiredKeys) this.#heldAcquisitionDispositionWrites.delete(retired);
    if (recording.kind === 'held') this.#heldAcquisitionDispositionWrites.add(record.key);
    else this.#heldAcquisitionDispositionWrites.delete(record.key);
    return recording;
  }

  #retireDurableAcquisitionDisposition(
    record: DurableProviderProxySetAcquisitionDispositionRecord,
    evidence: ProviderProxyAcquisitionAbsenceEvidence,
  ): ProviderProxySetOperatorDispositionRecording {
    this.#assertDurableOperatorDispositionAuthority();
    if (
      !isProviderProxyAcquisitionAbsenceEvidenceFor(evidence, record.recoverySubject) ||
      evidence.disappearanceReceipt.length === 0
    ) {
      throw new Error('provider_proxy_set_acquisition_absence_evidence_mismatch');
    }
    if (this.#durableAcquisitionDispositions.get(record.key) !== record) return { kind: 'recorded' };
    const recording = this.#replaceOperatorDispositionRecords([], [record.key]);
    if (recording.kind === 'held') {
      this.#heldAcquisitionDispositionWrites.add(record.key);
      return recording;
    }
    this.#durableAcquisitionDispositions.delete(record.key);
    this.#heldAcquisitionDispositionWrites.delete(record.key);
    return recording;
  }

  #retireDurableSetDispositionsAfterContainmentAbsence(
    identity: ProviderProxySetIdentity,
    proof: ProviderProxySetFencedContainmentProof,
    disappearanceReceipt: string,
  ): ProviderProxySetOperatorDispositionRecording {
    this.#assertDurableOperatorDispositionAuthority();
    if (disappearanceReceipt.length === 0) {
      throw new Error('provider_proxy_set_containment_absence_evidence_missing');
    }
    const evidence = providerProxySetContainmentEvidenceFor(proof, identity);
    if (evidence.kind !== 'reap-required') {
      throw new Error('provider_proxy_set_durable_retirement_evidence_not_decisive');
    }
    const setKey = providerProxySetKey(identity);
    const retiredKeys = [...this.#durableOperatorDispositions.values()]
      .filter((record) => providerProxySetKey(record.setIdentity) === setKey)
      .map((record) => record.key);
    if (retiredKeys.length === 0) return { kind: 'recorded' };
    const recording = this.#replaceOperatorDispositionRecords([], retiredKeys);
    if (recording.kind === 'held') return recording;
    for (const key of retiredKeys) this.#durableOperatorDispositions.delete(key);
    return recording;
  }

  #retireDurableSetDispositionsAfterOperatorAbandonment(
    identity: ProviderProxySetIdentity,
    evidence: OperatorAbandonmentEvidence,
  ): ProviderProxySetOperatorDispositionRecording {
    this.#assertDurableOperatorDispositionAuthority();
    if (evidence.kind !== 'operator-abandoned') {
      throw new Error('provider_proxy_set_operator_abandonment_evidence_missing');
    }
    const setKey = providerProxySetKey(identity);
    const retiredKeys = [...this.#durableOperatorDispositions.values()]
      .filter((record) => providerProxySetKey(record.setIdentity) === setKey)
      .map((record) => record.key);
    if (retiredKeys.length === 0) return { kind: 'recorded' };
    const recording = this.#replaceOperatorDispositionRecords([], retiredKeys);
    if (recording.kind === 'held') return recording;
    for (const key of retiredKeys) this.#durableOperatorDispositions.delete(key);
    return recording;
  }

  async reconcileDurableOperatorDispositions(
    signal: AbortSignal = new AbortController().signal,
  ): Promise<DurableOperatorDispositionReconciliationSettlement> {
    const settlement = await settleDurableOperatorDispositionReconciliation(() =>
      this.#performDurableOperatorDispositionReconciliation(signal),
    );
    if (settlement.kind === 'retry' && !signal.aborted) {
      this.#scheduleDurableOperatorDispositionReconciliation();
    }
    if (settlement.kind !== 'completed') return settlement;
    const heldSetWrite = this.#heldDurableSetDispositionWrites.values().next().value;
    if (heldSetWrite !== undefined) {
      return {
        kind: 'held',
        reason: heldSetWrite.reason,
        waitingFor: 'store-repair',
        exit: 'provider-proxy-set-operator-disposition-store-retry',
      };
    }
    const heldAcquisitionKey = this.#heldAcquisitionDispositionWrites.values().next().value;
    if (heldAcquisitionKey !== undefined) {
      return {
        kind: 'held',
        reason: `provider proxy acquisition disposition remains held key=${heldAcquisitionKey}`,
        waitingFor: 'store-repair',
        exit: 'provider-proxy-set-operator-disposition-store-retry',
      };
    }
    return settlement;
  }

  async #performDurableOperatorDispositionReconciliation(signal: AbortSignal): Promise<void> {
    this.#assertDurableOperatorDispositionAuthority();
    const collectProof = this.#deps.collectOperatorDispositionContainmentProof;
    const writerIncarnation = this.#deps.writerIncarnation;
    {
      const staleBySet = new Map<ProviderProxySetKey, DurableProviderProxySetOperatorDispositionRecord[]>();
      for (const record of this.#durableOperatorDispositions.values()) {
        if (
          record.status.kind !== 'stale' &&
          !(record.status.kind === 'successor-observed' && record.status.evidence.kind !== 'canonical-hold-observation')
        )
          continue;
        const setKey = providerProxySetKey(record.setIdentity);
        const records = staleBySet.get(setKey) ?? [];
        records.push(record);
        staleBySet.set(setKey, records);
      }
      for (const records of staleBySet.values()) {
        signal.throwIfAborted();
        const first = records[0];
        if (first === undefined) continue;
        const identity = first.setIdentity;
        const observation = await reobserveDurableProviderProxySetDisposition({
          identity,
          signal,
          collectProof,
          reobserveContainment: (reobservedIdentity, proof, reobservationSignal) =>
            reobserveDurableProviderProxySetContainment({
              identity: reobservedIdentity,
              proof,
              signal: reobservationSignal,
              reapRecordedContainment: this.#deps.reapRecordedContainment,
            }),
        });
        if (observation.kind === 'retry') {
          this.#deps.onError?.(
            `Durable provider proxy set disposition re-observation failed set=${providerProxySetReference(identity)} error=${observation.reason}`,
          );
          continue;
        }
        if (observation.kind === 'retire') {
          try {
            const recording = this.#retireDurableSetDispositionsAfterContainmentAbsence(
              identity,
              observation.proof,
              observation.disappearanceReceipt,
            );
            this.#trackDurableSetDispositionWrite(identity, recording);
            if (recording.kind === 'held') {
              this.#deps.onError?.(
                `Durable provider proxy set disposition retirement remains held set=${providerProxySetReference(identity)} error=${recording.reason}`,
              );
            }
          } finally {
            releaseProviderProxySetContainmentProofFence(observation.proof);
          }
          continue;
        }
        const recording = this.#recordDurableSetReobservation(records, observation.evidence, observation.reapOutcome);
        this.#trackDurableSetDispositionWrite(identity, recording);
        if (recording.kind === 'held') {
          this.#deps.onError?.(
            `Durable provider proxy set disposition re-observation remains held set=${providerProxySetReference(identity)} error=${recording.reason}`,
          );
        }
      }
    }
    const reobserveAcquisition = this.#deps.reobserveAcquisitionContainment;
    {
      for (const record of [...this.#durableAcquisitionDispositions.values()]) {
        if (record.status.kind !== 'stale' && record.status.kind !== 'successor-acquisition-observed') continue;
        signal.throwIfAborted();
        const observation = await reobserveDurableProviderProxyAcquisitionDisposition({
          subject: record.recoverySubject,
          signal,
          observe: reobserveAcquisition,
        });
        if (observation.kind === 'retry') {
          this.#deps.onError?.(
            `Durable provider proxy acquisition disposition re-observation failed key=${record.key} error=${observation.reason}`,
          );
          continue;
        }
        if (observation.kind === 'retire') {
          const recording = this.#retireDurableAcquisitionDisposition(record, observation.evidence);
          if (recording.kind === 'held') {
            this.#deps.onError?.(
              `Durable provider proxy acquisition disposition retirement remains held key=${record.key} error=${recording.reason}`,
            );
          }
          continue;
        }
        const next: DurableProviderProxySetAcquisitionDispositionRecord = {
          ...record,
          disposition: { ...record.disposition, incidentReason: observation.reason },
          status: {
            kind: 'successor-acquisition-observed',
            observedByIncarnation: writerIncarnation,
            observedAtMs: this.#deps.time.now(),
            observation: observation.observation,
          },
        };
        this.#durableAcquisitionDispositions.set(next.key, next);
        const recording = this.#replaceOperatorDispositionRecords([next]);
        if (recording.kind === 'held') {
          this.#heldAcquisitionDispositionWrites.add(next.key);
          this.#deps.onError?.(
            `Durable provider proxy acquisition disposition update remains held key=${record.key} error=${recording.reason}`,
          );
        } else {
          this.#heldAcquisitionDispositionWrites.delete(next.key);
        }
      }
    }
    this.#scheduleDurableOperatorDispositionReconciliation();
  }

  #scheduleDurableOperatorDispositionReconciliation(): void {
    if (
      this.#durableReobservationTimer === null &&
      (this.#heldDurableSetDispositionWrites.size > 0 ||
        [...this.#durableOperatorDispositions.values()].some(
          (record) =>
            record.status.kind === 'stale' ||
            (record.status.kind === 'successor-observed' &&
              record.status.evidence.kind !== 'canonical-hold-observation'),
        ) ||
        [...this.#durableAcquisitionDispositions.values()].some(
          (record) => record.status.kind === 'stale' || record.status.kind === 'successor-acquisition-observed',
        ))
    ) {
      this.#durableReobservationTimer = this.#deps.time.setTimeout(() => {
        this.#durableReobservationTimer = null;
        void this.reconcileDurableOperatorDispositions().then((settlement) => {
          if (settlement.kind !== 'completed') {
            this.#deps.onError?.(
              `Durable provider proxy disposition scheduled reconciliation failed: ${settlement.reason}`,
            );
          }
        });
      }, REATTACHMENT_HOLD_RETRY_MS);
      this.#durableReobservationTimer.unref?.();
    }
  }

  #recordDurableSetReobservation(
    records: readonly DurableProviderProxySetOperatorDispositionRecord[],
    evidence: ProviderProxySetContainmentEvidence,
    reapOutcome?: DurableProviderProxySetContainmentHoldOutcome,
  ): ProviderProxySetOperatorDispositionRecording {
    const next = records.map((record) => ({
      ...record,
      status: {
        kind: 'successor-observed' as const,
        observedByIncarnation: this.#deps.writerIncarnation,
        observedAtMs: this.#deps.time.now(),
        evidence,
        ...(reapOutcome === undefined ? {} : { reapOutcome }),
      },
    }));
    for (const record of next) this.#durableOperatorDispositions.set(record.key, record);
    return this.#replaceOperatorDispositionRecords(next);
  }

  #reapRecordedContainment(
    identity: ProviderProxySetIdentity,
    proof: ProviderProxySetFencedContainmentProof,
    signal: AbortSignal,
    onSignal: (signal: ProviderProxySetContainmentSignal) => void,
    assertSignalAuthorized?: () => void,
  ): Promise<ProviderProxySetRecordedContainmentReapResult> {
    let transferred = false;
    return this.#deps
      .reapRecordedContainment(identity, proof, signal, onSignal, assertSignalAuthorized)
      .then((result) => {
        transferred = result.kind === 'containment-absent';
        return result;
      })
      .finally(() => {
        if (!transferred) releaseProviderProxySetContainmentProofFence(proof);
      });
  }

  initializeClaimSlots(): void {
    const identities = [...this.#deps.claims.identities()].sort((left, right) =>
      providerProxySetAddressKey(providerProxySetAddress(left)).localeCompare(
        providerProxySetAddressKey(providerProxySetAddress(right)),
      ),
    );
    for (const identity of identities) {
      const key = this.#identityIndex.add(identity);
      if (this.#slots.has(key)) continue;
      this.#slots.set(key, {
        kind: 'recovering',
        recoveryKind: 'claim',
        key,
        identity,
        address: providerProxySetAddress(identity),
        capacityClass: 'retained',
        capsulePath: null,
      });
    }
    this.#classifyCapacity();
  }

  completeStartupDiscovery(): void {
    this.#classifyCapacity();
    this.#startupDiscoveryCompleted = true;
  }

  /**
   * The observation is an operation input rather than a dependency because it is the only process question
   * discovery is entitled to ask. A port would carry spawn, exec, kill and signal along with it; the answers
   * this takes may authorize nothing beyond retiring a capsule whose every recorded process is absent.
   */
  installDiscoveredCapsules(
    capsules: readonly Readonly<{ path: string; capsule: HandoffCapsule }>[],
    inputs: Readonly<{ observeRecordedProcess: RecordedProcessObserver }>,
  ): void {
    if (this.#startupDiscoveryCompleted) throw new Error('provider_proxy_capsule_discovery_already_completed');
    for (const discovered of capsules) {
      this.#installDiscoveredCapsule(discovered.path, discovered.capsule, inputs.observeRecordedProcess);
    }
    this.#classifyCapacity();
    this.#startupDiscoveryCompleted = true;
    for (const slot of this.#slots.values()) {
      if (slot.kind === 'capsule-recovering') this.#recoverExactCapsule(slot);
    }
  }

  beginFreshAcquisition(
    routeKey: string,
    binding?: Readonly<{ buildSetId: string; hostFingerprint: string }>,
  ): FreshProxySetAdmission {
    if (!this.#startupDiscoveryCompleted) {
      return { kind: 'startup-discovery-pending', code: 'provider_proxy_set_startup_discovery_pending' };
    }
    if (
      [...this.#slots.values()].some(
        (slot) =>
          (slot.kind === 'acquiring' && slot.routeKey === routeKey) ||
          (slot.kind === 'capsule-recovering' && slot.routeKey === routeKey) ||
          (slot.kind === 'recovering' &&
            slot.recoveryKind === 'acquisition-publication' &&
            slot.routeKey === routeKey) ||
          ((slot.kind === 'available' ||
            slot.kind === 'draining' ||
            slot.kind === 'containing' ||
            slot.kind === 'containment-wait' ||
            slot.kind === 'absence-delivery-pending' ||
            slot.kind === 'abandonment-delivery-pending') &&
            slot.routeKey === routeKey),
      )
    ) {
      return { kind: 'already-represented' };
    }
    if (
      binding !== undefined &&
      [...this.#slots.values()].some((slot) =>
        slot.kind === 'acquiring'
          ? slot.binding?.buildSetId === binding.buildSetId && slot.binding.hostFingerprint === binding.hostFingerprint
          : slot.kind !== 'capsule-foreign' &&
            slot.address.buildSetId === binding.buildSetId &&
            slot.address.hostFingerprint === binding.hostFingerprint,
      )
    ) {
      return { kind: 'already-represented' };
    }
    if (this.#occupiedSlotCount() + 1 > MAX_COORDINATOR_PROXY_SET_SLOTS) {
      return { kind: 'capacity', code: 'provider_proxy_set_capacity' };
    }
    const slotId = `acquiring-${this.#nextSlotId++}`;
    this.#slots.set(slotId, {
      kind: 'acquiring',
      slotId,
      routeKey,
      address: null,
      binding: binding ?? null,
      cleanupHold: null,
      cleanupRetryTimer: null,
      cleanupAttemptToken: 0,
      cleanupAttempt: null,
    });
    return { kind: 'accepted', slotId };
  }

  acquisitionFailed(slotId: string): void {
    const slot = this.#slots.get(slotId);
    if (slot?.kind === 'acquiring' && slot.cleanupHold === null) this.#slots.delete(slotId);
  }

  acquisitionCleanupHeld(
    slotId: string,
    hold: ProviderProxyAcquisitionHeld<'provider-host-manager'>,
  ): Readonly<{ kind: 'accepted'; owner: 'provider-proxy-set-lifecycle' }> {
    const slot = this.#slots.get(slotId);
    if (slot?.kind !== 'acquiring') throw new Error('provider_proxy_set_acquisition_slot_missing');
    if (slot.cleanupHold !== null) throw new Error('provider_proxy_set_acquisition_cleanup_already_owned');
    const durable = [...this.#durableAcquisitionDispositions.values()].find(
      (record) => providerProxySetAddressKey(record.setAddress) === providerProxySetAddressKey(hold.setAddress),
    );
    if (durable === undefined) throw new Error('provider_proxy_acquisition_durable_hold_missing');
    slot.cleanupHold = hold;
    this.#report(
      'warn',
      `Provider proxy set acquisition cleanup is held ${acquisitionHoldTarget(hold)} error=${singleLineErrorSummary(hold.reason)}`,
    );
    this.#runAcquisitionCleanupRetry(slot);
    return { kind: 'accepted', owner: 'provider-proxy-set-lifecycle' };
  }

  persistAcquisitionCleanupHold(
    slotId: string,
    hold: ProviderProxyAcquisitionHeld<'provider-host-acquisition'>,
  ): ProviderProxyAcquisitionHoldAcceptance {
    const slot = this.#slots.get(slotId);
    if (slot?.kind !== 'acquiring') throw new Error('provider_proxy_set_acquisition_slot_missing');
    const recording = this.#recordDurableAcquisitionDisposition(slot.routeKey, hold, {
      disposition: 'held',
      incidentReason: singleLineErrorSummary(hold.reason),
      waitingFor: acquisitionHoldWaitingFor(hold),
    });
    if (recording.kind === 'held') {
      this.#report(
        'warn',
        `Provider proxy acquisition cleanup remains held because durable reporting failed ${acquisitionHoldTarget(hold)} error=${recording.reason}`,
      );
      return {
        kind: 'held',
        owner: 'provider-host-acquisition',
        reason: recording.reason,
        waitingFor: recording.waitingFor,
        exit: recording.exit,
      };
    }
    return { kind: 'accepted', owner: 'durable-provider-proxy-acquisition-hold-store' };
  }

  acquisitionCleanupPending(
    slotId: string,
    hold: Extract<ProviderProxySetAcquisitionCleanupHold, { kind: 'provider_proxy_acquisition_pending_cleanup' }>,
  ): Readonly<{ kind: 'accepted'; owner: 'provider-proxy-set-lifecycle' }> | Readonly<{ kind: 'already-represented' }> {
    const slot = this.#slots.get(slotId);
    if (slot?.kind !== 'acquiring') return { kind: 'already-represented' };
    if (slot.cleanupHold !== null) throw new Error('provider_proxy_set_acquisition_cleanup_already_owned');
    slot.cleanupHold = hold;
    this.#report('warn', `Provider proxy set acquisition cleanup is pending target=${hold.target}`);
    this.#runAcquisitionCleanupRetry(slot);
    return { kind: 'accepted', owner: 'provider-proxy-set-lifecycle' };
  }

  acquisitionCleanupConfirmed(
    slotId: string,
    hold: ProviderProxySetAcquisitionCleanupHold,
    confirmation: Extract<ProviderProxySetAcquisitionCleanupDisposition, { kind: 'absence-confirmed' }>,
  ): void {
    const slot = this.#slots.get(slotId);
    if (slot?.kind !== 'acquiring' || slot.cleanupHold !== hold) return;
    if (hold.kind === 'provider_proxy_acquisition_held') {
      if (confirmation.evidence === undefined) {
        throw new Error('provider_proxy_set_acquisition_absence_evidence_missing');
      }
      const record = this.#durableAcquisitionRecordForHold(hold);
      const recording = this.#retireDurableAcquisitionDisposition(record, confirmation.evidence);
      if (recording.kind === 'held') {
        this.#report(
          'warn',
          `Provider proxy acquisition absence remains held because durable retirement failed key=${record.key} error=${recording.reason}`,
        );
        this.#scheduleAcquisitionCleanupRetry(slot);
        return;
      }
    }
    this.#slots.delete(slotId);
    if (confirmation.strandedArtifacts.length > 0) {
      this.#report(
        'warn',
        `Provider proxy set acquisition containment is absent with stranded artifacts: ${confirmation.strandedArtifacts.join(', ')}`,
      );
    }
    this.#deps.onSlotReleased?.(slot.routeKey);
  }

  #runAcquisitionCleanupRetry(slot: Extract<ProviderProxySetSlot, { kind: 'acquiring' }>): void {
    const hold = slot.cleanupHold;
    if (hold === null || slot.cleanupAttempt !== null) return;
    const token = ++slot.cleanupAttemptToken;
    const abort = new AbortController();
    const timeout = this.#deps.time.setTimeout(
      () => abort.abort(new Error('provider_proxy_acquisition_cleanup_attempt_deadline')),
      CONTAINMENT_ATTEMPT_MS,
    );
    timeout.unref?.();
    let markSettled!: () => void;
    const attempt: ProviderProxySetCleanupAttempt = {
      abort,
      settlement: new Promise<void>((resolve) => {
        markSettled = resolve;
      }),
    };
    slot.cleanupAttempt = attempt;
    void (async () => {
      try {
        const outcome = await hold.recoveryCapability.retry(abort.signal);
        const current = this.#slots.get(slot.slotId);
        if (current !== slot || slot.cleanupAttemptToken !== token || slot.cleanupAttempt !== attempt) return;
        if (outcome.kind === 'absence-confirmed') {
          if (hold.kind === 'provider_proxy_acquisition_held') {
            if (outcome.evidence === undefined) {
              this.#deps.onError?.('Provider proxy acquisition absence was reported without decisive evidence');
              return;
            }
            try {
              const record = this.#durableAcquisitionRecordForHold(hold);
              const recording = this.#retireDurableAcquisitionDisposition(record, outcome.evidence);
              if (recording.kind !== 'held') {
                this.#slots.delete(slot.slotId);
                if (outcome.strandedArtifacts.length > 0) {
                  this.#report(
                    'warn',
                    `Provider proxy set acquisition containment is absent with stranded artifacts: ${outcome.strandedArtifacts.join(', ')}`,
                  );
                }
                this.#deps.onSlotReleased?.(slot.routeKey);
                return;
              }
              this.#report(
                'warn',
                `Provider proxy acquisition absence remains held because durable retirement failed key=${record.key} error=${recording.reason}`,
              );
              this.#scheduleAcquisitionCleanupRetry(slot);
              return;
            } catch (error) {
              this.#report(
                'warn',
                `Provider proxy acquisition absence remains held because durable retirement failed error=${singleLineErrorSummary(error)}`,
              );
              this.#scheduleAcquisitionCleanupRetry(slot);
              return;
            }
          }
          this.#slots.delete(slot.slotId);
          if (outcome.strandedArtifacts.length > 0) {
            this.#report(
              'warn',
              `Provider proxy set acquisition containment is absent with stranded artifacts: ${outcome.strandedArtifacts.join(', ')}`,
            );
          }
          this.#deps.onSlotReleased?.(slot.routeKey);
          return;
        }
        const target =
          hold.kind === 'provider_proxy_acquisition_held' ? acquisitionHoldTarget(hold) : `target=${hold.target}`;
        const reason =
          outcome.kind === 'delegated'
            ? 'delegation returned before the lifecycle slot accepted ownership'
            : outcome.reason;
        if (hold.kind === 'provider_proxy_acquisition_held') {
          try {
            const recording = this.#recordDurableAcquisitionDisposition(slot.routeKey, hold, {
              disposition: 'held',
              incidentReason: singleLineErrorSummary(reason),
              waitingFor: acquisitionHoldWaitingFor(hold),
            });
            if (recording.kind !== 'held') {
              this.#report(
                'warn',
                `Provider proxy set acquisition cleanup remains held ${target} error=${singleLineErrorSummary(reason)}`,
              );
              this.#scheduleAcquisitionCleanupRetry(slot);
              return;
            }
            this.#report(
              'warn',
              `Provider proxy acquisition cleanup remains held because durable reporting failed ${acquisitionHoldTarget(hold)} error=${recording.reason}`,
            );
          } catch (error) {
            this.#report(
              'warn',
              `Provider proxy acquisition cleanup remains held ${target} error=${singleLineErrorSummary(error)}`,
            );
          }
        }
        this.#report(
          'warn',
          `Provider proxy set acquisition cleanup remains held ${target} error=${singleLineErrorSummary(reason)}`,
        );
        this.#scheduleAcquisitionCleanupRetry(slot);
      } catch (error: unknown) {
        if (this.#slots.get(slot.slotId) !== slot || slot.cleanupAttemptToken !== token) return;
        this.#report(
          'warn',
          `Provider proxy set acquisition cleanup remains held error=${singleLineErrorSummary(error)}`,
        );
        this.#scheduleAcquisitionCleanupRetry(slot);
      } finally {
        this.#deps.time.clearTimeout(timeout);
        if (slot.cleanupAttempt === attempt) slot.cleanupAttempt = null;
        markSettled();
      }
    })();
  }

  #scheduleAcquisitionCleanupRetry(slot: Extract<ProviderProxySetSlot, { kind: 'acquiring' }>): void {
    slot.cleanupRetryTimer = this.#deps.time.setTimeout(() => {
      slot.cleanupRetryTimer = null;
      this.#runAcquisitionCleanupRetry(slot);
    }, REATTACHMENT_HOLD_RETRY_MS);
    slot.cleanupRetryTimer.unref?.();
  }

  #durableAcquisitionRecordForHold(
    hold: ProviderProxyAcquisitionHeld<string>,
  ): DurableProviderProxySetAcquisitionDispositionRecord {
    const record = [...this.#durableAcquisitionDispositions.values()].find(
      (candidate) =>
        providerProxySetAddressKey(candidate.setAddress) === providerProxySetAddressKey(hold.setAddress) &&
        JSON.stringify(candidate.recoverySubject) === JSON.stringify(hold.recoverySubject),
    );
    if (record === undefined) throw new Error('provider_proxy_acquisition_durable_hold_subject_mismatch');
    return record;
  }

  acquisitionPublicationUnknown(
    slotId: string,
    handoff: ProviderProxyAcquisitionSessionHandedOver<'provider-host-manager'>,
    decorateAuthority: (authority: DurableProviderProxyOperationAuthority) => DurableProviderProxyOperationAuthority,
  ): Readonly<{ kind: 'accepted'; owner: 'provider-proxy-set-lifecycle' }> {
    const acquiring = this.#slots.get(slotId);
    if (acquiring?.kind !== 'acquiring') throw new Error('provider_proxy_set_acquisition_slot_missing');
    const refuseSession = (reason: string): never => {
      closeProviderProxyAcquisitionSession(handoff.session, reason);
      this.#slots.delete(slotId);
      throw new Error(reason);
    };
    const {
      setIdentity: identity,
      capsulePath,
      capsuleBinding,
    } = providerProxyAcquisitionSessionDescriptor(handoff.session);
    const capsuleIdentity = providerProxySetIdentityFromCapsule(capsuleBinding);
    if (!providerProxySetIdentitiesEqual(identity, capsuleIdentity)) {
      return refuseSession('provider_proxy_set_acquisition_session_identity_mismatch');
    }
    if (
      acquiring.binding !== null &&
      (acquiring.binding.buildSetId !== capsuleBinding.buildSetId ||
        acquiring.binding.hostFingerprint !== capsuleBinding.hostFingerprint)
    ) {
      return refuseSession('provider_proxy_set_acquisition_capsule_binding_mismatch');
    }
    const address = providerProxySetAddress(identity);
    const addressKey = providerProxySetAddressKey(address);
    const duplicatePath = this.#capsuleAddresses.get(addressKey);
    if (duplicatePath !== undefined && duplicatePath !== capsulePath) {
      return refuseSession('provider_proxy_capsule_address_alias');
    }
    const duplicateGrantPath = this.#capsuleGrants.get(capsuleBinding.grantId);
    if (duplicateGrantPath !== undefined && duplicateGrantPath !== capsulePath) {
      return refuseSession('provider_proxy_capsule_grant_alias');
    }
    if (this.#slots.has(providerProxySetKey(identity))) {
      return refuseSession('provider_proxy_capsule_exact_identity_alias');
    }
    const accepted = handOverProviderProxyAcquisitionControlSession(
      handoff.session,
      providerProxyControlSessionOwner.lifecycle,
      handoff.incident,
    );
    const key = this.#identityIndex.add(identity);
    this.#capsuleAddresses.set(addressKey, capsulePath);
    this.#capsuleGrants.set(capsuleBinding.grantId, capsulePath);
    const incident = singleLineErrorSummary(handoff.incident.reason);
    const slot: Extract<ProviderProxySetSlot, { kind: 'recovering'; recoveryKind: 'acquisition-publication' }> = {
      kind: 'recovering',
      recoveryKind: 'acquisition-publication',
      key,
      identity,
      capsulePath,
      capsuleBinding,
      address,
      capacityClass: 'retained',
      completedAttempts: 0,
      retryTimer: null,
      attemptToken: 0,
      routeKey: acquiring.routeKey,
      session: accepted.session,
      acquisitionCleanupHold: null,
      decorateAuthority,
      unsubscribeFault: null,
    };
    if (acquiring.cleanupHold !== null) {
      slot.acquisitionCleanupHold = {
        kind: 'provider_proxy_acquisition_publication_cleanup',
        owner: 'provider-proxy-set-lifecycle',
        target: providerProxySetReference(identity),
        reason: incident,
        exit: 'publication-confirmation-or-control-reattachment',
        recoveryCapability: {
          retry: (signal) => this.#retryAcquisitionPublicationCleanup(slot, signal),
        },
      };
    }
    this.#slots.set(key, slot);
    this.#slots.delete(slotId);
    this.#setOperatorDispositions(
      identity,
      new Map([
        [
          operatorDispositionSubjectKey('acquisition-publication'),
          {
            disposition: 'held',
            incidentReason: incident,
            waitingFor: 'publication-confirmation-or-control-release',
          },
        ],
      ]),
    );
    this.#report(
      'warn',
      `Provider proxy set acquisition publication is unknown set=${providerProxySetReference(identity)} error=${incident}`,
    );
    this.#classifyCapacity();
    slot.unsubscribeFault = onProviderProxyAcquisitionSessionFault(slot.session, (fault) => {
      if (fault.kind === 'heartbeat-failed') this.#releaseAcquisitionPublicationSession(slot, fault.error);
    });
    this.#runAcquisitionPublicationRetry(slot);
    return { kind: 'accepted', owner: 'provider-proxy-set-lifecycle' };
  }

  acquisitionSucceeded(
    slotId: string,
    authority: DurableProviderProxyOperationAuthority,
    publicationReceipt: PublicationReceipt,
    capsulePath: string | null = null,
  ): Readonly<{ kind: 'accepted'; owner: 'provider-proxy-set-lifecycle' }> {
    const acquiring = this.#slots.get(slotId);
    if (acquiring?.kind !== 'acquiring') throw new Error('provider_proxy_set_acquisition_slot_missing');
    this.#establish(authority, publicationReceipt, acquiring.routeKey, capsulePath, 'serve');
    this.#slots.delete(slotId);
    return { kind: 'accepted', owner: 'provider-proxy-set-lifecycle' };
  }

  registerInheritedSet(
    authority: DurableProviderProxyOperationAuthority,
    publicationReceipt: PublicationReceipt,
    capsulePath: string | null = null,
    protection: ProviderProxySetProtection = 'protected',
  ): void {
    this.#establish(authority, publicationReceipt, null, capsulePath, 'serve', protection);
  }

  routeFor(routeKey: string): DurableProviderProxyOperationAuthority | null {
    const key = this.#routeIndex.get(routeKey);
    if (key === undefined) return null;
    const slot = this.#slots.get(key);
    return slot?.kind === 'available' &&
      slot.capacityClass === 'retained' &&
      slot.operationControlState === 'operational'
      ? slot.authority
      : null;
  }

  authorityFor(identity: ProviderProxySetIdentity): DurableProviderProxyOperationAuthority | null {
    const slot = this.#slots.get(providerProxySetKey(identity));
    if (
      slot === undefined ||
      slot.kind === 'acquiring' ||
      slot.kind === 'capsule-recovering' ||
      slot.kind === 'capsule-foreign' ||
      slot.kind === 'recovering' ||
      slot.kind === 'reattaching' ||
      slot.kind === 'reattachment-hold' ||
      slot.kind === 'containing' ||
      slot.kind === 'containment-wait' ||
      slot.kind === 'absence-delivery-pending' ||
      slot.kind === 'abandonment-delivery-pending' ||
      slot.operationControlState === 'outcome-unknown' ||
      !providerProxySetIdentitiesEqual(slot.identity, identity)
    ) {
      return null;
    }
    return slot.authority;
  }

  liveSets(): readonly DurableProviderProxyOperationAuthority[] {
    return [...this.#slots.values()].flatMap((slot) => {
      if (!providerProxySetSlotIsLive[slot.kind]) return [];
      switch (slot.kind) {
        case 'available':
        case 'draining':
        case 'reattaching':
        case 'reattachment-hold':
        case 'containing':
        case 'containment-wait':
          return [slot.authority];
        case 'absence-delivery-pending':
        case 'abandonment-delivery-pending':
          return slot.authority === null ? [] : [slot.authority];
        case 'acquiring':
        case 'capsule-recovering':
        case 'capsule-foreign':
        case 'recovering':
          return [];
        default:
          return assertNever(slot);
      }
    });
  }

  acquisitionCleanupHolds(): readonly ProviderProxySetAcquisitionCleanupHold[] {
    return [...this.#slots.values()].flatMap((slot) => {
      if (slot.kind === 'acquiring') return slot.cleanupHold === null ? [] : [slot.cleanupHold];
      if (
        slot.kind === 'capsule-recovering' ||
        (slot.kind === 'recovering' && slot.recoveryKind === 'acquisition-publication')
      ) {
        return slot.acquisitionCleanupHold === null ? [] : [slot.acquisitionCleanupHold];
      }
      return [];
    });
  }

  abandonDurableAcquisition(address: ProviderProxySetAddress): ProviderProxySetDurableAcquisitionAbandonment {
    this.#assertDurableOperatorDispositionAuthority();
    const addressKey = providerProxySetAddressKey(address);
    const records = [...this.#durableAcquisitionDispositions.values()].filter(
      (record) => providerProxySetAddressKey(record.setAddress) === addressKey,
    );
    if (records.length === 0) return { kind: 'not-found' };
    const liveSlots = [...this.#slots.values()].flatMap((slot) => {
      if (
        slot.kind !== 'acquiring' ||
        slot.cleanupHold?.kind !== 'provider_proxy_acquisition_held' ||
        providerProxySetAddressKey(slot.cleanupHold.setAddress) !== addressKey
      ) {
        return [];
      }
      return [{ slot, hold: slot.cleanupHold }];
    });
    const unsupportedLiveHold = liveSlots.find(
      ({ hold }) =>
        !('operatorExit' in hold) ||
        !records.some((record) => JSON.stringify(record.recoverySubject) === JSON.stringify(hold.recoverySubject)),
    );
    if (unsupportedLiveHold !== undefined) {
      return {
        kind: 'live-exit-unavailable',
        reason: 'the live acquisition cleanup hold has no exact-subject operator abandonment exit',
        exit: 'acquisition-cleanup-retry',
      };
    }
    const activeAttempts = liveSlots.flatMap(({ slot }) => (slot.cleanupAttempt === null ? [] : [slot.cleanupAttempt]));
    if (activeAttempts.length > 0) {
      for (const { slot } of liveSlots) {
        slot.cleanupAttemptToken += 1;
        slot.cleanupAttempt?.abort.abort(new Error('provider_proxy_acquisition_operator_abandonment_requested'));
        if (slot.cleanupRetryTimer !== null) this.#deps.time.clearTimeout(slot.cleanupRetryTimer);
        slot.cleanupRetryTimer = null;
      }
      return {
        kind: 'transfer-pending',
        reason: 'an acquisition cleanup attempt is still settling',
        waitingFor: 'cleanup-attempt-settlement',
        exit: 'provider-proxy-set-operator-abandonment-retry',
      };
    }
    const recording = this.#replaceOperatorDispositionRecords(
      [],
      records.map((record) => record.key),
    );
    if (recording.kind === 'held') {
      for (const record of records) this.#heldAcquisitionDispositionWrites.add(record.key);
      this.#deps.onError?.(
        `Durable provider proxy acquisition abandonment remains held set=${encodeProviderProxySetAddress(address)} error=${recording.reason}`,
      );
      return recording;
    }
    for (const { slot, hold } of liveSlots) {
      if (!('operatorExit' in hold)) throw new Error('provider_proxy_acquisition_operator_exit_missing');
      const abandonment = hold.operatorExit.abandon();
      if (
        abandonment.kind !== 'operator-abandoned' ||
        abandonment.processAbsenceProven ||
        abandonment.successor.owner !== 'operator-command' ||
        abandonment.successor.acceptance !== 'accepted' ||
        JSON.stringify(abandonment.recoverySubject) !== JSON.stringify(hold.recoverySubject)
      ) {
        throw new Error('provider_proxy_acquisition_operator_exit_not_accepted');
      }
      if (slot.cleanupRetryTimer !== null) this.#deps.time.clearTimeout(slot.cleanupRetryTimer);
      slot.cleanupRetryTimer = null;
      slot.cleanupHold = null;
      this.#slots.delete(slot.slotId);
      this.#deps.onSlotReleased?.(slot.routeKey);
    }
    for (const record of records) {
      this.#durableAcquisitionDispositions.delete(record.key);
      this.#heldAcquisitionDispositionWrites.delete(record.key);
    }
    return { kind: 'retired' };
  }

  representationReleaseHolds(): readonly Readonly<{
    label: string;
    proxyInstanceId: string;
    pendingOperations: readonly string[];
    disposition: ProviderProxyRepresentationReleaseDisposition;
    exit: 'provider-proxy-representation-release-settlement';
    settlement: Promise<ProviderProxyRepresentationReleaseSettlement>;
  }>[] {
    return [...this.#slots.values()].flatMap((slot) =>
      slot.kind === 'absence-delivery-pending' || slot.kind === 'abandonment-delivery-pending'
        ? [
            {
              label: `provider proxy representation release ${providerProxySetReference(slot.identity)}`,
              proxyInstanceId: slot.identity.proxyInstanceId,
              pendingOperations: [...slot.pendingOperations.values()].map(operationKey),
              disposition: this.#representationReleaseDisposition(slot),
              exit: 'provider-proxy-representation-release-settlement' as const,
              settlement: slot.representationReleaseSettlement,
            },
          ]
        : [],
    );
  }

  #representationReleaseDisposition(slot: ReleaseDeliveryPendingSlot): ProviderProxyRepresentationReleaseDisposition {
    if (slot.fatalSettlement !== null) {
      return {
        ...slot.fatalSettlement,
        exit: 'provider-proxy-set-operator-abandonment',
      };
    }
    if (
      slot.retirementState === 'retry-owned' ||
      [...slot.initialDeliveries.values()].some((delivery) => delivery.kind === 'retry-owned')
    ) {
      return { kind: 'operational-retry-owned', exit: 'provider-proxy-set-release-retry' };
    }
    return { kind: 'in-progress' };
  }

  beginGracefulDrain(identity: ProviderProxySetIdentity): void {
    const slot = this.#slots.get(providerProxySetKey(identity));
    if (slot?.kind !== 'available') return;
    this.#retireAvailableSlot(slot, 'graceful_idle');
  }

  claimsChanged(identity: ProviderProxySetIdentity): void {
    const slot = this.#slots.get(providerProxySetKey(identity));
    if (slot === undefined) return;
    // A reattachment hold never became decisive on its own evidence, but zero claims makes ordinary
    // retirement safe regardless of source: nothing this coordinator still has a claim in is destroyed.
    if (slot.kind === 'reattachment-hold') {
      const window = slot.controlReattachmentWindow;
      if (window === null || this.#deps.claims.claimsFor(slot.identity).length !== 0) return;
      this.#clearControlReattachment(slot, window);
      this.#clearLocalOperatorDispositions(slot.identity);
      this.#beginRetirementContainment(slot, this.#retirementStopDecision(slot, 'graceful_idle', 0));
      return;
    }
    if ((slot.kind === 'available' || slot.kind === 'draining') && this.#hasLiveClaimsHold(slot)) {
      const liveClaims = this.#deps.claims.claimsFor(slot.identity).length;
      if (liveClaims !== 0) return;
      const retirementReason =
        slot.kind === 'draining' && slot.retirementDecision !== null ? slot.retirementDecision.reason : 'graceful_idle';
      this.#clearLocalOperatorDispositions(slot.identity);
      this.#beginRetirementContainment(slot, this.#retirementStopDecision(slot, retirementReason, liveClaims));
      return;
    }
    if (slot.kind !== 'draining' || slot.retirementDecision === null) return;
    const liveClaims = this.#deps.claims.claimsFor(slot.identity).length;
    if (liveClaims !== 0) return;
    this.#beginRetirementContainment(
      slot,
      this.#retirementStopDecision(slot, slot.retirementDecision.reason, liveClaims),
    );
  }

  recordAuthorityIncident(identity: ProviderProxySetIdentity, incident: ProviderProxyAuthorityObservation): void {
    this.#recordAuthorityIncident(identity, null, null, incident);
  }

  #recordAuthorityIncident(
    identity: ProviderProxySetIdentity,
    authority: DurableProviderProxyOperationAuthority | null,
    token: number | null,
    incident: ProviderProxyAuthorityObservation,
  ): void {
    const slot = this.#slots.get(providerProxySetKey(identity));
    if (
      slot === undefined ||
      slot.kind === 'acquiring' ||
      slot.kind === 'capsule-recovering' ||
      slot.kind === 'capsule-foreign' ||
      slot.kind === 'recovering' ||
      slot.kind === 'absence-delivery-pending' ||
      slot.kind === 'abandonment-delivery-pending' ||
      slot.kind === 'containing' ||
      slot.kind === 'containment-wait' ||
      (authority !== null && (slot.authority !== authority || slot.attemptToken !== token))
    ) {
      return;
    }
    if (incident.kind === 'control-channel-fault') {
      if (slot.kind !== 'reattaching' && slot.kind !== 'reattachment-hold') {
        this.#beginControlReattachment(slot, incident);
      }
      return;
    }
    if (slot.kind === 'reattaching' || slot.kind === 'reattachment-hold') return;
    if (incident.kind === 'heartbeat-observation') {
      this.#recordHeartbeatObservation(slot, incident);
      return;
    }
    const context = {
      action: 'preserve' as const,
      error: singleLineErrorSummary(incident.error),
      liveClaims: this.#deps.claims.claimsFor(slot.identity).length,
      setIdentity: slot.identity,
    };
    const decision: ProviderProxySetPreserveDecision = {
      ...context,
      reason: 'retry_safe_operation_control_failure',
      fault: incident.kind,
      policy: incident.policy,
    };
    this.#recordDecision(slot, decision, preserveErrorIdentity(incident.error));
  }

  #faultAuthority(
    identity: ProviderProxySetIdentity,
    authority: DurableProviderProxyOperationAuthority,
    token: number,
    fault: ProviderProxyAuthorityFault,
  ): void {
    const slot = this.#slots.get(providerProxySetKey(identity));
    if (
      slot === undefined ||
      slot.kind === 'acquiring' ||
      slot.kind === 'capsule-recovering' ||
      slot.kind === 'capsule-foreign' ||
      slot.kind === 'recovering' ||
      slot.kind === 'absence-delivery-pending' ||
      slot.kind === 'abandonment-delivery-pending' ||
      slot.authority !== authority ||
      slot.attemptToken !== token ||
      slot.operationControlState === 'outcome-unknown'
    ) {
      return;
    }
    if (
      slot.kind === 'reattaching' ||
      slot.kind === 'reattachment-hold' ||
      slot.kind === 'containing' ||
      slot.kind === 'containment-wait'
    ) {
      return;
    }
    const liveClaims = this.#deps.claims.claimsFor(slot.identity).length;
    if (liveClaims === 0 || (fault.kind === 'heartbeat-failed' && fault.terminalReason === 'teardown-latched')) {
      this.#beginFaultContainment(slot, this.#authorityFaultDecision(slot, fault));
      return;
    }
    if (fault.kind === 'heartbeat-failed') {
      this.#beginHeartbeatLocalFailureHold(slot, fault);
      return;
    }
    this.#holdOperationControlIndeterminate(slot, fault);
  }

  #hasLiveClaimsHold(slot: EstablishedSlot): boolean {
    const dispositions = this.#operatorDispositions.get(slot.key);
    if (dispositions === undefined) return false;
    for (const disposition of dispositions.values()) {
      if (
        disposition.waitingFor === 'heartbeat-bound-live-claims' ||
        disposition.waitingFor === 'heartbeat-protocol-live-claims' ||
        disposition.waitingFor === 'operation-control-outcome-unknown'
      ) {
        return true;
      }
    }
    return false;
  }

  #armObservedOperatorExitGate(slot: EstablishedSlot | CapsuleRecoveringSlot): void {
    if (slot.operatorExitNotBeforeMonotonicMs !== null) return;
    const observedAtMonotonicMs = this.#deps.time.monotonicNow();
    const gate: OperatorExitObservedGate = {
      boundMs: CONTAINMENT_ATTEMPT_MS,
      observedElapsedMs: 0,
      lastObservedAtMonotonicMs: observedAtMonotonicMs,
    };
    slot.operatorExitNotBeforeMonotonicMs = observedAtMonotonicMs + BigInt(gate.boundMs);
    slot.operatorExitObservedGate = gate;
  }

  #observeOperatorExitGate(slot: EstablishedSlot | CapsuleRecoveringSlot, gate: OperatorExitObservedGate): number {
    const observedAtMonotonicMs = this.#deps.time.monotonicNow();
    const gapMs = observedAtMonotonicMs - gate.lastObservedAtMonotonicMs;
    gate.lastObservedAtMonotonicMs = observedAtMonotonicMs;
    if (gapMs > 0n) {
      gate.observedElapsedMs = Math.min(
        gate.boundMs,
        gate.observedElapsedMs + Math.min(Number(gapMs), OPERATOR_EXIT_OBSERVATION_MS),
      );
    }
    const remainingMs = Math.max(0, gate.boundMs - gate.observedElapsedMs);
    slot.operatorExitNotBeforeMonotonicMs = observedAtMonotonicMs + BigInt(remainingMs);
    return remainingMs;
  }

  #clearObservedOperatorExitGate(slot: EstablishedSlot | CapsuleRecoveringSlot): void {
    slot.operatorExitObservedGate = null;
  }

  #operatorExitAvailability(slot: ProviderProxySetSlot):
    | Readonly<{ kind: 'authorized'; slot: EstablishedSlot | CapsuleRecoveringSlot | ReleaseDeliveryPendingSlot }>
    | Readonly<{ kind: 'not-held'; state: ProviderProxySetLifecycleState }>
    | Readonly<{
        kind: 'deadline-pending';
        remainingMs: number;
        slot: EstablishedSlot | CapsuleRecoveringSlot | ReleaseDeliveryPendingSlot;
      }> {
    const fatalReleasePending =
      (slot.kind === 'absence-delivery-pending' || slot.kind === 'abandonment-delivery-pending') &&
      slot.fatalSettlement !== null;
    const heldWhileRoutable = (slot.kind === 'available' || slot.kind === 'draining') && this.#hasLiveClaimsHold(slot);
    if (
      slot.kind !== 'reattaching' &&
      slot.kind !== 'reattachment-hold' &&
      slot.kind !== 'containing' &&
      slot.kind !== 'containment-wait' &&
      slot.kind !== 'capsule-recovering' &&
      !fatalReleasePending &&
      !heldWhileRoutable
    ) {
      return { kind: 'not-held', state: slot.kind };
    }
    if (slot.operatorExitNotBeforeMonotonicMs === null) return { kind: 'not-held', state: slot.kind };
    if ('operatorExitObservedGate' in slot && slot.operatorExitObservedGate !== null) {
      const remainingObservedMs = this.#observeOperatorExitGate(slot, slot.operatorExitObservedGate);
      if (remainingObservedMs > 0) return { kind: 'deadline-pending', remainingMs: remainingObservedMs, slot };
    }
    if ((slot.kind === 'reattaching' || slot.kind === 'reattachment-hold') && slot.controlReattachmentWindow !== null) {
      const remainingObservedMs = Math.max(
        0,
        slot.controlReattachmentWindow.boundMs - slot.controlReattachmentWindow.observedElapsedMs,
      );
      if (remainingObservedMs > 0) return { kind: 'deadline-pending', remainingMs: remainingObservedMs, slot };
    }
    const remainingMs = Number(slot.operatorExitNotBeforeMonotonicMs - this.#deps.time.monotonicNow());
    return remainingMs > 0 ? { kind: 'deadline-pending', remainingMs, slot } : { kind: 'authorized', slot };
  }

  #operatorExit(
    slot: ProviderProxySetSlot,
    dispositions: ReadonlyMap<string, ProviderProxySetOperatorDisposition>,
  ): ProviderProxySetOperatorExit {
    if (
      (slot.kind === 'absence-delivery-pending' || slot.kind === 'abandonment-delivery-pending') &&
      slot.fatalSettlement !== null
    ) {
      return { kind: 'refused', ground: 'representation-release-fatal' };
    }
    const availability = this.#operatorExitAvailability(slot);
    if (availability.kind === 'not-held') return { kind: 'none' };
    if (availability.kind === 'deadline-pending') {
      return { kind: 'gated', remainingMs: availability.remainingMs };
    }
    const refusal = [...dispositions.values()].find(
      (disposition) => disposition.disposition === 'operator-exit-refused',
    );
    if (refusal === undefined) return { kind: 'contain' };
    switch (refusal.incidentReason) {
      case 'operator_exit_enforcer-alive':
        return { kind: 'refused', ground: 'enforcer-alive' };
      case 'operator_exit_enforcer-unobservable':
        return { kind: 'refused', ground: 'enforcer-unobservable' };
      case 'operator_exit_recorded_group_unattributable':
        return { kind: 'refused', ground: 'recorded-group-unattributable' };
      case 'operator_exit_signal_authorization_refused':
        return { kind: 'refused', ground: 'signal-authorization-refused' };
      case 'operator_exit_identity_unobservable':
        return { kind: 'refused', ground: 'identity-unobservable' };
      case 'operator_exit_store_unreadable':
        return { kind: 'refused', ground: 'store-unreadable' };
      case 'operator_exit_representation_release_fatal':
        return { kind: 'refused', ground: 'representation-release-fatal' };
      case 'operator_exit_deadline_pending':
      case 'operator_exit_requires_held_set':
        return { kind: 'contain' };
      default:
        return { kind: 'none' };
    }
  }

  authorizeBooleanOperatorExit(address: ProviderProxySetAddress): ProviderProxySetBooleanOperatorExitAuthorization {
    const key = this.#identityIndex.keyForAddress(address);
    if (key === null) return { kind: 'set-not-found' };
    const slot = this.#slots.get(key);
    if (slot === undefined) return { kind: 'set-not-found' };
    if (
      (slot.kind === 'absence-delivery-pending' || slot.kind === 'abandonment-delivery-pending') &&
      slot.fatalSettlement !== null
    ) {
      return { kind: 'unsupported-contract' };
    }
    return this.authorizeOperatorExit(address);
  }

  authorizeOperatorExit(address: ProviderProxySetAddress): ProviderProxySetOperatorExitAuthorization {
    const key = this.#identityIndex.keyForAddress(address);
    if (key === null) return { kind: 'set-not-found' };
    const slot = this.#slots.get(key);
    if (slot === undefined) return { kind: 'set-not-found' };
    const availability = this.#operatorExitAvailability(slot);
    if (availability.kind === 'not-held') {
      if (slot.kind === 'available' || slot.kind === 'draining') {
        this.#recordOperatorExitRefusal(slot, 'operator_exit_requires_held_set', 'ordinary-drain');
      }
      return availability;
    }
    if (availability.kind === 'deadline-pending') {
      this.#recordOperatorExitRefusal(availability.slot, 'operator_exit_deadline_pending', 'set-adoption-deadline');
      return { kind: 'deadline-pending', remainingMs: availability.remainingMs };
    }
    const authorizedSlot = availability.slot;
    const notBeforeMonotonicMs = authorizedSlot.operatorExitNotBeforeMonotonicMs;
    if (notBeforeMonotonicMs === null) return { kind: 'not-held', state: authorizedSlot.kind };
    const fenceProviderOperationMutations = this.#deps.fenceProviderOperationMutations;
    if (fenceProviderOperationMutations === undefined) {
      throw new Error('provider_proxy_operator_exit_mutation_fence_unavailable');
    }
    if ('operatorExitObservedGate' in authorizedSlot) this.#clearObservedOperatorExitGate(authorizedSlot);
    authorizedSlot.operatorExitGeneration += 1;
    authorizedSlot.attemptToken += 1;
    if (authorizedSlot.kind === 'capsule-recovering') {
      authorizedSlot.attemptAbort?.abort(new Error('provider_proxy_operator_exit_authorized'));
      authorizedSlot.attemptAbort = null;
      if (authorizedSlot.retryTimer !== null) this.#deps.time.clearTimeout(authorizedSlot.retryTimer);
      authorizedSlot.retryTimer = null;
      authorizedSlot.recoveryPhase = 'containment-wait';
    } else {
      if (
        authorizedSlot.kind === 'absence-delivery-pending' ||
        authorizedSlot.kind === 'abandonment-delivery-pending'
      ) {
        this.#clearRepresentationReleaseTimers(authorizedSlot);
      } else {
        this.#removeRoute(authorizedSlot);
        authorizedSlot.containmentAttemptAbort?.abort(new Error('provider_proxy_operator_exit_authorized'));
        authorizedSlot.containmentAttemptAbort = null;
        if (authorizedSlot.controlReattachmentWindow !== null) {
          this.#clearControlReattachment(authorizedSlot, authorizedSlot.controlReattachmentWindow);
        }
        if (authorizedSlot.retryTimer !== null) this.#deps.time.clearTimeout(authorizedSlot.retryTimer);
        authorizedSlot.retryTimer = null;
        authorizedSlot.kind = 'containment-wait';
        authorizedSlot.operationControlState = 'operator-fenced';
        holdProviderProxyOperationControl(authorizedSlot.authority, 'operator-exit-fenced');
      }
    }
    const priorDestructiveAttemptsSettled = this.#destructiveAttemptsSettled(authorizedSlot);
    const mutationFence = fenceProviderOperationMutations(authorizedSlot.identity);
    const operatorExitGeneration = authorizedSlot.operatorExitGeneration;
    const attemptToken = authorizedSlot.attemptToken;
    let admissionClose: Promise<void> | null = null;
    const closeAdmission = (): Promise<void> => {
      admissionClose ??= (async () => {
        if (mutationFence.kind === 'holding') await mutationFence.retryAfter;
        const current = this.#slots.get(providerProxySetKey(authorizedSlot.identity));
        if (
          current !== authorizedSlot ||
          current.operatorExitGeneration !== operatorExitGeneration ||
          current.attemptToken !== attemptToken
        ) {
          mutationFence.release();
          return;
        }
        if (
          authorizedSlot.kind !== 'capsule-recovering' &&
          authorizedSlot.kind !== 'absence-delivery-pending' &&
          authorizedSlot.kind !== 'abandonment-delivery-pending'
        ) {
          authorizedSlot.authority.stopHeartbeats();
          await authorizedSlot.authority.initiateControlClose();
        }
      })();
      return admissionClose;
    };
    const containmentProofAuthorization = authorizeProviderProxySetContainmentProof(authorizedSlot.identity, {
      mutationFence,
      closeAdmission,
    });
    const priorFenceAuthorization = this.#operatorExitFenceAuthorizations.get(authorizedSlot.key);
    this.#operatorExitFenceAuthorizations.set(authorizedSlot.key, containmentProofAuthorization);
    if (priorFenceAuthorization !== undefined) {
      releaseProviderProxySetContainmentProofFence(priorFenceAuthorization);
    }
    return {
      kind: 'authorized',
      capability: Object.freeze({
        setIdentity: authorizedSlot.identity,
        containmentProofAuthorization,
        notBeforeMonotonicMs,
        operatorExitGeneration,
        attemptToken,
        priorDestructiveAttemptsSettled,
        [operatorExitCapabilityBrand]: this,
      }) as ProviderProxySetOperatorExitCapability,
    };
  }

  async completeOperatorExit(
    capability: ProviderProxySetOperatorExitCapability,
    proof: ProviderProxySetFencedContainmentProof,
    abandonWithoutAbsence: boolean,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<ProviderProxySetOperatorExitResult> {
    return this.#completeOperatorExit(capability, proof, {
      contract: 'current',
      behavior: abandonWithoutAbsence ? 'abandon' : 'contain',
      signal,
    });
  }

  async completeBooleanOperatorExit(
    capability: ProviderProxySetOperatorExitCapability,
    proof: ProviderProxySetFencedContainmentProof,
    abandonWithoutAbsence: boolean,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<ProviderProxySetBooleanOperatorExitResult> {
    return this.#completeOperatorExit(capability, proof, {
      contract: 'boolean',
      behavior: abandonWithoutAbsence ? 'boolean-abandon' : 'contain',
      signal,
    });
  }

  async #completeOperatorExit(
    capability: ProviderProxySetOperatorExitCapability,
    proof: ProviderProxySetFencedContainmentProof,
    request: ProviderProxySetCurrentOperatorExitRequest,
  ): Promise<ProviderProxySetOperatorExitResult>;
  async #completeOperatorExit(
    capability: ProviderProxySetOperatorExitCapability,
    proof: ProviderProxySetFencedContainmentProof,
    request: ProviderProxySetBooleanOperatorExitRequest,
  ): Promise<ProviderProxySetBooleanOperatorExitResult>;
  async #completeOperatorExit(
    capability: ProviderProxySetOperatorExitCapability,
    proof: ProviderProxySetFencedContainmentProof,
    request: ProviderProxySetOperatorExitRequest,
  ): Promise<ProviderProxySetBooleanOperatorExitResult> {
    const address = providerProxySetAddress(capability.setIdentity);
    const noEffect: ProviderProxySetOperatorExitEffect = {
      signalsSent: [],
      containmentAbsent: false,
      representationAction: 'none',
    };
    if (capability[operatorExitCapabilityBrand] !== this) {
      throw new Error('provider_proxy_operator_exit_capability_invalid');
    }
    await capability.priorDestructiveAttemptsSettled;
    const evidence = providerProxySetContainmentEvidenceFor(
      proof,
      capability.setIdentity,
      capability.containmentProofAuthorization,
    );
    const slot = this.#slots.get(providerProxySetKey(capability.setIdentity));
    if (slot === undefined) {
      this.#releaseOperatorExitFence(capability);
      return { kind: 'set-not-found', setIdentity: address, effect: noEffect };
    }
    const fatalReleasePending =
      (slot.kind === 'absence-delivery-pending' || slot.kind === 'abandonment-delivery-pending') &&
      slot.fatalSettlement !== null;
    const heldWhileRoutable = (slot.kind === 'available' || slot.kind === 'draining') && this.#hasLiveClaimsHold(slot);
    if (
      (slot.kind !== 'containing' &&
        slot.kind !== 'containment-wait' &&
        slot.kind !== 'reattaching' &&
        slot.kind !== 'reattachment-hold' &&
        slot.kind !== 'capsule-recovering' &&
        !fatalReleasePending &&
        !heldWhileRoutable) ||
      !providerProxySetIdentitiesEqual(slot.identity, capability.setIdentity)
    ) {
      this.#releaseOperatorExitFence(capability);
      return { kind: 'not-held', setIdentity: address, state: slot.kind, effect: noEffect };
    }
    if (
      slot.operatorExitNotBeforeMonotonicMs !== capability.notBeforeMonotonicMs ||
      slot.operatorExitGeneration !== capability.operatorExitGeneration ||
      slot.attemptToken !== capability.attemptToken ||
      this.#deps.time.monotonicNow() < capability.notBeforeMonotonicMs
    ) {
      this.#releaseOperatorExitFence(capability);
      return { kind: 'authorization-stale', setIdentity: address, effect: noEffect };
    }
    const proofCurrentness = verifyProviderProxySetContainmentProofCurrent(proof, capability.setIdentity);
    if (proofCurrentness.kind === 'authorization-missing') {
      this.#releaseOperatorExitFence(capability);
      return { kind: 'authorization-stale', setIdentity: address, effect: noEffect };
    }
    if (proofCurrentness.kind === 'authorization-stale') {
      this.#releaseOperatorExitFence(capability);
      return { kind: 'authorization-stale', setIdentity: address, effect: noEffect };
    }
    if (slot.kind === 'absence-delivery-pending' || slot.kind === 'abandonment-delivery-pending') {
      if (slot.fatalSettlement === null) {
        this.#releaseOperatorExitFence(capability);
        return { kind: 'not-held', setIdentity: address, state: slot.kind, effect: noEffect };
      }
      if (request.behavior === 'contain') {
        this.#releaseOperatorExitFence(capability);
        return { kind: 'representation-release-abandonment-required', setIdentity: address, effect: noEffect };
      }
      this.#releaseOperatorExitFence(capability);
      this.#acceptFatalRepresentationReleaseSuccessor(slot);
      return {
        kind: 'representation-release-abandoned',
        setIdentity: address,
        successor: { owner: 'operator-command', acceptance: 'accepted' },
        effect: { signalsSent: [], containmentAbsent: false, representationAction: 'fatal-release-abandoned' },
      };
    }
    if (proofCurrentness.kind === 'store-unreadable') {
      this.#recordOperatorExitRefusal(slot, 'operator_exit_store_unreadable', 'store-repair');
      this.#releaseOperatorExitFence(capability);
      return { kind: 'store-unreadable', setIdentity: address, effect: noEffect };
    }
    if (evidence.kind === 'store-unreadable') {
      this.#recordOperatorExitRefusal(slot, 'operator_exit_store_unreadable', 'store-repair');
      this.#releaseOperatorExitFence(capability);
      return { kind: 'store-unreadable', setIdentity: address, effect: noEffect };
    }
    if (request.behavior === 'abandon' && evidence.kind === 'reap-required') {
      const enforcerObservations: ProviderProxySetEnforcerObservations = [
        { role: 'guardian', observation: 'absent' },
        { role: 'reaper', observation: 'absent' },
      ];
      const decision: ProviderProxySetOperatorAbandonmentDecision = {
        action: 'abandon',
        reason: 'operator_exact_set_abandonment',
        liveClaims: this.#deps.claims.claimsFor(slot.identity).length,
        setIdentity: slot.identity,
      };
      if (slot.kind === 'capsule-recovering') {
        this.#recordOperatorDisposition(decision);
        this.#reportDecision(decision);
      } else {
        this.#recordDecision(slot, decision);
      }
      const abandonmentEvidence: OperatorAbandonmentEvidence = Object.freeze({
        kind: 'operator-abandoned',
        basis: 'enforcer-observations',
        enforcerObservations,
        [operatorAbandonmentEvidenceBrand]: true as const,
      });
      return this.#completeOperatorAbandonment({
        slot,
        capability,
        proof,
        request,
        abandonmentEvidence,
        setIdentity: address,
        signalsSent: [],
        resultForClaimDischarge: (claimDischarge, releaseEffect) => ({
          kind: 'abandoned',
          setIdentity: address,
          enforcerObservations,
          claimDischarge,
          effect: releaseEffect,
        }),
      });
    }
    if (evidence.kind === 'reap-required') {
      const signalsSent: ProviderProxySetContainmentSignal[] = [];
      const assertCapabilityCurrent = (): void => {
        const current = this.#slots.get(providerProxySetKey(capability.setIdentity));
        if (
          current !== slot ||
          current.attemptToken !== capability.attemptToken ||
          current.operatorExitNotBeforeMonotonicMs !== capability.notBeforeMonotonicMs ||
          current.operatorExitGeneration !== capability.operatorExitGeneration ||
          this.#deps.time.monotonicNow() < capability.notBeforeMonotonicMs
        ) {
          throw new Error('provider_proxy_operator_exit_authorization_stale');
        }
      };
      const attemptSignal =
        slot.kind === 'capsule-recovering'
          ? slot.attemptAbort?.signal
          : slot.kind === 'reattaching' || slot.kind === 'reattachment-hold'
            ? slot.controlReattachmentWindow?.attemptAbort?.signal
            : slot.containmentAttemptAbort?.signal;
      const reapingSignal =
        attemptSignal === undefined ? request.signal : AbortSignal.any([request.signal, attemptSignal]);
      let reapResult: ProviderProxySetRecordedContainmentReapResult;
      try {
        reapResult = await this.#reapRecordedContainment(
          capability.setIdentity,
          proof,
          reapingSignal,
          (delivered) => {
            if (!signalsSent.includes(delivered)) signalsSent.push(delivered);
          },
          assertCapabilityCurrent,
        );
      } catch {
        const current = this.#slots.get(providerProxySetKey(capability.setIdentity));
        const authorizationMoved =
          current !== slot ||
          current.attemptToken !== capability.attemptToken ||
          current.operatorExitNotBeforeMonotonicMs !== capability.notBeforeMonotonicMs ||
          current.operatorExitGeneration !== capability.operatorExitGeneration;
        if (authorizationMoved) {
          this.#releaseOperatorExitFence(capability);
          return {
            kind: 'authorization-stale',
            setIdentity: address,
            effect: { signalsSent, containmentAbsent: false, representationAction: 'none' },
          };
        }
        this.#releaseOperatorExitFence(capability);
        return {
          kind: 'containment-unconfirmed',
          setIdentity: address,
          recoveryAction: { kind: 'retry-exact-set-containment' },
          effect: { signalsSent, containmentAbsent: false, representationAction: 'none' },
        };
      }
      const current = this.#slots.get(providerProxySetKey(capability.setIdentity));
      if (
        current !== slot ||
        current.attemptToken !== capability.attemptToken ||
        current.operatorExitNotBeforeMonotonicMs !== capability.notBeforeMonotonicMs ||
        current.operatorExitGeneration !== capability.operatorExitGeneration
      ) {
        this.#releaseOperatorExitFence(capability);
        return {
          kind: 'authorization-stale',
          setIdentity: address,
          effect: {
            signalsSent,
            containmentAbsent: reapResult.kind === 'containment-absent',
            representationAction: 'none',
          },
        };
      }
      if (reapResult.kind === 'recorded-group-unattributable') {
        if (request.behavior === 'boolean-abandon') {
          const decision: ProviderProxySetOperatorAbandonmentDecision = {
            action: 'abandon',
            reason: 'operator_exact_set_abandonment',
            liveClaims: this.#deps.claims.claimsFor(slot.identity).length,
            setIdentity: slot.identity,
          };
          if (slot.kind === 'capsule-recovering') {
            this.#recordOperatorDisposition(decision);
            this.#reportDecision(decision);
          } else {
            this.#recordDecision(slot, decision);
          }
          const abandonmentEvidence: OperatorAbandonmentEvidence = Object.freeze({
            kind: 'operator-abandoned',
            basis: 'recorded-group-unattributable',
            [operatorAbandonmentEvidenceBrand]: true as const,
          });
          return this.#completeOperatorAbandonment({
            slot,
            capability,
            proof,
            request,
            abandonmentEvidence,
            setIdentity: address,
            signalsSent,
            resultForClaimDischarge: (claimDischarge, releaseEffect) => ({
              kind: 'unattributable-group-abandoned',
              setIdentity: address,
              claimDischarge,
              effect: releaseEffect,
            }),
          });
        }
        this.#recordOperatorExitRefusal(slot, 'operator_exit_recorded_group_unattributable', 'operator-abandonment');
        this.#releaseOperatorExitFence(capability);
        return {
          kind: 'recorded-group-unattributable',
          setIdentity: address,
          effect: { signalsSent, containmentAbsent: false, representationAction: 'none' },
        };
      }
      if (reapResult.kind === 'identity-unobservable') {
        if (reapResult.signalDelivered) {
          this.#releaseOperatorExitFence(capability);
          return {
            kind: 'containment-unconfirmed',
            setIdentity: address,
            recoveryAction: { kind: 'retry-exact-set-containment' },
            effect: { signalsSent, containmentAbsent: false, representationAction: 'none' },
          };
        }
        this.#recordOperatorExitRefusal(slot, 'operator_exit_identity_unobservable', 'operator-abandonment');
        this.#releaseOperatorExitFence(capability);
        return {
          kind: 'identity-unobservable',
          setIdentity: address,
          effect: { signalsSent, containmentAbsent: false, representationAction: 'none' },
        };
      }
      if (reapResult.kind === 'signal-authorization-refused') {
        this.#recordOperatorExitRefusal(slot, 'operator_exit_signal_authorization_refused', 'operator-abandonment');
        this.#releaseOperatorExitFence(capability);
        return {
          kind: 'signal-authorization-refused',
          setIdentity: address,
          effect: { signalsSent, containmentAbsent: false, representationAction: 'none' },
        };
      }
      if (reapResult.kind === 'authorization-stale') {
        this.#releaseOperatorExitFence(capability);
        return {
          kind: 'authorization-stale',
          setIdentity: address,
          effect: { signalsSent, containmentAbsent: false, representationAction: 'none' },
        };
      }
      if (reapResult.kind === 'authorization-missing') {
        this.#releaseOperatorExitFence(capability);
        return {
          kind: 'authorization-stale',
          setIdentity: address,
          effect: { signalsSent, containmentAbsent: false, representationAction: 'none' },
        };
      }
      if (reapResult.kind === 'store-unreadable') {
        this.#recordOperatorExitRefusal(slot, 'operator_exit_store_unreadable', 'store-repair');
        this.#releaseOperatorExitFence(capability);
        return {
          kind: 'store-unreadable',
          setIdentity: address,
          effect: { signalsSent, containmentAbsent: false, representationAction: 'none' },
        };
      }
      const { disappearanceReceipt } = reapResult;
      const decision: ProviderProxySetOperatorContainmentDecision = {
        action: 'operator-contain',
        reason: 'operator_exact_set_containment',
        liveClaims: this.#deps.claims.claimsFor(slot.identity).length,
        setIdentity: slot.identity,
      };
      if (slot.kind === 'capsule-recovering') {
        this.#recordOperatorDisposition(decision);
        this.#reportDecision(decision);
      } else {
        this.#recordDecision(slot, decision);
        if (
          (slot.kind === 'reattaching' || slot.kind === 'reattachment-hold') &&
          slot.controlReattachmentWindow !== null
        ) {
          this.#clearControlReattachment(slot, slot.controlReattachmentWindow);
        }
        this.#commitHeldSlotToContainment(slot);
      }
      const releaseObservation: {
        pending: ReleaseDeliveryPendingSlot | null;
        predecessorClaimDischarge: Promise<ProviderProxySetOperatorClaimDischarge> | null;
      } = { pending: null, predecessorClaimDischarge: null };
      const accepted = this.#containmentAbsent(slot.identity, disappearanceReceipt, proof, (pending) => {
        releaseObservation.pending = pending;
        releaseObservation.predecessorClaimDischarge = predecessorClaimDischargeBeforeRelease(
          request.contract,
          pending,
        );
      });
      this.#detachOperatorExitFence(capability);
      const pendingRelease = releaseObservation.pending;
      if (pendingRelease === null) throw new Error('provider_proxy_operator_exit_release_missing');
      const effect: ProviderProxySetOperatorExitEffect = {
        signalsSent,
        containmentAbsent: true,
        representationAction: 'absence-release-started',
      };
      const claimDischarge = await operatorExitClaimDischargeAfterRelease(
        request.contract,
        releaseObservation.predecessorClaimDischarge,
        accepted,
        pendingRelease,
      );
      if (claimDischarge.kind === 'fatal-successor-pending') {
        return this.#completeFatalOperatorExit(pendingRelease, request, effect);
      }
      return {
        kind: 'contained',
        setIdentity: address,
        disappearanceReceipt,
        claimDischarge,
        effect,
      };
    }
    const enforcerVerdict = providerProxySetEnforcerVerdict(evidence.observations);
    if (request.behavior === 'contain') {
      this.#recordOperatorExitRefusal(
        slot,
        `operator_exit_${enforcerVerdict}`,
        'operator-abandonment',
        evidence.observations,
      );
      this.#releaseOperatorExitFence(capability);
      return {
        kind: enforcerVerdict,
        setIdentity: address,
        enforcerObservations: evidence.observations,
        effect: noEffect,
      };
    }

    const decision: ProviderProxySetOperatorAbandonmentDecision = {
      action: 'abandon',
      reason: 'operator_exact_set_abandonment',
      liveClaims: this.#deps.claims.claimsFor(slot.identity).length,
      setIdentity: slot.identity,
    };
    if (slot.kind === 'capsule-recovering') {
      this.#recordOperatorDisposition(decision);
      this.#reportDecision(decision);
    } else {
      this.#recordDecision(slot, decision);
    }
    const abandonmentEvidence: OperatorAbandonmentEvidence = Object.freeze({
      kind: 'operator-abandoned',
      basis: 'enforcer-observations',
      enforcerObservations: evidence.observations,
      [operatorAbandonmentEvidenceBrand]: true as const,
    });
    return this.#completeOperatorAbandonment({
      slot,
      capability,
      proof,
      request,
      abandonmentEvidence,
      setIdentity: address,
      signalsSent: [],
      resultForClaimDischarge: (claimDischarge, releaseEffect) => ({
        kind: 'abandoned',
        setIdentity: address,
        enforcerObservations: evidence.observations,
        claimDischarge,
        effect: releaseEffect,
      }),
    });
  }

  async #completeOperatorAbandonment({
    slot,
    capability,
    proof,
    request,
    abandonmentEvidence,
    setIdentity,
    signalsSent,
    resultForClaimDischarge,
  }: Readonly<{
    slot: EstablishedSlot | CapsuleRecoveringSlot;
    capability: ProviderProxySetOperatorExitCapability;
    proof: ProviderProxySetFencedContainmentProof;
    request: Extract<ProviderProxySetOperatorExitRequest, { behavior: 'abandon' | 'boolean-abandon' }>;
    abandonmentEvidence: OperatorAbandonmentEvidence;
    setIdentity: ProviderProxySetAddress;
    signalsSent: readonly ProviderProxySetContainmentSignal[];
    resultForClaimDischarge: (
      claimDischarge: ProviderProxySetOperatorClaimDischarge,
      effect: ProviderProxySetOperatorExitEffect,
    ) => ProviderProxySetBooleanOperatorExitResult;
  }>): Promise<ProviderProxySetBooleanOperatorExitResult> {
    const commitment = this.#commitOperatorAbandonment(slot, abandonmentEvidence, proof);
    if (commitment.kind === 'held') {
      this.#recordOperatorExitRefusal(slot, 'operator_exit_disposition_store_write_failed', 'store-repair');
      this.#releaseOperatorExitFence(capability);
      return {
        kind: 'store-unreadable',
        setIdentity,
        effect: { signalsSent, containmentAbsent: false, representationAction: 'none' },
      };
    }
    const { pending } = commitment;
    this.#detachOperatorExitFence(capability);
    const predecessorClaimDischarge = predecessorClaimDischargeBeforeRelease(request.contract, pending);
    this.#beginRepresentationRelease(pending);
    const releaseEffect: ProviderProxySetOperatorExitEffect = {
      signalsSent,
      containmentAbsent: false,
      representationAction: 'abandonment-release-started',
    };
    const claimDischarge = await operatorExitClaimDischargeAfterRelease(
      request.contract,
      predecessorClaimDischarge,
      pending.initialDisposition,
      pending,
    );
    if (claimDischarge.kind === 'fatal-successor-pending') {
      return this.#completeFatalOperatorExit(pending, request, releaseEffect);
    }
    return resultForClaimDischarge(claimDischarge, releaseEffect);
  }

  #beginRepresentationRelease(slot: ReleaseDeliveryPendingSlot): void {
    if (slot.pendingOperations.size === 0) {
      this.#startRetirement(slot);
      return;
    }
    for (const operation of slot.pendingOperations.values()) this.#deliverRepresentationRelease(slot, operation);
  }

  #completeFatalOperatorExit(
    slot: ReleaseDeliveryPendingSlot,
    request: ProviderProxySetOperatorExitRequest,
    effect: ProviderProxySetOperatorExitEffect,
  ): ProviderProxySetBooleanOperatorExitResult {
    if (request.behavior !== 'abandon') {
      return { kind: 'representation-release-abandonment-required', setIdentity: slot.address, effect };
    }
    this.#acceptFatalRepresentationReleaseSuccessor(slot);
    return {
      kind: 'representation-release-abandoned',
      setIdentity: slot.address,
      successor: { owner: 'operator-command', acceptance: 'accepted' },
      effect: { ...effect, representationAction: 'fatal-release-abandoned' },
    };
  }

  containmentAbsent(identity: ProviderProxySetIdentity, disappearanceReceipt: string): ContainmentAbsenceAcceptance {
    return this.#containmentAbsent(identity, disappearanceReceipt, null);
  }

  #containmentAbsent(
    identity: ProviderProxySetIdentity,
    disappearanceReceipt: string,
    mutationProof: ProviderProxySetFencedContainmentProof | null,
    onReleaseCommitted?: (slot: ReleaseDeliveryPendingSlot) => void,
  ): ContainmentAbsenceAcceptance {
    const processEvidence = this.#processContainmentEvidence(disappearanceReceipt);
    const commit = this.#commitContainmentAbsence(identity, processEvidence, mutationProof);
    if (commit.kind === 'unchanged') {
      onReleaseCommitted?.(commit.pending);
      return this.#absenceAcceptance(commit.pending);
    }
    const { pending, authoritiesToClose } = commit;
    this.#report(
      'info',
      `Provider proxy containment disappeared set=${providerProxySetReference(pending.identity)} receipt=${JSON.stringify(disappearanceReceipt).slice(1, -1)}`,
    );

    for (const authority of authoritiesToClose) {
      // Deferred to confirmed absence rather than the containment attempt's own start: a `stop-and-reap`
      // decision keeps its heartbeat lease live for as long as the guardian commit is unconfirmed, so a
      // retry always has a current lease to commit against instead of one this coordinator tore down itself.
      authority.stopHeartbeats();
      void authority
        .initiateControlClose()
        .catch((error: unknown) =>
          this.#deps.onError?.(
            `Provider proxy control close after containment failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
    }
    onReleaseCommitted?.(pending);
    this.#beginRepresentationRelease(pending);
    return this.#absenceAcceptance(pending);
  }

  #releaseOperatorExitFence(capability: ProviderProxySetOperatorExitCapability): void {
    this.#detachOperatorExitFence(capability);
    releaseProviderProxySetContainmentProofFence(capability.containmentProofAuthorization);
  }

  #detachOperatorExitFence(capability: ProviderProxySetOperatorExitCapability): void {
    const key = providerProxySetKey(capability.setIdentity);
    if (this.#operatorExitFenceAuthorizations.get(key) === capability.containmentProofAuthorization) {
      this.#operatorExitFenceAuthorizations.delete(key);
    }
  }

  #absenceAcceptance(slot: AbsenceDeliveryPendingSlot): ContainmentAbsenceAcceptance {
    return {
      kind: 'accepted',
      disappearanceReceipt: slot.releaseEvidence.receipt,
      initialDisposition: slot.initialDisposition.promise,
      get initialDispositionState() {
        return slot.initialDisposition.state;
      },
    };
  }

  #processContainmentEvidence(disappearanceReceipt: string): ProcessContainmentEvidence {
    if (typeof disappearanceReceipt !== 'string' || disappearanceReceipt.length === 0) {
      throw new Error('provider_proxy_containment_absence_receipt_invalid');
    }
    return Object.freeze({
      kind: 'containment-absent',
      receipt: disappearanceReceipt,
    }) as ProcessContainmentEvidence;
  }

  #noLiveClaimsDischarge(identity: ProviderProxySetIdentity): DurableClaimDischarge {
    if (this.#deps.claims.claimsFor(identity).length !== 0) {
      throw new Error('provider_proxy_no_live_claims_discharge_with_live_claims');
    }
    return this.#durableClaimDischarge([]);
  }

  #durableClaimDischarge(operations: readonly OperationIdentity[]): DurableClaimDischarge {
    return Object.freeze({
      kind: 'claims-discharged',
      operations: Object.freeze([...operations]),
    }) as DurableClaimDischarge;
  }

  #providerProxySetDischarge(slot: ReleaseDeliveryPendingSlot): ProviderProxySetDischarge {
    if (slot.claimOperations.length === 0) {
      slot.claimDischarge = this.#noLiveClaimsDischarge(slot.identity);
    }
    if (slot.claimDischarge === null) throw new Error('provider_proxy_claim_discharge_missing');
    return slot.kind === 'absence-delivery-pending'
      ? (Object.freeze({
          kind: 'evidence-backed',
          process: slot.releaseEvidence,
          claims: slot.claimDischarge,
        }) as ProviderProxySetDischarge)
      : (Object.freeze({
          kind: 'operator-abandoned',
          abandonment: slot.releaseEvidence,
          claims: slot.claimDischarge,
        }) as ProviderProxySetDischarge);
  }

  #pendingReleaseFields(
    slot:
      | Pick<PendingReleaseSlot, 'key' | 'identity' | 'address' | 'capacityClass' | 'capsulePath' | 'authority'>
      | EstablishedSlot
      | CapsuleRecoveringSlot
      | Extract<ProviderProxySetSlot, { kind: 'recovering' }>,
    mutationProof: ProviderProxySetFencedContainmentProof | null,
  ): Omit<ReleaseDeliveryPendingSlot, 'kind' | 'releaseEvidence' | 'routeKey'> {
    const claimOperations = this.#deps.claims.claimsFor(slot.identity).map((claim) => claim.operation);
    const pendingOperations = new Map(claimOperations.map((operation) => [operationKey(operation), operation]));
    let settleRepresentationRelease!: (disposition: ProviderProxyRepresentationReleaseSettlement) => void;
    const representationReleaseSettlement = new Promise<ProviderProxyRepresentationReleaseSettlement>((resolve) => {
      settleRepresentationRelease = resolve;
    });
    const shared = {
      key: slot.key,
      identity: slot.identity,
      address: slot.address,
      capacityClass: slot.capacityClass,
      authority: 'authority' in slot ? slot.authority : null,
      claimOperations,
      claimDischarge: claimOperations.length === 0 ? this.#noLiveClaimsDischarge(slot.identity) : null,
      pendingOperations,
      initialDeliveries: new Map(
        [...pendingOperations.keys()].map((key) => [key, { kind: 'initial-pending' } as const]),
      ),
      deliveryRetryTimers: new Map<string, TimerHandle>(),
      capsulePath: slot.capsulePath,
      retirementState: 'not-ready' as const,
      retirementTimer: null,
      initialDisposition: createInitialDispositionLatch(),
      representationReleaseSettlement,
      settleRepresentationRelease,
      fatalSettlement: null,
      operatorExitNotBeforeMonotonicMs: null,
      operatorExitGeneration: 0,
      attemptToken: 0,
      mutationProof,
    };
    return shared;
  }

  #commitContainmentAbsence(
    identity: ProviderProxySetIdentity,
    processEvidence: ProcessContainmentEvidence,
    mutationProof: ProviderProxySetFencedContainmentProof | null,
  ): ContainmentAbsenceCommit {
    const key = providerProxySetKey(identity);
    const slot = this.#slots.get(key);
    if (slot === undefined) throw new Error('provider_proxy_containment_absence_slot_missing');
    if (
      slot.kind === 'acquiring' ||
      slot.kind === 'capsule-foreign' ||
      !providerProxySetIdentitiesEqual(slot.identity, identity)
    ) {
      throw new Error('provider_proxy_containment_absence_identity_mismatch');
    }
    if (slot.kind === 'absence-delivery-pending') {
      if (mutationProof !== null && mutationProof !== slot.mutationProof) {
        releaseProviderProxySetContainmentProofFence(mutationProof);
      }
      if (slot.releaseEvidence.receipt !== processEvidence.receipt) {
        throw new Error('provider_proxy_containment_absence_conflict');
      }
      return { kind: 'unchanged', pending: slot };
    }
    if (slot.kind === 'abandonment-delivery-pending') {
      throw new Error('provider_proxy_containment_absence_after_abandonment');
    }
    if (slot.kind === 'available' || slot.kind === 'draining') {
      throw new Error('provider_proxy_containment_absence_before_authority_fault');
    }
    if (slot.kind === 'recovering' && slot.recoveryKind === 'acquisition-publication') {
      throw new Error('provider_proxy_containment_absence_before_acquisition_control_release');
    }

    const pending: Extract<ProviderProxySetSlot, { kind: 'absence-delivery-pending' }> = {
      ...this.#pendingReleaseFields(slot, mutationProof),
      kind: 'absence-delivery-pending',
      releaseEvidence: processEvidence,
      routeKey: slot.kind === 'recovering' ? null : slot.routeKey,
    };
    if (slot.kind === 'capsule-recovering') {
      slot.attemptToken += 1;
      slot.attemptAbort?.abort();
      if (slot.retryTimer !== null) this.#deps.time.clearTimeout(slot.retryTimer);
    } else if (slot.kind !== 'recovering') {
      slot.attemptToken += 1;
      slot.containmentAttemptAbort?.abort(new Error('provider_proxy_containment_released'));
      slot.containmentAttemptAbort = null;
      if (slot.retryTimer !== null) this.#deps.time.clearTimeout(slot.retryTimer);
    }
    const authoritiesToClose =
      slot.kind === 'recovering' || slot.kind === 'capsule-recovering'
        ? []
        : slot.containmentAuthority === null
          ? [slot.authority]
          : [slot.authority, slot.containmentAuthority];
    this.#slots.set(key, pending);
    return { kind: 'committed', pending, authoritiesToClose };
  }

  #commitOperatorAbandonment(
    slot: EstablishedSlot | CapsuleRecoveringSlot,
    abandonmentEvidence: OperatorAbandonmentEvidence,
    mutationProof: ProviderProxySetFencedContainmentProof | null,
  ):
    | Readonly<{ kind: 'committed'; pending: Extract<ProviderProxySetSlot, { kind: 'abandonment-delivery-pending' }> }>
    | Readonly<{ kind: 'held'; recording: Extract<ProviderProxySetOperatorDispositionRecording, { kind: 'held' }> }> {
    const recording = this.#retireDurableSetDispositionsAfterOperatorAbandonment(slot.identity, abandonmentEvidence);
    this.#trackDurableSetDispositionWrite(slot.identity, recording);
    if (recording.kind === 'held') return { kind: 'held', recording };
    const pending: Extract<ProviderProxySetSlot, { kind: 'abandonment-delivery-pending' }> = {
      ...this.#pendingReleaseFields(slot, mutationProof),
      kind: 'abandonment-delivery-pending',
      releaseEvidence: abandonmentEvidence,
      routeKey: slot.routeKey,
    };
    slot.attemptToken += 1;
    if (slot.kind === 'capsule-recovering') {
      slot.attemptAbort?.abort(new Error('provider_proxy_containment_abandoned'));
      slot.attemptAbort = null;
      if (slot.retryTimer !== null) this.#deps.time.clearTimeout(slot.retryTimer);
    } else {
      slot.containmentAttemptAbort?.abort(new Error('provider_proxy_containment_abandoned'));
      slot.containmentAttemptAbort = null;
      if (slot.controlReattachmentWindow !== null) this.#clearControlReattachment(slot, slot.controlReattachmentWindow);
      if (slot.retryTimer !== null) this.#deps.time.clearTimeout(slot.retryTimer);
      this.#removeRoute(slot);
      slot.authority.stopHeartbeats();
      if (slot.containmentAuthority !== null) {
        slot.containmentAuthority.stopHeartbeats();
        void slot.containmentAuthority.initiateControlClose().catch((error: unknown) => {
          this.#deps.onError?.(`Partial provider proxy control close failed: ${singleLineErrorSummary(error)}`);
        });
      }
    }
    this.#slots.set(slot.key, pending);
    return { kind: 'committed', pending };
  }

  snapshot(): ProviderProxySetLifecycleSnapshot {
    const slots = [...this.#slots.values()];
    const durableSets = new Map<
      ProviderProxySetKey,
      Readonly<{
        identity: ProviderProxySetIdentity;
        dispositions: Map<string, ProviderProxySetOperatorDisposition>;
      }>
    >();
    for (const record of this.#durableOperatorDispositions.values()) {
      const setKey = providerProxySetKey(record.setIdentity);
      const current = durableSets.get(setKey) ?? { identity: record.setIdentity, dispositions: new Map() };
      const durableObservation: NonNullable<ProviderProxySetOperatorDisposition['durableObservation']> =
        record.status.kind === 'stale'
          ? {
              kind: 'stale',
              writerIncarnation: record.writerIncarnation,
              reobserveAction: 'automatic-exact-set-containment-observation',
            }
          : record.status.kind === 'current-writer'
            ? { kind: 'current-writer', writerIncarnation: record.writerIncarnation }
            : {
                kind: 'successor-observed',
                writerIncarnation: record.writerIncarnation,
                observedByIncarnation: record.status.observedByIncarnation,
              };
      const disposition =
        record.status.kind === 'successor-observed' && record.status.evidence.kind !== 'canonical-hold-observation'
          ? {
              disposition: 'held' as const,
              incidentReason:
                record.status.reapOutcome !== undefined
                  ? `exact set containment re-observation ended ${record.status.reapOutcome.kind}`
                  : record.status.evidence.kind === 'store-unreadable'
                    ? 'exact set containment store is unreadable'
                    : 'exact set containment enforcers were re-observed without decisive absence',
              waitingFor:
                record.status.evidence.kind === 'store-unreadable'
                  ? ('store-repair' as const)
                  : ('independent-containment-absence' as const),
              ...(record.status.evidence.kind === 'enforcers-observed'
                ? { enforcerObservations: record.status.evidence.observations }
                : {}),
              durableObservation,
            }
          : { ...record.disposition, durableObservation };
      current.dispositions.set(record.subjectKey, disposition);
      durableSets.set(setKey, current);
    }
    for (const [setKey, held] of this.#heldDurableSetDispositionWrites) {
      const current = durableSets.get(setKey) ?? { identity: held.identity, dispositions: new Map() };
      current.dispositions.set(OPERATOR_DISPOSITION_STORE_REPAIR_SUBJECT, {
        disposition: 'held',
        incidentReason: held.reason,
        waitingFor: 'store-repair',
      });
      durableSets.set(setKey, current);
    }
    for (const [setKey, dispositions] of this.#operatorDispositions) {
      const slot = this.#slots.get(setKey);
      if (slot === undefined || slot.kind === 'acquiring' || slot.kind === 'capsule-foreign') continue;
      const durable = durableSets.get(setKey);
      if (durable === undefined) {
        durableSets.set(setKey, { identity: slot.identity, dispositions: new Map(dispositions) });
      } else {
        for (const [subjectKey, disposition] of dispositions) durable.dispositions.set(subjectKey, disposition);
      }
    }
    const operatorDispositions = [...durableSets.values()].flatMap(({ dispositions }) => [...dispositions.values()]);
    const operatorSets: ProviderProxySetOperatorStatus[] = [...durableSets].map(([key, { identity, dispositions }]) => {
      const slot = this.#slots.get(key);
      const setIdentity = providerProxySetAddress(identity);
      return {
        setIdentity,
        setToken: encodeProviderProxySetAddress(setIdentity),
        liveClaims: this.#deps.claims.claimsFor(identity).length,
        operatorExit:
          slot === undefined || slot.kind === 'acquiring' || slot.kind === 'capsule-foreign'
            ? { kind: 'none' as const }
            : this.#operatorExit(slot, dispositions),
        holds: [...dispositions.values()],
      };
    });
    for (const record of this.#durableAcquisitionDispositions.values()) {
      const durableObservation: NonNullable<ProviderProxySetOperatorDisposition['durableObservation']> =
        record.status.kind === 'stale'
          ? {
              kind: 'stale',
              writerIncarnation: record.writerIncarnation,
              reobserveAction: 'automatic-exact-acquisition-containment-observation',
            }
          : record.status.kind === 'successor-acquisition-observed'
            ? {
                kind: 'successor-observed',
                writerIncarnation: record.writerIncarnation,
                observedByIncarnation: record.status.observedByIncarnation,
              }
            : { kind: 'current-writer', writerIncarnation: record.writerIncarnation };
      const disposition = this.#heldAcquisitionDispositionWrites.has(record.key)
        ? {
            ...record.disposition,
            incidentReason: 'provider proxy acquisition disposition persistence remains held',
            waitingFor: 'store-repair' as const,
          }
        : { ...record.disposition, durableObservation };
      operatorDispositions.push(disposition);
      const addressKey = providerProxySetAddressKey(record.setAddress);
      const representedIndex = operatorSets.findIndex(
        ({ setIdentity }) => providerProxySetAddressKey(setIdentity) === addressKey,
      );
      if (representedIndex >= 0) {
        const represented = operatorSets[representedIndex];
        if (represented !== undefined) {
          operatorSets[representedIndex] = { ...represented, holds: [...represented.holds, disposition] };
        }
        continue;
      }
      operatorSets.push({
        setIdentity: record.setAddress,
        setToken: encodeProviderProxySetAddress(record.setAddress),
        liveClaims: 0,
        operatorExit: { kind: 'abandon' },
        holds: [disposition],
      });
    }
    return {
      startupDiscoveryCompleted: this.#startupDiscoveryCompleted,
      represented: slots.length,
      available: slots.filter((slot) => slot.kind === 'available').length,
      states: slots.map((slot) => slot.kind),
      pendingOperationCounts: slots.flatMap((slot) =>
        slot.kind === 'absence-delivery-pending' || slot.kind === 'abandonment-delivery-pending'
          ? [slot.pendingOperations.size]
          : [],
      ),
      operatorDispositions,
      operatorSets,
      skippedDurableOperatorDispositions: this.#skippedDurableOperatorDispositions,
    };
  }

  #installDiscoveredCapsule(path: string, capsule: HandoffCapsule, observe: RecordedProcessObserver): void {
    const address: ProviderProxySetAddress = {
      buildSetId: capsule.buildSetId,
      hostFingerprint: capsule.hostFingerprint,
      proxyInstanceId: capsule.proxyInstanceId,
    };
    const addressKey = providerProxySetAddressKey(address);
    const duplicatePath = this.#capsuleAddresses.get(addressKey);
    if (duplicatePath !== undefined && duplicatePath !== path) {
      throw new Error('provider_proxy_capsule_address_alias');
    }
    const duplicateGrantPath = this.#capsuleGrants.get(capsule.grantId);
    if (duplicateGrantPath !== undefined && duplicateGrantPath !== path) {
      throw new Error('provider_proxy_capsule_grant_alias');
    }
    this.#capsuleAddresses.set(addressKey, path);
    this.#capsuleGrants.set(capsule.grantId, path);

    // Decided before anything is attached to a claim, because a capsule that names a durable operation is
    // exactly the capsule an upgrade finds, and attaching it is what makes it get dialed.
    //
    // Reaching a role is what makes an un-inheritable capsule fatal rather than merely useless.
    // `handoff.redeem` is gated on build identity (`assertNamedCoordinatorBuild`), so a foreign set answers
    // `identity_mismatch`; the recovery policy reads that as `refused`, and `refused` retires fatally
    // *before* any seam can weigh the absence evidence gathered beside it — taking this whole coordinator
    // down over a set it never owned.
    //
    // A V2 capsule is the same problem from the other side: this build can reach it, but its process
    // identity is in seconds it can no longer verify, and carrying those numbers into a token would make a
    // live process read as absent.
    const classified = this.#classifyCapsule(capsule);
    const uninheritable = classified.kind === 'uninheritable' ? classified.reason : null;

    // The decision must precede the claim lookup: a capsule whose every recorded process is provably gone is
    // retirable whether or not a claim names its address, and deciding later would leave it on disk for every
    // subsequent boot to rediscover and re-observe.
    const retirable = classified.kind === 'uninheritable' && recordedProcessesAllAbsent(capsule, observe);
    // An operator reading a representation warning must be able to tell a capsule that is about to vanish
    // from one that will sit represented for the whole boot.
    const retirementNote = retirable
      ? ' Every process it records is provably absent, so automatic retirement is being attempted.'
      : '';

    const claimKey = this.#identityIndex.keyForAddress(address);
    if (claimKey !== null) {
      const claimSlot = this.#slots.get(claimKey);
      if (
        claimSlot?.kind !== 'recovering' ||
        claimSlot.recoveryKind !== 'claim' ||
        !providerProxySetCapsuleMatchesIdentity(capsule, claimSlot.identity)
      ) {
        throw new Error('provider_proxy_capsule_claim_identity_mismatch');
      }
      if (claimSlot.capsulePath !== null && claimSlot.capsulePath !== path) {
        throw new Error('provider_proxy_capsule_claim_path_alias');
      }
      if (uninheritable !== null) {
        // Leave `capsulePath` null — the same state a claim reaches when no capsule was found at all, which
        // resolves through containment proof rather than redemption. Naming the path here is precisely what
        // hands this credential to a redemption that must be refused.
        this.#deps.reportLifecycle(
          'warn',
          `Provider proxy capsule at ${path} names a claimed set but is not inheritable (${uninheritable}); the claim will resolve without it.${retirementNote}`,
        );
        if (retirable) {
          this.#beginForeignCapsuleRetirement({
            capsulePath: path,
            addressKey,
            grantId: capsule.grantId,
            foreignSlotId: null,
          });
        }
        return;
      }
      claimSlot.capsulePath = path;
      return;
    }

    // Unclaimed and un-inheritable: the slot exists so the address stays represented and cannot be aliased.
    if (classified.kind === 'uninheritable') {
      const slotId = `capsule-${this.#nextSlotId++}`;
      this.#slots.set(slotId, {
        kind: 'capsule-foreign',
        slotId,
        capsulePath: path,
        address,
        capacityClass: 'retained',
        reason: classified.reason,
      });
      this.#deps.reportLifecycle(
        'warn',
        `Provider proxy capsule at ${path} is represented but not inheritable (${classified.reason}).${retirementNote}`,
      );
      if (retirable) {
        this.#beginForeignCapsuleRetirement({
          capsulePath: path,
          addressKey,
          grantId: capsule.grantId,
          foreignSlotId: slotId,
        });
      }
      return;
    }
    const inheritable = classified.capsule;

    const identity = providerProxySetIdentityFromCapsule(inheritable);
    const key = this.#identityIndex.add(identity);
    if (this.#slots.has(key)) throw new Error('provider_proxy_capsule_exact_identity_alias');
    const recovering: CapsuleRecoveringSlot = {
      kind: 'capsule-recovering',
      key,
      identity,
      capsulePath: path,
      capsuleBinding: inheritable,
      address,
      capacityClass: 'retained',
      completedAttempts: 0,
      retryTimer: null,
      attemptToken: 0,
      attemptAbort: null,
      recoveryPhase: 'redemption',
      routeKey: null,
      acquisitionCleanupHold: null,
      operatorExitNotBeforeMonotonicMs: null,
      operatorExitObservedGate: null,
      operatorExitGeneration: 0,
    };
    this.#slots.set(key, recovering);
    this.#armObservedOperatorExitGate(recovering);
  }

  /**
   * A `foreignSlotId` must name a slot that is already installed: completing a retirement deletes that slot,
   * so an owner registered before the install would leave the representation of a capsule that is gone
   * standing for the rest of the boot.
   */
  #beginForeignCapsuleRetirement(registration: Omit<ForeignCapsuleRetirementOwner, 'failures' | 'retryTimer'>): void {
    const owner: ForeignCapsuleRetirementOwner = { ...registration, failures: null, retryTimer: null };
    this.#foreignRetirementOwners.set(owner.capsulePath, owner);
    this.#attemptForeignCapsuleRetirement(owner);
  }

  /**
   * One turn per attempt. A turn is spent by its first non-evidence observation, so a bounded retry that
   * reused one would make every attempt after the first unobservable.
   */
  #attemptForeignCapsuleRetirement(owner: ForeignCapsuleRetirementOwner): void {
    // A callback that outlives its owner must not act: the map entry is the only thing that says this turn is
    // still the one this build is running for this path.
    const stillOwned = (): boolean => this.#foreignRetirementOwners.get(owner.capsulePath) === owner;
    const turn = this.#deps.recoveryDispatcher.begin(
      'foreign-capsule-retirement',
      {},
      {
        evidence: () => {
          if (stillOwned()) this.#completeForeignCapsuleRetirement(owner);
        },
        retry: (retry) => {
          if (!stillOwned()) return;
          this.#recordForeignRetirementFailure(
            owner,
            retry.incident as ProviderProxyForeignCapsuleRetirementRetryIncident,
          );
        },
        // Nothing observed on this seam may finalize anything, and a turn that ends in a fatal can no longer
        // settle this path — but the hold must still end where an operator can read it.
        fatal: (error) => {
          if (!stillOwned()) return;
          this.#abandonForeignCapsuleRetirement(owner, { kind: 'forwarded-fatal', error });
        },
      },
    );
    turn.start({
      sourceId: 'foreign-retirement',
      producerId: 'capsule-retirement',
      input: { path: owner.capsulePath },
    });
  }

  /**
   * Removes exactly what named this capsule path and nothing else. A recovering claim, its identity-index
   * entry, and every absence slot belong to owners this turn never held — a foreign retirement that released
   * one would strand the operations behind it.
   *
   * Releasing an alias entry is housekeeping for the discovery pass that installed it. Nothing may be given a
   * reason to read those maps after that pass, because it would be depending on a release that an abandoned
   * retirement never makes.
   */
  #completeForeignCapsuleRetirement(owner: ForeignCapsuleRetirementOwner): void {
    this.#dropForeignRetirementOwner(owner);
    // Every release is conditioned on the entry still naming this owner's path: an entry a later capsule
    // installed under the same key belongs to that capsule, and dropping it would surrender a credential this
    // build is still representing.
    if (this.#capsuleAddresses.get(owner.addressKey) === owner.capsulePath) {
      this.#capsuleAddresses.delete(owner.addressKey);
    }
    if (this.#capsuleGrants.get(owner.grantId) === owner.capsulePath) {
      this.#capsuleGrants.delete(owner.grantId);
    }
    if (owner.foreignSlotId === null) return;
    const slot = this.#slots.get(owner.foreignSlotId);
    if (slot?.kind === 'capsule-foreign' && slot.capsulePath === owner.capsulePath) {
      this.#slots.delete(owner.foreignSlotId);
    }
  }

  /**
   * Buys a bounded amount of time for a filesystem that may recover. The last failure must reach the terminal
   * rather than another wait: a hold no reachable event can clear is an obligation nobody can discharge.
   */
  #recordForeignRetirementFailure(
    owner: ForeignCapsuleRetirementOwner,
    incident: ProviderProxyForeignCapsuleRetirementRetryIncident,
  ): void {
    const failures = { count: (owner.failures?.count ?? 0) + 1, lastIncident: incident };
    owner.failures = failures;
    if (owner.retryTimer !== null) this.#deps.time.clearTimeout(owner.retryTimer);
    owner.retryTimer = null;

    if (failures.count >= FOREIGN_CAPSULE_RETIREMENT_ATTEMPT_LIMIT) {
      this.#abandonForeignCapsuleRetirement(owner, {
        kind: 'attempt-limit',
        attempts: failures.count,
        incident: failures.lastIncident,
      });
      return;
    }

    const timer = this.#deps.time.setTimeout(() => {
      owner.retryTimer = null;
      if (this.#foreignRetirementOwners.get(owner.capsulePath) !== owner) return;
      this.#attemptForeignCapsuleRetirement(owner);
    }, retryDelayMs(failures.count));
    timer.unref?.();
    owner.retryTimer = timer;
  }

  /**
   * The hold ends here with the capsule still on disk, so whatever was observed last must reach an operator:
   * a refusal nobody can read is a credential nobody knows to remove. A named exit may not be suppressible,
   * so this warning may not be routed through the preserve-report throttle.
   */
  #abandonForeignCapsuleRetirement(
    owner: ForeignCapsuleRetirementOwner,
    abandonment: ForeignCapsuleRetirementAbandonment,
  ): void {
    this.#dropForeignRetirementOwner(owner);
    this.#report(
      'warn',
      `Provider proxy capsule at ${owner.capsulePath} names only processes proven absent but could not be retired ${renderForeignRetirementAbandonment(abandonment)}; it stays represented for the rest of this boot, and a later boot retries it only while discovery still finds it and can still prove its recorded processes absent.`,
    );
  }

  /**
   * The map entry is the ownership token, so only the owner it names may retract it: retracting by path alone
   * would make a hold's end depend on which turn happened to settle last.
   */
  #dropForeignRetirementOwner(owner: ForeignCapsuleRetirementOwner): void {
    if (owner.retryTimer !== null) this.#deps.time.clearTimeout(owner.retryTimer);
    owner.retryTimer = null;
    if (this.#foreignRetirementOwners.get(owner.capsulePath) === owner) {
      this.#foreignRetirementOwners.delete(owner.capsulePath);
    }
  }

  #classifyCapsule(capsule: HandoffCapsule): CapsuleInheritance {
    const verdict = classifyProviderProxySetInheritance(capsule, this.#deps.buildSetId);
    return verdict.kind === 'refused'
      ? { kind: 'uninheritable', reason: verdict.reason }
      : { kind: 'inheritable', capsule: verdict.candidate };
  }

  #runAcquisitionPublicationRetry(
    slot: Extract<ProviderProxySetSlot, { kind: 'recovering'; recoveryKind: 'acquisition-publication' }>,
  ): void {
    if (this.#slots.get(slot.key) !== slot) return;
    slot.attemptToken += 1;
    const token = slot.attemptToken;
    void retryProviderProxyAcquisitionPublication(slot.session).then(
      (publication) => {
        if (this.#slots.get(slot.key) !== slot || slot.attemptToken !== token) return;
        if (publication.kind === 'published') {
          slot.unsubscribeFault?.();
          slot.unsubscribeFault = null;
          if (slot.retryTimer !== null) this.#deps.time.clearTimeout(slot.retryTimer);
          let established;
          try {
            established = establishProviderProxyAcquisitionSession(
              slot.session,
              publication.receipt,
              slot.decorateAuthority,
            );
          } catch (error: unknown) {
            this.#releaseAcquisitionPublicationSession(slot, error);
            return;
          }
          this.#deleteOperatorDispositions(slot.identity);
          this.#establish(established.set, established.publicationReceipt, slot.routeKey, slot.capsulePath, 'serve');
          return;
        }
        if (publication.kind === 'not-attempted') {
          this.#releaseAcquisitionPublicationSession(
            slot,
            `provider_proxy_acquisition_publication_refused:${publication.role}:${publication.reason}`,
          );
          return;
        }
        this.#holdAcquisitionPublicationSession(slot, publication.reason);
      },
      (error: unknown) => {
        if (this.#slots.get(slot.key) === slot && slot.attemptToken === token) {
          this.#holdAcquisitionPublicationSession(slot, errorMessage(error));
        }
      },
    );
  }

  async #retryAcquisitionPublicationCleanup(
    slot: Extract<ProviderProxySetSlot, { kind: 'recovering'; recoveryKind: 'acquisition-publication' }>,
    signal: AbortSignal,
  ): Promise<ProviderProxySetAcquisitionCleanupOutcome> {
    if (signal.aborted) return { kind: 'held', reason: 'publication recovery retry was cancelled' };
    const current = this.#slots.get(slot.key);
    if (current === undefined) {
      return { kind: 'held', reason: 'publication recovery ownership could not be observed' };
    }
    if (providerProxySetSlotIsLive[current.kind]) {
      return { kind: 'delegated', owner: 'provider-proxy-set-lifecycle' };
    }
    if (current === slot) {
      if (slot.retryTimer !== null) this.#deps.time.clearTimeout(slot.retryTimer);
      slot.retryTimer = null;
      this.#runAcquisitionPublicationRetry(slot);
      return { kind: 'held', reason: 'publication confirmation remains pending' };
    }
    return { kind: 'held', reason: `provider proxy set recovery remains ${current.kind}` };
  }

  #holdAcquisitionPublicationSession(
    slot: Extract<ProviderProxySetSlot, { kind: 'recovering'; recoveryKind: 'acquisition-publication' }>,
    reason: string,
  ): void {
    if (this.#slots.get(slot.key) !== slot) return;
    slot.completedAttempts += 1;
    const incident = singleLineErrorSummary(reason);
    this.#setOperatorDispositions(
      slot.identity,
      new Map([
        [
          operatorDispositionSubjectKey('acquisition-publication'),
          {
            disposition: 'held',
            attempts: slot.completedAttempts,
            incidentReason: incident,
            waitingFor: 'publication-confirmation-or-control-release',
          },
        ],
      ]),
    );
    if (slot.completedAttempts >= ACQUISITION_PUBLICATION_ATTEMPT_LIMIT) {
      this.#releaseAcquisitionPublicationSession(
        slot,
        `provider_proxy_acquisition_publication_retry_exhausted:${incident}`,
      );
      return;
    }
    const delayMs = retryDelayMs(slot.completedAttempts);
    const requestedWakeMs = this.#deps.time.now() + delayMs;
    slot.retryTimer = this.#deps.time.setTimeout(() => {
      slot.retryTimer = null;
      this.#recordLateness('acquisition-publication-retry', requestedWakeMs);
      this.#runAcquisitionPublicationRetry(slot);
    }, delayMs);
    slot.retryTimer.unref?.();
  }

  #releaseAcquisitionPublicationSession(
    slot: Extract<ProviderProxySetSlot, { kind: 'recovering'; recoveryKind: 'acquisition-publication' }>,
    reason: unknown,
  ): void {
    if (this.#slots.get(slot.key) !== slot) return;
    slot.attemptToken += 1;
    slot.unsubscribeFault?.();
    slot.unsubscribeFault = null;
    if (slot.retryTimer !== null) this.#deps.time.clearTimeout(slot.retryTimer);
    const closed = closeProviderProxyAcquisitionSession(slot.session, singleLineErrorSummary(reason));
    const recovering: Extract<ProviderProxySetSlot, { kind: 'capsule-recovering' }> = {
      kind: 'capsule-recovering',
      key: slot.key,
      identity: slot.identity,
      capsulePath: slot.capsulePath,
      capsuleBinding: slot.capsuleBinding,
      address: slot.address,
      capacityClass: slot.capacityClass,
      completedAttempts: 0,
      retryTimer: null,
      attemptToken: 0,
      attemptAbort: null,
      recoveryPhase: 'redemption',
      routeKey: slot.routeKey,
      acquisitionCleanupHold: slot.acquisitionCleanupHold,
      operatorExitNotBeforeMonotonicMs: null,
      operatorExitObservedGate: null,
      operatorExitGeneration: 0,
    };
    this.#slots.set(slot.key, recovering);
    this.#armObservedOperatorExitGate(recovering);
    this.#setOperatorDispositions(
      slot.identity,
      new Map([
        [
          operatorDispositionSubjectKey('acquisition-publication'),
          {
            disposition: 'held',
            incidentReason: closed.reason,
            waitingFor: 'control-reattachment',
          },
        ],
      ]),
    );
    this.#recoverExactCapsule(recovering);
  }

  #recoverExactCapsule(slot: Extract<ProviderProxySetSlot, { kind: 'capsule-recovering' }>): void {
    if (this.#slots.get(slot.key) !== slot || slot.recoveryPhase !== 'redemption') return;
    const dispatcher = this.#deps.recoveryDispatcher;
    slot.attemptToken += 1;
    const token = slot.attemptToken;
    const abort = new AbortController();
    slot.attemptAbort = abort;
    const turn = dispatcher.begin(
      'exact-capsule-recovery',
      { setIdentity: slot.identity, capsule: slot.capsuleBinding },
      {
        evidence: (value, sourceId) => {
          if (this.#slots.get(slot.key) !== slot || slot.attemptToken !== token) {
            this.#releaseLateReattachmentEvidence(value, sourceId);
            return;
          }
          if (sourceId === 'redemption') {
            abort.abort();
            slot.attemptAbort = null;
            const outcome = value as Exclude<ProviderProxySetRedemptionOutcome, { kind: 'temporarily-unavailable' }>;
            if (outcome.kind === 'protocol-incompatible') {
              this.#dispositionProtocolIncompatibleCapsule(slot, outcome.role, outcome.method);
              return;
            }
            this.#slots.delete(slot.key);
            this.#identityIndex.delete(slot.identity);
            this.#deleteOperatorDispositions(slot.identity);
            this.#establish(
              outcome.set,
              outcome.publicationReceipt,
              slot.routeKey,
              slot.capsulePath,
              slot.routeKey === null ? 'contain-unclaimed-discovery' : 'serve',
              outcome.protection,
            );
            return;
          }
          const proof = value as ProviderProxySetFencedContainmentProof;
          const evidence = providerProxySetContainmentEvidenceFor(proof, slot.identity);
          if (evidence.kind !== 'reap-required') {
            releaseProviderProxySetContainmentProofFence(proof);
            return;
          }
          const reapAbort = new AbortController();
          slot.attemptAbort = reapAbort;
          void this.#trackDestructiveAttempt(
            slot,
            this.#reapRecordedContainment(slot.identity, proof, reapAbort.signal, () => undefined),
          ).then(
            (outcome) => {
              if (this.#slots.get(slot.key) !== slot || slot.attemptToken !== token) {
                if (outcome.kind === 'containment-absent') releaseProviderProxySetContainmentProofFence(proof);
                return;
              }
              slot.attemptAbort = null;
              if (outcome.kind === 'containment-absent') {
                this.#containmentAbsent(slot.identity, outcome.disappearanceReceipt, proof);
                return;
              }
              slot.completedAttempts += 1;
              const delayMs = retryDelayMs(slot.completedAttempts);
              const requestedWakeMs = this.#deps.time.now() + delayMs;
              slot.retryTimer = this.#deps.time.setTimeout(() => {
                slot.retryTimer = null;
                this.#recordLateness('containment-retry', requestedWakeMs);
                this.#recoverExactCapsule(slot);
              }, delayMs);
              slot.retryTimer.unref?.();
            },
            (error: unknown) => {
              if (this.#slots.get(slot.key) !== slot || slot.attemptToken !== token) return;
              slot.attemptAbort = null;
              this.#deps.onError?.(
                `Provider handoff capsule exact containment reap failed: ${singleLineErrorSummary(error)}`,
              );
              slot.completedAttempts += 1;
              const delayMs = retryDelayMs(slot.completedAttempts);
              const requestedWakeMs = this.#deps.time.now() + delayMs;
              slot.retryTimer = this.#deps.time.setTimeout(() => {
                slot.retryTimer = null;
                this.#recordLateness('containment-retry', requestedWakeMs);
                this.#recoverExactCapsule(slot);
              }, delayMs);
              slot.retryTimer.unref?.();
            },
          );
        },
        retry: (retry) => {
          if (this.#slots.get(slot.key) !== slot || slot.attemptToken !== token) return;
          abort.abort();
          slot.attemptAbort = null;
          this.#deps.onError?.(
            `Provider handoff capsule exact recovery is temporarily unavailable: ${retry.producerId}`,
          );
          slot.completedAttempts += 1;
          const delayMs = retryDelayMs(slot.completedAttempts);
          const requestedWakeMs = this.#deps.time.now() + delayMs;
          slot.retryTimer = this.#deps.time.setTimeout(() => {
            slot.retryTimer = null;
            this.#recordLateness('containment-retry', requestedWakeMs);
            this.#recoverExactCapsule(slot);
          }, delayMs);
          slot.retryTimer.unref?.();
        },
        fatal: () => {
          if (this.#slots.get(slot.key) === slot && slot.attemptToken === token) slot.attemptAbort = null;
        },
        disposeLateEvidence: (value, sourceId) => this.#releaseLateReattachmentEvidence(value, sourceId),
      },
    );
    turn.start({
      sourceId: 'redemption',
      producerId: 'capsule-redemption',
      input: { capsule: slot.capsuleBinding, capsulePath: slot.capsulePath, signal: abort.signal },
      abort: (reason) => abort.abort(reason),
    });
    turn.start({
      sourceId: 'absence',
      producerId: 'containment-proof',
      input: { identity: slot.identity, signal: abort.signal },
      abort: (reason) => abort.abort(reason),
    });
  }

  #establish(
    authority: DurableProviderProxyOperationAuthority,
    _publicationReceipt: PublicationReceipt,
    routeKey: string | null,
    capsulePath: string | null,
    intent: EstablishmentIntent,
    protection: ProviderProxySetProtection = 'protected',
  ): void {
    const identity = authority.setIdentity;
    const key = this.#identityIndex.add(identity);
    const existing = this.#slots.get(key);
    if (existing !== undefined && existing.kind !== 'recovering') {
      if (
        (existing.kind === 'available' ||
          existing.kind === 'draining' ||
          existing.kind === 'reattaching' ||
          existing.kind === 'reattachment-hold' ||
          existing.kind === 'containing' ||
          existing.kind === 'containment-wait') &&
        existing.authority === authority
      ) {
        return;
      }
      throw new Error('provider_proxy_set_already_established');
    }
    const slot: EstablishedSlot = {
      kind: 'available',
      operationControlState: 'operational',
      key,
      identity,
      address: providerProxySetAddress(identity),
      capacityClass: existing?.capacityClass ?? 'retained',
      authority,
      routeKey,
      capsulePath: capsulePath ?? existing?.capsulePath ?? null,
      completedAttempts: 0,
      attemptToken: 0,
      containmentAttemptAbort: null,
      containmentAuthority: null,
      retryTimer: null,
      retirementDecision: null,
      preserveReports: new Map(),
      heartbeatEvidenceWindows: new Map(),
      heartbeatHoldBound: authority.autonomousDeadline.heartbeatHoldBound,
      controlReattachmentBoundMs: authority.autonomousDeadline.adoptionWindowMs,
      controlReattachmentWindow: null,
      operatorExitNotBeforeMonotonicMs: null,
      operatorExitObservedGate: null,
      operatorExitGeneration: 0,
      protection,
      containmentCommitStatus: null,
    };
    this.#slots.set(key, slot);
    this.#subscribeAuthority(slot, authority, slot.attemptToken);
    this.#classifyCapacity();
    if (intent === 'contain-unclaimed-discovery' && slot.kind === 'available') {
      const liveClaims = this.#deps.claims.claimsFor(slot.identity).length;
      if (liveClaims === 0) {
        this.#beginRetirementContainment(slot, this.#retirementStopDecision(slot, 'unclaimed_discovery', liveClaims));
      }
    }
    if (slot.kind === 'available' && routeKey !== null) {
      this.#routeIndex.set(routeKey, key);
    }
    if (this.authorityFor(identity) === authority) {
      this.#deps.controlEstablished(authority);
    }
  }

  #subscribeAuthority(slot: EstablishedSlot, authority: DurableProviderProxyOperationAuthority, token: number): void {
    authority.onFault((fault) => this.#faultAuthority(slot.identity, authority, token, fault));
    authority.onIncident((incident) => this.#recordAuthorityIncident(slot.identity, authority, token, incident));
  }

  /**
   * Slots this coordinator is actually running a set in. A `capsule-foreign` slot is deliberately excluded:
   * it holds no authority, no route and no claim, and the coordinator can take no action on it, so counting
   * it against the acquisition limit lets capsules left behind by another build deny this one its own sets —
   * four of them permanently, and one of them for the matching host.
   */
  #occupiedSlotCount(): number {
    return [...this.#slots.values()].filter((slot) => slot.kind !== 'capsule-foreign').length;
  }

  #classifyCapacity(): void {
    const addressed = [...this.#slots.values()]
      .filter(
        (slot): slot is Exclude<ProviderProxySetSlot, { kind: 'acquiring' | 'capsule-foreign' }> =>
          slot.kind !== 'acquiring' && slot.kind !== 'capsule-foreign',
      )
      .sort((left, right) =>
        providerProxySetAddressKey(left.address).localeCompare(providerProxySetAddressKey(right.address)),
      );
    for (const [index, slot] of addressed.entries()) slot.capacityClass = index < 4 ? 'retained' : 'excess';
    for (const slot of addressed) {
      if (slot.capacityClass !== 'excess' || slot.kind !== 'available') continue;
      this.#retireAvailableSlot(slot, 'excess_capacity');
    }
  }

  #retireAvailableSlot(slot: EstablishedSlot, reason: ProviderProxySetClaimBearingRetirementReason): void {
    const liveClaims = this.#deps.claims.claimsFor(slot.identity).length;
    if (liveClaims === 0) {
      this.#beginRetirementContainment(slot, this.#retirementStopDecision(slot, reason, liveClaims));
      return;
    }
    const decision = this.#drainDecision(slot, reason, liveClaims);
    slot.retirementDecision = decision;
    this.#recordDecision(slot, decision);
    slot.kind = 'draining';
    this.#removeRoute(slot);
  }

  #removeRoute(slot: EstablishedSlot): void {
    if (slot.routeKey !== null && this.#routeIndex.get(slot.routeKey) === slot.key) {
      this.#routeIndex.delete(slot.routeKey);
    }
  }

  /** Disappearance evidence cannot release a routable slot until containment owns it. */
  #commitHeldSlotToContainment(slot: EstablishedSlot): void {
    if (slot.kind !== 'available' && slot.kind !== 'draining') return;
    this.#removeRoute(slot);
    slot.kind = 'containing';
  }

  #beginControlReattachment(slot: EstablishedSlot, incident: ProviderProxyControlChannelIncident): void {
    if (this.#slots.get(slot.key) !== slot || (slot.kind !== 'available' && slot.kind !== 'draining')) return;
    const returnKind = slot.kind;
    const observedAtMonotonicMs = this.#deps.time.monotonicNow();
    slot.attemptToken += 1;
    const window: ControlReattachmentWindow = {
      returnKind,
      lastObservedAtMonotonicMs: observedAtMonotonicMs,
      observedElapsedMs: 0,
      trigger: { role: incident.role, cause: incident.cause, error: incident.error },
      attempts: 0,
      boundMs: slot.controlReattachmentBoundMs,
      attemptToken: slot.attemptToken,
      attemptAbort: null,
      deadlineTimer: null,
    };
    slot.kind = 'reattaching';
    slot.controlReattachmentWindow = window;
    slot.operatorExitNotBeforeMonotonicMs = observedAtMonotonicMs + BigInt(window.boundMs);
    this.#removeRoute(slot);
    slot.authority.stopHeartbeats();
    this.#scheduleControlReattachmentDeadline(slot, window);
    this.#runControlReattachmentAttempt(slot, window);
  }

  #scheduleControlReattachmentDeadline(slot: EstablishedSlot, window: ControlReattachmentWindow): void {
    const remainingMs = window.boundMs - window.observedElapsedMs;
    if (remainingMs <= 0) {
      this.#awaitControlReattachmentAbsence(slot, window, 'control_reattachment_bound_expired');
      return;
    }
    const observationCadenceMs = Math.min(retryDelayMs(Math.max(window.attempts, 1)), remainingMs);
    window.deadlineTimer = this.#deps.time.setTimeout(() => {
      window.deadlineTimer = null;
      if (this.#slots.get(slot.key) !== slot || slot.controlReattachmentWindow !== window) return;
      if (this.#observeControlReattachmentWindow(slot, window, observationCadenceMs) > 0) {
        this.#scheduleControlReattachmentDeadline(slot, window);
        return;
      }
      if (slot.kind === 'reattachment-hold') return;
      this.#awaitControlReattachmentAbsence(slot, window, 'control_reattachment_bound_expired');
    }, observationCadenceMs);
    window.deadlineTimer.unref?.();
  }

  #runControlReattachmentAttempt(slot: EstablishedSlot, window: ControlReattachmentWindow): void {
    if (
      this.#slots.get(slot.key) !== slot ||
      slot.kind !== 'reattaching' ||
      slot.controlReattachmentWindow !== window
    ) {
      return;
    }
    if (window.observedElapsedMs >= window.boundMs) {
      this.#awaitControlReattachmentAbsence(slot, window, 'control_reattachment_bound_expired');
      return;
    }
    slot.attemptToken += 1;
    window.attemptToken = slot.attemptToken;
    window.attempts += 1;
    const token = window.attemptToken;
    const abort = new AbortController();
    window.attemptAbort = abort;
    this.#recordDecision(slot, this.#controlReattachmentHoldDecision(slot, window));
    const authority = slot.authority;
    const turn = this.#deps.recoveryDispatcher.begin(
      'control-reattachment',
      { setIdentity: slot.identity },
      {
        evidence: (value, sourceId) => {
          if (!this.#isCurrentControlReattachment(slot, window, token)) {
            this.#releaseLateReattachmentEvidence(value, sourceId);
            return;
          }
          window.attemptAbort = null;
          if (sourceId === 'absence') {
            const proof = value as ProviderProxySetFencedContainmentProof;
            const evidence = providerProxySetContainmentEvidenceFor(proof, slot.identity);
            if (evidence.kind !== 'reap-required') {
              releaseProviderProxySetContainmentProofFence(proof);
              return;
            }
            const reapAbort = new AbortController();
            window.attemptAbort = reapAbort;
            void this.#trackDestructiveAttempt(
              slot,
              this.#reapRecordedContainment(slot.identity, proof, reapAbort.signal, () => undefined),
            ).then(
              (outcome) => {
                if (!this.#isCurrentControlReattachment(slot, window, token)) {
                  if (outcome.kind === 'containment-absent') releaseProviderProxySetContainmentProofFence(proof);
                  return;
                }
                window.attemptAbort = null;
                if (outcome.kind !== 'containment-absent') {
                  this.#scheduleControlReattachmentRetry(slot, window);
                  return;
                }
                this.#clearControlReattachment(slot, window);
                this.#deleteOperatorDispositions(slot.identity);
                this.#containmentAbsent(slot.identity, outcome.disappearanceReceipt, proof);
              },
              (error: unknown) => {
                if (!this.#isCurrentControlReattachment(slot, window, token)) return;
                window.attemptAbort = null;
                this.#deps.onError?.(
                  `Provider proxy control reattachment containment reap failed: ${singleLineErrorSummary(error)}`,
                );
                this.#scheduleControlReattachmentRetry(slot, window);
              },
            );
            return;
          }
          const outcome = value as ProviderProxyControlRedemptionOutcome;
          if (outcome.kind === 'refused') {
            const decisive = decisiveTeardownLatchedRefusal(outcome.refusal);
            if (decisive !== null) {
              this.#commitReattachmentTeardownLatched(slot, window, decisive);
              return;
            }
            this.#releasePartialRedemption(outcome.refusal);
            this.#awaitControlReattachmentAbsence(slot, window, 'control_reattachment_refused', outcome.refusal);
            return;
          }
          if (outcome.kind === 'redeemed') void this.#promoteControlReattachment(slot, window, token, outcome);
        },
        retry: () => {
          if (!this.#isCurrentControlReattachment(slot, window, token)) return;
          window.attemptAbort = null;
          this.#scheduleControlReattachmentRetry(slot, window);
        },
        fatal: () => {
          if (this.#isCurrentControlReattachment(slot, window, token)) window.attemptAbort = null;
        },
        disposeLateEvidence: (value, sourceId) => this.#releaseLateReattachmentEvidence(value, sourceId),
      },
    );
    turn.start({
      sourceId: 'redemption',
      producerId: 'role-control',
      input: { signal: abort.signal, run: (signal) => authority.redeemControl(signal) },
      abort: (reason) => abort.abort(reason),
    });
    turn.start({
      sourceId: 'absence',
      producerId: 'containment-proof',
      input: { identity: slot.identity, signal: abort.signal },
      abort: (reason) => abort.abort(reason),
    });
  }

  #isCurrentControlReattachment(slot: EstablishedSlot, window: ControlReattachmentWindow, token: number): boolean {
    return (
      this.#slots.get(slot.key) === slot &&
      (slot.kind === 'reattaching' || slot.kind === 'reattachment-hold') &&
      slot.controlReattachmentWindow === window &&
      slot.attemptToken === token &&
      window.attemptToken === token
    );
  }

  #scheduleControlReattachmentRetry(slot: EstablishedSlot, window: ControlReattachmentWindow): void {
    const remainingMs = window.boundMs - window.observedElapsedMs;
    if (remainingMs <= 0) {
      this.#awaitControlReattachmentAbsence(slot, window, 'control_reattachment_bound_expired');
      return;
    }
    const delayMs = Math.min(retryDelayMs(window.attempts), remainingMs);
    slot.retryTimer = this.#deps.time.setTimeout(() => {
      slot.retryTimer = null;
      if (
        this.#slots.get(slot.key) !== slot ||
        slot.kind !== 'reattaching' ||
        slot.controlReattachmentWindow !== window
      ) {
        return;
      }
      this.#observeControlReattachmentWindow(slot, window, delayMs);
      this.#runControlReattachmentAttempt(slot, window);
    }, delayMs);
    slot.retryTimer.unref?.();
  }

  #observeControlReattachmentWindow(
    slot: EstablishedSlot,
    window: ControlReattachmentWindow,
    scheduledCadenceMs: number,
  ): number {
    const observedAtMonotonicMs = this.#deps.time.monotonicNow();
    const gapMs = observedAtMonotonicMs - window.lastObservedAtMonotonicMs;
    window.lastObservedAtMonotonicMs = observedAtMonotonicMs;
    if (gapMs > 0n) {
      window.observedElapsedMs += Math.min(Number(gapMs), scheduledCadenceMs);
    }
    const remainingMs = Math.max(0, window.boundMs - window.observedElapsedMs);
    slot.operatorExitNotBeforeMonotonicMs = observedAtMonotonicMs + BigInt(remainingMs);
    return remainingMs;
  }

  async #promoteControlReattachment(
    slot: EstablishedSlot,
    window: ControlReattachmentWindow,
    token: number,
    redemption: RedeemedProviderProxyControl,
  ): Promise<void> {
    const oldAuthority = slot.authority;
    const promotionAbort = new AbortController();
    window.attemptAbort = promotionAbort;
    let promoted: DurableProviderProxyOperationAuthority;
    try {
      promoted = await oldAuthority.promoteControl(redemption, promotionAbort.signal);
    } catch (error: unknown) {
      if (!this.#isCurrentControlReattachment(slot, window, token)) return;
      window.attemptAbort = null;
      this.#deps.onError?.(`Provider proxy control promotion failed: ${singleLineErrorSummary(error)}`);
      this.#scheduleControlReattachmentRetry(slot, window);
      return;
    }
    if (!this.#isCurrentControlReattachment(slot, window, token)) {
      promoted.stopHeartbeats();
      void promoted.initiateControlClose().catch((error: unknown) => {
        this.#deps.onError?.(`Stale provider proxy control close failed: ${singleLineErrorSummary(error)}`);
      });
      return;
    }

    slot.attemptToken += 1;
    const promotedToken = slot.attemptToken;
    slot.authority = promoted;
    slot.operationControlState = 'operational';
    this.#subscribeAuthority(slot, promoted, promotedToken);
    void oldAuthority.initiateControlClose().catch((error: unknown) => {
      this.#deps.onError?.(`Displaced provider proxy control close failed: ${singleLineErrorSummary(error)}`);
    });
    this.#clearControlReattachment(slot, window);
    slot.kind = window.returnKind;
    slot.heartbeatEvidenceWindows.clear();
    slot.heartbeatHoldBound = promoted.autonomousDeadline.heartbeatHoldBound;
    slot.controlReattachmentBoundMs = promoted.autonomousDeadline.adoptionWindowMs;
    this.#clearObservedOperatorExitGate(slot);
    slot.operatorExitNotBeforeMonotonicMs = null;
    this.#flushPreserveReports(slot);
    this.#deleteOperatorDispositions(slot.identity);
    if (slot.kind === 'available' && slot.routeKey !== null) this.#routeIndex.set(slot.routeKey, slot.key);
    this.#deps.controlEstablished(promoted);
    if (slot.kind === 'draining') this.claimsChanged(slot.identity);
  }

  #clearControlReattachment(slot: EstablishedSlot, window: ControlReattachmentWindow): void {
    window.attemptAbort?.abort(new Error('provider_proxy_control_reattachment_finished'));
    window.attemptAbort = null;
    if (window.deadlineTimer !== null) this.#deps.time.clearTimeout(window.deadlineTimer);
    window.deadlineTimer = null;
    if (slot.retryTimer !== null) this.#deps.time.clearTimeout(slot.retryTimer);
    slot.retryTimer = null;
    slot.controlReattachmentWindow = null;
  }

  #controlReattachmentHoldDecision(
    slot: EstablishedSlot,
    window: ControlReattachmentWindow,
  ): ProviderProxySetPreserveDecision {
    return {
      action: 'preserve',
      reason: 'control_channel_reattaching',
      fault: 'control-channel-fault',
      role: window.trigger.role,
      cause: controlChannelCause(window.trigger.cause),
      attempts: window.attempts,
      elapsedMs: window.observedElapsedMs,
      boundMs: window.boundMs,
      error: singleLineErrorSummary(window.trigger.error),
      liveClaims: this.#deps.claims.claimsFor(slot.identity).length,
      setIdentity: slot.identity,
    };
  }

  #awaitControlReattachmentAbsence(
    slot: EstablishedSlot,
    window: ControlReattachmentWindow,
    reason: ProviderProxySetControlReattachmentAwaitAbsenceDecision['reason'],
    refusal?: ProviderProxyControlRedemptionRefusal,
  ): void {
    if (this.#slots.get(slot.key) !== slot || slot.controlReattachmentWindow !== window) return;
    const decisive = refusal === undefined ? null : decisiveTeardownLatchedRefusal(refusal);
    if (decisive !== null) {
      this.#commitReattachmentTeardownLatched(slot, window, decisive);
      return;
    }
    const error = singleLineErrorSummary(refusal ?? new Error('provider_proxy_control_reattachment_bound_expired'));
    const liveClaims = this.#deps.claims.claimsFor(slot.identity).length;
    if (liveClaims > 0) {
      this.#enterReattachmentHold(slot, window, {
        reason,
        fault: 'control-channel-fault',
        role: window.trigger.role,
        cause: controlChannelCause(window.trigger.cause),
        attempts: window.attempts,
        elapsedMs: window.observedElapsedMs,
        boundMs: window.boundMs,
        error,
      });
      return;
    }
    slot.attemptToken += 1;
    const reattachmentBoundObserved = window.observedElapsedMs >= window.boundMs;
    this.#clearControlReattachment(slot, window);
    if (!reattachmentBoundObserved) slot.operatorExitNotBeforeMonotonicMs = null;
    this.#clearLocalOperatorDispositions(slot.identity);
    this.#beginContainment(slot, {
      action: 'await-containment-absence',
      reason,
      fault: 'control-channel-fault',
      role: window.trigger.role,
      cause: controlChannelCause(window.trigger.cause),
      attempts: window.attempts,
      elapsedMs: window.observedElapsedMs,
      boundMs: window.boundMs,
      error,
      liveClaims,
      setIdentity: slot.identity,
    });
  }

  /**
   * The redemption channel's own decisive answer, reachable from both the active window and the post-bound
   * hold — decisiveness does not depend on which one observed it.
   */
  #commitReattachmentTeardownLatched(
    slot: EstablishedSlot,
    window: ControlReattachmentWindow,
    decisive: Readonly<{
      role: ProviderProxyRole;
      stage: 'open' | 'heartbeat';
      method: NonNullable<ProviderProxyRoleControlRemoteError['method']>;
      error: ProviderProxyRoleControlRemoteError;
      authority: ProviderProxyContainmentAuthority;
    }>,
  ): void {
    slot.attemptToken += 1;
    this.#clearControlReattachment(slot, window);
    slot.operatorExitNotBeforeMonotonicMs = null;
    this.#clearLocalOperatorDispositions(slot.identity);
    slot.containmentAuthority = decisive.authority;
    this.#beginFaultContainment(slot, {
      action: 'stop-and-reap',
      reason: 'provider_authority_lost',
      fault: 'control-redemption-refused',
      role: decisive.role,
      stage: decisive.stage,
      method: decisive.method,
      terminalReason: 'teardown-latched',
      error: singleLineErrorSummary(decisive.error),
      liveClaims: this.#deps.claims.claimsFor(slot.identity).length,
      setIdentity: slot.identity,
    });
  }

  /**
   * Moves the slot into the unbounded post-bound hold: the window's own deadline is no longer enforced, and
   * redemption plus containment observation continue at a restrained cadence instead of the active window's
   * backoff. Reachable only with live claims present — the liveClaims===0 case stays on the decisive
   * `await-containment-absence` path, which destroys nothing this coordinator still has a claim in.
   */
  #enterReattachmentHold(
    slot: EstablishedSlot,
    window: ControlReattachmentWindow,
    refusedDecision:
      | ProviderProxySetControlReattachmentRefusalDecision
      | ProviderProxySetHeartbeatLocalFailureRefusalDecision,
  ): void {
    if (this.#slots.get(slot.key) !== slot || slot.controlReattachmentWindow !== window) return;
    window.attemptAbort?.abort(new Error('provider_proxy_control_reattachment_hold_entered'));
    window.attemptAbort = null;
    if (slot.retryTimer !== null) this.#deps.time.clearTimeout(slot.retryTimer);
    slot.retryTimer = null;
    slot.kind = 'reattachment-hold';
    // Already in the past when this hold followed an expired active window's own deadline — that lets the
    // operator override apply immediately rather than waiting a second grace period. A window opened directly
    // from a heartbeat local-failure fault has no prior deadline, so this is the one that arms it.
    this.#armObservedOperatorExitGate(slot);
    const decision: ProviderProxySetContainmentRefusedDecision = {
      action: 'preserve',
      reason: 'containment_refused_live_claims',
      liveClaims: this.#deps.claims.claimsFor(slot.identity).length,
      setIdentity: slot.identity,
      refusedDecision,
    };
    this.#recordDecision(slot, decision);
    // Restrained cadence starts from the hold's own entry, not from an immediate re-attempt: the active
    // window already just tried and was refused or timed out, so retrying again at once would defeat the
    // point of slowing down.
    this.#scheduleReattachmentHoldRetry(slot, window);
  }

  /**
   * The reattachment hold's own retry loop: the same redemption and absence sources as the active window, at
   * a restrained cadence and with no deadline to expire against — the bound already expired, so nothing here
   * re-arms it. `#isCurrentControlReattachment` doubles as this loop's own currency check.
   */
  #runReattachmentHoldAttempt(slot: EstablishedSlot, window: ControlReattachmentWindow): void {
    if (
      this.#slots.get(slot.key) !== slot ||
      slot.kind !== 'reattachment-hold' ||
      slot.controlReattachmentWindow !== window
    ) {
      return;
    }
    slot.attemptToken += 1;
    window.attemptToken = slot.attemptToken;
    window.attempts += 1;
    const token = window.attemptToken;
    const abort = new AbortController();
    window.attemptAbort = abort;
    const authority = slot.authority;
    const turn = this.#deps.recoveryDispatcher.begin(
      'control-reattachment-hold',
      { setIdentity: slot.identity },
      {
        evidence: (value, sourceId) => {
          if (!this.#isCurrentControlReattachment(slot, window, token)) {
            this.#releaseLateReattachmentEvidence(value, sourceId);
            return;
          }
          window.attemptAbort = null;
          if (sourceId === 'absence') {
            const proof = value as ProviderProxySetFencedContainmentProof;
            const evidence = providerProxySetContainmentEvidenceFor(proof, slot.identity);
            if (evidence.kind !== 'reap-required') {
              releaseProviderProxySetContainmentProofFence(proof);
              this.#scheduleReattachmentHoldRetry(slot, window);
              return;
            }
            const reapAbort = new AbortController();
            window.attemptAbort = reapAbort;
            void this.#trackDestructiveAttempt(
              slot,
              this.#reapRecordedContainment(slot.identity, proof, reapAbort.signal, () => undefined),
            ).then(
              (outcome) => {
                if (!this.#isCurrentControlReattachment(slot, window, token)) {
                  if (outcome.kind === 'containment-absent') releaseProviderProxySetContainmentProofFence(proof);
                  return;
                }
                window.attemptAbort = null;
                if (outcome.kind !== 'containment-absent') {
                  this.#scheduleReattachmentHoldRetry(slot, window);
                  return;
                }
                this.#clearControlReattachment(slot, window);
                this.#deleteOperatorDispositions(slot.identity);
                this.#containmentAbsent(slot.identity, outcome.disappearanceReceipt, proof);
              },
              (error: unknown) => {
                if (!this.#isCurrentControlReattachment(slot, window, token)) return;
                window.attemptAbort = null;
                this.#deps.onError?.(
                  `Provider proxy reattachment hold containment reap failed: ${singleLineErrorSummary(error)}`,
                );
                this.#scheduleReattachmentHoldRetry(slot, window);
              },
            );
            return;
          }
          const outcome = value as ProviderProxyControlRedemptionOutcome;
          if (outcome.kind === 'refused') {
            const decisive = decisiveTeardownLatchedRefusal(outcome.refusal);
            if (decisive !== null) {
              this.#commitReattachmentTeardownLatched(slot, window, decisive);
              return;
            }
            this.#releasePartialRedemption(outcome.refusal);
            this.#scheduleReattachmentHoldRetry(slot, window);
            return;
          }
          if (outcome.kind === 'redeemed') void this.#promoteControlReattachment(slot, window, token, outcome);
        },
        retry: () => {
          if (!this.#isCurrentControlReattachment(slot, window, token)) return;
          window.attemptAbort = null;
          this.#scheduleReattachmentHoldRetry(slot, window);
        },
        fatal: () => {
          if (this.#isCurrentControlReattachment(slot, window, token)) window.attemptAbort = null;
        },
        disposeLateEvidence: (value, sourceId) => this.#releaseLateReattachmentEvidence(value, sourceId),
      },
    );
    turn.start({
      sourceId: 'redemption',
      producerId: 'role-control',
      input: { signal: abort.signal, run: (signal) => authority.redeemControl(signal) },
      abort: (reason) => abort.abort(reason),
    });
    turn.start({
      sourceId: 'absence',
      producerId: 'containment-proof',
      input: { identity: slot.identity, signal: abort.signal },
      abort: (reason) => abort.abort(reason),
    });
  }

  #scheduleReattachmentHoldRetry(slot: EstablishedSlot, window: ControlReattachmentWindow): void {
    if (
      this.#slots.get(slot.key) !== slot ||
      slot.kind !== 'reattachment-hold' ||
      slot.controlReattachmentWindow !== window
    ) {
      return;
    }
    slot.retryTimer = this.#deps.time.setTimeout(() => {
      slot.retryTimer = null;
      this.#runReattachmentHoldAttempt(slot, window);
    }, REATTACHMENT_HOLD_RETRY_MS);
    slot.retryTimer.unref?.();
  }

  #releasePartialRedemption(refusal: ProviderProxyControlRedemptionRefusal): void {
    if (refusal.kind !== 'downstream-role-refused') return;
    refusal.guardianAuthority.stopHeartbeats();
    void refusal.guardianAuthority.initiateControlClose().catch((error: unknown) => {
      this.#deps.onError?.(`Partial provider proxy control close failed: ${singleLineErrorSummary(error)}`);
    });
  }

  #releaseLateReattachmentEvidence(value: unknown, sourceId: string): void {
    if (sourceId === 'absence') {
      releaseProviderProxySetContainmentProofFence(value as ProviderProxySetContainmentProof);
      return;
    }
    if (sourceId !== 'redemption' || typeof value !== 'object' || value === null || !('kind' in value)) return;
    const outcome = value as ProviderProxyControlRedemptionOutcome;
    if (outcome.kind === 'redeemed') {
      closeRedeemedProviderProxyControl(outcome);
      return;
    }
    if (outcome.kind === 'refused') this.#releasePartialRedemption(outcome.refusal);
  }

  #beginFaultContainment(slot: EstablishedSlot, decision: ProviderProxySetAuthorityStopDecision): void {
    this.#beginContainment(slot, decision);
  }

  #beginRetirementContainment(slot: EstablishedSlot, decision: ProviderProxySetRetirementStopDecision): void {
    this.#beginContainment(slot, decision);
  }

  #beginContainment(slot: EstablishedSlot, decision: ProviderProxySetContainmentDecision): void {
    if (this.#slots.get(slot.key) !== slot || slot.kind === 'containing' || slot.kind === 'containment-wait') {
      return;
    }
    this.#recordDecision(slot, decision);
    this.#armObservedOperatorExitGate(slot);
    slot.retirementDecision = null;
    this.#removeRoute(slot);
    slot.kind = 'containing';
    if (decision.action === 'await-containment-absence') {
      // Sends no containment command: this hold is resolved only by an independently observed absence, an
      // accepted successor, or the operator override, never by anything this close accelerates. Heartbeats and
      // control are given up immediately because there is no commit in flight whose ownership this coordinator
      // must retain.
      slot.authority.stopHeartbeats();
      void this.#runContainmentAttempt(slot, decision);
      void slot.authority.initiateControlClose().catch((error: unknown) => {
        this.#deps.onError?.(
          `Provider proxy control close before containment wait failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      return;
    }
    this.#commitContainmentThenBegin(slot, decision);
  }

  /**
   * The single coordinator ingress to the guardian's destructive `guardian.containment-commit.v1`. Heartbeats
   * and control stay untouched until a confirmed result — `containment-absent` — arrives: an unconfirmed sent
   * request (`outcome-unknown`) or a proven non-latch (`not-sent`) both retain full reconciliation ownership,
   * which needs a live heartbeat lease to keep retrying against, not a torn-down one.
   */
  #commitContainmentThenBegin(
    slot: EstablishedSlot,
    decision: ProviderProxySetAuthorityStopDecision | ProviderProxySetRetirementStopDecision,
  ): void {
    void this.#runContainmentAttempt(slot, decision);
  }

  /** A containment-commit outcome must amend, not add, a disposition. */
  #recordContainmentCommitOutcome(
    slot: EstablishedSlot,
    decision: ProviderProxySetAuthorityStopDecision | ProviderProxySetRetirementStopDecision,
    outcome: 'not-sent' | 'outcome-unknown',
  ): void {
    const setKey = providerProxySetKey(decision.setIdentity);
    const existing = this.#operatorDispositions.get(setKey);
    if (existing === undefined) return;
    const dispositions = new Map(existing);
    const role = 'role' in decision && typeof decision.role === 'string' ? decision.role : undefined;
    const method = 'method' in decision && typeof decision.method === 'string' ? decision.method : undefined;
    const subjectKey = operatorDispositionSubjectKey(role, method);
    const current = dispositions.get(subjectKey);
    if (current === undefined || current.disposition !== 'awaiting-containment-absence') return;
    dispositions.set(subjectKey, {
      ...current,
      waitingFor: outcome === 'not-sent' ? 'containment-authorization' : 'containment-outcome-unknown',
    });
    this.#setOperatorDispositions(decision.setIdentity, dispositions);
  }

  #recordDecision(
    slot: EstablishedSlot,
    decision: ProviderProxySetDecision,
    errorIdentity?: string,
  ): ProviderProxySetOperatorDispositionRecording {
    const recording = this.#recordOperatorDisposition(decision);
    if (decision.action === 'preserve') {
      this.#recordPreserveDecision(slot, decision, errorIdentity ?? preserveErrorIdentity(decision.error));
      return recording;
    }
    this.#flushPreserveReports(slot);
    this.#reportDecision(decision);
    return recording;
  }

  #recordOperatorDisposition(decision: ProviderProxySetDecision): ProviderProxySetOperatorDispositionRecording {
    if (
      decision.action === 'preserve' &&
      decision.fault !== 'heartbeat-indeterminate' &&
      decision.fault !== 'control-channel-fault' &&
      decision.reason !== 'containment_refused_live_claims'
    ) {
      return { kind: 'recorded' };
    }
    const setKey = providerProxySetKey(decision.setIdentity);
    if (decision.action === 'drain') {
      return this.#deleteOperatorDispositions(decision.setIdentity);
    }
    if (decision.reason === 'containment_refused_live_claims') {
      return this.#recordNonAuthorizingDisposition(decision);
    }
    const role = 'role' in decision && typeof decision.role === 'string' ? decision.role : undefined;
    const method = 'method' in decision && typeof decision.method === 'string' ? decision.method : undefined;
    const subjectKey = operatorDispositionSubjectKey(role, method);
    const dispositions = new Map(this.#operatorDispositions.get(setKey) ?? []);
    const incidentReason =
      'incidentReason' in decision && typeof decision.incidentReason === 'string'
        ? decision.incidentReason
        : 'lastIncidentReason' in decision && typeof decision.lastIncidentReason === 'string'
          ? decision.lastIncidentReason
          : 'terminalReason' in decision && typeof decision.terminalReason === 'string'
            ? decision.terminalReason
            : decision.reason;
    const shared = {
      ...(role === undefined ? {} : { role }),
      ...(method === undefined ? {} : { method }),
      ...('cause' in decision
        ? {
            cause: decision.cause,
            attempts: decision.attempts,
            elapsedMs: decision.elapsedMs,
            boundMs: decision.boundMs,
          }
        : {}),
      incidentReason,
    };
    if (decision.action === 'preserve') {
      dispositions.set(subjectKey, {
        ...shared,
        disposition: 'held',
        waitingFor: decision.fault === 'control-channel-fault' ? 'control-reattachment' : 'heartbeat-evidence-window',
      });
      return this.#setOperatorDispositions(decision.setIdentity, dispositions);
    }
    dispositions.set(subjectKey, {
      ...shared,
      disposition: 'awaiting-containment-absence',
      waitingFor: 'independent-containment-absence',
    });
    return this.#setOperatorDispositions(decision.setIdentity, dispositions);
  }

  #recordNonAuthorizingDisposition(
    decision: ProviderProxySetContainmentRefusedDecision,
  ): ProviderProxySetOperatorDispositionRecording {
    const refused = decision.refusedDecision;
    const role = 'role' in refused ? refused.role : undefined;
    const method = 'method' in refused ? refused.method : 'policy' in refused ? refused.policy.method : undefined;
    const subjectKey = operatorDispositionSubjectKey(role, method);
    const dispositions = new Map(this.#operatorDispositions.get(providerProxySetKey(decision.setIdentity)) ?? []);
    const incidentReason =
      'incidentReason' in refused
        ? refused.incidentReason
        : 'lastIncidentReason' in refused
          ? refused.lastIncidentReason
          : 'terminalReason' in refused
            ? refused.terminalReason
            : refused.reason;
    const waitingFor: ProviderProxySetOperatorDisposition['waitingFor'] =
      refused.reason === 'control_reattachment_bound_expired' ||
      refused.reason === 'control_reattachment_refused' ||
      refused.reason === 'heartbeat_local_failure'
        ? 'control-reattachment-bound-live-claims'
        : refused.reason === 'heartbeat_hold_exhausted' || refused.reason === 'heartbeat_answer_unusable_hold_exhausted'
          ? 'heartbeat-bound-live-claims'
          : refused.reason === 'heartbeat_protocol_incompatible'
            ? 'heartbeat-protocol-live-claims'
            : 'operation-control-outcome-unknown';
    dispositions.set(subjectKey, {
      ...(role === undefined ? {} : { role }),
      ...(method === undefined ? {} : { method }),
      ...('cause' in refused
        ? { cause: refused.cause, attempts: refused.attempts, elapsedMs: refused.elapsedMs, boundMs: refused.boundMs }
        : {}),
      disposition: 'held',
      incidentReason,
      waitingFor,
    });
    return this.#setOperatorDispositions(decision.setIdentity, dispositions);
  }

  #recordOperatorExitRefusal(
    slot: EstablishedSlot | CapsuleRecoveringSlot | ReleaseDeliveryPendingSlot,
    incidentReason: string,
    waitingFor: ProviderProxySetOperatorDisposition['waitingFor'],
    enforcerObservations?: ProviderProxySetEnforcerObservations,
  ): ProviderProxySetOperatorDispositionRecording {
    const setKey = providerProxySetKey(slot.identity);
    const dispositions = new Map(this.#operatorDispositions.get(setKey) ?? []);
    dispositions.set(operatorDispositionSubjectKey('operator-exit'), {
      disposition: 'operator-exit-refused',
      ...(enforcerObservations === undefined ? {} : { enforcerObservations }),
      incidentReason,
      waitingFor,
    });
    try {
      return this.#setOperatorDispositions(slot.identity, dispositions);
    } catch (error) {
      const reason = singleLineErrorSummary(error);
      this.#operatorDispositions.set(
        setKey,
        new Map([
          ...dispositions,
          [
            OPERATOR_DISPOSITION_STORE_REPAIR_SUBJECT,
            { disposition: 'held', incidentReason: reason, waitingFor: 'store-repair' },
          ] as const,
        ]),
      );
      return {
        kind: 'held',
        reason,
        waitingFor: 'store-repair',
        exit: 'provider-proxy-set-operator-disposition-store-retry',
      };
    }
  }

  #recordPreserveDecision(
    slot: EstablishedSlot,
    decision: ProviderProxySetPreserveDecision,
    errorIdentity: string,
  ): void {
    const now = this.#deps.time.now();
    const subject =
      decision.reason === 'containment_refused_live_claims'
        ? refusedDecisionSubjectKey(decision.refusedDecision)
        : decision.fault === 'operation-control-failed'
          ? decision.policy.method
          : decision.fault === 'control-channel-fault'
            ? `${decision.role}:${decision.cause}`
            : decision.method;
    const key = JSON.stringify([subject, errorIdentity]);
    const report = slot.preserveReports.get(key);
    if (report === undefined) {
      this.#makeRoomForPreserveReport(slot);
      const newReport: PreserveReportState = {
        decision,
        lastReportedAtMs: now,
        suppressed: 0,
        recoveryTimer: null,
      };
      slot.preserveReports.set(key, newReport);
      this.#reportDecision(decision);
      this.#schedulePreserveRecovery(slot, key, newReport);
      return;
    }
    report.decision = decision;
    slot.preserveReports.delete(key);
    slot.preserveReports.set(key, report);
    if (now - report.lastReportedAtMs < PRESERVE_REPORT_INTERVAL_MS) {
      report.suppressed += 1;
      this.#schedulePreserveRecovery(slot, key, report);
      return;
    }
    this.#reportDecision(decision, `summary=periodic suppressed=${report.suppressed}`);
    report.lastReportedAtMs = now;
    report.suppressed = 0;
    this.#schedulePreserveRecovery(slot, key, report);
  }

  #heartbeatPreserveDecision(
    slot: EstablishedSlot,
    incident: ProviderProxyHeartbeatObservation,
    incidentReason: 'unanswered' | 'unclassified',
    error: unknown,
  ): Extract<ProviderProxySetPreserveDecision, { fault: 'heartbeat-indeterminate' }> {
    return {
      action: 'preserve',
      reason: 'heartbeat_echo_indeterminate',
      fault: 'heartbeat-indeterminate',
      role: incident.role,
      method: incident.method,
      incidentReason,
      schedulerLatenessMs: incident.schedulerLatenessMs,
      error: singleLineErrorSummary(error),
      liveClaims: this.#deps.claims.claimsFor(slot.identity).length,
      setIdentity: slot.identity,
    };
  }

  /** A heartbeat disposition may enter containment only when no live claim would lose representation. */
  #applyHeartbeatDisposition(slot: EstablishedSlot, disposition: ProviderProxySetHeartbeatAwaitAbsenceDecision): void {
    if (disposition.liveClaims === 0) {
      this.#beginContainment(slot, disposition);
      return;
    }
    this.#holdHeartbeatDisposition(slot, disposition);
  }

  #holdHeartbeatDisposition(slot: EstablishedSlot, disposition: ProviderProxySetHeartbeatAwaitAbsenceDecision): void {
    if (slot.operatorExitNotBeforeMonotonicMs === null) {
      this.#armObservedOperatorExitGate(slot);
      slot.operatorExitGeneration += 1;
    }
    const refusedDecision: ProviderProxySetNonAuthorizingContainmentDecision =
      disposition.reason === 'heartbeat_protocol_incompatible'
        ? {
            reason: disposition.reason,
            fault: disposition.fault,
            role: disposition.role,
            method: disposition.method,
            incidentReason: disposition.incidentReason,
            error: disposition.error,
          }
        : disposition.reason === 'heartbeat_hold_exhausted'
          ? {
              reason: disposition.reason,
              fault: disposition.fault,
              role: disposition.role,
              method: disposition.method,
              lastIncidentReason: disposition.lastIncidentReason,
              attempts: disposition.attempts,
              observedDurationMs: disposition.observedDurationMs,
              schedulerLatenessMs: disposition.schedulerLatenessMs,
              error: disposition.error,
            }
          : {
              reason: disposition.reason,
              fault: disposition.fault,
              role: disposition.role,
              method: disposition.method,
              lastIncidentReason: disposition.lastIncidentReason,
              attempts: disposition.attempts,
              observedDurationMs: disposition.observedDurationMs,
              schedulerLatenessMs: disposition.schedulerLatenessMs,
              error: disposition.error,
            };
    const decision: ProviderProxySetContainmentRefusedDecision = {
      action: 'preserve',
      reason: 'containment_refused_live_claims',
      liveClaims: disposition.liveClaims,
      setIdentity: disposition.setIdentity,
      refusedDecision,
    };
    this.#recordDecision(slot, decision);
  }

  #recordHeartbeatObservation(slot: EstablishedSlot, incident: ProviderProxyHeartbeatObservation): void {
    const key = JSON.stringify([incident.role, incident.method]);
    const current = slot.heartbeatEvidenceWindows.get(key) ?? { kind: 'clear' };
    const timing = {
      nowMonotonicMs: this.#deps.time.monotonicNow(),
      schedulerLatenessMs: incident.schedulerLatenessMs,
      bound: slot.heartbeatHoldBound,
    };
    const { observation } = incident;
    if (observation.kind === 'reply') {
      const transition = applyAnswer(current, observation, timing);
      slot.heartbeatEvidenceWindows.set(key, transition.window);
      if (transition.effect === 'accepted' || transition.effect === 'challenge-mismatch') {
        this.#recordHeartbeatAccepted(slot, incident);
        return;
      }
      if (transition.effect === 'method-not-found') {
        this.#applyHeartbeatDisposition(
          slot,
          this.#heartbeatProtocolContainmentDecision(slot, incident, transition.error),
        );
        return;
      }
      if (transition.effect === 'teardown-latched') {
        // This boundary owns only the evidence-window transition; finalization stays on that latch.
        return;
      }
      const decision = this.#heartbeatPreserveDecision(slot, incident, 'unclassified', transition.error);
      if (transition.effect === 'unusable-holding') {
        this.#recordDecision(slot, decision, preserveErrorIdentity(transition.error));
        return;
      }
      this.#applyHeartbeatDisposition(
        slot,
        this.#answeredHeartbeatHoldExhaustedDecision(slot, incident, transition.window, transition.error),
      );
      return;
    }
    if (observation.kind === 'no-response-before-deadline') {
      const transition = applyNoResponse(current, observation, timing);
      slot.heartbeatEvidenceWindows.set(key, transition.window);
      const decision = this.#heartbeatPreserveDecision(slot, incident, 'unanswered', transition.error);
      if (transition.effect === 'silence-holding') {
        this.#recordDecision(slot, decision, preserveErrorIdentity(transition.error));
        return;
      }
      this.#applyHeartbeatDisposition(
        slot,
        this.#silenceHoldExhaustedDecision(slot, incident, transition.window, transition.error),
      );
      return;
    }
  }

  #silenceHoldExhaustedDecision(
    slot: EstablishedSlot,
    incident: ProviderProxyHeartbeatObservation,
    hold: Extract<HeartbeatEvidenceWindow, { kind: 'silence' }>,
    error: unknown,
  ): ProviderProxySetHeartbeatAwaitAbsenceDecision {
    const liveClaims = this.#deps.claims.claimsFor(slot.identity).length;
    return {
      action: 'await-containment-absence',
      liveClaims,
      reason: 'heartbeat_hold_exhausted',
      fault: 'heartbeat-hold-exhausted',
      role: incident.role,
      method: incident.method,
      lastIncidentReason: 'unanswered',
      attempts: hold.attempts,
      schedulerLatenessMs: hold.schedulerLatenessAfterFirstObservationMs,
      observedDurationMs: hold.observedDurationMs,
      error: singleLineErrorSummary(error),
      setIdentity: slot.identity,
    };
  }

  #answeredHeartbeatHoldExhaustedDecision(
    slot: EstablishedSlot,
    incident: ProviderProxyHeartbeatObservation,
    hold: Extract<HeartbeatEvidenceWindow, { kind: 'answered-unusable' }>,
    error: unknown,
  ): ProviderProxySetHeartbeatAwaitAbsenceDecision {
    const liveClaims = this.#deps.claims.claimsFor(slot.identity).length;
    return {
      action: 'await-containment-absence',
      liveClaims,
      reason: 'heartbeat_answer_unusable_hold_exhausted',
      fault: 'heartbeat-answer-unusable-hold-exhausted',
      role: incident.role,
      method: incident.method,
      lastIncidentReason: 'unclassified',
      attempts: hold.attempts,
      schedulerLatenessMs: hold.schedulerLatenessAfterFirstObservationMs,
      observedDurationMs: hold.observedDurationMs,
      error: singleLineErrorSummary(error),
      setIdentity: slot.identity,
    };
  }

  #heartbeatProtocolContainmentDecision(
    slot: EstablishedSlot,
    incident: ProviderProxyHeartbeatObservation,
    error: unknown,
  ): ProviderProxySetHeartbeatAwaitAbsenceDecision {
    const liveClaims = this.#deps.claims.claimsFor(slot.identity).length;
    return {
      action: 'await-containment-absence',
      liveClaims,
      reason: 'heartbeat_protocol_incompatible',
      fault: 'heartbeat-method-not-found',
      role: incident.role,
      method: incident.method,
      incidentReason: 'method-not-found',
      error: singleLineErrorSummary(error),
      setIdentity: slot.identity,
    };
  }

  #recordHeartbeatAccepted(slot: EstablishedSlot, incident: ProviderProxyHeartbeatObservation): void {
    const { role, method } = incident;
    const setKey = providerProxySetKey(slot.identity);
    const existingDispositions = this.#operatorDispositions.get(setKey);
    const dispositions = existingDispositions === undefined ? undefined : new Map(existingDispositions);
    const subjectKey = operatorDispositionSubjectKey(role, method);
    const operatorDisposition = dispositions?.get(subjectKey);
    const hasDurableDisposition = [...this.#durableOperatorDispositions.values()].some(
      (record) => providerProxySetKey(record.setIdentity) === setKey && record.subjectKey === subjectKey,
    );
    let recoveredLiveClaimsHold = false;
    if (operatorDisposition?.disposition === 'held') {
      dispositions?.delete(subjectKey);
      recoveredLiveClaimsHold = true;
    }
    if (operatorDisposition !== undefined || hasDurableDisposition) {
      this.#setOperatorDispositions(slot.identity, dispositions ?? new Map(), undefined, new Set([subjectKey]));
    }
    if (recoveredLiveClaimsHold && !this.#hasLiveClaimsHold(slot)) {
      this.#clearObservedOperatorExitGate(slot);
      slot.operatorExitNotBeforeMonotonicMs = null;
      slot.operatorExitGeneration += 1;
    }
    for (const [key, report] of slot.preserveReports) {
      const recovers =
        (report.decision.fault === 'heartbeat-indeterminate' &&
          report.decision.role === role &&
          report.decision.method === method) ||
        (report.decision.reason === 'containment_refused_live_claims' &&
          'method' in report.decision.refusedDecision &&
          report.decision.refusedDecision.role === role &&
          report.decision.refusedDecision.method === method);
      if (!recovers) continue;
      slot.preserveReports.delete(key);
      this.#reportDecision(report.decision, `summary=recovered suppressed=${report.suppressed}`);
    }
  }

  #dispositionProtocolIncompatibleCapsule(
    slot: Extract<ProviderProxySetSlot, { kind: 'capsule-recovering' }>,
    role: ProviderProxySetHeartbeatAwaitAbsenceDecision['role'],
    method: ProviderProxySetHeartbeatAwaitAbsenceDecision['method'],
  ): void {
    if (this.#slots.get(slot.key) !== slot) return;
    const decision: ProviderProxySetHeartbeatAwaitAbsenceDecision = {
      action: 'await-containment-absence',
      reason: 'heartbeat_protocol_incompatible',
      fault: 'heartbeat-method-not-found',
      role,
      method,
      incidentReason: 'method-not-found',
      error: 'this set speaks a heartbeat protocol this build cannot use',
      liveClaims: this.#deps.claims.claimsFor(slot.identity).length,
      setIdentity: slot.identity,
    };
    this.#recordOperatorDisposition(decision);
    this.#reportDecision(decision);
    slot.recoveryPhase = 'containment-wait';
    this.#runContainmentAttempt(slot, decision);
  }

  #makeRoomForPreserveReport(slot: EstablishedSlot): void {
    if (slot.preserveReports.size < MAX_PRESERVE_REPORTS_PER_SET) return;
    let victim: readonly [string, PreserveReportState] | undefined;
    for (const entry of slot.preserveReports) {
      if (entry[1].decision.fault === 'operation-control-failed') {
        victim = entry;
        break;
      }
      victim ??= entry;
    }
    if (victim === undefined) return;
    const [key, report] = victim;
    if (report.recoveryTimer !== null) this.#deps.time.clearTimeout(report.recoveryTimer);
    slot.preserveReports.delete(key);
    this.#reportDecision(report.decision, `summary=evicted suppressed=${report.suppressed}`);
  }

  #schedulePreserveRecovery(slot: EstablishedSlot, key: string, report: PreserveReportState): void {
    if (report.decision.fault !== 'operation-control-failed') return;
    if (report.recoveryTimer !== null) this.#deps.time.clearTimeout(report.recoveryTimer);
    report.recoveryTimer = this.#deps.time.setTimeout(() => {
      report.recoveryTimer = null;
      if (slot.preserveReports.get(key) !== report) return;
      slot.preserveReports.delete(key);
      this.#reportDecision(report.decision, `summary=recovered suppressed=${report.suppressed}`);
    }, PRESERVE_REPORT_INTERVAL_MS);
    report.recoveryTimer.unref?.();
  }

  #flushPreserveReports(slot: EstablishedSlot): void {
    for (const report of slot.preserveReports.values()) {
      if (report.recoveryTimer !== null) this.#deps.time.clearTimeout(report.recoveryTimer);
      if (report.suppressed > 0) {
        this.#reportDecision(report.decision, `summary=closed suppressed=${report.suppressed}`);
      }
    }
    slot.preserveReports.clear();
    slot.heartbeatEvidenceWindows.clear();
  }

  #reportDecision(decision: ProviderProxySetDecision, summary?: string): void {
    const report = renderProviderProxySetDecision(decision, summary);
    this.#report(report.severity, report.message);
  }

  #report(severity: ProviderProxySetLogSeverity, message: string): void {
    try {
      this.#deps.reportLifecycle(severity, message);
    } catch {
      // Observability is not part of the authority transition and cannot be allowed to strand the set.
    }
  }

  #authorityFaultDecision(
    slot: EstablishedSlot,
    fault: ProviderProxyAuthorityFault,
  ): ProviderProxySetAuthorityStopDecision {
    const context = {
      action: 'stop-and-reap' as const,
      reason: 'provider_authority_lost' as const,
      error: singleLineErrorSummary(fault.error),
      liveClaims: this.#deps.claims.claimsFor(slot.identity).length,
      setIdentity: slot.identity,
    };
    switch (fault.kind) {
      case 'operation-control-failed':
        return { ...context, fault: fault.kind, policy: fault.policy };
      case 'heartbeat-failed':
        return {
          ...context,
          fault: fault.kind,
          role: fault.role,
          method: fault.method,
          terminalReason: fault.terminalReason,
        };
    }
  }

  /**
   * `heartbeat-failed` with `local-failure` and live claims present: this process's own failure to reach the
   * peer, never a disposition about the peer. Opens a fresh reattachment window directly in the hold phase —
   * there is no bounded active window to run first, because a local send failure already is the same "our own
   * failure to reach the peer" conclusion the bound exists to reach.
   */
  #beginHeartbeatLocalFailureHold(
    slot: EstablishedSlot,
    fault: Extract<ProviderProxyAuthorityFault, { kind: 'heartbeat-failed' }>,
  ): void {
    if (this.#slots.get(slot.key) !== slot || (slot.kind !== 'available' && slot.kind !== 'draining')) return;
    const returnKind = slot.kind;
    const observedAtMonotonicMs = this.#deps.time.monotonicNow();
    slot.attemptToken += 1;
    const window: ControlReattachmentWindow = {
      returnKind,
      lastObservedAtMonotonicMs: observedAtMonotonicMs,
      observedElapsedMs: 0,
      trigger: { role: fault.role, cause: 'heartbeat-local-failure', error: fault.error },
      attempts: 0,
      boundMs: 0,
      attemptToken: slot.attemptToken,
      attemptAbort: null,
      deadlineTimer: null,
    };
    slot.controlReattachmentWindow = window;
    this.#removeRoute(slot);
    slot.authority.stopHeartbeats();
    void slot.authority.initiateControlClose().catch((error: unknown) => {
      this.#deps.onError?.(
        `Provider proxy control close before reattachment hold failed: ${singleLineErrorSummary(error)}`,
      );
    });
    this.#enterReattachmentHold(slot, window, {
      reason: 'heartbeat_local_failure',
      fault: 'heartbeat-failed',
      role: fault.role,
      method: fault.method,
      terminalReason: 'local-failure',
      error: singleLineErrorSummary(fault.error),
    });
  }

  /** Unknown mutation outcomes must fence both future lookup and every retained reference to this authority. */
  #holdOperationControlIndeterminate(
    slot: EstablishedSlot,
    fault: Extract<ProviderProxyAuthorityFault, { kind: 'operation-control-failed' }>,
  ): void {
    slot.operationControlState = 'outcome-unknown';
    holdProviderProxyOperationControl(slot.authority);
    this.#removeRoute(slot);
    this.#armObservedOperatorExitGate(slot);
    const decision: ProviderProxySetContainmentRefusedDecision = {
      action: 'preserve',
      reason: 'containment_refused_live_claims',
      liveClaims: this.#deps.claims.claimsFor(slot.identity).length,
      setIdentity: slot.identity,
      refusedDecision: {
        reason: 'operation_control_indeterminate',
        fault: 'operation-control-failed',
        policy: fault.policy,
        error: singleLineErrorSummary(fault.error),
      },
    };
    this.#recordDecision(slot, decision);
  }

  #drainDecision(
    slot: EstablishedSlot,
    reason: ProviderProxySetClaimBearingRetirementReason,
    liveClaims: number,
  ): ProviderProxySetDrainDecision {
    return {
      action: 'drain',
      reason,
      liveClaims,
      setIdentity: slot.identity,
    };
  }

  #retirementStopDecision(
    slot: EstablishedSlot,
    reason: ProviderProxySetRetirementReason,
    liveClaims: 0,
  ): ProviderProxySetRetirementStopDecision {
    return {
      action: 'stop-and-reap',
      reason,
      liveClaims,
      setIdentity: slot.identity,
    };
  }

  #runContainmentAttempt(
    slot: EstablishedSlot | Extract<ProviderProxySetSlot, { kind: 'capsule-recovering' }>,
    decision: ProviderProxySetContainmentDecision,
  ): void {
    const capsuleRecovery = slot.kind === 'capsule-recovering';
    if (
      this.#slots.get(slot.key) !== slot ||
      (capsuleRecovery
        ? slot.recoveryPhase !== 'containment-wait'
        : slot.kind !== 'containing' && slot.kind !== 'containment-wait')
    ) {
      return;
    }
    if (!capsuleRecovery) slot.kind = 'containing';
    slot.attemptToken += 1;
    const token = slot.attemptToken;
    const abort = new AbortController();
    if (slot.kind === 'capsule-recovering') slot.attemptAbort = abort;
    else slot.containmentAttemptAbort = abort;
    const dispatcher = this.#deps.recoveryDispatcher;
    let committedAbsenceReceipt: string | null = null;
    let committedAbsenceProof: ProviderProxySetFencedContainmentProof | null = null;
    const releaseCommittedAbsenceProof = (): void => {
      if (committedAbsenceProof === null) return;
      releaseProviderProxySetContainmentProofFence(committedAbsenceProof);
      committedAbsenceProof = null;
    };
    const settleCommittedAbsence = (): void => {
      if (committedAbsenceReceipt === null || committedAbsenceProof === null) return;
      const proof = committedAbsenceProof;
      const currentness = verifyProviderProxySetContainmentProofCurrent(proof, slot.identity);
      committedAbsenceProof = null;
      if (currentness.kind !== 'current') {
        releaseProviderProxySetContainmentProofFence(proof);
        return;
      }
      this.#finishContainmentAttempt(slot, decision, token, abort, committedAbsenceReceipt, proof);
    };
    abort.signal.addEventListener('abort', releaseCommittedAbsenceProof, { once: true });
    const turn = dispatcher.begin(
      'containment-attempt',
      { setIdentity: slot.identity },
      {
        evidence: (value, sourceId) => {
          if (this.#slots.get(slot.key) !== slot || token !== slot.attemptToken) {
            this.#releaseLateReattachmentEvidence(value, sourceId);
            return;
          }
          if (sourceId === 'stop-and-reap') {
            const outcome = value as ContainmentCommitOutcome;
            if (outcome.kind === 'containment-absent') {
              if (slot.kind !== 'capsule-recovering') slot.containmentCommitStatus = null;
              committedAbsenceReceipt = outcome.disappearanceReceipt;
              settleCommittedAbsence();
              return;
            }
            // `not-sent` proves the commit did not latch; `outcome-unknown` proves only that it may have.
            // Neither ends this attempt: the retry above and the independent `absence` source both keep
            // running, and this coordinator retains reconciliation ownership until one of them, an accepted
            // successor, or the operator override resolves it.
            if (slot.kind !== 'capsule-recovering' && decision.action === 'stop-and-reap') {
              const aggregateOutcome =
                slot.containmentCommitStatus === 'outcome-unknown' ? 'outcome-unknown' : outcome.kind;
              slot.containmentCommitStatus = aggregateOutcome;
              this.#recordContainmentCommitOutcome(slot, decision, aggregateOutcome);
            }
            return;
          }
          const proof = value as ProviderProxySetFencedContainmentProof;
          const evidence = providerProxySetContainmentEvidenceFor(proof, slot.identity);
          if (evidence.kind === 'reap-required') {
            void this.#trackDestructiveAttempt(
              slot,
              this.#reapRecordedContainment(slot.identity, proof, abort.signal, () => undefined),
            ).then(
              (outcome) =>
                this.#finishContainmentAttempt(
                  slot,
                  decision,
                  token,
                  abort,
                  outcome.kind === 'containment-absent' ? outcome.disappearanceReceipt : null,
                  outcome.kind === 'containment-absent' ? proof : null,
                ),
              (error: unknown) => {
                if (this.#slots.get(slot.key) === slot && token === slot.attemptToken) {
                  this.#deps.onError?.(`Provider containment reap failed: ${singleLineErrorSummary(error)}`);
                }
              },
            );
          } else {
            if (!capsuleRecovery && decision.action === 'stop-and-reap') {
              committedAbsenceProof = proof;
              settleCommittedAbsence();
              return;
            }
            releaseProviderProxySetContainmentProofFence(proof);
            if (!capsuleRecovery) return;
            // A result that did not establish absence must not end the attempt while a destructive source may
            // still establish it.
            this.#finishContainmentAttempt(slot, decision, token, abort, null);
          }
        },
        retry: (retry) => {
          this.#deps.onError?.(`Provider containment source '${retry.producerId}' is temporarily unavailable.`);
        },
        fatal: () => undefined,
        disposeLateEvidence: (value, sourceId) => this.#releaseLateReattachmentEvidence(value, sourceId),
      },
    );
    const requestedWakeMs = this.#deps.time.now() + CONTAINMENT_ATTEMPT_MS;
    slot.retryTimer = this.#deps.time.setTimeout(() => {
      slot.retryTimer = null;
      this.#recordLateness('containment-attempt-deadline', requestedWakeMs);
      releaseCommittedAbsenceProof();
      turn.cancel(new Error('provider_proxy_containment_attempt_deadline'));
      this.#finishContainmentAttempt(slot, decision, token, abort, null);
    }, CONTAINMENT_ATTEMPT_MS);
    slot.retryTimer.unref?.();
    if (decision.action === 'stop-and-reap') {
      if (slot.kind === 'capsule-recovering') throw new Error('provider_proxy_containment_authority_missing');
      turn.start({
        sourceId: 'stop-and-reap',
        producerId: 'role-control',
        input: {
          signal: abort.signal,
          run: (signal) =>
            this.#trackDestructiveAttempt(
              slot,
              (slot.containmentAuthority ?? slot.authority).commitContainment(signal),
            ),
        },
        abort: (reason) => abort.abort(reason),
      });
    }
    turn.start({
      sourceId: 'absence',
      producerId: 'containment-proof',
      input: { identity: slot.identity, signal: abort.signal },
      abort: (reason) => abort.abort(reason),
    });
  }

  #finishContainmentAttempt(
    slot: EstablishedSlot | Extract<ProviderProxySetSlot, { kind: 'capsule-recovering' }>,
    decision: ProviderProxySetContainmentDecision,
    token: number,
    abort: AbortController,
    receipt: string | null,
    mutationProof: ProviderProxySetFencedContainmentProof | null = null,
  ): void {
    if (this.#slots.get(slot.key) !== slot || token !== slot.attemptToken) {
      if (mutationProof !== null) releaseProviderProxySetContainmentProofFence(mutationProof);
      return;
    }
    slot.attemptToken += 1;
    abort.abort();
    if (slot.kind === 'capsule-recovering') {
      if (slot.attemptAbort === abort) slot.attemptAbort = null;
    } else if (slot.containmentAttemptAbort === abort) {
      slot.containmentAttemptAbort = null;
    }
    if (slot.retryTimer !== null) {
      this.#deps.time.clearTimeout(slot.retryTimer);
      slot.retryTimer = null;
    }
    slot.completedAttempts += 1;
    if (receipt !== null) {
      this.#containmentAbsent(slot.identity, receipt, mutationProof);
      return;
    }
    if (slot.kind === 'capsule-recovering') slot.recoveryPhase = 'containment-wait';
    else slot.kind = 'containment-wait';
    const delayMs = retryDelayMs(slot.completedAttempts);
    const requestedRetryMs = this.#deps.time.now() + delayMs;
    slot.retryTimer = this.#deps.time.setTimeout(() => {
      slot.retryTimer = null;
      this.#recordLateness('containment-retry', requestedRetryMs);
      this.#runContainmentAttempt(slot, decision);
    }, delayMs);
    slot.retryTimer.unref?.();
  }

  #deliverRepresentationRelease(slot: ReleaseDeliveryPendingSlot, operation: OperationIdentity): void {
    if (slot.kind === 'absence-delivery-pending') {
      this.#deliverDisappearance(slot, operation);
      return;
    }
    this.#deliverAbandonment(slot, operation);
  }

  #deliverDisappearance(slot: AbsenceDeliveryPendingSlot, operation: OperationIdentity): void {
    const turn = this.#deps.recoveryDispatcher.begin(
      'disappearance-delivery',
      { operation, setIdentity: slot.identity },
      this.#representationReleaseSinks(slot, operation),
    );
    turn.start({
      sourceId: 'delivery',
      producerId: 'disappearance-consumer',
      input: {
        notice: {
          operation,
          setIdentity: slot.identity,
          disappearanceReceipt: slot.releaseEvidence.receipt,
        } satisfies ContainmentDisappearanceNotice,
        ...(slot.mutationProof === null ? {} : { mutationProof: slot.mutationProof }),
      },
    });
  }

  #deliverAbandonment(
    slot: Extract<ReleaseDeliveryPendingSlot, { kind: 'abandonment-delivery-pending' }>,
    operation: OperationIdentity,
  ): void {
    const turn = this.#deps.recoveryDispatcher.begin(
      'representation-abandonment-delivery',
      { operation, setIdentity: slot.identity },
      this.#representationReleaseSinks(slot, operation),
    );
    turn.start({
      sourceId: 'delivery',
      producerId: 'representation-abandonment-consumer',
      input: {
        notice: { operation, setIdentity: slot.identity } satisfies ProviderRepresentationAbandonmentNotice,
        ...(slot.mutationProof === null ? {} : { mutationProof: slot.mutationProof }),
      },
    });
  }

  #representationReleaseSinks(
    slot: ReleaseDeliveryPendingSlot,
    operation: OperationIdentity,
  ): ProviderProxyRecoveryTurnSinks {
    const currentDelivery = (): boolean =>
      this.#slots.get(slot.key) === slot &&
      slot.fatalSettlement === null &&
      slot.pendingOperations.has(operationKey(operation));
    return {
      evidence: () => {
        if (!currentDelivery()) return;
        this.#acceptRepresentationRelease(slot, operation);
      },
      retry: (retry) => {
        if (!currentDelivery()) return;
        this.#retainRepresentationRelease(
          slot,
          operation,
          retry.incident as
            | Extract<DisappearanceDeliveryAttemptOutcome, { kind: 'operational-failure' }>
            | Extract<RepresentationAbandonmentDeliveryAttemptOutcome, { kind: 'operational-failure' }>,
        );
      },
      fatal: (error) => {
        if (!currentDelivery()) return;
        this.#failRepresentationRelease(slot, operation, error);
      },
    };
  }

  #acceptRepresentationRelease(slot: ReleaseDeliveryPendingSlot, operation: OperationIdentity): void {
    if (this.#slots.get(slot.key) !== slot) return;
    const key = operationKey(operation);
    if (!slot.pendingOperations.delete(key)) return;
    const timer = slot.deliveryRetryTimers.get(key);
    if (timer !== undefined) this.#deps.time.clearTimeout(timer);
    slot.deliveryRetryTimers.delete(key);
    slot.initialDeliveries.set(key, { kind: 'accepted' });
    if (slot.pendingOperations.size === 0) {
      slot.claimDischarge ??= this.#durableClaimDischarge(slot.claimOperations);
      this.#startRetirement(slot);
    }
    this.#finishInitialDisposition(slot);
  }

  #retainRepresentationRelease(
    slot: ReleaseDeliveryPendingSlot,
    operation: OperationIdentity,
    outcome:
      | Extract<DisappearanceDeliveryAttemptOutcome, { kind: 'operational-failure' }>
      | Extract<RepresentationAbandonmentDeliveryAttemptOutcome, { kind: 'operational-failure' }>,
  ): void {
    const key = operationKey(operation);
    const nextAttemptAtMs = this.#deps.time.now() + 1_000;
    const incident: ContainmentAbsenceOperationalIncident =
      slot.kind === 'absence-delivery-pending'
        ? {
            stage: 'disappearance-delivery',
            operation,
            code: 'disappearance_consumer_unavailable',
            reason: outcome.reason,
            nextAttemptAtMs,
          }
        : {
            stage: 'representation-abandonment-delivery',
            operation,
            code: 'representation_abandonment_consumer_unavailable',
            reason: outcome.reason,
            nextAttemptAtMs,
          };
    slot.initialDeliveries.set(key, { kind: 'retry-owned', incident });
    this.#scheduleRepresentationReleaseRetry(slot, operation, nextAttemptAtMs);
    this.#finishInitialDisposition(slot);
  }

  #scheduleRepresentationReleaseRetry(
    slot: ReleaseDeliveryPendingSlot,
    operation: OperationIdentity,
    nextAttemptAtMs: number,
  ): void {
    if (slot.fatalSettlement !== null) return;
    const key = operationKey(operation);
    const previous = slot.deliveryRetryTimers.get(key);
    if (previous !== undefined) this.#deps.time.clearTimeout(previous);
    const timer = this.#deps.time.setTimeout(() => {
      slot.deliveryRetryTimers.delete(key);
      this.#recordLateness('containment-retry', nextAttemptAtMs);
      void this.#deliverRepresentationRelease(slot, operation);
    }, 1_000);
    timer.unref?.();
    slot.deliveryRetryTimers.set(key, timer);
  }

  #failRepresentationRelease(
    slot: ReleaseDeliveryPendingSlot,
    operation: OperationIdentity,
    error: ProviderProxySetLifecycleFatalError,
  ): ProviderProxyRepresentationReleaseFatalSettlement {
    const key = operationKey(operation);
    slot.initialDeliveries.set(key, { kind: 'fatal', error });
    const disposition = this.#settleFatalRepresentationRelease(slot, error);
    this.#rejectInitialDisposition(slot, disposition);
    return disposition;
  }

  #settleFatalRepresentationRelease(
    slot: ReleaseDeliveryPendingSlot,
    error: ProviderProxySetLifecycleFatalError,
  ): ProviderProxyRepresentationReleaseFatalSettlement {
    if (slot.fatalSettlement !== null) return slot.fatalSettlement;
    const successor: ProviderProxyRepresentationReleaseSuccessor = {
      owner: 'operator-command',
      acceptance: 'pending',
      inspectCommand: 'coral-cli backend status',
      actionCommand: `coral-cli backend provider-proxy-set abandon ${encodeProviderProxySetAddress(slot.address)}`,
    };
    slot.retirementState = 'fatal';
    slot.operatorExitNotBeforeMonotonicMs = this.#deps.time.monotonicNow();
    this.#clearRepresentationReleaseTimers(slot);
    const recording = this.#recordOperatorExitRefusal(
      slot,
      'operator_exit_representation_release_fatal',
      'operator-abandonment',
    );
    const disposition: ProviderProxyRepresentationReleaseFatalSettlement = {
      kind: 'fatal-successor-pending',
      error,
      successor,
      operatorDispositionRecording: recording,
    };
    slot.fatalSettlement = disposition;
    if (recording.kind === 'held') {
      this.#report(
        'warn',
        `Provider proxy set operator-exit refusal remains in memory because durable reporting failed set=${providerProxySetReference(slot.identity)} error=${recording.reason}`,
      );
    }
    slot.settleRepresentationRelease(disposition);
    return disposition;
  }

  #clearRepresentationReleaseTimers(slot: ReleaseDeliveryPendingSlot): void {
    for (const timer of slot.deliveryRetryTimers.values()) this.#deps.time.clearTimeout(timer);
    slot.deliveryRetryTimers.clear();
    if (slot.retirementTimer !== null) this.#deps.time.clearTimeout(slot.retirementTimer);
    slot.retirementTimer = null;
  }

  #rejectInitialDisposition(
    slot: ReleaseDeliveryPendingSlot,
    disposition: ProviderProxyRepresentationReleaseFatalSettlement,
  ): void {
    if (slot.initialDisposition.state !== 'pending') return;
    slot.initialDisposition.reject(disposition);
  }

  #startRetirement(slot: ReleaseDeliveryPendingSlot): void {
    if (
      this.#slots.get(slot.key) !== slot ||
      slot.fatalSettlement !== null ||
      slot.pendingOperations.size !== 0 ||
      slot.claimDischarge === null ||
      slot.retirementState !== 'not-ready'
    ) {
      return;
    }
    if (slot.capsulePath === null) {
      slot.retirementState = 'retired';
      this.#releaseRepresentationSlot(slot, this.#providerProxySetDischarge(slot));
      this.#finishInitialDisposition(slot);
      return;
    }
    slot.retirementState = 'initial-pending';
    void this.#attemptRetirement(slot);
  }

  #attemptRetirement(slot: ReleaseDeliveryPendingSlot): void {
    if (
      this.#slots.get(slot.key) !== slot ||
      slot.fatalSettlement !== null ||
      slot.pendingOperations.size !== 0 ||
      slot.capsulePath === null
    ) {
      return;
    }
    const dispatcher = this.#deps.recoveryDispatcher;
    const path = slot.capsulePath;
    const turn = dispatcher.begin(
      'capsule-retirement',
      { setIdentity: slot.identity },
      {
        evidence: () => {
          if (this.#slots.get(slot.key) !== slot || slot.fatalSettlement !== null) return;
          slot.retirementState = 'retired';
          this.#releaseRepresentationSlot(slot, this.#providerProxySetDischarge(slot));
          this.#finishInitialDisposition(slot);
        },
        retry: (retry) => {
          if (this.#slots.get(slot.key) !== slot || slot.fatalSettlement !== null) return;
          this.#recordRetirementOperationalFailure(slot, {
            kind: 'temporarily-unavailable',
            incident: retry.incident as Extract<
              CapsuleRetirementAttemptOutcome,
              { kind: 'temporarily-unavailable' }
            >['incident'],
          });
        },
        fatal: (error) => {
          if (this.#slots.get(slot.key) !== slot || slot.fatalSettlement !== null) return;
          this.#recordRetirementRetry(slot, { kind: 'fatal', error });
        },
      },
    );
    turn.start({ sourceId: 'retirement', producerId: 'capsule-retirement', input: { path } });
  }

  #recordRetirementOperationalFailure(
    slot: ReleaseDeliveryPendingSlot,
    outcome: Extract<CapsuleRetirementAttemptOutcome, { kind: 'temporarily-unavailable' }>,
  ): void {
    this.#recordRetirementRetry(slot, { kind: 'operational', reason: outcome.incident.kind });
  }

  #recordRetirementRetry(
    slot: ReleaseDeliveryPendingSlot,
    outcome:
      | Readonly<{ kind: 'operational'; reason: string }>
      | Readonly<{ kind: 'fatal'; error: ProviderProxySetLifecycleFatalError }>,
  ): void {
    const nextAttemptAtMs = this.#deps.time.now() + 1_000;
    if (outcome.kind === 'fatal') {
      const disposition = this.#settleFatalRepresentationRelease(slot, outcome.error);
      this.#rejectInitialDisposition(slot, disposition);
      return;
    }
    slot.retirementState = 'retry-owned';
    if (slot.retirementTimer !== null) this.#deps.time.clearTimeout(slot.retirementTimer);
    slot.retirementTimer = this.#deps.time.setTimeout(() => {
      slot.retirementTimer = null;
      this.#recordLateness('containment-retry', nextAttemptAtMs);
      this.#attemptRetirement(slot);
    }, 1_000);
    slot.retirementTimer.unref?.();
    this.#finishInitialDisposition(slot, {
      stage: 'capsule-retirement',
      code: 'capsule_retirement_unavailable',
      reason: outcome.reason,
      nextAttemptAtMs,
    });
  }

  #acceptFatalRepresentationReleaseSuccessor(slot: ReleaseDeliveryPendingSlot): void {
    if (this.#slots.get(slot.key) !== slot || slot.fatalSettlement === null) {
      throw new Error('provider_proxy_representation_release_successor_not_pending');
    }
    this.#clearRepresentationReleaseTimers(slot);
    this.#removeRepresentationSlot(slot);
  }

  #releaseRepresentationSlot(slot: ReleaseDeliveryPendingSlot, discharge: ProviderProxySetDischarge): void {
    if (this.#slots.get(slot.key) !== slot) return;
    const authorityMatches =
      slot.kind === 'absence-delivery-pending'
        ? discharge.kind === 'evidence-backed' && discharge.process === slot.releaseEvidence
        : discharge.kind === 'operator-abandoned' && discharge.abandonment === slot.releaseEvidence;
    if (!authorityMatches || discharge.claims !== slot.claimDischarge) {
      throw new Error('provider_proxy_set_discharge_mismatch');
    }
    this.#removeRepresentationSlot(slot);
    slot.settleRepresentationRelease({ kind: 'released' });
  }

  #removeRepresentationSlot(slot: ReleaseDeliveryPendingSlot): void {
    this.#slots.delete(slot.key);
    this.#deleteOperatorDispositions(slot.identity);
    this.#identityIndex.delete(slot.identity);
    for (const [address, path] of this.#capsuleAddresses) {
      if (path === slot.capsulePath) this.#capsuleAddresses.delete(address);
    }
    for (const [grantId, path] of this.#capsuleGrants) {
      if (path === slot.capsulePath) this.#capsuleGrants.delete(grantId);
    }
    if (slot.mutationProof !== null) releaseProviderProxySetContainmentProofFence(slot.mutationProof);
    if (slot.routeKey !== null) this.#deps.onSlotReleased?.(slot.routeKey);
  }

  #finishInitialDisposition(
    slot: ReleaseDeliveryPendingSlot,
    retirementIncident?: ContainmentAbsenceOperationalIncident,
  ): void {
    if (slot.initialDisposition.state !== 'pending') return;
    const deliveries = [...slot.initialDeliveries.values()];
    if (deliveries.some((delivery) => delivery.kind === 'initial-pending')) return;
    const incidents = deliveries.flatMap((delivery) => (delivery.kind === 'retry-owned' ? [delivery.incident] : []));
    if (retirementIncident !== undefined) incidents.push(retirementIncident);
    const [firstIncident, ...remainingIncidents] = incidents;
    if (firstIncident !== undefined) {
      slot.initialDisposition.resolve({
        kind: 'operational-retry-owned',
        exit: 'provider-proxy-set-release-retry',
        incidents: [firstIncident, ...remainingIncidents],
      });
      return;
    }
    if (slot.pendingOperations.size > 0 || slot.retirementState === 'initial-pending') return;
    if (slot.retirementState === 'not-ready') {
      this.#startRetirement(slot);
      return;
    }
    if (slot.retirementState === 'retired') slot.initialDisposition.resolve({ kind: 'completed' });
  }

  #recordLateness(stage: ProviderProxySetLifecycleProgressViolation['stage'], requestedWakeMs: number): void {
    const observedWakeMs = this.#deps.time.now();
    const latenessMs = observedWakeMs - requestedWakeMs;
    if (latenessMs <= 0) return;
    this.#deps.onProgressPremiseViolation?.({ stage, requestedWakeMs, observedWakeMs, latenessMs });
  }
}
