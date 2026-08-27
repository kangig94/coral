import type { TimePort, TimerHandle } from '../../../infra/port-types.js';
import type { ProcessIncarnation, RecordedProcessObserver } from '../../../infra/node-process.js';
import { errorMessage } from '../../../infra/error-format.js';
import type { OperationIdentity } from '../../../provider-proxy/protocol.js';
import {
  applyAnswer,
  applyLocalFailure,
  applyNoResponse,
  type HeartbeatEvidenceWindow,
} from '../../../provider-proxy/heartbeat-observation.js';
import { type HandoffCapsule, type HandoffCapsuleV3 } from '../../../provider-proxy/handoff-capsule.js';
import type { DurableProviderProxyOperationAuthority } from '../../live/provider-proxy/operation-route.js';
import type { ProviderHandoffCapsuleRetirementOutcome } from '../provider-proxy-capsule-discovery.js';
import { classifyProviderProxySetInheritance, type ProviderProxySetRedemptionOutcome } from './inheritance.js';
import type {
  ContainmentDisappearanceNotice,
  DisappearanceDeliveryAttemptOutcome,
} from '../provider-containment-disappearance.js';
import type { ProviderProxySetClaimMirror } from './claim-mirror.js';
import type {
  ProviderProxyAuthorityFault,
  ProviderProxyAuthorityObservation,
  ProviderProxyHeartbeatObservation,
} from '../provider-proxy-authority-fault.js';
import type {
  ProviderProxyForeignCapsuleRetirementRetryIncident,
  ProviderProxyRecoveryDispatcher,
  ProviderProxySetLifecycleFatalError,
} from '../provider-proxy-recovery-policy.js';
import {
  renderProviderProxySetDecision,
  type ProviderProxySetAuthorityStopDecision,
  type ProviderProxySetClaimBearingRetirementReason,
  type ProviderProxySetContainmentDecision,
  type ProviderProxySetDecision,
  type ProviderProxySetDrainDecision,
  type ProviderProxySetHeartbeatAwaitAbsenceDecision,
  type ProviderProxySetHeartbeatHoldExhaustedStopDecision,
  type ProviderProxySetLogSeverity,
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
  type ProviderProxySetAddress,
  type ProviderProxySetIdentity,
  type ProviderProxySetKey,
} from './identity.js';

export const MAX_COORDINATOR_PROXY_SET_SLOTS = 4;
const CONTAINMENT_ATTEMPT_MS = 30_000;

declare const processContainmentEvidenceBrand: unique symbol;
declare const durableClaimDischargeBrand: unique symbol;
declare const providerProxySetDischargeBrand: unique symbol;

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

export type ProviderProxySetDischarge = Readonly<{
  process: ProcessContainmentEvidence;
  claims: DurableClaimDischarge;
}> &
  Readonly<{ [providerProxySetDischargeBrand]: true }>;

type CapacityClass = 'retained' | 'excess';
type EstablishmentIntent = 'serve' | 'contain-unclaimed-discovery';

type PreserveReportState = {
  decision: ProviderProxySetPreserveDecision;
  lastReportedAtMs: number;
  suppressed: number;
  recoveryTimer: TimerHandle | null;
};

type EstablishedSlot = {
  kind: 'available' | 'draining' | 'containing' | 'containment-wait';
  key: ProviderProxySetKey;
  identity: ProviderProxySetIdentity;
  address: ProviderProxySetAddress;
  capacityClass: CapacityClass;
  authority: DurableProviderProxyOperationAuthority;
  routeKey: string | null;
  capsulePath: string | null;
  completedAttempts: number;
  attemptToken: number;
  retryTimer: TimerHandle | null;
  retirementDecision: ProviderProxySetDrainDecision | null;
  preserveReports: Map<string, PreserveReportState>;
  heartbeatEvidenceWindows: Map<string, HeartbeatEvidenceWindow>;
  heartbeatHoldBound: DurableProviderProxyOperationAuthority['autonomousDeadline']['heartbeatHoldBound'];
};

type ProviderProxySetSlot =
  | {
      kind: 'acquiring';
      slotId: string;
      routeKey: string;
      address: ProviderProxySetAddress | null;
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
      key: ProviderProxySetKey;
      identity: ProviderProxySetIdentity;
      address: ProviderProxySetAddress;
      capacityClass: CapacityClass;
      capsulePath: string | null;
    }
  | EstablishedSlot
  | {
      kind: 'absence-delivery-pending';
      key: ProviderProxySetKey;
      identity: ProviderProxySetIdentity;
      address: ProviderProxySetAddress;
      capacityClass: CapacityClass;
      processEvidence: ProcessContainmentEvidence;
      claimOperations: readonly OperationIdentity[];
      claimDischarge: DurableClaimDischarge | null;
      pendingOperations: Map<string, OperationIdentity>;
      initialDeliveries: Map<string, AbsenceDeliveryState>;
      deliveryRetryTimers: Map<string, TimerHandle>;
      capsulePath: string | null;
      routeKey: string | null;
      retirementState: 'not-ready' | 'initial-pending' | 'retry-owned' | 'retired' | 'fatal';
      retirementTimer: TimerHandle | null;
      initialDisposition: InitialDispositionLatch;
    };

