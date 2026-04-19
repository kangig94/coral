import type {
  Provider,
  ProviderAppServerLifecycle,
  ProviderArtifactCleanup,
  ProviderArtifactRecovery,
  ProviderExecutor,
} from './provider-contracts.js';

/** Read-only view of the provider registry. */
export interface ProviderCatalog {
  get(name: string): Provider | undefined;
  getExecutor(name: string): ProviderExecutor | undefined;
  getAppServerLifecycle(name: string): ProviderAppServerLifecycle | undefined;
  getArtifactRecovery(name: string): ProviderArtifactRecovery | undefined;
  getArtifactCleanup(name: string): ProviderArtifactCleanup | undefined;
}
