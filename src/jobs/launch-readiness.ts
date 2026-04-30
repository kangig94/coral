import type { LaunchReadiness } from './records.js';
import type { JobProjectionDetail } from './read-contract.js';

export function deriveLaunchReadiness(detail: JobProjectionDetail): LaunchReadiness {
  const status = detail.status;
  if (status === null) {
    return 'pending';
  }

  if (status.phase === 'queued') {
    return 'queued';
  }

  if (status.phase === 'launching') {
    return 'pending';
  }

  if ((status.phase === 'error' || status.phase === 'aborted') && detail.runtime === null) {
    return 'error';
  }

  return 'ready';
}
