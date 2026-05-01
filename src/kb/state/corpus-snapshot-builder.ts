import type { ManifestAuthority } from '../corpus/manifest-authority.js';
import type { KbIndexStateSnapshot } from '../corpus/lanes.js';
import { deriveStableCorpusSnapshotId, type CorpusSnapshot } from '../corpus/snapshot.js';

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
