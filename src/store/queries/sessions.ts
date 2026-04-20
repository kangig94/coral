import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';

import type { SessionLookup, SessionLookupRef } from '../../sessions/lookup.js';
import type { SessionEntry } from '../../sessions/entry.js';
import {
  readSessionEntry,
  readSessionEntryLenient,
  type LenientSessionEntry,
  type ProvenanceState,
} from '../../sessions/shell/session-read.js';
import { readSessionRefs } from '../../sessions/shell/resolve.js';
import { sessionBase } from '../../infra/paths.js';

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

function readProjectionSessionShard(
  db: BetterSqlite3.Database,
  sessionId: string,
): string | null {
  const row = db.prepare<[string], Pick<SessionLookupRow, 'shard_dir'>>(
    `SELECT shard_dir
       FROM projection_sessions
      WHERE session_id = ?
      LIMIT 1`,
  ).get(sessionId);

  return row?.shard_dir ?? null;
}

function listSessionShardDirs(): string[] {
  try {
    return readdirSync(sessionBase(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(sessionBase(), entry.name));
  } catch {
    return [];
  }
}

function findSessionFilePath(
  db: BetterSqlite3.Database,
  sessionId: string,
): string | null {
  const projectionShard = readProjectionSessionShard(db, sessionId);
  if (projectionShard !== null) {
    const projectionPath = join(projectionShard, `${sessionId}.json`);
    if (existsSync(projectionPath)) {
      return projectionPath;
    }
  }

  for (const shardDir of listSessionShardDirs()) {
    const match = readSessionRefs(shardDir, { readdirSync, readFileSync }).find((ref) => ref.sessionId === sessionId);
    if (match) {
      const sessionPath = join(shardDir, `${sessionId}.json`);
      if (existsSync(sessionPath)) {
        return sessionPath;
      }
    }
  }

  return null;
}

export function readSessionEntryById(
  db: BetterSqlite3.Database,
  sessionId: string,
): SessionEntry {
  const sessionPath = findSessionFilePath(db, sessionId);
  const entry = sessionPath === null ? null : readSessionEntry(sessionPath);

  if (entry === null) {
    throw new Error(`Session not found: ${sessionId}`);
  }

  return entry;
}

export function readSessionEntryLenientById(
  db: BetterSqlite3.Database,
  sessionId: string,
): LenientSessionEntry | null {
  const sessionPath = findSessionFilePath(db, sessionId);
  return sessionPath === null ? null : readSessionEntryLenient(sessionPath);
}

export function readSessionProvenanceById(
  db: BetterSqlite3.Database,
  sessionId: string,
): ProvenanceState | null {
  return readSessionEntryLenientById(db, sessionId)?.provenanceState ?? null;
}
