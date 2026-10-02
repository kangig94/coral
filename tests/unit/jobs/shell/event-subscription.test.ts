import { describe, expect, it } from 'vitest';

import { subscribeJobEvents } from '#src/jobs/shell/event-subscription.js';

describe('subscribeJobEvents', () => {
  it('closes a subscription whose signal was already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const iterator = subscribeJobEvents({ afterSeq: 0, jobIds: ['job-1'], abortSignal: controller.signal })[
      Symbol.asyncIterator
    ]();

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        iterator.next(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error('subscription did not close')), 100);
        }),
      ]);
      expect(result.done).toBe(true);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  });
});
