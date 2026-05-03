import { describe, expect, it } from 'vitest';

import { waitForCorpusReadiness } from '#src/coordinator/index.js';
import type { Backed, FtsRetrieval, KbCorpusSnapshot, KbRuntime } from '#src/kb/contract.js';
import type { VectorRetrieval } from '#src/kb/search/contract.js';
import {
  BUILTIN_EMBEDDING_CAPABILITY_DESCRIPTOR,
  BUILTIN_FTS_CAPABILITY_DESCRIPTOR,
  BUILTIN_VECTOR_CAPABILITY_DESCRIPTOR,
  KB_EMBEDDING_CAPABILITY,
  KB_FTS_CAPABILITY,
  KB_VECTOR_CAPABILITY,
} from '#src/kb/capability/constants.js';
import { createCapabilityRegistry } from '#src/kb/capability/registry.js';
import { createRuntimeBinding } from '#src/runtime/binding.js';
import { createDeferred } from '#tools/testing/deferred.js';

function makeKb(bindings: { readonly fts?: string; readonly vector?: string }): Pick<KbRuntime, 'capabilityRegistry'> {
  const registry = createCapabilityRegistry();
  registry.registerBuiltin(
    BUILTIN_FTS_CAPABILITY_DESCRIPTOR,
    createRuntimeBinding<Backed<FtsRetrieval>>(KB_FTS_CAPABILITY),
  );
  registry.registerBuiltin(
    BUILTIN_VECTOR_CAPABILITY_DESCRIPTOR,
    createRuntimeBinding<Backed<VectorRetrieval>>(KB_VECTOR_CAPABILITY),
  );
  registry.registerBuiltin(BUILTIN_EMBEDDING_CAPABILITY_DESCRIPTOR, createRuntimeBinding(KB_EMBEDDING_CAPABILITY));
  const scope = { [Symbol.dispose]() {} };
  const bindConsumer = (name: typeof KB_FTS_CAPABILITY | typeof KB_VECTOR_CAPABILITY, consumerId: string): void => {
    registry.runtimeView().bind(
      name,
      {
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
      },
      scope,
      'test-holder',
    );
  };
  if (bindings.fts !== undefined) {
    bindConsumer(KB_FTS_CAPABILITY, bindings.fts);
  }
  if (bindings.vector !== undefined) {
    bindConsumer(KB_VECTOR_CAPABILITY, bindings.vector);
  }
  return { capabilityRegistry: registry };
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
        ...makeKb({ fts: 'fts-consumer', vector: 'vector-consumer' }),
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
        ...makeKb({ fts: 'fts-consumer', vector: 'vector-consumer' }),
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
        ...makeKb({ fts: 'fts-consumer', vector: 'vector-consumer' }),
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
        ...makeKb({ fts: 'fts-consumer', vector: 'vector-consumer' }),
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
        ...makeKb({ fts: 'fts-consumer' }),
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
          ...makeKb({ vector: 'vector-consumer' }),
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
          ...makeKb({ fts: 'fts-consumer' }),
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
