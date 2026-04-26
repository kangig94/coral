import { homedir } from 'node:os';
import { join } from 'node:path';

import type { BuildFlavor } from '../build-flavor.js';

/**
 * Resolves the Coral root directory (`~/.coral` by default). Tests pass an
 * explicit `baseDir` override to point at a tmp dir.
 *
 * Lives in its own file (cycle-break sibling) because every flavor-aware path
 * family in this subdir needs it; folding it into `compose.ts` would create
 * `compose -> store -> compose` cycles. Same precedent as
 * `kb/corpus/manifest-types.ts`.
 */
export function coralRoot(baseDir?: string): string {
  return baseDir ?? join(homedir(), '.coral');
}

export interface KbVaultRootOptions {
  readonly baseDir?: string;
  /** Resolved `CORAL_KB_PATH` value from caller's env port. Honored to point
   *  at a synced/shared vault without disturbing the machine-local runtime
   *  tree (kbRuntimeDir). */
  readonly customRoot?: string;
}

/**
 * Resolves the KB markdown vault root. Pure: callers pass the resolved
 * `CORAL_KB_PATH` value via `opts.customRoot` rather than this function
 * reading ambient `process.env`. Per design-philosophy.md Principle #4,
 * path resolvers do not read ambient state.
 */
export function kbVaultRoot(flavor: BuildFlavor, opts?: KbVaultRootOptions): string {
  if (opts?.baseDir !== undefined) {
    return join(coralRoot(opts.baseDir), flavor === 'dev' ? 'kb-dev' : 'kb');
  }
  if (opts?.customRoot) {
    return opts.customRoot.startsWith('~')
      ? join(homedir(), opts.customRoot.slice(1))
      : opts.customRoot;
  }
  return join(coralRoot(), flavor === 'dev' ? 'kb-dev' : 'kb');
}
