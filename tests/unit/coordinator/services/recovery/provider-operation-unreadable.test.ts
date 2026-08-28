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
import {
  encodeProviderOperationRecord,
  PROVIDER_OPERATION_RECORD_VERSION,
  type ProviderOperationRecord,
} from '#src/store/provider-operation-record.js';
import { ProviderProxySetClaimMirror } from '#src/coordinator/services/provider-proxy-set/claim-mirror.js';
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

  it('adopts a repaired row before removing its quarantine', async () => {
    const repaired = providerOperationRecord('executing');
    const key = recordKey(repaired);
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
    const claims = new ProviderProxySetClaimMirror();
    claims.initialize([]);
    let acceptedBeforeRemoval = false;
    sources.register(UNREADABLE_PROVIDER_OPERATION_BOUNDARY, (subject) =>
      createUnreadableProviderOperationRetryPlan(db, subject, (record) => {
        claims.applyMutation({ kind: 'upserted', record });
        acceptedBeforeRemoval = claims.claimFor(record.operation) !== null && quarantine.list().length === 1;
        return acceptedBeforeRemoval
          ? { kind: 'accepted', owner: 'provider-proxy-claim-mirror' }
          : { kind: 'refused', reason: 'test claim mirror did not accept the repaired record' };
      }),
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
    db.prepare<[string, string]>('UPDATE meta SET value = ? WHERE key = ?').run(
      encodeProviderOperationRecord(repaired),
      key,
    );
    const dueRows = db
      .prepare<[string], { count: number }>('SELECT COUNT(*) AS count FROM meta WHERE key LIKE ?')
      .get(`provider_operation_saga.v${PROVIDER_OPERATION_RECORD_VERSION}:due:%`)?.count;
    expect(dueRows).toBe(0);
    await expect(retry.clear(request)).resolves.toEqual({ ...request, disposition: 'advanced' });
    expect(acceptedBeforeRemoval).toBe(true);
    expect(claims.claimFor(repaired.operation)).not.toBeNull();
    expect(quarantine.list()).toEqual([]);
  });

  it('advances an absent row without offering it for adoption', async () => {
    const record = providerOperationRecord('executing');
    const key = recordKey(record);
    db.prepare<[string, string]>('INSERT INTO meta (key, value) VALUES (?, ?)').run(key, 'not-json');
    const scan = readProviderOperations(db);
    await quarantineUnreadableProviderOperations(
      quarantine,
      attributeUnreadableProviderOperations(db, scan.unreadableKeys),
    );
    const entry = quarantine.list()[0];
    if (entry === undefined || entry.subject.revision.kind !== 'fingerprint') {
      throw new Error('expected unreadable provider operation quarantine entry');
    }

    let adoptionCalls = 0;
    const sources = createRecoverySourceRegistry();
    sources.register(UNREADABLE_PROVIDER_OPERATION_BOUNDARY, (subject) =>
      createUnreadableProviderOperationRetryPlan(db, subject, () => {
        adoptionCalls += 1;
        return { kind: 'refused', reason: 'an absent row cannot be adopted' };
      }),
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

    db.prepare<[string]>('DELETE FROM meta WHERE key = ?').run(key);
    await expect(retry.clear(request)).resolves.toEqual({ ...request, disposition: 'advanced' });
    expect(adoptionCalls).toBe(0);
    expect(quarantine.list()).toEqual([]);
  });

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
