import { describe, expect, it } from 'vitest';
import { exchangeAcquisitionStage } from '#src/coordinator/live/provider-proxy/set-publication.js';
import { proxyAcquisitionPublishResultSchema } from '#src/provider-proxy/protocol.js';
import { ControlClientError, controlExchangeForTest, type ControlClient } from '#src/provider-proxy/control-client.js';
import { createDeferred } from '#tools/testing/deferred.js';
import { flushMicrotasks, VirtualTime } from '#tools/simulation/core/virtual-time.js';

describe('exchangeAcquisitionStage', () => {
  it('keeps an endpoint budget refusal unknown when the dispatched handler later mutates', async () => {
    const time = new VirtualTime();
    const handlerGate = createDeferred<void>();
    let handlerStarted = false;
    let mutated = false;
    const client: ControlClient = {
      exchange: async () => {
        handlerStarted = true;
        const response = handlerGate.promise.then(() => {
          mutated = true;
          return controlExchangeForTest({
            kind: 'response',
            response: { kind: 'result', value: { state: 'acquisition-published' } },
          });
        });
        const timeout = time.sleep(100).then(() =>
          controlExchangeForTest({
            kind: 'no-response',
            cause: 'timeout',
            error: new ControlClientError('control_call_failed', 'endpoint budget expired', 'timeout'),
          }),
        );
        return Promise.race([response, timeout]);
      },
      faulted: new Promise<never>(() => undefined),
      onFault: () => () => undefined,
      close: () => undefined,
    };

    const pending = exchangeAcquisitionStage(
      client,
      'proxy.acquisition-publish.v1',
      {},
      proxyAcquisitionPublishResultSchema,
    );
    await flushMicrotasks();
    expect(handlerStarted).toBe(true);
    time.tick(100);

    await expect(pending).resolves.toMatchObject({ kind: 'unknown' });
    handlerGate.resolve();
    await flushMicrotasks();
    expect(mutated).toBe(true);
  });
});
