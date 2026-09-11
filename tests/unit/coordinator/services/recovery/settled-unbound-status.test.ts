import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createSettledUnboundStatusPort,
  MAX_SETTLED_UNBOUND_STATUS_ENTRIES,
} from '#src/coordinator/services/recovery/settled-unbound-status.js';
import { RecoveryQuarantineStore } from '#src/recovery/quarantine.js';
import { SETTLED_UNBOUND_STATUS_BOUNDARY } from '#src/recovery/source-registry.js';
import { formatRecoveryQuarantineList } from '#src/cli/format/backend.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { applyBundledStoreSchema, type Database } from '#src/store/db.js';
import { insertProviderOperation } from '#src/store/provider-operation-journal.js';
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

    const recorded = status.record(record.operation);
    if (recorded.kind !== 'recorded') throw new Error('expected durable status ownership');
    expect(quarantine.list()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          boundary: SETTLED_UNBOUND_STATUS_BOUNDARY,
          subject: expect.objectContaining({
            revision: { kind: 'fingerprint', value: expect.stringMatching(/^sha256:/u) },
          }),
          errorMessage: expect.stringContaining(
            `job '${record.operation.jobId}' operation '${record.operation.operationId}'`,
          ),
          detail: expect.stringContaining('command=coral-cli backend recovery-quarantine list'),
        }),
      ]),
    );
    const rendered = formatRecoveryQuarantineList(quarantine.list());
    expect(rendered).toContain(SETTLED_UNBOUND_STATUS_BOUNDARY);

    const [subject] = recorded.ownership.subjects;
    if (subject === undefined) throw new Error('expected durable status subject');
    const restartedStatus = createSettledUnboundStatusPort(() => db, { now: () => 200 });
    const rebound = restartedStatus.rebind(subject);
    if (rebound === null) throw new Error('expected ownership reconstructed from the durable coordinate');
    expect(restartedStatus.clear(record.operation, rebound)).toBe(true);
    expect(quarantine.list()).toEqual([]);
  });

  it('persists identity-keyed status when the provider-operation journal scan fails', () => {
    db.exec('DROP TABLE meta');
    const identity = { jobId: randomUUID(), operationId: randomUUID() };
    const status = createSettledUnboundStatusPort(() => db, { now: () => 100 });

    const recorded = status.record(identity);
    expect(recorded).toMatchObject({ kind: 'recorded' });
    expect(quarantine.list()).toEqual([
      expect.objectContaining({
        boundary: SETTLED_UNBOUND_STATUS_BOUNDARY,
        state: 'active',
        errorMessage: expect.stringContaining(`job '${identity.jobId}' operation '${identity.operationId}'`),
        detail: expect.stringContaining('journal scan failed'),
      }),
    ]);
  });

  it('clears only the exact typed status and preserves foreign matching prose', () => {
    const record = providerOperationRecord('settlement-pending');
    insertProviderOperation(db, record);
    const status = createSettledUnboundStatusPort(() => db, { now: () => 100 });
    const recorded = status.record(record.operation);
    if (recorded.kind !== 'recorded') throw new Error('expected durable status ownership');
    const [owned] = quarantine.list();
    if (owned === undefined) throw new Error('expected durable status row');
    expect(
      quarantine.upsert({
        boundary: 'foreign-recovery-boundary',
        subject: { key: 'foreign-subject', revision: { kind: 'fingerprint', value: `sha256:${'f'.repeat(64)}` } },
        state: 'active',
        stage: 'settle',
        errorMessage: owned.errorMessage,
        detail: 'foreign evidence',
      }),
    ).toBe(true);

    expect(status.clear(record.operation, recorded.ownership)).toBe(true);
    expect(quarantine.list()).toEqual([
      expect.objectContaining({
        boundary: 'foreign-recovery-boundary',
        subject: expect.objectContaining({ key: 'foreign-subject' }),
        errorMessage: owned.errorMessage,
      }),
    ]);
  });

  it('refuses to clear an owned subject after its durable state changes', () => {
    const record = providerOperationRecord('settlement-pending');
    insertProviderOperation(db, record);
    const status = createSettledUnboundStatusPort(() => db, { now: () => 100 });
    const recorded = status.record(record.operation);
    if (recorded.kind !== 'recorded') throw new Error('expected durable status ownership');
    const [owned] = quarantine.list();
    if (owned === undefined) throw new Error('expected durable status row');
    expect(
      quarantine.upsert({
        boundary: owned.boundary,
        subject: owned.subject,
        state: 'continuation',
        stage: owned.stage,
        errorMessage: owned.errorMessage,
        detail: owned.detail,
        continuation: { kind: 'successor', key: 'changed-owner' },
      }),
    ).toBe(true);

    expect(status.clear(record.operation, recorded.ownership)).toBe(false);
    expect(quarantine.list()).toEqual([expect.objectContaining({ state: 'continuation' })]);
  });

  it('reports proven absence without creating durable status', () => {
    const status = createSettledUnboundStatusPort(() => db, { now: () => 100 });

    expect(status.record({ jobId: randomUUID(), operationId: randomUUID() })).toEqual({ kind: 'absent' });
    expect(quarantine.list()).toEqual([]);
  });

  it('refuses a new identity without exceeding the durable status capacity', () => {
    for (let index = 0; index < MAX_SETTLED_UNBOUND_STATUS_ENTRIES; index += 1) {
      expect(
        quarantine.upsert({
          boundary: SETTLED_UNBOUND_STATUS_BOUNDARY,
          subject: {
            key: `retained-${index}`,
            revision: { kind: 'fingerprint', value: `sha256:${index.toString(16).padStart(64, '0')}` },
          },
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
    expect(quarantine.list().filter((entry) => entry.boundary === SETTLED_UNBOUND_STATUS_BOUNDARY)).toHaveLength(
      MAX_SETTLED_UNBOUND_STATUS_ENTRIES,
    );
  });
});
