import type { CorpusInterest } from '../../store/consumer-contract.js';
import type { CorpusSnapshot } from './snapshot.js';

/**
 * Engine artifact category. `'projection-cache'` covers all current artifact
 * kinds — files an engine derives from authority (Corpus markdown / Journal
 * events) and that are fully rebuildable from that authority. New variants
 * (e.g. an authoritative mirror format) will be added when an actual engine
 * needs them.
 */
export type EngineArtifactKind = 'projection-cache';

export type EngineArtifactProjectedSnapshot = Pick<
  CorpusSnapshot,
  'snapshotId' | 'contentSeq' | 'metadataSeq' | 'contentManifestHash' | 'metadataManifestHash'
> & {
  readonly projectionIdentityHash: string;
};

export type EngineArtifactFreshness =
  | {
      readonly status: 'present';
      readonly projected: EngineArtifactProjectedSnapshot;
    }
  | {
      readonly status: 'missing';
    }
  | {
      readonly status: 'corrupt';
      readonly diagnostic: string;
    };

export interface EngineArtifactDescriptor {
  readonly artifactId: string;
  readonly kind: EngineArtifactKind;
  readonly targetConsumerIds: readonly string[];
  readonly corpusInterest: CorpusInterest;
  readonly artifactPaths: readonly string[];
  readonly expectedProjectionIdentityHash: string;
  readonly freshness: EngineArtifactFreshness;
}

export interface EngineArtifactPort {
  describeArtifacts(): Promise<readonly EngineArtifactDescriptor[]>;
}
