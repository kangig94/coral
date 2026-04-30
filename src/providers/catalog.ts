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

/**
 * Fail-closed `ProviderLookupPort`: rejects every provider name. Use at
 * production composition edges that need an explicit baseline before a real
 * catalog is wired (e.g., bootstrap smoke tests that write events with no
 * provider references). Append-time validators that consult this port will
 * reject any provider reference, which is the safe default — the
 * permissive shape lives only in test helpers.
 */
export const noProviderLookupPort: ProviderLookupPort = {
  hasProvider: () => false,
};
