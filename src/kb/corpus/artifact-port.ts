import type { CorpusInterest } from '../../store/consumer-contract.js';
import type { CorpusSnapshot } from './snapshot.js';

/**
 * `'projection-cache'` — files an engine derives from authority (Corpus
 * markdown / Journal events) that are fully rebuildable from that authority.
 */
type EngineArtifactKind = 'projection-cache';

export type EngineArtifactProjectedSnapshot = Pick<
  CorpusSnapshot,
  'snapshotId' | 'contentSeq' | 'metadataSeq' | 'contentManifestHash' | 'metadataManifestHash'
> & {
  readonly projectionIdentityHash: string;
  readonly generatedCommunityGeneration?: number;
  readonly generatedCommunityDocsHash?: string;
};

type EngineArtifactFreshness =
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
  readonly projectsGeneratedCommunityDocs?: boolean;
  readonly freshness: EngineArtifactFreshness;
}

export interface EngineArtifactPort {
  describeArtifacts(): Promise<readonly EngineArtifactDescriptor[]>;
}
