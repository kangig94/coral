import { describe, expect, it } from 'vitest';

import {
  ProviderEventBackpressureError,
  collectProviderEvents,
  providerProgressEvent,
  streamProviderEvents,
} from '../stream.js';
import type { ProviderEventBody } from '../contract.js';

describe('streamProviderEvents', () => {
  it('fails with a backpressure error when the producer outruns an absent consumer', async () => {
    const stream = streamProviderEvents<ProviderEventBody>((emit) => {
      for (let i = 0; i <= 1024; i += 1) {
        emit(providerProgressEvent(`step ${i}`, `2026-04-20T00:00:${String(i % 60).padStart(2, '0')}.000Z`));
      }
    });

    await Promise.resolve();

    await expect(collectProviderEvents(stream)).rejects.toBeInstanceOf(ProviderEventBackpressureError);
  });
});
