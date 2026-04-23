import type { AbortResult } from '../../jobs/abort-result.js';

import type { AbortRegistry } from './abort-registry.js';

export function abortJobs(registry: AbortRegistry, jobIds: string[]): AbortResult {
  return registry.abort(jobIds);
}
