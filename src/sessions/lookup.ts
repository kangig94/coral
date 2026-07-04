import type { ReadonlyDatabase } from '../store/read-port.js';
import type { SessionEntry } from './entry.js';
import { readProjectionSessionEntry } from './projections.js';

type SessionLookupRef = {
  sessionId: string;
  provider: string;
};

export interface SessionLookup {
  listSessionRefs(): SessionLookupRef[];
  readSessionEntry(sessionId: string): SessionEntry | null;
}

type SessionLookupRow = {
  session_id: string;
  provider: string;
};

export function createProjectionSessionLookup(db: ReadonlyDatabase): SessionLookup {
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
