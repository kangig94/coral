import type { TimePort, TimerHandle } from '../../infra/port-types.js';
import type { OperationIdentity } from '../../provider-proxy/protocol.js';
import type { HandoffCapsule, HandoffCapsuleV1, HandoffCapsuleV2 } from '../../provider-proxy/handoff-capsule.js';
import type { DurableProviderProxyOperationAuthority } from '../live/provider-proxy/operation-route.js';
import type { ProviderHandoffCapsuleRetirementOutcome } from './provider-proxy-capsule-discovery.js';
import type { ProviderProxySetRedemptionOutcome } from './provider-proxy-set-inheritance.js';
import type {
  ContainmentDisappearanceAcceptance,
  ProviderContainmentDisappearanceConsumer,
} from './provider-operation-reconciler.js';
import type { ProviderProxySetClaimMirror } from './provider-proxy-set-claim-mirror.js';
import {
  ProviderProxySetLifecycleFatalError,
  type ProviderProxyRecoveryDispatcher,
} from './provider-proxy-recovery-policy.js';
import {
  ProviderProxySetIdentityIndex,
  providerProxySetAddress,
  providerProxySetAddressKey,
  providerProxySetIdentitiesEqual,
  providerProxySetIdentityFromCapsule,
  providerProxySetKey,
  type ProviderProxySetAddress,
  type ProviderProxySetIdentity,
  type ProviderProxySetKey,
} from './provider-proxy-set-identity.js';

export const MAX_COORDINATOR_PROXY_SET_SLOTS = 4;
const CONTAINMENT_ATTEMPT_MS = 30_000;

type CapacityClass = 'retained' | 'excess';
type EstablishmentIntent = 'serve' | 'contain-unclaimed-discovery';

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
      capsuleBinding: HandoffCapsuleV2;
      address: ProviderProxySetAddress;
      capacityClass: CapacityClass;
      completedAttempts: number;
      retryTimer: TimerHandle | null;
      attemptToken: number;
      attemptAbort: AbortController | null;
    }
  | {
      kind: 'capsule-opaque';
      slotId: string;
      capsulePath: string;
      capsuleBinding: HandoffCapsuleV1;
      address: ProviderProxySetAddress;
      capacityClass: CapacityClass;
      completedAttempts: number;
      retryTimer: TimerHandle | null;
      attemptToken: number;
      attemptAbort: AbortController | null;
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
      disappearanceReceipt: string;
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
}>;

export type ProviderProxySetLifecycleProgressViolation = Readonly<{
  stage: 'containment-attempt-deadline' | 'containment-retry';
  requestedWakeMs: number;
  observedWakeMs: number;
  latenessMs: number;
}>;

