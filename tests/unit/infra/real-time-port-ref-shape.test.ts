import { describe, expect, it } from 'vitest';

import { createRealTimePort } from '#src/infra/time.js';

/**
 * `src/coordinator/shutdown.ts`'s `keepaliveGuardedRetryAfter` depends on `setInterval` staying ref'd: an
 * unref'd keepalive lets the event loop drain and the process exit before a held authority-release
 * disposition's `retryAfter` ever resolves. This is checked against the real Node `Timeout` handle
 * (`.hasRef()`), not a fake time port's call log, because a call log cannot observe ref state at all.
 */
describe('createRealTimePort ref shape', () => {
  it("returns a ref'd setInterval handle, unlike sleep which unrefs its own timer", () => {
    const time = createRealTimePort();
    const interval = time.setInterval(() => {}, 60_000);
    try {
      expect((interval as NodeJS.Timeout).hasRef()).toBe(true);
    } finally {
      time.clearInterval(interval);
    }
  });
});
