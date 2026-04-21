import type { ProviderCatalog } from './catalog.js';
import type { ProviderSpec } from './contract.js';

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
export class ProviderRegistry implements ProviderCatalog {
  private providers = new Map<string, ProviderSpec>();

  register(spec: ProviderSpec): void {
    if (RESERVED_TOOL_NAMES.has(spec.name)) {
      throw new Error(`Provider name "${spec.name}" is reserved`);
    }
    if (this.providers.has(spec.name)) {
      throw new Error(`New provider "${spec.name}" is already registered`);
    }
    this.providers.set(spec.name, spec);
  }

  get(name: string): ProviderSpec | undefined {
    return this.providers.get(name);
  }

  getAll(): ProviderSpec[] {
    return [...this.providers.values()];
  }

  /** Reset provider registry state. Intended for test isolation. */
  clear(): void {
    this.providers.clear();
  }
}
