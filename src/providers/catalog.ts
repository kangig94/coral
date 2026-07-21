import type { ProviderDefinition } from './registry.js';
import type {
  ProviderBindingFailure,
  ProviderBindingResult,
  ProviderBindingRuntime,
  ProviderBindingUse,
} from './contracts/binding.js';
import type { RehydratedProviderBinding } from './registry.js';
import type { ProviderScope } from '../infra/provider-scope.js';

/** Read-only view of the provider registry. */
export interface ProviderCatalog {
  get(name: string): ProviderDefinition | undefined;
  getAll(): ProviderDefinition[];
}

/** Provider lookup plus the opaque binding operations used outside provider modules. */
export interface ProviderBindingCatalog extends ProviderCatalog {
  decodeScope(rawScope: unknown): ProviderBindingResult<ProviderScope>;
  decodeCompleteScope(rawScope: unknown, requiredProviders: readonly string[]): ProviderBindingResult<ProviderScope>;
  bindFromScope(
    rawScope: unknown,
    providerName: string,
    use: ProviderBindingUse,
    runtime: ProviderBindingRuntime,
  ): Promise<ProviderBindingResult<RehydratedProviderBinding>>;
  bindProfile(
    providerName: string,
    rawProfileEnvelope: unknown,
    runtime: ProviderBindingRuntime,
  ): Promise<ProviderBindingResult<RehydratedProviderBinding>>;
  rehydrateBinding(rawEnvelope: unknown): ProviderBindingResult<RehydratedProviderBinding>;
  renderBindingFailure(failure: ProviderBindingFailure): string;
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
