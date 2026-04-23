import type { VectorRetrieval } from '../../kb/search/contract.js';
import type { KbRuntimeActivationSnapshot } from '../../kb/contracts.js';
import type { ConsumerHandle } from '../../coordinator/consumer-driver.js';

/** Re-exports the KB-facing runtime activation shape so coordinator equipment code shares one contract. */
export type RuntimeActivationSnapshot = KbRuntimeActivationSnapshot;

/** Produces the inactive fallback snapshot readers use before equipment is live. */
export function emptySnapshot(retrieval: VectorRetrieval): RuntimeActivationSnapshot {
  return {
    retrieval,
    snapshotId: null,
    contentSeq: 0,
    contentManifestHash: null,
  };
}

/** Derives the router-visible freshness tuple from the registered equipment consumer handle. */
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
