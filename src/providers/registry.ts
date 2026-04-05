import { claudeProvider } from './claude/adapter.js';
import { codexProvider } from './codex/adapter.js';
import type { Provider } from './types.js';

const RESERVED_TOOL_NAMES = new Set([
  'wait',
  'workflow',
  'abort',
  'backend',
  'kb_search',
  'kb_read',
  'kb_promote',
  'kb_update',
  'kb_delete',
  'kb_source_import',
  'kb_source_list',
  'kb_source_delete',
  'kb_reindex',
  'kb_principles',
  'kb_memo',
  'kb_memo_list',
  'kb_memo_delete',
  'kb_memo_purge',
  'discuss_seed',
  'discuss_start',
  'discuss_watch',
  'discuss_participate',
  'discuss_abort',
]);
export class ProviderRegistry {
  private providers = new Map<string, Provider>();
  private bootstrapped = false;

  register(provider: Provider): void {
    if (RESERVED_TOOL_NAMES.has(provider.name)) {
      throw new Error(`Provider name "${provider.name}" is reserved`);
    }
    if (this.providers.has(provider.name)) {
      throw new Error(`New provider "${provider.name}" is already registered`);
    }
    this.providers.set(provider.name, provider);
  }

  get(name: string): Provider | undefined {
    return this.providers.get(name);
  }

  getAll(): Provider[] {
    return [...this.providers.values()];
  }

  registerBuiltIns(): void {
    if (this.bootstrapped) return;
    this.register(codexProvider);
    this.register(claudeProvider);
    this.bootstrapped = true;
  }

  /** Reset provider registry state. Intended for test isolation. */
  clear(): void {
    this.providers.clear();
    this.bootstrapped = false;
  }
}
