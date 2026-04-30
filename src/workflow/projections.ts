import type BetterSqlite3 from 'better-sqlite3';

import {
  commit as commitEvents,
  type CommitClosureResult,
  type CommitContext,
  type CommitEventsFn,
} from '../store/append.js';
import { nowDate } from '../infra/time.js';
import type { TimePort } from '../runtime/ports.js';
import { createDefaultUpcasterRegistry } from '../store/upcaster-registry.js';
import { composeReducers } from '../store/reducers.js';
import { workflowRegistry } from './events.js';

const workflowReducers = composeReducers(workflowRegistry);
const upcasters = createDefaultUpcasterRegistry();

export type WorkflowJournal = {
  commit(cb: <Scope>(c: CommitContext<Scope>) => CommitClosureResult): void;
};

export function commitWorkflowEvents(
  db: BetterSqlite3.Database,
  cb: <Scope>(c: CommitContext<Scope>) => CommitClosureResult,
  time: Pick<TimePort, 'now'>,
): void {
  commitEvents(db, cb, {
    now: () => nowDate(time),
    reducers: workflowReducers,
    upcasters,
  });
}

export function createWorkflowJournal(options: { commit: CommitEventsFn }): WorkflowJournal {
  return {
    commit(cb) {
      options.commit(cb);
    },
  };
}
