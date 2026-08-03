import type { Database } from '../store/db.js';
import type { EventsRow } from '../store/schema.js';
import type { RecoveryRevisionField, RecoveryRevisionValue } from './containment.js';

export const EVENT_COLUMNS =
  'seq, ts, type, stream_kind, stream_id, namespace, project, correlation_id, causation_seq, refs, body';

export const PROJECTION_SESSION_COLUMNS =
  'session_id, controller, resumable, conversation_ref, scope_key, entry, last_seq';

type ProjectionJobRevisionRow = {
  readonly job_id: string;
  readonly execution_owner: RecoveryRevisionValue;
  readonly phase: RecoveryRevisionValue;
  readonly terminal: RecoveryRevisionValue;
  readonly diagnostics: RecoveryRevisionValue;
  readonly session_id: RecoveryRevisionValue;
  readonly provider: RecoveryRevisionValue;
  readonly project_root: RecoveryRevisionValue;
  readonly backend_namespace: RecoveryRevisionValue;
  readonly bundle_hash: RecoveryRevisionValue;
  readonly job_kind: RecoveryRevisionValue;
  readonly parent_workflow_job_id: RecoveryRevisionValue;
  readonly workflow_slot: RecoveryRevisionValue;
  readonly workflow_slot_generation: RecoveryRevisionValue;
  readonly replaces_workflow_job_id: RecoveryRevisionValue;
  readonly created_at: RecoveryRevisionValue;
  readonly last_seq: RecoveryRevisionValue;
};

type ProjectionSessionRevisionRow = {
  readonly session_id: string;
  readonly controller: RecoveryRevisionValue;
  readonly resumable: RecoveryRevisionValue;
  readonly conversation_ref: RecoveryRevisionValue;
  readonly scope_key: RecoveryRevisionValue;
  readonly entry: RecoveryRevisionValue;
  readonly last_seq: RecoveryRevisionValue;
};

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
  const key = row.job_id;
  return [
    { table: 'projection_jobs', key, field: 'job_id', value: row.job_id },
    { table: 'projection_jobs', key, field: 'execution_owner', value: row.execution_owner },
    { table: 'projection_jobs', key, field: 'phase', value: row.phase },
    { table: 'projection_jobs', key, field: 'terminal', value: row.terminal },
    { table: 'projection_jobs', key, field: 'diagnostics', value: row.diagnostics },
    { table: 'projection_jobs', key, field: 'session_id', value: row.session_id },
    { table: 'projection_jobs', key, field: 'provider', value: row.provider },
    { table: 'projection_jobs', key, field: 'project_root', value: row.project_root },
    { table: 'projection_jobs', key, field: 'backend_namespace', value: row.backend_namespace },
    { table: 'projection_jobs', key, field: 'bundle_hash', value: row.bundle_hash },
    { table: 'projection_jobs', key, field: 'job_kind', value: row.job_kind },
    { table: 'projection_jobs', key, field: 'parent_workflow_job_id', value: row.parent_workflow_job_id },
    { table: 'projection_jobs', key, field: 'workflow_slot', value: row.workflow_slot },
    {
      table: 'projection_jobs',
      key,
      field: 'workflow_slot_generation',
      value: row.workflow_slot_generation,
    },
    { table: 'projection_jobs', key, field: 'replaces_workflow_job_id', value: row.replaces_workflow_job_id },
    { table: 'projection_jobs', key, field: 'created_at', value: row.created_at },
    { table: 'projection_jobs', key, field: 'last_seq', value: row.last_seq },
  ];
}

export function projectionSessionRevisionFields(row: ProjectionSessionRevisionRow): RecoveryRevisionField[] {
  const key = row.session_id;
  return [
    { table: 'projection_sessions', key, field: 'session_id', value: row.session_id },
    { table: 'projection_sessions', key, field: 'controller', value: row.controller },
    { table: 'projection_sessions', key, field: 'resumable', value: row.resumable },
    { table: 'projection_sessions', key, field: 'conversation_ref', value: row.conversation_ref },
    { table: 'projection_sessions', key, field: 'scope_key', value: row.scope_key },
    { table: 'projection_sessions', key, field: 'entry', value: row.entry },
    { table: 'projection_sessions', key, field: 'last_seq', value: row.last_seq },
  ];
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
