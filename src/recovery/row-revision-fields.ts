import type { Database } from '../store/db.js';
import type { EventsRow } from '../store/schema.js';
import type { RecoveryRevisionField, RecoveryRevisionValue } from './containment.js';

export const EVENT_COLUMNS =
  'seq, ts, type, stream_kind, stream_id, namespace, project, correlation_id, causation_seq, refs, body';

type ProjectionJobRevisionRow = import('../jobs/projection-row.js').ProjectionJobStoredRow;

type ContinuationRevisionRow = {
  readonly continuation_kind: RecoveryRevisionValue;
  readonly continuation_key: RecoveryRevisionValue;
};

export function withConsistentRead<T>(db: Database, read: () => T): T {
  db.exec('BEGIN DEFERRED');
  try {
    const value = read();
    db.exec('COMMIT');
    return value;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function eventRevisionFields(row: EventsRow): RecoveryRevisionField[] {
  const key = String(row.seq);
  return [
    { table: 'events', key, field: 'seq', value: row.seq },
    { table: 'events', key, field: 'ts', value: row.ts },
    { table: 'events', key, field: 'type', value: row.type },
    { table: 'events', key, field: 'stream_kind', value: row.stream_kind },
    { table: 'events', key, field: 'stream_id', value: row.stream_id },
    { table: 'events', key, field: 'namespace', value: row.namespace },
    { table: 'events', key, field: 'project', value: row.project },
    { table: 'events', key, field: 'correlation_id', value: row.correlation_id },
    { table: 'events', key, field: 'causation_seq', value: row.causation_seq },
    { table: 'events', key, field: 'refs', value: row.refs },
    { table: 'events', key, field: 'body', value: row.body },
  ];
}

export function projectionJobRevisionFields(row: ProjectionJobRevisionRow): RecoveryRevisionField[] {
  return Object.entries(row).map(([field, value]) => ({ table: 'projection_jobs', key: row.job_id, field, value }));
}

export function continuationRevisionFields(
  boundary: string,
  subjectKey: string,
  continuation: ContinuationRevisionRow | null,
): RecoveryRevisionField[] {
  const key = `${boundary}:${subjectKey}`;
  return [
    {
      table: 'recovery_quarantine',
      key,
      field: 'continuation_kind',
      value: continuation?.continuation_kind ?? null,
    },
    {
      table: 'recovery_quarantine',
      key,
      field: 'continuation_key',
      value: continuation?.continuation_key ?? null,
    },
  ];
}
