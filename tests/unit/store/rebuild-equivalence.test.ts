import * as fs from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { CoralSetupError } from '#src/runtime/errors.js';
import { appendEvents } from '#src/store/append.js';
import { createEmptyRegistry } from '#src/store/envelope.js';
import { applyStoreSchemas } from '#src/store/schema-loader.js';
import { composeReducers, type DomainEventRegistry, type Reducer } from '#src/store/reducers.js';
import { rebuildProjections } from '#src/store/rebuild.js';
import { applyTestCounterSchema, testCounterRegistry } from '#tests/unit/store/fixtures/test-counter-registry.js';

const SCHEMAS_DIR = join(process.cwd(), 'src/store/schemas');
const storageAdapter = {
  readdirSync: (p: string, opts: { withFileTypes: true }) => fs.readdirSync(p, opts),
  readFileSync: (p: string, enc: 'utf-8') => fs.readFileSync(p, enc),
};

describe('rebuildProjections equivalence (§3.5 replay identity)', () => {
  it('1000-event sequence produces byte-identical projection after rebuild', () => {
    const db = new Database(':memory:');
    try {
      applyStoreSchemas({ db, storage: storageAdapter as never, schemasDir: SCHEMAS_DIR });
      applyTestCounterSchema(db);
      const reducers = composeReducers(testCounterRegistry);
      const upcasters = createEmptyRegistry();

      const ids = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
      const inputs = Array.from({ length: 1000 }, (_, i) => ({
        type: 'test.counter.ticked' as const,
        stream: { kind: 'job' as const, id: `stream-${i % 3}` },
        bodyVersion: 1,
        body: { id: ids[i % ids.length], delta: (i % 7) + 1 },
      }));

      appendEvents(db, inputs, { now: () => new Date(0), reducers, upcasters });

      const beforeRebuild = db.prepare('SELECT * FROM projection_test_counter ORDER BY id').all();
      expect(beforeRebuild.length).toBe(ids.length);

      rebuildProjections({
        db,
        cutoffSeq: 1000,
        reducers,
        upcasters,
        extraProjectionTables: ['projection_test_counter'],
      });

      const afterRebuild = db.prepare('SELECT * FROM projection_test_counter ORDER BY id').all();
      expect(afterRebuild).toStrictEqual(beforeRebuild);
      // Column-drift guard: assert the row shape explicitly so a new projection column
      // that happens to default to the same value on both paths can't silently slip past toEqual.
      const columns = db.prepare(`PRAGMA table_info(projection_test_counter)`).all() as Array<{ name: string }>;
      expect(columns.map((c) => c.name).sort()).toEqual(['count', 'id', 'last_seq']);
      expect(afterRebuild.length).toBeGreaterThan(0);
      for (const row of afterRebuild as Array<Record<string, unknown>>) {
        expect(Object.keys(row).sort()).toEqual(['count', 'id', 'last_seq']);
      }
    } finally {
      db.close();
    }
  });

  it('does NOT touch kb_corpus_state (Corpus control state)', () => {
    const db = new Database(':memory:');
    try {
      applyStoreSchemas({ db, storage: storageAdapter as never, schemasDir: SCHEMAS_DIR });
      const reducers = composeReducers();
      const upcasters = createEmptyRegistry();

      db.prepare(
        `UPDATE kb_corpus_state
            SET snapshot_id = ?,
                content_seq = ?,
                metadata_seq = ?,
                content_manifest_hash = ?,
                metadata_manifest_hash = ?`,
      ).run('snapshot-before-rebuild', 5, 6, 'content-hash-before', 'metadata-hash-before');

      rebuildProjections({ db, cutoffSeq: 0, reducers, upcasters });

      const corpusState = db
        .prepare(
          'SELECT snapshot_id, content_seq, metadata_seq, content_manifest_hash, metadata_manifest_hash FROM kb_corpus_state',
        )
        .get() as {
        snapshot_id: string;
        content_seq: number;
        metadata_seq: number;
        content_manifest_hash: string;
        metadata_manifest_hash: string;
      };
      expect(corpusState).toEqual({
        snapshot_id: 'snapshot-before-rebuild',
        content_seq: 5,
        metadata_seq: 6,
        content_manifest_hash: 'content-hash-before',
        metadata_manifest_hash: 'metadata-hash-before',
      });
    } finally {
      db.close();
    }
  });

  it('throws CoralSetupError(schema_missing_for_event_type) when registry.types lacks a matching schema', () => {
    const missingSchemaRegistry: DomainEventRegistry = {
      types: ['test.counter.ticked'],
      reducers: {
        'test.counter.ticked': (() => {}) as Reducer<unknown>,
      },
      schemas: {} as Record<string, never>,
    };

    let thrown: unknown;
    try {
      composeReducers(missingSchemaRegistry);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CoralSetupError);
    expect((thrown as CoralSetupError).code).toBe('schema_missing_for_event_type');
  });

  it('throws CoralSetupError(event_stream_kind_invalid) when an events row has an unknown stream kind', () => {
    const db = new Database(':memory:');
    try {
      applyStoreSchemas({ db, storage: storageAdapter as never, schemasDir: SCHEMAS_DIR });

      db.prepare(
        `INSERT INTO events (
           seq,
           ts,
           type,
           stream_kind,
           stream_id,
           body_version,
           body
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(1, '2026-04-19T00:00:00.000Z', 'test.invalid-stream-kind', 'bogus', 'stream-1', 1, Buffer.from('{}'));

      const reducers = composeReducers();
      const upcasters = createEmptyRegistry();

      let thrown: unknown;
      try {
        rebuildProjections({
          db,
          cutoffSeq: 1,
          reducers,
          upcasters,
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(CoralSetupError);
      expect((thrown as CoralSetupError).code).toBe('event_stream_kind_invalid');
    } finally {
      db.close();
    }
  });
});
