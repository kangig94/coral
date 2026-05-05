import type { KbCurateActiveClaimRow, KbCurateCommunitySummaryInputFingerprintRow } from '../../state/schema.js';
import { parsePositiveInteger } from '../../validation.js';
import { prepareCached, withImmediate, type Database } from '../../../store/db.js';
import type { ReadonlyDatabase } from '../../../store/read-port.js';
import { readCurateDiscoveryBacklog, syncCurateDiscoveryBacklog } from '../discovery-backlog.js';
import { readCurateRetryQueue } from '../retry.js';
import {
  compareCursor,
  cursorEntryKind,
  defaultCurateState,
  kbEntryIdSchema,
  type CurateCursor,
  type CurateRepairFrontier,
  type CurateState,
  type PendingRepair,
} from './model.js';
import { readCurateSchedulerState, writeCurateSchedulerState } from '../state-scheduler.js';

type ReadHandle = Database | ReadonlyDatabase;

function comparePendingRepair(left: PendingRepair, right: PendingRepair): number {
  if (left.entrySeq === null || right.entrySeq === null) {
    if (left.entrySeq === null && right.entrySeq === null) {
      return left.entryId.localeCompare(right.entryId);
    }

    return left.entrySeq === null ? -1 : 1;
  }

  return compareCursor(
    {
      entryId: left.entryId,
      entrySeq: left.entrySeq,
    },
    {
      entryId: right.entryId,
      entrySeq: right.entrySeq,
    },
  );
}

export function getCurateRepairFrontier(db: ReadHandle): CurateRepairFrontier {
  const queue = readCurateRetryQueue(db);
  if (queue.length === 0) {
    return { kind: 'none' };
  }

  const sorted = [...queue].sort(comparePendingRepair);
  for (const entry of sorted) {
    if (entry.entrySeq === null) {
      return { kind: 'unknown' };
    }
  }

  const first = sorted[0];
  if (first === undefined || first.entrySeq === null) {
    return { kind: 'none' };
  }

  return {
    kind: 'known',
    cursor: {
      entryId: first.entryId,
      entrySeq: first.entrySeq,
    },
  };
}

function clampCursorToRepairFrontier(cursor: CurateCursor | null, frontier: CurateRepairFrontier): CurateCursor | null {
  if (cursor === null || frontier.kind === 'none') {
    return cursor;
  }
  if (frontier.kind === 'unknown') {
    return null;
  }

  return compareCursor(cursor, frontier.cursor) >= 0 ? null : cursor;
}

export function normalizeCurateStateRepairFrontier(db: ReadHandle, state: CurateState): CurateState {
  const frontier = getCurateRepairFrontier(db);

  if (frontier.kind === 'unknown') {
    return {
      ...state,
      processedThrough: null,
      lastAttemptedThrough: null,
      discoveryHighSeq: 0,
      discoveryOffset: 0,
    };
  }

  if (frontier.kind === 'known' && state.discoveryHighSeq >= frontier.cursor.entrySeq) {
    return {
      ...state,
      processedThrough: clampCursorToRepairFrontier(state.processedThrough, frontier),
      lastAttemptedThrough: clampCursorToRepairFrontier(state.lastAttemptedThrough, frontier),
      discoveryHighSeq: Math.max(frontier.cursor.entrySeq - 1, 0),
      discoveryOffset: 0,
    };
  }

  return {
    ...state,
    processedThrough: clampCursorToRepairFrontier(state.processedThrough, frontier),
    lastAttemptedThrough: clampCursorToRepairFrontier(state.lastAttemptedThrough, frontier),
  };
}

function readActiveClaim(db: ReadHandle): CurateState['activeClaim'] {
  const row = prepareCached<[], KbCurateActiveClaimRow | undefined>(
    db,
    `SELECT id, through_seq, through_entry_id, through_entry_kind, started_at
       FROM kb_curate_active_claim
      WHERE id = 1`,
  ).get();
  if (row === undefined) {
    return null;
  }

  const through = {
    entryId: kbEntryIdSchema.parse(row.through_entry_id),
    entrySeq: parsePositiveInteger(row.through_seq, 'kb_curate_active_claim.through_seq'),
  };
  if (cursorEntryKind(through) !== row.through_entry_kind) {
    throw new Error('kb_curate_active_claim through_entry_kind must match the stored entry ID');
  }

  return {
    through,
    startedAt: row.started_at,
  };
}

function sameActiveClaim(left: CurateState['activeClaim'], right: CurateState['activeClaim']): boolean {
  if (left === null || right === null) {
    return left === right;
  }

  return compareCursor(left.through, right.through) === 0 && left.startedAt === right.startedAt;
}

