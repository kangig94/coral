import { classifyProviderResponseServiceability as classifyBuiltInProviderResponseServiceability } from './bootstrap.js';
import type { ProviderResponseDiagnosticFact } from './host-diagnostics.js';
import type { HostServiceability } from './host-serviceability.js';

export function classifyProviderResponseServiceability(
  provider: string,
  fact: ProviderResponseDiagnosticFact,
): HostServiceability {
  return classifyBuiltInProviderResponseServiceability(provider, fact);
}
