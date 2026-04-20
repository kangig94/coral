import { z } from 'zod';

import type { CurateRetryQueueRow } from '../../store/schema.js';
import { kbEntryIdSchema, type PendingRepair } from './state-shared.js';
import {
  prepareCached,
  type SqliteTarget,
} from './sqlite.js';

const DEFAULT_RETRY_REASON = 'pending-repair';

const retryRowSchema = z.object({
  entry_id: kbEntryIdSchema,
  entry_seq: z.number().int().positive().nullable(),
  reason: z.string().min(1),
  observed_at: z.string().datetime({ offset: true }),
  locus: z.string().nullable(),
  canonical_incident: z.string().nullable(),
  signals_json: z
    .string()
    .nullable()
    .superRefine((value, ctx) => {
      if (value === null) {
        return;
      }
      try {
        JSON.parse(value);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'signals_json must be valid JSON',
        });
      }
    }),
  repair_hint: z.string().nullable(),
  retry_not_before: z.string().datetime({ offset: true }),
  retry_count: z.number().int().nonnegative(),
});

function rowToPendingRepair(row: CurateRetryQueueRow): PendingRepair {
  const parsed = retryRowSchema.parse(row);
  return {
    entryId: parsed.entry_id,
    entrySeq: parsed.entry_seq,
    detectedAt: parsed.observed_at,
    reason: parsed.reason,
    locus: parsed.locus ?? undefined,
    canonicalIncident: parsed.canonical_incident ?? undefined,
    signalsJson: parsed.signals_json ?? undefined,
    repairHint: parsed.repair_hint ?? undefined,
    retryNotBefore: parsed.retry_not_before,
    retryCount: parsed.retry_count,
  };
}

function pendingRepairToRow(entry: PendingRepair): CurateRetryQueueRow {
  return retryRowSchema.parse({
    entry_id: entry.entryId,
    entry_seq: entry.entrySeq,
    reason: entry.reason ?? DEFAULT_RETRY_REASON,
    observed_at: entry.detectedAt,
    locus: entry.locus ?? null,
    canonical_incident: entry.canonicalIncident ?? null,
    signals_json: entry.signalsJson ?? null,
    repair_hint: entry.repairHint ?? null,
    retry_not_before: entry.retryNotBefore ?? entry.detectedAt,
    retry_count: entry.retryCount ?? 0,
  });
}

export function readCurateRetryQueue(target: SqliteTarget): PendingRepair[] {
  const rows = prepareCached<[], CurateRetryQueueRow>(
    target,
    `SELECT
       entry_id,
       entry_seq,
       reason,
       observed_at,
       locus,
       canonical_incident,
       signals_json,
       repair_hint,
       retry_not_before,
       retry_count
     FROM curate_retry_queue
     ORDER BY entry_id ASC`,
  ).all();
  return rows.map((row) => rowToPendingRepair(row));
}

export function scanDueCurateRetryQueue(
  target: SqliteTarget,
  retryNotBefore: string,
  limit = 1,
): PendingRepair[] {
  const rows = prepareCached<[string, number], CurateRetryQueueRow>(
    target,
    `SELECT
       entry_id,
       entry_seq,
       reason,
       observed_at,
       locus,
       canonical_incident,
       signals_json,
       repair_hint,
       retry_not_before,
       retry_count
     FROM curate_retry_queue
     WHERE retry_not_before <= ?
     ORDER BY retry_not_before ASC, entry_id ASC
     LIMIT ?`,
  ).all(retryNotBefore, limit);
  return rows.map((row) => rowToPendingRepair(row));
}

export function upsertCurateRetryEntry(target: SqliteTarget, entry: PendingRepair): void {
  const row = pendingRepairToRow(entry);
  prepareCached<
    [string, number | null, string, string, string | null, string | null, string | null, string | null, string, number]
  >(
    target,
    `INSERT INTO curate_retry_queue (
       entry_id,
       entry_seq,
       reason,
       observed_at,
       locus,
       canonical_incident,
       signals_json,
       repair_hint,
       retry_not_before,
       retry_count
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(entry_id) DO UPDATE SET
       entry_seq = excluded.entry_seq,
       reason = excluded.reason,
       observed_at = excluded.observed_at,
       locus = excluded.locus,
       canonical_incident = excluded.canonical_incident,
       signals_json = excluded.signals_json,
       repair_hint = excluded.repair_hint,
       retry_not_before = excluded.retry_not_before,
       retry_count = excluded.retry_count`,
  ).run(
    row.entry_id,
    row.entry_seq,
    row.reason,
    row.observed_at,
    row.locus,
    row.canonical_incident,
    row.signals_json,
    row.repair_hint,
    row.retry_not_before,
    row.retry_count,
  );
}

export function deleteCurateRetryEntry(target: SqliteTarget, entryId: string): void {
  prepareCached<[string]>(target, `DELETE FROM curate_retry_queue WHERE entry_id = ?`).run(entryId);
}

export function replaceCurateRetryQueue(target: SqliteTarget, entries: ReadonlyArray<PendingRepair>): void {
  prepareCached<[]>(target, `DELETE FROM curate_retry_queue`).run();

  for (const entry of entries) {
    upsertCurateRetryEntry(target, entry);
  }
}
