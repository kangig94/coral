import { describe, expect, it } from 'vitest';

import { waitForCorpusReadiness } from '#src/kb-daemon/services/readiness.js';
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
});
