import type { ProviderSpec } from './contract.js';

/** Read-only view of the provider registry. */
export interface ProviderCatalog {
  get(name: string): ProviderSpec | undefined;
  getAll(): ProviderSpec[];
}
