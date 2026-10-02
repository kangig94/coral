import { currentCoralStoreFormat } from '#src/store-format.js';
import { newRawDatabase, totalChanges } from '#tests/helpers/test-db.js';
import { describe, expect, it } from 'vitest';

import { applyBundledStoreSchema } from '#src/store/db.js';

describe('store schema idempotency', () => {
  it('second run performs zero write activity', () => {
    const db = newRawDatabase(':memory:');

    try {
      applyBundledStoreSchema(db, currentCoralStoreFormat());
      const firstChanges = totalChanges(db);
      const firstFingerprint = db
        .prepare<[], { value: string }>("SELECT value FROM meta WHERE key = 'store_format_fingerprint'")
        .get()?.value;

      applyBundledStoreSchema(db, currentCoralStoreFormat());
      const secondChanges = totalChanges(db);
      const secondFingerprint = db
        .prepare<[], { value: string }>("SELECT value FROM meta WHERE key = 'store_format_fingerprint'")
        .get()?.value;

      expect(secondChanges).toBe(firstChanges);
      expect(secondFingerprint).toBe(firstFingerprint);
    } finally {
      db.close();
    }
  });
});
