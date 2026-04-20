import { z } from 'zod';

import type { CurateSchedulerRow } from '../../store/schema.js';
import type { CurateCursor } from './state-shared.js';
import { kbEntryIdSchema } from './state-shared.js';
import { prepareCached, type SqliteTarget } from './sqlite.js';

type CurateSchedulerState = {
  processedThrough: CurateCursor | null;
  discoveryHighSeq: number;
  discoveryOffset: number;
  lastRunDay: string | null;
  consecutiveFailures: number;
  communityTopologyHash?: string;
};

const schedulerRowSchema = z.object({
  id: z.literal(1),
  processed_through_seq: z.number().int().positive().nullable(),
  processed_through_entry_id: kbEntryIdSchema.nullable(),
  processed_through_entry_kind: z.enum(['note', 'source']).nullable(),
  discovery_high_seq: z.number().int().nonnegative().nullable(),
  discovery_offset: z.number().int().nonnegative().nullable(),
  last_run_day: z.string().nullable(),
  consecutive_failures: z.number().int().nonnegative(),
  community_topology_hash: z.string().nullable(),
});

function defaultCurateSchedulerState(): CurateSchedulerState {
  return {
    processedThrough: null,
    discoveryHighSeq: 0,
    discoveryOffset: 0,
    lastRunDay: null,
    consecutiveFailures: 0,
    communityTopologyHash: undefined,
  };
}

function cursorEntryKind(cursor: CurateCursor): 'note' | 'source' {
  if (cursor.entryId.startsWith('note:')) {
    return 'note';
  }
  if (cursor.entryId.startsWith('source:')) {
    return 'source';
  }

  throw new Error(`curate scheduler cursor must point at a note or source entry: ${cursor.entryId}`);
}

function rowToCurateSchedulerState(row: CurateSchedulerRow | undefined): CurateSchedulerState {
  if (row === undefined) {
    return defaultCurateSchedulerState();
  }

  const parsed = schedulerRowSchema.parse(row);
  if (
    (parsed.processed_through_seq === null) !== (parsed.processed_through_entry_id === null) ||
    (parsed.processed_through_seq === null) !== (parsed.processed_through_entry_kind === null)
  ) {
    throw new Error('curate_scheduler processed_through columns must be all null or all populated');
  }

  return {
    processedThrough:
      parsed.processed_through_seq === null || parsed.processed_through_entry_id === null
        ? null
        : {
            entrySeq: parsed.processed_through_seq,
            entryId: parsed.processed_through_entry_id,
          },
    discoveryHighSeq: parsed.discovery_high_seq ?? 0,
    discoveryOffset: parsed.discovery_offset ?? 0,
    lastRunDay: parsed.last_run_day,
    consecutiveFailures: parsed.consecutive_failures,
    communityTopologyHash: parsed.community_topology_hash ?? undefined,
  };
}

export function readCurateSchedulerState(target: SqliteTarget): CurateSchedulerState {
  const row = prepareCached<[], CurateSchedulerRow | undefined>(
    target,
    `SELECT
       id,
       processed_through_seq,
       processed_through_entry_id,
       processed_through_entry_kind,
       discovery_high_seq,
       discovery_offset,
       last_run_day,
       consecutive_failures,
       community_topology_hash
     FROM curate_scheduler
     WHERE id = 1`,
  ).get();
  return rowToCurateSchedulerState(row);
}

export function writeCurateSchedulerState(target: SqliteTarget, state: CurateSchedulerState): void {
  const processedThroughEntryKind = state.processedThrough === null ? null : cursorEntryKind(state.processedThrough);

  prepareCached<
    [number | null, string | null, 'note' | 'source' | null, number, number, string | null, number, string | null]
  >(
    target,
    `UPDATE curate_scheduler
        SET processed_through_seq = ?,
            processed_through_entry_id = ?,
            processed_through_entry_kind = ?,
            discovery_high_seq = ?,
            discovery_offset = ?,
            last_run_day = ?,
            consecutive_failures = ?,
            community_topology_hash = ?
      WHERE id = 1`,
  ).run(
    state.processedThrough?.entrySeq ?? null,
    state.processedThrough?.entryId ?? null,
    processedThroughEntryKind,
    state.discoveryHighSeq,
    state.discoveryOffset,
    state.lastRunDay,
    state.consecutiveFailures,
    state.communityTopologyHash ?? null,
  );
}

export type { CurateSchedulerState };
