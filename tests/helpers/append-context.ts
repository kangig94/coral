import type { ProviderLookupPort } from '#src/providers/catalog.js';

/**
 * Test-only `ProviderLookupPort` that accepts every provider id.
 *
 * Production callers MUST compose a real `ProviderLookupPort` through
 * `providerLookupPortFromCatalog(...)`.
 * `AppendContext.providers` is required at the type level so this permissive
 * fallback is unreachable in production — the symbol exists only for unit
 * tests whose subject under test is unrelated to provider validation.
 *
 * Tests that DO exercise provider validation must construct a port whose
 * `hasProvider(id)` reflects the test's intent, not this universal accept.
 */
export const permissiveProviderLookupPort: ProviderLookupPort = {
  hasProvider: () => true,
  validatePersistedBinding: () => ({ ok: true }),
  validatePersistedScope: () => ({ ok: true }),
};
