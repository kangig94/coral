import { describe, expect, it } from 'vitest';

import { getMaxWorkers } from '#src/coordinator/live/worker-limits.js';
import { MAX_PROXY_LIVE_PROVIDER_ROOTS } from '#src/provider-proxy/provider-root-authority.js';

describe('provider-proxy-root-capacity', () => {
  it('should let one proxy set run a host for every worker the coordinator can admit', () => {
    expect(MAX_PROXY_LIVE_PROVIDER_ROOTS).toBeGreaterThanOrEqual(getMaxWorkers({ get: () => '1000000' }));
  });
});
