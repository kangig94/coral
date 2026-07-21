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
function coralRoot(baseDir?: string): string {
  return baseDir ?? join(homedir(), '.coral');
}

/** Resolve the current OS user's home at the path-authority boundary. */
export function resolveUserHomeDir(envHome?: string): string {
  return envHome && envHome.length > 0 ? envHome : homedir();
}

/**
 * Resolve the Claude Code config dir from a captured `CLAUDE_CONFIG_DIR` value,
 * falling back to `<home>/.claude`. The raw env value is passed in, never read
 * from ambient state; callers should pass `homeDir` (it defaults to
 * `os.homedir()` only as a convenience for the rare caller without one).
 */
export function resolveClaudeConfigDir(rawConfigDir: string | undefined, homeDir?: string): string {
  return rawConfigDir && rawConfigDir.length > 0 ? rawConfigDir : join(homeDir ?? homedir(), '.claude');
}

/** Account-neutral root for all Coral-owned state. */
export function coralStateRoot(baseDir?: string): string {
  return coralRoot(baseDir);
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
 * reading ambient `process.env`. Path resolvers must not read ambient state —
 * everything they need flows through their arguments.
 */
export function kbVaultRoot(flavor: BuildFlavor, opts?: KbVaultRootOptions): string {
  if (opts?.baseDir !== undefined) {
    return join(coralRoot(opts.baseDir), flavor === 'dev' ? 'kb-dev' : 'kb');
  }
  if (opts?.customRoot) {
    return opts.customRoot.startsWith('~') ? join(homedir(), opts.customRoot.slice(1)) : opts.customRoot;
  }
  return join(coralRoot(), flavor === 'dev' ? 'kb-dev' : 'kb');
}
