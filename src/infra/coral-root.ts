import { homedir } from 'node:os';
import { join } from 'node:path';

import type { BuildFlavor } from './build-flavor.js';

/**
 * Resolves the Coral root directory (`~/.coral` by default). Tests pass an
 * explicit `baseDir` override to point at a tmp dir.
 *
 * Lives in its own file because every flavor-aware path family needs it,
 * and putting it in `coral-paths.ts` (the composer) would create cycles
 * (coral-paths -> store-paths -> coral-paths and so on).
 */
export function coralRoot(baseDir?: string): string {
  return baseDir ?? join(homedir(), '.coral');
}

/**
 * Resolves the KB markdown vault root. Honors `CORAL_KB_PATH` at the leaf
 * level so users can point at a synced/shared vault without disturbing the
 * machine-local runtime tree (kbRuntimeDir).
 *
 * Single canonical implementation — both `kb/paths.ts:kbRoot` (KB domain
 * caller) and `infra/coral-paths.ts:corpusPaths` (CoralPaths composer)
 * delegate here. Per Principle #7 (No Ambiguity): a vault path resolver
 * has exactly one home, and that home must be at a layer both callers can
 * import without violating the layering rules — i.e. infra.
 */
export function kbVaultRoot(flavor: BuildFlavor, baseDir?: string): string {
  if (baseDir !== undefined) {
    return join(coralRoot(baseDir), flavor === 'dev' ? 'kb-dev' : 'kb');
  }

  const custom = process.env.CORAL_KB_PATH;
  if (custom) return custom.startsWith('~') ? join(homedir(), custom.slice(1)) : custom;
  return join(coralRoot(), flavor === 'dev' ? 'kb-dev' : 'kb');
}
