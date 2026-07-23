import { withImmediate, type Database } from '../../store/db.js';

import type { KbCorpusPublication, KbCorpusSnapshot, KbPersistCorpusStateResult } from '../contract.js';
import { z } from 'zod';

const corpusStateTimestampSchema = z.string().datetime();
const emptyCorpusStateRowSchema = z
  .object({
    id: z.literal(1),
    snapshot_id: z.null(),
    content_seq: z.literal(0),
    metadata_seq: z.literal(0),
    content_manifest_hash: z.null(),
    metadata_manifest_hash: z.null(),
    last_mutation: corpusStateTimestampSchema,
  })
  .strict();
const populatedCorpusStateRowSchema = z
  .object({
    id: z.literal(1),
    snapshot_id: z.string().min(1),
    content_seq: z.number().int().nonnegative(),
    metadata_seq: z.number().int().nonnegative(),
    content_manifest_hash: z.string().min(1),
    metadata_manifest_hash: z.string().min(1),
    last_mutation: corpusStateTimestampSchema,
  })
  .strict();

export const corpusStateRowSchema = z.union([emptyCorpusStateRowSchema, populatedCorpusStateRowSchema]);
type CorpusStateRow = z.infer<typeof corpusStateRowSchema>;

export interface CorpusSnapshotCursorRow {
  snapshot_id: string | null;
  content_seq: number | null;
  metadata_seq: number | null;
  content_manifest_hash: string | null;
  metadata_manifest_hash: string | null;
}

const EMPTY_CORPUS_SNAPSHOT: KbCorpusSnapshot = {
  snapshotId: '',
  contentSeq: 0,
  metadataSeq: 0,
  contentManifestHash: '',
  metadataManifestHash: '',
};

export interface PersistCorpusStateOptions {
  now: () => Date;
}

function readCorpusStateRow(db: Database): CorpusStateRow {
  const row = db
    .prepare(
      `
        SELECT id, snapshot_id, content_seq, metadata_seq, content_manifest_hash, metadata_manifest_hash, last_mutation
          FROM kb_corpus_state
         WHERE id = 1
      `,
    )
    .get();
  return corpusStateRowSchema.parse(row);
}

function stateRowToSnapshot(row: CorpusStateRow): KbCorpusSnapshot {
  if (row.snapshot_id === null) return { ...EMPTY_CORPUS_SNAPSHOT };
  return {
    snapshotId: row.snapshot_id,
    contentSeq: row.content_seq,
    metadataSeq: row.metadata_seq,
    contentManifestHash: row.content_manifest_hash,
    metadataManifestHash: row.metadata_manifest_hash,
  };
}

function toSnapshot(row: CorpusSnapshotCursorRow): KbCorpusSnapshot {
  return {
    snapshotId: row.snapshot_id ?? '',
    contentSeq: row.content_seq ?? 0,
    metadataSeq: row.metadata_seq ?? 0,
    contentManifestHash: row.content_manifest_hash ?? '',
    metadataManifestHash: row.metadata_manifest_hash ?? '',
  };
}

function isSnapshotFresh(current: CorpusSnapshotCursorRow, next: KbCorpusSnapshot): boolean {
  return (
    next.contentSeq > (current.content_seq ?? 0) ||
    next.metadataSeq > (current.metadata_seq ?? 0) ||
    (next.contentSeq === (current.content_seq ?? 0) &&
      next.metadataSeq === (current.metadata_seq ?? 0) &&
      next.snapshotId !== (current.snapshot_id ?? ''))
  );
}

