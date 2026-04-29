import { z } from 'zod';

import type { KbCurateSchedulerRow } from '../state/schema.js';
import type { CurateCursor } from './state/model.js';
import { cursorEntryKind, kbEntryIdSchema } from './state/model.js';
import { prepareCached, type SqliteTarget } from './sqlite.js';

type CurateSchedulerState = {
  processedThrough: CurateCursor | null;
  discoveryHighSeq: number;
  discoveryOffset: number;
  lastRunDay: string | null;
  lastAttemptedThrough: CurateCursor | null;
  retryNotBefore: string | null;
  consecutiveClaimFailures: number;
  consecutiveCommunityBatchFailures: number;
  claimLaneDisabledAt: string | null;
  communityBatchLaneDisabledAt: string | null;
  communityTopologyHash?: string;
  communitySummaryTopologyHash?: string;
  initialized: boolean;
};

const schedulerRowSchema = z.object({
  id: z.literal(1),
  processed_through_seq: z.number().int().positive().nullable(),
  processed_through_entry_id: kbEntryIdSchema.nullable(),
  processed_through_entry_kind: z.enum(['note', 'source']).nullable(),
  discovery_high_seq: z.number().int().nonnegative().nullable(),
  discovery_offset: z.number().int().nonnegative().nullable(),
  last_run_day: z.string().nullable(),
  last_attempted_through_seq: z.number().int().positive().nullable(),
  last_attempted_through_entry_id: kbEntryIdSchema.nullable(),
  last_attempted_through_entry_kind: z.enum(['note', 'source']).nullable(),
  retry_not_before: z.string().nullable(),
  consecutive_claim_failures: z.number().int().nonnegative(),
  consecutive_community_batch_failures: z.number().int().nonnegative(),
  claim_lane_disabled_at: z.string().nullable(),
  community_batch_lane_disabled_at: z.string().nullable(),
  community_topology_hash: z.string().nullable(),
  community_summary_topology_hash: z.string().nullable(),
  initialized: z.union([z.literal(0), z.literal(1)]),
});

function defaultCurateSchedulerState(): CurateSchedulerState {
  return {
    processedThrough: null,
    discoveryHighSeq: 0,
    discoveryOffset: 0,
    lastRunDay: null,
    lastAttemptedThrough: null,
    retryNotBefore: null,
    consecutiveClaimFailures: 0,
    consecutiveCommunityBatchFailures: 0,
    claimLaneDisabledAt: null,
    communityBatchLaneDisabledAt: null,
    communityTopologyHash: undefined,
    communitySummaryTopologyHash: undefined,
    initialized: false,
  };
}

function parseStoredCursor(
  label: string,
  entrySeq: number | null,
  entryId: CurateCursor['entryId'] | null,
  entryKind: 'note' | 'source' | null,
): CurateCursor | null {
  if (entrySeq === null && entryId === null && entryKind === null) {
    return null;
  }

  if ((entrySeq === null) !== (entryId === null) || (entrySeq === null) !== (entryKind === null)) {
    throw new Error(`kb_curate_scheduler ${label} columns must be all null or all populated`);
  }
  if (entrySeq === null || entryId === null || entryKind === null) {
    throw new Error(`kb_curate_scheduler ${label} columns must be all null or all populated`);
  }

  const cursor = {
    entrySeq,
    entryId,
  };
  if (cursorEntryKind(cursor, 'curate scheduler') !== entryKind) {
    throw new Error(`kb_curate_scheduler ${label} entry kind must match the stored entry ID`);
  }
  return cursor;
}

