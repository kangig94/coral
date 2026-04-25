import { homedir } from 'node:os';
import { join } from 'node:path';

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
