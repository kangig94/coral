import type { TimePort, TimerHandle } from '../../infra/port-types.js';
import type { OperationIdentity } from '../../provider-proxy/protocol.js';
import type { HandoffCapsule } from '../../provider-proxy/handoff-capsule.js';
import type { DurableProviderProxyOperationAuthority } from '../live/provider-proxy/operation-route.js';
import type {
  ContainmentDisappearanceAcceptance,
  ProviderContainmentDisappearanceConsumer,
} from './provider-operation-reconciler.js';
import type { ProviderProxySetClaimMirror } from './provider-proxy-set-claim-mirror.js';
import {
  ProviderProxySetIdentityIndex,
  providerProxySetAddress,
  providerProxySetAddressKey,
  providerProxySetIdentitiesEqual,
  providerProxySetKey,
  type ProviderProxySetAddress,
  type ProviderProxySetIdentity,
  type ProviderProxySetKey,
} from './provider-proxy-set-identity.js';

export const MAX_COORDINATOR_PROXY_SET_SLOTS = 4;
const CONTAINMENT_ATTEMPT_MS = 30_000;

type CapacityClass = 'retained' | 'excess';

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
      slotId: string;
      capsulePath: string;
      capsuleBinding: HandoffCapsule;
      address: ProviderProxySetAddress;
      capacityClass: CapacityClass;
      completedAttempts: number;
      retryTimer: TimerHandle | null;
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
      capsulePath: string | null;
      routeKey: string | null;
      retirementTimer: TimerHandle | null;
    };

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

