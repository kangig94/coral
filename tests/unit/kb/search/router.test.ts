import { describe, expect, it, vi } from 'vitest';

import type { Backed, KbRuntime } from '#src/kb/contract.js';
import type { VectorRetrieval } from '#src/kb/search/contract.js';
import { createRuntimeBinding } from '#src/runtime/binding.js';
import { createRouter } from '#src/kb/search/router.js';

function createVectorBacked(): { backed: Backed<VectorRetrieval>; retrieval: VectorRetrieval } {
  const retrieval: VectorRetrieval = {
    search: vi.fn(async () => ({ hits: [] })),
  };
  return {
    retrieval,
    backed: {
      read: () => retrieval,
      consumer: {
        id: 'mock-vector',
        authority: 'corpus',
        kind: 'apply',
        registrationKind: 'expansion',
        corpusInterest: 'content',
        apply: async () => {},
      },
    },
  };
}

describe('createRouter', () => {
  it('lazily reads the vector binding when invoked', async () => {
    const { backed: vectorBacked, retrieval: vectorRetrieval } = createVectorBacked();
    const vector = createRuntimeBinding<Backed<VectorRetrieval>>('kb.vector');
    vector.bind(vectorBacked, { [Symbol.dispose]() {} }, 'mock-vector');

    const runtime = { vector } as unknown as KbRuntime;

    const router = createRouter(runtime);
    await router.vector.search([0.1, 0.2], 5);

    expect(vectorRetrieval.search).toHaveBeenCalledTimes(1);
  });
});
