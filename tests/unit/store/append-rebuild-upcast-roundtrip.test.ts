import * as fs from 'node:fs';
import { join } from 'node:path';

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { commitInputs } from '#tests/helpers/commit-inputs.js';
import { decodeEventBody } from '#src/store/body-codec.js';
import { createDefaultUpcasterRegistry } from '#src/store/upcaster-registry.js';
import { applyStoreSchemas } from '#src/store/schema-loader.js';
import { composeReducers, defineDomainEvent } from '#src/store/reducers.js';
import { rebuildProjections } from '#tests/helpers/rebuild-projections.js';
import { permissiveProviderLookupPort } from '#tests/helpers/append-context.js';

const SCHEMAS_DIR = join(process.cwd(), 'src/store/schemas');
const storageAdapter = {
  readdirSync: (p: string, opts: { withFileTypes: true }) => fs.readdirSync(p, opts),
  readFileSync: (p: string, enc: 'utf-8') => fs.readFileSync(p, enc),
};

describe('append/rebuild upcaster round-trip', () => {
  it('append stores raw v1 bytes; rebuild upcasts to v2 for reducer', () => {
    const db = new Database(':memory:');
    try {
      applyStoreSchemas({ db, storage: storageAdapter as never, schemasDir: SCHEMAS_DIR });

      db.exec(`CREATE TABLE projection_test_upcasted (id TEXT PRIMARY KEY, count INTEGER NOT NULL)`);

      const V2_SCHEMA = z.object({ count: z.number().int() });
      const receivedBodies: { count: number }[] = [];

      const reducers = composeReducers({
        entries: [
          defineDomainEvent({
            type: 'test.upcasted',
            schema: V2_SCHEMA,
            reducer: (database, event) => {
              receivedBodies.push(event.body);
              database
                .prepare(
                  `INSERT INTO projection_test_upcasted (id, count) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET count=excluded.count`,
                )
                .run(event.stream.id, event.body.count);
            },
          }),
        ],
      });

      const upcasters = createDefaultUpcasterRegistry();
      upcasters.registerUpcaster('test.upcasted', 1, 2, (body) => {
        const v1 = body as { n: number };
        return { count: v1.n };
      });

      commitInputs(db, [{ type: 'test.upcasted', stream: { kind: 'job', id: 'x' }, bodyVersion: 1, body: { n: 7 } }], {
        now: () => new Date(0),
        reducers,
        upcasters,
        providers: permissiveProviderLookupPort,
      });

      const row = db.prepare('SELECT body_version, body FROM events WHERE seq = 1').get() as {
        body_version: number;
        body: Uint8Array | Buffer;
      };
      expect(row.body_version).toBe(1);
      const decoded = decodeEventBody(row.body);
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
