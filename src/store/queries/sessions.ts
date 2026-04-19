import type BetterSqlite3 from 'better-sqlite3';

import type { SessionLookup, SessionLookupRef } from '../../sessions/lookup.js';

type SessionLookupRow = {
  session_id: string;
  provider: string;
  shard_dir: string;
};

export function createProjectionSessionLookup(db: BetterSqlite3.Database): SessionLookup {
  const listStmt = db.prepare<[], SessionLookupRow>(
    `SELECT session_id, provider, shard_dir
       FROM projection_sessions
      ORDER BY session_id ASC`,
  );
  const lookupStmt = db.prepare<[string], SessionLookupRow>(
    `SELECT session_id, provider, shard_dir
       FROM projection_sessions
      WHERE session_id = ?
      LIMIT 1`,
  );

  return {
    listSessionRefs(): SessionLookupRef[] {
      return listStmt.all().map((row) => ({
        sessionId: row.session_id,
        provider: row.provider,
        shardDir: row.shard_dir,
      }));
    },
    lookupSessionShard(sessionId: string): { shardDir: string; provider: string } | null {
      const row = lookupStmt.get(sessionId);
      return row
        ? {
            shardDir: row.shard_dir,
            provider: row.provider,
          }
        : null;
    },
  };
}
