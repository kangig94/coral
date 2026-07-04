import type { EnvPort, StoragePort, TimePort } from '../../infra/port-types.js';
import type { IdPort, ProcessPort } from '../../runtime/ports.js';
import type { KbEntryId, EntityType, RelationshipType } from '../entry-types.js';
import type { CurateCursor } from './state/index.js';

export type GitSyncRuntimePicks = {
  processPort: Pick<ProcessPort, 'exec' | 'execSync'>;
  storagePort: Pick<StoragePort, 'readFileSync' | 'existsSync' | 'writeAtomicSync' | 'statSync' | 'rmSync'>;
  envPort: Pick<EnvPort, 'get' | 'claudeConfigDir'>;
  timePort?: Pick<TimePort, 'now'>;
  idsPort?: Pick<IdPort, 'uuid'>;
};

export type NoteClaimCandidate = {
  kind: 'note';
  entryId: KbEntryId;
  slug: string;
  updatedAt: string;
  entrySeq?: number;
  cursor: CurateCursor;
};

type SourceClaimCandidate = {
  kind: 'source';
  entryId: KbEntryId;
  slug: string;
  entrySeq?: number;
  cursor: CurateCursor;
};

export type ClaimCandidate = NoteClaimCandidate | SourceClaimCandidate;

type NoteCurateClaimedEntry = {
  kind: 'note';
  entryId: KbEntryId;
  slug: string;
  title: string;
  body: string;
  updatedAt: string;
  entrySeq?: number;
  cursor: CurateCursor;
};

type SourceCurateClaimedEntry = {
  kind: 'source';
  entryId: KbEntryId;
  slug: string;
  title: string;
  body: string;
  claimTimeFingerprint: string;
  entrySeq?: number;
  cursor: CurateCursor;
};

export type CurateClaimedEntry = NoteCurateClaimedEntry | SourceCurateClaimedEntry;
export type DiscoveryCurateClaimedEntry = NoteCurateClaimedEntry;

export type NoteMetadataTarget = {
  kind: 'note';
  entryId: KbEntryId;
  slug: string;
  entrySeq?: number;
  cursor: CurateCursor;
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
      entrySeq?: number;
      cursor: CurateCursor;
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
