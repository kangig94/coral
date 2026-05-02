import { join } from 'node:path';
import type { EnvPort } from '../infra/port-types.js';

/**
 * Tmp scratch root for live job artifacts (recordings, intermediates).
 * Distinct from `runtime.paths.coral.exports.jobsRoot`, which is the
 * persistent export directory for completed job results.
 */
export function jobsDir(env: Pick<EnvPort, 'tmpdir'>): string {
  return join(env.tmpdir(), 'coral-jobs');
}