export type DisappearanceDeliveryAttemptOutcome =
  | Readonly<{ kind: 'accepted'; acceptance: ContainmentDisappearanceAcceptance }>
  | Readonly<{
      kind: 'operational-failure';
      code: 'disappearance_consumer_unavailable';
      reason: string;
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
  claims: ProviderProxySetClaimMirror;
  controlEstablished(authority: DurableProviderProxyOperationAuthority): void;
  disappearanceConsumer: Readonly<{
    containmentDisappeared(
      notice: Parameters<ProviderContainmentDisappearanceConsumer['containmentDisappeared']>[0],
    ): Promise<DisappearanceDeliveryAttemptOutcome>;
  }>;
  time: Pick<TimePort, 'now' | 'setTimeout' | 'clearTimeout'>;
  recoveryDispatcher: ProviderProxyRecoveryDispatcher;
  onProgressPremiseViolation?: (violation: ProviderProxySetLifecycleProgressViolation) => void;
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

function retryDelayMs(completedAttempts: number): number {
  return Math.min(1_000 * 2 ** Math.min(Math.max(completedAttempts - 1, 0), 5), 30_000);
}

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

  installDiscoveredCapsules(capsules: readonly Readonly<{ path: string; capsule: HandoffCapsule }>[]): void {
    if (this.#startupDiscoveryCompleted) throw new Error('provider_proxy_capsule_discovery_already_completed');
    for (const discovered of capsules) this.#installDiscoveredCapsule(discovered.path, discovered.capsule);
    this.#classifyCapacity();
    this.#startupDiscoveryCompleted = true;
    for (const slot of this.#slots.values()) {
      if (slot.kind === 'capsule-recovering') this.#recoverExactCapsule(slot);
      if (slot.kind === 'capsule-opaque') void this.#redeemOpaqueCapsule(slot);
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
          slot.address.buildSetId === binding.buildSetId &&
          slot.address.hostFingerprint === binding.hostFingerprint,
      )
    ) {
      return { kind: 'already-represented' };
    }
    if (this.#slots.size + 1 > MAX_COORDINATOR_PROXY_SET_SLOTS) {
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
      slot.kind === 'capsule-opaque' ||
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
    slot.kind = 'draining';
    this.#removeRoute(slot);
    if (this.#deps.claims.claimsFor(slot.identity).length === 0) {
      this.#beginContainment(slot, 'graceful_idle');
    }
  }

  claimsChanged(identity: ProviderProxySetIdentity): void {
    const slot = this.#slots.get(providerProxySetKey(identity));
    if (slot?.kind === 'draining' && this.#deps.claims.claimsFor(slot.identity).length === 0) {
      this.#beginContainment(slot, 'graceful_idle');
    }
  }

  faultAuthority(identity: ProviderProxySetIdentity): void {
    const slot = this.#slots.get(providerProxySetKey(identity));
    if (
      slot === undefined ||
      slot.kind === 'acquiring' ||
      slot.kind === 'capsule-recovering' ||
      slot.kind === 'capsule-opaque' ||
      slot.kind === 'recovering'
    ) {
      return;
    }
    if (slot.kind === 'absence-delivery-pending' || slot.kind === 'containing' || slot.kind === 'containment-wait') {
      return;
    }
    this.#beginContainment(slot, 'provider_authority_lost');
  }

  containmentAbsent(identity: ProviderProxySetIdentity, disappearanceReceipt: string): ContainmentAbsenceAcceptance {
    const commit = this.#commitContainmentAbsence(identity, disappearanceReceipt);
    if (commit.kind === 'unchanged') return this.#absenceAcceptance(commit.pending);
    const { pending, authorityToClose } = commit;

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
      disappearanceReceipt: slot.disappearanceReceipt,
      initialDisposition: slot.initialDisposition.promise,
    };
  }

  #commitContainmentAbsence(
    identity: ProviderProxySetIdentity,
    disappearanceReceipt: string,
  ): ContainmentAbsenceCommit {
    const key = providerProxySetKey(identity);
    if (typeof disappearanceReceipt !== 'string' || disappearanceReceipt.length === 0) {
      throw new Error('provider_proxy_containment_absence_receipt_invalid');
    }
    const slot = this.#slots.get(key);
    if (slot === undefined) throw new Error('provider_proxy_containment_absence_slot_missing');
    if (
      slot.kind === 'acquiring' ||
      slot.kind === 'capsule-opaque' ||
      !providerProxySetIdentitiesEqual(slot.identity, identity)
    ) {
      throw new Error('provider_proxy_containment_absence_identity_mismatch');
    }
    if (slot.kind === 'absence-delivery-pending') {
      if (slot.disappearanceReceipt !== disappearanceReceipt) {
        throw new Error('provider_proxy_containment_absence_conflict');
      }
      return { kind: 'unchanged', pending: slot };
    }
    if (slot.kind === 'available' || slot.kind === 'draining') {
      throw new Error('provider_proxy_containment_absence_before_authority_fault');
    }

    const pendingOperations = new Map(
      this.#deps.claims.claimsFor(slot.identity).map((claim) => [operationKey(claim.operation), claim.operation]),
    );
    const initialDeliveries = new Map(
      [...pendingOperations.keys()].map((key) => [key, { kind: 'initial-pending' } as const]),
    );
    const pending: AbsenceDeliveryPendingSlot = {
      kind: 'absence-delivery-pending',
      key: slot.key,
      identity: slot.identity,
      address: slot.address,
      capacityClass: slot.capacityClass,
      disappearanceReceipt,
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
    };
  }

  #installDiscoveredCapsule(path: string, capsule: HandoffCapsule): void {
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

    const claimKey = this.#identityIndex.keyForAddress(address);
    if (claimKey !== null) {
      const claimSlot = this.#slots.get(claimKey);
      if (claimSlot?.kind !== 'recovering' || !this.#capsuleMatchesIdentity(capsule, claimSlot.identity)) {
        throw new Error('provider_proxy_capsule_claim_identity_mismatch');
      }
      if (claimSlot.capsulePath !== null && claimSlot.capsulePath !== path) {
        throw new Error('provider_proxy_capsule_claim_path_alias');
      }
      claimSlot.capsulePath = path;
      return;
    }

    if (capsule.version === 1) {
      const slotId = `capsule-${this.#nextSlotId++}`;
      this.#slots.set(slotId, {
        kind: 'capsule-opaque',
        slotId,
        capsulePath: path,
        capsuleBinding: capsule,
        address,
        capacityClass: 'retained',
        completedAttempts: 0,
        retryTimer: null,
        attemptToken: 0,
        attemptAbort: null,
      });
      return;
    }

    const identity = providerProxySetIdentityFromCapsule(capsule);
    const key = this.#identityIndex.add(identity);
    if (this.#slots.has(key)) throw new Error('provider_proxy_capsule_exact_identity_alias');
    this.#slots.set(key, {
      kind: 'capsule-recovering',
      key,
      identity,
      capsulePath: path,
      capsuleBinding: capsule,
      address,
      capacityClass: 'retained',
      completedAttempts: 0,
      retryTimer: null,
      attemptToken: 0,
      attemptAbort: null,
    });
  }

  #capsuleMatchesIdentity(capsule: HandoffCapsule, identity: ProviderProxySetIdentity): boolean {
    if (capsule.version === 2) {
      return providerProxySetIdentitiesEqual(providerProxySetIdentityFromCapsule(capsule), identity);
    }
    return (
      capsule.buildSetId === identity.buildSetId &&
      capsule.hostFingerprint === identity.hostFingerprint &&
      capsule.guardianInstanceId === identity.guardianInstanceId &&
      capsule.reaperInstanceId === identity.reaperInstanceId &&
      capsule.proxyInstanceId === identity.proxyInstanceId &&
      capsule.guardianControlEndpoint === identity.guardianControlEndpoint &&
      capsule.reaperControlEndpoint === identity.reaperControlEndpoint &&
      capsule.proxyEndpoint === identity.canonicalEndpoint
    );
  }

  #recoverExactCapsule(slot: Extract<ProviderProxySetSlot, { kind: 'capsule-recovering' }>): void {
    if (this.#slots.get(slot.key) !== slot) return;
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
            const outcome = value as Extract<ProviderProxySetRedemptionOutcome, { kind: 'redeemed' }>;
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

  #redeemOpaqueCapsule(slot: Extract<ProviderProxySetSlot, { kind: 'capsule-opaque' }>): void {
    if (this.#slots.get(slot.slotId) !== slot) return;
    const dispatcher = this.#deps.recoveryDispatcher;
    slot.attemptToken += 1;
    const token = slot.attemptToken;
    const abort = new AbortController();
    slot.attemptAbort = abort;
    const turn = dispatcher.begin(
      'opaque-capsule-redemption',
      { capsule: slot.capsuleBinding },
      {
        evidence: (value) => {
          if (this.#slots.get(slot.slotId) !== slot || slot.attemptToken !== token) return;
          slot.attemptAbort = null;
          const outcome = value as Extract<ProviderProxySetRedemptionOutcome, { kind: 'redeemed' }>;
          const identity = outcome.set.setIdentity;
          const upgraded: HandoffCapsuleV2 = {
            ...slot.capsuleBinding,
            version: 2,
            guardianPid: identity.guardianPid,
            guardianProcessStartedAtSeconds: identity.guardianProcessStartedAtSeconds,
            proxyPid: identity.proxyPid,
            reaperPid: identity.reaperPid,
            reaperProcessStartedAtSeconds: identity.reaperProcessStartedAtSeconds,
            containmentKind: identity.containmentKind,
            proxyProcessStartedAtSeconds: identity.proxyProcessStartedAtSeconds,
            proxyProcessGroupId: identity.proxyProcessGroupId,
          };
          this.#rewriteOpaqueCapsule(slot, outcome.set, upgraded);
        },
        retry: () => {
          if (this.#slots.get(slot.slotId) !== slot || slot.attemptToken !== token) return;
          slot.attemptAbort = null;
          slot.completedAttempts += 1;
          const delayMs = retryDelayMs(slot.completedAttempts);
          const requestedWakeMs = this.#deps.time.now() + delayMs;
          slot.retryTimer = this.#deps.time.setTimeout(() => {
            slot.retryTimer = null;
            this.#recordLateness('containment-retry', requestedWakeMs);
            this.#redeemOpaqueCapsule(slot);
          }, delayMs);
          slot.retryTimer.unref?.();
        },
        fatal: () => {
          if (this.#slots.get(slot.slotId) === slot && slot.attemptToken === token) slot.attemptAbort = null;
        },
      },
    );
    turn.start({
      sourceId: 'redemption',
      producerId: 'capsule-redemption',
      input: { capsule: slot.capsuleBinding, capsulePath: slot.capsulePath, signal: abort.signal },
      abort: (reason) => abort.abort(reason),
    });
  }

  #rewriteOpaqueCapsule(
    slot: Extract<ProviderProxySetSlot, { kind: 'capsule-opaque' }>,
    authority: DurableProviderProxyOperationAuthority,
    upgraded: HandoffCapsuleV2,
  ): void {
    const dispatcher = this.#deps.recoveryDispatcher;
    const turn = dispatcher.begin(
      'opaque-capsule-rewrite',
      { setIdentity: authority.setIdentity, capsule: upgraded },
      {
        evidence: () => {
          if (this.#slots.get(slot.slotId) !== slot) return;
          this.#slots.delete(slot.slotId);
          this.#establish(authority, null, slot.capsulePath, 'contain-unclaimed-discovery');
        },
        retry: () => {
          throw new Error('provider_proxy_capsule_rewrite_retry_is_not_permitted');
        },
        fatal: () => undefined,
      },
    );
    turn.start({
      sourceId: 'rewrite',
      producerId: 'capsule-rewrite',
      input: { path: slot.capsulePath, capsule: upgraded },
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
    };
    this.#slots.set(key, slot);
    authority.onFault(() => this.faultAuthority(identity));
    this.#classifyCapacity();
    if (intent === 'contain-unclaimed-discovery' && slot.kind === 'available') {
      this.#beginContainment(slot, 'unclaimed_discovery');
    }
    if (slot.kind === 'available' && routeKey !== null) {
      this.#routeIndex.set(routeKey, key);
    }
    if (this.authorityFor(identity) === authority) {
      this.#deps.controlEstablished(authority);
    }
  }

  #classifyCapacity(): void {
    const addressed = [...this.#slots.values()]
      .filter((slot): slot is Exclude<ProviderProxySetSlot, { kind: 'acquiring' }> => slot.kind !== 'acquiring')
      .sort((left, right) =>
        providerProxySetAddressKey(left.address).localeCompare(providerProxySetAddressKey(right.address)),
      );
    for (const [index, slot] of addressed.entries()) slot.capacityClass = index < 4 ? 'retained' : 'excess';
    for (const slot of addressed) {
      if (slot.capacityClass !== 'excess' || slot.kind !== 'available') continue;
      slot.kind = 'draining';
      this.#removeRoute(slot);
      if (this.#deps.claims.claimsFor(slot.identity).length === 0) {
        this.#beginContainment(slot, 'excess_capacity');
      }
    }
  }

  #removeRoute(slot: EstablishedSlot): void {
    if (slot.routeKey !== null && this.#routeIndex.get(slot.routeKey) === slot.key) {
      this.#routeIndex.delete(slot.routeKey);
    }
  }

  #beginContainment(
    slot: EstablishedSlot,
    _reason: 'provider_authority_lost' | 'graceful_idle' | 'excess_capacity' | 'unclaimed_discovery',
  ): void {
    this.#removeRoute(slot);
    slot.kind = 'containing';
    slot.authority.stopHeartbeats();
    void this.#runContainmentAttempt(slot);
  }

  #runContainmentAttempt(slot: EstablishedSlot): void {
    if (this.#slots.get(slot.key) !== slot || (slot.kind !== 'containing' && slot.kind !== 'containment-wait')) {
      return;
    }
    slot.kind = 'containing';
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
                token,
                abort,
                (value as { disappearanceReceipt: string }).disappearanceReceipt,
              );
            }
            return;
          }
          if (value !== null) this.#finishContainmentAttempt(slot, token, abort, value as string);
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
      this.#finishContainmentAttempt(slot, token, abort, null);
    }, CONTAINMENT_ATTEMPT_MS);
    slot.retryTimer.unref?.();
    turn.start({
      sourceId: 'stop-and-reap',
      producerId: 'role-control',
      input: { signal: abort.signal, run: (signal) => slot.authority.stopAndReap(signal) },
      abort: (reason) => abort.abort(reason),
    });
    turn.start({
      sourceId: 'absence',
      producerId: 'containment-proof',
      input: { identity: slot.identity, signal: abort.signal },
      abort: (reason) => abort.abort(reason),
    });
  }

  #finishContainmentAttempt(
    slot: EstablishedSlot,
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
    slot.kind = 'containment-wait';
    const delayMs = retryDelayMs(slot.completedAttempts);
    const requestedRetryMs = this.#deps.time.now() + delayMs;
    slot.retryTimer = this.#deps.time.setTimeout(() => {
      slot.retryTimer = null;
      this.#recordLateness('containment-retry', requestedRetryMs);
      this.#runContainmentAttempt(slot);
    }, delayMs);
    slot.retryTimer.unref?.();
  }

  async #deliverDisappearance(slot: AbsenceDeliveryPendingSlot, operation: OperationIdentity): Promise<void> {
    try {
      const outcome = await this.#deps.disappearanceConsumer.containmentDisappeared({
        operation,
        setIdentity: slot.identity,
        disappearanceReceipt: slot.disappearanceReceipt,
      });
      if (this.#slots.get(slot.key) !== slot || !slot.pendingOperations.has(operationKey(operation))) return;
      if (outcome.kind === 'operational-failure') {
        this.#retainDisappearanceDelivery(slot, operation, outcome);
        return;
      }
      this.#acceptDisappearance(slot, operation, outcome.acceptance);
    } catch (error: unknown) {
      if (this.#slots.get(slot.key) !== slot || !slot.pendingOperations.has(operationKey(operation))) return;
      this.#failDisappearanceDelivery(
        slot,
        operation,
        new ProviderProxySetLifecycleFatalError(
          'disappearance-delivery',
          `Provider containment disappearance delivery failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error, operation, setIdentity: slot.identity },
        ),
      );
    }
  }

  #acceptDisappearance(
    slot: AbsenceDeliveryPendingSlot,
    operation: OperationIdentity,
    acceptance: ContainmentDisappearanceAcceptance,
  ): void {
    if (this.#slots.get(slot.key) !== slot) return;
    if (operationKey(acceptance.operation) !== operationKey(operation)) {
      throw new Error('provider_proxy_disappearance_acceptance_identity_mismatch');
    }
    const key = operationKey(operation);
    if (!slot.pendingOperations.delete(key)) return;
    const timer = slot.deliveryRetryTimers.get(key);
    if (timer !== undefined) this.#deps.time.clearTimeout(timer);
    slot.deliveryRetryTimers.delete(key);
    slot.initialDeliveries.set(key, { kind: 'accepted' });
    if (slot.pendingOperations.size === 0) this.#startRetirement(slot);
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
      slot.retirementState !== 'not-ready'
    ) {
      return;
    }
    if (slot.capsulePath === null) {
      slot.retirementState = 'retired';
      this.#releaseAbsenceSlot(slot);
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
          this.#releaseAbsenceSlot(slot);
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

  #releaseAbsenceSlot(slot: AbsenceDeliveryPendingSlot): void {
    if (this.#slots.get(slot.key) !== slot) return;
    this.#slots.delete(slot.key);
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
