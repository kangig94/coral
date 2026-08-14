import { PROJECTION_JOB_COLUMNS, type ProjectionJobStoredRow } from '../jobs/projection-row.js';
import type { Database } from '../store/db.js';
import type { EventsRow } from '../store/schema.js';
import {
  canonicalRecoveryRevision,
  defineRecoverySource,
  type RecoveryRevisionField,
  type RecoverySource,
  type RecoverySubject,
} from '../recovery/containment.js';
import {
  EVENT_COLUMNS,
  continuationRevisionFields,
  eventRevisionFields,
  projectionJobRevisionFields,
  projectionSessionRevisionFields,
  withConsistentRead,
} from '../recovery/row-revision-fields.js';
import type { RawSessionProjectionRow } from '../sessions/projection-recovery-source.js';
import type { RawWorkflowProjectionRow } from './read-queries.js';

const WORKFLOW_RECOVERY_BOUNDARY = 'workflow-recovery';

export type RawWorkflowRecoveryContinuationRow = {
  readonly subject_revision: string | null;
  readonly continuation_kind: string | null;
  readonly continuation_key: string | null;
};

export type RawWorkflowRecoveryJob = {
  readonly projection: ProjectionJobStoredRow;
  readonly events: readonly EventsRow[];
};

export type RawWorkflowRecoveryEnvelope = {
  readonly job: RawWorkflowRecoveryJob;
  readonly workflow: RawWorkflowProjectionRow | null;
  readonly workflowEvents: readonly EventsRow[];
  readonly children: readonly RawWorkflowRecoveryJob[];
  readonly providerSessions: readonly RawSessionProjectionRow[];
  readonly sessionEvents: readonly EventsRow[];
  readonly continuation: RawWorkflowRecoveryContinuationRow | null;
  readonly sourceRevision: Extract<RecoverySubject['revision'], { kind: 'fingerprint' }>;
  readonly subject: RecoverySubject;
};

function readStreamEvents(db: Database, streamKind: EventsRow['stream_kind'], streamId: string): EventsRow[] {
  return db
    .prepare<[EventsRow['stream_kind'], string], EventsRow>(
      `SELECT ${EVENT_COLUMNS}
         FROM events
        WHERE stream_kind = ?
          AND stream_id = ?
        ORDER BY seq ASC`,
    )
    .all(streamKind, streamId);
}

function readWorkflowJobEvents(db: Database, workflowId: string): EventsRow[] {
  return db
    .prepare<[string, string], EventsRow>(
      `SELECT events.*
         FROM events
        WHERE events.stream_kind = 'job'
          AND (
            events.stream_id = ?
            OR EXISTS (
              SELECT 1
                FROM projection_jobs
               WHERE projection_jobs.job_id = events.stream_id
                 AND projection_jobs.parent_workflow_job_id = ?
            )
          )
        ORDER BY events.seq ASC`,
    )
    .all(workflowId, workflowId);
}

function readWorkflowProviderSessions(db: Database, workflowId: string): RawSessionProjectionRow[] {
  return db
    .prepare<[string], RawSessionProjectionRow>(
      `SELECT projection_sessions.*
         FROM projection_sessions
        WHERE EXISTS (
          SELECT 1
            FROM projection_jobs
           WHERE projection_jobs.session_id = projection_sessions.session_id
             AND projection_jobs.parent_workflow_job_id = ?
        )
        ORDER BY projection_sessions.session_id ASC`,
    )
    .all(workflowId);
}

function readWorkflowSessionEvents(db: Database, workflowId: string): EventsRow[] {
  return db
    .prepare<[string], EventsRow>(
      `SELECT events.*
         FROM events
        WHERE events.stream_kind = 'session'
          AND EXISTS (
            SELECT 1
              FROM projection_jobs
             WHERE projection_jobs.session_id = events.stream_id
               AND projection_jobs.parent_workflow_job_id = ?
          )
        ORDER BY events.seq ASC`,
    )
    .all(workflowId);
}

function workflowRevisionFields(workflowId: string, row: RawWorkflowProjectionRow | null): RecoveryRevisionField[] {
  if (row === null) {
    return [{ table: 'projection_workflows', key: workflowId, field: '__absent__', value: null }];
  }
  return [
    { table: 'projection_workflows', key: workflowId, field: 'workflow_id', value: row.workflow_id },
    { table: 'projection_workflows', key: workflowId, field: 'plan', value: row.plan },
    { table: 'projection_workflows', key: workflowId, field: 'provider_scope', value: row.provider_scope },
    { table: 'projection_workflows', key: workflowId, field: 'lifecycle', value: row.lifecycle },
    { table: 'projection_workflows', key: workflowId, field: 'last_seq', value: row.last_seq },
  ];
}

