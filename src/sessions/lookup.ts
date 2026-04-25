import type BetterSqlite3 from 'better-sqlite3';

import type { Runtime } from '../runtime/ports.js';
import { currentBuildFlavor } from '../infra/build-flavor.js';
import { openBackendStoreDb } from '../store/db.js';
import type { SessionEntry } from './entry.js';
import { readProjectionSessionEntry } from './projections.js';

export type SessionLookupRef = {
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

type SessionLookupRuntime = Pick<Runtime, 'storage' | 'paths'>;

export function createSessionLookup(runtime: SessionLookupRuntime): SessionLookup {
  return createProjectionSessionLookup(openBackendStoreDb(runtime, currentBuildFlavor()));
}
