import { describe, expect, it } from 'vitest';

import { applyProviderEventAtSeq, type ProviderEventEffectPort } from '#src/jobs/provider-event.js';
import { createDeferred } from '#tools/testing/deferred.js';

const identity = { jobId: 'job-1', operationId: 'operation-1', proxyInstanceId: 'proxy-1', buildSetId: 'build-1' };

function fixture() {
  let watermark = 0;
  const port: ProviderEventEffectPort<null> = {
    runInTransaction: (execute) => execute(null),
    verifyIdentity: async () => true,
    readWatermark: async () => watermark,
    advanceWatermark: async (_tx, _identity, seq) => {
      watermark = seq;
    },
    appendProgress: async () => {},
    appendSessionEvent: async () => {},
    appendSessionInterrupted: async () => {},
    appendJobTerminal: async () => {},
    releaseSessionClaim: async () => {},
    markSettlementPending: async () => {},
  };
  return { port };
}

describe('applyProviderEventAtSeq', () => {
  it('does not acknowledge the provider before its checkpoint transaction commits', async () => {
    const f = fixture();
    const checkpointStarted = createDeferred<void>();
    const checkpoint = createDeferred<void>();
    let durable = false;
    let acknowledged = false;
    const port: ProviderEventEffectPort<null> = {
      ...f.port,
      runInTransaction: async (execute) => {
        const result = await execute(null);
        durable = true;
        return result;
      },
      appendSessionEvent: async () => {
        checkpointStarted.resolve();
        await checkpoint.promise;
      },
    };
    const receipt = applyProviderEventAtSeq(port, {
      identity,
      seq: 1,
      event: { kind: 'continuity', conversationRef: null, resumable: false, providerContinuity: null },
    }).then((result) => {
      acknowledged = true;
      expect(durable).toBe(true);
      return result;
    });
    await checkpointStarted.promise;
    expect(acknowledged).toBe(false);
    checkpoint.resolve();
    await expect(receipt).resolves.toEqual({ kind: 'ack', committedThroughProviderSeq: 1 });
  });
});
