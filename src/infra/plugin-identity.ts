import { realpathSync } from 'node:fs';
import { hashToken } from './hash.js';

const namespaceCache = new Map<string, string>();

/**
 * Stable per-pluginRoot namespace identifier. Resolves the canonical path
 * of the plugin root and hashes it to a 12-char token used to scope state
 * between concurrently installed plugin builds.
 */
export function pluginRootNamespace(pluginRoot: string): string {
  const cached = namespaceCache.get(pluginRoot);
  if (cached) return cached;
  const canonical = realpathSync(pluginRoot);
  const ns = hashToken(canonical, 12);
  namespaceCache.set(pluginRoot, ns);
  return ns;
}
