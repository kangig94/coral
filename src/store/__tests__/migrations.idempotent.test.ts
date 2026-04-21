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

  it('schema.sql and the applied migrations yield matching schema state', () => {
    const schemaSql = readFileSync(SCHEMA_SQL_PATH, 'utf8');

    const dbFromSchema = new Database(':memory:');
    const dbFromMigration = new Database(':memory:');

    try {
      dbFromSchema.exec(schemaSql);
      applyMigrations({ db: dbFromMigration, storage: nodeStorage });

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
      expect(metaA.find((row) => row.key === 'schema_version')).toEqual({ key: 'schema_version', value: '1' });

      const corpusStateA = dbFromSchema.prepare(
        'SELECT id, snapshot_id, content_seq, metadata_seq, content_manifest_hash, metadata_manifest_hash FROM corpus_state',
      ).get() as {
        id: number;
        snapshot_id: string | null;
        content_seq: number;
        metadata_seq: number;
        content_manifest_hash: string | null;
        metadata_manifest_hash: string | null;
      };
      const corpusStateB = dbFromMigration.prepare(
        'SELECT id, snapshot_id, content_seq, metadata_seq, content_manifest_hash, metadata_manifest_hash FROM corpus_state',
      ).get() as {
        id: number;
        snapshot_id: string | null;
        content_seq: number;
        metadata_seq: number;
        content_manifest_hash: string | null;
        metadata_manifest_hash: string | null;
      };
      expect(corpusStateA).toEqual({
        id: 1,
        snapshot_id: null,
        content_seq: 0,
        metadata_seq: 0,
        content_manifest_hash: null,
        metadata_manifest_hash: null,
      });
      expect(corpusStateB).toEqual(corpusStateA);

      const equipmentCursorColumnsA = (
        dbFromSchema.prepare("PRAGMA table_info('equipment_cursors')").all() as Array<{ name: string }>
      ).map((row) => row.name);
      const equipmentCursorColumnsB = (
        dbFromMigration.prepare("PRAGMA table_info('equipment_cursors')").all() as Array<{ name: string }>
      ).map((row) => row.name);
      expect(equipmentCursorColumnsA).toEqual([
        'consumer_id',
        'authority',
        'lane',
        'corpus_interest',
        'cursor',
        'snapshot_id',
        'content_seq',
        'metadata_seq',
        'content_manifest_hash',
        'metadata_manifest_hash',
        'equipped_at',
      ]);
      expect(equipmentCursorColumnsB).toEqual(equipmentCursorColumnsA);

      const curateSchedulerColumnsA = (
        dbFromSchema.prepare("PRAGMA table_info('curate_scheduler')").all() as Array<{ name: string }>
      ).map((row) => row.name);
      const curateSchedulerColumnsB = (
        dbFromMigration.prepare("PRAGMA table_info('curate_scheduler')").all() as Array<{ name: string }>
      ).map((row) => row.name);
      expect(curateSchedulerColumnsA).toEqual([
        'id',
        'processed_through_seq',
        'processed_through_entry_id',
        'processed_through_entry_kind',
        'discovery_high_seq',
        'discovery_offset',
        'last_run_day',
        'last_attempted_through_seq',
        'last_attempted_through_entry_id',
        'last_attempted_through_entry_kind',
        'retry_not_before',
        'consecutive_claim_failures',
        'consecutive_community_batch_failures',
        'community_topology_hash',
        'community_summary_topology_hash',
        'initialized',
        'migration_version',
      ]);
      expect(curateSchedulerColumnsB).toEqual(curateSchedulerColumnsA);

      const curateSchedulerA = dbFromSchema
        .prepare(
          'SELECT id, processed_through_seq, processed_through_entry_id, processed_through_entry_kind, discovery_high_seq, discovery_offset, last_run_day, last_attempted_through_seq, last_attempted_through_entry_id, last_attempted_through_entry_kind, retry_not_before, consecutive_claim_failures, consecutive_community_batch_failures, community_topology_hash, community_summary_topology_hash, initialized, migration_version FROM curate_scheduler',
        )
        .get() as {
          id: number;
          processed_through_seq: number | null;
          processed_through_entry_id: string | null;
          processed_through_entry_kind: string | null;
          discovery_high_seq: number | null;
          discovery_offset: number | null;
          last_run_day: string | null;
          last_attempted_through_seq: number | null;
          last_attempted_through_entry_id: string | null;
          last_attempted_through_entry_kind: string | null;
          retry_not_before: string | null;
          consecutive_claim_failures: number;
          consecutive_community_batch_failures: number;
          community_topology_hash: string | null;
          community_summary_topology_hash: string | null;
          initialized: number;
          migration_version: number;
        };
      const curateSchedulerB = dbFromMigration
        .prepare(
          'SELECT id, processed_through_seq, processed_through_entry_id, processed_through_entry_kind, discovery_high_seq, discovery_offset, last_run_day, last_attempted_through_seq, last_attempted_through_entry_id, last_attempted_through_entry_kind, retry_not_before, consecutive_claim_failures, consecutive_community_batch_failures, community_topology_hash, community_summary_topology_hash, initialized, migration_version FROM curate_scheduler',
        )
        .get() as {
          id: number;
          processed_through_seq: number | null;
          processed_through_entry_id: string | null;
          processed_through_entry_kind: string | null;
          discovery_high_seq: number | null;
          discovery_offset: number | null;
          last_run_day: string | null;
          last_attempted_through_seq: number | null;
          last_attempted_through_entry_id: string | null;
          last_attempted_through_entry_kind: string | null;
          retry_not_before: string | null;
          consecutive_claim_failures: number;
          consecutive_community_batch_failures: number;
          community_topology_hash: string | null;
          community_summary_topology_hash: string | null;
          initialized: number;
          migration_version: number;
        };
      expect(curateSchedulerA).toEqual({
        id: 1,
        processed_through_seq: null,
        processed_through_entry_id: null,
        processed_through_entry_kind: null,
        discovery_high_seq: null,
        discovery_offset: null,
        last_run_day: null,
        last_attempted_through_seq: null,
        last_attempted_through_entry_id: null,
        last_attempted_through_entry_kind: null,
        retry_not_before: null,
        consecutive_claim_failures: 0,
        consecutive_community_batch_failures: 0,
        community_topology_hash: null,
        community_summary_topology_hash: null,
        initialized: 0,
        migration_version: 0,
      });
      expect(curateSchedulerB).toEqual(curateSchedulerA);

      const activeClaimColumnsA = (
        dbFromSchema.prepare("PRAGMA table_info('curate_active_claim')").all() as Array<{ name: string }>
      ).map((row) => row.name);
      const activeClaimColumnsB = (
        dbFromMigration.prepare("PRAGMA table_info('curate_active_claim')").all() as Array<{ name: string }>
      ).map((row) => row.name);
      expect(activeClaimColumnsA).toEqual(['id', 'through_seq', 'through_entry_id', 'through_entry_kind', 'started_at']);
      expect(activeClaimColumnsB).toEqual(activeClaimColumnsA);
      expect(dbFromSchema.prepare('SELECT COUNT(*) AS count FROM curate_active_claim').get()).toEqual({ count: 0 });
      expect(dbFromMigration.prepare('SELECT COUNT(*) AS count FROM curate_active_claim').get()).toEqual({ count: 0 });

      const fingerprintColumnsA = (
        dbFromSchema.prepare("PRAGMA table_info('curate_community_summary_input_fingerprints')").all() as Array<{ name: string }>
      ).map((row) => row.name);
      const fingerprintColumnsB = (
        dbFromMigration.prepare("PRAGMA table_info('curate_community_summary_input_fingerprints')").all() as Array<{ name: string }>
      ).map((row) => row.name);
      expect(fingerprintColumnsA).toEqual(['community_slug', 'fingerprint']);
      expect(fingerprintColumnsB).toEqual(fingerprintColumnsA);
      expect(
        dbFromSchema.prepare('SELECT COUNT(*) AS count FROM curate_community_summary_input_fingerprints').get(),
      ).toEqual({ count: 0 });
      expect(
        dbFromMigration.prepare('SELECT COUNT(*) AS count FROM curate_community_summary_input_fingerprints').get(),
      ).toEqual({ count: 0 });

      const retryQueueColumnsA = (
        dbFromSchema.prepare("PRAGMA table_info('curate_retry_queue')").all() as Array<{ name: string }>
      ).map((row) => row.name);
      const retryQueueColumnsB = (
        dbFromMigration.prepare("PRAGMA table_info('curate_retry_queue')").all() as Array<{ name: string }>
      ).map((row) => row.name);
      expect(retryQueueColumnsA).toEqual([
        'entry_id',
        'entry_seq',
        'reason',
        'observed_at',
        'locus',
        'canonical_incident',
        'signals_json',
        'repair_hint',
        'retry_not_before',
        'retry_count',
      ]);
      expect(retryQueueColumnsB).toEqual(retryQueueColumnsA);

      const retryPlanA = (
        dbFromSchema
          .prepare(
            'EXPLAIN QUERY PLAN SELECT entry_id, reason FROM curate_retry_queue WHERE retry_not_before <= ? ORDER BY retry_not_before LIMIT 1',
          )
          .all('9999-12-31T23:59:59.999Z') as Array<{ detail: string }>
      ).map((row) => row.detail);
      const retryPlanB = (
        dbFromMigration
          .prepare(
            'EXPLAIN QUERY PLAN SELECT entry_id, reason FROM curate_retry_queue WHERE retry_not_before <= ? ORDER BY retry_not_before LIMIT 1',
          )
          .all('9999-12-31T23:59:59.999Z') as Array<{ detail: string }>
      ).map((row) => row.detail);
      expect(retryPlanA.some((detail) => detail.includes('USING INDEX curate_retry_by_time'))).toBe(true);
      expect(retryPlanB.some((detail) => detail.includes('USING INDEX curate_retry_by_time'))).toBe(true);

      const discoveryBacklogColumnsA = (
        dbFromSchema.prepare("PRAGMA table_info('curate_discovery_backlog')").all() as Array<{ name: string }>
      ).map((row) => row.name);
      const discoveryBacklogColumnsB = (
        dbFromMigration.prepare("PRAGMA table_info('curate_discovery_backlog')").all() as Array<{ name: string }>
      ).map((row) => row.name);
      expect(discoveryBacklogColumnsA).toEqual(['entry_id', 'principle_slug', 'statement', 'queued_at', 'reason']);
      expect(discoveryBacklogColumnsB).toEqual(discoveryBacklogColumnsA);

      const discoveryBacklogNotesColumnsA = (
        dbFromSchema.prepare("PRAGMA table_info('curate_discovery_backlog_notes')").all() as Array<{ name: string }>
      ).map((row) => row.name);
      const discoveryBacklogNotesColumnsB = (
        dbFromMigration.prepare("PRAGMA table_info('curate_discovery_backlog_notes')").all() as Array<{ name: string }>
      ).map((row) => row.name);
      expect(discoveryBacklogNotesColumnsA).toEqual(['backlog_entry_id', 'note_id']);
      expect(discoveryBacklogNotesColumnsB).toEqual(discoveryBacklogNotesColumnsA);

      const discoveryBacklogFksA = (
        dbFromSchema.prepare("PRAGMA foreign_key_list('curate_discovery_backlog_notes')").all() as Array<{
          table: string;
          from: string;
          to: string;
          on_delete: string;
        }>
      ).map(({ table, from, to, on_delete }) => ({ table, from, to, on_delete }));
      const discoveryBacklogFksB = (
        dbFromMigration.prepare("PRAGMA foreign_key_list('curate_discovery_backlog_notes')").all() as Array<{
          table: string;
          from: string;
          to: string;
          on_delete: string;
        }>
      ).map(({ table, from, to, on_delete }) => ({ table, from, to, on_delete }));
      expect(discoveryBacklogFksA).toEqual([
        {
          table: 'curate_discovery_backlog',
          from: 'backlog_entry_id',
          to: 'entry_id',
          on_delete: 'CASCADE',
        },
      ]);
      expect(discoveryBacklogFksB).toEqual(discoveryBacklogFksA);
    } finally {
      dbFromSchema.close();
      dbFromMigration.close();
    }
  });
});
