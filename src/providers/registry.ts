import type { Provider } from './types.js';

const RESERVED_TOOL_NAMES = new Set(['wait', 'workflow', 'abort']);
const newProviders = new Map<string, Provider>();

export function registerNewProvider(provider: Provider): void {
  if (RESERVED_TOOL_NAMES.has(provider.name)) {
    throw new Error(`Provider name "${provider.name}" is reserved`);
  }
  if (newProviders.has(provider.name)) {
    throw new Error(`New provider "${provider.name}" is already registered`);
  }
  newProviders.set(provider.name, provider);
}

export function getNewProvider(name: string): Provider | undefined {
  return newProviders.get(name);
}

export function getAllNewProviders(): Provider[] {
  return [...newProviders.values()];
}

export function _resetNewProvidersForTests(): void {
  newProviders.clear();
}
