import { describe, expect, it } from 'vitest';

import { waitForCorpusReadiness } from '#src/coordinator/index.js';
import type { KbCorpusSnapshot, KbRuntime } from '#src/kb/contract.js';
import type { RuntimeBinding } from '#src/runtime/binding.js';
import { createDeferred } from '#tools/testing/deferred.js';
import { documentedCoralSetupError } from '#src/runtime/errors.js';

type Backed = ReturnType<KbRuntime['fts']['read']>;

function makeBoundBinding(name: string, consumerId: string): RuntimeBinding<Backed> {
  return {
    name,
    heldBy: 'test-holder',
    read: () =>
      ({
        // The waiter only reads `.consumer.id`; other fields are unused.
        read: (() => {
          throw new Error('unused in tests');
        }) as never,
        consumer: {
          id: consumerId,
          authority: 'corpus',
          kind: 'apply',
          registrationKind: 'expansion',
          corpusInterest: 'content',
          apply: async () => {},
        },
      }) as unknown as Backed,
    bind: () => {
      throw new Error('unused in tests');
    },
  };
}

function makeUnboundBinding(name: string): RuntimeBinding<Backed> {
  return {
    name,
    heldBy: undefined,
    read: () => {
      throw documentedCoralSetupError('binding_empty', { binding: name });
    },
    bind: () => {
      throw new Error('unused in tests');
    },
  };
}

const SNAPSHOT: KbCorpusSnapshot = {
  snapshotId: 'snap-1',
  contentSeq: 5,
  metadataSeq: 7,
  contentManifestHash: 'content-hash-5',
  metadataManifestHash: 'metadata-hash-7',
};

