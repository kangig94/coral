import type { Database } from '../store/db.js';

import {
  commit as commitEvents,
  type CommitClosureResult,
  type CommitContext,
  type CommitEventsFn,
} from '../store/append.js';
import { nowDate } from '../infra/time.js';
import type { ProviderLookupPort } from '../providers/catalog.js';
import type { TimePort } from '../infra/port-types.js';
import { createEventBodyCodec } from '../store/event-body-codec.js';
import { composeReducers } from '../store/reducers.js';
import { workflowRegistry } from './events.js';

const workflowReducers = composeReducers(workflowRegistry);
const bodyCodec = createEventBodyCodec();

export type WorkflowJournal = {
  commit(cb: <Scope>(c: CommitContext<Scope>) => CommitClosureResult): void;
};

export function commitWorkflowEvents(
  db: Database,
  cb: <Scope>(c: CommitContext<Scope>) => CommitClosureResult,
  time: Pick<TimePort, 'now'>,
  providers: ProviderLookupPort,
): void {
  commitEvents(db, cb, {
    now: () => nowDate(time),
    reducers: workflowReducers,
    bodyCodec,
    providers,
  });
}

export function createWorkflowJournal(options: { commit: CommitEventsFn }): WorkflowJournal {
  return {
    commit(cb) {
      options.commit(cb);
    },
  };
}
