import { currentCoralStoreFormat } from '#src/store-format.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { describe, expect, it } from 'vitest';

import { applyBundledStoreSchema } from '#src/store/db.js';

describe('applyBundledStoreSchema', () => {
  it('applies the bundled store schema to a raw database', () => {
    const db = newRawDatabase(':memory:');

    try {
      applyBundledStoreSchema(db, currentCoralStoreFormat());

      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'events'").get()).toEqual({
        name: 'events',
      });
      expect(
        db.prepare<[], { value: string }>("SELECT value FROM meta WHERE key = 'store_format_fingerprint'").get()?.value,
      ).toBe(currentCoralStoreFormat().fingerprint);
    } finally {
      db.close();
    }
  });
});
