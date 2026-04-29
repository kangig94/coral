import type { CorpusInterest } from '../../store/consumer-contract.js';
import type { CorpusSnapshot } from './snapshot.js';

export type EngineArtifactKind = 'authority-mirror' | 'projection-cache';

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
