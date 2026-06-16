import { homedir } from 'node:os';
import { join } from 'node:path';

import type { BuildFlavor } from '../build-flavor.js';
import { hashToken } from '../hash.js';

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

/**
 * Resolve the Claude Code config dir from a captured `CLAUDE_CONFIG_DIR` value,
 * falling back to `<home>/.claude`. The raw env value is passed in, never read
 * from ambient state; callers should pass `homeDir` (it defaults to
 * `os.homedir()` only as a convenience for the rare caller without one).
 */
export function resolveClaudeConfigDir(rawConfigDir: string | undefined, homeDir?: string): string {
  return rawConfigDir && rawConfigDir.length > 0 ? rawConfigDir : join(homeDir ?? homedir(), '.claude');
}

/**
 * Per-config-dir partition slot for Coral's daemon-owned state tree. The plugin
 * (and thus its backend daemon binary) installs *inside* the config dir, so two
 * config dirs are two independent daemons that must not share a socket, store,
 * or job tree. The default config dir (`~/.claude`) maps to no slot so existing
 * installs keep their `~/.coral` paths; any other config dir gets a stable hash
 * slot. Callers should pass `homeDir` for the default comparison (it defaults
 * to `os.homedir()` only as a convenience).
 */
export function claudeConfigSlot(configDir: string, homeDir?: string): string | undefined {
  if (configDir === join(homeDir ?? homedir(), '.claude')) return undefined;
  return hashToken(configDir, 8);
}

/**
 * Coral state root partitioned by config-dir slot. Daemon-owned runtime state
 * (store, coordinator, jobs, projects, exports, engines) lives here; the shared
 * KB stays at the unpartitioned {@link coralRoot}.
 */
export function coralStateRoot(configSlot?: string, baseDir?: string): string {
  const root = coralRoot(baseDir);
  return configSlot ? join(root, 'by-config', configSlot) : root;
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
