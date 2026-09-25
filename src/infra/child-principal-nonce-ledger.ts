import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { StoragePort } from './port-types.js';

export function verifyChildPrincipalRecoveryGrant(
  storage: StoragePort,
  runDir: string,
  attemptId: string,
  grantId: string,
  generation: number,
  checkpoint: number,
): boolean {
  if (grantId !== `child-principal-nonces:${attemptId}`) return false;
  try {
    const db = storage.openSqliteDatabaseSync(join(runDir, 'child-principal-nonces.v1.sqlite'), { readOnly: true });
    try {
      const row = db
        .prepare('SELECT generation, checkpoint FROM child_principal_grant WHERE grant_id = ?')
        .get(grantId);
      return (
        row !== null &&
        typeof row === 'object' &&
        'generation' in row &&
        row.generation === generation &&
        'checkpoint' in row &&
        row.checkpoint === checkpoint
      );
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

export class ChildPrincipalNonceLedger {
  private readonly db: DatabaseSync;

  constructor(runDir: string) {
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    const path = join(runDir, 'child-principal-nonces.v1.sqlite');
    this.db = new DatabaseSync(path, { timeout: 5_000 });
    chmodSync(path, 0o600);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      CREATE TABLE IF NOT EXISTS child_principal_authority (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        generation INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO child_principal_authority (singleton, generation) VALUES (1, 1);
      CREATE TABLE IF NOT EXISTS child_principal_consumption (
        handle TEXT NOT NULL,
        token TEXT NOT NULL,
        generation INTEGER NOT NULL,
        PRIMARY KEY (handle, token)
      );
      CREATE TABLE IF NOT EXISTS child_principal_grant (
        grant_id TEXT PRIMARY KEY,
        generation INTEGER NOT NULL,
        checkpoint INTEGER NOT NULL
      );
    `);
  }

  generation(): number {
    const row = this.db.prepare('SELECT generation FROM child_principal_authority WHERE singleton = 1').get() as
      | { generation: number }
      | undefined;
    if (row === undefined) throw new Error('Child principal authority is missing.');
    return row.generation;
  }

  checkpoint(): number {
    const row = this.db.prepare('SELECT count(*) AS count FROM child_principal_consumption').get() as
      | { count: number }
      | undefined;
    if (row === undefined) throw new Error('Child principal consumption ledger is unreadable.');
    return row.count;
  }

  consumedTokens(handle: string): readonly string[] {
    return this.db
      .prepare('SELECT token FROM child_principal_consumption WHERE handle = ? ORDER BY token')
      .all(handle)
      .map((row) => String(row.token));
  }

  claimGenerationAndReplay(
    grantId: string,
    checkpoint: number,
    expectedGeneration: number,
    successorGeneration: number,
    handles: readonly string[],
  ): ReadonlyMap<string, readonly string[]> | null {
    if (successorGeneration <= expectedGeneration) return null;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const grant = this.db
        .prepare('SELECT generation, checkpoint FROM child_principal_grant WHERE grant_id = ?')
        .get(grantId) as { generation: number; checkpoint: number } | undefined;
      const currentGeneration = this.generation();
      if (
        grant?.generation !== expectedGeneration ||
        grant.checkpoint !== checkpoint ||
        this.checkpoint() < checkpoint ||
        (currentGeneration !== expectedGeneration && currentGeneration !== successorGeneration)
      ) {
        this.db.exec('ROLLBACK');
        return null;
      }
      if (currentGeneration === expectedGeneration) {
        this.db
          .prepare('UPDATE child_principal_authority SET generation = ? WHERE singleton = 1 AND generation = ?')
          .run(successorGeneration, expectedGeneration);
      }
      const consumed = new Map<string, readonly string[]>(
        handles.map((handle) => [handle, this.consumedTokens(handle)]),
      );
      this.db.exec('COMMIT');
      return consumed;
    } catch {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // An uncertain claim cannot authorize transferred authentication.
      }
      return null;
    }
  }

  prepareGrant(attemptId: string, generation: number): { grantId: string; checkpoint: number } | null {
    const grantId = `child-principal-nonces:${attemptId}`;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      if (this.generation() !== generation) {
        this.db.exec('ROLLBACK');
        return null;
      }
      const checkpoint = this.checkpoint();
      this.db
        .prepare('INSERT OR IGNORE INTO child_principal_grant (grant_id, generation, checkpoint) VALUES (?, ?, ?)')
        .run(grantId, generation, checkpoint);
      const recorded = this.db
        .prepare('SELECT generation, checkpoint FROM child_principal_grant WHERE grant_id = ?')
        .get(grantId) as { generation: number; checkpoint: number } | undefined;
      if (recorded?.generation !== generation) {
        this.db.exec('ROLLBACK');
        return null;
      }
      this.db.exec('COMMIT');
      return { grantId, checkpoint: recorded.checkpoint };
    } catch {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // A grant without a durable commit cannot authorize transfer.
      }
      return null;
    }
  }

  consume(handle: string, token: string, generation: number): boolean {
    try {
      this.db.exec('BEGIN IMMEDIATE');
      if (this.generation() !== generation) {
        this.db.exec('ROLLBACK');
        return false;
      }
      const inserted = this.db
        .prepare('INSERT OR IGNORE INTO child_principal_consumption (handle, token, generation) VALUES (?, ?, ?)')
        .run(handle, token, generation);
      this.db.exec('COMMIT');
      return inserted.changes === 1;
    } catch {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // The failed write cannot authorize the child.
      }
      return false;
    }
  }

  advanceGeneration(expected: number, successor: number): boolean {
    if (successor <= expected) return false;
    try {
      this.db.exec('BEGIN IMMEDIATE');
      const updated = this.db
        .prepare('UPDATE child_principal_authority SET generation = ? WHERE singleton = 1 AND generation = ?')
        .run(successor, expected);
      this.db.exec('COMMIT');
      return updated.changes === 1;
    } catch {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // An uncertain generation change cannot authorize either claimant.
      }
      return false;
    }
  }

  close(): void {
    this.db.close();
  }
}
