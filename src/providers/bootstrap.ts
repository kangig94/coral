import { ProviderRegistry } from './registry.js';
import { claudeProviderDefinition } from './claude/definition.js';
import { codexProviderDefinition } from './codex/definition.js';

const BUILT_IN_PROVIDERS = [codexProviderDefinition, claudeProviderDefinition] as const;

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
