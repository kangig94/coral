import { claudeProvider } from './claude/adapter.js';
import { codexProvider } from './codex/adapter.js';
import type { Provider } from './provider-contracts.js';
import { ProviderRegistry } from './registry.js';
import { createScriptedProvider, readScriptedProviderSpecFromEnv } from './scripted-provider.js';

const BUILT_IN_PROVIDERS = [codexProvider, claudeProvider] as const;

function resolveBuiltInProviders(env: NodeJS.ProcessEnv = process.env): Provider[] {
  const scriptedProviderSpec = readScriptedProviderSpecFromEnv(env);
  if (scriptedProviderSpec === null) {
    return [...BUILT_IN_PROVIDERS];
  }

  const scriptedProvider = createScriptedProvider(scriptedProviderSpec);
  const replacedProviders = BUILT_IN_PROVIDERS.map((provider) =>
    provider.name === scriptedProvider.name ? scriptedProvider : provider);
  if (replacedProviders.some((provider) => provider === scriptedProvider)) {
    return replacedProviders;
  }
  return [...replacedProviders, scriptedProvider];
}

export function registerBuiltInProviders(registry: ProviderRegistry, env: NodeJS.ProcessEnv = process.env): void {
  const providers = resolveBuiltInProviders(env);
  const existingProviders = providers.map((provider) => ({
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

export function createBuiltInProviderRegistry(env: NodeJS.ProcessEnv = process.env): ProviderRegistry {
  const registry = new ProviderRegistry();
  registerBuiltInProviders(registry, env);
  return registry;
}
