import type { EnvPort } from '../infra/port-types.js';

export const DEFAULT_STALE_CHECK_INTERVAL_MS = 500;
export const DEFAULT_STALE_TIMEOUT_MS = 900_000;

/**
 * Default grace period for sibling atoms after a slot fails. The wait loop
 * issues `executionSvc.abort()` on entering failure-drain and then waits
 * up to this deadline for in-flight atoms to surface a terminal before
 * forcing the workflow to complete. 15s covers typical provider abort
 * latency; long-running siblings (large model turns, network stalls) may
 * need more — override via `CORAL_WORKFLOW_DRAIN_TIMEOUT_MS`.
 */
export const DEFAULT_DRAIN_DEADLINE_MS = 15_000;

export const CORAL_WORKFLOW_DRAIN_TIMEOUT_MS_ENV = 'CORAL_WORKFLOW_DRAIN_TIMEOUT_MS';

export function resolveDrainDeadlineMs(env: Pick<EnvPort, 'get'>): number {
  const raw = env.get(CORAL_WORKFLOW_DRAIN_TIMEOUT_MS_ENV);
  if (raw === undefined || raw.trim() === '') return DEFAULT_DRAIN_DEADLINE_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_DRAIN_DEADLINE_MS;
  return parsed;
}
