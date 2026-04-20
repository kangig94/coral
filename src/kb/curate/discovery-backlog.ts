import { createHash } from 'node:crypto';
import { z } from 'zod';

import type { CurateDiscoveryBacklogNoteRow, CurateDiscoveryBacklogRow } from '../../store/schema.js';
import type { PendingDiscovery } from './state-shared.js';
import { prepareCached, type SqliteTarget } from './sqlite.js';

const backlogRowSchema = z.object({
  entry_id: z.string().min(1),
  principle_slug: z.string().min(1),
  statement: z.string().min(1),
  queued_at: z.string().datetime({ offset: true }),
  reason: z.string().nullable(),
});

const backlogNoteRowSchema = z.object({
  backlog_entry_id: z.string().min(1),
  note_id: z.string().min(1),
});

function backlogEntryId(entry: Pick<PendingDiscovery, 'principle' | 'statement'>): string {
  return createHash('sha256').update(`${entry.principle}\u0000${entry.statement}`, 'utf8').digest('hex');
}

function rowToPendingDiscovery(
  row: CurateDiscoveryBacklogRow,
  notes: readonly string[],
): PendingDiscovery {
  const parsed = backlogRowSchema.parse(row);
  return {
    principle: parsed.principle_slug,
    statement: parsed.statement,
    notes: [...notes].sort((left, right) => left.localeCompare(right)),
    createdAt: parsed.queued_at,
    reason: parsed.reason ?? undefined,
  };
}

export function readCurateDiscoveryBacklog(target: SqliteTarget): PendingDiscovery[] {
  const rows = prepareCached<[], CurateDiscoveryBacklogRow>(
    target,
    `SELECT
       entry_id,
       principle_slug,
       statement,
       queued_at,
       reason
     FROM curate_discovery_backlog
     ORDER BY queued_at ASC, principle_slug ASC, statement ASC`,
  ).all();
  const noteRows = prepareCached<[], CurateDiscoveryBacklogNoteRow>(
    target,
    `SELECT backlog_entry_id, note_id
       FROM curate_discovery_backlog_notes
      ORDER BY backlog_entry_id ASC, note_id ASC`,
  ).all();

  const notesByEntryId = new Map<string, string[]>();
  for (const row of noteRows) {
    const parsed = backlogNoteRowSchema.parse(row);
    const bucket = notesByEntryId.get(parsed.backlog_entry_id) ?? [];
    bucket.push(parsed.note_id);
    notesByEntryId.set(parsed.backlog_entry_id, bucket);
  }

  return rows.map((row) => rowToPendingDiscovery(row, notesByEntryId.get(row.entry_id) ?? []));
}

export function addCurateDiscoveryBacklogEntry(target: SqliteTarget, entry: PendingDiscovery): void {
  const entryId = backlogEntryId(entry);
  const inserted = prepareCached<[string, string, string, string, string | null]>(
    target,
    `INSERT OR IGNORE INTO curate_discovery_backlog (
       entry_id,
       principle_slug,
       statement,
       queued_at,
       reason
     ) VALUES (?, ?, ?, ?, ?)`,
  ).run(entryId, entry.principle, entry.statement, entry.createdAt, entry.reason ?? null);

  if (inserted.changes === 0) {
    return;
  }

  for (const noteId of [...new Set(entry.notes)].sort((left, right) => left.localeCompare(right))) {
    prepareCached<[string, string]>(
      target,
      `INSERT OR IGNORE INTO curate_discovery_backlog_notes (backlog_entry_id, note_id) VALUES (?, ?)`,
    ).run(entryId, noteId);
  }
}

export function removeCurateDiscoveryBacklogEntry(
  target: SqliteTarget,
  entry: Pick<PendingDiscovery, 'principle' | 'statement'>,
): void {
  prepareCached<[string, string]>(
    target,
    `DELETE FROM curate_discovery_backlog
      WHERE principle_slug = ? AND statement = ?`,
  ).run(entry.principle, entry.statement);
}

export function replaceCurateDiscoveryBacklog(
  target: SqliteTarget,
  entries: ReadonlyArray<PendingDiscovery>,
): void {
  prepareCached<[]>(target, `DELETE FROM curate_discovery_backlog`).run();
  for (const entry of entries) {
    addCurateDiscoveryBacklogEntry(target, entry);
  }
}
