import { UNREADABLE_PROVIDER_OPERATION_BOUNDARY } from '#src/recovery/source-registry.js';
import { randomUUID } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createUnreadableProviderOperationRetryPlan } from '#src/coordinator/services/recovery/index.js';
import { quarantineUnreadableProviderOperations } from '#src/coordinator/services/recovery/retry-plans.js';
import { RecoveryQuarantineStore } from '#src/recovery/quarantine.js';
import {
  unreadableProviderOperationSubject,
  type ProviderOperationAdoptionRemedy,
} from '#src/recovery/unreadable-provider-operation.js';
import type { RecoveryQuarantinePort } from '#src/recovery/containment.js';
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

  it('validates and freezes the exact durable row coordinate', () => {
    const subject = unreadableProviderOperationSubject('provider-operation-key', `sha256:${'a'.repeat(64)}`);

    expect(subject).toMatchObject({
      key: 'provider-operation-key',
      revision: { kind: 'fingerprint', value: `sha256:${'a'.repeat(64)}` },
    });
    expect(Object.isFrozen(subject)).toBe(true);
    expect(Object.isFrozen(subject.revision)).toBe(true);
    expect(() => unreadableProviderOperationSubject('', `sha256:${'a'.repeat(64)}`)).toThrow(
      'unreadable_provider_operation_key_invalid',
    );
    expect(() => unreadableProviderOperationSubject('provider-operation-key', 'not-a-fingerprint')).toThrow(
      'unreadable_provider_operation_revision_invalid',
    );
  });

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
    const acceptForDrive = vi.fn(async (record: ProviderOperationRecord) => {
      expect(record).toEqual(repaired);
      expect(quarantine.list()).toHaveLength(1);
    });
    sources.register(UNREADABLE_PROVIDER_OPERATION_BOUNDARY, (subject) =>
      createUnreadableProviderOperationRetryPlan(db, subject, async (record) => {
        await acceptForDrive(record);
        return { kind: 'accepted', owner: 'provider-operation-reconciler' };
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
    expect(acceptForDrive).toHaveBeenCalledExactlyOnceWith(repaired);
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

    const sources = createRecoverySourceRegistry();
    sources.register(UNREADABLE_PROVIDER_OPERATION_BOUNDARY, (subject) =>
      createUnreadableProviderOperationRetryPlan(db, subject, () => {
        throw new Error('an absent row cannot be adopted');
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
    expect(quarantine.list()).toEqual([]);
  });

  it.each([
    {
      remedy: { kind: 'restart-coordinator' } as const,
      advice: 'Restart the coordinator to initialize the repaired row at boot, then retry this coordinate.',
    },
    {
      remedy: { kind: 'remote-settlement' } as const,
      advice: 'Coral retries the remote settlement path automatically; re-check this coordinate after settlement.',
    },
    {
      remedy: { kind: 'recovery-quarantine-discard', allowReadable: false } as const,
      advice:
        'Run coral-cli backend recovery-quarantine list and use only the exact discard-provider-operation command it prints if losing that row is acceptable.',
    },
    {
      remedy: { kind: 'recovery-quarantine-discard', allowReadable: true } as const,
      advice:
        'Run coral-cli backend recovery-quarantine list and use only the exact discard-provider-operation command with --allow-readable it prints if losing that row is acceptable.',
    },
    {
      remedy: { kind: 'recovery-quarantine-clear' } as const,
      advice: 'Run coral-cli backend recovery-quarantine list and use its exact clear command.',
    },
    {
      remedy: { kind: 'external-repair' } as const,
      advice:
        'External repair of the reported provider-operation ownership path is required; no Coral command can repair it. Restart the coordinator after repair, then retry this coordinate.',
    },
  ] satisfies readonly Readonly<{ remedy: ProviderOperationAdoptionRemedy; advice: string }>[])(
    'retains $remedy.kind advice when adoption of a readable row is refused',
    async ({ remedy, advice }) => {
      const repaired = providerOperationRecord('executing');
      const key = recordKey(repaired);
      db.prepare<[string, string]>('INSERT INTO meta (key, value) VALUES (?, ?)').run(key, 'not-json');
      await quarantineUnreadableProviderOperations(
        quarantine,
        attributeUnreadableProviderOperations(db, readProviderOperations(db).unreadableKeys),
      );
      const entry = quarantine.list()[0];
      if (entry === undefined || entry.subject.revision.kind !== 'fingerprint') {
        throw new Error('expected unreadable provider operation quarantine entry');
      }
      db.prepare<[string, string]>('UPDATE meta SET value = ? WHERE key = ?').run(
        encodeProviderOperationRecord(repaired),
        key,
      );

      const sources = createRecoverySourceRegistry();
      sources.register(UNREADABLE_PROVIDER_OPERATION_BOUNDARY, (subject) =>
        createUnreadableProviderOperationRetryPlan(db, subject, () => ({
          kind: 'refused',
          reason: 'cause-specific diagnostic text',
          remedy,
        })),
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
      expect(quarantine.list()).toEqual([
        expect.objectContaining({
          state: 'active',
          detail: expect.stringContaining(advice),
        }),
      ]);
    },
  );

  it('reports only the unreadable keys whose quarantine status could not be materialized', async () => {
    const firstKey = recordKey(providerOperationRecord('executing'));
    const secondKey = `${firstKey}:failed`;
    db.prepare<[string, string]>('INSERT INTO meta (key, value) VALUES (?, ?)').run(firstKey, 'not-json-1');
    db.prepare<[string, string]>('INSERT INTO meta (key, value) VALUES (?, ?)').run(secondKey, 'not-json-2');
    const rows = attributeUnreadableProviderOperations(db, readProviderOperations(db).unreadableKeys);
    const materialization: RecoveryQuarantinePort = {
      read: () => null,
      upsert: (write) => {
        if (write.subject.key === secondKey) throw new Error('quarantine storage unavailable');
        return true;
      },
      delete: () => false,
    };

    const report = await quarantineUnreadableProviderOperations(materialization, rows);

    expect(report.materialized).toBe(1);
    expect(report.retained).toBe(0);
    expect(report.failed.map(({ key }) => key)).toEqual([secondKey]);
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
