import type { Provider } from './types.js';

/** Read-only view of the provider registry - returns a provider by name. */
export interface ProviderCatalog {
  get(name: string): Provider | undefined;
}
