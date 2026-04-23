import type BetterSqlite3 from 'better-sqlite3';

import type { CorpusSnapshot } from './corpus/snapshot.js';
import { readCorpusState } from './state/corpus-state.js';

type Database = BetterSqlite3.Database;

export interface CorpusStateMirror {
  get(): CorpusSnapshot;
  invalidate(): void;
}

/** Caches the last persisted corpus snapshot so repeated readers avoid duplicate store hits. */
export function createCorpusStateMirror(db: Database): CorpusStateMirror {
  let cachedSnapshot: CorpusSnapshot | null = null;

  return {
    get(): CorpusSnapshot {
      cachedSnapshot ??= readCorpusState(db);
      return { ...cachedSnapshot };
    },
    invalidate(): void {
      cachedSnapshot = null;
    },
  };
}
