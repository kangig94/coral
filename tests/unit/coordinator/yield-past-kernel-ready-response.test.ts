import { describe, expect, it } from 'vitest';

import { yieldPastKernelReadyResponse } from '#src/coordinator/lifecycle.js';

describe('yieldPastKernelReadyResponse', () => {
  it('waits for the whole microtask queue to drain, not a fixed number of microtask hops', async () => {
    // A macrotask boundary (setImmediate) is only crossed once every microtask is drained, however deep the
    // chain — unlike `await Promise.resolve()`, which resolves after a fixed, small number of hops regardless
    // of what else is still queued. Chaining far more hops than any such fixed-hop stand-in would cross is
    // what distinguishes a real yield from one that merely looks like it waits.
    const order: string[] = [];
    const yielded = yieldPastKernelReadyResponse().then(() => order.push('yielded'));

    let chain: Promise<unknown> = Promise.resolve();
    for (let hop = 0; hop < 50; hop += 1) {
      chain = chain.then(() => undefined);
    }
    const longMicrotaskChain = chain.then(() => order.push('long-microtask-chain'));

    await Promise.all([yielded, longMicrotaskChain]);

    expect(order).toEqual(['long-microtask-chain', 'yielded']);
  });
});
