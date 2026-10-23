import type { Database } from '../../store/db.js';
import { decodeStoredBody, type StoreReadContext } from '../../store/body-codec.js';
import type { EventsRow } from '../../store/schema.js';
import {
  canonicalRecoveryRevision,
  defineRecoverySource,
  type RecoverySource,
  type RecoverySubject,
} from '../../recovery/containment.js';
import { eventRevisionFields } from '../../recovery/row-revision-fields.js';
import { jobRetentionDiscardRequestedBodySchema } from '../event-bodies.js';
import { readExecutionAcceptedOutcomeEvent } from '../execution-journal.js';
import { retentionActionKey } from '../execution-address.js';

function scanRetentionRequests(db: Database, ctx: StoreReadContext, subject?: RecoverySubject): EventsRow[] {
  return db
    .prepare<[], EventsRow>(
      "SELECT * FROM events WHERE stream_kind = 'job' AND type = 'job.retention.discard.requested' ORDER BY seq",
    )
    .all()
    .filter((row) => {
      const action = jobRetentionDiscardRequestedBodySchema.parse(decodeStoredBody(row, ctx));
      return subject === undefined || retentionActionKey({ jobId: row.stream_id, ...action }) === subject.key;
    });
}

export function retentionRecoverySource(
  db: Database,
  ctx: StoreReadContext,
  subject?: RecoverySubject,
): RecoverySource<EventsRow> {
  return defineRecoverySource({
    boundary: 'job-conversation-retention',
    scanSubject: subject ?? { key: 'retention-requests', revision: { kind: 'until-cleared' } },
    scan: () => scanRetentionRequests(db, ctx, subject),
    subject: (row) => {
      const action = jobRetentionDiscardRequestedBodySchema.parse(decodeStoredBody(row, ctx));
      const accepted = readExecutionAcceptedOutcomeEvent(db, ctx, {
        jobId: row.stream_id,
        execution: action.execution,
      });
      return {
        key: retentionActionKey({ jobId: row.stream_id, ...action }),
        revision: canonicalRecoveryRevision(eventRevisionFields(accepted)),
      };
    },
  });
}