function deriveChangedLanes(
  current: CorpusSnapshotCursorRow,
  next: KbCorpusSnapshot,
): KbCorpusPublication['changedLanes'] {
  const changedLanes: KbCorpusPublication['changedLanes'] = [];

  if (
    next.contentSeq > (current.content_seq ?? 0) ||
    (next.contentSeq === (current.content_seq ?? 0) &&
      next.contentManifestHash !== (current.content_manifest_hash ?? ''))
  ) {
    changedLanes.push('content');
  }

  if (
    next.metadataSeq > (current.metadata_seq ?? 0) ||
    (next.metadataSeq === (current.metadata_seq ?? 0) &&
      next.metadataManifestHash !== (current.metadata_manifest_hash ?? ''))
  ) {
    changedLanes.push('metadata');
  }

  return changedLanes;
}

function snapshotToCursorRow(snapshot: KbCorpusSnapshot): CorpusSnapshotCursorRow {
  return {
    snapshot_id: snapshot.snapshotId,
    content_seq: snapshot.contentSeq,
    metadata_seq: snapshot.metadataSeq,
    content_manifest_hash: snapshot.contentManifestHash,
    metadata_manifest_hash: snapshot.metadataManifestHash,
  };
}

export function normalizeCorpusCursor(row: CorpusSnapshotCursorRow | undefined): KbCorpusSnapshot {
  if (row === undefined) {
    return { ...EMPTY_CORPUS_SNAPSHOT };
  }

  return toSnapshot(row);
}

export function isSnapshotFresherForInterest(
  next: KbCorpusSnapshot,
  current: KbCorpusSnapshot,
  interest: 'content' | 'metadata' | 'both',
): boolean {
  const currentRow = snapshotToCursorRow(current);
  if (interest === 'both') {
    return isSnapshotFresh(currentRow, next);
  }

  return deriveChangedLanes(currentRow, next).includes(interest);
}

export function readCorpusState(db: Database): KbCorpusSnapshot {
  return stateRowToSnapshot(readCorpusStateRow(db));
}

export function persistCorpusState(
  db: Database,
  snapshot: KbCorpusSnapshot,
  options: PersistCorpusStateOptions,
): KbPersistCorpusStateResult {
  const now = options.now;
  return withImmediate(db, (): KbPersistCorpusStateResult => {
    const current = readCorpusStateRow(db);
    if (!isSnapshotFresh(current, snapshot)) {
      return {
        snapshot: toSnapshot(current),
        changedLanes: [],
      };
    }

    const changedLanes = deriveChangedLanes(current, snapshot);
    const update = db.prepare(
      `
        UPDATE kb_corpus_state
           SET snapshot_id = ?,
               content_seq = ?,
               metadata_seq = ?,
               content_manifest_hash = ?,
               metadata_manifest_hash = ?,
               last_mutation = ?
         WHERE id = 1
           AND (
             content_seq < ?
             OR metadata_seq < ?
             OR (content_seq = ? AND metadata_seq = ? AND (snapshot_id IS NULL OR snapshot_id != ?))
           )
      `,
    );
    const nowIso = now().toISOString();
    const result = update.run(
      snapshot.snapshotId,
      snapshot.contentSeq,
      snapshot.metadataSeq,
      snapshot.contentManifestHash,
      snapshot.metadataManifestHash,
      nowIso,
      snapshot.contentSeq,
      snapshot.metadataSeq,
      snapshot.contentSeq,
      snapshot.metadataSeq,
      snapshot.snapshotId,
    );

    if (result.changes === 0) {
      return {
        snapshot: toSnapshot(readCorpusStateRow(db)),
        changedLanes: [],
      };
    }

    return {
      snapshot: { ...snapshot },
      changedLanes,
    };
  });
}

export interface CorpusStateMirror {
  get(): KbCorpusSnapshot;
  invalidate(): void;
}

export function createCorpusStateMirror(db: Database): CorpusStateMirror {
  let cachedSnapshot: KbCorpusSnapshot | null = null;

  return {
    get(): KbCorpusSnapshot {
      cachedSnapshot ??= readCorpusState(db);
      return { ...cachedSnapshot };
    },
    invalidate(): void {
      cachedSnapshot = null;
    },
  };
}