export type ProviderProxySetLifecycleDeps = Readonly<{
  claims: ProviderProxySetClaimMirror;
  disappearanceConsumer: ProviderContainmentDisappearanceConsumer;
  time: Pick<TimePort, 'now' | 'setTimeout' | 'clearTimeout'>;
  proveContainmentAbsent(identity: ProviderProxySetIdentity, signal: AbortSignal): Promise<string | null>;
  retireCapsule?: (path: string) => Promise<void> | void;
  onProgressPremiseViolation?: (violation: ProviderProxySetLifecycleProgressViolation) => void;
  onError?: (message: string) => void;
  redeemCapsule?: (
    capsule: HandoffCapsule,
    capsulePath: string,
    signal: AbortSignal,
  ) => Promise<DurableProviderProxyOperationAuthority>;
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
      if (slot.kind === 'capsule-recovering') void this.#redeemCapsule(slot);
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
    this.#establish(authority, acquiring.routeKey, capsulePath);
  }

  registerInheritedSet(authority: DurableProviderProxyOperationAuthority, capsulePath: string | null = null): void {
    this.#establish(authority, null, capsulePath);
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
      slot.kind === 'recovering'
    ) {
      return;
    }
    if (slot.kind === 'absence-delivery-pending' || slot.kind === 'containing' || slot.kind === 'containment-wait') {
      return;
    }
    this.#beginContainment(slot, 'provider_authority_lost');
  }

  containmentAbsent(identity: ProviderProxySetIdentity, disappearanceReceipt: string): void {
    const key = providerProxySetKey(identity);
    if (typeof disappearanceReceipt !== 'string' || disappearanceReceipt.length === 0) {
      throw new Error('provider_proxy_containment_absence_receipt_invalid');
    }
    const slot = this.#slots.get(key);
    if (slot === undefined) throw new Error('provider_proxy_containment_absence_slot_missing');
    if (
      slot.kind === 'acquiring' ||
      slot.kind === 'capsule-recovering' ||
      !providerProxySetIdentitiesEqual(slot.identity, identity)
    ) {
      throw new Error('provider_proxy_containment_absence_identity_mismatch');
    }
    if (slot.kind === 'absence-delivery-pending') {
      if (slot.disappearanceReceipt !== disappearanceReceipt) {
        throw new Error('provider_proxy_containment_absence_conflict');
      }
      return;
    }
    if (slot.kind === 'available' || slot.kind === 'draining') {
      throw new Error('provider_proxy_containment_absence_before_authority_fault');
    }

    const pendingOperations = new Map(
      this.#deps.claims.claimsFor(slot.identity).map((claim) => [operationKey(claim.operation), claim.operation]),
    );
    const pending: Extract<ProviderProxySetSlot, { kind: 'absence-delivery-pending' }> = {
      kind: 'absence-delivery-pending',
      key: slot.key,
      identity: slot.identity,
      address: slot.address,
      capacityClass: slot.capacityClass,
      disappearanceReceipt,
      pendingOperations,
      capsulePath: slot.capsulePath,
      routeKey: slot.kind === 'recovering' ? null : slot.routeKey,
      retirementTimer: null,
    };
    if (slot.kind !== 'recovering') {
      slot.attemptToken += 1;
      if (slot.retryTimer !== null) this.#deps.time.clearTimeout(slot.retryTimer);
    }
    this.#slots.set(key, pending);

    if (slot.kind !== 'recovering') {
      void slot.authority
        .initiateControlClose()
        .catch((error: unknown) =>
          this.#deps.onError?.(
            `Provider proxy control close after containment failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
    }
    if (pendingOperations.size === 0) {
      void this.#retireAndRelease(pending);
      return;
    }
    for (const operation of pendingOperations.values()) void this.#deliverDisappearance(pending, operation);
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

    const slotId = `capsule-${this.#nextSlotId++}`;
    this.#slots.set(slotId, {
      kind: 'capsule-recovering',
      slotId,
      capsulePath: path,
      capsuleBinding: capsule,
      address,
      capacityClass: 'retained',
      completedAttempts: 0,
      retryTimer: null,
    });
  }

  #capsuleMatchesIdentity(capsule: HandoffCapsule, identity: ProviderProxySetIdentity): boolean {
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

  async #redeemCapsule(slot: Extract<ProviderProxySetSlot, { kind: 'capsule-recovering' }>): Promise<void> {
    if (this.#slots.get(slot.slotId) !== slot) return;
    try {
      if (this.#deps.redeemCapsule === undefined) throw new Error('capsule redemption is not configured');
      const authority = await this.#deps.redeemCapsule(
        slot.capsuleBinding,
        slot.capsulePath,
        new AbortController().signal,
      );
      if (this.#slots.get(slot.slotId) !== slot) return;
      if (!this.#capsuleMatchesIdentity(slot.capsuleBinding, authority.setIdentity)) {
        throw new Error('provider_proxy_capsule_redemption_identity_mismatch');
      }
      this.#slots.delete(slot.slotId);
      this.#capsuleAddresses.delete(providerProxySetAddressKey(slot.address));
      this.#establish(authority, null, slot.capsulePath);
      this.faultAuthority(authority.setIdentity);
    } catch (error: unknown) {
      if (this.#slots.get(slot.slotId) !== slot) return;
      slot.completedAttempts += 1;
      this.#deps.onError?.(
        `Provider handoff capsule redemption failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      const delayMs = retryDelayMs(slot.completedAttempts);
      const requestedWakeMs = this.#deps.time.now() + delayMs;
      slot.retryTimer = this.#deps.time.setTimeout(() => {
        slot.retryTimer = null;
        this.#recordLateness('containment-retry', requestedWakeMs);
        void this.#redeemCapsule(slot);
      }, delayMs);
      slot.retryTimer.unref?.();
    }
  }

  #establish(
    authority: DurableProviderProxyOperationAuthority,
    routeKey: string | null,
    capsulePath: string | null,
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
    if (slot.kind === 'available' && routeKey !== null) {
      this.#routeIndex.set(routeKey, key);
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
    _reason: 'provider_authority_lost' | 'graceful_idle' | 'excess_capacity',
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
    const requestedWakeMs = this.#deps.time.now() + CONTAINMENT_ATTEMPT_MS;
    slot.retryTimer = this.#deps.time.setTimeout(() => {
      slot.retryTimer = null;
      this.#recordLateness('containment-attempt-deadline', requestedWakeMs);
      this.#finishContainmentAttempt(slot, token, abort, null);
    }, CONTAINMENT_ATTEMPT_MS);
    slot.retryTimer.unref?.();
    void slot.authority
      .stopAndReap(abort.signal)
      .then((result) => {
        if ('disappearanceReceipt' in result) {
          this.#finishContainmentAttempt(slot, token, abort, result.disappearanceReceipt);
        }
      })
      .catch((error: unknown) => {
        this.#deps.onError?.(
          `Provider containment request failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    void this.#deps
      .proveContainmentAbsent(slot.identity, abort.signal)
      .then((receipt) => {
        if (receipt !== null) this.#finishContainmentAttempt(slot, token, abort, receipt);
      })
      .catch((error: unknown) => {
        this.#deps.onError?.(
          `Independent provider containment proof failed: ${error instanceof Error ? error.message : String(error)}`,
        );
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

  async #deliverDisappearance(
    slot: Extract<ProviderProxySetSlot, { kind: 'absence-delivery-pending' }>,
    operation: OperationIdentity,
  ): Promise<void> {
    try {
      const acceptance = await this.#deps.disappearanceConsumer.containmentDisappeared({
        operation,
        setIdentity: slot.identity,
        disappearanceReceipt: slot.disappearanceReceipt,
      });
      this.#acceptDisappearance(slot, operation, acceptance);
    } catch (error: unknown) {
      this.#deps.onError?.(
        `Provider containment disappearance delivery failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      const requestedWakeMs = this.#deps.time.now() + 1_000;
      slot.retirementTimer = this.#deps.time.setTimeout(() => {
        slot.retirementTimer = null;
        this.#recordLateness('containment-retry', requestedWakeMs);
        void this.#deliverDisappearance(slot, operation);
      }, 1_000);
      slot.retirementTimer.unref?.();
    }
  }

  #acceptDisappearance(
    slot: Extract<ProviderProxySetSlot, { kind: 'absence-delivery-pending' }>,
    operation: OperationIdentity,
    acceptance: ContainmentDisappearanceAcceptance,
  ): void {
    if (
      this.#slots.get(slot.key) !== slot ||
      operationKey(acceptance.operation) !== operationKey(operation) ||
      !slot.pendingOperations.delete(operationKey(operation))
    ) {
      return;
    }
    if (slot.pendingOperations.size === 0) void this.#retireAndRelease(slot);
  }

  async #retireAndRelease(slot: Extract<ProviderProxySetSlot, { kind: 'absence-delivery-pending' }>): Promise<void> {
    if (this.#slots.get(slot.key) !== slot || slot.pendingOperations.size !== 0) return;
    try {
      if (slot.capsulePath !== null) await this.#deps.retireCapsule?.(slot.capsulePath);
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
    } catch (error: unknown) {
      this.#deps.onError?.(
        `Provider handoff capsule retirement failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      const requestedWakeMs = this.#deps.time.now() + 1_000;
      slot.retirementTimer = this.#deps.time.setTimeout(() => {
        slot.retirementTimer = null;
        this.#recordLateness('containment-retry', requestedWakeMs);
        void this.#retireAndRelease(slot);
      }, 1_000);
      slot.retirementTimer.unref?.();
    }
  }

  #recordLateness(stage: ProviderProxySetLifecycleProgressViolation['stage'], requestedWakeMs: number): void {
    const observedWakeMs = this.#deps.time.now();
    const latenessMs = observedWakeMs - requestedWakeMs;
    if (latenessMs <= 0) return;
    this.#deps.onProgressPremiseViolation?.({ stage, requestedWakeMs, observedWakeMs, latenessMs });
  }
}
