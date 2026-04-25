import type BetterSqlite3 from 'better-sqlite3';

import type { SessionLookup, SessionLookupRef } from './lookup-contract.js';
import type { SessionEntry } from './entry.js';
import { readProjectionSessionEntry } from './projections.js';

type SessionLookupRow = {
  session_id: string;
  provider: string;
};

export function createProjectionSessionLookup(db: BetterSqlite3.Database): SessionLookup {
  const listStmt = db.prepare<[], SessionLookupRow>(
    `SELECT session_id, provider
       FROM projection_sessions
      ORDER BY session_id ASC`,
  );

  return {
    listSessionRefs(): SessionLookupRef[] {
      return listStmt.all().map((row) => ({
        sessionId: row.session_id,
        provider: row.provider,
      }));
    },
    readSessionEntry(sessionId: string): SessionEntry | null {
      return readProjectionSessionEntry(db, sessionId);
    },
  };
}

export function readSessionEntryById(
  db: BetterSqlite3.Database,
  sessionId: string,
): SessionEntry {
  const entry = readProjectionSessionEntry(db, sessionId);

  if (entry === null) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  return entry;
}
