import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createSettledUnboundStatusPort,
  MAX_SETTLED_UNBOUND_STATUS_ENTRIES,
} from '#src/coordinator/services/recovery/settled-unbound-status.js';
import { RecoveryQuarantineStore } from '#src/recovery/quarantine.js';
import { UNREADABLE_PROVIDER_OPERATION_BOUNDARY } from '#src/recovery/source-registry.js';
import { unreadableProviderOperationSubject } from '#src/recovery/unreadable-provider-operation.js';
import { formatRecoveryQuarantineList } from '#src/cli/format/backend.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { applyBundledStoreSchema, type Database } from '#src/store/db.js';
import { insertProviderOperation, providerOperationRecordKeyPrefix } from '#src/store/provider-operation-journal.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';
import { providerOperationRecord } from '#tests/unit/store/provider-operation-fixtures.js';

describe('settled unbound status', () => {
  let db: Database;
  let quarantine: RecoveryQuarantineStore;

  beforeEach(() => {
    db = newRawDatabase(':memory:');
    applyBundledStoreSchema(db, currentCoralStoreFormat());
    quarantine = new RecoveryQuarantineStore(db, { now: () => 100 });
  });

  afterEach(() => {
    db.close();
  });

  it('persists an identity-matched exact row status until settlement clears it', () => {
    const record = providerOperationRecord('settlement-pending');
    insertProviderOperation(db, record);
    const status = createSettledUnboundStatusPort(() => db, { now: () => 100 });

    expect(status.record(record.operation)).toEqual({ kind: 'recorded' });
    expect(quarantine.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          boundary: UNREADABLE_PROVIDER_OPERATION_BOUNDARY,
          subject: expect.objectContaining({
            revision: { kind: 'fingerprint', value: expect.stringMatching(/^sha256:/u) },
          }),
          errorMessage: expect.stringContaining(
            `job '${record.operation.jobId}' operation '${record.operation.operationId}'`,
          ),
          detail: expect.stringContaining('--allow-readable'),
        }),
      ]),
    );
    const rendered = formatRecoveryQuarantineList(quarantine.list());
    expect(rendered).toContain('discard-provider-operation');
    expect(rendered).toContain('--allow-readable');

    expect(status.clear(record.operation)).toBe(true);
    expect(quarantine.list()).toEqual([]);
  });

  it('reports proven absence without creating durable status', () => {
    const status = createSettledUnboundStatusPort(() => db, { now: () => 100 });

    expect(status.record({ jobId: randomUUID(), operationId: randomUUID() })).toEqual({ kind: 'absent' });
    expect(quarantine.list()).toEqual([]);
  });

  it('refuses a new identity without exceeding the durable status capacity', () => {
    for (let index = 0; index < MAX_SETTLED_UNBOUND_STATUS_ENTRIES; index += 1) {
      const jobId = randomUUID();
      const key = `${providerOperationRecordKeyPrefix(jobId)}${randomUUID()}:` + `${randomUUID()}:${randomUUID()}`;
      expect(
        quarantine.upsert({
          boundary: UNREADABLE_PROVIDER_OPERATION_BOUNDARY,
          subject: unreadableProviderOperationSubject(key, `sha256:${'0'.repeat(64)}`),
          state: 'active',
          stage: 'settle',
          errorMessage: `Provider operation settlement journal probe remained unknown for retained-${index}.`,
          detail: 'retained for its named exit',
        }),
      ).toBe(true);
    }
    const overflow = providerOperationRecord('settlement-pending');
    insertProviderOperation(db, overflow);
    const status = createSettledUnboundStatusPort(() => db, { now: () => 100 });

    expect(status.record(overflow.operation)).toEqual({
      kind: 'refused',
      reason: 'The durable unsettled settlement status is at capacity.',
    });
    expect(
      quarantine
        .list()
        .filter(
          (entry) =>
            entry.boundary === UNREADABLE_PROVIDER_OPERATION_BOUNDARY &&
            entry.errorMessage.startsWith('Provider operation settlement journal probe remained unknown'),
        ),
    ).toHaveLength(MAX_SETTLED_UNBOUND_STATUS_ENTRIES);
  });
});
