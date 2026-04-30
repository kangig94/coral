import type { EnvPort, IdPort, ProcessPort, StoragePort, TimePort } from '../../runtime/ports.js';
import type { KbEntryId, EntityType, RelationshipType } from '../entry-types.js';
import type { CurateCursor } from './state/index.js';

export type GitSyncRuntimePicks = {
  processPort: Pick<ProcessPort, 'exec' | 'execSync'>;
  storagePort: Pick<StoragePort, 'readFileSync' | 'existsSync' | 'writeAtomicSync'>;
  envPort: Pick<EnvPort, 'get'>;
  timePort?: Pick<TimePort, 'now'>;
  idsPort?: Pick<IdPort, 'uuid'>;
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
};