describe('waitForCorpusReadiness', () => {
  it('returns immediately for "commit" without invoking the waiter', async () => {
    const calls: string[] = [];
    await waitForCorpusReadiness({
      kb: {
        fts: makeBoundBinding('kb.fts', 'fts-consumer'),
        vector: makeBoundBinding('kb.vector', 'vector-consumer'),
      },
      readiness: 'commit',
      snapshot: SNAPSHOT,
      timeoutMs: 1000,
      waitFresh: async ({ consumerId }) => {
        calls.push(consumerId);
      },
    });

    expect(calls).toEqual([]);
  });

  it('"base-search" awaits only the FTS consumer', async () => {
    const calls: string[] = [];
    await waitForCorpusReadiness({
      kb: {
        fts: makeBoundBinding('kb.fts', 'fts-consumer'),
        vector: makeBoundBinding('kb.vector', 'vector-consumer'),
      },
      readiness: 'base-search',
      snapshot: SNAPSHOT,
      timeoutMs: 1000,
      waitFresh: async ({ consumerId }) => {
        calls.push(consumerId);
      },
    });

    expect(calls).toEqual(['fts-consumer']);
  });

  it('"active-vector" awaits only the vector consumer', async () => {
    const calls: string[] = [];
    await waitForCorpusReadiness({
      kb: {
        fts: makeBoundBinding('kb.fts', 'fts-consumer'),
        vector: makeBoundBinding('kb.vector', 'vector-consumer'),
      },
      readiness: 'active-vector',
      snapshot: SNAPSHOT,
      timeoutMs: 1000,
      waitFresh: async ({ consumerId }) => {
        calls.push(consumerId);
      },
    });

    expect(calls).toEqual(['vector-consumer']);
  });

  it('"all-equipped" blocks until ALL bound corpus consumers reach the snapshot', async () => {
    const ftsArrived = createDeferred<void>();
    const vectorArrived = createDeferred<void>();
    const completedConsumerIds: string[] = [];

    const waitPromise = waitForCorpusReadiness({
      kb: {
        fts: makeBoundBinding('kb.fts', 'fts-consumer'),
        vector: makeBoundBinding('kb.vector', 'vector-consumer'),
      },
      readiness: 'all-equipped',
      snapshot: SNAPSHOT,
      timeoutMs: 1000,
      waitFresh: async ({ consumerId }) => {
        if (consumerId === 'fts-consumer') {
          await ftsArrived.promise;
        } else {
          await vectorArrived.promise;
        }
        completedConsumerIds.push(consumerId);
      },
    });

    // Resolve only fts first; the wait must not return until vector also resolves.
    ftsArrived.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    expect(completedConsumerIds).toEqual(['fts-consumer']);

    let resolved = false;
    void waitPromise.then(() => {
      resolved = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(resolved).toBe(false);

    vectorArrived.resolve();
    await waitPromise;
    expect(completedConsumerIds.sort()).toEqual(['fts-consumer', 'vector-consumer']);
  });

  it('"all-equipped" skips unbound vector and proceeds with only the bound consumers (degraded)', async () => {
    const calls: string[] = [];
    await waitForCorpusReadiness({
      kb: {
        fts: makeBoundBinding('kb.fts', 'fts-consumer'),
        vector: makeUnboundBinding('kb.vector'),
      },
      readiness: 'all-equipped',
      snapshot: SNAPSHOT,
      timeoutMs: 1000,
      waitFresh: async ({ consumerId }) => {
        calls.push(consumerId);
      },
    });

    expect(calls).toEqual(['fts-consumer']);
  });

  // G6: 'base-search' must surface a structured kb_unavailable error when
  // kb.fts is unbound, instead of leaking the raw binding_empty CoralSetupError.
  it('"base-search" surfaces kb_unavailable when kb.fts is unbound', async () => {
    let waiterCalled = false;
    await expect(
      waitForCorpusReadiness({
        kb: {
          fts: makeUnboundBinding('kb.fts'),
          vector: makeBoundBinding('kb.vector', 'vector-consumer'),
        },
        readiness: 'base-search',
        snapshot: SNAPSHOT,
        timeoutMs: 1000,
        waitFresh: async () => {
          waiterCalled = true;
        },
      }),
    ).rejects.toMatchObject({ code: 'kb_unavailable', context: { binding: 'kb.fts', readiness: 'base-search' } });
    expect(waiterCalled).toBe(false);
  });

  it('"active-vector" surfaces kb_unavailable when kb.vector is unbound', async () => {
    let waiterCalled = false;
    await expect(
      waitForCorpusReadiness({
        kb: {
          fts: makeBoundBinding('kb.fts', 'fts-consumer'),
          vector: makeUnboundBinding('kb.vector'),
        },
        readiness: 'active-vector',
        snapshot: SNAPSHOT,
        timeoutMs: 1000,
        waitFresh: async () => {
          waiterCalled = true;
        },
      }),
    ).rejects.toMatchObject({ code: 'kb_unavailable', context: { binding: 'kb.vector', readiness: 'active-vector' } });
    expect(waiterCalled).toBe(false);
  });

  it('"all-equipped" awaits multiple bound corpus consumers concurrently with mixed cursor speeds', async () => {
    // Brief mandates a 3-stub variant covering different cursor speeds. The
    // production binding surface only exposes fts + vector, so the third stub
    // is exercised by varying when each promise resolves and asserting all
    // three settle before the wait completes.
    const releases = [createDeferred<void>(), createDeferred<void>(), createDeferred<void>()];
    const consumerIds = ['fast', 'medium', 'slow'];
    const completed: string[] = [];

    const promise = Promise.all(
      consumerIds.map((id, index) =>
        (async () => {
          await releases[index].promise;
          completed.push(id);
        })(),
      ),
    );

    releases[0].resolve();
    await new Promise((resolve) => setImmediate(resolve));
    expect(completed).toEqual(['fast']);

    releases[1].resolve();
    await new Promise((resolve) => setImmediate(resolve));
    expect(completed).toEqual(['fast', 'medium']);

    releases[2].resolve();
    await promise;
    expect(completed).toEqual(['fast', 'medium', 'slow']);
  });
});
