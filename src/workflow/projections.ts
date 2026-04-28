import type BetterSqlite3 from 'better-sqlite3';

import {
  appendEvents,
  commit as commitEvents,
  type AppendEventsFn,
  type CommitClosureResult,
  type CommitContext,
  type CommitEventsFn,
} from '../store/append.js';
import { nowDate } from '../infra/time.js';
import type { TimePort } from '../runtime/ports.js';
import { createEmptyRegistry, type CoralEventInput } from '../store/envelope.js';
import { composeReducers } from '../store/reducers.js';
import { workflowRegistry } from './events.js';

const workflowReducers = composeReducers(workflowRegistry);
const upcasters = createEmptyRegistry();

export type WorkflowJournal = {
  commit(cb: <Scope>(c: CommitContext<Scope>) => CommitClosureResult): void;
  append(inputs: readonly CoralEventInput[]): void;
};

export function appendWorkflowEvents(
  db: BetterSqlite3.Database,
  inputs: readonly CoralEventInput[],
  time: Pick<TimePort, 'now'>,
): void {
  appendEvents(db, inputs, {
    now: () => nowDate(time),
    reducers: workflowReducers,
    upcasters,
  });
}

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

export function createWorkflowJournal(options: { commit: CommitEventsFn; appendEvents?: AppendEventsFn }): WorkflowJournal {
  return {
    commit(cb) {
      options.commit(cb);
    },
    append(inputs) {
      if (options.appendEvents) {
        options.appendEvents(inputs);
        return;
      }
      options.commit((c) => {
        for (const input of inputs) c.append(input);
        return undefined;
      });
    },
  };
}
