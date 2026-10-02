import { describe, expect, it } from 'vitest';

import { applyProviderEventAtSeq, type ProviderEventEffectPort } from '#src/jobs/provider-event.js';
import { type ProviderTerminalEventBody } from '#src/providers/contract.js';
import { createDeferred } from '#tools/testing/deferred.js';

const identity = { jobId: 'job-1', operationId: 'operation-1', proxyInstanceId: 'proxy-1', buildSetId: 'build-1' };
const terminal: ProviderTerminalEventBody = {
  kind: 'terminal',
  terminal: { content: 'done', durationMs: 5, outcome: { kind: 'completed' } },
  diagnostics: {},
};

function fixture() {
  let watermark = 0;
  let terminals = 0;
  let releases = 0;
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
    appendJobTerminal: async () => {
      terminals++;
    },
    releaseSessionClaim: async () => {
      releases++;
    },
    markSettlementPending: async () => {},
  };
  return { port, counts: () => ({ terminals, releases }) };
}

describe('applyProviderEventAtSeq', () => {
  it('replays a terminal without a second external effect', async () => {
    const f = fixture();
    await applyProviderEventAtSeq(f.port, { identity, seq: 1, event: terminal });
    expect(await applyProviderEventAtSeq(f.port, { identity, seq: 1, event: terminal })).toEqual({
      kind: 'ack',
      committedThroughProviderSeq: 1,
    });
    expect(f.counts()).toEqual({ terminals: 1, releases: 1 });
  });

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
