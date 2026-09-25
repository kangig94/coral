import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { currentCoralStoreFormat } from '../../../../../src/store-format.js';
import { reconcileStartupCustody } from '../../../../../src/coordinator/services/recovery/custody-reconciliation.js';
import { applyBundledStoreSchema } from '../../../../../src/store/db.js';
import { insertProviderOperation } from '../../../../../src/store/provider-operation-journal.js';
import { custodyLedgerDir, recordCustodyIntent } from '../../../../../src/store/custody-ledger.js';
import { newRawDatabase } from '../../../../helpers/test-db.js';
import { providerOperationRecord } from '../../../store/provider-operation-fixtures.js';

describe('startup custody reconciliation', () => {
  it('recovers publication after a crash between the database insert and identity binding', () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-custody-publication-'));
    const db = newRawDatabase(':memory:');
    applyBundledStoreSchema(db, currentCoralStoreFormat());
    const runDir = join(root, 'run');
    const record = providerOperationRecord('prepare-pending');
    try {
      const intent = recordCustodyIntent(runDir, {
        effect: 'provider-operation-publication',
        epoch: 'epoch-a',
        owner: 'provider-operation',
        operationId: record.operation.operationId,
        capsule: null,
        nowMs: 100,
        bindWithinMs: 1_000,
      });
      insertProviderOperation(db, record);
      writeFileSync(join(custodyLedgerDir(runDir), intent.id, 'binding.v1.json'), '{"pid":');
      expect(reconcileStartupCustody(runDir, 3_200, db, 'epoch-a')).toMatchObject([
        { kind: 'bound', binding: { process: null } },
      ]);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not prove an old epoch publication absent from the current epoch database', () => {
    const root = mkdtempSync(join(tmpdir(), 'coral-custody-epoch-'));
    const db = newRawDatabase(':memory:');
    applyBundledStoreSchema(db, currentCoralStoreFormat());
    const runDir = join(root, 'run');
    try {
      recordCustodyIntent(runDir, {
        effect: 'provider-operation-publication',
        epoch: 'epoch-old',
        owner: 'provider-operation',
        operationId: 'operation-old',
        capsule: null,
        nowMs: 100,
        bindWithinMs: 1_000,
      });
      expect(reconcileStartupCustody(runDir, 3_200, db, 'epoch-new')).toMatchObject([{ kind: 'holding' }]);
      expect(reconcileStartupCustody(runDir, 3_200, db, 'epoch-old')).toMatchObject([{ kind: 'absent' }]);
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