function writeActiveClaim(db: Database, activeClaim: CurateState['activeClaim']): void {
  const existing = readActiveClaim(db);
  if (sameActiveClaim(existing, activeClaim)) {
    return;
  }

  if (activeClaim === null) {
    prepareCached<[]>(db, `DELETE FROM kb_curate_active_claim WHERE id = 1`).run();
    return;
  }

  const throughEntryKind = cursorEntryKind(activeClaim.through);
  if (existing === null) {
    prepareCached<[number, string, 'note' | 'source', string]>(
      db,
      `INSERT INTO kb_curate_active_claim (
         id,
         through_seq,
         through_entry_id,
         through_entry_kind,
         started_at
       ) VALUES (1, ?, ?, ?, ?)`,
    ).run(activeClaim.through.entrySeq, activeClaim.through.entryId, throughEntryKind, activeClaim.startedAt);
    return;
  }

  prepareCached<[number, string, 'note' | 'source', string]>(
    db,
    `UPDATE kb_curate_active_claim
        SET through_seq = ?,
            through_entry_id = ?,
            through_entry_kind = ?,
            started_at = ?
      WHERE id = 1`,
  ).run(activeClaim.through.entrySeq, activeClaim.through.entryId, throughEntryKind, activeClaim.startedAt);
}

function readCommunitySummaryInputFingerprints(db: ReadHandle): Record<string, string> | undefined {
  const rows = prepareCached<[], KbCurateCommunitySummaryInputFingerprintRow>(
    db,
    `SELECT community_slug, fingerprint
       FROM kb_curate_community_summary_input_fingerprints
      ORDER BY community_slug ASC`,
  ).all();
  if (rows.length === 0) {
    return undefined;
  }

  const fingerprints: Record<string, string> = {};
  for (const { community_slug, fingerprint } of rows) {
    fingerprints[community_slug] = fingerprint;
  }
  return fingerprints;
}

function writeCommunitySummaryInputFingerprints(db: Database, fingerprints: Record<string, string> | undefined): void {
  const existing = readCommunitySummaryInputFingerprints(db) ?? {};
  const next = fingerprints ?? {};

  for (const communitySlug of Object.keys(existing)) {
    if (!(communitySlug in next)) {
      prepareCached<[string]>(
        db,
        `DELETE FROM kb_curate_community_summary_input_fingerprints
          WHERE community_slug = ?`,
      ).run(communitySlug);
    }
  }

  const nextEntries = Object.entries(next).sort(([left], [right]) => left.localeCompare(right));
  for (const [communitySlug, fingerprint] of nextEntries) {
    if (!(communitySlug in existing)) {
      prepareCached<[string, string]>(
        db,
        `INSERT INTO kb_curate_community_summary_input_fingerprints (
           community_slug,
           fingerprint
         ) VALUES (?, ?)`,
      ).run(communitySlug, fingerprint);
      continue;
    }

    if (existing[communitySlug] !== fingerprint) {
      prepareCached<[string, string]>(
        db,
        `UPDATE kb_curate_community_summary_input_fingerprints
            SET fingerprint = ?
          WHERE community_slug = ?`,
      ).run(fingerprint, communitySlug);
    }
  }
}

export function readCurateState(db: ReadHandle): CurateState {
  const scheduler = readCurateSchedulerState(db);
  return normalizeCurateStateRepairFrontier(db, {
    ...defaultCurateState(),
    processedThrough: scheduler.processedThrough,
    discoveryHighSeq: scheduler.discoveryHighSeq,
    discoveryOffset: scheduler.discoveryOffset,
    lastRunDay: scheduler.lastRunDay,
    lastAttemptedThrough: scheduler.lastAttemptedThrough,
    retryNotBefore: scheduler.retryNotBefore,
    activeClaim: readActiveClaim(db),
    pendingDiscoveries: readCurateDiscoveryBacklog(db),
    communityTopologyHash: scheduler.communityTopologyHash,
    communitySummaryTopologyHash: scheduler.communitySummaryTopologyHash,
    communitySummaryInputFingerprints: readCommunitySummaryInputFingerprints(db),
    consecutiveClaimFailures: scheduler.consecutiveClaimFailures,
    consecutiveCommunityBatchFailures: scheduler.consecutiveCommunityBatchFailures,
    claimLaneDisabledAt: scheduler.claimLaneDisabledAt,
    communityBatchLaneDisabledAt: scheduler.communityBatchLaneDisabledAt,
    initialized: scheduler.initialized,
  });
}

export function writeCurateState(db: Database, state: CurateState): void {
  const normalized = normalizeCurateStateRepairFrontier(db, state);
  withImmediate(db, () => {
    writeCurateSchedulerState(db, {
      processedThrough: normalized.processedThrough,
      discoveryHighSeq: normalized.discoveryHighSeq,
      discoveryOffset: normalized.discoveryOffset,
      lastRunDay: normalized.lastRunDay,
      lastAttemptedThrough: normalized.lastAttemptedThrough,
      retryNotBefore: normalized.retryNotBefore,
      consecutiveClaimFailures: normalized.consecutiveClaimFailures,
      consecutiveCommunityBatchFailures: normalized.consecutiveCommunityBatchFailures,
      claimLaneDisabledAt: normalized.claimLaneDisabledAt,
      communityBatchLaneDisabledAt: normalized.communityBatchLaneDisabledAt,
      communityTopologyHash: normalized.communityTopologyHash,
      communitySummaryTopologyHash: normalized.communitySummaryTopologyHash,
      initialized: normalized.initialized,
    });
    syncCurateDiscoveryBacklog(db, normalized.pendingDiscoveries);
    writeActiveClaim(db, normalized.activeClaim);
    writeCommunitySummaryInputFingerprints(db, normalized.communitySummaryInputFingerprints);
  });
}
