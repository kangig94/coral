/**
 * Pure-function environment sanitization primitives.
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
  return new Set(
    raw
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
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
export function shedIfOverBudget(
  base: Record<string, string>,
  budget: number,
  passthrough: Set<string>,
): Record<string, string> {
  const originalSize = measureEnv(base);
  if (originalSize <= budget) return base;

  const originalCount = Object.keys(base).length;
  const entries = Object.entries(base).sort((left, right) => right[1].length - left[1].length);
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

  const shedList = shedNames.join(', ') + (shedCount > shedNames.length ? `, ... (+${shedCount - shedNames.length} more)` : '');
  backendLog.warn(
    `child-env: shed ${shedCount}/${originalCount} vars ` +
      `(${(originalSize / 1024).toFixed(0)}KB -> ${(currentSize / 1024).toFixed(0)}KB, ` +
      `budget=${(budget / 1024).toFixed(0)}KB) [${shedList}]` +
      (shedCount > 0 ? ' - set CORAL_ENV_PASSTHROUGH=VAR1,VAR2 to protect specific vars' : ''),
  );

  return kept;
}

/** Remove all keys starting with `CORAL_` from an env record. */
export function stripInternalCoralKeys(env: Readonly<Record<string, string>>): Record<string, string> {
  const stripped: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('CORAL_')) continue;
    stripped[key] = value;
  }
  return stripped;
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
  const inheritedEnv = shedIfOverBudget(stripped, budgetBytes, passthrough);
  return {
    ...inheritedEnv,
    ...envAdditions,
    CORAL_CHILD: '1',
  };
}
