import { describe, expect, it, vi } from 'vitest';

import type { KbCorpusSnapshot, KbRuntime, KbRuntimeActivationSnapshot } from '../../contracts.js';
import type { VectorRetrieval } from '../contract.js';
import { resolveVectorRoute } from '../router.js';

type BackendVectorRetrieval = VectorRetrieval & {
  readonly backendKind: 'needle' | 'orama';
};

function createVectorRetrieval(backendKind: BackendVectorRetrieval['backendKind']): BackendVectorRetrieval {
  return {
    backendKind,
    search: vi.fn(async () => ({ hits: [] })),
  };
}

describe('resolveVectorRoute', () => {
  it('uses runtime.getCorpusStateSnapshot without touching runtime.db', () => {
    const base = createVectorRetrieval('orama');
    const needle = createVectorRetrieval('needle');
    const corpusSnapshot: KbCorpusSnapshot = {
      snapshotId: 'snapshot-1',
      contentSeq: 7,
      metadataSeq: 0,
      contentManifestHash: 'manifest-1',
      metadataManifestHash: 'metadata-1',
    };
    const activation: KbRuntimeActivationSnapshot = {
      retrieval: needle,
      snapshotId: 'snapshot-1',
      contentSeq: 7,
      contentManifestHash: 'manifest-1',
    };
    const getCorpusStateSnapshot = vi.fn(() => corpusSnapshot);

    const runtime = {
      getEquipmentView: () => activation,
      getActiveVectorSurface: () => needle,
      getBaseRetrievalSurface: () => base,
      getCorpusStateSnapshot,
      get db() {
        throw new Error('resolveVectorRoute should not touch runtime.db');
      },
    } as unknown as KbRuntime;

    expect(resolveVectorRoute(runtime)).toEqual({
      retrieval: needle,
      backend: 'needle',
    });
    expect(getCorpusStateSnapshot).toHaveBeenCalledTimes(1);
  });
});
