import type { ProjectionJobStoredRow } from '../../jobs/projection-row.js';
import { PROJECTION_JOB_COLUMNS } from '../../jobs/projection-row.js';
import { sqlPlaceholders, type Database } from '../../store/db.js';
import type { EventsRow } from '../../store/schema.js';
import {
  canonicalRecoveryRevision,
  defineRecoverySource,
  type RecoveryRevisionField,
  type RecoverySource,
  type RecoverySubject,
} from '../../recovery/containment.js';
import {
  EVENT_COLUMNS,
  continuationRevisionFields,
  eventRevisionFields,
  projectionJobRevisionFields,
  withConsistentRead,
} from '../../recovery/row-revision-fields.js';

const CANDIDATE_BOUNDARY = 'discussion-candidate';

export type RawDiscussionContinuationRow = {
  readonly subject_revision: string | null;
  readonly continuation_kind: string | null;
  readonly continuation_key: string | null;
};

export type RawDiscussionOwnedJob = {
  readonly projection: ProjectionJobStoredRow;
  readonly events: readonly EventsRow[];
};

export type RawDiscussionCandidateEnvelope = {
  readonly discussion: {
    readonly discuss_id: string;
    readonly state: string;
    readonly last_seq: number;
  };
  readonly discussionEvents: readonly EventsRow[];
  readonly ownedJobs: readonly RawDiscussionOwnedJob[];
  readonly continuation: RawDiscussionContinuationRow | null;
  readonly inputRevision: Extract<RecoverySubject['revision'], { kind: 'fingerprint' }>;
  readonly subject: RecoverySubject;
};

function inputRevisionFields(
  discussion: RawDiscussionCandidateEnvelope['discussion'],
  discussionEvents: readonly EventsRow[],
  ownedJobs: readonly RawDiscussionOwnedJob[],
): RecoveryRevisionField[] {
  const fields: RecoveryRevisionField[] = [
    {
      table: 'projection_discuss',
      key: discussion.discuss_id,
      field: 'discuss_id',
      value: discussion.discuss_id,
    },
    { table: 'projection_discuss', key: discussion.discuss_id, field: 'state', value: discussion.state },
    {
      table: 'projection_discuss',
      key: discussion.discuss_id,
      field: 'last_seq',
      value: discussion.last_seq,
    },
  ];
  for (const event of discussionEvents) fields.push(...eventRevisionFields(event));
  for (const job of ownedJobs) {
    fields.push(...projectionJobRevisionFields(job.projection));
    for (const event of job.events) fields.push(...eventRevisionFields(event));
  }
  return fields;
}

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

function readCandidateEnvelope(
  db: Database,
  discussion: RawDiscussionCandidateEnvelope['discussion'],
): RawDiscussionCandidateEnvelope {
  const discussionEvents = readEvents(db, 'discuss', [discussion.discuss_id]);
  const projections = db
    .prepare<[string], ProjectionJobStoredRow>(
      `SELECT ${PROJECTION_JOB_COLUMNS}
         FROM projection_jobs
        WHERE execution_owner = ?
        ORDER BY job_id ASC`,
    )
    .all(JSON.stringify({ kind: 'discussion', id: discussion.discuss_id }));
  const jobEvents = readEvents(
    db,
    'job',
    projections.map((projection) => projection.job_id),
  );
  const eventsByJob = new Map<string, EventsRow[]>();
  for (const event of jobEvents) {
    const events = eventsByJob.get(event.stream_id) ?? [];
    events.push(event);
    eventsByJob.set(event.stream_id, events);
  }
  const ownedJobs = projections.map((projection) => ({
    projection,
    events: eventsByJob.get(projection.job_id) ?? [],
  }));
  const continuation =
    db
      .prepare<[string, string], RawDiscussionContinuationRow>(
        `SELECT subject_revision, continuation_kind, continuation_key
           FROM recovery_quarantine
          WHERE boundary_id = ?
            AND subject_key = ?
            AND state = 'continuation'`,
      )
      .get(CANDIDATE_BOUNDARY, discussion.discuss_id) ?? null;

  const fields = inputRevisionFields(discussion, discussionEvents, ownedJobs);
  const inputRevision = canonicalRecoveryRevision(fields);
  if (inputRevision.kind !== 'fingerprint') {
    throw new Error('Discussion candidate input revision is not fingerprinted');
  }
  const subject: RecoverySubject = {
    key: discussion.discuss_id,
    revision: canonicalRecoveryRevision([
      ...fields,
      ...continuationRevisionFields(CANDIDATE_BOUNDARY, discussion.discuss_id, continuation),
    ]),
  };
  return {
    discussion,
    discussionEvents,
    ownedJobs,
    continuation,
    inputRevision,
    subject,
  };
}

function scanDiscussionCandidateEnvelopes(
  db: Database,
  subjectKey?: string,
): readonly RawDiscussionCandidateEnvelope[] {
  return withConsistentRead(db, () => {
    const discussions =
      subjectKey === undefined
        ? db
            .prepare<[], RawDiscussionCandidateEnvelope['discussion']>(
              `SELECT discuss_id, state, last_seq
                 FROM projection_discuss
                ORDER BY discuss_id ASC`,
            )
            .all()
        : db
            .prepare<[string], RawDiscussionCandidateEnvelope['discussion']>(
              `SELECT discuss_id, state, last_seq
                 FROM projection_discuss
                WHERE discuss_id = ?`,
            )
            .all(subjectKey);
    return discussions.map((discussion) => readCandidateEnvelope(db, discussion));
  });
}

/** Creates the complete raw discussion candidate source. */
export function discussionCandidateRecoverySource(
  db: Database,
  subject?: RecoverySubject,
): RecoverySource<RawDiscussionCandidateEnvelope> {
  return defineRecoverySource({
    boundary: CANDIDATE_BOUNDARY,
    scanSubject: subject ?? {
      key: 'discussion-candidate-discovery',
      revision: { kind: 'until-cleared' },
    },
    scan: () => scanDiscussionCandidateEnvelopes(db, subject?.key),
    subject: (raw) => raw.subject,
  });
}
