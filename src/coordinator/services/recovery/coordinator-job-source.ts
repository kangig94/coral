import { PROJECTION_JOB_COLUMNS, type ProjectionJobStoredRow } from '../../../jobs/projection-row.js';
import { sha256Hex } from '../../../infra/hash.js';
import type { Database } from '../../../store/db.js';
import { providerOperationRecordKeyPrefix } from '../../../store/provider-operation-journal.js';
import type { EventsRow } from '../../../store/schema.js';
import {
  canonicalRecoveryRevision,
  defineRecoverySource,
  type RecoveryRevisionField,
  type RecoverySource,
  type RecoverySubject,
} from '../../../recovery/containment.js';
import {
  EVENT_COLUMNS,
  PROJECTION_SESSION_COLUMNS,
  eventRevisionFields,
  projectionJobRevisionFields,
  projectionSessionRevisionFields,
  withConsistentRead,
} from '../../../recovery/row-revision-fields.js';

export type RawCoordinatorSessionRow = {
  readonly session_id: string;
  readonly controller: string;
  readonly resumable: number;
  readonly conversation_ref: string | null;
  readonly scope_key: string;
  readonly entry: string;
  readonly last_seq: number;
};

/** One canonical provider-operation saga row from the generic `meta` keyspace. */
export type RawProviderOperationSagaRow = {
  readonly key: string;
  readonly value: string;
};

export type RawCoordinatorJobRecoveryEnvelope = {
  readonly jobId: string;
  readonly projection: ProjectionJobStoredRow | null;
  readonly statusEvents: readonly EventsRow[];
  readonly claimedSession: RawCoordinatorSessionRow | null;
  readonly providerOperations: readonly RawProviderOperationSagaRow[];
};

function scanCoordinatorJobRecoveryEnvelopes(
  db: Database,
  subjectKey?: string,
): readonly RawCoordinatorJobRecoveryEnvelope[] {
  return withConsistentRead(db, () => {
    const projections =
      subjectKey === undefined
        ? db
            .prepare<[], ProjectionJobStoredRow>(
              `SELECT ${PROJECTION_JOB_COLUMNS}
               FROM projection_jobs
              ORDER BY job_id ASC`,
            )
            .all()
        : db
            .prepare<[string], ProjectionJobStoredRow>(
              `SELECT ${PROJECTION_JOB_COLUMNS}
               FROM projection_jobs
              WHERE job_id = ?
              ORDER BY job_id ASC`,
            )
            .all(subjectKey);
    const readStatusEvents = db.prepare<[string], EventsRow>(
      `SELECT ${EVENT_COLUMNS}
         FROM events
        WHERE stream_kind = 'job'
          AND stream_id = ?
          AND type IN (
            'job.launch.requested',
            'job.launch.rejected',
            'job.runtime.started',
            'job.terminal.recorded'
          )
        ORDER BY seq ASC`,
    );
    const readClaimedSession = db.prepare<[string], RawCoordinatorSessionRow>(
      `SELECT ${PROJECTION_SESSION_COLUMNS}
         FROM projection_sessions
        WHERE session_id = ?`,
    );
    // W2.5: a proxied app-server job's `acquired` `hostRef` names a live provider proxy set, not a local
    // host — see `provider-proxy-launch-route.ts`'s `proxiedHostRef`. Reading this alongside everything else
    // this envelope already reads keeps it inside the same `withConsistentRead` snapshot, so the revision
    // folded below stays accurate for whether that fact changes between a scan and its settlement.
    const readProviderOperations = db.prepare<[string], RawProviderOperationSagaRow>(
      `SELECT key, value
         FROM meta
        WHERE key LIKE ?
        ORDER BY key ASC`,
    );

    const jobEnvelopes = projections.map((projection) => ({
      jobId: projection.job_id,
      projection,
      statusEvents: readStatusEvents.all(projection.job_id),
      claimedSession: projection.session_id === null ? null : (readClaimedSession.get(projection.session_id) ?? null),
      providerOperations: readProviderOperations.all(`${providerOperationRecordKeyPrefix(projection.job_id)}%`),
    }));
    const orphanedClaims = db
      .prepare<[], RawCoordinatorSessionRow & { active_job_id: string }>(
        `SELECT ${PROJECTION_SESSION_COLUMNS}, json_extract(entry, '$.activeJobId') AS active_job_id
           FROM projection_sessions AS sessions
          WHERE json_valid(entry)
            AND typeof(json_extract(entry, '$.activeJobId')) = 'text'
            AND length(json_extract(entry, '$.activeJobId')) > 0
            AND NOT EXISTS (
              SELECT 1
                FROM projection_jobs AS jobs
               WHERE jobs.job_id = json_extract(sessions.entry, '$.activeJobId')
            )
          ORDER BY active_job_id ASC`,
      )
      .all()
      .filter((row) => subjectKey === undefined || row.active_job_id === subjectKey)
      .map(({ active_job_id: jobId, ...claimedSession }) => ({
        jobId,
        projection: null,
        statusEvents: Object.freeze([]),
        claimedSession,
        providerOperations: readProviderOperations.all(`${providerOperationRecordKeyPrefix(jobId)}%`),
      }));
    return [...jobEnvelopes, ...orphanedClaims];
  });
}

function sessionRevisionFields(jobId: string, row: RawCoordinatorSessionRow | null): RecoveryRevisionField[] {
  if (row === null) {
    return [{ table: 'projection_sessions', key: jobId, field: 'claimed_session', value: null }];
  }
  return projectionSessionRevisionFields(row);
}

/** Folds each canonical saga row's key and a digest of its value into the revision, so a
 *  row appearing, disappearing, or changing between a scan and its settlement invalidates a stale quarantine
 *  the same way every other fact this envelope reads already does. */
function providerOperationRevisionFields(rows: readonly RawProviderOperationSagaRow[]): RecoveryRevisionField[] {
  return rows.map((row) => ({ table: 'meta', key: row.key, field: 'value', value: sha256Hex(row.value) }));
}

function coordinatorJobRecoverySubject(raw: RawCoordinatorJobRecoveryEnvelope) {
  const fields =
    raw.projection === null
      ? [{ table: 'projection_jobs', key: raw.jobId, field: 'projection', value: null }]
      : projectionJobRevisionFields(raw.projection);
  for (const event of raw.statusEvents) fields.push(...eventRevisionFields(event));
  fields.push(...sessionRevisionFields(raw.jobId, raw.claimedSession));
  fields.push(...providerOperationRevisionFields(raw.providerOperations));
  return {
    key: raw.jobId,
    revision: canonicalRecoveryRevision(fields),
  };
}

/** Creates the raw item-granular coordinator job recovery source. */
export function coordinatorJobRecoverySource(
  db: Database,
  options: Readonly<{ subjectKey?: string; subject?: RecoverySubject }> = {},
): RecoverySource<RawCoordinatorJobRecoveryEnvelope> {
  return defineRecoverySource({
    boundary: 'coordinator-job-recovery',
    scanSubject: options.subject ?? {
      key: options.subjectKey ?? 'coordinator-job-recovery-discovery',
      revision: { kind: 'until-cleared' },
    },
    scan: () => scanCoordinatorJobRecoveryEnvelopes(db, options.subject?.key ?? options.subjectKey),
    subject: coordinatorJobRecoverySubject,
  });
}
