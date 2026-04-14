import { claudeProvider } from './claude/adapter.js';
import { codexProvider } from './codex/adapter.js';
import { ProviderRegistry } from './registry.js';

const BUILT_IN_PROVIDERS = [codexProvider, claudeProvider] as const;

export function registerBuiltInProviders(registry: ProviderRegistry): void {
  const existingProviders = BUILT_IN_PROVIDERS.map((provider) => ({
    provider,
    existing: registry.get(provider.name),
  }));

  if (existingProviders.every(({ provider, existing }) => existing === provider)) {
    return;
  }

  const conflicts = existingProviders
    .filter(({ existing }) => existing !== undefined)
    .map(({ provider }) => provider.name);
  if (conflicts.length > 0) {
    throw new Error(
      `Built-in provider${conflicts.length === 1 ? '' : 's'} already registered: ${conflicts.join(', ')}`,
    );
  }

  for (const { provider } of existingProviders) {
    registry.register(provider);
  }
}

export function createBuiltInProviderRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  registerBuiltInProviders(registry);
  return registry;
}
