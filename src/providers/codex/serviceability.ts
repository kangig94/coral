import type { ProviderResponseDiagnosticFact } from '../host-diagnostics.js';
import type { HostServiceability } from '../host-serviceability.js';

export function classifyCodexProviderResponseServiceability(fact: ProviderResponseDiagnosticFact): HostServiceability {
  if (fact.method !== 'config/read') return 'unknown';
  return fact.response.kind === 'success' ? 'serviceable' : 'unserviceable';
}
