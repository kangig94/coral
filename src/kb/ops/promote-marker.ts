import { join } from 'node:path';

import type { KbEntryId } from '../entry-types.js';
import { KB_RUNTIME_AUTHORITY } from '../runtime-authority.js';

export const PROMOTE_MARKER_VERSION = 1 as const;

/**
 * Promote-recovery marker phase. Recovery dispatches on this enum at startup
 * and either rolls forward or rolls back per the AC31 recovery semantics.
 */
export type PromoteRecoveryPhase =
  | 'marker-created'
  | 'payloads-staged'
  | 'note-written'
  | 'wiki-written'
  | 'state-committed'
  | 'memo-removed'
  | 'cleanup-complete';

/**
 * Versioned on-disk marker schema. Every transition is written via
 * tmp+fsync+rename+parent-fsync; recovery reads the latest marker plus the
 * staged payloads and backups to reconstruct the durable state.
 */
export interface PromoteRecoveryMarker {
  version: typeof PROMOTE_MARKER_VERSION;
  promoteId: string;
  phase: PromoteRecoveryPhase;
  memoPath: string;
  noteSlug: string;
  noteEntryId: KbEntryId;
  notePath: string;
  wikiSlug: string;
  wikiEntryId: KbEntryId;
  wikiPath: string;
  stagedNotePath: string;
  stagedWikiPath: string;
  backupWikiPath?: string;
  oldWikiHash?: string;
  newNoteHash: string;
  newWikiHash: string;
  /** Note frontmatter snapshot the live promote captured at lock entry. */
  noteSource: string[];
  noteCreatedAt: string;
  noteUpdatedAt: string;
  noteEntrySeq: number;
  noteTags: string[];
  createdAt: string;
  updatedAt: string;
}

export function promoteRecoveryDir(runtimeDir: string): string {
  return join(runtimeDir, KB_RUNTIME_AUTHORITY.promoteRecovery);
}

export function promoteRecoveryMarkerPath(runtimeDir: string, promoteId: string): string {
  return join(promoteRecoveryDir(runtimeDir), `${promoteId}.json`);
}

export function promoteRecoveryStagingDir(runtimeDir: string, promoteId: string): string {
  return join(promoteRecoveryDir(runtimeDir), 'payloads', promoteId);
}

export function promoteRecoveryBackupDir(runtimeDir: string, promoteId: string): string {
  return join(promoteRecoveryDir(runtimeDir), 'backups', promoteId);
}
