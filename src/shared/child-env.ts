/**
 * Environment sanitization for child process spawning.
 *
 * Prevents E2BIG (execve argument-list-too-long) in environments with large
 * env blocks — common in Kubernetes where service discovery, ConfigMaps, and
 * Secrets can push process.env to hundreds of KB while ARG_MAX may be as low
 * as 128KB.
 *
 * Strategy: size-budget with pure size-based shedding.
 * - If total env fits within budget → pass everything unchanged.
 * - If over budget → drop the largest vars first until it fits.
 * - CORAL_ENV_PASSTHROUGH protects specific vars from being shed.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { backendLog } from './backend-log.js';

/**
 * Resolve the system's ARG_MAX and derive an env budget (80% of ARG_MAX,
 * leaving 20% headroom for argv, the executable path, and padding).
 *
 * Detection order:
 * 1. /proc/sys/kernel/argmax (Linux, no subprocess)
 * 2. `getconf ARG_MAX` (POSIX, cross-platform)
 * 3. Fallback: 2MB (standard Linux default)
 */
function resolveEnvBudget(): number {
  let argMax: number | undefined;

  // 1. procfs (fast, no spawn)
  try {
    argMax = parseInt(readFileSync('/proc/sys/kernel/argmax', 'utf8').trim(), 10);
  } catch {
    // not Linux or procfs unavailable
  }

  // 2. getconf (POSIX)
  if (!argMax || isNaN(argMax)) {
    try {
      argMax = parseInt(execSync('getconf ARG_MAX', { encoding: 'utf8', timeout: 2_000 }).trim(), 10);
    } catch {
      // getconf not available
    }
  }

  // 3. Fallback
  if (!argMax || isNaN(argMax) || argMax <= 0) {
    argMax = 2 * 1024 * 1024;
  }

  return Math.floor(argMax * 0.80);
}

/** Env budget: 80% of system ARG_MAX. Computed once at module load. */
export const ENV_BUDGET_BYTES = resolveEnvBudget();

/**
 * Vars listed in CORAL_ENV_PASSTHROUGH (comma-separated) are never shed.
 * This lets users protect critical env vars in budget-constrained environments.
 */
function parsePassthrough(): Set<string> {
  const raw = process.env.CORAL_ENV_PASSTHROUGH;
  if (!raw) return new Set();
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}

export function measureEnv(env: Record<string, string>): number {
  let size = 0;
  for (const key of Object.keys(env)) {
    // execve counts "KEY=VALUE\0" per entry
    size += key.length + 1 + env[key].length + 1;
  }
  return size;
}

/**
 * Build a sanitized environment for a child CLI process.
 *
 * - Strips `CORAL_*` from the inherited env (child is a different program).
 * - Applies size-budget shedding when total env exceeds 80% of system ARG_MAX.
 * - Overlays `extraEnv` (always preserved, never shed).
 * - Sets `CORAL_CHILD: '1'`.
 *
 * No domain heuristics — shedding is purely size-based (largest vars first).
 * Use `CORAL_ENV_PASSTHROUGH=VAR1,VAR2` to protect specific vars from shedding.
 */
export function buildChildEnv(extraEnv?: Record<string, string>): Record<string, string> {
  // 1. Collect base env, stripping CORAL_* internal vars
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string' && !key.startsWith('CORAL_')) {
      base[key] = value;
    }
  }

  // 2. Apply budget shedding if needed (only on base — extraEnv is sacred)
  const shedded = shedIfOverBudget(base);

  // 3. Overlay extraEnv (takes precedence, never shed) + CORAL_CHILD
  return {
    ...shedded,
    ...extraEnv,
    CORAL_CHILD: '1',
  };
}

function shedIfOverBudget(base: Record<string, string>): Record<string, string> {
  if (measureEnv(base) <= ENV_BUDGET_BYTES) return base;

  const passthrough = parsePassthrough();
  const originalCount = Object.keys(base).length;
  const originalSize = measureEnv(base);

  // Sort entries by value size descending — drop the largest first.
  // Protected (passthrough) vars are never dropped.
  const entries = Object.entries(base).sort((a, b) => b[1].length - a[1].length);
  const kept: Record<string, string> = {};
  let currentSize = originalSize;
  let shed = 0;
  const shedNames: string[] = [];

  for (const [key, value] of entries) {
    if (currentSize <= ENV_BUDGET_BYTES || passthrough.has(key)) {
      kept[key] = value;
    } else {
      currentSize -= key.length + 1 + value.length + 1;
      shed++;
      if (shedNames.length < 10) shedNames.push(key);
    }
  }

  const finalSize = measureEnv(kept);
  const shedList = shedNames.join(', ') + (shed > shedNames.length ? `, ... (+${shed - shedNames.length} more)` : '');
  backendLog.warn(
    `child-env: shed ${shed}/${originalCount} vars ` +
      `(${(originalSize / 1024).toFixed(0)}KB → ${(finalSize / 1024).toFixed(0)}KB, ` +
      `budget=${(ENV_BUDGET_BYTES / 1024).toFixed(0)}KB) [${shedList}]` +
      (shed > 0 ? ' — set CORAL_ENV_PASSTHROUGH=VAR1,VAR2 to protect specific vars' : ''),
  );
  return kept;
}
