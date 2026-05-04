import { newRawDatabase } from '#tests/helpers/test-db.js';
import { describe, expect, it } from 'vitest';

import { applyBundledStoreSchema } from '#src/store/db.js';

describe('applyBundledStoreSchema', () => {
  it('applies the bundled store schema to a raw database', () => {
    const db = newRawDatabase(':memory:');

    try {
      applyBundledStoreSchema(db);

      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events'").get()).toEqual({
        name: 'events',
      });
      expect(db.prepare<[], { user_version: number }>('PRAGMA user_version').get()?.user_version).not.toBe(0);
    } finally {
      db.close();
    }
  });
});
