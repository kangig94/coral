import { PROJECTION_JOB_COLUMNS, type ProjectionJobStoredRow } from './projection-row.js';
import { sqlPlaceholders, type Database } from '../store/db.js';
import type { EventsRow } from '../store/schema.js';
import { TERMINAL_JOB_PHASES } from './phase.js';
import {
  canonicalRecoveryRevision,
  defineRecoverySource,
  type RecoverySource,
  type RecoverySubject,
} from '../recovery/containment.js';
import {
  EVENT_COLUMNS,
  eventRevisionFields,
  projectionJobRevisionFields,
  withConsistentRead,
} from '../recovery/row-revision-fields.js';

export type RawCrashedJobRow = {
  readonly projection: ProjectionJobStoredRow;
  readonly launchEvent: EventsRow | null;
};

function scanCrashedJobRows(db: Database, subjectKey?: string): readonly RawCrashedJobRow[] {
  return withConsistentRead(db, () => {
    const projections =
      subjectKey === undefined
        ? db
            .prepare<unknown[], ProjectionJobStoredRow>(
              `SELECT ${PROJECTION_JOB_COLUMNS}
                 FROM projection_jobs
                WHERE phase NOT IN (${sqlPlaceholders(TERMINAL_JOB_PHASES.length)})
                ORDER BY job_id ASC`,
            )
            .all(...TERMINAL_JOB_PHASES)
        : db
            .prepare<unknown[], ProjectionJobStoredRow>(
              `SELECT ${PROJECTION_JOB_COLUMNS}
                 FROM projection_jobs
                WHERE phase NOT IN (${sqlPlaceholders(TERMINAL_JOB_PHASES.length)})
                  AND job_id = ?`,
            )
            .all(...TERMINAL_JOB_PHASES, subjectKey);
    const readLaunchEvent = db.prepare<[string], EventsRow>(
      `SELECT ${EVENT_COLUMNS}
         FROM events
        WHERE stream_kind = 'job'
          AND stream_id = ?
          AND type = 'job.launch.requested'
        ORDER BY seq DESC
        LIMIT 1`,
    );
    return projections.map((projection) => ({
      projection,
      launchEvent: readLaunchEvent.get(projection.job_id) ?? null,
    }));
  });
}

function crashedJobSubject(raw: RawCrashedJobRow) {
  const fields = projectionJobRevisionFields(raw.projection);
  if (raw.launchEvent === null) {
    fields.push({
      table: 'events',
      key: raw.projection.job_id,
      field: 'job.launch.requested.__absent__',
      value: null,
    });
  } else {
    fields.push(...eventRevisionFields(raw.launchEvent));
  }
  return {
    key: raw.projection.job_id,
    revision: canonicalRecoveryRevision(fields),
  };
}

/** Creates the raw row-granular live-job crash terminalization source. */
export function crashedJobTerminalizationSource(
  db: Database,
  subject?: RecoverySubject,
): RecoverySource<RawCrashedJobRow> {
  return defineRecoverySource({
    boundary: 'crashed-job-terminalization',
    scanSubject: subject ?? { key: 'crashed-job-terminalization-discovery', revision: { kind: 'until-cleared' } },
    scan: () => scanCrashedJobRows(db, subject?.key),
    subject: crashedJobSubject,
  });
}
