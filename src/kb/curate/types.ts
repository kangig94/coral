import type { RuntimeEnvPort, RuntimeProcessPort, RuntimeStoragePort } from '../../runtime/ports.js';
import type { KbIndex, KbEntryId, EntityType, RelationshipType } from '../entry-types.js';
import type { CurateCursor, PendingDiscovery } from './state.js';

export type SpawnCliResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  aborted: boolean;
};

export type SpawnCliFn = (options: {
  provider: string;
  command: string;
  args: string[];
  prompt?: string;
  cwd?: string;
  pool?: 'default' | 'discuss' | 'curate';
  signal?: AbortSignal;
}) => Promise<SpawnCliResult>;

export type GitSyncRuntimePicks = {
  processPort: Pick<RuntimeProcessPort, 'exec' | 'execSync'>;
  storagePort: Pick<RuntimeStoragePort, 'readFileSync' | 'existsSync' | 'writeAtomicSync'>;
  envPort: Pick<RuntimeEnvPort, 'get'>;
};

export type NoteClaimCandidate = {
  kind: 'note';
  entryId: KbEntryId;
  slug: string;
  updatedAt: string;
  cursor: CurateCursor;
};

export type SourceClaimCandidate = {
  kind: 'source';
  entryId: KbEntryId;
  slug: string;
  cursor: CurateCursor;
};

export type ClaimCandidate = NoteClaimCandidate | SourceClaimCandidate;

export type NoteCurateClaimedEntry = {
  kind: 'note';
  entryId: KbEntryId;
  slug: string;
  title: string;
  body: string;
  updatedAt: string;
  entrySeq: number;
};

export type SourceCurateClaimedEntry = {
  kind: 'source';
  entryId: KbEntryId;
  slug: string;
  title: string;
  body: string;
  claimTimeFingerprint: string;
  entrySeq: number;
};

export type CurateClaimedEntry = NoteCurateClaimedEntry | SourceCurateClaimedEntry;
export type DiscoveryCurateClaimedEntry = NoteCurateClaimedEntry;

export type NoteMetadataTarget = {
  kind: 'note';
  entryId: KbEntryId;
  slug: string;
  entrySeq: number;
  claimTimeUpdatedAt: string;
  addTags?: string[];
  addRelated?: string[];
  desiredTags?: string[];
  addPrinciples?: string[];
  removePrinciples?: string[];
  removeTags?: string[];
};

export type ClassificationNewEntity = {
  type: EntityType;
  description: string;
};

export type ClassificationRelationship = {
  source: string;
  target: string;
  type: RelationshipType;
  description: string;
};

export type ClassificationAssignment = {
  entry: string;
  tags: string[];
  principles?: string[];
  related?: string[];
  newEntities?: Record<string, ClassificationNewEntity>;
  relationships?: ClassificationRelationship[];
};

export type DiscoveryProposal = {
  slug: string;
  statement: string;
  notes: string[];
  absorbs?: string[];
};

export type MetadataTarget =
  | {
      kind: 'source';
      entryId: KbEntryId;
      slug: string;
      entrySeq: number;
      claimTimeFingerprint: string;
      addTags?: string[];
      desiredTags?: string[];
      addRelated?: string[];
      removeTags?: string[];
    }
  | NoteMetadataTarget;

export type CurateClaim = {
  entries: CurateClaimedEntry[];
  through: CurateCursor;
};

export type CurateHandle = {
  start(): Promise<void>;
  schedule(): void;
  scheduleDeferredCommit(): void;
  stop(): Promise<void>;
  isRunning(): boolean;
  _testInternals?: {
    claimCurateRun(today: string): Promise<CurateClaim | null>;
    runClassificationBatches(claim: CurateClaim, index: KbIndex): Promise<ClassificationAssignment[]>;
    commitMetadataTargets(targets: MetadataTarget[]): Promise<void>;
    runPrincipleDiscovery(processedThrough: CurateCursor): Promise<void>;
    recordCurateFailure(through: CurateCursor | null, error: unknown): Promise<void>;
    clearCurateRetryState(): Promise<void>;
    recordDiscoveryAttempt(highSeq: number, nextOffset: number): Promise<void>;
    addPendingDiscovery(entry: PendingDiscovery): Promise<void>;
    removePendingDiscovery(entry: PendingDiscovery): Promise<void>;
    runCommunitySubphase(): Promise<boolean>;
    migrateCurateStateIfNeeded(): Promise<void>;
  };
};
