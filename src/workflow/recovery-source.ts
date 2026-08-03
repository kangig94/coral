import { PROJECTION_JOB_COLUMNS, type ProjectionJobStoredRow } from '../jobs/projection-row.js';
import type { Database } from '../store/db.js';
import { sqlPlaceholders } from '../store/db.js';
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
  PROJECTION_SESSION_COLUMNS,
  continuationRevisionFields,
  eventRevisionFields,
  projectionJobRevisionFields,
  projectionSessionRevisionFields,
  withConsistentRead,
} from '../recovery/row-revision-fields.js';
import type { RawSessionProjectionRow } from '../sessions/session-projection-recovery-source.js';
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

function readEvents(db: Database, streamKind: EventsRow['stream_kind'], streamIds: readonly string[]): EventsRow[] {
  if (streamIds.length === 0) return [];
  return db
    .prepare<unknown[], EventsRow>(
      `SELECT ${EVENT_COLUMNS}
         FROM events
        WHERE stream_kind = ?
          AND stream_id IN (${sqlPlaceholders(streamIds.length)})
        ORDER BY seq ASC`,
    )
    .all(streamKind, ...streamIds);
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
  const jobEvents = readEvents(db, 'job', [workflowId, ...childProjections.map((row) => row.job_id)]);
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
  const sessionIds = [
    ...new Set(
      childProjections
        .map((child) => child.session_id)
        .filter((sessionId): sessionId is string => typeof sessionId === 'string' && sessionId.length > 0),
    ),
  ].sort();
  const providerSessions =
    sessionIds.length === 0
      ? []
      : db
          .prepare<unknown[], RawSessionProjectionRow>(
            `SELECT ${PROJECTION_SESSION_COLUMNS}
               FROM projection_sessions
              WHERE session_id IN (${sqlPlaceholders(sessionIds.length)})
              ORDER BY session_id ASC`,
          )
          .all(...sessionIds);
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
    workflowEvents: readEvents(db, 'workflow', [workflowId]),
    children,
    providerSessions,
    sessionEvents: readEvents(db, 'session', sessionIds),
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

function scanWorkflowRecoveryEnvelopes(db: Database): readonly RawWorkflowRecoveryEnvelope[] {
  return withConsistentRead(db, () => {
    const projections = db
      .prepare<[], ProjectionJobStoredRow>(
        `SELECT ${PROJECTION_JOB_COLUMNS}
         FROM projection_jobs
         WHERE job_kind = 'workflow'
           AND phase NOT IN ('completed', 'error', 'aborted')
          ORDER BY job_id ASC`,
      )
      .all();
    return projections.map((projection) => readWorkflowEnvelope(db, projection));
  });
}

/** Creates the complete raw workflow recovery source. */
export function workflowRecoverySource(db: Database): RecoverySource<RawWorkflowRecoveryEnvelope> {
  return defineRecoverySource({
    boundary: WORKFLOW_RECOVERY_BOUNDARY,
    scanSubject: { key: 'workflow-recovery-discovery', revision: { kind: 'until-cleared' } },
    scan: () => scanWorkflowRecoveryEnvelopes(db),
    subject: (raw) => raw.subject,
  });
}
