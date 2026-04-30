import type BetterSqlite3 from 'better-sqlite3';
import type { KbCurateActiveClaimRow, KbCurateCommunitySummaryInputFingerprintRow } from '../../state/schema.js';
import { parsePositiveInteger } from '../../validation.js';
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
import { prepareCached, resolveSqliteDb, type SqliteTarget } from '../sqlite.js';
import { readCurateSchedulerState, writeCurateSchedulerState } from '../state-scheduler.js';

export type CurateStateTarget = SqliteTarget;

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

export function getCurateRepairFrontier(target: CurateStateTarget): CurateRepairFrontier {
  const queue = readCurateRetryQueue(target);
  if (queue.length === 0) {
    return { kind: 'none' };
  }

  const sorted = [...queue].sort(comparePendingRepair);
  if (sorted.some((entry) => entry.entrySeq === null)) {
    return { kind: 'unknown' };
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

export function normalizeCurateStateRepairFrontier(target: CurateStateTarget, state: CurateState): CurateState {
  const frontier = getCurateRepairFrontier(target);

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

function readActiveClaim(target: CurateStateTarget): CurateState['activeClaim'] {
  const row = prepareCached<[], KbCurateActiveClaimRow | undefined>(
    target,
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

function writeActiveClaim(target: CurateStateTarget, activeClaim: CurateState['activeClaim']): void {
  const existing = readActiveClaim(target);
  if (sameActiveClaim(existing, activeClaim)) {
    return;
  }

  if (activeClaim === null) {
    prepareCached<[]>(target, `DELETE FROM kb_curate_active_claim WHERE id = 1`).run();
    return;
  }

  const throughEntryKind = cursorEntryKind(activeClaim.through);
  if (existing === null) {
    prepareCached<[number, string, 'note' | 'source', string]>(
      target,
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
    target,
    `UPDATE kb_curate_active_claim
        SET through_seq = ?,
            through_entry_id = ?,
            through_entry_kind = ?,
            started_at = ?
      WHERE id = 1`,
  ).run(activeClaim.through.entrySeq, activeClaim.through.entryId, throughEntryKind, activeClaim.startedAt);
}

function readCommunitySummaryInputFingerprints(target: CurateStateTarget): Record<string, string> | undefined {
  const rows = prepareCached<[], KbCurateCommunitySummaryInputFingerprintRow>(
    target,
    `SELECT community_slug, fingerprint
       FROM kb_curate_community_summary_input_fingerprints
      ORDER BY community_slug ASC`,
  ).all();
  if (rows.length === 0) {
    return undefined;
  }

  return Object.fromEntries(rows.map(({ community_slug, fingerprint }) => [community_slug, fingerprint]));
}

function writeCommunitySummaryInputFingerprints(
  target: CurateStateTarget,
  fingerprints: Record<string, string> | undefined,
): void {
  const existing = readCommunitySummaryInputFingerprints(target) ?? {};
  const next = fingerprints ?? {};

  for (const communitySlug of Object.keys(existing)) {
    if (!(communitySlug in next)) {
      prepareCached<[string]>(
        target,
        `DELETE FROM kb_curate_community_summary_input_fingerprints
          WHERE community_slug = ?`,
      ).run(communitySlug);
    }
  }

  for (const [communitySlug, fingerprint] of Object.entries(next).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (!(communitySlug in existing)) {
      prepareCached<[string, string]>(
        target,
        `INSERT INTO kb_curate_community_summary_input_fingerprints (
           community_slug,
           fingerprint
         ) VALUES (?, ?)`,
      ).run(communitySlug, fingerprint);
      continue;
    }

    if (existing[communitySlug] !== fingerprint) {
      prepareCached<[string, string]>(
        target,
        `UPDATE kb_curate_community_summary_input_fingerprints
            SET fingerprint = ?
          WHERE community_slug = ?`,
      ).run(fingerprint, communitySlug);
    }
  }
}

export function readCurateState(target: CurateStateTarget): CurateState {
  const scheduler = readCurateSchedulerState(target);
  return normalizeCurateStateRepairFrontier(target, {
    ...defaultCurateState(),
    processedThrough: scheduler.processedThrough,
    discoveryHighSeq: scheduler.discoveryHighSeq,
    discoveryOffset: scheduler.discoveryOffset,
    lastRunDay: scheduler.lastRunDay,
    lastAttemptedThrough: scheduler.lastAttemptedThrough,
    retryNotBefore: scheduler.retryNotBefore,
    activeClaim: readActiveClaim(target),
    pendingDiscoveries: readCurateDiscoveryBacklog(target),
    communityTopologyHash: scheduler.communityTopologyHash,
    communitySummaryTopologyHash: scheduler.communitySummaryTopologyHash,
    communitySummaryInputFingerprints: readCommunitySummaryInputFingerprints(target),
    consecutiveClaimFailures: scheduler.consecutiveClaimFailures,
    consecutiveCommunityBatchFailures: scheduler.consecutiveCommunityBatchFailures,
    claimLaneDisabledAt: scheduler.claimLaneDisabledAt,
    communityBatchLaneDisabledAt: scheduler.communityBatchLaneDisabledAt,
    initialized: scheduler.initialized,
  });
}

export function writeCurateState(target: CurateStateTarget, state: CurateState): void {
  const normalized = normalizeCurateStateRepairFrontier(target, state);
  const db = resolveSqliteDb(target) as ReturnType<typeof resolveSqliteDb> & {
    transaction: BetterSqlite3.Database['transaction'];
  };
  db.transaction(() => {
    writeCurateSchedulerState(target, {
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
    syncCurateDiscoveryBacklog(target, normalized.pendingDiscoveries);
    writeActiveClaim(target, normalized.activeClaim);
    writeCommunitySummaryInputFingerprints(target, normalized.communitySummaryInputFingerprints);
  })();
}
