import type {
  ProviderOperationCleanupIdentity,
  ProviderOperationCleanupOwner,
  ProviderOperationCleanupPort,
  ProviderOperationCleanupRegistrar,
} from './contracts/provider-operation-lifecycle.js';

export class ProviderOperationCleanupRouter implements ProviderOperationCleanupPort, ProviderOperationCleanupRegistrar {
  readonly #owners = new Set<ProviderOperationCleanupOwner>();

  register(owner: ProviderOperationCleanupOwner): void {
    this.#owners.add(owner);
  }

  release(identity: ProviderOperationCleanupIdentity): void {
    for (const owner of this.#owners) {
      if (owner.releaseProviderOperationLocalState(identity)) return;
    }
  }
}
