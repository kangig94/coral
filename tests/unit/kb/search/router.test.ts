import { describe, expect, it, vi } from 'vitest';

import type { Backed, FtsRetrieval, KbRuntime, VectorRetrieval } from '#src/kb/contract.js';
import { createRuntimeBinding } from '#src/runtime/binding.js';
import { createRouter } from '#src/kb/search/router.js';

type BackendVectorRetrieval = VectorRetrieval & {
  readonly backendKind: 'needle' | 'orama';
};

function createVectorBacked(
  backendKind: BackendVectorRetrieval['backendKind'],
): { backed: Backed<VectorRetrieval>; retrieval: BackendVectorRetrieval } {
  const retrieval: BackendVectorRetrieval = {
    backendKind,
    read: vi.fn(async () => ({ hits: [] })),
  };
  return {
    retrieval,
    backed: {
      read: () => retrieval,
      consumer: {
        id: `mock-${backendKind}`,
        authority: 'corpus',
        corpusInterest: 'content',
        registrationKind: 'expansion',
      },
    },
  };
}

describe('createRouter', () => {
  it('reads vector and fts bindings without touching runtime.db', () => {
    const { backed: vectorBacked, retrieval: vectorRetrieval } = createVectorBacked('needle');
    const textRetrieval: FtsRetrieval = {
      read: vi.fn(async () => ({ hits: [] })),
    };
    const vector = createRuntimeBinding<Backed<VectorRetrieval>>('kb.vector', vectorBacked);
    const fts = createRuntimeBinding<Backed<FtsRetrieval>>('kb.fts', {
      read: () => textRetrieval,
      consumer: {
        id: 'mock-orama',
        authority: 'corpus',
        corpusInterest: 'content',
        registrationKind: 'base',
      },
    });

    const runtime = {
      vector,
      fts,
      get db() {
        throw new Error('createRouter should not touch runtime.db');
      },
    } as unknown as KbRuntime;

    const router = createRouter(runtime);

    expect(router.vector).toBe(vectorRetrieval);
    expect(router.text).toBe(textRetrieval);
  });
});
