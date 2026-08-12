import type { ProviderResponseDiagnosticFact } from './host-diagnostics.js';
import type { HostServiceability } from './host-serviceability.js';
import { classifyCodexProviderResponseServiceability } from './codex/serviceability.js';

export type ProviderResponseServiceabilityClassifier = (fact: ProviderResponseDiagnosticFact) => HostServiceability;

export const PROVIDER_RESPONSE_SERVICEABILITY_CLASSIFIERS: Readonly<
  Record<string, ProviderResponseServiceabilityClassifier>
> = Object.freeze({
  codex: classifyCodexProviderResponseServiceability,
});

export function classifyProviderResponseServiceability(
  provider: string,
  fact: ProviderResponseDiagnosticFact,
): HostServiceability {
  return PROVIDER_RESPONSE_SERVICEABILITY_CLASSIFIERS[provider]?.(fact) ?? 'unknown';
}
