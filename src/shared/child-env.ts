/**
 * Environment sanitization for child process spawning.
 *
 * Prevents E2BIG (execve argument-list-too-long) in environments with large
 * env blocks — common in Kubernetes where service discovery, ConfigMaps, and
 * Secrets can push process.env to hundreds of KB while ARG_MAX may be as low
 * as 128KB.
 *
 * Strategy: size-budget with tiered shedding.
 * - If total env fits within budget → pass everything unchanged.
 * - If over budget → shed categories in priority order until it fits.
 */

import { backendLog } from './backend-log.js';

// Budget: 96KB leaves headroom for argv under a 128KB ARG_MAX.
// Normal environments (< 96KB) experience zero filtering.
const ENV_BUDGET_BYTES = 96 * 1024;

/** Kubernetes service-discovery pattern: `<NAME>_SERVICE_HOST`, `<NAME>_SERVICE_PORT`, `<NAME>_PORT_<N>_<PROTO>_*` */
const K8S_SERVICE_RE =
  /^[A-Z0-9_]+_(?:SERVICE_HOST|SERVICE_PORT(?:_[A-Z0-9_]+)?|PORT(?:_\d+_[A-Z]+(?:_[A-Z_]+)?)?|PORT)$/;
const K8S_PREFIX_RE = /^KUBERNETES_/;

/** Per-value size ceiling for Tier 2 shedding (certificate blobs, mounted secrets). */
const LARGE_VALUE_BYTES = 4 * 1024;

function measureEnv(env: Record<string, string>): number {
  let size = 0;
  for (const key of Object.keys(env)) {
    // execve counts "KEY=VALUE\0" per entry
    size += key.length + 1 + env[key].length + 1;
  }
  return size;
}

type ShedResult = { env: Record<string, string>; shed: number };

function shedTier1(env: Record<string, string>, budget: number): ShedResult {
  const kept: Record<string, string> = {};
  let shed = 0;
  for (const key of Object.keys(env)) {
    if (K8S_SERVICE_RE.test(key) || K8S_PREFIX_RE.test(key)) {
      shed++;
    } else {
      kept[key] = env[key];
    }
  }
  return { env: kept, shed };
}

function shedTier2(env: Record<string, string>): ShedResult {
  const kept: Record<string, string> = {};
  let shed = 0;
  for (const key of Object.keys(env)) {
    if (env[key].length > LARGE_VALUE_BYTES) {
      shed++;
    } else {
      kept[key] = env[key];
    }
  }
  return { env: kept, shed };
}

function shedTier3(env: Record<string, string>, budget: number): ShedResult {
  // Sort entries by value size descending — drop the largest first.
  const entries = Object.entries(env).sort((a, b) => b[1].length - a[1].length);
  const kept: Record<string, string> = {};
  let currentSize = measureEnv(env);
  let shed = 0;

  for (const [key, value] of entries) {
    if (currentSize <= budget) {
      kept[key] = value;
    } else {
      currentSize -= key.length + 1 + value.length + 1;
      shed++;
    }
  }

  // Add remaining entries that weren't iterated past the budget crossing
  // (the loop above marks entries as kept once budget is met, but entries
  // sorted after the crossover point haven't been visited yet).
  // Actually, we iterate ALL entries. If over budget, drop; once under, keep.
  // This is correct — largest values are dropped first.

  return { env: kept, shed };
}

/**
 * Build a sanitized environment for a child CLI process.
 *
 * - Strips `CORAL_*` from the inherited env (child is a different program).
 * - Applies size-budget shedding when total env exceeds 96KB.
 * - Overlays `extraEnv` (always preserved, never shed).
 * - Sets `CORAL_CHILD: '1'`.
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
  let size = measureEnv(base);
  if (size <= ENV_BUDGET_BYTES) return base;

  const originalCount = Object.keys(base).length;
  const originalSize = size;
  let env = base;
  let totalShed = 0;
  const tiers: string[] = [];

  // Tier 1: k8s service discovery vars
  const t1 = shedTier1(env, ENV_BUDGET_BYTES);
  if (t1.shed > 0) {
    env = t1.env;
    totalShed += t1.shed;
    tiers.push(`tier1(k8s): ${t1.shed} vars`);
    size = measureEnv(env);
    if (size <= ENV_BUDGET_BYTES) {
      logShedding(originalSize, size, originalCount, totalShed, tiers);
      return env;
    }
  }

  // Tier 2: individual values > 4KB
  const t2 = shedTier2(env);
  if (t2.shed > 0) {
    env = t2.env;
    totalShed += t2.shed;
    tiers.push(`tier2(large): ${t2.shed} vars`);
    size = measureEnv(env);
    if (size <= ENV_BUDGET_BYTES) {
      logShedding(originalSize, size, originalCount, totalShed, tiers);
      return env;
    }
  }

  // Tier 3: drop largest remaining vars until under budget
  const t3 = shedTier3(env, ENV_BUDGET_BYTES);
  env = t3.env;
  totalShed += t3.shed;
  tiers.push(`tier3(by-size): ${t3.shed} vars`);

  logShedding(originalSize, measureEnv(env), originalCount, totalShed, tiers);
  return env;
}

function logShedding(
  originalSize: number,
  finalSize: number,
  originalCount: number,
  shedCount: number,
  tiers: string[],
): void {
  backendLog.warn(
    `child-env: shed ${shedCount}/${originalCount} vars ` +
      `(${(originalSize / 1024).toFixed(0)}KB → ${(finalSize / 1024).toFixed(0)}KB) ` +
      `[${tiers.join(', ')}]`,
  );
}
