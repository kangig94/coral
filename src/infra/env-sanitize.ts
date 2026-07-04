/**
 * Environment sanitization primitives.
 *
 * Prevents E2BIG (execve argument-list-too-long) in environments with large
 * env blocks — common in Kubernetes where service discovery, ConfigMaps, and
 * Secrets can push process.env to hundreds of KB while ARG_MAX may be as low
 * as 128KB.
 *
 * Strategy: size-budget with pure size-based shedding.
 * - If total env fits within budget → pass everything unchanged.
 * - If over budget → drop the largest vars first until it fits.
 * - Passthrough set protects specific vars from being shed.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { backendLog } from './backend-log.js';

const ENV_BUDGET_FALLBACK_BYTES = 2 * 1024 * 1024;
const ENV_BUDGET_HEADROOM_RATIO = 0.8;

let cachedBudgetBytes: number | undefined;

/**
 * Resolve the system's ARG_MAX and derive an env budget (80% of ARG_MAX,
 * leaving 20% headroom for argv, the executable path, and padding).
 *
 * Detection order:
 * 1. /proc/sys/kernel/argmax (Linux, no subprocess)
 * 2. `getconf ARG_MAX` (POSIX, cross-platform)
 * 3. Fallback: 2MB (standard Linux default)
 *
 * Result is computed lazily on first call and cached.
 */
export function resolveEnvBudgetBytes(): number {
  if (cachedBudgetBytes !== undefined) return cachedBudgetBytes;

  let argMax: number | undefined;

  // 1. procfs (fast, no spawn)
  try {
    argMax = parseInt(readFileSync('/proc/sys/kernel/argmax', 'utf8').trim(), 10);
  } catch {
    // not Linux or procfs unavailable
  }

  // 2. getconf (POSIX)
  if (!argMax || Number.isNaN(argMax)) {
    try {
      argMax = parseInt(execSync('getconf ARG_MAX', { encoding: 'utf8', timeout: 2_000 }).trim(), 10);
    } catch {
      // getconf not available
    }
  }

  // 3. Fallback
  if (!argMax || Number.isNaN(argMax) || argMax <= 0) {
    argMax = ENV_BUDGET_FALLBACK_BYTES;
  }

  cachedBudgetBytes = Math.floor(argMax * ENV_BUDGET_HEADROOM_RATIO);
  return cachedBudgetBytes;
}

/** Parse comma-separated CORAL_ENV_PASSTHROUGH value into a set of protected var names. */
export function parsePassthrough(raw: string | undefined): Set<string> {
  if (!raw) return new Set<string>();
  const passthrough = new Set<string>();
  for (const entry of raw.split(',')) {
    const name = entry.trim();
    if (name.length > 0) {
      passthrough.add(name);
    }
  }
  return passthrough;
}

/** Measure total execve env size: sum of "KEY=VALUE\0" per entry. */
export function measureEnv(env: Record<string, string>): number {
  let size = 0;
  for (const [key, value] of Object.entries(env)) {
    size += key.length + 1 + value.length + 1;
  }
  return size;
}

/**
 * Drop the largest env vars until total size fits within budget.
 * Vars in the passthrough set are never dropped.
 * Returns the original object unchanged if already within budget.
 */
function shedIfOverBudget(
  base: Record<string, string>,
  budget: number,
  passthrough: Set<string>,
): Record<string, string> {
  const originalSize = measureEnv(base);
  if (originalSize <= budget) return base;

  const entries = Object.entries(base).sort((left, right) => right[1].length - left[1].length);
  const originalCount = entries.length;
  const kept: Record<string, string> = {};
  let currentSize = originalSize;
  let shedCount = 0;
  const shedNames: string[] = [];

  for (const [key, value] of entries) {
    if (currentSize <= budget || passthrough.has(key)) {
      kept[key] = value;
      continue;
    }

    currentSize -= key.length + 1 + value.length + 1;
    shedCount += 1;
    if (shedNames.length < 10) {
      shedNames.push(key);
    }
  }

  const shedList =
    shedNames.join(', ') + (shedCount > shedNames.length ? `, ... (+${shedCount - shedNames.length} more)` : '');
  backendLog.warn(
    `child-env: shed ${shedCount}/${originalCount} vars ` +
      `(${(originalSize / 1024).toFixed(0)}KB -> ${(currentSize / 1024).toFixed(0)}KB, ` +
      `budget=${(budget / 1024).toFixed(0)}KB) [${shedList}]` +
      (shedCount > 0 ? ' - set CORAL_ENV_PASSTHROUGH=VAR1,VAR2 to protect specific vars' : ''),
  );

  return kept;
}

