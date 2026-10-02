import { createRecoveryQuarantineRetryService } from '#src/recovery/source-registry.js';
import { createRecoverySourceRegistry } from '#src/recovery/source-registry.js';
import { UNREADABLE_PROVIDER_OPERATION_BOUNDARY } from '#src/recovery/source-registry.js';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createUnreadableProviderOperationRetryPlan } from '#src/coordinator/services/recovery/index.js';
import { quarantineUnreadableProviderOperations } from '#src/coordinator/services/recovery/retry-plans.js';
import { RecoveryQuarantineStore } from '#src/recovery/quarantine.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { applyBundledStoreSchema, type Database } from '#src/store/db.js';
import {
  attributeUnreadableProviderOperations,
  readProviderOperations,
} from '#src/store/provider-operation-journal.js';
import {
  PROVIDER_OPERATION_RECORD_VERSION,
  type ProviderOperationRecord,
} from '#src/store/provider-operation-record.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';

function recordKey(record: ProviderOperationRecord): string {
  return `provider_operation_saga.v${PROVIDER_OPERATION_RECORD_VERSION}:record:${[
    record.operation.jobId,
    record.operation.operationId,
    record.operation.proxyInstanceId,
    record.operation.buildSetId,
  ].join(':')}`;
}

describe('unreadable provider operation recovery quarantine', () => {
  let db: Database;
  let quarantine: RecoveryQuarantineStore;

  beforeEach(() => {
    db = newRawDatabase(':memory:');
    applyBundledStoreSchema(db, currentCoralStoreFormat());
    quarantine = new RecoveryQuarantineStore(db, { now: () => 1_700_000_000_000 });
  });

  afterEach(() => db.close());

  it('atomically moves retry ownership to the current raw fingerprint', async () => {
    const record = providerOperationRecord('executing');
    const key = recordKey(record);
    db.prepare<[string, string]>('INSERT INTO meta (key, value) VALUES (?, ?)').run(key, 'not-json-r1');
    const scan = readProviderOperations(db);
    await quarantineUnreadableProviderOperations(
      quarantine,
      attributeUnreadableProviderOperations(db, scan.unreadableKeys),
    );
    const original = quarantine.list()[0];
    if (original === undefined || original.subject.revision.kind !== 'fingerprint') {
      throw new Error('expected unreadable provider operation quarantine entry');
    }

    const sources = createRecoverySourceRegistry();
    sources.register(UNREADABLE_PROVIDER_OPERATION_BOUNDARY, (subject) =>
      createUnreadableProviderOperationRetryPlan(db, subject, () => {
        throw new Error('an unreadable row cannot be adopted');
      }),
    );
    const retry = createRecoveryQuarantineRetryService({
      instanceId: 'coordinator-1',
      ids: { uuid: () => randomUUID() },
      quarantine,
      sources,
    });
    const oldRequest = {
      boundary: UNREADABLE_PROVIDER_OPERATION_BOUNDARY,
      key,
      revision: original.subject.revision.value,
    };

    db.prepare<[string, string]>('UPDATE meta SET value = ? WHERE key = ?').run('not-json-r2', key);
    await expect(retry.clear(oldRequest)).resolves.toEqual({ ...oldRequest, disposition: 'quarantined' });

    const current = quarantine.list()[0];
    expect(current).toEqual(
      expect.objectContaining({
        boundary: UNREADABLE_PROVIDER_OPERATION_BOUNDARY,
        state: 'active',
        subject: { key, revision: { kind: 'fingerprint', value: expect.stringMatching(/^sha256:/u) } },
      }),
    );
    if (current === undefined || current.subject.revision.kind !== 'fingerprint') {
      throw new Error('expected moved unreadable provider operation quarantine entry');
    }
    expect(current.subject.revision.value).not.toBe(oldRequest.revision);
    await expect(retry.clear(oldRequest)).rejects.toMatchObject({ code: 'revision-mismatch' });
    const currentRequest = { ...oldRequest, revision: current.subject.revision.value };
    await expect(retry.clear(currentRequest)).resolves.toEqual({ ...currentRequest, disposition: 'quarantined' });
  });
});
