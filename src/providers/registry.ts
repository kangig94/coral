import type { ProviderAdapter, ProviderTool } from './types.js';

const RESERVED_TOOL_NAMES = new Set(['wait', 'workflow', 'abort']);
const providers = new Map<string, ProviderAdapter>();

export function registerProvider(adapter: ProviderAdapter): void {
  if (adapter.name !== adapter.tool.name) {
    throw new Error(`Provider name "${adapter.name}" must match tool name "${adapter.tool.name}"`);
  }
  if (RESERVED_TOOL_NAMES.has(adapter.name)) {
    throw new Error(`Provider name "${adapter.name}" is reserved`);
  }
  if (providers.has(adapter.name)) {
    throw new Error(`Provider "${adapter.name}" is already registered`);
  }
  providers.set(adapter.name, adapter);
}

export function getProvider(name: string): ProviderAdapter | undefined {
  return providers.get(name);
}

export function hasProvider(name: string): boolean {
  return providers.has(name);
}

export function getAllTools(): ProviderTool[] {
  return [...providers.values()].map((provider) => provider.tool);
}

export function getProviderNames(): string[] {
  return [...providers.keys()];
}

export function _resetProvidersForTests(): void {
  providers.clear();
}
