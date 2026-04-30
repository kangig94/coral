import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { SimulationRuntime } from '#tools/simulation/core/backend.js';
import { applyStoreSchemas } from '#src/store/schema-loader.js';

describe('applyStoreSchemas with Runtime.storage', () => {
  it('reads SQL schema files from a storage port and ignores non-sql entries', () => {
    const runtime = new SimulationRuntime();
    const schemasDir = '/tmp/sim/schemas';
    const db = new Database(':memory:');

    runtime.storage.mkdirSync(join(schemasDir, 'nested'), { recursive: true });
    runtime.storage.writeFileSync(
      join(schemasDir, '001_initial.sql'),
      [
        'CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);',
        "INSERT INTO meta(key, value) VALUES ('schema_version', '1');",
        'CREATE TABLE widgets (id INTEGER PRIMARY KEY, name TEXT NOT NULL);',
      ].join('\n'),
    );
    runtime.storage.writeFileSync(join(schemasDir, 'notes.txt'), 'ignore me');

    try {
      applyStoreSchemas({ db, storage: runtime.storage, schemasDir });

      expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: '1' });
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'widgets'").get()).toEqual({
        name: 'widgets',
      });
    } finally {
      db.close();
    }
  });
});
