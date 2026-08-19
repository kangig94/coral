import { z } from 'zod';

import { prepareCached, type Database } from '../../store/db.js';
import { RECOVERY_COMPONENT_ID, type RuntimeComponent, type RuntimeComponentStatus } from './contract.js';

const recoveryQuarantineHealthRowSchema = z
  .object({
    count: z.number().int().nonnegative(),
    last_error: z.string(),
  })
  .strict();

function readRecoveryStatus(db: Database): RuntimeComponentStatus {
  const row = recoveryQuarantineHealthRowSchema.parse(
    prepareCached<[], unknown>(
      db,
      `SELECT
         COUNT(*) AS count,
         COALESCE((
           SELECT error_message
           FROM recovery_quarantine
           ORDER BY updated_at DESC, boundary_id ASC, subject_key ASC
           LIMIT 1
         ), '') AS last_error
       FROM recovery_quarantine`,
    ).get(),
  );

  if (row.count === 0) {
    return { id: RECOVERY_COMPONENT_ID, phase: 'online' };
  }
  return {
    id: RECOVERY_COMPONENT_ID,
    phase: 'degraded',
    reason: {
      kind: 'recovery-quarantine',
      count: row.count,
      lastError: row.last_error,
    },
  };
}

export function createRecoveryComponent(db: Database): RuntimeComponent {
  return {
    id: RECOVERY_COMPONENT_ID,
    get status() {
      return readRecoveryStatus(db);
    },
    async init() {},
    async dispose() {},
  };
}
