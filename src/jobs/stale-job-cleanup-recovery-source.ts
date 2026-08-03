import { PROJECTION_JOB_COLUMNS, type ProjectionJobStoredRow } from './projection-row.js';
import type { Database } from '../store/db.js';
import type { EventsRow } from '../store/schema.js';
import { canonicalRecoveryRevision, defineRecoverySource, type RecoverySource } from '../recovery/containment.js';
import {
  EVENT_COLUMNS,
  eventRevisionFields,
  projectionJobRevisionFields,
  withConsistentRead,
} from '../recovery/row-revision-fields.js';

export type RawStaleJobCleanupRow = {
  readonly projection: ProjectionJobStoredRow;
  readonly statusEvents: readonly EventsRow[];
};

function scanStaleJobCleanupRows(db: Database): readonly RawStaleJobCleanupRow[] {
  return withConsistentRead(db, () => {
    const projections = db
      .prepare<[], ProjectionJobStoredRow>(
        `SELECT ${PROJECTION_JOB_COLUMNS}
           FROM projection_jobs
          WHERE phase NOT IN ('queued', 'launching', 'running')
          ORDER BY job_id ASC`,
      )
      .all();
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
    return projections.map((projection) => ({
      projection,
      statusEvents: readStatusEvents.all(projection.job_id),
    }));
  });
}

function staleJobCleanupSubject(raw: RawStaleJobCleanupRow) {
  const fields = projectionJobRevisionFields(raw.projection);
  for (const event of raw.statusEvents) fields.push(...eventRevisionFields(event));
  return {
    key: raw.projection.job_id,
    revision: canonicalRecoveryRevision(fields),
  };
}

/** Creates the raw row-granular terminal-job artifact cleanup source. */
export function staleJobCleanupSource(db: Database): RecoverySource<RawStaleJobCleanupRow> {
  return defineRecoverySource({
    boundary: 'stale-job-cleanup',
    scanSubject: { key: 'stale-job-cleanup-discovery', revision: { kind: 'until-cleared' } },
    scan: () => scanStaleJobCleanupRows(db),
    subject: staleJobCleanupSubject,
  });
}
