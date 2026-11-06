import { z } from 'zod';

import { persistedProcessIncarnationSchema } from '../infra/persisted-scalar-contracts.js';
import type { RecordedProcessIdentity } from '../infra/process-containment.js';
import type { SqliteDatabasePort } from '../infra/port-types.js';
import type { Database } from '../store/db.js';

const durableCliExecutionSchema = z
  .object({
    jobId: z.string().min(1),
    execution: z.number().int().positive().safe(),
    pid: z.number().int().positive().safe(),
    incarnation: persistedProcessIncarnationSchema,
    phase: z.enum(['planned', 'entered']).default('planned'),
  })
  .strict()
  .readonly();

type DurableCliExecution = z.infer<typeof durableCliExecutionSchema>;

function executionIdentityKey(jobId: string, identity: RecordedProcessIdentity): string {
  return `durable_cli_execution.v1:${JSON.stringify([jobId, identity.pid, identity.incarnation])}`;
}

/** A process incarnation may never be reassociated with another execution. */
export function recordDurableCliExecution(db: Database, record: Omit<DurableCliExecution, 'phase'>): void {
  const parsed = durableCliExecutionSchema.parse({ ...record, phase: 'planned' });
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING').run(
    executionIdentityKey(parsed.jobId, parsed),
    JSON.stringify(parsed),
  );
  if (readDurableCliExecution(db, parsed.jobId, parsed) !== parsed.execution)
    throw new Error('Durable CLI process execution association conflicts with its existing record.');
}

export function readDurableCliExecution(
  db: Database | SqliteDatabasePort,
  jobId: string,
  identity: RecordedProcessIdentity,
): number | null {
  return readDurableCliExecutionReceipt(db, jobId, identity)?.execution ?? null;
}

export function markDurableCliExecutionEntered(db: Database, record: Omit<DurableCliExecution, 'phase'>): void {
  const receipt = readDurableCliExecutionReceipt(db, record.jobId, record);
  if (receipt === null || receipt.execution !== record.execution)
    throw new Error('Durable CLI entry requires its planned execution receipt.');
  db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(
    JSON.stringify({ ...receipt, phase: 'entered' }),
    executionIdentityKey(record.jobId, record),
  );
  const entered = readDurableCliExecutionReceipt(db, record.jobId, record);
  if (entered?.execution !== record.execution || entered.phase !== 'entered')
    throw new Error('Durable CLI entry publication was not persisted.');
}

export function readDurableCliExecutionReceipt(
  db: Database | SqliteDatabasePort,
  jobId: string,
  identity: RecordedProcessIdentity,
): DurableCliExecution | null {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(executionIdentityKey(jobId, identity)) as
    | { value: string }
    | undefined;
  if (row === undefined) return null;
  const record = durableCliExecutionSchema.parse(JSON.parse(row.value));
  if (record.jobId !== jobId || record.pid !== identity.pid || record.incarnation !== identity.incarnation)
    throw new Error('Durable CLI process execution association does not match its address.');
  return record;
}
