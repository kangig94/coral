import { createHash } from 'node:crypto';
import { z } from 'zod';

import type { KbCurateDiscoveryBacklogNoteRow, KbCurateDiscoveryBacklogRow } from '../state/schema.js';
import type { PendingDiscovery } from './state-model.js';
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

function canonicalNoteIds(noteIds: readonly string[]): string[] {
  return [...new Set(noteIds)].sort((left, right) => left.localeCompare(right));
}

function canonicalPendingDiscovery(entry: PendingDiscovery): PendingDiscovery {
  return {
    principle: entry.principle,
    statement: entry.statement,
    notes: canonicalNoteIds(entry.notes),
    createdAt: entry.createdAt,
    reason: entry.reason ?? undefined,
  };
}

function rowToPendingDiscovery(
  row: KbCurateDiscoveryBacklogRow,
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
  const rows = prepareCached<[], KbCurateDiscoveryBacklogRow>(
    target,
    `SELECT
       entry_id,
       principle_slug,
       statement,
       queued_at,
       reason
     FROM kb_curate_discovery_backlog
     ORDER BY queued_at ASC, principle_slug ASC, statement ASC`,
  ).all();
  const noteRows = prepareCached<[], KbCurateDiscoveryBacklogNoteRow>(
    target,
    `SELECT backlog_entry_id, note_id
       FROM kb_curate_discovery_backlog_notes
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
  const canonicalEntry = canonicalPendingDiscovery(entry);
  const entryId = backlogEntryId(canonicalEntry);
  const inserted = prepareCached<[string, string, string, string, string | null]>(
    target,
    `INSERT OR IGNORE INTO kb_curate_discovery_backlog (
       entry_id,
       principle_slug,
       statement,
       queued_at,
       reason
     ) VALUES (?, ?, ?, ?, ?)`,
  ).run(
    entryId,
    canonicalEntry.principle,
    canonicalEntry.statement,
    canonicalEntry.createdAt,
    canonicalEntry.reason ?? null,
  );

  if (inserted.changes === 0) {
    return;
  }

  for (const noteId of canonicalEntry.notes) {
    prepareCached<[string, string]>(
      target,
      `INSERT OR IGNORE INTO kb_curate_discovery_backlog_notes (backlog_entry_id, note_id) VALUES (?, ?)`,
    ).run(entryId, noteId);
  }
}

export function removeCurateDiscoveryBacklogEntry(
  target: SqliteTarget,
  entry: Pick<PendingDiscovery, 'principle' | 'statement'>,
): void {
  prepareCached<[string, string]>(
    target,
    `DELETE FROM kb_curate_discovery_backlog
      WHERE principle_slug = ? AND statement = ?`,
  ).run(entry.principle, entry.statement);
}

export function replaceCurateDiscoveryBacklog(
  target: SqliteTarget,
  entries: ReadonlyArray<PendingDiscovery>,
): void {
  prepareCached<[]>(target, `DELETE FROM kb_curate_discovery_backlog`).run();
  for (const entry of entries) {
    addCurateDiscoveryBacklogEntry(target, entry);
  }
}

function updateCurateDiscoveryBacklogEntry(target: SqliteTarget, entry: PendingDiscovery): void {
  const canonicalEntry = canonicalPendingDiscovery(entry);
  prepareCached<[string, string | null, string]>(
    target,
    `UPDATE kb_curate_discovery_backlog
        SET queued_at = ?,
            reason = ?
      WHERE entry_id = ?`,
  ).run(canonicalEntry.createdAt, canonicalEntry.reason ?? null, backlogEntryId(canonicalEntry));
}

function addCurateDiscoveryBacklogNote(target: SqliteTarget, backlogId: string, noteId: string): void {
  prepareCached<[string, string]>(
    target,
    `INSERT OR IGNORE INTO kb_curate_discovery_backlog_notes (backlog_entry_id, note_id) VALUES (?, ?)`,
  ).run(backlogId, noteId);
}

function removeCurateDiscoveryBacklogNote(target: SqliteTarget, backlogId: string, noteId: string): void {
  prepareCached<[string, string]>(
    target,
    `DELETE FROM kb_curate_discovery_backlog_notes
      WHERE backlog_entry_id = ? AND note_id = ?`,
  ).run(backlogId, noteId);
}

export function syncCurateDiscoveryBacklog(
  target: SqliteTarget,
  entries: ReadonlyArray<PendingDiscovery>,
): void {
  const existingById = new Map(
    readCurateDiscoveryBacklog(target).map((entry) => {
      const canonicalEntry = canonicalPendingDiscovery(entry);
      return [backlogEntryId(canonicalEntry), canonicalEntry] as const;
    }),
  );
  const nextById = new Map<string, PendingDiscovery>();
  for (const entry of entries) {
    const canonicalEntry = canonicalPendingDiscovery(entry);
    const entryId = backlogEntryId(canonicalEntry);
    if (!nextById.has(entryId)) {
      nextById.set(entryId, canonicalEntry);
    }
  }

  for (const [entryId, existing] of existingById) {
    if (!nextById.has(entryId)) {
      removeCurateDiscoveryBacklogEntry(target, existing);
    }
  }

  for (const [entryId, entry] of nextById) {
    const existing = existingById.get(entryId);
    if (existing === undefined) {
      addCurateDiscoveryBacklogEntry(target, entry);
      continue;
    }

    if (existing.createdAt !== entry.createdAt || (existing.reason ?? undefined) !== (entry.reason ?? undefined)) {
      updateCurateDiscoveryBacklogEntry(target, entry);
    }

    const existingNotes = new Set(existing.notes);
    const nextNotes = new Set(entry.notes);
    for (const noteId of existing.notes) {
      if (!nextNotes.has(noteId)) {
        removeCurateDiscoveryBacklogNote(target, entryId, noteId);
      }
    }
    for (const noteId of entry.notes) {
      if (!existingNotes.has(noteId)) {
        addCurateDiscoveryBacklogNote(target, entryId, noteId);
      }
    }
  }
}
