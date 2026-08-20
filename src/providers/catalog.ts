import type { ProviderDefinition } from './registry.js';
import type {
  ProviderBindingFailure,
  ProviderBindingResult,
  ProviderBindingRuntime,
  ProviderBindingUse,
} from './contracts/binding.js';
import type { BoundProvider } from './bound-provider-contract.js';
import type { ProviderScope } from '../infra/provider-scope.js';

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
  ): Promise<ProviderBindingResult<BoundProvider>>;
  bindProfile(
    providerName: string,
    rawProfileEnvelope: unknown,
    runtime: ProviderBindingRuntime,
  ): Promise<ProviderBindingResult<BoundProvider>>;
  rehydrateBinding(rawEnvelope: unknown): ProviderBindingResult<BoundProvider>;
  renderBindingFailure(failure: ProviderBindingFailure): string;
}

/** Narrow provider lookup used by synchronous append-time validators. */
export interface ProviderLookupPort {
  hasProvider(name: string): boolean;
  validatePersistedBinding(
    rawEnvelope: unknown,
  ): { readonly ok: true } | { readonly ok: false; readonly message: string };
  validatePersistedScope(
    rawScope: unknown,
    requiredProviders: readonly string[],
  ): { readonly ok: true } | { readonly ok: false; readonly message: string };
}

export function providerLookupPortFromCatalog(catalog: ProviderBindingCatalog): ProviderLookupPort {
  return {
    hasProvider: (name) => catalog.get(name) !== undefined,
    validatePersistedBinding(rawEnvelope) {
      const result = catalog.rehydrateBinding(rawEnvelope);
      return result.ok ? { ok: true } : { ok: false, message: catalog.renderBindingFailure(result.failure) };
    },
    validatePersistedScope(rawScope, requiredProviders) {
      const result = catalog.decodeScope(rawScope);
      if (!result.ok) return { ok: false, message: catalog.renderBindingFailure(result.failure) };
      const required = new Set(requiredProviders);
      const present = new Set(result.value.profiles.map((profile) => profile.provider));
      const missing = [...required].find((provider) => !present.has(provider));
      if (missing !== undefined) return { ok: false, message: `Provider scope is missing profile '${missing}'.` };
      const unexpected = [...present].find((provider) => !required.has(provider));
      return unexpected === undefined
        ? { ok: true }
        : { ok: false, message: `Provider scope contains undeclared profile '${unexpected}'.` };
    },
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
  validatePersistedBinding: () => ({ ok: false, message: 'No provider binding codecs are registered.' }),
  validatePersistedScope: () => ({ ok: false, message: 'No provider profile codecs are registered.' }),
};
