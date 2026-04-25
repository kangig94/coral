import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Tmp scratch root for live job artifacts (recordings, intermediates).
 * Distinct from `runtime.paths.coral.exports.jobsRoot`, which is the
 * persistent export directory for completed job results.
 */
export function jobsDir(): string {
  return join(tmpdir(), 'coral-jobs');
}
