import { ProviderRegistry } from './registry.js';

export function registerBuiltInProviders(registry: ProviderRegistry): void {
  registry.registerBuiltIns();
}

export function createBuiltInProviderRegistry(): ProviderRegistry {
  const registry = new ProviderRegistry();
  registerBuiltInProviders(registry);
  return registry;
}
