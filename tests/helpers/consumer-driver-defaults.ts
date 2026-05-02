// Shared real-fs ConsumerDriver options for tests. Production code threads
// these through the runtime port at composition (`coordinator/index.ts`);
// tests opt into the same shape so the constructor can require them
// without forcing every test site to re-spell ambient timers/clock.

import type { TimePort, TimerHandle } from '#src/infra/port-types.js';

export const REAL_CONSUMER_DRIVER_TIMERS: Pick<TimePort, 'setTimeout' | 'clearTimeout'> = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle: TimerHandle | null) => {
    if (handle !== null) {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    }
  },
};

export const realConsumerDriverNow = (): Date => new Date();
