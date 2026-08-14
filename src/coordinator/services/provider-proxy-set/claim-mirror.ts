import type { OperationIdentity } from '../../../provider-proxy/protocol.js';
import type { ProviderOperationRecord } from '../../../store/provider-operation-record.js';
import type { ProviderOperationMutation } from '../../../store/provider-operation-journal.js';
import {
  ProviderProxySetIdentityIndex,
  providerProxySetIdentitiesEqual,
  providerProxySetIdentityFromRecord,
  providerProxySetKey,
  type ProviderProxySetIdentity,
  type ProviderProxySetKey,
} from './identity.js';

export type ProviderProxySetOperationClaim = Readonly<{
  operation: OperationIdentity;
  setIdentity: ProviderProxySetIdentity;
}>;

function operationKey(operation: OperationIdentity): string {
  return JSON.stringify([operation.jobId, operation.operationId, operation.proxyInstanceId, operation.buildSetId]);
}

export class ProviderProxySetClaimMirror {
  readonly #identityIndex = new ProviderProxySetIdentityIndex();
  readonly #claims = new Map<string, ProviderProxySetOperationClaim>();

  initialize(records: readonly ProviderOperationRecord[]): void {
    if (this.#claims.size !== 0 || this.#identityIndex.size !== 0) {
      throw new Error('provider_proxy_claim_mirror_already_initialized');
    }
    for (const record of records) this.#publish(record);
  }

  applyMutation(mutation: ProviderOperationMutation): void {
    if (mutation.kind === 'deleted') {
      this.#release(mutation.record.operation);
      return;
    }
    this.#publish(mutation.record);
  }

  claimsFor(identity: ProviderProxySetIdentity): readonly ProviderProxySetOperationClaim[] {
    return [...this.#claims.values()].filter((claim) => providerProxySetIdentitiesEqual(claim.setIdentity, identity));
  }

  identityKeys(): readonly ProviderProxySetKey[] {
    return [...new Set([...this.#claims.values()].map((claim) => providerProxySetKey(claim.setIdentity)))];
  }

  identities(): readonly ProviderProxySetIdentity[] {
    const byKey = new Map<ProviderProxySetKey, ProviderProxySetIdentity>();
    for (const claim of this.#claims.values()) byKey.set(providerProxySetKey(claim.setIdentity), claim.setIdentity);
    return [...byKey.values()];
  }

  claimFor(operation: OperationIdentity): ProviderProxySetOperationClaim | null {
    return this.#claims.get(operationKey(operation)) ?? null;
  }

  get size(): number {
    return this.#claims.size;
  }

  #publish(record: ProviderOperationRecord): void {
    const key = operationKey(record.operation);
    if (record.phase === 'local-recovery-pending') {
      this.#release(record.operation);
      return;
    }
    const setIdentity = providerProxySetIdentityFromRecord(record);
    this.#identityIndex.add(setIdentity);
    const existing = this.#claims.get(key);
    if (existing !== undefined && !providerProxySetIdentitiesEqual(existing.setIdentity, setIdentity)) {
      throw new Error('provider_proxy_claim_identity_changed');
    }
    this.#claims.set(key, Object.freeze({ operation: record.operation, setIdentity }));
  }

  #release(operation: OperationIdentity): void {
    const released = this.#claims.get(operationKey(operation));
    if (released === undefined) return;
    this.#claims.delete(operationKey(operation));
    if (
      ![...this.#claims.values()].some((claim) =>
        providerProxySetIdentitiesEqual(claim.setIdentity, released.setIdentity),
      )
    ) {
      this.#identityIndex.delete(released.setIdentity);
    }
  }
}
