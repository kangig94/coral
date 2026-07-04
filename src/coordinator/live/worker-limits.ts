import type { Runtime } from '../../runtime/ports.js';

const CURATE_MAX_WORKERS = 1;

export function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
}

export function getMaxWorkers(env: Pick<Runtime['env'], 'get'>): number {
  return Math.min(Math.max(parsePositiveInt(env.get('CORAL_MAX_WORKERS'), 10), 1), 10);
}

export function getDiscussMaxWorkers(env: Pick<Runtime['env'], 'get'>): number {
  return Math.min(Math.max(parsePositiveInt(env.get('CORAL_DISCUSS_MAX_WORKERS'), 5), 1), 10);
}

export function getActiveLimit(pool: 'default' | 'discuss' | 'curate', env: Pick<Runtime['env'], 'get'>): number {
  if (pool === 'discuss') {
    return getDiscussMaxWorkers(env);
  }
  if (pool === 'curate') {
    return CURATE_MAX_WORKERS;
  }
  return getMaxWorkers(env);
}
