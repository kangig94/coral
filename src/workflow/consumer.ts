import type BetterSqlite3 from 'better-sqlite3';

import type { ConsumerDriver } from '../coordinator/consumer-driver.js';
import { getEventsSince } from '../store/queries/events.js';
import { applyReducer, composeReducers } from '../store/reducers.js';
import { workflowRegistry } from './events.js';

const reducers = composeReducers(workflowRegistry);
const workflowTypes = new Set(workflowRegistry.types);

async function applyWorkflowProjectionRange(
  db: BetterSqlite3.Database,
  fromSeq: number,
  upToSeq: number,
): Promise<void> {
  let cursor = fromSeq;

  while (cursor < upToSeq) {
    const page = getEventsSince(db, cursor, {}, 1_000);
    const scoped = page.events.filter((event) => event.seq <= upToSeq && workflowTypes.has(event.type));
    if (scoped.length > 0) {
      const txn = db.transaction(() => {
        for (const event of scoped) {
          applyReducer(db, event, reducers);
        }
      });
      txn.immediate();
    }

    if (page.nextCursor <= cursor) {
      break;
    }
    cursor = page.nextCursor;
  }
}

export function registerWorkflowConsumer(
  driver: ConsumerDriver,
  db: BetterSqlite3.Database,
): void {
  driver.register({
    id: 'workflow',
    authority: 'journal',
    apply: ({ fromSeq, upToSeq }) => applyWorkflowProjectionRange(db, fromSeq, upToSeq),
  });
}