type AbsenceDeliveryPendingSlot = Extract<ProviderProxySetSlot, { kind: 'absence-delivery-pending' }>;

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
      authorityToClose: DurableProviderProxyOperationAuthority | null;
    }>;

export type ProviderProxySetLifecycleSnapshot = Readonly<{
  startupDiscoveryCompleted: boolean;
  represented: number;
  available: number;
  states: readonly ProviderProxySetSlot['kind'][];
  pendingOperationCounts: readonly number[];
  operatorDispositions: readonly ProviderProxySetOperatorDisposition[];
}>;

export type ProviderProxySetOperatorDisposition = Readonly<{
  setIdentity: ProviderProxySetAddress;
  disposition: 'held' | 'awaiting-containment-absence';
  role?: string;
  method?: string;
  incidentReason: string;
  waitingFor: 'heartbeat-evidence-window' | 'independent-containment-absence';
}>;

export type ProviderProxySetLifecycleProgressViolation = Readonly<{
  stage: 'containment-attempt-deadline' | 'containment-retry';
  requestedWakeMs: number;
  observedWakeMs: number;
  latenessMs: number;
}>;

export type CapsuleRetirementAttemptOutcome = ProviderHandoffCapsuleRetirementOutcome;

export type ContainmentAbsenceOperationalIncident = Readonly<{
  stage: 'disappearance-delivery' | 'capsule-retirement';
  operation?: OperationIdentity;
  code: 'disappearance_consumer_unavailable' | 'capsule_retirement_unavailable';
  reason: string;
  nextAttemptAtMs: number;
}>;

export type ContainmentAbsenceInitialDisposition =
  | Readonly<{ kind: 'completed' }>
  | Readonly<{
      kind: 'operational-retry-owned';
      incidents: readonly ContainmentAbsenceOperationalIncident[];
    }>;

export type ContainmentAbsenceAcceptance = Readonly<{
  kind: 'accepted';
  disappearanceReceipt: string;
  initialDisposition: Promise<ContainmentAbsenceInitialDisposition>;
}>;

type InitialDispositionLatch = {
  state: 'pending' | 'resolved' | 'rejected';
  readonly promise: Promise<ContainmentAbsenceInitialDisposition>;
  resolve(value: ContainmentAbsenceInitialDisposition): void;
  reject(error: ProviderProxySetLifecycleFatalError): void;
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

const PRESERVE_REPORT_INTERVAL_MS = 60_000;
const MAX_PRESERVE_REPORTS_PER_SET = 32;

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
    state: 'pending',
    promise,
    resolve: (value) => {
      if (latch.state !== 'pending') return;
      latch.state = 'resolved';
      accept(value);
    },
    reject: (error) => {
      if (latch.state !== 'pending') return;
      latch.state = 'rejected';
      refuse(error);
    },
  };
  return latch;
}

export class ProviderProxySetLifecycle {
  readonly #deps: ProviderProxySetLifecycleDeps;
  readonly #identityIndex = new ProviderProxySetIdentityIndex();
  readonly #slots = new Map<string, ProviderProxySetSlot>();
  readonly #routeIndex = new Map<string, ProviderProxySetKey>();
  readonly #capsuleAddresses = new Map<string, string>();
  readonly #capsuleGrants = new Map<string, string>();
  readonly #foreignRetirementOwners = new Map<string, ForeignCapsuleRetirementOwner>();
  readonly #operatorDispositions = new Map<string, ProviderProxySetOperatorDisposition>();
  #nextSlotId = 1;
  #startupDiscoveryCompleted = false;

