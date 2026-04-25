import type BetterSqlite3 from 'better-sqlite3';

import { appendEvents, type AppendEventsFn } from '../store/append.js';
import { createEmptyRegistry, type CoralEventInput } from '../store/envelope.js';
import { composeReducers } from '../store/reducers.js';
import { workflowRegistry } from './events.js';

const workflowReducers = composeReducers(workflowRegistry);
const upcasters = createEmptyRegistry();

export type WorkflowJournal = {
  append(inputs: readonly CoralEventInput[]): void;
};

export function appendWorkflowEvents(db: BetterSqlite3.Database, inputs: readonly CoralEventInput[]): void {
  appendEvents(db, inputs, {
    now: () => new Date(),
    reducers: workflowReducers,
    upcasters,
  });
}

export function createWorkflowJournal(options: { appendEvents: AppendEventsFn }): WorkflowJournal {
  return {
    append(inputs) {
      options.appendEvents(inputs);
    },
  };
}
