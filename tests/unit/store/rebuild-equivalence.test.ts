import { currentCoralStoreFormat } from '#src/store-format.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { describe, expect, it } from 'vitest';

import { CoralSetupError } from '#src/runtime/errors.js';
import { StoreCodecError } from '#src/store/body-codec.js';
import { commitInputs } from '#tests/helpers/commit-inputs.js';
import { createEventBodyCodec } from '#src/store/event-body-codec.js';
import { applyBundledStoreSchema } from '#src/store/db.js';
import { composeReducers, defineDomainEvent } from '#src/store/reducers.js';
import { z } from 'zod';
import { rebuildProjections } from '#tests/helpers/rebuild-projections.js';
import { applyTestCounterSchema, testCounterRegistry } from '#tests/unit/store/fixtures/test-counter-registry.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';

describe('rebuildProjections replay identity', () => {
  it('1000-event sequence produces byte-identical projection after rebuild', () => {
    const db = newRawDatabase(':memory:');
    try {
      applyBundledStoreSchema(db, currentCoralStoreFormat());
      applyTestCounterSchema(db);
      const reducers = composeReducers(testCounterRegistry);
      const bodyCodec = createEventBodyCodec();

      const ids = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
      const inputs = Array.from({ length: 1000 }, (_, i) => ({
        type: 'test.counter.ticked' as const,
        stream: { kind: 'job' as const, id: `stream-${i % 3}` },
        body: { id: ids[i % ids.length], delta: (i % 7) + 1 },
      }));

      commitInputs(db, inputs, {
        now: () => new Date(0),
        reducers,
        bodyCodec,
        providers: permissiveProviderLookupPort,
      });

      const beforeRebuild = db.prepare('SELECT * FROM projection_test_counter ORDER BY id').all();
      expect(beforeRebuild.length).toBe(ids.length);

      rebuildProjections({
        db,
        cutoffSeq: 1000,
        reducers,
        bodyCodec,
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
    const db = newRawDatabase(':memory:');
    try {
      applyBundledStoreSchema(db, currentCoralStoreFormat());
      const reducers = composeReducers({
        streamKind: 'job',
        entries: [defineDomainEvent({ type: 'test.invalid-stream-kind', schema: z.object({}).strict() })],
      });
      const bodyCodec = createEventBodyCodec();

      db.prepare(
        `UPDATE kb_corpus_state
            SET snapshot_id = ?,
                content_seq = ?,
                metadata_seq = ?,
                content_manifest_hash = ?,
                metadata_manifest_hash = ?`,
      ).run('snapshot-before-rebuild', 5, 6, 'content-hash-before', 'metadata-hash-before');

      rebuildProjections({ db, cutoffSeq: 0, reducers, bodyCodec });

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

  it('throws CoralSetupError(reducer_duplicate) when the same event type is registered twice', () => {
    const schema = z.object({ id: z.string() });
    const first = {
      streamKind: 'job' as const,
      entries: [defineDomainEvent({ type: 'dup.event', schema })],
    };
    const second = {
      streamKind: 'job' as const,
      entries: [defineDomainEvent({ type: 'dup.event', schema })],
    };

    let thrown: unknown;
    try {
      composeReducers(first, second);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CoralSetupError);
    expect((thrown as CoralSetupError).code).toBe('reducer_duplicate');
  });

  it('rejects an events row whose stream kind does not match its registered type', () => {
    const db = newRawDatabase(':memory:');
    try {
      applyBundledStoreSchema(db, currentCoralStoreFormat());

      db.prepare(
        `INSERT INTO events (
           seq,
           ts,
           type,
           stream_kind,
           stream_id,
           body
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(1, '2026-04-19T00:00:00.000Z', 'test.invalid-stream-kind', 'bogus', 'stream-1', Buffer.from('{}'));

      const reducers = composeReducers({
        streamKind: 'job',
        entries: [defineDomainEvent({ type: 'test.invalid-stream-kind', schema: z.object({}).strict() })],
      });
      const bodyCodec = createEventBodyCodec();

      let thrown: unknown;
      try {
        rebuildProjections({
          db,
          cutoffSeq: 1,
          reducers,
          bodyCodec,
        });
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(StoreCodecError);
      expect((thrown as StoreCodecError).code).toBe('store_codec_rejected');
    } finally {
      db.close();
    }
  });

  it('rolls back projection rebuild when a registered stored body violates the current codec', () => {
    const db = newRawDatabase(':memory:');
    try {
      applyBundledStoreSchema(db, currentCoralStoreFormat());
      applyTestCounterSchema(db);
      const reducers = composeReducers(testCounterRegistry);
      const bodyCodec = createEventBodyCodec();
      commitInputs(
        db,
        [
          {
            type: 'test.counter.ticked',
            stream: { kind: 'job', id: 'job-invalid-body' },
            body: { id: 'preserved', delta: 3 },
          },
        ],
        {
          now: () => new Date(0),
          reducers,
          bodyCodec,
          providers: permissiveProviderLookupPort,
        },
      );
      const before = db.prepare('SELECT * FROM projection_test_counter').all();
      db.prepare('UPDATE events SET body = ? WHERE seq = 1').run(
        Buffer.from(JSON.stringify({ id: 'preserved', delta: 'bad' })),
      );

      expect(() =>
        rebuildProjections({
          db,
          cutoffSeq: 1,
          reducers,
          bodyCodec,
          extraProjectionTables: ['projection_test_counter'],
        }),
      ).toThrow("Current codec rejected stored event type 'test.counter.ticked'");
      expect(db.prepare('SELECT * FROM projection_test_counter').all()).toEqual(before);
    } finally {
      db.close();
    }
  });
});
