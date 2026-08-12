import { ProviderRegistry } from './registry.js';
import { claudeProviderDefinition } from './claude/definition.js';
import { classifyCodexProviderResponseServiceability, codexProviderDefinition } from './codex/definition.js';
import type { ProviderResponseDiagnosticFact } from './host-diagnostics.js';
import type { HostServiceability } from './host-serviceability.js';

const BUILT_IN_PROVIDERS = [codexProviderDefinition, claudeProviderDefinition] as const;

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

export function registerBuiltInProviders(registry: ProviderRegistry): void {
  let allRegistered = true;
  const conflicts: string[] = [];
  for (const provider of BUILT_IN_PROVIDERS) {
    const existing = registry.get(provider.name);
    if (existing !== provider) {
      allRegistered = false;
    }
    if (existing !== undefined) {
      conflicts.push(provider.name);
    }
  }

  if (allRegistered) {
    return;
  }

  if (conflicts.length > 0) {
    throw new Error(
      `Built-in provider${conflicts.length === 1 ? '' : 's'} already registered: ${conflicts.join(', ')}`,
    );
  }

  for (const provider of BUILT_IN_PROVIDERS) {
    registry.register(provider);
  }
}

export function createBuiltInProviderRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  registerBuiltInProviders(registry);
  return registry;
}
