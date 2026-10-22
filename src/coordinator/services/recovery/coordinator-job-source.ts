import { observeDatabaseReads } from '../../../recovery/read-observation.js';
import type { RecoveryObservation } from '../../../recovery/phase-observation.js';
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
  eventRevisionFields,
  projectionJobRevisionFields,
  withConsistentRead,
} from '../../../recovery/row-revision-fields.js';
import { COORDINATOR_JOB_RECOVERY_BOUNDARY } from '../../../recovery/source-registry.js';

export type RawCoordinatorSessionRow = import('../../../jobs/conversation/projections.js').ConversationEvidence;

/** One canonical provider-operation saga row from the generic `meta` keyspace. */
type RawProviderOperationSagaRow = {
  readonly key: string;
  readonly value: string;
};

type CoordinatorJobRecoveryFacts = {
  readonly jobId: string;
  readonly projection: ProjectionJobStoredRow | null;
  readonly statusEvents: readonly EventsRow[];
  readonly claimedSession: RawCoordinatorSessionRow | null;
  readonly providerOperations: readonly RawProviderOperationSagaRow[];
};

export type RawCoordinatorJobRecoveryEnvelope = CoordinatorJobRecoveryFacts & {
  readonly subject: RecoverySubject;
};

function scanCoordinatorJobRecoveryEnvelopes(
  db: Database,
  subjectKey?: string,
  observation?: RecoveryObservation,
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
        ORDER BY seq ASC`,
    );
    const readProviderOperations = db.prepare<[string], RawProviderOperationSagaRow>(
      `SELECT key, value
         FROM meta
        WHERE key LIKE ?
        ORDER BY key ASC`,
    );

    const jobEnvelopes = projections.map((projection) => {
      const facts = {
        jobId: projection.job_id,
        projection,
        statusEvents: readStatusEvents.all(projection.job_id),
        claimedSession: projection.job_kind === 'provider' ? { projection, events: readStatusEvents.all(projection.job_id) } : null,
        providerOperations: readProviderOperations.all(`${providerOperationRecordKeyPrefix(projection.job_id)}%`),
      };
      return facts;
    });
    observation?.record(COORDINATOR_JOB_RECOVERY_BOUNDARY, {
      subjects: jobEnvelopes.length,
    });
    return jobEnvelopes.map((facts) => ({
      ...facts,
      subject: coordinatorJobRecoverySubject(facts),
    }));
  });
}

function sessionRevisionFields(jobId: string, row: RawCoordinatorSessionRow | null): RecoveryRevisionField[] {
  if (row === null) {
    return [{ table: 'projection_jobs', key: jobId, field: 'conversation', value: null }];
  }
  return projectionJobRevisionFields(row.projection);
}

/** Folds each canonical saga row's key and a digest of its value into the revision, so a
 *  row appearing, disappearing, or changing between a scan and its settlement invalidates a stale quarantine
 *  the same way every other fact this envelope reads already does. */
function providerOperationRevisionFields(rows: readonly RawProviderOperationSagaRow[]): RecoveryRevisionField[] {
  return rows.map((row) => ({ table: 'meta', key: row.key, field: 'value', value: sha256Hex(row.value) }));
}

function coordinatorJobRecoverySubject(raw: CoordinatorJobRecoveryFacts): RecoverySubject {
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

export function coordinatorJobRecoverySource(
  db: Database,
  options: Readonly<{ subjectKey?: string; subject?: RecoverySubject; observation?: RecoveryObservation }> = {},
): RecoverySource<RawCoordinatorJobRecoveryEnvelope> {
  const observedDb =
    options.observation === undefined
      ? db
      : observeDatabaseReads(db, options.observation, COORDINATOR_JOB_RECOVERY_BOUNDARY);
  return defineRecoverySource({
    boundary: COORDINATOR_JOB_RECOVERY_BOUNDARY,
    scanSubject: options.subject ?? {
      key: options.subjectKey ?? `${COORDINATOR_JOB_RECOVERY_BOUNDARY}-discovery`,
      revision: { kind: 'until-cleared' },
    },
    scan: () =>
      scanCoordinatorJobRecoveryEnvelopes(observedDb, options.subject?.key ?? options.subjectKey, options.observation),
    subject: (raw) => raw.subject,
  });
}
