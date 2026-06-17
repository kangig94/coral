import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Database } from '#src/store/db.js';
import { newRawDatabase, pragmaSimple, totalChanges } from '#tests/helpers/test-db.js';
import { describe, expect, it } from 'vitest';

import { applyBundledStoreSchema } from '#src/store/db.js';
function tableColumns(db: Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>).map((row) => row.name);
}

function rowCount(db: Database, table: string): { count: number } {
  return db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
}

describe('store schema idempotency', () => {
  it('second run performs zero write activity', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'coral-store-schemas-'));
    const db = newRawDatabase(join(tempDir, 'store.db'));

    try {
      applyBundledStoreSchema(db);
      const firstChanges = totalChanges(db);
      const firstSchemaVersion = pragmaSimple(db, 'schema_version');
      const firstUserVersion = pragmaSimple(db, 'user_version');

      applyBundledStoreSchema(db);
      const secondChanges = totalChanges(db);
      const secondSchemaVersion = pragmaSimple(db, 'schema_version');
      const secondUserVersion = pragmaSimple(db, 'user_version');

      expect(secondChanges).toBe(firstChanges);
      expect(secondSchemaVersion).toBe(firstSchemaVersion);
      expect(secondUserVersion).toBe(firstUserVersion);
    } finally {
      db.close();
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('store schema migrations create the expected baseline schema state', () => {
    const db = newRawDatabase(':memory:');

    try {
      applyBundledStoreSchema(db);

      const objects = (
        db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index') ORDER BY name").all() as Array<{
          name: string;
        }>
      ).map((row) => row.name);
      expect(objects).toContain('events');
      expect(objects).toContain('meta');
      expect(objects).toContain('projection_sessions');
      expect(objects).toContain('kb_corpus_state');
      expect(objects).toContain('consumer_cursors');
      expect(objects).toContain('kb_curate_scheduler');
      expect(objects).toContain('kb_curate_conflict_quarantine');
      expect(objects).toContain('expansion_manifest_catalog');

      const meta = (
        db.prepare('SELECT key, value FROM meta ORDER BY key').all() as { key: string; value: string }[]
      ).map(({ key, value }) => ({
        key,
        value: key === 'coordinator_id' || key === 'created_ts' ? '<dynamic>' : value,
      }));
      expect(meta.map((row) => row.key)).toEqual(['coordinator_id', 'created_ts', 'journal_version']);
      expect(pragmaSimple(db, 'user_version')).not.toBe(0);

      expect(
        db
          .prepare(
            'SELECT id, snapshot_id, content_seq, metadata_seq, content_manifest_hash, metadata_manifest_hash FROM kb_corpus_state',
          )
          .get(),
      ).toEqual({
        id: 1,
        snapshot_id: null,
        content_seq: 0,
        metadata_seq: 0,
        content_manifest_hash: null,
        metadata_manifest_hash: null,
      });

      expect(tableColumns(db, 'consumer_cursors')).toEqual([
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
        'registered_at',
        'registration_kind',
      ]);
      expect(tableColumns(db, 'expansion_manifest_catalog')).toEqual(['id', 'manifest_json', 'updated_at']);

      expect(tableColumns(db, 'expansion_state')).toEqual(['id', 'version', 'installed_at']);

      expect(tableColumns(db, 'kb_curate_scheduler')).toEqual([
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
        'claim_lane_disabled_at',
        'community_batch_lane_disabled_at',
        'community_topology_hash',
        'community_summary_topology_hash',
        'initialized',
      ]);

      expect(
        db
          .prepare(
            'SELECT id, processed_through_seq, processed_through_entry_id, processed_through_entry_kind, discovery_high_seq, discovery_offset, last_run_day, last_attempted_through_seq, last_attempted_through_entry_id, last_attempted_through_entry_kind, retry_not_before, consecutive_claim_failures, consecutive_community_batch_failures, community_topology_hash, community_summary_topology_hash, initialized FROM kb_curate_scheduler',
          )
          .get(),
      ).toEqual({
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
      });

      expect(tableColumns(db, 'kb_curate_active_claim')).toEqual([
        'id',
        'through_seq',
        'through_entry_id',
        'through_entry_kind',
        'started_at',
      ]);
      expect(rowCount(db, 'kb_curate_active_claim')).toEqual({ count: 0 });

      expect(tableColumns(db, 'kb_curate_community_summary_input_fingerprints')).toEqual([
        'community_slug',
        'fingerprint',
      ]);
      expect(rowCount(db, 'kb_curate_community_summary_input_fingerprints')).toEqual({ count: 0 });

      expect(tableColumns(db, 'kb_curate_retry_queue')).toEqual([
        'entry_id',
        'entry_seq',
        'reason',
        'observed_at',
        'observed_content_hash',
        'locus',
        'canonical_incident',
        'signals_json',
        'repair_hint',
        'retry_not_before',
        'retry_count',
      ]);

      const retryPlan = (
        db
          .prepare(
            'EXPLAIN QUERY PLAN SELECT entry_id, reason FROM kb_curate_retry_queue WHERE retry_not_before <= ? ORDER BY retry_not_before LIMIT 1',
          )
          .all('9999-12-31T23:59:59.999Z') as Array<{ detail: string }>
      ).map((row) => row.detail);
      expect(retryPlan.some((detail) => detail.includes('USING INDEX kb_curate_retry_by_time'))).toBe(true);

      expect(tableColumns(db, 'kb_curate_conflict_quarantine')).toEqual([
        'entry_id',
        'entry_kind',
        'slug',
        'path',
        'recovery_ref',
        'detected_at',
      ]);
      expect(rowCount(db, 'kb_curate_conflict_quarantine')).toEqual({ count: 0 });

      expect(tableColumns(db, 'kb_curate_discovery_backlog')).toEqual([
        'entry_id',
        'principle_slug',
        'statement',
        'queued_at',
        'reason',
      ]);

      expect(tableColumns(db, 'kb_curate_discovery_backlog_notes')).toEqual(['backlog_entry_id', 'note_id']);
      expect(
        (
          db.prepare("PRAGMA foreign_key_list('kb_curate_discovery_backlog_notes')").all() as Array<{
            table: string;
            from: string;
            to: string;
            on_delete: string;
          }>
        ).map(({ table, from, to, on_delete }) => ({ table, from, to, on_delete })),
      ).toEqual([
        {
          table: 'kb_curate_discovery_backlog',
          from: 'backlog_entry_id',
          to: 'entry_id',
          on_delete: 'CASCADE',
        },
      ]);
    } finally {
      db.close();
    }
  });
});
