import { describe, expect, it } from 'vitest';

import { subscribeJobEvents } from '#src/jobs/shell/event-subscription.js';

describe('subscribeJobEvents', () => {
  it('closes a subscription whose signal was already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const iterator = subscribeJobEvents({ afterSeq: 0, jobIds: ['job-1'], abortSignal: controller.signal })[
      Symbol.asyncIterator
    ]();

    expect(await iterator.next()).toEqual({ value: undefined, done: true });
  });
});
