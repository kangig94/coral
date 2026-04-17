/**
 * Environment sanitization for child process spawning.
 *
 * Builds a sanitized env for child CLI processes by stripping CORAL_* internal
 * vars, applying size-budget shedding, and overlaying caller-supplied extras.
 * Pure sanitization primitives live in env-sanitize.ts.
 */

import {
  parsePassthrough,
  resolveEnvBudgetBytes,
  shedIfOverBudget,
  stripInternalCoralKeys,
} from './env-sanitize.js';

/** Re-export for test access. */
export { measureEnv, resolveEnvBudgetBytes as envBudgetBytes } from './env-sanitize.js';

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
  const base = stripInternalCoralKeys(
    Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    ),
  );

  // 2. Apply budget shedding if needed (only on base — extraEnv is sacred)
  const budget = resolveEnvBudgetBytes();
  const passthrough = parsePassthrough(process.env.CORAL_ENV_PASSTHROUGH);
  const shedded = shedIfOverBudget(base, budget, passthrough);

  // 3. Overlay extraEnv (takes precedence, never shed) + CORAL_CHILD
  return {
    ...shedded,
    ...extraEnv,
    CORAL_CHILD: '1',
  };
}
