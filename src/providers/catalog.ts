import type { ProviderSpec } from './contract.js';

/** Read-only view of the provider registry. */
export interface ProviderCatalog {
  get(name: string): ProviderSpec | undefined;
  getAll(): ProviderSpec[];
}

/** Narrow provider lookup used by synchronous append-time validators. */
export interface ProviderLookupPort {
  hasProvider(name: string): boolean;
}

export function providerLookupPortFromCatalog(catalog: ProviderCatalog): ProviderLookupPort {
  return {
    hasProvider: (name) => catalog.get(name) !== undefined,
  };
}