function rowToCurateSchedulerState(row: KbCurateSchedulerRow | undefined): CurateSchedulerState {
  if (row === undefined) {
    return defaultCurateSchedulerState();
  }

  const parsed = schedulerRowSchema.parse(row);

  return {
    processedThrough: parseStoredCursor(
      'processed_through',
      parsed.processed_through_seq,
      parsed.processed_through_entry_id,
      parsed.processed_through_entry_kind,
    ),
    discoveryHighSeq: parsed.discovery_high_seq ?? 0,
    discoveryOffset: parsed.discovery_offset ?? 0,
    lastRunDay: parsed.last_run_day,
    lastAttemptedThrough: parseStoredCursor(
      'last_attempted_through',
      parsed.last_attempted_through_seq,
      parsed.last_attempted_through_entry_id,
      parsed.last_attempted_through_entry_kind,
    ),
    retryNotBefore: parsed.retry_not_before,
    consecutiveClaimFailures: parsed.consecutive_claim_failures,
    consecutiveCommunityBatchFailures: parsed.consecutive_community_batch_failures,
    claimLaneDisabledAt: parsed.claim_lane_disabled_at,
    communityBatchLaneDisabledAt: parsed.community_batch_lane_disabled_at,
    communityTopologyHash: parsed.community_topology_hash ?? undefined,
    communitySummaryTopologyHash: parsed.community_summary_topology_hash ?? undefined,
    initialized: parsed.initialized === 1,
  };
}

export function readCurateSchedulerState(target: SqliteTarget): CurateSchedulerState {
  const row = prepareCached<[], KbCurateSchedulerRow | undefined>(
    target,
    `SELECT
       id,
       processed_through_seq,
       processed_through_entry_id,
       processed_through_entry_kind,
       discovery_high_seq,
       discovery_offset,
       last_run_day,
       last_attempted_through_seq,
       last_attempted_through_entry_id,
       last_attempted_through_entry_kind,
       retry_not_before,
       consecutive_claim_failures,
       consecutive_community_batch_failures,
       claim_lane_disabled_at,
       community_batch_lane_disabled_at,
       community_topology_hash,
       community_summary_topology_hash,
       initialized
     FROM kb_curate_scheduler
     WHERE id = 1`,
  ).get();
  return rowToCurateSchedulerState(row);
}

export function writeCurateSchedulerState(target: SqliteTarget, state: CurateSchedulerState): void {
  const processedThroughEntryKind =
    state.processedThrough === null ? null : cursorEntryKind(state.processedThrough, 'curate scheduler');
  const lastAttemptedThroughEntryKind =
    state.lastAttemptedThrough === null ? null : cursorEntryKind(state.lastAttemptedThrough, 'curate scheduler');

  prepareCached<
    [
      number | null,
      string | null,
      'note' | 'source' | null,
      number,
      number,
      string | null,
      number | null,
      string | null,
      'note' | 'source' | null,
      string | null,
      number,
      number,
      string | null,
      string | null,
      string | null,
      string | null,
      0 | 1,
    ]
  >(
    target,
    `UPDATE kb_curate_scheduler
        SET processed_through_seq = ?,
            processed_through_entry_id = ?,
            processed_through_entry_kind = ?,
            discovery_high_seq = ?,
            discovery_offset = ?,
            last_run_day = ?,
            last_attempted_through_seq = ?,
            last_attempted_through_entry_id = ?,
            last_attempted_through_entry_kind = ?,
            retry_not_before = ?,
            consecutive_claim_failures = ?,
            consecutive_community_batch_failures = ?,
            claim_lane_disabled_at = ?,
            community_batch_lane_disabled_at = ?,
            community_topology_hash = ?,
            community_summary_topology_hash = ?,
            initialized = ?
      WHERE id = 1`,
  ).run(
    state.processedThrough?.entrySeq ?? null,
    state.processedThrough?.entryId ?? null,
    processedThroughEntryKind,
    state.discoveryHighSeq,
    state.discoveryOffset,
    state.lastRunDay,
    state.lastAttemptedThrough?.entrySeq ?? null,
    state.lastAttemptedThrough?.entryId ?? null,
    lastAttemptedThroughEntryKind,
    state.retryNotBefore,
    state.consecutiveClaimFailures,
    state.consecutiveCommunityBatchFailures,
    state.claimLaneDisabledAt,
    state.communityBatchLaneDisabledAt,
    state.communityTopologyHash ?? null,
    state.communitySummaryTopologyHash ?? null,
    state.initialized ? 1 : 0,
  );
}

export type { CurateSchedulerState };
