export const DEFAULT_JOBS_DIR = '/tmp/sim/jobs';
export const DEFAULT_SESSION_BASE = '/tmp/sim/sessions';
export const DEFAULT_INSTALLATIONS_DIR = '/tmp/sim/installations';
export const DEFAULT_CORAL_ROOT = '/tmp/sim/coral';

export function toError(value: Error | string): Error {
  return value instanceof Error ? value : new Error(value);
}
