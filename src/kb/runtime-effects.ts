import type { KbRuntime } from './contracts.js';
import type { EntityGraph } from './entry-types.js';
import type { ManifestAuthorityDelta, ManifestAuthorityLane } from './corpus/manifest-authority.js';

export function queueManifestAuthorityDelta(
  kb: KbRuntime,
  deltas: readonly ManifestAuthorityDelta[],
): void {
  const runtime = kb as KbRuntime & {
    queueManifestAuthorityDelta?: (nextDeltas: readonly ManifestAuthorityDelta[]) => void;
  };
  if (typeof runtime.queueManifestAuthorityDelta !== 'function') {
    throw new Error('KB runtime does not expose manifest-authority delta staging.');
  }
  runtime.queueManifestAuthorityDelta(deltas);
}

export function getManifestAuthorityHash(kb: KbRuntime, lane: ManifestAuthorityLane): string {
  const runtime = kb as KbRuntime & {
    getCurrentManifestAuthorityHash?: (nextLane: ManifestAuthorityLane) => string;
  };
  if (typeof runtime.getCurrentManifestAuthorityHash !== 'function') {
    throw new Error('KB runtime does not expose manifest-authority hashes.');
  }
  return runtime.getCurrentManifestAuthorityHash(lane);
}

export function writeEntityGraphLocked(kb: KbRuntime, graph: EntityGraph): void {
  const runtime = kb as KbRuntime & {
    writeEntityGraphLocked?: (nextGraph: EntityGraph) => void;
  };
  if (typeof runtime.writeEntityGraphLocked !== 'function') {
    throw new Error('KB runtime does not expose lock-held entity graph writes.');
  }
  runtime.writeEntityGraphLocked(graph);
}