/** Remove all keys starting with `CORAL_` from an env record. */
function stripInternalCoralKeys(env: Readonly<Record<string, string>>): Record<string, string> {
  const stripped: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('CORAL_')) continue;
    stripped[key] = value;
  }
  return stripped;
}

/**
 * Delete the inherited Claude Code session identity — `CLAUDECODE` and the `CLAUDE_*`
 * family (`CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_CHILD_SESSION`, `CLAUDE_ENV_FILE`, …) —
 * from `env`, in place. `CLAUDE_CONFIG_DIR` is the one exception, preserved (see below).
 *
 * The Coral backend is a long-lived shared daemon, almost always spawned from inside a
 * Claude Code session (the SessionStart hook or the CLI auto-ensure path). It therefore
 * inherits that one session's Claude Code env and would freeze it onto every provider
 * child it spawns for the daemon's whole lifetime. Most damaging: an inherited
 * `CLAUDE_CODE_CHILD_SESSION` makes every spawned `claude` treat itself as a parent-owned
 * sub-session and skip writing its own `~/.claude/projects/<id>.jsonl` session log — the
 * very log the broker tails to detect turn completion (its absence hangs every turn until
 * the staleness watchdog aborts it). The backend reads none of these vars at runtime (its
 * plugin root is the build-time `__PLUGIN_ROOT__`), so the daemon sheds them at startup:
 * every provider child then launches with a clean, top-level environment, exactly as if
 * run from a fresh shell. Coral still tags its children with `CORAL_CHILD` so its own
 * hooks self-suppress.
 *
 * Pass the live `process.env` — it is mutated in place. `CLAUDE_CONFIG_DIR` is preserved:
 * the daemon is isolated per config dir (its plugin and backend binary install *inside*
 * that dir), so every session it serves shares the one config dir. The daemon resolves its
 * `.claude` paths and partitions its state tree from it, and forwards it to spawned `claude`
 * children so they read the matching settings/credentials/session logs. Only the per-session
 * identity vars are shed — freezing one launcher session's identity onto every child would
 * make each `claude` skip its own session log and hang the broker's turn detection.
 */
export function shedInheritedClaudeCodeEnv(env: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(env)) {
    if (key === 'CLAUDE_CONFIG_DIR') continue;
    if (key === 'CLAUDECODE' || key.startsWith('CLAUDE_')) {
      delete env[key];
    }
  }
}

/**
 * Compose the launch env for a child process from a captured inherited env snapshot.
 *
 * Applies the same production ordering everywhere:
 * 1. Strip internal CORAL_* keys from the inherited env snapshot
 * 2. Shed oversized inherited env entries against the provided budget
 * 3. Overlay launch-specific additions
 * 4. Mark the child boundary with CORAL_CHILD=1
 */
export function composeChildEnv(
  baseEnv: Readonly<Record<string, string>>,
  envAdditions: Record<string, string>,
  budgetBytes: number,
  passthrough: Set<string>,
): Record<string, string> {
  const stripped = stripInternalCoralKeys(baseEnv);
  // CLAUDE_CONFIG_DIR is load-bearing for spawned `claude` children: it routes
  // their session logs to the daemon's config dir, which the broker tails for
  // turn detection. Protect it from size-based shedding regardless of budget.
  const protectedPassthrough = new Set(passthrough).add('CLAUDE_CONFIG_DIR');
  const inheritedEnv = shedIfOverBudget(stripped, budgetBytes, protectedPassthrough);
  return {
    ...inheritedEnv,
    ...envAdditions,
    CORAL_CHILD: '1',
  };
}

/**
 * Convenience wrapper that reads the live `process.env` and applies the same
 * sanitization pipeline. Used at provider call sites that don't have an
 * explicit env captured by the runtime layer.
 */
export function buildChildEnv(extraEnv?: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      base[key] = value;
    }
  }
  return composeChildEnv(
    base,
    extraEnv ?? {},
    resolveEnvBudgetBytes(),
    parsePassthrough(process.env.CORAL_ENV_PASSTHROUGH),
  );
}
