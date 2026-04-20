import type BetterSqlite3 from 'better-sqlite3';

import type { KbCorpusPublication, KbCorpusSnapshot, KbPersistCorpusStateResult } from '../kb/contracts.js';
import type { CorpusStateRow } from './schema.js';

type Database = BetterSqlite3.Database;
export type CorpusStateSnapshot = KbCorpusSnapshot;

export interface PersistCorpusStateOptions {
  now?: () => Date;
}

function ensureCorpusStateRow(db: Database): void {
  db.prepare(
    `
      INSERT OR IGNORE INTO corpus_state (
        id,
        snapshot_id,
        content_seq,
        metadata_seq,
        content_manifest_hash,
        metadata_manifest_hash,
        last_mutation
      ) VALUES (1, NULL, 0, 0, NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    `,
  ).run();
}

export function readCorpusStateRow(db: Database): CorpusStateRow {
  ensureCorpusStateRow(db);
  return db
    .prepare(
      `
        SELECT id, snapshot_id, content_seq, metadata_seq, content_manifest_hash, metadata_manifest_hash, last_mutation
          FROM corpus_state
         WHERE id = 1
      `,
    )
    .get() as CorpusStateRow;
}

function toSnapshot(row: CorpusStateRow): CorpusStateSnapshot {
  return {
    snapshotId: row.snapshot_id ?? '',
    contentSeq: row.content_seq,
    metadataSeq: row.metadata_seq,
    contentManifestHash: row.content_manifest_hash ?? '',
    metadataManifestHash: row.metadata_manifest_hash ?? '',
  };
}

function isSnapshotFresh(current: CorpusStateRow, next: KbCorpusSnapshot): boolean {
  return (
    next.contentSeq > current.content_seq ||
    next.metadataSeq > current.metadata_seq ||
    (next.contentSeq === current.content_seq &&
      next.metadataSeq === current.metadata_seq &&
      next.snapshotId !== (current.snapshot_id ?? ''))
  );
}

function deriveChangedLanes(current: CorpusStateRow, next: KbCorpusSnapshot): KbCorpusPublication['changedLanes'] {
  const changedLanes: KbCorpusPublication['changedLanes'] = [];

  if (
    next.contentSeq > current.content_seq ||
    (next.contentSeq === current.content_seq && next.contentManifestHash !== (current.content_manifest_hash ?? ''))
  ) {
    changedLanes.push('content');
  }

  if (
    next.metadataSeq > current.metadata_seq ||
    (next.metadataSeq === current.metadata_seq && next.metadataManifestHash !== (current.metadata_manifest_hash ?? ''))
  ) {
    changedLanes.push('metadata');
  }

  return changedLanes;
}

export function readCorpusState(db: Database): CorpusStateSnapshot {
  return toSnapshot(readCorpusStateRow(db));
}

export function persistCorpusState(
  db: Database,
  snapshot: KbCorpusSnapshot,
  options: PersistCorpusStateOptions = {},
): KbPersistCorpusStateResult {
  const now = options.now ?? (() => new Date());
  const persistTxn = db.transaction((nextSnapshot: KbCorpusSnapshot): KbPersistCorpusStateResult => {
    const current = readCorpusStateRow(db);
    if (!isSnapshotFresh(current, nextSnapshot)) {
      return {
        snapshot: toSnapshot(current),
        changedLanes: [],
      };
    }

    const changedLanes = deriveChangedLanes(current, nextSnapshot);
    const update = db.prepare(
      `
        UPDATE corpus_state
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
      nextSnapshot.snapshotId,
      nextSnapshot.contentSeq,
      nextSnapshot.metadataSeq,
      nextSnapshot.contentManifestHash,
      nextSnapshot.metadataManifestHash,
      nowIso,
      nextSnapshot.contentSeq,
      nextSnapshot.metadataSeq,
      nextSnapshot.contentSeq,
      nextSnapshot.metadataSeq,
      nextSnapshot.snapshotId,
    );

    if (result.changes === 0) {
      return {
        snapshot: toSnapshot(readCorpusStateRow(db)),
        changedLanes: [],
      };
    }

    return {
      snapshot: { ...nextSnapshot },
      changedLanes,
    };
  });

  return persistTxn.immediate(snapshot);
}
