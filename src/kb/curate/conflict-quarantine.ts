import { z } from 'zod';

import type { KbCurateConflictQuarantineRow } from '../state/schema.js';
import type { KbEntryId } from '../entry-types.js';
import { kbEntryIdSchema } from './state/model.js';
import { prepareCached, type Database } from '../../store/db.js';
import type { ReadonlyDatabase } from '../../store/read-port.js';

export type ConflictQuarantineKind = 'note' | 'source' | 'community' | 'wiki';

export type CurateConflictQuarantineEntry = {
  entryId: KbEntryId;
  kind: ConflictQuarantineKind;
  slug: string;
  path: string;
  recoveryRef: string;
  detectedAt: string;
};

const quarantineRowSchema = z.object({
  entry_id: kbEntryIdSchema,
  entry_kind: z.enum(['note', 'source', 'community', 'wiki']),
  slug: z.string().min(1),
  path: z.string().min(1),
  recovery_ref: z.string().min(1),
  detected_at: z.string().datetime({ offset: true }),
});

function rowToConflictQuarantine(row: KbCurateConflictQuarantineRow): CurateConflictQuarantineEntry {
  const parsed = quarantineRowSchema.parse(row);
  return {
    entryId: parsed.entry_id,
    kind: parsed.entry_kind,
    slug: parsed.slug,
    path: parsed.path,
    recoveryRef: parsed.recovery_ref,
    detectedAt: parsed.detected_at,
  };
}

function conflictQuarantineToRow(entry: CurateConflictQuarantineEntry): KbCurateConflictQuarantineRow {
  return quarantineRowSchema.parse({
    entry_id: entry.entryId,
    entry_kind: entry.kind,
    slug: entry.slug,
    path: entry.path,
    recovery_ref: entry.recoveryRef,
    detected_at: entry.detectedAt,
  });
}

export function readCurateConflictQuarantine(
  db: Database | ReadonlyDatabase,
): CurateConflictQuarantineEntry[] {
  const rows = prepareCached<[], KbCurateConflictQuarantineRow>(
    db,
    `SELECT
       entry_id,
       entry_kind,
       slug,
       path,
       recovery_ref,
       detected_at
     FROM kb_curate_conflict_quarantine
     ORDER BY entry_id ASC`,
  ).all();
  const entries: CurateConflictQuarantineEntry[] = [];
  for (const row of rows) {
    entries.push(rowToConflictQuarantine(row));
  }
  return entries;
}

export function readCurateConflictQuarantineEntryIds(db: Database | ReadonlyDatabase): Set<KbEntryId> {
  const ids = new Set<KbEntryId>();
  for (const entry of readCurateConflictQuarantine(db)) {
    ids.add(entry.entryId);
  }
  return ids;
}

export function upsertCurateConflictQuarantine(db: Database, entry: CurateConflictQuarantineEntry): void {
  const row = conflictQuarantineToRow(entry);
  prepareCached<[string, string, string, string, string, string]>(
    db,
    `INSERT INTO kb_curate_conflict_quarantine (
       entry_id,
       entry_kind,
       slug,
       path,
       recovery_ref,
       detected_at
     ) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(entry_id) DO UPDATE SET
       entry_kind = excluded.entry_kind,
       slug = excluded.slug,
       path = excluded.path,
       recovery_ref = excluded.recovery_ref,
       detected_at = excluded.detected_at`,
  ).run(row.entry_id, row.entry_kind, row.slug, row.path, row.recovery_ref, row.detected_at);
}

export function deleteCurateConflictQuarantineEntry(db: Database, entryId: KbEntryId): void {
  prepareCached<[string]>(db, `DELETE FROM kb_curate_conflict_quarantine WHERE entry_id = ?`).run(entryId);
}

export function clearCurateConflictQuarantine(db: Database): void {
  prepareCached<[]>(db, `DELETE FROM kb_curate_conflict_quarantine`).run();
}
