import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createUnreadableProviderOperationDiscardService } from '#src/coordinator/services/recovery/unreadable-provider-operation-discard.js';
import { sha256Hex } from '#src/infra/hash.js';
import { UNREADABLE_PROVIDER_OPERATION_BOUNDARY } from '#src/recovery/source-registry.js';
import { unreadableProviderOperationSubject } from '#src/recovery/unreadable-provider-operation.js';
import { RecoveryQuarantineStore } from '#src/recovery/quarantine.js';
import { applyBundledStoreSchema, type Database } from '#src/store/db.js';
import { insertProviderOperation, observeProviderOperationRecord } from '#src/store/provider-operation-journal.js';
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

  it.each(['retrying', 'continuation'] as const)(
    'refuses while a %s recovery owner holds the exact subject and changes no evidence',
    (state) => {
      const seeded = seedRaw();
      const subject = unreadableProviderOperationSubject(seeded.key, seeded.revision);
      persistActive(seeded.key, seeded.revision);
      if (state === 'retrying') {
        quarantine.claimRetry({
          boundary: UNREADABLE_PROVIDER_OPERATION_BOUNDARY,
          subject,
          retry: { owner: 'recovery-owner', token: 'recovery-token' },
        });
      } else {
        quarantine.upsert({
          boundary: UNREADABLE_PROVIDER_OPERATION_BOUNDARY,
          subject,
          state: 'continuation',
          stage: 'settle',
          continuation: { kind: 'provider-retry', key: 'continuation-key' },
          errorMessage: 'partial progress',
          detail: 'continuation owns recovery',
        });
      }
      const before = quarantine.read(UNREADABLE_PROVIDER_OPERATION_BOUNDARY, seeded.key);

      expect(service().discard({ key: seeded.key, revision: seeded.revision })).toEqual({
        key: seeded.key,
        revision: seeded.revision,
        kind: 'owned',
        state,
      });
      expect(
        db.prepare<[string], { value: string }>('SELECT value FROM meta WHERE key = ?').get(seeded.key)?.value,
      ).toBe(seeded.raw);
      expect(
        db.prepare<[string], { key: string }>('SELECT key FROM meta WHERE value = ?').all(seeded.key),
      ).toHaveLength(seeded.dueKeys.length);
      expect(quarantine.read(UNREADABLE_PROVIDER_OPERATION_BOUNDARY, seeded.key)).toEqual(before);
    },
  );

  it('refuses without persisted exact quarantine authority and leaves the raw row untouched', () => {
    const seeded = seedRaw();

    expect(service().discard({ key: seeded.key, revision: seeded.revision })).toEqual({
      key: seeded.key,
      revision: seeded.revision,
      kind: 'quarantine-not-found',
    });
    expect(db.prepare<[string], { value: string }>('SELECT value FROM meta WHERE key = ?').get(seeded.key)?.value).toBe(
      seeded.raw,
    );
  });

  it('releases its temporary claim when the raw revision no longer matches', () => {
    const seeded = seedRaw();
    persistActive(seeded.key, seeded.revision);
    db.prepare<[string, string]>('UPDATE meta SET value = ? WHERE key = ?').run(
      '{"unsupportedVersion":100}',
      seeded.key,
    );
    const changed = observeProviderOperationRecord(db, seeded.key);
    if (changed.kind !== 'unreadable') throw new Error(`expected unreadable row, got ${changed.kind}`);

    expect(service().discard({ key: seeded.key, revision: seeded.revision })).toEqual({
      key: seeded.key,
      revision: seeded.revision,
      kind: 'revision-mismatch',
      currentRevision: changed.attribution.revision,
    });
    expect(quarantine.read(UNREADABLE_PROVIDER_OPERATION_BOUNDARY, seeded.key)).toEqual({
      boundary: UNREADABLE_PROVIDER_OPERATION_BOUNDARY,
      subject: expect.objectContaining({
        key: seeded.key,
        revision: unreadableProviderOperationSubject(seeded.key, seeded.revision).revision,
      }),
      state: 'active',
    });
  });

  it('reports the persisted quarantine fingerprint before claiming a still-matching raw row', () => {
    const seeded = seedRaw();
    const quarantineRevision = `sha256:${'b'.repeat(64)}`;
    persistActive(seeded.key, quarantineRevision);
    const before = quarantine.read(UNREADABLE_PROVIDER_OPERATION_BOUNDARY, seeded.key);
    const uuid = vi.fn(() => 'operator-discard-token');

    expect(service(uuid).discard({ key: seeded.key, revision: seeded.revision })).toEqual({
      key: seeded.key,
      revision: seeded.revision,
      kind: 'revision-mismatch',
      currentRevision: quarantineRevision,
    });
    expect(db.prepare<[string], { value: string }>('SELECT value FROM meta WHERE key = ?').get(seeded.key)?.value).toBe(
      seeded.raw,
    );
    expect(db.prepare<[string], { key: string }>('SELECT key FROM meta WHERE value = ?').all(seeded.key)).toHaveLength(
      seeded.dueKeys.length,
    );
    expect(quarantine.read(UNREADABLE_PROVIDER_OPERATION_BOUNDARY, seeded.key)).toEqual(before);
    expect(uuid).not.toHaveBeenCalled();
  });

  it.each(['absent', 'readable'] as const)('releases its temporary claim when the raw row is %s', (kind) => {
    const seeded = seedRaw();
    persistActive(seeded.key, seeded.revision);
    db.prepare<[string]>('DELETE FROM meta WHERE key = ?').run(seeded.key);
    let requestRevision = seeded.revision;
    if (kind === 'readable') {
      insertProviderOperation(db, seeded.record);
      const raw = db
        .prepare<[string], { value: string }>('SELECT value FROM meta WHERE key = ?')
        .get(seeded.key)?.value;
      if (raw === undefined) throw new Error('expected readable row');
      requestRevision = `sha256:${sha256Hex(raw)}`;
      persistActive(seeded.key, requestRevision);
    }

    expect(service().discard({ key: seeded.key, revision: requestRevision })).toEqual({
      key: seeded.key,
      revision: requestRevision,
      kind,
    });
    expect(quarantine.read(UNREADABLE_PROVIDER_OPERATION_BOUNDARY, seeded.key)).toEqual({
      boundary: UNREADABLE_PROVIDER_OPERATION_BOUNDARY,
      subject: expect.objectContaining({
        key: seeded.key,
        revision: unreadableProviderOperationSubject(seeded.key, requestRevision).revision,
      }),
      state: 'active',
    });
  });
});
