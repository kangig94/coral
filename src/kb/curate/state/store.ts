import { z } from 'zod';

import type { KbCurateActiveClaimRow } from '../../state/schema.js';
import { prepareCached, withImmediate, type Database } from '../../../store/db.js';
import type { ReadonlyDatabase } from '../../../store/read-port.js';
import { readCurateDiscoveryBacklog, syncCurateDiscoveryBacklog } from '../discovery-backlog.js';
import { readCurateRetryQueue } from '../retry.js';
import {
  compareCursor,
  cursorEntryId,
  cursorEntryKind,
  cursorFromEntryId,
  cursorTimestampFromStorageSeq,
  cursorTimestampToStorageSeq,
  defaultCurateState,
  kbEntryIdSchema,
  type CurateRepairFrontier,
  type CurateState,
  type PendingRepair,
} from './model.js';
import { readCurateSchedulerState, writeCurateSchedulerState } from '../state-scheduler.js';

type ReadHandle = Database | ReadonlyDatabase;

export const activeClaimRowSchema = z
  .object({
    id: z.literal(1),
    through_seq: z.number().int().positive(),
    through_entry_id: kbEntryIdSchema,
    through_entry_kind: z.enum(['note', 'source']),
    started_at: z.string(),
  })
  .strict()
  .superRefine((row, ctx) => {
    const expectedKind = row.through_entry_id.startsWith('note:')
      ? 'note'
      : row.through_entry_id.startsWith('source:')
        ? 'source'
        : undefined;
    if (expectedKind !== row.through_entry_kind) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['through_entry_kind'],
        message: 'must match the stored note or source entry ID',
      });
    }
  })
  .describe('active-claim-entry-kind-matches-entry-id');

function comparePendingRepair(left: PendingRepair, right: PendingRepair): number {
  if (left.entrySeq === null || right.entrySeq === null) {
    if (left.entrySeq === null && right.entrySeq === null) {
      return left.entryId.localeCompare(right.entryId);
    }

    return left.entrySeq === null ? -1 : 1;
  }

  if (left.entrySeq !== right.entrySeq) {
    return left.entrySeq - right.entrySeq;
  }
  return left.entryId.localeCompare(right.entryId);
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
    entryId: first.entryId,
    entrySeq: first.entrySeq,
  };
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

  if (frontier.kind === 'known') {
    if (state.discoveryHighSeq >= frontier.entrySeq) {
      return {
        ...state,
        discoveryHighSeq: Math.max(frontier.entrySeq - 1, 0),
        discoveryOffset: 0,
      };
    }
  }

  return state;
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

  const parsed = activeClaimRowSchema.parse(row);
  const through = cursorFromEntryId(
    cursorTimestampFromStorageSeq(parsed.through_seq),
    parsed.through_entry_id,
    'kb_curate_active_claim',
  );

  return {
    through,
    startedAt: parsed.started_at,
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
  const throughEntryId = cursorEntryId(activeClaim.through);
  const throughSeq = cursorTimestampToStorageSeq(activeClaim.through, 'kb_curate_active_claim');
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
    ).run(throughSeq, throughEntryId, throughEntryKind, activeClaim.startedAt);
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
  ).run(throughSeq, throughEntryId, throughEntryKind, activeClaim.startedAt);
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
    communitySummaryTopologyHash: scheduler.communitySummaryTopologyHash,
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
      communitySummaryTopologyHash: normalized.communitySummaryTopologyHash,
      initialized: normalized.initialized,
    });
    syncCurateDiscoveryBacklog(db, normalized.pendingDiscoveries);
    writeActiveClaim(db, normalized.activeClaim);
  });
}
