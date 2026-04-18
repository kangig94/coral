import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { appendEvents } from '../append.js';
import { createEmptyRegistry } from '../envelope.js';
import { applyMigrations } from '../migrations.js';
import { composeReducers } from '../reducers.js';
import { rebuildProjections } from '../rebuild.js';
import { applyTestCounterMigration, testCounterRegistry } from './fixtures/test-counter-registry.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../migrations');
const storageAdapter = {
  readdirSync: (p: string, opts: { withFileTypes: true }) => fs.readdirSync(p, opts),
  readFileSync: (p: string, enc: 'utf-8') => fs.readFileSync(p, enc),
};

describe('rebuildProjections equivalence (§3.5 replay identity)', () => {
  it('1000-event sequence produces byte-identical projection after rebuild', () => {
    const db = new Database(':memory:');
    try {
      applyMigrations({ db, storage: storageAdapter as never, migrationsDir: MIGRATIONS_DIR });
      applyTestCounterMigration(db);
      const reducers = composeReducers(testCounterRegistry);
      const upcasters = createEmptyRegistry();

      const ids = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
      const inputs = Array.from({ length: 1000 }, (_, i) => ({
        type: 'test.counter.ticked' as const,
        stream: { kind: 'job' as const, id: `stream-${i % 3}` },
        bodyVersion: 1,
        body: { id: ids[i % ids.length]!, delta: (i % 7) + 1 },
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
      expect(afterRebuild).toEqual(beforeRebuild);
    } finally {
      db.close();
    }
  });

  it('does NOT touch projection_kb (Corpus authority)', () => {
    const db = new Database(':memory:');
    try {
      applyMigrations({ db, storage: storageAdapter as never, migrationsDir: MIGRATIONS_DIR });
      const reducers = composeReducers();
      const upcasters = createEmptyRegistry();

      db.prepare(
        `INSERT INTO projection_kb (entry_id, title, content, frontmatter, content_seq) VALUES (?, ?, ?, ?, ?)`,
      ).run('kb-1', 'Title', 'Content', '{}', 1);

      rebuildProjections({ db, cutoffSeq: 0, reducers, upcasters });

      const kbCount = db.prepare('SELECT COUNT(*) AS n FROM projection_kb').get() as { n: number };
      expect(kbCount.n).toBe(1);
    } finally {
      db.close();
    }
  });
});
