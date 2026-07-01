import type { KbCorpusSnapshot, KbIndexMutationLane, KbIndexState } from '../contract.js';
import type { KbIndex, ReindexResult } from '../entry-types.js';
import type { CorpusAuthorityBaselineGeneration } from './authority-baseline-contract.js';
import type { StagedKbIndexArtifact } from './index/store.js';
import type { StagedManifestSurfaceHashes } from './manifest-authority.js';
import type { CorpusSurface } from './surface.js';
import type { DetectedIncident } from './rescan/incidents/catalog.js';

export type CorpusProjectionSeq = Pick<KbIndexState, 'contentSeq' | 'metadataSeq'>;

export type RescanCounts = Pick<
  ReindexResult,
  | 'notes'
  | 'sources'
  | 'communities'
  | 'wikis'
  | 'principles'
  | 'tags'
  | 'entities'
  | 'relationships'
  | 'entityCoverage'
>;

export type CorpusProjectionCandidate = {
  readonly startSeq: CorpusProjectionSeq;
  readonly priorGeneratedGeneration: number;
  readonly priorGeneratedDocsHash: string;
  readonly index: KbIndex;
  readonly finalSurface: CorpusSurface;
  readonly incidents: readonly DetectedIncident[];
  readonly externalMutation?: KbIndexMutationLane;
  readonly counts: RescanCounts;
};

export type CorpusProjectionCommitPhase =
  | 'pending'
  | 'index_adopted'
  | 'baseline_adopted'
  | 'manifest_adopted'
  | 'state_written'
  | 'committed'
  | 'rolled_back';

export type CorpusProjectionCommitFaultPhase =
  | 'pending'
  | 'index_renamed'
  | 'index_adopted'
  | 'baseline_adopted'
  | 'manifest_adopted'
  | 'state_persisted'
  | 'state_written'
  | 'committed';

export type CorpusProjectionFaultInjection = {
  readonly failAfterPhase?: CorpusProjectionCommitFaultPhase;
};

export type StagedCorpusProjection = {
  readonly commitId: string;
  readonly candidate: CorpusProjectionCandidate;
  readonly stagedIndex: StagedKbIndexArtifact;
  readonly stagedManifestSurface: StagedManifestSurfaceHashes;
  readonly stagedBaseline: CorpusAuthorityBaselineGeneration;
};

export type CorpusProjectionDiscardReason = 'stale_seq' | 'stale_generated_generation';

export type CorpusProjectionCommitResult =
  | {
      readonly status: 'committed';
      readonly commitId: string;
      readonly counts: RescanCounts;
      readonly snapshot: KbCorpusSnapshot;
      readonly state: KbIndexState;
    }
  | {
      readonly status: 'discarded';
      readonly commitId: string;
      readonly reason: CorpusProjectionDiscardReason;
      readonly startSeq: CorpusProjectionSeq;
      readonly currentSeq: CorpusProjectionSeq;
      readonly priorGeneratedGeneration: number;
      readonly currentGeneratedGeneration: number;
    };

export type CorpusProjectionCommitRecord = {
  readonly schemaVersion: 1;
  readonly commitId: string;
  readonly startSeq: CorpusProjectionSeq;
  readonly previousState: KbIndexState | null;
  readonly nextState: KbIndexState | null;
  readonly stagedIndex: {
    readonly stagingDir: string;
    readonly indexPath: string;
    readonly previousIndexPath: string;
    readonly hadPreviousIndex: boolean;
  };
  readonly stagedBaselineGenerationId: string;
  readonly previousBaselineGenerationId: string;
  readonly stagedManifestCommitId: string;
  readonly previousManifestCommitId: string | null;
  readonly phase: CorpusProjectionCommitPhase;
};
