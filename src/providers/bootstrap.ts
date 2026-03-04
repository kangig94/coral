import { claudeAdapter } from './claude/server-handlers.js';
import { codexAdapter } from './codex/server-handlers.js';
import { registerProvider } from './registry.js';
import type { ProviderAdapter } from './types.js';

let bootstrapped = false;

export function registerBuiltInProviders(extraAdapters: ProviderAdapter[] = []): void {
  if (bootstrapped) return;
  registerProvider(codexAdapter);
  registerProvider(claudeAdapter);
  for (const adapter of extraAdapters) {
    registerProvider(adapter);
  }
  bootstrapped = true;
}

export function _resetProviderBootstrapForTests(): void {
  bootstrapped = false;
}
