import type { Database } from '../../store/db.js';
import {
  canonicalRecoveryRevision,
  defineRecoverySource,
  type RecoverySource,
  type RecoverySubject,
} from '../../recovery/containment.js';

export type RawDiscussionSourceRow = {
  readonly discuss_id: string;
  readonly state: string;
  readonly last_seq: number;
};

export type DiscussionSourceCoordinate = {
  readonly discussId: string;
  readonly sourceId: string;
};

function scanDiscussionSourceRows(db: Database, subjectKey?: string): readonly RawDiscussionSourceRow[] {
  if (subjectKey !== undefined) {
    const row = db
      .prepare<[string], RawDiscussionSourceRow>(
        `SELECT discuss_id, state, last_seq
           FROM projection_discuss
          WHERE discuss_id = ?`,
      )
      .get(subjectKey);
    return row === undefined ? [] : [row];
  }
  return db
    .prepare<[], RawDiscussionSourceRow>(
      `SELECT discuss_id, state, last_seq
         FROM projection_discuss
        ORDER BY discuss_id ASC`,
    )
    .all();
}

export function discussionSourceRecoverySource(
  db: Database,
  subject?: RecoverySubject,
): RecoverySource<RawDiscussionSourceRow> {
  return defineRecoverySource({
    boundary: 'discussion-source',
    scanSubject: subject ?? {
      key: 'discussion-source-discovery',
      revision: { kind: 'until-cleared' },
    },
    scan: () => scanDiscussionSourceRows(db, subject?.key),
    subject: (row) => ({
      key: row.discuss_id,
      revision: canonicalRecoveryRevision([
        { table: 'projection_discuss', key: row.discuss_id, field: 'discuss_id', value: row.discuss_id },
        { table: 'projection_discuss', key: row.discuss_id, field: 'state', value: row.state },
        { table: 'projection_discuss', key: row.discuss_id, field: 'last_seq', value: row.last_seq },
      ]),
    }),
  });
}
