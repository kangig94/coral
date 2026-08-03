import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RECOVERY_COMPONENT_ID } from '#src/coordinator/runtime-components/contract.js';
import { createRecoveryComponent } from '#src/coordinator/runtime-components/recovery-component.js';
import { RecoveryQuarantineStore } from '#src/recovery/quarantine.js';
import { currentCoralStoreFormat } from '#src/store-format.js';
import { applyBundledStoreSchema, type Database } from '#src/store/db.js';
import { newRawDatabase } from '#tests/helpers/test-db.js';

const TEST_TIME = { now: () => Date.parse('2026-08-03T00:00:00.000Z') };

describe('createRecoveryComponent', () => {
  let db: Database;
  let quarantine: RecoveryQuarantineStore;

  beforeEach(() => {
    db = newRawDatabase(':memory:');
    applyBundledStoreSchema(db, currentCoralStoreFormat());
    quarantine = new RecoveryQuarantineStore(db, TEST_TIME);
  });

  afterEach(() => {
    db.close();
  });

  it('should report online when no unresolved recovery rows exist', () => {
    expect(createRecoveryComponent(db).status).toEqual({
      id: RECOVERY_COMPONENT_ID,
      phase: 'online',
    });
  });

  it('should report the unresolved count and latest retained error when degraded', () => {
    quarantine.upsert({
      boundary: 'workflow-recovery',
      subject: { key: 'workflow-1', revision: { kind: 'fingerprint', value: 'revision-1' } },
      state: 'active',
      stage: 'hydrate',
      errorMessage: 'older recovery error',
      detail: 'retained workflow',
    });
    quarantine.upsert({
      boundary: 'discussion-recovery',
      subject: { key: 'discussion-1', revision: { kind: 'until-cleared' } },
      state: 'continuation',
      stage: 'settle',
      continuation: { kind: 'discussion-resume.v1', key: 'resume-1' },
      errorMessage: 'latest recovery error',
      detail: 'resume discussion',
    });
    db.prepare(
      `UPDATE recovery_quarantine
       SET updated_at = CASE boundary_id
         WHEN 'workflow-recovery' THEN '2026-08-03T00:00:00.000Z'
         ELSE '2026-08-03T00:01:00.000Z'
       END`,
    ).run();

    expect(createRecoveryComponent(db).status).toEqual({
      id: RECOVERY_COMPONENT_ID,
      phase: 'degraded',
      reason: {
        kind: 'recovery-quarantine',
        count: 2,
        lastError: 'latest recovery error',
      },
    });
  });
});
