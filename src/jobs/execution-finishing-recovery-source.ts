import type { Database } from '../store/db.js';
import type { EventsRow } from '../store/schema.js';
import {
  canonicalRecoveryRevision,
  defineRecoverySource,
  type RecoverySource,
  type RecoverySubject,
} from '../recovery/containment.js';
import { eventRevisionFields } from '../recovery/row-revision-fields.js';

export function executionFinishingRecoverySource(db: Database, subject: RecoverySubject): RecoverySource<EventsRow> {
  const separator = subject.key.lastIndexOf(':');
  const jobId = subject.key.slice(0, separator);
  const execution = Number(subject.key.slice(separator + 1));
  return defineRecoverySource({
    boundary: 'job-execution-finishing',
    scanSubject: subject,
    scan: () =>
      db
        .prepare<
          [string, number],
          EventsRow
        >("SELECT * FROM events WHERE stream_kind = 'job' AND stream_id = ? AND type = 'job.execution.requested' AND json_extract(CAST(body AS TEXT), '$.execution') = ?")
        .all(jobId, execution),
    subject: (row) => ({ key: subject.key, revision: canonicalRecoveryRevision(eventRevisionFields(row)) }),
  });
}
