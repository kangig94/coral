import type { VectorRetrieval } from '../../kb/search/contract.js';
import type { KbRuntimeActivationSnapshot } from '../../kb/contracts.js';
import type { ConsumerHandle } from '../consumer-driver.js';

export type RuntimeActivationSnapshot = KbRuntimeActivationSnapshot;

export function emptySnapshot(retrieval: VectorRetrieval): RuntimeActivationSnapshot {
  return {
    retrieval,
    snapshotId: null,
    contentSeq: 0,
    contentManifestHash: null,
  };
}

export function runtimeActivationFromHandle(
  retrieval: VectorRetrieval,
  handle: ConsumerHandle,
): RuntimeActivationSnapshot {
  const status = handle.status();
  if (status.authority !== 'corpus') {
    return emptySnapshot(retrieval);
  }

  return {
    retrieval,
    snapshotId: status.snapshotId,
    contentSeq: status.contentSeq,
    contentManifestHash: status.contentManifestHash,
  };
}
