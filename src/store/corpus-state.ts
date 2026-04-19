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
      INSERT OR IGNORE INTO corpus_state (id, content_seq, metadata_seq, last_mutation)
      VALUES (1, 0, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    `,
  ).run();
}

export function readCorpusStateRow(db: Database): CorpusStateRow {
  ensureCorpusStateRow(db);
  return db.prepare('SELECT id, content_seq, metadata_seq, last_mutation FROM corpus_state WHERE id = 1').get() as CorpusStateRow;
}

export function readCorpusState(db: Database): CorpusStateSnapshot {
  const row = readCorpusStateRow(db);
  return {
    contentSeq: row.content_seq,
    metadataSeq: row.metadata_seq,
  };
}

export function persistCorpusState(
  db: Database,
  snapshot: KbCorpusSnapshot,
  options: PersistCorpusStateOptions = {},
): KbPersistCorpusStateResult {
  const now = options.now ?? (() => new Date());
  const persistTxn = db.transaction((nextSnapshot: KbCorpusSnapshot): KbPersistCorpusStateResult => {
    const current = readCorpusStateRow(db);
    const nextContentSeq = Math.max(current.content_seq, nextSnapshot.contentSeq);
    const nextMetadataSeq = Math.max(current.metadata_seq, nextSnapshot.metadataSeq);
    const changedLanes: KbCorpusPublication['changedLanes'] = [];

    if (nextContentSeq > current.content_seq) {
      changedLanes.push('content');
    }
    if (nextMetadataSeq > current.metadata_seq) {
      changedLanes.push('metadata');
    }

    if (changedLanes.length === 0) {
      return {
        snapshot: {
          contentSeq: current.content_seq,
          metadataSeq: current.metadata_seq,
        },
        changedLanes,
      };
    }

    db.prepare(
      `
        UPDATE corpus_state
           SET content_seq = ?,
               metadata_seq = ?,
               last_mutation = ?
         WHERE id = 1
      `,
    ).run(nextContentSeq, nextMetadataSeq, now().toISOString());

    return {
      snapshot: {
        contentSeq: nextContentSeq,
        metadataSeq: nextMetadataSeq,
      },
      changedLanes,
    };
  });

  return persistTxn.immediate(snapshot);
}
