import { expect, it } from 'vitest';

import { STORE_EPOCH_OPEN_RETRY_BUDGET_MS } from '#src/store/epoch.js';
import { HEALTH_TIMEOUT_MS } from '#src/transport/health.js';

it('keeps the store-epoch retry window below the health timeout with a safety margin', () => {
  expect(HEALTH_TIMEOUT_MS - STORE_EPOCH_OPEN_RETRY_BUDGET_MS).toBeGreaterThanOrEqual(1_000);
});
