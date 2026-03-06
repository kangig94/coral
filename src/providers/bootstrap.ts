import { claudeProvider } from './claude/adapter.js';
import { codexProvider } from './codex/adapter.js';
import { _resetNewProvidersForTests, registerNewProvider } from './registry.js';

let bootstrapped = false;

export function registerBuiltInProviders(): void {
  if (bootstrapped) return;
  registerNewProvider(codexProvider);
  registerNewProvider(claudeProvider);
  bootstrapped = true;
}

export function _resetProviderBootstrapForTests(): void {
  bootstrapped = false;
  _resetNewProvidersForTests();
}