  constructor(deps: ProviderProxySetLifecycleDeps) {
    this.#deps = deps;
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
          ((slot.kind === 'available' ||
            slot.kind === 'draining' ||
            slot.kind === 'containing' ||
            slot.kind === 'containment-wait' ||
            slot.kind === 'absence-delivery-pending') &&
            slot.routeKey === routeKey),
      )
    ) {
      return { kind: 'already-represented' };
    }
    if (
      binding !== undefined &&
      [...this.#slots.values()].some(
        (slot) =>
          slot.kind !== 'acquiring' &&
          slot.kind !== 'capsule-foreign' &&
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
    this.#slots.set(slotId, { kind: 'acquiring', slotId, routeKey, address: null });
    return { kind: 'accepted', slotId };
  }

  acquisitionFailed(slotId: string): void {
    const slot = this.#slots.get(slotId);
    if (slot?.kind === 'acquiring') this.#slots.delete(slotId);
  }

  acquisitionSucceeded(
    slotId: string,
    authority: DurableProviderProxyOperationAuthority,
    capsulePath: string | null = null,
  ): void {
    const acquiring = this.#slots.get(slotId);
    if (acquiring?.kind !== 'acquiring') throw new Error('provider_proxy_set_acquisition_slot_missing');
    this.#slots.delete(slotId);
    this.#establish(authority, acquiring.routeKey, capsulePath, 'serve');
  }

  registerInheritedSet(authority: DurableProviderProxyOperationAuthority, capsulePath: string | null = null): void {
    this.#establish(authority, null, capsulePath, 'serve');
  }

  routeFor(routeKey: string): DurableProviderProxyOperationAuthority | null {
    const key = this.#routeIndex.get(routeKey);
    if (key === undefined) return null;
    const slot = this.#slots.get(key);
    return slot?.kind === 'available' && slot.capacityClass === 'retained' ? slot.authority : null;
  }

  authorityFor(identity: ProviderProxySetIdentity): DurableProviderProxyOperationAuthority | null {
    const slot = this.#slots.get(providerProxySetKey(identity));
    if (
      slot === undefined ||
      slot.kind === 'acquiring' ||
      slot.kind === 'capsule-recovering' ||
      slot.kind === 'capsule-foreign' ||
      slot.kind === 'recovering' ||
      slot.kind === 'containing' ||
      slot.kind === 'containment-wait' ||
      slot.kind === 'absence-delivery-pending' ||
      !providerProxySetIdentitiesEqual(slot.identity, identity)
    ) {
      return null;
    }
    return slot.authority;
  }

  liveSets(): readonly DurableProviderProxyOperationAuthority[] {
    return [...this.#slots.values()].flatMap((slot) =>
      slot.kind === 'available' ||
      slot.kind === 'draining' ||
      slot.kind === 'containing' ||
      slot.kind === 'containment-wait'
        ? [slot.authority]
        : [],
    );
  }

  beginGracefulDrain(identity: ProviderProxySetIdentity): void {
    const slot = this.#slots.get(providerProxySetKey(identity));
    if (slot?.kind !== 'available') return;
    this.#retireAvailableSlot(slot, 'graceful_idle');
  }

  claimsChanged(identity: ProviderProxySetIdentity): void {
    const slot = this.#slots.get(providerProxySetKey(identity));
    if (slot?.kind !== 'draining' || slot.retirementDecision === null) return;
    const liveClaims = this.#deps.claims.claimsFor(slot.identity).length;
    if (liveClaims !== 0) return;
    this.#beginRetirementContainment(
      slot,
      this.#retirementStopDecision(slot, slot.retirementDecision.reason, liveClaims),
    );
  }

  recordAuthorityIncident(identity: ProviderProxySetIdentity, incident: ProviderProxyAuthorityObservation): void {
    const slot = this.#slots.get(providerProxySetKey(identity));
    if (
      slot === undefined ||
      slot.kind === 'acquiring' ||
      slot.kind === 'capsule-recovering' ||
      slot.kind === 'capsule-foreign' ||
      slot.kind === 'recovering' ||
      slot.kind === 'absence-delivery-pending' ||
      slot.kind === 'containing' ||
      slot.kind === 'containment-wait'
    ) {
      return;
    }
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

  #faultAuthority(identity: ProviderProxySetIdentity, fault: ProviderProxyAuthorityFault): void {
    const slot = this.#slots.get(providerProxySetKey(identity));
    if (
      slot === undefined ||
      slot.kind === 'acquiring' ||
      slot.kind === 'capsule-recovering' ||
      slot.kind === 'capsule-foreign' ||
      slot.kind === 'recovering'
    ) {
      return;
    }
    if (slot.kind === 'absence-delivery-pending' || slot.kind === 'containing' || slot.kind === 'containment-wait') {
      return;
    }
    this.#beginFaultContainment(slot, this.#authorityFaultDecision(slot, fault));
  }

  containmentAbsent(identity: ProviderProxySetIdentity, disappearanceReceipt: string): ContainmentAbsenceAcceptance {
    const processEvidence = this.#processContainmentEvidence(disappearanceReceipt);
    const commit = this.#commitContainmentAbsence(identity, processEvidence);
    if (commit.kind === 'unchanged') return this.#absenceAcceptance(commit.pending);
    const { pending, authorityToClose } = commit;
    this.#report(
      'info',
      `Provider proxy containment disappeared set=${providerProxySetReference(pending.identity)} receipt=${JSON.stringify(disappearanceReceipt).slice(1, -1)}`,
    );

    if (authorityToClose !== null) {
      void authorityToClose
        .initiateControlClose()
        .catch((error: unknown) =>
          this.#deps.onError?.(
            `Provider proxy control close after containment failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
    }
    if (pending.pendingOperations.size === 0) {
      this.#startRetirement(pending);
    } else {
      for (const operation of pending.pendingOperations.values()) void this.#deliverDisappearance(pending, operation);
    }
    return this.#absenceAcceptance(pending);
  }

  #absenceAcceptance(slot: AbsenceDeliveryPendingSlot): ContainmentAbsenceAcceptance {
    return {
      kind: 'accepted',
      disappearanceReceipt: slot.processEvidence.receipt,
      initialDisposition: slot.initialDisposition.promise,
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

  #providerProxySetDischarge(slot: AbsenceDeliveryPendingSlot): ProviderProxySetDischarge {
    if (slot.claimOperations.length === 0) {
      slot.claimDischarge = this.#noLiveClaimsDischarge(slot.identity);
    }
    if (slot.claimDischarge === null) throw new Error('provider_proxy_claim_discharge_missing');
    return Object.freeze({
      process: slot.processEvidence,
      claims: slot.claimDischarge,
    }) as ProviderProxySetDischarge;
  }

  #commitContainmentAbsence(
    identity: ProviderProxySetIdentity,
    processEvidence: ProcessContainmentEvidence,
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
      if (slot.processEvidence.receipt !== processEvidence.receipt) {
        throw new Error('provider_proxy_containment_absence_conflict');
      }
      return { kind: 'unchanged', pending: slot };
    }
    if (slot.kind === 'available' || slot.kind === 'draining') {
      throw new Error('provider_proxy_containment_absence_before_authority_fault');
    }

    const claimOperations = this.#deps.claims.claimsFor(slot.identity).map((claim) => claim.operation);
    const pendingOperations = new Map(claimOperations.map((operation) => [operationKey(operation), operation]));
    const initialDeliveries = new Map(
      [...pendingOperations.keys()].map((key) => [key, { kind: 'initial-pending' } as const]),
    );
    const pending: AbsenceDeliveryPendingSlot = {
      kind: 'absence-delivery-pending',
      key: slot.key,
      identity: slot.identity,
      address: slot.address,
      capacityClass: slot.capacityClass,
      processEvidence,
      claimOperations,
      claimDischarge: claimOperations.length === 0 ? this.#noLiveClaimsDischarge(slot.identity) : null,
      pendingOperations,
      initialDeliveries,
      deliveryRetryTimers: new Map(),
      capsulePath: slot.capsulePath,
      routeKey: slot.kind === 'recovering' || slot.kind === 'capsule-recovering' ? null : slot.routeKey,
      retirementState: 'not-ready',
      retirementTimer: null,
      initialDisposition: createInitialDispositionLatch(),
    };
    if (slot.kind === 'capsule-recovering') {
      slot.attemptToken += 1;
      slot.attemptAbort?.abort();
      if (slot.retryTimer !== null) this.#deps.time.clearTimeout(slot.retryTimer);
    } else if (slot.kind !== 'recovering') {
      slot.attemptToken += 1;
      if (slot.retryTimer !== null) this.#deps.time.clearTimeout(slot.retryTimer);
    }
    const authorityToClose = slot.kind === 'recovering' || slot.kind === 'capsule-recovering' ? null : slot.authority;
    this.#slots.set(key, pending);
    return { kind: 'committed', pending, authorityToClose };
  }

  snapshot(): ProviderProxySetLifecycleSnapshot {
    const slots = [...this.#slots.values()];
    return {
      startupDiscoveryCompleted: this.#startupDiscoveryCompleted,
      represented: slots.length,
      available: slots.filter((slot) => slot.kind === 'available').length,
      states: slots.map((slot) => slot.kind),
      pendingOperationCounts: slots.flatMap((slot) =>
        slot.kind === 'absence-delivery-pending' ? [slot.pendingOperations.size] : [],
      ),
      operatorDispositions: [...this.#operatorDispositions.values()],
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
      if (claimSlot?.kind !== 'recovering' || !providerProxySetCapsuleMatchesIdentity(capsule, claimSlot.identity)) {
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
    this.#slots.set(key, {
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
    });
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
          if (this.#slots.get(slot.key) !== slot || slot.attemptToken !== token) return;
          abort.abort();
          slot.attemptAbort = null;
          if (sourceId === 'redemption') {
            const outcome = value as Exclude<ProviderProxySetRedemptionOutcome, { kind: 'temporarily-unavailable' }>;
            if (outcome.kind === 'protocol-incompatible') {
              this.#dispositionProtocolIncompatibleCapsule(slot, outcome.role, outcome.method);
              return;
            }
            this.#slots.delete(slot.key);
            this.#identityIndex.delete(slot.identity);
            this.#establish(outcome.set, null, slot.capsulePath, 'contain-unclaimed-discovery');
            return;
          }
          void this.containmentAbsent(slot.identity, value as string);
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
    routeKey: string | null,
    capsulePath: string | null,
    intent: EstablishmentIntent,
  ): void {
    const identity = authority.setIdentity;
    const key = this.#identityIndex.add(identity);
    const existing = this.#slots.get(key);
    if (existing !== undefined && existing.kind !== 'recovering') {
      if (
        (existing.kind === 'available' ||
          existing.kind === 'draining' ||
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
      key,
      identity,
      address: providerProxySetAddress(identity),
      capacityClass: existing?.capacityClass ?? 'retained',
      authority,
      routeKey,
      capsulePath: capsulePath ?? existing?.capsulePath ?? null,
      completedAttempts: 0,
      attemptToken: 0,
      retryTimer: null,
      retirementDecision: null,
      preserveReports: new Map(),
      heartbeatEvidenceWindows: new Map(),
      heartbeatHoldBound: authority.autonomousDeadline.heartbeatHoldBound,
    };
    this.#slots.set(key, slot);
    authority.onFault((fault) => this.#faultAuthority(identity, fault));
    authority.onIncident((incident) => this.recordAuthorityIncident(identity, incident));
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
    slot.retirementDecision = null;
    this.#removeRoute(slot);
    slot.kind = 'containing';
    slot.authority.stopHeartbeats();
    void this.#runContainmentAttempt(slot, decision);
    if (decision.action === 'await-containment-absence') {
      void slot.authority.initiateControlClose().catch((error: unknown) => {
        this.#deps.onError?.(
          `Provider proxy control close before containment wait failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
  }

  #recordDecision(slot: EstablishedSlot, decision: ProviderProxySetDecision, errorIdentity?: string): void {
    this.#recordOperatorDisposition(decision);
    if (decision.action === 'preserve') {
      this.#recordPreserveDecision(slot, decision, errorIdentity ?? preserveErrorIdentity(decision.error));
      return;
    }
    this.#flushPreserveReports(slot);
    this.#reportDecision(decision);
  }

  #recordOperatorDisposition(decision: ProviderProxySetDecision): void {
    const key = providerProxySetKey(decision.setIdentity);
    if (decision.action === 'preserve' && decision.fault !== 'heartbeat-indeterminate') return;
    if (decision.action === 'drain') {
      this.#operatorDispositions.delete(key);
      return;
    }
    const role = 'role' in decision && typeof decision.role === 'string' ? decision.role : undefined;
    const method = 'method' in decision && typeof decision.method === 'string' ? decision.method : undefined;
    const incidentReason =
      'incidentReason' in decision && typeof decision.incidentReason === 'string'
        ? decision.incidentReason
        : 'lastIncidentReason' in decision && typeof decision.lastIncidentReason === 'string'
          ? decision.lastIncidentReason
          : 'terminalReason' in decision && typeof decision.terminalReason === 'string'
            ? decision.terminalReason
            : decision.reason;
    const shared = {
      setIdentity: providerProxySetAddress(decision.setIdentity),
      ...(role === undefined ? {} : { role }),
      ...(method === undefined ? {} : { method }),
      incidentReason,
    };
    if (decision.action === 'preserve') {
      this.#operatorDispositions.set(key, {
        ...shared,
        disposition: 'held',
        waitingFor: 'heartbeat-evidence-window',
      });
      return;
    }
    this.#operatorDispositions.set(key, {
      ...shared,
      disposition: 'awaiting-containment-absence',
      waitingFor: 'independent-containment-absence',
    });
  }

  #recordPreserveDecision(
    slot: EstablishedSlot,
    decision: ProviderProxySetPreserveDecision,
    errorIdentity: string,
  ): void {
    const now = this.#deps.time.now();
    const subject = decision.fault === 'operation-control-failed' ? decision.policy.method : decision.method;
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

  #applyHeartbeatDisposition(
    slot: EstablishedSlot,
    disposition: ProviderProxySetHeartbeatHoldExhaustedStopDecision | ProviderProxySetHeartbeatAwaitAbsenceDecision,
  ): void {
    if (disposition.action === 'stop-and-reap') {
      this.#beginFaultContainment(slot, disposition);
      return;
    }
    this.#beginContainment(slot, disposition);
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
        this.#recordHeartbeatAccepted(slot, incident.role, incident.method);
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
        // The heartbeat assembly reports this observation before it uses the existing terminal-fault latch.
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
        this.#answeredHeartbeatHoldExhaustedDecision(
          slot,
          incident,
          transition.window,
          transition.error,
          timing.nowMonotonicMs,
        ),
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
        this.#silenceHoldExhaustedDecision(slot, incident, transition.window, transition.error, timing.nowMonotonicMs),
      );
      return;
    }
    // No window state is written. The assembly follows this observation through the existing terminal-fault path.
    applyLocalFailure(observation);
  }

  /**
   * This decision requires a continuous answer-free window for the exact role and method, below the material
   * scheduler-lateness share. It may start dual-evidence containment but must not settle disappearance alone.
   */
  #silenceHoldExhaustedDecision(
    slot: EstablishedSlot,
    incident: ProviderProxyHeartbeatObservation,
    hold: Extract<HeartbeatEvidenceWindow, { kind: 'silence' }>,
    error: unknown,
    nowMonotonicMs: bigint,
  ): ProviderProxySetHeartbeatHoldExhaustedStopDecision {
    return {
      action: 'stop-and-reap',
      reason: 'heartbeat_hold_exhausted',
      fault: 'heartbeat-hold-exhausted',
      role: incident.role,
      method: incident.method,
      lastIncidentReason: 'unanswered',
      attempts: hold.attempts,
      schedulerLatenessMs: hold.schedulerLatenessAfterFirstObservationMs,
      // The decision's `elapsedMs` is log text, not authority, so this is the one place the monotonic span
      // leaves bigint for a plain millisecond count.
      elapsedMs: Number(nowMonotonicMs - hold.firstObservedAtMonotonicMs),
      error: singleLineErrorSummary(error),
      liveClaims: this.#deps.claims.claimsFor(slot.identity).length,
      setIdentity: slot.identity,
    };
  }

  #answeredHeartbeatHoldExhaustedDecision(
    slot: EstablishedSlot,
    incident: ProviderProxyHeartbeatObservation,
    hold: Extract<HeartbeatEvidenceWindow, { kind: 'answered-unusable' }>,
    error: unknown,
    nowMonotonicMs: bigint,
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
      elapsedMs: Number(nowMonotonicMs - hold.firstObservedAtMonotonicMs),
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

  #recordHeartbeatAccepted(
    slot: EstablishedSlot,
    role: ProviderProxyHeartbeatObservation['role'],
    method: ProviderProxyHeartbeatObservation['method'],
  ): void {
    const operatorKey = providerProxySetKey(slot.identity);
    const operatorDisposition = this.#operatorDispositions.get(operatorKey);
    if (
      operatorDisposition?.disposition === 'held' &&
      operatorDisposition.role === role &&
      operatorDisposition.method === method
    ) {
      this.#operatorDispositions.delete(operatorKey);
    }
    for (const [key, report] of slot.preserveReports) {
      if (
        report.decision.fault !== 'heartbeat-indeterminate' ||
        report.decision.role !== role ||
        report.decision.method !== method
      ) {
        continue;
      }
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
      case 'control-channel-fault':
        return { ...context, fault: fault.kind, role: fault.role };
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
    const dispatcher = this.#deps.recoveryDispatcher;
    const turn = dispatcher.begin(
      'containment-attempt',
      { setIdentity: slot.identity },
      {
        evidence: (value, sourceId) => {
          if (this.#slots.get(slot.key) !== slot || token !== slot.attemptToken) return;
          if (sourceId === 'stop-and-reap') {
            if (typeof value === 'object' && value !== null && 'disappearanceReceipt' in value) {
              this.#finishContainmentAttempt(
                slot,
                decision,
                token,
                abort,
                (value as { disappearanceReceipt: string }).disappearanceReceipt,
              );
            }
            return;
          }
          if (value !== null || capsuleRecovery) {
            this.#finishContainmentAttempt(slot, decision, token, abort, value as string | null);
          }
        },
        retry: (retry) => {
          this.#deps.onError?.(`Provider containment source '${retry.producerId}' is temporarily unavailable.`);
        },
        fatal: () => undefined,
      },
    );
    const requestedWakeMs = this.#deps.time.now() + CONTAINMENT_ATTEMPT_MS;
    slot.retryTimer = this.#deps.time.setTimeout(() => {
      slot.retryTimer = null;
      this.#recordLateness('containment-attempt-deadline', requestedWakeMs);
      turn.cancel(new Error('provider_proxy_containment_attempt_deadline'));
      this.#finishContainmentAttempt(slot, decision, token, abort, null);
    }, CONTAINMENT_ATTEMPT_MS);
    slot.retryTimer.unref?.();
    if (decision.action === 'stop-and-reap') {
      if (slot.kind === 'capsule-recovering') throw new Error('provider_proxy_containment_authority_missing');
      turn.start({
        sourceId: 'stop-and-reap',
        producerId: 'role-control',
        input: { signal: abort.signal, run: (signal) => slot.authority.stopAndReap(signal) },
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
  ): void {
    if (this.#slots.get(slot.key) !== slot || token !== slot.attemptToken) return;
    slot.attemptToken += 1;
    abort.abort();
    if (slot.retryTimer !== null) {
      this.#deps.time.clearTimeout(slot.retryTimer);
      slot.retryTimer = null;
    }
    slot.completedAttempts += 1;
    if (receipt !== null) {
      this.containmentAbsent(slot.identity, receipt);
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

  #deliverDisappearance(slot: AbsenceDeliveryPendingSlot, operation: OperationIdentity): void {
    const notice: ContainmentDisappearanceNotice = {
      operation,
      setIdentity: slot.identity,
      disappearanceReceipt: slot.processEvidence.receipt,
    };
    const currentDelivery = (): boolean =>
      this.#slots.get(slot.key) === slot && slot.pendingOperations.has(operationKey(operation));
    const turn = this.#deps.recoveryDispatcher.begin(
      'disappearance-delivery',
      { operation, setIdentity: slot.identity },
      {
        evidence: () => {
          if (!currentDelivery()) return;
          this.#acceptDisappearance(slot, operation);
        },
        retry: (retry) => {
          if (!currentDelivery()) return;
          this.#retainDisappearanceDelivery(
            slot,
            operation,
            retry.incident as Extract<DisappearanceDeliveryAttemptOutcome, { kind: 'operational-failure' }>,
          );
        },
        fatal: (error) => {
          if (!currentDelivery()) return;
          this.#failDisappearanceDelivery(slot, operation, error);
        },
      },
    );
    turn.start({
      sourceId: 'delivery',
      producerId: 'disappearance-consumer',
      input: { notice },
    });
  }

  #acceptDisappearance(slot: AbsenceDeliveryPendingSlot, operation: OperationIdentity): void {
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

  #retainDisappearanceDelivery(
    slot: AbsenceDeliveryPendingSlot,
    operation: OperationIdentity,
    outcome: Extract<DisappearanceDeliveryAttemptOutcome, { kind: 'operational-failure' }>,
  ): void {
    const key = operationKey(operation);
    const nextAttemptAtMs = this.#deps.time.now() + 1_000;
    const incident: ContainmentAbsenceOperationalIncident = {
      stage: 'disappearance-delivery',
      operation,
      code: outcome.code,
      reason: outcome.reason,
      nextAttemptAtMs,
    };
    slot.initialDeliveries.set(key, { kind: 'retry-owned', incident });
    const previous = slot.deliveryRetryTimers.get(key);
    if (previous !== undefined) this.#deps.time.clearTimeout(previous);
    const timer = this.#deps.time.setTimeout(() => {
      slot.deliveryRetryTimers.delete(key);
      this.#recordLateness('containment-retry', nextAttemptAtMs);
      void this.#deliverDisappearance(slot, operation);
    }, 1_000);
    timer.unref?.();
    slot.deliveryRetryTimers.set(key, timer);
    this.#finishInitialDisposition(slot);
  }

  #failDisappearanceDelivery(
    slot: AbsenceDeliveryPendingSlot,
    operation: OperationIdentity,
    error: ProviderProxySetLifecycleFatalError,
  ): void {
    const key = operationKey(operation);
    const timer = slot.deliveryRetryTimers.get(key);
    if (timer !== undefined) this.#deps.time.clearTimeout(timer);
    slot.deliveryRetryTimers.delete(key);
    slot.initialDeliveries.set(key, { kind: 'fatal', error });
    this.#rejectInitialDisposition(slot, error);
  }

  #startRetirement(slot: AbsenceDeliveryPendingSlot): void {
    if (
      this.#slots.get(slot.key) !== slot ||
      slot.pendingOperations.size !== 0 ||
      slot.claimDischarge === null ||
      slot.retirementState !== 'not-ready'
    ) {
      return;
    }
    if (slot.capsulePath === null) {
      slot.retirementState = 'retired';
      this.#releaseAbsenceSlot(slot, this.#providerProxySetDischarge(slot));
      this.#finishInitialDisposition(slot);
      return;
    }
    slot.retirementState = 'initial-pending';
    void this.#attemptRetirement(slot);
  }

  #attemptRetirement(slot: AbsenceDeliveryPendingSlot): void {
    if (this.#slots.get(slot.key) !== slot || slot.pendingOperations.size !== 0 || slot.capsulePath === null) return;
    const dispatcher = this.#deps.recoveryDispatcher;
    const path = slot.capsulePath;
    const turn = dispatcher.begin(
      'capsule-retirement',
      { setIdentity: slot.identity },
      {
        evidence: () => {
          if (this.#slots.get(slot.key) !== slot) return;
          slot.retirementState = 'retired';
          this.#releaseAbsenceSlot(slot, this.#providerProxySetDischarge(slot));
          this.#finishInitialDisposition(slot);
        },
        retry: (retry) => {
          if (this.#slots.get(slot.key) !== slot) return;
          this.#recordRetirementOperationalFailure(slot, {
            kind: 'temporarily-unavailable',
            incident: retry.incident as Extract<
              CapsuleRetirementAttemptOutcome,
              { kind: 'temporarily-unavailable' }
            >['incident'],
          });
        },
        fatal: (error) => {
          if (this.#slots.get(slot.key) !== slot) return;
          slot.retirementState = 'fatal';
          this.#rejectInitialDisposition(slot, error);
        },
      },
    );
    turn.start({ sourceId: 'retirement', producerId: 'capsule-retirement', input: { path } });
  }

  #recordRetirementOperationalFailure(
    slot: AbsenceDeliveryPendingSlot,
    outcome: Extract<CapsuleRetirementAttemptOutcome, { kind: 'temporarily-unavailable' }>,
  ): void {
    const nextAttemptAtMs = this.#deps.time.now() + 1_000;
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
      reason: outcome.incident.kind,
      nextAttemptAtMs,
    });
  }

  #releaseAbsenceSlot(slot: AbsenceDeliveryPendingSlot, discharge: ProviderProxySetDischarge): void {
    if (this.#slots.get(slot.key) !== slot) return;
    if (discharge.process !== slot.processEvidence || discharge.claims !== slot.claimDischarge) {
      throw new Error('provider_proxy_set_discharge_mismatch');
    }
    this.#slots.delete(slot.key);
    this.#operatorDispositions.delete(slot.key);
    this.#identityIndex.delete(slot.identity);
    for (const [address, path] of this.#capsuleAddresses) {
      if (path === slot.capsulePath) this.#capsuleAddresses.delete(address);
    }
    for (const [grantId, path] of this.#capsuleGrants) {
      if (path === slot.capsulePath) this.#capsuleGrants.delete(grantId);
    }
    if (slot.routeKey !== null) this.#deps.onSlotReleased?.(slot.routeKey);
  }

  #finishInitialDisposition(
    slot: AbsenceDeliveryPendingSlot,
    retirementIncident?: ContainmentAbsenceOperationalIncident,
  ): void {
    if (slot.initialDisposition.state !== 'pending') return;
    const deliveries = [...slot.initialDeliveries.values()];
    if (deliveries.some((delivery) => delivery.kind === 'initial-pending')) return;
    const incidents = deliveries.flatMap((delivery) => (delivery.kind === 'retry-owned' ? [delivery.incident] : []));
    if (retirementIncident !== undefined) incidents.push(retirementIncident);
    if (incidents.length > 0) {
      slot.initialDisposition.resolve({ kind: 'operational-retry-owned', incidents });
      return;
    }
    if (slot.pendingOperations.size > 0 || slot.retirementState === 'initial-pending') return;
    if (slot.retirementState === 'not-ready') {
      this.#startRetirement(slot);
      return;
    }
    if (slot.retirementState === 'retired') slot.initialDisposition.resolve({ kind: 'completed' });
  }

  #rejectInitialDisposition(slot: AbsenceDeliveryPendingSlot, error: ProviderProxySetLifecycleFatalError): void {
    if (slot.initialDisposition.state === 'rejected') return;
    slot.initialDisposition.reject(error);
  }

  #recordLateness(stage: ProviderProxySetLifecycleProgressViolation['stage'], requestedWakeMs: number): void {
    const observedWakeMs = this.#deps.time.now();
    const latenessMs = observedWakeMs - requestedWakeMs;
    if (latenessMs <= 0) return;
    this.#deps.onProgressPremiseViolation?.({ stage, requestedWakeMs, observedWakeMs, latenessMs });
  }
}
