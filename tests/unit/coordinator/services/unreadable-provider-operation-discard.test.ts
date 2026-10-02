import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createUnreadableProviderOperationDiscardService } from '#src/coordinator/services/recovery/unreadable-provider-operation-discard.js';
import { UNREADABLE_PROVIDER_OPERATION_BOUNDARY } from '#src/recovery/source-registry.js';
import { unreadableProviderOperationSubject } from '#src/recovery/unreadable-provider-operation.js';
import { RecoveryQuarantineStore } from '#src/recovery/quarantine.js';
import { applyBundledStoreSchema, type Database } from '#src/store/db.js';
import { observeProviderOperationRecord } from '#src/store/provider-operation-journal.js';
import { PROVIDER_OPERATION_RECORD_VERSION } from '#src/store/provider-operation-record.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';

const NOW = Date.parse('2026-08-29T00:00:00.000Z');

describe('unreadable provider-operation discard ownership', () => {
  let db: Database;
  let quarantine: RecoveryQuarantineStore;

  beforeEach(() => {
    db = newRawDatabase(':memory:');
    applyBundledStoreSchema(db, currentCoralStoreFormat());
    quarantine = new RecoveryQuarantineStore(db, { now: () => NOW });
  });

  afterEach(() => db.close());

  function seedRaw() {
    const record = providerOperationRecord('prepare-pending', { job: 91 });
    const key =
      `provider_operation_saga.v${PROVIDER_OPERATION_RECORD_VERSION}:record:` +
      `${record.operation.jobId}:${record.operation.operationId}:` +
      `${record.operation.proxyInstanceId}:${record.operation.buildSetId}`;
    const raw = '{"unsupportedVersion":99}';
    const dueKeys = [
      `provider_operation_saga.v${PROVIDER_OPERATION_RECORD_VERSION}:due:owned-current`,
      'provider_operation_saga.v1:due:owned-superseded',
    ];
    const insert = db.prepare<[string, string]>('INSERT INTO meta (key, value) VALUES (?, ?)');
    insert.run(key, raw);
    for (const dueKey of dueKeys) insert.run(dueKey, key);
    const observation = observeProviderOperationRecord(db, key);
    if (observation.kind !== 'unreadable') throw new Error(`expected unreadable row, got ${observation.kind}`);
    return { key, raw, dueKeys, record, revision: observation.attribution.revision };
  }

  function service(uuid: () => string = () => 'operator-discard-token') {
    return createUnreadableProviderOperationDiscardService({
      instanceId: 'operator-discard-test',
      ids: { uuid },
      db,
      time: { now: () => NOW },
    });
  }

  function persistActive(key: string, revision: string): void {
    quarantine.upsert({
      boundary: UNREADABLE_PROVIDER_OPERATION_BOUNDARY,
      subject: unreadableProviderOperationSubject(key, revision),
      state: 'active',
      stage: 'hydrate',
      errorMessage: 'unreadable row',
      detail: 'operator decision required',
    });
  }

  it('removes the raw row, due pointers, and exact quarantine under one claimed authority', () => {
    const seeded = seedRaw();
    persistActive(seeded.key, seeded.revision);

    expect(service().discard({ key: seeded.key, revision: seeded.revision })).toEqual({
      key: seeded.key,
      revision: seeded.revision,
      kind: 'discarded',
    });
    expect(observeProviderOperationRecord(db, seeded.key)).toEqual({ kind: 'absent' });
    expect(db.prepare<[string], { key: string }>('SELECT key FROM meta WHERE value = ?').all(seeded.key)).toEqual([]);
    expect(quarantine.read(UNREADABLE_PROVIDER_OPERATION_BOUNDARY, seeded.key)).toBeNull();
  });
});