function envelopeRevisionFields(raw: Omit<RawWorkflowRecoveryEnvelope, 'sourceRevision' | 'subject'>) {
  const workflowId = raw.job.projection.job_id;
  const fields = [
    ...projectionJobRevisionFields(raw.job.projection),
    ...workflowRevisionFields(workflowId, raw.workflow),
  ];
  for (const event of raw.job.events) fields.push(...eventRevisionFields(event));
  for (const event of raw.workflowEvents) fields.push(...eventRevisionFields(event));
  for (const child of raw.children) {
    fields.push(...projectionJobRevisionFields(child.projection));
    for (const event of child.events) fields.push(...eventRevisionFields(event));
  }
  for (const session of raw.providerSessions) fields.push(...projectionSessionRevisionFields(session));
  for (const event of raw.sessionEvents) fields.push(...eventRevisionFields(event));
  return fields;
}

function readWorkflowEnvelope(db: Database, projection: ProjectionJobStoredRow): RawWorkflowRecoveryEnvelope {
  const workflowId = projection.job_id;
  const workflow =
    db
      .prepare<[string], RawWorkflowProjectionRow>(
        `SELECT workflow_id, plan, provider_scope, lifecycle, last_seq
           FROM projection_workflows
          WHERE workflow_id = ?`,
      )
      .get(workflowId) ?? null;
  const childProjections = db
    .prepare<[string], ProjectionJobStoredRow>(
      `SELECT ${PROJECTION_JOB_COLUMNS}
         FROM projection_jobs
        WHERE parent_workflow_job_id = ?
        ORDER BY job_id ASC`,
    )
    .all(workflowId);
  const jobEvents = readWorkflowJobEvents(db, workflowId);
  const eventsByJob = new Map<string, EventsRow[]>();
  for (const event of jobEvents) {
    const rows = eventsByJob.get(event.stream_id) ?? [];
    rows.push(event);
    eventsByJob.set(event.stream_id, rows);
  }
  const children = childProjections.map((child) => ({
    projection: child,
    events: eventsByJob.get(child.job_id) ?? [],
  }));
  const providerSessions = readWorkflowProviderSessions(db, workflowId);
  const continuation =
    db
      .prepare<[string, string], RawWorkflowRecoveryContinuationRow>(
        `SELECT subject_revision, continuation_kind, continuation_key
           FROM recovery_quarantine
          WHERE boundary_id = ?
            AND subject_key = ?
            AND state = 'continuation'`,
      )
      .get(WORKFLOW_RECOVERY_BOUNDARY, workflowId) ?? null;
  const raw = {
    job: { projection, events: eventsByJob.get(workflowId) ?? [] },
    workflow,
    workflowEvents: readStreamEvents(db, 'workflow', workflowId),
    children,
    providerSessions,
    sessionEvents: readWorkflowSessionEvents(db, workflowId),
    continuation,
  };
  const fields = envelopeRevisionFields(raw);
  const sourceRevision = canonicalRecoveryRevision(fields);
  if (sourceRevision.kind !== 'fingerprint') {
    throw new Error('Workflow recovery source revision is not fingerprinted');
  }
  return {
    ...raw,
    sourceRevision,
    subject: {
      key: workflowId,
      revision: canonicalRecoveryRevision([
        ...fields,
        ...continuationRevisionFields(WORKFLOW_RECOVERY_BOUNDARY, workflowId, continuation),
      ]),
    },
  };
}

function scanWorkflowRecoveryEnvelopes(db: Database, subjectKey?: string): readonly RawWorkflowRecoveryEnvelope[] {
  return withConsistentRead(db, () => {
    const projections =
      subjectKey === undefined
        ? db
            .prepare<[], ProjectionJobStoredRow>(
              `SELECT ${PROJECTION_JOB_COLUMNS}
                 FROM projection_jobs
                WHERE job_kind = 'workflow'
                  AND phase NOT IN ('completed', 'error', 'aborted')
                ORDER BY job_id ASC`,
            )
            .all()
        : db
            .prepare<[string], ProjectionJobStoredRow>(
              `SELECT ${PROJECTION_JOB_COLUMNS}
                 FROM projection_jobs
                WHERE job_kind = 'workflow'
                  AND phase NOT IN ('completed', 'error', 'aborted')
                  AND job_id = ?`,
            )
            .all(subjectKey);
    return projections.map((projection) => readWorkflowEnvelope(db, projection));
  });
}

/** Creates the complete raw workflow recovery source. */
export function workflowRecoverySource(
  db: Database,
  subject?: RecoverySubject,
): RecoverySource<RawWorkflowRecoveryEnvelope> {
  return defineRecoverySource({
    boundary: WORKFLOW_RECOVERY_BOUNDARY,
    scanSubject: subject ?? { key: 'workflow-recovery-discovery', revision: { kind: 'until-cleared' } },
    scan: () => scanWorkflowRecoveryEnvelopes(db, subject?.key),
    subject: (raw) => raw.subject,
  });
}
