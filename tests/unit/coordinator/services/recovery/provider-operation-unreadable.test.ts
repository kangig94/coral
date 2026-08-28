import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createUnreadableProviderOperationRetryPlan,
  quarantineUnreadableProviderOperations,
  UNREADABLE_PROVIDER_OPERATION_BOUNDARY,
} from '#src/coordinator/services/recovery/index.js';
import { RecoveryQuarantineStore } from '#src/recovery/quarantine.js';
import { createRecoveryQuarantineRetryService, createRecoverySourceRegistry } from '#src/recovery/source-registry.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { applyBundledStoreSchema, type Database } from '#src/store/db.js';
import {
  attributeUnreadableProviderOperations,
  readProviderOperations,
} from '#src/store/provider-operation-journal.js';
import { PROVIDER_OPERATION_RECORD_VERSION } from '#src/store/provider-operation-record.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';

describe('unreadable provider operation recovery quarantine', () => {
  let db: Database;
  let quarantine: RecoveryQuarantineStore;

  beforeEach(() => {
    db = newRawDatabase(':memory:');
    applyBundledStoreSchema(db, currentCoralStoreFormat());
    quarantine = new RecoveryQuarantineStore(db, { now: () => 1_700_000_000_000 });
  });

  afterEach(() => db.close());

  it('lists the raw row by key and revision until a clear retry observes it repaired', async () => {
    const key = `provider_operation_saga.v${PROVIDER_OPERATION_RECORD_VERSION}:record:${[
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ].join(':')}`;
    db.prepare<[string, string]>('INSERT INTO meta (key, value) VALUES (?, ?)').run(key, 'not-json');
    const scan = readProviderOperations(db);
    await quarantineUnreadableProviderOperations(
      quarantine,
      attributeUnreadableProviderOperations(db, scan.unreadableKeys),
    );

    const entry = quarantine.list()[0];
    expect(entry).toEqual(
      expect.objectContaining({
        boundary: UNREADABLE_PROVIDER_OPERATION_BOUNDARY,
        subject: {
          key,
          revision: { kind: 'fingerprint', value: expect.stringMatching(/^sha256:/u) },
        },
        state: 'active',
      }),
    );
    if (entry === undefined || entry.subject.revision.kind !== 'fingerprint') {
      throw new Error('expected unreadable provider operation quarantine entry');
    }

    const sources = createRecoverySourceRegistry();
    sources.register(UNREADABLE_PROVIDER_OPERATION_BOUNDARY, (subject) =>
      createUnreadableProviderOperationRetryPlan(db, subject),
    );
    const retry = createRecoveryQuarantineRetryService({
      instanceId: 'coordinator-1',
      ids: { uuid: () => randomUUID() },
      quarantine,
      sources,
    });
    const request = {
      boundary: UNREADABLE_PROVIDER_OPERATION_BOUNDARY,
      key,
      revision: entry.subject.revision.value,
    };

    await expect(retry.clear(request)).resolves.toEqual({ ...request, disposition: 'quarantined' });
    db.prepare<[string]>('DELETE FROM meta WHERE key = ?').run(key);
    await expect(retry.clear(request)).resolves.toEqual({ ...request, disposition: 'advanced' });
    expect(quarantine.list()).toEqual([]);
  });
});
