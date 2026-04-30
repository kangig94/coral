import { z } from 'zod';

import type { KbCurateRetryQueueRow } from '../state/schema.js';
import type { KbEntryId } from '../entry-types.js';
import { kbEntryIdSchema, type PendingRepair } from './state/model.js';
import { prepareCached, type SqliteTarget } from './sqlite.js';

const DEFAULT_RETRY_REASON = 'pending-repair';

const retryRowSchema = z.object({
  entry_id: kbEntryIdSchema,
  entry_seq: z.number().int().positive().nullable(),
  reason: z.string().min(1),
  observed_at: z.string().datetime({ offset: true }),
  observed_content_hash: z.string().min(1).nullable(),
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

const pendingRepairRowSchema = z.object({
  entry_id: kbEntryIdSchema,
  observed_at: z.string().datetime({ offset: true }),
  observed_content_hash: z.string().min(1).nullable(),
  reason: z.string().min(1),
});

type PendingRepairRow = Pick<KbCurateRetryQueueRow, 'entry_id' | 'observed_at' | 'observed_content_hash' | 'reason'>;

export type PendingRepairRetryCandidate = Pick<
  PendingRepair,
  'entryId' | 'detectedAt' | 'observedContentHash' | 'reason'
>;

function rowToPendingRepair(row: KbCurateRetryQueueRow): PendingRepair {
  const parsed = retryRowSchema.parse(row);
  return {
    entryId: parsed.entry_id,
    entrySeq: parsed.entry_seq,
    detectedAt: parsed.observed_at,
    observedContentHash: parsed.observed_content_hash ?? undefined,
    reason: parsed.reason,
    locus: parsed.locus ?? undefined,
    canonicalIncident: parsed.canonical_incident ?? undefined,
    signalsJson: parsed.signals_json ?? undefined,
    repairHint: parsed.repair_hint ?? undefined,
    retryNotBefore: parsed.retry_not_before,
    retryCount: parsed.retry_count,
  };
}

function rowToPendingRepairRetryCandidate(row: PendingRepairRow): PendingRepairRetryCandidate {
  const parsed = pendingRepairRowSchema.parse(row);
  return {
    entryId: parsed.entry_id,
    detectedAt: parsed.observed_at,
    observedContentHash: parsed.observed_content_hash ?? undefined,
    reason: parsed.reason,
  };
}

function pendingRepairToRow(entry: PendingRepair): KbCurateRetryQueueRow {
  return retryRowSchema.parse({
    entry_id: entry.entryId,
    entry_seq: entry.entrySeq,
    reason: entry.reason ?? DEFAULT_RETRY_REASON,
    observed_at: entry.detectedAt,
    observed_content_hash: entry.observedContentHash ?? null,
    locus: entry.locus ?? null,
    canonical_incident: entry.canonicalIncident ?? null,
    signals_json: entry.signalsJson ?? null,
    repair_hint: entry.repairHint ?? null,
    retry_not_before: entry.retryNotBefore ?? entry.detectedAt,
    retry_count: entry.retryCount ?? 0,
  });
}

function samePendingRepairRow(left: KbCurateRetryQueueRow, right: KbCurateRetryQueueRow): boolean {
  return (
    left.entry_id === right.entry_id &&
    left.entry_seq === right.entry_seq &&
    left.reason === right.reason &&
    left.observed_at === right.observed_at &&
    left.observed_content_hash === right.observed_content_hash &&
    left.locus === right.locus &&
    left.canonical_incident === right.canonical_incident &&
    left.signals_json === right.signals_json &&
    left.repair_hint === right.repair_hint &&
    left.retry_not_before === right.retry_not_before &&
    left.retry_count === right.retry_count
  );
}

export function readCurateRetryQueue(target: SqliteTarget): PendingRepair[] {
  const rows = prepareCached<[], KbCurateRetryQueueRow>(
    target,
    `SELECT
       entry_id,
       entry_seq,
       reason,
       observed_at,
       observed_content_hash,
       locus,
       canonical_incident,
       signals_json,
       repair_hint,
       retry_not_before,
       retry_count
     FROM kb_curate_retry_queue
     ORDER BY entry_id ASC`,
  ).all();
  return rows.map((row) => rowToPendingRepair(row));
}

export function readPendingRepairRows(target: SqliteTarget): PendingRepairRetryCandidate[] {
  const rows = prepareCached<[], PendingRepairRow>(
    target,
    `SELECT
       entry_id,
       observed_at,
       observed_content_hash,
       reason
     FROM kb_curate_retry_queue
     ORDER BY entry_id ASC`,
  ).all();
  return rows.map((row) => rowToPendingRepairRetryCandidate(row));
}

export function upsertCurateRetryEntry(target: SqliteTarget, entry: PendingRepair): void {
  const row = pendingRepairToRow(entry);
  prepareCached<
    [
      string,
      number | null,
      string,
      string,
      string | null,
      string | null,
      string | null,
      string | null,
      string | null,
      string,
      number,
    ]
  >(
    target,
    `INSERT INTO kb_curate_retry_queue (
       entry_id,
       entry_seq,
       reason,
       observed_at,
       observed_content_hash,
       locus,
       canonical_incident,
       signals_json,
       repair_hint,
       retry_not_before,
       retry_count
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(entry_id) DO UPDATE SET
       entry_seq = excluded.entry_seq,
       reason = excluded.reason,
       observed_at = excluded.observed_at,
       observed_content_hash = excluded.observed_content_hash,
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
    row.observed_content_hash,
    row.locus,
    row.canonical_incident,
    row.signals_json,
    row.repair_hint,
    row.retry_not_before,
    row.retry_count,
  );
}

export function deleteCurateRetryEntry(target: SqliteTarget, entryId: string): void {
  prepareCached<[string]>(target, `DELETE FROM kb_curate_retry_queue WHERE entry_id = ?`).run(entryId);
}

export function syncCurateRetryQueue(target: SqliteTarget, entries: ReadonlyArray<PendingRepair>): void {
  const existingById = new Map(readCurateRetryQueue(target).map((entry) => [entry.entryId, entry] as const));
  const nextById = new Map<KbEntryId, PendingRepair>();
  for (const entry of entries) {
    nextById.set(entry.entryId, entry);
  }

  for (const entryId of existingById.keys()) {
    if (!nextById.has(entryId)) {
      deleteCurateRetryEntry(target, entryId);
    }
  }

  for (const [entryId, entry] of nextById) {
    const existing = existingById.get(entryId);
    if (existing === undefined || !samePendingRepairRow(pendingRepairToRow(existing), pendingRepairToRow(entry))) {
      upsertCurateRetryEntry(target, entry);
    }
  }
}
