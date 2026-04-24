import type { ManifestAuthority } from './corpus/manifest-authority.js';
import type { KbIndexStateSnapshot } from './corpus/lanes.js';
import { deriveStableCorpusSnapshotId, type CorpusSnapshot } from './corpus/snapshot.js';
import type { KbRuntimeActivationSnapshot } from './contracts.js';
import type { VectorRetrieval } from './search/contract.js';

export function emptyRuntimeActivationSnapshot(retrieval: VectorRetrieval): KbRuntimeActivationSnapshot {
  return {
    retrieval,
    snapshotId: null,
    contentSeq: 0,
    contentManifestHash: null,
  };
}

export function buildCurrentCorpusSnapshot(
  state: KbIndexStateSnapshot,
  manifestAuthority: ManifestAuthority,
): CorpusSnapshot {
  const snapshotWithoutId = {
    contentSeq: state.contentSeq,
    metadataSeq: state.metadataSeq,
    contentManifestHash: manifestAuthority.getCurrentManifestHash('content'),
    metadataManifestHash: manifestAuthority.getCurrentManifestHash('metadata'),
  };

  return {
    ...snapshotWithoutId,
    snapshotId: deriveStableCorpusSnapshotId(snapshotWithoutId),
  };
}
