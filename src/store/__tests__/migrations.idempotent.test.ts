import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { applyMigrations } from '../migrations.js';
import type { StoragePort } from '../../runtime/ports.js';

const STORE_DIR = fileURLToPath(new URL('../', import.meta.url));
const SCHEMA_SQL_PATH = join(STORE_DIR, 'schema.sql');
const INITIAL_MIGRATION_PATH = join(STORE_DIR, 'migrations/001_initial.sql');
type TrackedDatabase = InstanceType<typeof Database> & { totalChanges: number };
const nodeStorage: Pick<StoragePort, 'readFileSync' | 'readdirSync'> = {
  readFileSync: (path, encoding) => readFileSync(path, encoding),
  readdirSync: (path, options) => readdirSync(path, options),
};

describe('migrations idempotency', () => {
  it('second run performs zero write activity', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'coral-store-migrations-'));
    const db = new Database(join(tempDir, 'store.db')) as TrackedDatabase;

    try {
      applyMigrations({ db, storage: nodeStorage });
      const firstChanges = db.totalChanges;
      const firstSchemaVersion = db.pragma('schema_version', { simple: true });
      const firstMetaVersion = (db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }).value;

      applyMigrations({ db, storage: nodeStorage });
      const secondChanges = db.totalChanges;
      const secondSchemaVersion = db.pragma('schema_version', { simple: true });
      const secondMetaVersion = (db.prepare("SELECT value FROM meta WHERE key='schema_version'").get() as { value: string }).value;

      expect(secondChanges).toBe(firstChanges);
      expect(secondSchemaVersion).toBe(firstSchemaVersion);
      expect(secondMetaVersion).toBe(firstMetaVersion);
    } finally {
      db.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('schema.sql and migrations/001_initial.sql remain byte-identical and yield matching schema state', () => {
    const schemaSql = readFileSync(SCHEMA_SQL_PATH, 'utf8');
    const migrationSql = readFileSync(INITIAL_MIGRATION_PATH, 'utf8');
    expect(migrationSql).toBe(schemaSql);

    const dbFromSchema = new Database(':memory:');
    const dbFromMigration = new Database(':memory:');

    try {
      dbFromSchema.exec(schemaSql);
      dbFromMigration.exec(migrationSql);

      const objectsA = (
        dbFromSchema
          .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index') ORDER BY name")
          .all() as { name: string }[]
      ).map((row) => row.name);
      const objectsB = (
        dbFromMigration
          .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index') ORDER BY name")
          .all() as { name: string }[]
      ).map((row) => row.name);
      expect(objectsA).toEqual(objectsB);

      const metaA = (
        dbFromSchema.prepare("SELECT key, value FROM meta ORDER BY key").all() as { key: string; value: string }[]
      ).map(({ key, value }) => ({ key, value: key === 'coordinator_id' || key === 'created_ts' ? '<dynamic>' : value }));
      const metaB = (
        dbFromMigration.prepare("SELECT key, value FROM meta ORDER BY key").all() as { key: string; value: string }[]
      ).map(({ key, value }) => ({ key, value: key === 'coordinator_id' || key === 'created_ts' ? '<dynamic>' : value }));
      expect(metaA).toEqual(metaB);
      expect(metaA.map((row) => row.key)).toEqual(['coordinator_id', 'created_ts', 'journal_version', 'schema_version']);

      const corpusStateA = dbFromSchema.prepare('SELECT id, content_seq, metadata_seq FROM corpus_state').get() as {
        id: number;
        content_seq: number;
        metadata_seq: number;
      };
      const corpusStateB = dbFromMigration.prepare('SELECT id, content_seq, metadata_seq FROM corpus_state').get() as {
        id: number;
        content_seq: number;
        metadata_seq: number;
      };
      expect(corpusStateA).toEqual({ id: 1, content_seq: 0, metadata_seq: 0 });
      expect(corpusStateB).toEqual(corpusStateA);

      const curateSchedulerA = dbFromSchema
        .prepare(
          'SELECT id, processed_through, discovery_high_seq, discovery_offset, last_run_day, consecutive_failures, community_topology_hash FROM curate_scheduler',
        )
        .get() as {
          id: number;
          processed_through: string | null;
          discovery_high_seq: number | null;
          discovery_offset: number | null;
          last_run_day: string | null;
          consecutive_failures: number;
          community_topology_hash: string | null;
        };
      const curateSchedulerB = dbFromMigration
        .prepare(
          'SELECT id, processed_through, discovery_high_seq, discovery_offset, last_run_day, consecutive_failures, community_topology_hash FROM curate_scheduler',
        )
        .get() as {
          id: number;
          processed_through: string | null;
          discovery_high_seq: number | null;
          discovery_offset: number | null;
          last_run_day: string | null;
          consecutive_failures: number;
          community_topology_hash: string | null;
        };
      expect(curateSchedulerA).toEqual({
        id: 1,
        processed_through: null,
        discovery_high_seq: null,
        discovery_offset: null,
        last_run_day: null,
        consecutive_failures: 0,
        community_topology_hash: null,
      });
      expect(curateSchedulerB).toEqual(curateSchedulerA);
    } finally {
      dbFromSchema.close();
      dbFromMigration.close();
    }
  });
});
