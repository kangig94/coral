import type { AbortResult } from '../../shared/execution-contracts.js';

import type { AbortRegistry } from './abort-registry.js';

export function abortJobs(registry: AbortRegistry, jobIds: string[]): AbortResult {
  return registry.abort(jobIds);
}
