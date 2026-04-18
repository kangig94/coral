import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { appendEvents } from '../append.js';
import { createEmptyRegistry } from '../envelope.js';
import { applyMigrations } from '../migrations.js';
import { composeReducers, type Reducer } from '../reducers.js';
import { rebuildProjections } from '../rebuild.js';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../migrations');
const storageAdapter = {
  readdirSync: (p: string, opts: { withFileTypes: true }) => fs.readdirSync(p, opts),
  readFileSync: (p: string, enc: 'utf-8') => fs.readFileSync(p, enc),
};

describe('append/rebuild upcaster round-trip (AC9 lock)', () => {
  it('append stores raw v1 bytes; rebuild upcasts to v2 for reducer', () => {
    const db = new Database(':memory:');
    try {
      applyMigrations({ db, storage: storageAdapter as never, migrationsDir: MIGRATIONS_DIR });

      db.exec(`CREATE TABLE projection_test_upcasted (id TEXT PRIMARY KEY, count INTEGER NOT NULL)`);

      const V2_SCHEMA = z.object({ count: z.number().int() });
      const receivedBodies: { count: number }[] = [];
      const reducer: Reducer<z.infer<typeof V2_SCHEMA>> = (database, event) => {
        receivedBodies.push(event.body);
        database
          .prepare(
            `INSERT INTO projection_test_upcasted (id, count) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET count=excluded.count`,
          )
          .run(event.stream.id, event.body.count);
      };

      const reducers = composeReducers({
        types: ['test.upcasted'],
        reducers: { 'test.upcasted': reducer as Reducer<unknown> },
        schemas: { 'test.upcasted': V2_SCHEMA },
      });

      const upcasters = createEmptyRegistry();
      upcasters.registerUpcaster('test.upcasted', 1, 2, (body) => {
        const v1 = body as { n: number };
        return { count: v1.n };
      });

      appendEvents(
        db,
        [{ type: 'test.upcasted', stream: { kind: 'job', id: 'x' }, bodyVersion: 1, body: { n: 7 } }],
        { now: () => new Date(0), reducers, upcasters },
      );

      const row = db.prepare('SELECT body_version, body FROM events WHERE seq = 1').get() as {
        body_version: number;
        body: Uint8Array | Buffer;
      };
      expect(row.body_version).toBe(1);
      const decoded = JSON.parse(new TextDecoder().decode(row.body));
      expect(decoded).toEqual({ n: 7 });

      expect(receivedBodies).toEqual([{ count: 7 }]);

      receivedBodies.length = 0;
      rebuildProjections({
        db,
        cutoffSeq: 1,
        reducers,
        upcasters,
        extraProjectionTables: ['projection_test_upcasted'],
      });

      expect(receivedBodies).toEqual([{ count: 7 }]);
      const kbRow = db.prepare('SELECT * FROM projection_test_upcasted WHERE id = ?').get('x');
      expect(kbRow).toEqual({ id: 'x', count: 7 });
    } finally {
      db.close();
    }
  });
});
