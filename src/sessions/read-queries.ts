import type BetterSqlite3 from 'better-sqlite3';

import type { SessionEntry } from './entry.js';
import { readProjectionSessionEntry } from './projections.js';

export function readSessionEntryById(db: BetterSqlite3.Database, sessionId: string): SessionEntry {
  const entry = readProjectionSessionEntry(db, sessionId);

  if (entry === null) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  return entry;
}
